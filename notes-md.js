// Markdown <-> Quill Delta conversion used by the AI agent so it can read and
// write note bodies as plain Markdown while the editor stores rich Deltas.

function parseInline(text) {
  const ops = [];
  // bold(**), bold(__), italic(*), italic(_), strike(~~), code(`), link([t](u))
  const re = /(\*\*([^*]+)\*\*)|(__([^_]+)__)|(\*([^*]+)\*)|(_([^_]+)_)|(~~([^~]+)~~)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/;
  let rest = String(text);
  let guard = 0;
  while (rest.length && guard++ < 5000) {
    const m = re.exec(rest);
    if (!m) { ops.push({ insert: rest }); break; }
    if (m.index > 0) ops.push({ insert: rest.slice(0, m.index) });
    if (m[1]) ops.push({ insert: m[2], attributes: { bold: true } });
    else if (m[3]) ops.push({ insert: m[4], attributes: { bold: true } });
    else if (m[5]) ops.push({ insert: m[6], attributes: { italic: true } });
    else if (m[7]) ops.push({ insert: m[8], attributes: { italic: true } });
    else if (m[9]) ops.push({ insert: m[10], attributes: { strike: true } });
    else if (m[11]) ops.push({ insert: m[12], attributes: { code: true } });
    else if (m[13]) ops.push({ insert: m[14], attributes: { link: m[15] } });
    rest = rest.slice(m.index + m[0].length);
  }
  return ops;
}

function mdToDelta(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
  const ops = [];
  let inCode = false;
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) { inCode = !inCode; continue; }
    if (inCode) { ops.push({ insert: raw }); ops.push({ insert: '\n', attributes: { 'code-block': true } }); continue; }
    let line = raw;
    const block = {};
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { block.header = m[1].length; line = m[2]; }
    else if ((m = /^>\s?(.*)$/.exec(line))) { block.blockquote = true; line = m[1]; }
    else if ((m = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line))) { block.list = m[1].trim() ? 'checked' : 'unchecked'; line = m[2]; }
    else if ((m = /^[-*+]\s+(.*)$/.exec(line))) { block.list = 'bullet'; line = m[1]; }
    else if ((m = /^\d+\.\s+(.*)$/.exec(line))) { block.list = 'ordered'; line = m[1]; }
    parseInline(line).forEach((o) => ops.push(o));
    ops.push(Object.keys(block).length ? { insert: '\n', attributes: block } : { insert: '\n' });
  }
  if (!ops.length) ops.push({ insert: '\n' });
  return { ops };
}

function applyInlineMd(text, attr) {
  attr = attr || {};
  if (attr.code) text = '`' + text + '`';
  if (attr.bold) text = '**' + text + '**';
  if (attr.italic) text = '*' + text + '*';
  if (attr.strike) text = '~~' + text + '~~';
  if (attr.link) text = '[' + text + '](' + attr.link + ')';
  return text;
}

function deltaToMarkdown(delta) {
  let md = '';
  let buf = '';
  const flush = (a) => {
    a = a || {};
    if (a['code-block']) { md += '    ' + buf + '\n'; buf = ''; return; }
    let prefix = '';
    if (a.header === 1) prefix = '# ';
    else if (a.header === 2) prefix = '## ';
    else if (a.header === 3) prefix = '### ';
    if (a.list === 'bullet') prefix = '- ' + prefix;
    else if (a.list === 'ordered') prefix = '1. ' + prefix;
    else if (a.list === 'checked') prefix = '- [x] ';
    else if (a.list === 'unchecked') prefix = '- [ ] ';
    if (a.blockquote) prefix = '> ' + prefix;
    md += prefix + buf + '\n';
    buf = '';
  };
  ((delta && delta.ops) || []).forEach((op) => {
    if (typeof op.insert !== 'string') return;
    const parts = op.insert.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) buf += applyInlineMd(parts[i], op.attributes);
      if (i < parts.length - 1) flush(op.attributes);
    }
  });
  if (buf) md += buf + '\n';
  return md.trim() + '\n';
}

module.exports = { mdToDelta, deltaToMarkdown };
