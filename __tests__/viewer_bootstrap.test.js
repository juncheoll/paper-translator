import { JSDOM } from 'jsdom';
import { bootstrapPdfViewer } from '../src/viewer_bootstrap.js';
function fixture(file = '') {
  const dom = new JSDOM('<div id="toolbarViewerRight"></div><div id="viewerContainer"></div>', {url:`https://extension.test/pdfjs/web/viewer.html?file=${encodeURIComponent(file)}`});
  const win=dom.window, handlers={},app={initializedPromise:Promise.resolve(),_openFileInput:{click:jest.fn()},
    appConfig:{mainContainer:win.document.getElementById('viewerContainer')},eventBus:{on:(name,fn)=>{handlers[name]=fn;}}};
  const set=jest.fn(), initializeTranslation=jest.fn();
  const runtime={getURL: path=>'https://extension.test/'+path,openOptionsPage:jest.fn(async()=>{})};
  const loadModule=jest.fn(async url=>{
    if(url.endsWith('viewer.mjs')) {
      win.PDFViewerApplication=app;win.PDFViewerApplicationOptions={set};
      win.document.dispatchEvent(new win.Event('webviewerloaded'));
      expect(set).toHaveBeenCalledWith('defaultUrl','');
      expect(set).toHaveBeenCalledWith('localeProperties',{lang:'ko'});
    }
  });
  return {win,app,handlers,set,runtime,initializeTranslation,loadModule,dom};
}
test('settings load before PDF.js runs and empty viewer supports file picking and PDF.js drop events',async()=>{
  const f=fixture();let release;
  const loadSettings=jest.fn(()=>new Promise(resolve=>{release=resolve;}));
  const pending=bootstrapPdfViewer({window:f.win,...f,loadSettings});
  expect(f.loadModule).not.toHaveBeenCalled();
  release({uiLanguage:'ko'});await pending;
  expect(f.initializeTranslation).toHaveBeenCalledTimes(1);
  expect(f.loadModule.mock.calls.map(([url])=>url.split('/').at(-1))).toEqual(['pdf.mjs','viewer.mjs']);
  const welcome=f.win.document.getElementById('paperWelcome');
  expect(welcome.parentNode).toBe(f.app.appConfig.mainContainer);
  welcome.querySelector('button').click();expect(f.app._openFileInput.click).toHaveBeenCalled();
  f.handlers.documentloaded();expect(f.win.document.getElementById('paperWelcome')).toBeNull();
  f.dom.window.close();
});
test('an existing PDF URL avoids the welcome screen and keeps a settings entry point',async()=>{
  const f=fixture('https://papers.test/a.pdf');
  await bootstrapPdfViewer({window:f.win,...f,loadSettings:async()=>({uiLanguage:'ko'})});
  expect(f.win.document.getElementById('paperWelcome')).toBeNull();
  f.win.document.querySelector('#paperViewerLinks button').click();expect(f.runtime.openOptionsPage).toHaveBeenCalled();
  f.dom.window.close();
});
