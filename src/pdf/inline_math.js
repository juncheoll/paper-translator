import { extractFormulaVariables } from "./formula_variables.js";
const mathFont = /(?:CMMI|CMSY|CMEX|MSAM|MSBM|Math|STIX.*(?:Symbol|Integral|Variant)|Asana|SymbolMT)/i;
const unicodeMath = /[\u0370-\u03ff\u2200-\u22ff\u27c0-\u27ef\u{1d400}-\u{1d7ff}]/u;
const punctuation = /^[\s\d.,;:()[\]{}=+\-−×÷/|<>≤≥≠≈*^]+$/u;
const median = values => { const sorted=values.filter(v=>v>0).sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||10; };
const union = boxes => {const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return{x,y,
 width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};};
export const isMathFontName = name => mathFont.test(name || '');

// Some embedded math fonts report ascent=descent=0 despite drawing a visible glyph.
export function pdfFontMetrics(style = {}, ascent = .85, descent = -.2) {
 const top = Number.isFinite(style.ascent) ? style.ascent : ascent;
 const bottom = Number.isFinite(style.descent) ? style.descent : descent;
 return top > bottom ? {ascent:top,descent:bottom} : {ascent,descent};
}

export function pdfFontNames(page,styles) {
 return Object.fromEntries(Object.keys(styles||{}).map(id=>{try{return[id,page.commonObjs?.get(id)?.name||styles[id].fontFamily||''];}
  catch(_){return[id,styles[id].fontFamily||''];}}));
}

export function extractInlineMathRegions(items,styles = {},viewport,blocks,fontNames = {},pageNumber = 1) {
 const native=new Map();
 for(const [index,item]of items.entries()){
  if(!item.str?.trim()||!item.transform||!Number.isFinite(item.width))continue;
  const tx=viewport.transform||[1,0,0,-1,0,viewport.height],px=item.transform[4],py=item.transform[5];
  const [x,baseline]=viewport.convertToViewportPoint ? viewport.convertToViewportPoint(px,py) :
   [tx[0]*px+tx[2]*py+tx[4],tx[1]*px+tx[3]*py+tx[5]];
  const height=Math.abs(item.height)||Math.hypot(item.transform[2],item.transform[3]),style=styles[item.fontName]||{};
  const name=fontNames[item.fontName]||style.fontFamily||'',text=item.str.trim();
  const accent=style.ascent>=0&&style.ascent<.15&&style.descent<=-.4;
  const {ascent,descent}=accent?{ascent:1,descent:0}:pdfFontMetrics(style);
  native.set(index,{index,text,x,baseline,font:height,width:Math.abs(item.width),accent,
   math:isMathFontName(name)||(text.length<=16&&!/[A-Za-z]{2,}/.test(text)&&unicodeMath.test(text)),
   italic:/italic|oblique/i.test(name)&&/^\p{L}$/u.test(text),
   bridge:punctuation.test(text),box:{x,y:baseline-ascent*height,width:Math.abs(item.width),height:(ascent-descent)*height}});
 }
 const result=[],seen=new Set();
 for(const block of blocks){
  if(!['paragraph','caption','footnote','heading'].includes(block.kind)||block.visualRegion)continue;
  const members=(block.sourceIndices||[]).map(i=>native.get(i)).filter(Boolean);
  if(!members.length)continue;
  for(const item of members.filter(i=>i.italic&&!i.math)){
   const scripts=members.filter(s=>s!==item&&s.font<item.font*.88&&Math.abs(s.baseline-item.baseline)>item.font*.06&&
    Math.abs(s.baseline-item.baseline)<item.font*.8&&Math.abs(s.x-item.x-item.width)<item.font*.5);
   if(scripts.length){item.math=true;for(const script of scripts)script.math=true;}
  }
  const font=median(members.filter(i=>!i.math&&!i.bridge).map(i=>i.font));
  const anchors=members.filter(i=>!i.math&&!i.bridge&&i.font>=font*.85).map(i=>i.baseline).sort((a,b)=>a-b);
  const baselines=anchors.filter((y,i)=>!i||y-anchors[i-1]>font*.35);
  if(!baselines.length)for(const item of members.filter(i=>!i.accent).sort((a,b)=>b.font-a.font)){
   if(!baselines.some(y=>Math.abs(y-item.baseline)<font*.5))baselines.push(item.baseline);
  }
  const rows=new Map();
  for(const item of members){
   const baseline=baselines.reduce((a,b)=>Math.abs(a-item.baseline)<Math.abs(b-item.baseline)?a:b,baselines[0]??item.baseline);
   if(!rows.has(baseline))rows.set(baseline,[]);rows.get(baseline).push(item);
  }
  for(const [baseline,row]of rows){
   let run=[];
   const flush=()=>{
    while(run.length&&/^[.,;:]+$/.test(run[0].text))run.shift();
    while(run.length&&/^[.,;:]+$/.test(run.at(-1).text))run.pop();
    if(run.some(i=>i.math)){
     const indices=run.map(i=>i.index),key=[...indices].sort((a,b)=>a-b).join(',');
     if(!seen.has(key)){
      seen.add(key);const visualRegion={pageNumber,width:viewport.width,height:viewport.height,bbox:union(run.map(i=>i.box))};
      const symbols=run.some(i=>i.accent)?extractFormulaVariables(items,viewport,visualRegion,styles).map(v=>v.symbol):[];
      result.push({itemIndices:indices,baseline,fontSize:font,visualRegion,...(symbols.length?{symbols}: {})});
     }
    }
    run=[];
   };
   for(const item of row.sort((a,b)=>a.x-b.x||a.index-b.index)){
    const previous=run.at(-1);
    if(!item.math&&!item.bridge){flush();continue;}
    if(previous&&item.x-previous.x-previous.width>font*.75)flush();
    run.push(item);
   }
   flush();
  }
 }
 return result;
}

// Bind page geometry to sentence character offsets after line/page stitching, keeping native provenance intact.
export function bindInlineMath(unit,pages) {
 const matches=[];
 for(const page of pages)for(const region of page.inlineMathRegions||[]){
  const indices=new Set(region.itemIndices),spans=(unit.textSpans||[]).filter(span=>
   (span.pageNumber??unit.ownerPageNumber)===page.pageNumber&&indices.has(span.itemIndex));
  if(!spans.length||region.itemIndices.some(i=>!spans.some(s=>s.itemIndex===i)))continue;
  const start=Math.min(...spans.map(s=>s.start)),end=Math.max(...spans.map(s=>s.end));
  const outside=(unit.textSpans||[]).some(span=>span.start<end&&span.end>start&&
   ((span.pageNumber??unit.ownerPageNumber)!==page.pageNumber||!indices.has(span.itemIndex))&&
   unit.text.slice(Math.max(start,span.start),Math.min(end,span.end)).trim());
  if(!outside)matches.push({...region,start,end,text:unit.text.slice(start,end)});
 }
 matches.sort((a,b)=>a.start-b.start);
 const selected=matches.filter((m,i)=>!i||m.start>=matches[i-1].end);
 let prefix='M';while(unit.text.includes(`[${prefix}`))prefix='MTT'+prefix;
 if(selected.length)unit.inlineMath=selected.map((m,i)=>({...m,token:`[${prefix}${i+1}]`}));
 return unit;
}
export function protectedMathText(unit) {
 let text=unit.text;
 for(const math of [...unit.inlineMath||[]].reverse())text=text.slice(0,math.start)+math.token+text.slice(math.end);
 return text;
}
export function validMathTranslation(text,unit) {
 if(!unit.inlineMath?.length)return true;
 const expected=unit.inlineMath.map(m=>m.token),prefix=expected[0].match(/^\[([^\d]+)/)[1];
 const found=String(text||'').match(new RegExp(`\\[${prefix}\\d+\\]`,'g'))||[];
 return found.length===expected.length&&expected.every(token=>found.filter(t=>t===token).length===1);
}
export function plainMathText(text,unit) {
 for(const math of unit.inlineMath||[])text=String(text).split(math.token).join(math.symbols?.join(' ')||math.text);
 return text;
}
export function mathTranslationError() { return Object.assign(new Error('Translation did not preserve every inline math symbol.'),{code:'MATH_PLACEHOLDER'}); }
