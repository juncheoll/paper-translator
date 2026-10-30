const fs=require('fs'),path=require('path');
const {JSDOM}=require('jsdom');
const config=require('../webpack.config.js')({}, {mode:'production'});
const root=path.resolve(__dirname,'../public');
const bundles=new Set(Object.keys(config.entry).map(name=>name+'.js'));
test.each(['settings.html','popup.html','offscreen.html','pdfjs/web/viewer.html'])('%s references packaged scripts and styles that exist',file=>{
 const doc=new JSDOM(fs.readFileSync(path.join(root,file),'utf8')).window.document;
 for(const node of doc.querySelectorAll('script[src],link[rel="stylesheet"][href]')){
  const ref=node.getAttribute('src')||node.getAttribute('href');
  const relative=path.relative(root,path.resolve(path.dirname(path.join(root,file)),ref));
  expect(fs.existsSync(path.join(root,relative))||bundles.has(relative)).toBe(true);
 }
});
test('manifest points to built entries and excludes legacy permissions and web-accessible frames',()=>{
 const m=JSON.parse(fs.readFileSync(path.join(root,'manifest.json')));
 expect(bundles.has(m.background.service_worker)).toBe(true);
 expect(m.default_locale).toBe('en');
 expect(m.permissions).toEqual(expect.arrayContaining(['nativeMessaging','offscreen','storage']));
 expect(m.permissions).not.toEqual(expect.arrayContaining(['tts']));
 expect(m.web_accessible_resources).toBeUndefined();
 for(const c of m.content_scripts) for(const js of c.js) expect(bundles.has(js)).toBe(true);
});
