import { getMessage } from "../i18n.js";
import { extractFormulaVariables } from "./formula_variables.js";
import { validMathTranslation } from "./inline_math.js";
const msg = (key,fallback) => getMessage(key) || fallback;

export function visualRegionCrop(region, viewport, padding = 2) {
  const b = region?.bbox;
  if (!b || ![b.x,b.y,b.width,b.height,region.width,region.height].every(Number.isFinite) || b.width<=0 || b.height<=0 ||
    Math.abs(region.width-viewport.width)>1 || Math.abs(region.height-viewport.height)>1) throw new Error('Incompatible region coordinates');
  const x = Math.max(0,b.x-padding), y = Math.max(0,b.y-padding);
  const width = Math.min(viewport.width,b.x+b.width+padding)-x, height = Math.min(viewport.height,b.y+b.height+padding)-y;
  if (width<=0 || height<=0) throw new Error('Empty region');
  return {x,y,width,height};
}

export function createPdfVisualRenderer({ pdfDocument, doc = document, findDefinitions = () => [], onJumpToEvidence,
  isCurrent = () => true, maxCached = 64 }) {
  const win = doc.defaultView, cache = new Map(), records = new Map(), tasks = new Set(), rasters = new Map();
  let destroyed = false, tooltipAnchor, hideTimer, request = 0;
  const style = doc.createElement('style');
  style.textContent = `
    #mttPdfTranslatePanel .mttPdfTranslateFormula, #mttPdfTranslatePanel .mttPdfTranslateTable { white-space:normal; }
    #mttPdfTranslatePanel .mttPdfVisualRegion { display:block; position:relative; width:100%; overflow:hidden; background:#fff; }
    #mttPdfTranslatePanel .mttPdfVisualRegion img { display:block; width:100%; height:auto; }
    #mttPdfTranslatePanel .mttPdfVisualRegion .mttPdfSymbolHit { position:absolute; margin:0; padding:0; min-width:0; min-height:0;
      border:0; border-radius:2px; background:transparent; color:transparent; cursor:help; }
    #mttPdfTranslatePanel .mttPdfVisualRegion .mttPdfSymbolHit:hover,
    #mttPdfTranslatePanel .mttPdfVisualRegion .mttPdfSymbolHit:focus-visible { background:#f59e0b33; outline:1px solid #d97706; }
    #mttPdfTranslatePanel .mttPdfInlineMath { display:inline-block; position:relative; max-width:100%; line-height:0; }
    #mttPdfTranslatePanel .mttPdfInlineMath img { display:block; width:100%; height:auto; }
    #mttPdfTranslatePanel .mttPdfInlineMathAlt { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    #mttPdfTranslatePanel .mttPdfVisualLoading { display:block; color:#64748b; font:12px/1.6 system-ui; }
    #mttPdfVariableTooltip { position:fixed; z-index:1002; width:400px; max-width:calc(100vw - 24px); max-height:45vh;
      overflow:auto; padding:12px 14px; border:1px solid #cbd5e1; border-radius:8px; background:#fff; color:#182230;
      box-shadow:0 5px 22px #0003; font:13px/1.6 system-ui; }
    #mttPdfVariableTooltip[hidden] { display:none; }
    #mttPdfVariableTooltip strong { font-size:15px; }
    #mttPdfVariableTooltip p { margin:5px 0 10px; white-space:pre-wrap; }
    #mttPdfVariableTooltip .mttPdfEvidenceSource { color:#64748b; font-size:12px; }
    #mttPdfVariableTooltip button { padding:0; border:0; background:none; color:#1d4ed8; text-decoration:underline; cursor:pointer; font:inherit; }
    @media print { #mttPdfVariableTooltip { display:none !important; } }
  `;
  doc.head.append(style);
  const tooltip = doc.createElement('div'); tooltip.id='mttPdfVariableTooltip'; tooltip.hidden=true; tooltip.setAttribute('role','tooltip'); doc.body.append(tooltip);
  function hide() {
    request++; win.clearTimeout(hideTimer); tooltip.hidden=true;
    tooltipAnchor?.removeAttribute('aria-describedby'); tooltipAnchor=null;
  }
  const delayedHide = () => { win.clearTimeout(hideTimer); hideTimer=win.setTimeout(hide,150); };
  const scrolled = (event) => { if(!tooltip.contains(event.target)) hide(); };
  doc.addEventListener('scroll',scrolled,true); win.addEventListener('resize',hide);
  tooltip.addEventListener('mouseenter',()=>win.clearTimeout(hideTimer));
  tooltip.addEventListener('mouseleave',delayedHide);
  tooltip.addEventListener('keydown',event=>{if(event.key==='Escape') { event.stopPropagation(); hide(); }});
  const positionTooltip = (anchor) => {
    const b = anchor.getBoundingClientRect();
    tooltip.style.left=`${Math.max(12,Math.min(b.left,win.innerWidth-tooltip.offsetWidth-12))}px`;
    tooltip.style.top=`${Math.max(12,Math.min(b.bottom+8,win.innerHeight-tooltip.offsetHeight-12))}px`;
  };
  async function explain(anchor,variable,record) {
    hide(); win.clearTimeout(hideTimer); const token=++request; tooltipAnchor=anchor;
    tooltip.hidden=false; anchor.setAttribute('aria-describedby',tooltip.id); tooltip.replaceChildren();
    win.dispatchEvent(new win.Event('mtt-pdf-variable-hover'));
    const title = doc.createElement('strong'); title.textContent=variable.symbol; tooltip.append(title);
    const intro = doc.createElement('p'); intro.textContent=msg('PDF_Variable_Evidence','본문에서 찾은 설명 근거'); tooltip.append(intro); positionTooltip(anchor);
    try {
      const evidence=await findDefinitions(variable,{...record.block,pageNumber:record.block.visualRegion.pageNumber});
      if (destroyed || token!==request || !isCurrent() || !anchor.isConnected) return;
      if (!evidence?.length) {
        intro.textContent=msg('PDF_Variable_Not_Found','본문에서 이 변수의 설명을 찾지 못했습니다.');
      } else for (const item of evidence) {
        const p=doc.createElement('p'); p.textContent=(item.translation || item.text).slice(0,900); tooltip.append(p);
        if (item.translation) { const original=doc.createElement('p'); original.className='mttPdfEvidenceSource'; original.textContent=item.text.slice(0,900); tooltip.append(original); }
        const link=doc.createElement('button'); link.type='button';
        link.textContent=`${item.pageNumber} · ${msg('PDF_Variable_View_Source','설명 원문 보기')}`;
        link.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();hide();onJumpToEvidence?.(item);}); tooltip.append(link);
      }
      positionTooltip(anchor);
    } catch (_) { if (token===request) intro.textContent=msg('PDF_Variable_Not_Found','본문에서 이 변수의 설명을 찾지 못했습니다.'); }
  }
  function retireRaster(entry) {
    entry.evicted=true;
    if(!entry.users && entry.canvas) entry.canvas.width=entry.canvas.height=0;
  }
  function acquireRaster(pageNumber) {
    let entry=rasters.get(pageNumber);
    if(entry) {rasters.delete(pageNumber);rasters.set(pageNumber,entry);}
    else {
      entry={users:0,canvas:null,evicted:false};
      entry.promise=(async()=>{
        const page=await pdfDocument.getPage(pageNumber),base=page.getViewport({scale:1});
        if(destroyed || !isCurrent())throw new DOMException('Stopped','AbortError');
        const scale=Math.min(3,Math.sqrt(4000000/(base.width*base.height))),canvas=doc.createElement('canvas');
        canvas.width=Math.ceil(base.width*scale);canvas.height=Math.ceil(base.height*scale);entry.canvas=canvas;
        const task=page.render({canvasContext:canvas.getContext('2d'),viewport:page.getViewport({scale}),background:'rgb(255,255,255)'});
        tasks.add(task);
        try {await task.promise;return {page,base,scale,canvas};} finally {tasks.delete(task);}
      })();
      entry.promise.catch(()=>{if(rasters.get(pageNumber)===entry)rasters.delete(pageNumber);retireRaster(entry);});
      rasters.set(pageNumber,entry);
      while(rasters.size>2){const first=rasters.keys().next().value,old=rasters.get(first);rasters.delete(first);retireRaster(old);}
    }
    entry.users++;return entry;
  }
  async function snapshot(block) {
    const region=block.visualRegion,entry=acquireRaster(region.pageNumber);
    let canvas;
    try {
      const raster=await entry.promise;
      if(destroyed || !isCurrent())throw new DOMException('Stopped','AbortError');
      const crop=visualRegionCrop(region,raster.base,block.inlineMathImage ? .6 : 2);
      canvas=doc.createElement('canvas');canvas.width=Math.ceil(crop.width*raster.scale);canvas.height=Math.ceil(crop.height*raster.scale);
      canvas.getContext('2d').drawImage(raster.canvas,crop.x*raster.scale,crop.y*raster.scale,crop.width*raster.scale,crop.height*raster.scale,
        0,0,canvas.width,canvas.height);
      let variables=[];
      if(block.kind==='formula') {
        entry.content ||= raster.page.getTextContent({includeMarkedContent:true,disableNormalization:true});
        const content=await entry.content;
        variables=extractFormulaVariables(content.items,raster.base,region,content.styles);
      }
      if(destroyed || !isCurrent())throw new DOMException('Stopped','AbortError');
      return {url:canvas.toDataURL('image/png'),crop,variables};
    } finally {
      if(canvas)canvas.width=canvas.height=0;
      entry.users--;if(entry.evicted)retireRaster(entry);
    }
  }
  function cachedSnapshot(key,block) {
    if(!cache.has(key)) {
      const pending=snapshot(block);cache.set(key,pending);
      pending.catch(()=>{if(cache.get(key)===pending)cache.delete(key);});
      while(cache.size>maxCached)cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
  }
  function release(container) {
    const record=records.get(container); if(!record)return;
    if(tooltipAnchor && container.contains(tooltipAnchor)) hide();
    record.listeners.abort(); records.delete(container);
  }
  function render(container,block) {
    if (destroyed || !block.visualRegion) return;
    const key=JSON.stringify([block.kind,block.visualRegion]);
    const existing=records.get(container);
    if(existing?.key===key) {existing.block=block;return;}
    release(container);
    const record={key,block,listeners:new win.AbortController()}; records.set(container,record);
    container.replaceChildren(); container.setAttribute('translate','no');
    const loading=doc.createElement('span'); loading.className='mttPdfVisualLoading';
    loading.textContent=msg('PDF_Visual_Loading','원본 영역을 불러오는 중…'); container.append(loading);
    const pending=cachedSnapshot(key,block);
    pending.then(({url,crop,variables})=>{
      if(destroyed || !isCurrent() || records.get(container)!==record || !container.isConnected)return;
      const wrapper=doc.createElement('span'); wrapper.className='mttPdfVisualRegion';
      const image=doc.createElement('img'); image.src=url;
      image.alt=msg(block.kind==='formula'?'PDF_Visual_Formula':'PDF_Visual_Table',block.kind==='formula'?'원본 수식':'원본 표');
      wrapper.append(image);
      for(const variable of variables) {
        const hit=doc.createElement('button'); hit.type='button'; hit.className='mttPdfSymbolHit';
        hit.setAttribute('aria-label',`${variable.symbol} · ${msg('PDF_Variable_Explain','본문 설명 찾기')}`);
        hit.style.left=`${(variable.bbox.x-crop.x)/crop.width*100}%`; hit.style.top=`${(variable.bbox.y-crop.y)/crop.height*100}%`;
        hit.style.width=`${variable.bbox.width/crop.width*100}%`;hit.style.height=`${variable.bbox.height/crop.height*100}%`;
        hit.addEventListener('mouseenter',()=>{void explain(hit,variable,record);},{signal:record.listeners.signal});
        hit.addEventListener('mouseleave',delayedHide,{signal:record.listeners.signal});
        hit.addEventListener('focus',()=>{void explain(hit,variable,record);},{signal:record.listeners.signal});
        hit.addEventListener('blur',delayedHide,{signal:record.listeners.signal});
        hit.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();void explain(hit,variable,record);},{signal:record.listeners.signal});
        hit.addEventListener('keydown',event=>{if(['Enter',' ','Escape'].includes(event.key)){event.preventDefault();event.stopPropagation();if(event.key==='Escape')hide();else void explain(hit,variable,record);}},{signal:record.listeners.signal});
        wrapper.append(hit);
      }
      container.replaceChildren(wrapper);
      if(variables.length) {
        const help=doc.createElement('span');help.className='mttPdfVisualLoading';
        help.textContent=msg('PDF_Visual_Variable_Help','변수에 마우스를 올리면 본문 설명을 표시합니다.');container.append(help);
      }
    }).catch(()=>{
      if(destroyed || records.get(container)!==record || !container.isConnected)return;
      loading.textContent=msg('PDF_Visual_Failed','원본 영역을 불러오지 못했습니다.');
      const retry=doc.createElement('button');retry.type='button';retry.textContent=msg('PDF_Visual_Retry','다시 불러오기');
      retry.onclick=event=>{event.stopPropagation();release(container);cache.delete(key);render(container,block);};container.append(retry);
    });
  }
  function renderInline(container,block,translatedText) {
    if(destroyed || !validMathTranslation(translatedText,block))return;
    const key=JSON.stringify(['inline',translatedText,block.inlineMath]);
    if(records.get(container)?.key===key)return;
    release(container);const record={key,block,listeners:new win.AbortController()};records.set(container,record);
    const mathByToken=new Map(block.inlineMath.map(math=>[math.token,math])),nodes=[];
    let start=0;
    for(const match of translatedText.matchAll(/\[(?:MTT)*M\d+\]/g)) {
      const math=mathByToken.get(match[0]);if(!math)continue;
      nodes.push(doc.createTextNode(translatedText.slice(start,match.index)));start=match.index+match[0].length;
      const wrapper=doc.createElement('span');wrapper.className='mttPdfInlineMath';wrapper.setAttribute('role','img');
      wrapper.setAttribute('aria-label',math.text);wrapper.setAttribute('translate','no');
      const crop=visualRegionCrop(math.visualRegion,math.visualRegion,.6);
      wrapper.style.width=`${crop.width/math.fontSize}em`;wrapper.style.verticalAlign=`${(math.baseline-crop.y-crop.height)/math.fontSize}em`;
      const image=doc.createElement('img');image.alt='';image.setAttribute('aria-hidden','true');
      image.style.aspectRatio=`${crop.width} / ${crop.height}`;
      image.src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
      const alt=doc.createElement('span');alt.className='mttPdfInlineMathAlt';alt.textContent=math.text;
      wrapper.append(image,alt);nodes.push(wrapper);
      const cropBlock={kind:'inline_math',visualRegion:math.visualRegion,inlineMathImage:true};
      const cropKey=JSON.stringify([cropBlock.kind,math.visualRegion]);
      cachedSnapshot(cropKey,cropBlock).then(snapshot=>{
        if(!destroyed && isCurrent() && records.get(container)===record && container.isConnected)image.src=snapshot.url;
      }).catch(()=>{
        if(records.get(container)!==record)return;
        wrapper.replaceChildren(doc.createTextNode(math.text));wrapper.style.width='auto';wrapper.style.verticalAlign='baseline';
        wrapper.title=msg('PDF_Visual_Failed','원본 영역을 불러오지 못했습니다.');
      });
    }
    nodes.push(doc.createTextNode(translatedText.slice(start)));container.replaceChildren(...nodes);
  }
  return { render,renderInline,release,hideTooltip:hide,
    showVariable: (anchor,variable,block) => explain(anchor,variable,{block}),
    hideVariable: (anchor,immediate = true) => { if(tooltipAnchor===anchor) immediate ? hide() : delayedHide(); },
    isVariableActive: (anchor) => tooltipAnchor===anchor && !tooltip.hidden,
    destroy(){destroyed=true;hide();doc.removeEventListener('scroll',scrolled,true);win.removeEventListener('resize',hide);
      for(const container of [...records.keys()])release(container);for(const task of tasks)task.cancel();for(const entry of rasters.values())retireRaster(entry);rasters.clear();cache.clear();style.remove();tooltip.remove();},
  };
}
