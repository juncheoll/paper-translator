import { extractFormulaVariables } from "./formula_variables.js";
import { projectLayoutRegion } from "./layout_overlay.js";

function pagePoint(view, base, clientX, clientY) {
  const div = view.div, rect = div.getBoundingClientRect();
  const sx = div.offsetWidth ? rect.width / div.offsetWidth : 1;
  const sy = div.offsetHeight ? rect.height / div.offsetHeight : 1;
  if (!(sx > 0 && sy > 0)) return null;
  const point = base.convertToViewportPoint(...view.viewport.convertToPdfPoint(
    (clientX-rect.left)/sx-(div.clientLeft || 0), (clientY-rect.top)/sy-(div.clientTop || 0)));
  return point.every(Number.isFinite) ? { x:point[0], y:point[1] } : null;
}
const inside = (point,box,padding = 0) => point.x >= box.x-padding && point.x <= box.x+box.width+padding &&
  point.y >= box.y-padding && point.y <= box.y+box.height+padding;

export function findFormulaAtPoint(view,units,clientX,clientY,pageNumber) {
  if (!view?.div?.isConnected || !view.pdfPage || !view.viewport) return null;
  const base = view.pdfPage.getViewport({scale:1}), point = pagePoint(view,base,clientX,clientY);
  if (!point) return null;
  const block = units.find((unit) => unit.kind === 'formula' && unit.visualRegion?.pageNumber === pageNumber &&
    Math.abs(unit.visualRegion.width-base.width) <= 1 && Math.abs(unit.visualRegion.height-base.height) <= 1 &&
    inside(point,unit.visualRegion.bbox,3));
  return block ? {block,point,base,view,pageNumber} : null;
}

export function createPdfFormulaHover({ app,pdfDocument,getUnits,visualRenderer,
  isEnabled = () => true,isCurrent = () => true }) {
  const viewer = app.pdfViewer.container, doc = viewer.ownerDocument, win = doc.defaultView;
  const listeners = new win.AbortController(), contents = new Map(), variables = new Map();
  let frame, pending, sequence = 0, activeKey, anchor, destroyed = false;
  const claim = (enabled) => {
    if (enabled && !doc.documentElement.hasAttribute('data-mtt-pdf-variable-hover')) {
      doc.documentElement.setAttribute('data-mtt-pdf-variable-hover','');
      win.dispatchEvent(new win.Event('mtt-pdf-variable-hover'));
    } else if (!enabled) doc.documentElement.removeAttribute('data-mtt-pdf-variable-hover');
  };
  function leave(immediate = false) {
    sequence++; activeKey = null; pending = null;
    if (frame != null) win.cancelAnimationFrame(frame);
    frame = null;
    visualRenderer.hideVariable(anchor,immediate);
    if (immediate) { anchor?.remove(); anchor = null; }
  }
  function clear() { claim(false); leave(true); }
  async function resolve(match) {
    const token = ++sequence;
    const current = () => !destroyed && token === sequence && isCurrent() && isEnabled() &&
      match.view.div.isConnected && getUnits(match.pageNumber).includes(match.block);
    const key = JSON.stringify([match.block.id,match.block.visualRegion]);
    try {
      if (!variables.has(key)) {
        if (!contents.has(match.pageNumber)) {
          const promise = pdfDocument.getPage(match.pageNumber).then(page =>
            page.getTextContent({includeMarkedContent:true,disableNormalization:true}));
          contents.set(match.pageNumber,promise);
          promise.catch(() => { if(contents.get(match.pageNumber)===promise)contents.delete(match.pageNumber); });
        }
        const content = await contents.get(match.pageNumber);
        if (!current()) return;
        variables.set(key,extractFormulaVariables(content.items,match.base,match.block.visualRegion,content.styles));
        if (variables.size > 64) variables.delete(variables.keys().next().value);
      }
      if (!current()) return;
      const list = variables.get(key), index = list.findIndex(variable => inside(match.point,variable.bbox,0.5));
      if (index < 0) { leave(); return; }
      const hitKey = `${key}:${index}`;
      if (activeKey === hitKey && visualRenderer.isVariableActive(anchor)) return;
      const variable = list[index], bounds = projectLayoutRegion(variable,match.block.visualRegion,match.base,match.view.viewport);
      if (!bounds) { leave(); return; }
      if (!anchor || anchor.parentNode !== match.view.div) {
        visualRenderer.hideVariable(anchor); anchor?.remove(); anchor = doc.createElement('div');
        anchor.className = 'mttPdfSourceVariableAnchor'; anchor.setAttribute('aria-hidden','true');
        Object.assign(anchor.style,{position:'absolute',pointerEvents:'none'}); match.view.div.append(anchor);
      }
      Object.assign(anchor.style,{left:`${bounds.left/100*match.view.viewport.width}px`,top:`${bounds.top/100*match.view.viewport.height}px`,
        width:`${bounds.width/100*match.view.viewport.width}px`,height:`${bounds.height/100*match.view.viewport.height}px`});
      activeKey = hitKey;
      void visualRenderer.showVariable(anchor,variable,match.block);
    } catch (_) { if (current()) leave(); }
  }
  viewer.addEventListener('pointermove',event => {
    if (destroyed || !isCurrent() || !isEnabled() || event.buttons) { clear(); return; }
    const n = Number(event.target?.closest?.('.page[data-page-number]')?.dataset.pageNumber);
    const match = n && findFormulaAtPoint(app.pdfViewer.getPageView(n-1),getUnits(n),event.clientX,event.clientY,n);
    claim(!!match);
    if (!match) { leave(); return; }
    pending = match;
    if (frame != null) return;
    frame = win.requestAnimationFrame(() => { frame = null; if (pending) void resolve(pending); });
  },{signal:listeners.signal});
  viewer.addEventListener('pointerleave',() => {claim(false);leave();},{signal:listeners.signal});
  for (const event of ['pointerdown','scroll']) viewer.addEventListener(event,clear,{signal:listeners.signal,capture:event==='scroll'});
  doc.addEventListener('keydown',event=>{if(event.key==='Escape')clear();},{signal:listeners.signal});
  const events = ['pagechanging','scalechanging','rotationchanging','pagesinit'];
  for (const event of events) app.eventBus?.on(event,clear);
  return {clear,destroy() {
    if(destroyed)return;destroyed=true;clear();listeners.abort();contents.clear();variables.clear();
    for (const event of events) app.eventBus?.off(event,clear);
  }};
}
