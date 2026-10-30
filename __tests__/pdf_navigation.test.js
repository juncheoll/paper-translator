import { pdfViewerUrl, validPdfSource, isLocalPdf } from '../src/pdf_urls.js';
import { registerPdfNavigation } from '../src/pdf_navigation.js';
const setup = (enabled = true) => {
  const browser = { runtime: { id:'own-id', getURL:path=>`chrome-extension://own-id/${path}`, onMessage:{addListener:jest.fn()} },
    storage:{local:{get:jest.fn(async()=>({pdfAutoOpen:enabled}))}}, tabs:{onUpdated:{addListener:jest.fn()},update:jest.fn()} };
  registerPdfNavigation(browser);
  return { browser, receive:browser.runtime.onMessage.addListener.mock.calls[0][0], update:browser.tabs.onUpdated.addListener.mock.calls[0][0] };
};
const sender={id:'own-id',frameId:0,tab:{id:12},url:'https://papers.test/paper.pdf?download=1'};
test('PDF source URLs keep query strings safely and reject active or credential URLs',()=>{
  const {browser}=setup();
  expect(new URL(pdfViewerUrl(browser.runtime,sender.url)).searchParams.get('file')).toBe(sender.url);
  expect(validPdfSource('https://papers.test/a.pdf')).toBe(true);
  for(const value of ['javascript:alert(1)','data:application/pdf,x','https://user:secret@host/a.pdf','chrome://settings']) expect(validPdfSource(value)).toBe(false);
  expect(isLocalPdf('file:///a%20b/PAPER.PDF?x=1')).toBe(true);
});
test('automatic PDF navigation derives the source and destination tab from a trusted top frame',async()=>{
  const {browser,receive}=setup();
  await receive({type:'openPdf'},sender);
  expect(browser.tabs.update).toHaveBeenCalledWith(12,{url:pdfViewerUrl(browser.runtime,sender.url)});
  browser.tabs.update.mockClear();
  for(const invalid of [{...sender,id:'other'},{...sender,frameId:1},{...sender,url:'javascript:x'},{...sender,tab:undefined}]) await receive({type:'openPdf'},invalid);
  await receive({type:'openPdf',url:'https://elsewhere.test'},sender);
  expect(browser.tabs.update).not.toHaveBeenCalled();
});
test('disabled automatic navigation leaves the browser PDF alone',async()=>{
  const {browser,receive,update}=setup(false);
  await receive({type:'openPdf'},sender); update(12,{url:'file:///paper.pdf'});
  await Promise.resolve();await Promise.resolve();
  expect(browser.tabs.update).not.toHaveBeenCalled();
});
