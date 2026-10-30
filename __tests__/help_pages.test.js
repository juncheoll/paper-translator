const { JSDOM } = require('jsdom');
const { renderHelp } = require('../config/help-pages.js');
const fs = require('fs');
test('offline help declares UTF-8 and renders Docling anchor, links and readable tables',()=>{
 const doc = new JSDOM(renderHelp(fs.readFileSync(require('path').resolve(__dirname,'../README.md')))).window.document;
 expect(doc.querySelector('meta[charset]').getAttribute('charset')).toBe('utf-8');
 expect(doc.querySelector('#docling').textContent).toBe('Docling');
 expect(doc.querySelectorAll('table').length).toBeGreaterThan(0);
 expect(doc.querySelector('a[href="help/server.html"]')).not.toBeNull();
 expect(doc.body.textContent).not.toContain('\uFFFD');
 expect(doc.querySelector('script')).toBeNull();
});
test('help escapes embedded HTML rather than executing it',()=>{
 const html=renderHelp(Buffer.from('# 안내\n\n<script>alert(1)</script>'));
 expect(new JSDOM(html).window.document.querySelector('script')).toBeNull();
});
