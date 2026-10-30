import {JSDOM} from 'jsdom';
import {createPdfVisualRenderer,visualRegionCrop} from '../src/pdf/visual_regions';
jest.mock('../src/i18n.js',()=>({getMessage:()=>''}));
const settle=()=>new Promise(setImmediate);
const region={pageNumber:8,width:600,height:800,bbox:{x:20,y:90,width:100,height:40}};
const block={id:'eq',kind:'formula',visualRegion:region};
const viewport=scale=>({width:600*scale,height:800*scale,convertToViewportPoint:(x,y)=>[x,800-y]});
test('crops pad and clip original coordinates, reject incompatible pages',()=>{
 expect(visualRegionCrop(region,viewport(1))).toEqual({x:18,y:88,width:104,height:44});
 expect(visualRegionCrop({...region,bbox:{x:0,y:0,width:20,height:10}},viewport(1))).toEqual({x:0,y:0,width:22,height:12});
 expect(()=>visualRegionCrop(region,viewport(2))).toThrow();
});
function fixture(options={}){
 const dom=new JSDOM('<!doctype html><body><div id="mttPdfTranslatePanel"><span id="content"></span></div></body>');
 const doc=dom.window.document,render=jest.fn(()=>({promise:Promise.resolve(),cancel:jest.fn()}));
 dom.window.HTMLCanvasElement.prototype.getContext=()=>({drawImage:jest.fn()});
 dom.window.HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/png;base64,aW1hZ2U=';
 const page={getViewport:({scale})=>viewport(scale),render,getTextContent:async()=>({items:[
  {str:'R',width:8,height:10,transform:[10,0,0,10,30,690]},
  {str:'S',width:5,height:7,transform:[7,0,0,7,38,688]}
 ]})};
 const pdfDocument={getPage:jest.fn(async()=>page)},findDefinitions=jest.fn(()=>[]),onJumpToEvidence=jest.fn();
 const renderer=createPdfVisualRenderer({pdfDocument,doc,findDefinitions,onJumpToEvidence,...options});
 return{dom,doc,page,pdfDocument,findDefinitions,onJumpToEvidence,renderer,container:doc.querySelector('#content')};
}
test('original PDF is rasterized once per geometry; source variable hover shows cited evidence and can jump',async()=>{
 const f=fixture();const evidence={text:'Let R denote decoded tokens.',pageNumber:8,unit:{id:'source'}};
 f.findDefinitions.mockReturnValue([evidence]);f.renderer.render(f.container,block);await settle();
 expect(f.container.querySelector('img').alt).toBe('원본 수식');
 const rendered=f.page.render.mock.calls[0][0].viewport;
 expect(rendered.width).toBeGreaterThan(600);expect(rendered.width*rendered.height).toBeLessThanOrEqual(4000001);
 expect(f.page.render.mock.calls[0][0].transform).toBeUndefined();
 const hit=f.container.querySelector('button[aria-label^="R_S"]');expect(hit).not.toBeNull();
 hit.dispatchEvent(new f.dom.window.Event('mouseenter'));await settle();
 expect(f.findDefinitions.mock.calls[0][0]).toMatchObject({symbol:'R_S',base:'R',subscript:'S'});
 expect(f.doc.querySelector('[role=tooltip]').textContent).toContain(evidence.text);
 f.doc.querySelector('[role=tooltip] button').click();expect(f.onJumpToEvidence).toHaveBeenCalledWith(evidence);
 f.renderer.render(f.container,{...block});await settle();expect(f.page.render).toHaveBeenCalledTimes(1);
 f.renderer.release(f.container);f.renderer.render(f.container,block);await settle();expect(f.page.render).toHaveBeenCalledTimes(1);
 f.renderer.destroy();expect(f.doc.querySelector('[role=tooltip]')).toBeNull();f.dom.window.close();
});
test('missing definitions are explicit; removed or destroyed regions cannot attach stale images',async()=>{
 const f=fixture();f.renderer.render(f.container,block);await settle();
 f.container.querySelector('button').click();await settle();
 expect(f.doc.querySelector('[role=tooltip]').textContent).toContain('찾지 못했습니다');
 f.renderer.destroy();f.dom.window.close();
});

test('closing a document cancels pending raster work and never adds a late image',async()=>{
 const f=fixture();let resolve;const promise=new Promise(done=>{resolve=done;});const cancel=jest.fn();
 f.page.render.mockReturnValue({promise,cancel});f.renderer.render(f.container,block);await settle();
 f.renderer.destroy();expect(cancel).toHaveBeenCalledTimes(1);resolve();await settle();
 expect(f.container.querySelector('img')).toBeNull();f.dom.window.close();
});

test('native PDF and panel variables share one tooltip and only its owner can dismiss it',async()=>{
 const f=fixture(),anchor=f.doc.createElement('div');f.doc.body.append(anchor);
 f.findDefinitions.mockReturnValue([{text:'Definition from the body.',pageNumber:8}]);
 await f.renderer.showVariable(anchor,{symbol:'R_S',base:'R',subscript:'S'},block);
 expect(f.renderer.isVariableActive(anchor)).toBe(true);expect(f.doc.querySelectorAll('#mttPdfVariableTooltip')).toHaveLength(1);
 f.renderer.hideVariable(f.container);expect(f.renderer.isVariableActive(anchor)).toBe(true);
 f.renderer.hideVariable(anchor);expect(f.doc.querySelector('#mttPdfVariableTooltip').hidden).toBe(true);
 f.renderer.destroy();f.dom.window.close();
});

test('panel hit areas also use font metadata and preserve hats plus all indices',async()=>{
 const f=fixture();f.page.getTextContent=async()=>({styles:{extension:{ascent:.04,descent:-.6}},items:[
  {str:'b',fontName:'extension',width:5.5,height:10,transform:[10,0,0,10,32,692.5]},
  {str:'E',width:8,height:10,transform:[10,0,0,10,30,690]},
  {str:'ℓ,v',width:9.7,height:7,transform:[7,0,0,7,38,688.5]}
 ]});f.renderer.render(f.container,block);await settle();
 const hits=f.container.querySelectorAll('.mttPdfSymbolHit');expect(hits).toHaveLength(1);
 expect(hits[0].getAttribute('aria-label')).toContain('Ê_{ℓ,v}');hits[0].click();await settle();
 expect(f.findDefinitions.mock.calls[0][0]).toMatchObject({base:'E',accent:'hat',subscript:'ℓ,v'});
 f.renderer.destroy();f.dom.window.close();
});

test('translated inline math uses original crops in translated order, aligned to text and without marker text',async()=>{
 const f=fixture();const unit={id:'sentence',inlineMath:[
  {token:'[M1]',text:'BS',baseline:110,fontSize:10,visualRegion:{...region,bbox:{x:30,y:100,width:8,height:10}}},
  {token:'[M2]',text:'Ehat',baseline:110,fontSize:10,visualRegion:{...region,bbox:{x:60,y:97,width:12,height:14}}}
 ]};
 f.renderer.renderInline(f.container,unit,'[M2]보다 [M1]입니다.');await settle();
 const images=f.container.querySelectorAll('.mttPdfInlineMath img');expect(images).toHaveLength(2);
 expect(f.container.textContent).toBe('Ehat보다 BS입니다.');expect(f.container.textContent).not.toContain('[M');
 expect(images[0].src).toContain('data:image/png');expect(images[1].parentElement.style.verticalAlign).toMatch(/em$/);
 expect(f.page.render).toHaveBeenCalledTimes(1);
 f.renderer.renderInline(f.container,unit,'[M2]보다 [M1]입니다.');expect(f.container.querySelector('img')).toBe(images[0]);
 const other=f.doc.createElement('span');f.doc.body.append(other);f.renderer.render(other,block);await settle();
 expect(f.page.render).toHaveBeenCalledTimes(1);
 f.renderer.destroy();f.dom.window.close();
});
