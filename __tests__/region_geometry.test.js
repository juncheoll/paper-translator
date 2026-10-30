import { JSDOM } from 'jsdom';
import { createPdfRegionGeometryEditor, resizeRegionRect, splitRegionRect, unprojectRegionRect } from '../src/pdf/region_geometry';
import { projectLayoutRegion } from '../src/pdf/layout_overlay';
jest.mock('../src/i18n.js', () => ({ getMessage: () => '' }));
const settle = () => new Promise(setImmediate);
const page = { pageNumber:1, width:600, height:800 };
const region = { id:1, label:'text', bbox:{ x:100,y:200,width:200,height:100 } };
function viewport(rotation = 0, scale = 1) {
  const transform = {0:[scale,0,0,-scale,0,800*scale],90:[0,scale,scale,0,0,0],
    180:[-scale,0,0,scale,600*scale,0],270:[0,-scale,-scale,0,800*scale,600*scale]}[rotation];
  const [a,b,c,d,e,f] = transform;
  return { width:(rotation%180?800:600)*scale, height:(rotation%180?600:800)*scale,
    convertToViewportPoint:(x,y)=>[a*x+c*y+e,b*x+d*y+f],
    convertToPdfPoint:(x,y)=>[(d*(x-e)-c*(y-f))/(a*d-b*c),(-b*(x-e)+a*(y-f))/(a*d-b*c)] };
}

test.each([0,90,180,270])('geometry round trips and split coverage survive rotation %s and zoom', rotation => {
  for (const scale of [.5,1,2.5]) {
    const base = viewport(), v = viewport(rotation,scale);
    const b = projectLayoutRegion(region,page,base,v);
    const rect = { x:b.left/100*v.width,y:b.top/100*v.height,width:b.width/100*v.width,height:b.height/100*v.height };
    const result = unprojectRegionRect(rect,page,base,v);
    Object.keys(result).forEach(key=>expect(result[key]).toBeCloseTo(region.bbox[key]));
    for (const axis of ['horizontal','vertical']) {
      const parts = splitRegionRect(rect,axis,.3).map(part=>unprojectRegionRect(part,page,base,v));
      expect(parts.reduce((sum,p)=>sum+p.width*p.height,0)).toBeCloseTo(region.bbox.width*region.bbox.height);
      expect(Math.min(...parts.map(p=>p.x))).toBeCloseTo(region.bbox.x);
      expect(Math.max(...parts.map(p=>p.x+p.width))).toBeCloseTo(region.bbox.x+region.bbox.width);
    }
  }
});

test('native page rotation and resizing stay in the original page coordinate system', () => {
  const p = {...page,width:800,height:600}, base = viewport(90), v = viewport(270,2);
  const b = projectLayoutRegion(region,p,base,v);
  const rect = { x:b.left/100*v.width,y:b.top/100*v.height,width:b.width/100*v.width,height:b.height/100*v.height };
  const result = unprojectRegionRect(rect,p,base,v);
  Object.keys(result).forEach(key=>expect(result[key]).toBeCloseTo(region.bbox[key]));
  expect(resizeRegionRect(region.bbox,'nw',{x:-100,y:1000},page)).toEqual({x:0,y:292,width:300,height:8});
  expect(resizeRegionRect(region.bbox,'se',{x:900,y:900},page)).toEqual({x:100,y:200,width:500,height:600});
});

function fixture(onSave = jest.fn(async()=>{})) {
  const dom = new JSDOM('<!doctype html><body><button id="mttPdfLayoutEditToggle"></button><div id="viewer"><div id="page"></div></div></body>');
  const doc = dom.window.document, events = new Map();
  const view = { div:doc.querySelector('#page'), viewport:viewport(), pdfPage:{getViewport:()=>viewport()} };
  const app = { pdfViewer:{ container:doc.querySelector('#viewer'),getPageView:()=>view },
    eventBus:{ on:(name,fn)=>events.set(name,fn),off:name=>events.delete(name) } };
  const editor = createPdfRegionGeometryEditor({app,onSave});
  const click = text => [...doc.querySelectorAll('button')].find(b=>b.textContent===text).click();
  return {dom,doc,events,view,onSave,editor,click};
}

test('pointer resize and draggable split line save only on explicit confirmation', async () => {
  const f = fixture(); expect(f.editor.open(page,region)).toBe(true);
  const layer = f.doc.querySelector('.mttPdfGeometryLayer');
  layer.getBoundingClientRect = ()=>({left:10,top:20,width:600,height:800});
  f.doc.querySelector('[data-edge="se"]').dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,button:0}));
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointermove',{clientX:350+10,clientY:350+20,cancelable:true}));
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointerup'));
  const select = f.doc.querySelector('select'); select.value='horizontal'; select.dispatchEvent(new f.dom.window.Event('change'));
  f.doc.querySelector('[role=separator]').dispatchEvent(new f.dom.window.MouseEvent('pointerdown',{bubbles:true,button:0}));
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointermove',{clientX:200+10,clientY:250+20,cancelable:true}));
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointerup'));
  expect(f.onSave).not.toHaveBeenCalled(); f.click('저장'); await settle();
  expect(f.onSave).toHaveBeenCalledWith(page,region,{parts:[
    {label:'text',excluded:false,bbox:{x:100,y:200,width:250,height:50}},
    {label:'text',excluded:false,bbox:{x:100,y:250,width:250,height:100}}
  ]});
  expect(f.editor.isOpen()).toBe(false); f.editor.destroy(); f.dom.window.close();
});

test('cancel and viewport changes discard drafts; failed writes preserve a retryable draft', async () => {
  const f = fixture(jest.fn(async()=>{throw new Error('quota');}));
  f.editor.open(page,region); f.click('취소'); expect(f.onSave).not.toHaveBeenCalled();
  f.editor.open(page,region); f.events.get('rotationchanging')(); expect(f.editor.isOpen()).toBe(false);
  f.editor.open(page,region);
  f.doc.querySelector('[data-edge="e"]').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  f.click('저장'); await settle();
  expect(f.editor.isOpen()).toBe(true); expect(f.doc.querySelector('[role=alert]').textContent).toContain('저장하지 못했습니다');
  expect(f.onSave.mock.calls[0][2].parts[0].bbox.width).toBe(201);
  f.editor.destroy(); expect(f.events.size).toBe(0);
  expect(f.doc.querySelector('.mttPdfGeometryLayer')).toBeNull(); f.dom.window.close();
});
