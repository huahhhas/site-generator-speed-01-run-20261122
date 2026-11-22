// A fast, dependency-free reimplementation of the makefun-site 1.0.0 build,
// written from its README spec. It renders one site's sources into the same
// output tree, byte for byte, but with a single-pass Markdown scanner, a
// hand-rolled front-matter parser, precompiled templates and per-run caches.
//
// Entry point: run(input) with input { site, templates, files }.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ---------------------------------------------------------------- text ----

// Escape &, <, >, ", '. Fast path when nothing needs escaping.
const ESC_RE = /[&<>"']/;
function esc(s) {
  if (!ESC_RE.test(s)) return s;
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' :
    c === '"' ? '&quot;' : '&#39;');
}

// Escape one known character (used by the inline scanner).
function escChar(c) {
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

function longDate(date) {
  // date is a validated YYYY-MM-DD string.
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  let d = date.charCodeAt(8) - 48;
  if (date.charCodeAt(9) !== 45 && date.length > 9) d = d * 10 + (date.charCodeAt(9) - 48);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Slug: NFKD, combining marks dropped, A-Z lowered, every run of other
// characters one '-', none at either end, cut to 64 (a trailing '-' at the
// cut dropped), 'untitled' when nothing is left. After NFKD + mark
// stripping, every remaining non-ASCII code unit is a separator, so a
// per-code-unit scan is equivalent to the per-code-point rule.
function slugify(ctx, text) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  // Pure ASCII text is unchanged by NFKD and holds no combining marks.
  const plain = /[^\x00-\x7f]/.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = 0;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === 0) { if (out.length > 0) gap = true; continue; }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
    out = out.slice(0, e);
  }
  if (out === '') out = 'untitled';
  ctx.slugCache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  let out;
  do { out = `${slug}-${n++}`; } while (taken.has(out));
  taken.add(out);
  return out;
}

function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// Words in body lines [from, to): runs of non-whitespace characters.
function countWords(lines, from, to) {
  let n = 0;
  for (let li = from; li < to; li++) {
    const s = lines[li];
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      if (isWsCode(s.charCodeAt(i))) { inWord = false; continue; }
      if (!inWord) { inWord = true; n++; }
    }
  }
  return n;
}

// ---------------------------------------------------------- front matter ----

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimEndST(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return s.slice(0, e);
}

// A quoted/bare string value for title/summary.
function stringValue(raw, key) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: `key "${key}": a quoted string is not closed` };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) {
          return { error: `key "${key}": a quoted string holds an escape other than \\" or \\\\'` };
        }
        out += n;
        i++;
      } else if (c === '"') {
        return { error: `key "${key}": a quoted string holds a stray quote` };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) { // '['
    return { error: `key "${key}": a bare string opens on [` };
  }
  return { value: raw };
}

function keyValue(key, raw) {
  if (key === 'title' || key === 'summary') return stringValue(raw, key);
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    let y = 0, mo = 0, d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      if (ok) {
        y = +raw.slice(0, 4); mo = +raw.slice(5, 7); d = +raw.slice(8, 10);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
    }
    return ok ? { value: raw }
      : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
  }
  if (key === 'tags') {
    if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = [];
    let start = 0;
    for (let i = 0; i <= inner.length; i++) {
      if (i === inner.length || inner.charCodeAt(i) === 44) {
        const t = inner.slice(start, i).trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags.push(t);
        start = i + 1;
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    let ok = raw.length > 0;
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
    }
    return ok ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    let ok = raw.length >= 1 && raw.length <= 64;
    let prevDash = true; // a slug may not start with '-'
    for (let i = 0; ok && i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c === 45) { if (prevDash) ok = false; prevDash = true; }
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
      else ok = false;
    }
    if (prevDash) ok = false; // may not end with '-'
    return ok ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

// Parse front matter of a source whose text was split into `lines`.
// Returns { data, bodyFrom } or { error }.
function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue; // '#' comment
    // key: [a-z_]+, ':', optional ' ' + rest
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = trimEndST(raw);
    if (key !== 'title' && key !== 'date' && key !== 'tags' && key !== 'draft' &&
        key !== 'layout' && key !== 'slug' && key !== 'summary') {
      return { error: `unknown key "${key}"` };
    }
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = keyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyFrom: close + 1 };
}

// --------------------------------------------------------------- Markdown ----

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
function isEscapable(c) { return ESCAPABLE.has(c); }

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 95 || c === 43 || c === 45;
}

// Fence open: ``` + lang chars + spaces/tabs only. Returns lang or null.
function fenceLang(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.length < 3 || line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 '#', space/tab run, text with trailing spaces/tabs dropped.
// Returns { depth, text } or null.
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let s = n;
  while (s < line.length && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  let e = line.length;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === s) return null;
  return { depth: n, text: line.slice(s, e) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const a = line.charCodeAt(0), b = line.charCodeAt(1), d = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && d === 45) || (a === 42 && b === 42 && d === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function trimLine(line) {
  let s = 0, e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

// --- inline rendering over s[lo, hi), appending to `parts` ---

function findUnescaped(s, what, from, hi) {
  const wl = what.length;
  let j = from;
  while (j <= hi - wl) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && isEscapable(s[j + 1])) { j += 2; continue; }
    if (s.startsWith(what, j)) return j;
    j++;
  }
  return -1;
}

function findSingleStar(s, from, hi) {
  let j = from;
  while (j < hi) {
    const c = s[j];
    if (c === '\\' && j + 1 < hi && isEscapable(s[j + 1])) { j += 2; continue; }
    if (c !== '*') { j++; continue; }
    if (j + 1 < hi && s[j + 1] === '*') { j += 2; continue; }
    return j;
  }
  return -1;
}

function hasWhitespace(s) {
  for (let i = 0; i < s.length; i++) if (isWsCode(s.charCodeAt(i))) return true;
  return false;
}

const SPECIAL_RE = /[\\`*\[]/g;

function inlineRange(s, lo, hi, env, parts) {
  // Plain runs are flushed as whole slices (escaped in one pass). The next
  // Markdown construct is found with one regex scan (C++), not a per-char
  // JS loop, so plain prose costs almost nothing per character. The shared
  // regex is safe under recursion: every exec is preceded by setting
  // lastIndex.
  let plain = lo;
  let i = lo;
  const flush = (to) => { if (to > plain) parts.push(esc(s.slice(plain, to))); };
  while (i < hi) {
    SPECIAL_RE.lastIndex = i;
    const mm = SPECIAL_RE.exec(s);
    const j = mm !== null && mm.index < hi ? mm.index : hi;
    if (j >= hi) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < hi && isEscapable(s[j + 1])) {
        flush(j);
        parts.push(escChar(s[j + 1]));
        i = j + 2;
        plain = i;
      } else i = j + 1; // a lone backslash is plain text
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        flush(j);
        parts.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1; // no closer: the backtick is plain text
      continue;
    }
    if (c === '*') {
      if (j + 1 < hi && s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          flush(j);
          parts.push('<strong>');
          inlineRange(s, j + 2, k, env, parts);
          parts.push('</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        flush(j);
        parts.push('<em>');
        inlineRange(s, j + 1, k, env, parts);
        parts.push('</em>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1, hi);
    let m = -1;
    if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
      const r = s.indexOf(')', k + 2);
      if (r !== -1 && r < hi) m = r;
    }
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWhitespace(target)) {
      flush(j);
      parts.push('<a href="', esc(env.link(target)), '">');
      inlineRange(s, j + 1, k, env, parts);
      parts.push('</a>');
      i = m + 1;
      plain = i;
    } else i = j + 1; // not a link: the '[' is plain text
  }
  flush(hi);
}

function inlineStr(s, env) {
  const parts = [];
  inlineRange(s, 0, s.length, env, parts);
  return parts.join('');
}

// Render body lines [from, to) to HTML; returns { html, toc, excerpt }.
function renderMarkdown(lines, from, to, env, ctx) {
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  while (i < to) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      parts.push('<pre><code');
      if (lang !== '') parts.push(' class="language-', lang, '"');
      parts.push('>');
      i++;
      const bodyStart = i;
      while (i < to && !isFenceClose(lines[i])) i++;
      if (i > bodyStart) parts.push(esc(lines.slice(bodyStart, i).join('\n')), '\n');
      i++;
      parts.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(ctx, heading.text), ids);
      const html = inlineStr(heading.text, env);
      parts.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { parts.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < to && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        body.push(l);
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        parts.push('<blockquote>\n<p>', inlineStr(joined, env), '</p>\n</blockquote>\n');
      }
      continue;
    }
    // List?
    let ordered = false, startNum = 1, isList = false;
    const c0 = line.charCodeAt(0);
    if ((c0 === 45 || c0 === 42) && line.length >= 2 && line.charCodeAt(1) === 32) isList = true;
    else if (c0 >= 48 && c0 <= 57) {
      let j = 0;
      while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
      if (j >= 1 && j <= 9 && j + 1 < line.length && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
        isList = true; ordered = true; startNum = +line.slice(0, j);
      }
    }
    if (isList) {
      const items = [];
      while (i < to) {
        const l = lines[i];
        let rest = null;
        if (!ordered) {
          const a = l.charCodeAt(0);
          if ((a === 45 || a === 42) && l.length >= 2 && l.charCodeAt(1) === 32) rest = l.slice(2);
        } else {
          let j = 0;
          while (j < l.length && l.charCodeAt(j) >= 48 && l.charCodeAt(j) <= 57) j++;
          if (j >= 1 && j <= 9 && j + 1 < l.length && l.charCodeAt(j) === 46 && l.charCodeAt(j + 1) === 32) rest = l.slice(j + 2);
        }
        if (rest !== null) { items.push([trimLine(rest)]); i++; continue; }
        // continuation: two or more spaces, then a non-space
        let sp = 0;
        while (sp < l.length && l.charCodeAt(sp) === 32) sp++;
        if (sp >= 2 && sp < l.length && !isWsCode(l.charCodeAt(sp))) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      if (ordered && startNum !== 1) parts.push(`<ol start="${startNum}">\n`);
      else parts.push(`<${tag}>\n`);
      for (const item of items) {
        parts.push('<li>', inlineStr(item.join('\n'), env), '</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph.
    const body = [trimLine(line)];
    i++;
    while (i < to && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inlineStr(text, env);
    if (excerpt === null) excerpt = html;
    parts.push('<p>', html, '</p>\n');
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- Templates ----

class TemplateError extends Error {}

function isPathChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}
function isPathStart(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

// Validate a dotted path; returns its segments or throws TemplateError.
function pathOf(name, text) {
  if (text.length === 0) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  const parts = text.split('.');
  for (const p of parts) {
    if (p.length === 0 || !isPathStart(p.charCodeAt(0))) {
      throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
    for (let i = 1; i < p.length; i++) {
      if (!isPathChar(p.charCodeAt(i))) {
        throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
      }
    }
  }
  return parts;
}

function allSpaceTab(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Parse a template source into a node tree (throws TemplateError).
function parseTemplate(name, src) {
  // Tokenize.
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = allSpaceTab(src, lineStart, open) && allSpaceTab(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 'text', text }); text = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });

  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    // {% for x in path %}
    if (tag.startsWith('for ')) {
      const rest = tag.slice(4);
      const sp = rest.indexOf(' ');
      let name2 = null, ptext = null;
      if (sp > 0) {
        const cand = rest.slice(0, sp);
        const after = rest.slice(sp + 1);
        if (after.startsWith('in ') && cand.length > 0 && isPathStart(cand.charCodeAt(0))) {
          let ok = true;
          for (let q = 1; q < cand.length; q++) if (!isPathChar(cand.charCodeAt(q))) { ok = false; break; }
          if (ok && after.slice(3).indexOf(' ') === -1 && after.slice(3).indexOf('\t') === -1) {
            name2 = cand; ptext = after.slice(3);
          }
        }
      }
      if (name2 !== null) {
        const node = { kind: 'for', name: name2, path: pathOf(name, ptext), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
    } else if (tag.startsWith('if ')) {
      const rest = tag.slice(3);
      let not = false, ptext = rest;
      if (rest.startsWith('not ')) { not = true; ptext = rest.slice(4); }
      if (ptext.indexOf(' ') === -1 && ptext.indexOf('\t') === -1 && ptext.length > 0) {
        const node = { kind: 'if', not, path: pathOf(name, ptext), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      continue;
    }
    if (tag.startsWith('include "') && tag.endsWith('"') && tag.length > 10) {
      const inc = tag.slice(9, -1);
      let ok = inc.length > 0;
      for (let q = 0; ok && q < inc.length; q++) {
        const c = inc.charCodeAt(q);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      if (ok) { body.push({ kind: 'include', name: inc }); continue; }
    }
    throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v, parts) {
  if (typeof v === 'string') { parts.push(v); return; }
  if (typeof v === 'number') { parts.push(String(v)); return; }
  if (typeof v === 'boolean') { parts.push(v ? 'true' : 'false'); return; }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (i > 0) parts.push(', ');
      textOf(v[i], parts);
    }
  }
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, parts) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': parts.push(n.text); break;
      case 'var': {
        const v = lookup(scope, n.path);
        if (typeof v === 'string') parts.push(esc(v));
        else if (typeof v === 'number') parts.push(esc(String(v)));
        else if (typeof v === 'boolean') parts.push(v ? 'true' : 'false');
        else if (Array.isArray(v)) {
          const tmp = [];
          textOf(v, tmp);
          parts.push(esc(tmp.join('')));
        }
        break;
      }
      case 'raw': textOf(lookup(scope, n.path), parts); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, parts);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope and one loop record per for, mutated per element: the
        // values are only read while rendering, never retained.
        const vars = { [n.name]: undefined, loop: { index: 0, first: false, last: false, length: xs.length } };
        const child = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          const lp = vars.loop;
          lp.index = k + 1; lp.first = k === 0; lp.last = k === xs.length - 1;
          renderNodes(n.body, child, ctx, depth, parts);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, parts);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ build ----

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function run(input) {
  const ctx = { slugCache: new Map(), templates: new Map() };
  const report = [];
  const tNames = Object.keys(input.templates).sort(cmp);
  for (const name of tNames) {
    try {
      ctx.templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter and the refusal checks, in source order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!ctx.templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(ctx, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // '/' or '#'
        // scheme: [A-Za-z][A-Za-z0-9+.-]*:
        const c0 = target.charCodeAt(0);
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          let j = 1;
          while (j < target.length) {
            const c = target.charCodeAt(j);
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) { j++; continue; }
            break;
          }
          if (j < target.length && target.charCodeAt(j) === 58) return target;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyFrom, s.lines.length, env, ctx);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (const name of tags) {
      const slug = slugify(ctx, name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(ctx, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(ctx, name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  const linkOf = (s) => (s === null ? null : {
    title: s.data.title, url: s.url, date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.lines, s.bodyFrom, s.lines.length) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    // A post's card is already built and cached; reuse it verbatim.
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One root scope per run, mutated per render: a field left unset for a
  // render is undefined, which lookups treat exactly like an absent field.
  const rootVars = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const rootScope = { vars: rootVars, parent: null };
  const render = (name, vars) => {
    const nodes = ctx.templates.get(name);
    if (nodes === undefined) return null;
    rootVars.page = vars.page;
    rootVars.posts = vars.posts;
    rootVars.pager = vars.pager;
    rootVars.tag = vars.tag;
    const parts = [];
    renderNodes(nodes, rootScope, ctx, 0, parts);
    return parts.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(cmp);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
