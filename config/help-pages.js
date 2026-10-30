const MarkdownIt = require('markdown-it');
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function renderHelp(buffer) {
  const md = new MarkdownIt({ html: false });
  const original = md.renderer.rules.link_open || ((tokens, i, options, env, self) => self.renderToken(tokens, i, options));
  md.renderer.rules.link_open = (tokens, i, options, env, self) => {
    const token = tokens[i], href = token.attrGet('href') || '';
    if (/^doc\/[a-z-]+\.md$/.test(href)) token.attrSet('href', 'help/' + href.slice(4, -3) + '.html');
    else if (href === 'THIRD_PARTY_NOTICES.md') token.attrSet('href', 'help/notices.html');
    else if (href === 'LICENSE') token.attrSet('href', 'LICENSE');
    return original(tokens, i, options, env, self);
  };
  md.renderer.rules.heading_open = (tokens, i, options, env, self) => {
    const value = tokens[i + 1]?.content || '';
    tokens[i].attrSet('id', value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''));
    return self.renderToken(tokens, i, options);
  };
  const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  const title = content.match(/^# (.+)/)?.[1] || 'Paper Translator';
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>' + escape(title) + '</title><style>body{max-width:940px;margin:40px auto;padding:0 24px 64px;color:#263733;background:#fafbf9;font:16px/1.85 system-ui}h1,h2,h3{line-height:1.35;letter-spacing:-.5px}h2{margin-top:2.2em}a{color:#147d73}table{display:block;overflow:auto;border-collapse:collapse}th,td{padding:10px 14px;border:1px solid #dfe7e3;text-align:left}th{background:#edf4ef}pre{overflow:auto;padding:16px;background:#edf2ef;border-radius:10px}code{font-size:.87em}blockquote{border-left:3px solid #9bbcad;padding-left:16px;color:#63746b}</style></head><body>' +
    md.render(content) + '</body></html>';
}
module.exports = { renderHelp };
