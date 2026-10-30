import {extractInlineMathRegions,pdfFontNames,pdfFontMetrics,protectedMathText,validMathTranslation,bindInlineMath,plainMathText} from '../src/pdf/inline_math';
import {extractOrderedPage} from '../src/pdf/reading_order';
import {createDocumentSentencePages} from '../src/pdf/sentences';
import {sourceText,concatText} from '../src/pdf/text_provenance';
import deltaFixture from './fixtures/bigmomo-inline-delta.json';
const viewport={width:600,height:800,transform:[1,0,0,-1,0,800],convertToViewportPoint:(x,y)=>[x,800-y]};
const item=(str,x,y,width,fontName='body',height=10)=>({str,width,height,fontName,transform:[height,0,0,height,x,800-y]});
const styles={body:{ascent:.8,descent:-.2,fontFamily:'serif'},math:{ascent:.694,descent:-.194,fontFamily:'serif'},
 accent:{ascent:.04,descent:-.6,fontFamily:'sans-serif'},small:{ascent:.694,descent:-.194,fontFamily:'serif'}};
const names={body:'TimesRoman',math:'CMMI10',accent:'CMEX10',small:'CMMI7'};
const items=[item('Let ',40,110,15),item('b',57,107.5,5.5,'accent'),item('E',55,110,8,'math'),
 item('ℓ,v',63,111.5,10,'small',7),item(' be the estimate.',76,110,90)];

test('native math fonts, accents and subscripts remain one inline source crop while prose stays text',async()=>{
 const pdfPage={pageNumber:1,getViewport:()=>viewport,getTextContent:async()=>({items,styles}),getOperatorList:async()=>null,
  commonObjs:{get:id=>({name:names[id]})}};
 const layout={pageNumber:1,width:600,height:800,regions:[{id:1,label:'text',confidence:1,bbox:{x:40,y:99,width:130,height:20},
  cells:[{x:40,y:102,width:23,height:12},{x:55,y:102,width:112,height:12}]}]};
 const page=await extractOrderedPage(pdfPage,{layout});
 expect(page.blocks).toHaveLength(1);expect(page.blocks[0].text).toMatch(/^Let .* be the estimate\.$/);
 expect(page.inlineMathRegions).toHaveLength(1);
 expect(page.inlineMathRegions[0].itemIndices.sort()).toEqual([1,2,3]);
 const unit=createDocumentSentencePages([page])[0].blocks[0];
 expect(protectedMathText(unit)).toBe('Let [M1] be the estimate.');
 expect(unit.inlineMath[0].symbols).toContain('Ê_{ℓ,v}');
 expect(unit.inlineMath[0].visualRegion.bbox.y).toBe(97.5);
 expect(unit.sourceRanges.flatMap(r=>[r.itemIndex])).toEqual(expect.arrayContaining([0,1,2,3,4]));
});

test('degenerate font metrics fall back without changing valid accent or ordinary metrics',()=>{
 expect(pdfFontMetrics({ascent:0,descent:0})).toEqual({ascent:.85,descent:-.2});
 expect(pdfFontMetrics({ascent:-.2,descent:.4},1,0)).toEqual({ascent:1,descent:0});
 expect(pdfFontMetrics(styles.accent)).toEqual({ascent:.04,descent:-.6});
 expect(pdfFontMetrics(styles.body)).toEqual({ascent:.8,descent:-.2});
});

test.each([false,true])('BigMoMo zero-metric deltas stay inline and keep the wrapped candidate sentence complete (Docling: %s)',async(guided)=>{
 const {items,styles,fontNames,viewport,pageNumber,layout}=deltaFixture;
 const pdfPage={pageNumber,getViewport:()=>viewport,getTextContent:async()=>({items,styles}),getOperatorList:async()=>null,
  commonObjs:{get:id=>({name:fontNames[id]})}};
 const page=await extractOrderedPage(pdfPage,guided?{layout}:{});
 expect(page.blocks.every(block=>block.kind==='paragraph')).toBe(true);
 expect(page.blocks.flatMap(block=>block.sourceIndices).sort((a,b)=>a-b)).toEqual(items.flatMap((item,i)=>item.str.trim()?[i]:[]));
 const units=createDocumentSentencePages([page])[0].blocks;
 expect(units).toHaveLength(2);
 const target=units.find(unit=>unit.text.includes('additional routing impact'));
 expect(target.ownerPageNumber).toBe(pageNumber);
 expect(target.text).toContain('pruning candi-date expert');
 expect(target.text).toMatch(/define its pruning priority as.*Δ.*𝐶𝑒\.$/u);
 expect(target.inlineMath.map(math=>math.text)).toEqual(['Δ𝐼𝑒','𝑒','𝑃𝑒 = Δ𝐼𝑒 /𝐶𝑒']);
 expect(protectedMathText(target)).toContain('pruning candi-date expert [M2] and define its pruning priority as [M3].');
 for(const [i,item] of items.entries())if(item.str==='Δ'){
  expect(target.sourceRanges).toContainEqual({itemIndex:i,start:0,end:1});
  const crop=target.inlineMath.find(math=>math.itemIndices.includes(i)).visualRegion.bbox;
  expect(crop.height).toBeGreaterThan(item.height*.8);
  expect(crop.y).toBeLessThan(viewport.height-item.transform[5]-item.height*.8);
 }
});

test('inline expressions include their operators, parentheses and indices, but not neighboring words',()=>{
 const input=[item('time ',20,110,25),item('T',45,110,7,'math'),item('=',55,110,7),item('B',65,110,7,'math'),
  item('+',75,110,7),item('τ H',85,110,18,'math'),item(' on decoded tokens.',110,110,95)];
 const groups=extractInlineMathRegions(input,styles,viewport,[{kind:'paragraph',sourceIndices:input.map((_,i)=>i)}],names,1);
 expect(groups).toHaveLength(1);expect(groups[0].itemIndices).toEqual([1,2,3,4,5]);
 expect(groups[0].baseline).toBe(110);expect(groups[0].fontSize).toBe(10);
});

test('ordinary italic words remain translatable; isolated italic letters with scripts are protected',()=>{
 const input=[item('Important',20,110,50,'italic'),item('B',75,110,8,'italic'),item('S',83,111.5,5,'body',7),item(' has a cost.',95,110,60)];
 const groups=extractInlineMathRegions(input,styles,viewport,[{kind:'paragraph',sourceIndices:[0,1,2,3]}],{italic:'TimesItalic'},1);
 expect(groups).toHaveLength(1);expect(groups[0].itemIndices).toEqual([1,2]);
 expect(extractInlineMathRegions(input,styles,viewport,[{kind:'formula',sourceIndices:[0,1,2,3]}],names)).toEqual([]);
 expect(pdfFontNames({},styles).body).toBe('serif');
});

function page(n,first,variable,last=''){
 const parts=[sourceText(first,0),sourceText(variable,1),sourceText(last,2)],value=concatText(parts);
 return{pageNumber:n,width:600,height:800,blocks:[{id:`p${n}`,kind:'paragraph',...value,bbox:{x:20,y:100,width:200,height:12}}],
 inlineMathRegions:[{itemIndices:[1],baseline:110,fontSize:10,visualRegion:{pageNumber:n,width:600,height:800,bbox:{x:40,y:101,width:6,height:10}}}]};
}
test('complete sentences spanning pages retain both inline source crops and one shared translation identity',()=>{
 const pages=createDocumentSentencePages([page(1,'The value ','x'),page(2,' continues with ','y','.')]);
 const unit=pages[0].blocks[0];expect(pages[1].blocks[0]).toBe(unit);
 expect(unit.inlineMath.map(m=>m.visualRegion.pageNumber)).toEqual([1,2]);
 expect(protectedMathText(unit)).toBe('The value [M1] continues with [M2].');
});

test('math tokens are collision-free, may reorder, and reject omissions, duplicates or unknown tokens',()=>{
 const p=page(1,'Reference [M1] names ','x','.');const unit=createDocumentSentencePages([p])[0].blocks[0];
 expect(unit.inlineMath[0].token).toBe('[MTTM1]');
 expect(validMathTranslation('참조 [M1]의 [MTTM1]입니다.',unit)).toBe(true);
 expect(validMathTranslation('기호가 누락됨',unit)).toBe(false);
 expect(validMathTranslation('[MTTM1] [MTTM1]',unit)).toBe(false);
 expect(validMathTranslation('[MTTM1] [MTTM2]',unit)).toBe(false);
 expect(plainMathText('값 [MTTM1]',unit)).toBe('값 x');
 const combined=createDocumentSentencePages([page(1,'Value ','x',' and '),page(2,'value ','y','.')])[0].blocks[0];
 expect(validMathTranslation('[M2] 다음 [M1]',combined)).toBe(true);
});

test('binding never removes intervening prose between incorrectly combined math members',()=>{
 const p=page(1,'Words ','x',' are not math.');p.inlineMathRegions[0].itemIndices=[0,2];
 const unit={...p.blocks[0],ownerPageNumber:1};bindInlineMath(unit,[p]);expect(unit.inlineMath).toBeUndefined();
});
