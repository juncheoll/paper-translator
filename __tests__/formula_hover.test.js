import {JSDOM} from 'jsdom';
import {createPdfFormulaHover,findFormulaAtPoint} from '../src/pdf/formula_hover';
jest.mock('../src/i18n.js',()=>({getMessage:()=>''}));
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function viewport(rotation=0,scale=1){
 const [a,b,c,d,e,f]={0:[scale,0,0,-scale,0,800*scale],90:[0,scale,scale,0,0,0],
  180:[-scale,0,0,scale,600*scale,0],270:[0,-scale,-scale,0,800*scale,600*scale]}[rotation];
 return{width:(rotation%180?800:600)*scale,height:(rotation%180?600:800)*scale,
  convertToViewportPoint:(x,y)=>[a*x+c*y+e,b*x+d*y+f],
  convertToPdfPoint:(x,y)=>[(d*(x-e)-c*(y-f))/(a*d-b*c),(-b*(x-e)+a*(y-f))/(a*d-b*c)]};
}
function fixture(rotation=0,scale=1,cssScale=1){
 const dom=new JSDOM('<!doctype html><body><div id="viewer"><div class="page" data-page-number="8"><div class="textLayer"><span>Native R S</span></div></div></div></body>');
 const win=dom.window,doc=win.document,viewer=doc.querySelector('#viewer'),div=doc.querySelector('.page'),span=doc.querySelector('span');
 const base=viewport(),v=viewport(rotation,scale),border=2;
 Object.defineProperties(div,{offsetWidth:{value:v.width+border*2},offsetHeight:{value:v.height+border*2},clientLeft:{value:border},clientTop:{value:border}});
 div.getBoundingClientRect=()=>({left:100,top:150,width:(v.width+border*2)*cssScale,height:(v.height+border*2)*cssScale});
 const content={items:[{str:'R',width:8,height:10,transform:[10,0,0,10,30,690]},{str:'S',width:5,height:7,transform:[7,0,0,7,38,688]},
  {str:'T',width:8,height:10,transform:[10,0,0,10,60,690]},{str:'E',width:5,height:7,transform:[7,0,0,7,68,688]}]};
 const getTextContent=jest.fn(async()=>content),page={getViewport:()=>base,getTextContent};
 const view={div,viewport:v,pdfPage:page},events=new Map(),frames=new Map();let frameId=0,enabled=true,owner,shown=false;
 win.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};win.cancelAnimationFrame=id=>frames.delete(id);
 const app={pdfViewer:{container:viewer,getPageView:()=>view},eventBus:{on:(n,fn)=>events.set(n,fn),off:n=>events.delete(n)}};
 const pdfDocument={getPage:jest.fn(async()=>page)};
 const block={id:'eq',kind:'formula',visualRegion:{pageNumber:8,width:600,height:800,bbox:{x:20,y:90,width:180,height:45}}};
 let units=[block];
 const visualRenderer={showVariable:jest.fn((a)=>{owner=a;shown=true;}),hideVariable:jest.fn((a)=>{if(a===owner)shown=false;}),isVariableActive:a=>a===owner&&shown};
 const hover=createPdfFormulaHover({app,pdfDocument,visualRenderer,getUnits:()=>units,isEnabled:()=>enabled});
 const position=(x,y)=>{const [vx,vy]=v.convertToViewportPoint(...base.convertToPdfPoint(x,y));return [100+(vx+border)*cssScale,150+(vy+border)*cssScale];};
 const move=(x=33,y=105,buttons=0)=>{const [clientX,clientY]=position(x,y);span.dispatchEvent(new win.MouseEvent('pointermove',{bubbles:true,clientX,clientY,buttons}));};
 const frame=async()=>{const all=[...frames.values()];frames.clear();all.forEach(fn=>fn());await settle();};
 return{dom,win,doc,viewer,div,span,base,view,content,block,events,frames,hover,visualRenderer,pdfDocument,getTextContent,move,frame,position,
  disable:()=>{enabled=false;hover.clear();},replaceUnits:()=>{units=[{...block}];}};
}

test.each([0,90,180,270])('source coordinates identify the same base/subscript variable at rotation %s, zoom and CSS scaling',async rotation=>{
 for(const [scale,cssScale]of [[.7,1],[2,1],[1.5,1.3]]){
  const f=fixture(rotation,scale,cssScale),[x,y]=f.position(33,105);
  expect(findFormulaAtPoint(f.view,[f.block],x,y,8)?.block).toBe(f.block);
  f.move();await f.frame();expect(f.visualRenderer.showVariable.mock.calls[0][1]).toMatchObject({symbol:'R_S'});
  expect(f.div.querySelector('.mttPdfSourceVariableAnchor').style.pointerEvents).toBe('none');
  f.move(40,109);await f.frame();expect(f.visualRenderer.showVariable).toHaveBeenCalledTimes(1);
  f.move(63,105);await f.frame();expect(f.visualRenderer.showVariable.mock.calls[1][1].symbol).toBe('T_E');
  expect(f.getTextContent).toHaveBeenCalledTimes(1);expect(f.span.textContent).toBe('Native R S');
  f.hover.destroy();f.dom.window.close();
 }
});

test('claims formula hover before asynchronous loading, leaves normal text alone and does not prevent selection',async()=>{
 const f=fixture(),claimed=jest.fn();f.win.addEventListener('mtt-pdf-variable-hover',claimed);
 f.move();expect(f.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(true);expect(claimed).toHaveBeenCalledTimes(1);
 await f.frame();expect(f.visualRenderer.showVariable).toHaveBeenCalledTimes(1);
 f.move(180,105);await f.frame();expect(f.visualRenderer.hideVariable).toHaveBeenLastCalledWith(expect.anything(),false);
 f.move(300,250);await f.frame();expect(f.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(false);
 f.move();await f.frame();const event=new f.win.MouseEvent('pointerdown',{bubbles:true,cancelable:true});
 expect(f.span.dispatchEvent(event)).toBe(true);expect(event.defaultPrevented).toBe(false);
 expect(f.doc.querySelector('.mttPdfSourceVariableAnchor')).toBeNull();
 f.move(33,105,1);await f.frame();expect(f.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(false);
 f.hover.destroy();f.dom.window.close();
});

test('leaving, editing, viewport changes and destroy prevent pending requests from reopening a tooltip',async()=>{
 const f=fixture();let resolve;f.getTextContent.mockReturnValue(new Promise(done=>{resolve=done;}));
 f.move();await f.frame();f.disable();resolve(f.content);await settle();expect(f.visualRenderer.showVariable).not.toHaveBeenCalled();
 expect(f.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(false);
 f.hover.destroy();expect(f.events.size).toBe(0);expect(f.frames.size).toBe(0);f.dom.window.close();
 const g=fixture();g.move();await g.frame();g.events.get('rotationchanging')();
 expect(g.doc.querySelector('.mttPdfSourceVariableAnchor')).toBeNull();
 g.move();await g.frame();g.viewer.dispatchEvent(new g.win.Event('scroll'));expect(g.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(false);
 g.hover.destroy();g.move();await g.frame();expect(g.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(false);g.dom.window.close();
});

test('replacement of parsed units while loading cannot show stale definitions',async()=>{
 const f=fixture();let resolve;f.getTextContent.mockReturnValue(new Promise(done=>{resolve=done;}));
 f.move();await f.frame();f.replaceUnits();resolve(f.content);await settle();
 expect(f.visualRenderer.showVariable).not.toHaveBeenCalled();f.hover.destroy();f.dom.window.close();
});

test('hovering the encoded hat or the final comma-separated index selects the same decorated identifier',async()=>{
 const f=fixture();f.content.styles={extension:{ascent:.04,descent:-.6},italic:{ascent:.694,descent:-.194}};
 f.content.items=[{str:'b',fontName:'extension',width:5.5,height:10,transform:[10,0,0,10,32,692.5]},
  {str:'E',fontName:'italic',width:8,height:10,transform:[10,0,0,10,30,690]},
  {str:'ℓ,v',fontName:'italic',width:9.7,height:7,transform:[7,0,0,7,38,688.5]}];
 f.move(34,98.5);await f.frame();expect(f.visualRenderer.showVariable.mock.calls[0][1]).toMatchObject({symbol:'Ê_{ℓ,v}',accent:'hat',subscript:'ℓ,v'});
 f.move(46,109);await f.frame();expect(f.visualRenderer.showVariable).toHaveBeenCalledTimes(1);
 f.disable();expect(f.doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')).toBe(false);
 f.hover.destroy();f.dom.window.close();
});
