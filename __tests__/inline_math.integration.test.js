jest.mock('webextension-polyfill', () => ({ __esModule:true, default:{} }));
import fs from 'node:fs';
import path from 'node:path';
import localLlm from '../src/services/translation.js';
import {protectedMathText,validMathTranslation} from '../src/pdf/inline_math';
const live=process.env.MTT_INLINE_MATH_SMOKE==='1'?test:test.skip;
live('local Hy-MT preserves native inline math in real paper sentences, including batch recovery',async()=>{
 const output=path.resolve(__dirname,'../../output/specfit-formula-check');
 const {pages}=JSON.parse(fs.readFileSync(path.join(output,'parsed.json')));
 const units=[pages[3].blocks.find(b=>b.text.includes('be the estimate of')&&b.inlineMath?.length),
  pages[7].blocks.find(b=>b.text.includes('configuration spend decode time')&&b.inlineMath?.length)];
 expect(units.every(Boolean)).toBe(true);
 const settings={llmApiEndpoint:'http://localhost:11434/v1',llmModel:'hy-mt2:1.8b-q8'};
 const entries=units.map((unit,i)=>({id:String(i),text:protectedMathText(unit)}));
 let responses,fallback=false;
 try{
  responses=await localLlm.translateBatchStrict(entries,'en','ko',settings,'',{preserveMath:true});
  if(responses.some((result,i)=>!validMathTranslation(result.targetText,units[i])))throw new Error('Math tokens changed');
 }catch(_){
  fallback=true;responses=[];
  for(const [i,entry]of entries.entries())responses.push(await localLlm.translateStrict(entry.text,'en','ko',settings,'',{sentenceOnly:true,preserveMath:true}));
 }
 responses.forEach((response,i)=>{expect(response.targetText).toMatch(/[가-힣]/);expect(validMathTranslation(response.targetText,units[i])).toBe(true);});
 fs.writeFileSync(path.join(output,'inline-live-translations.json'),JSON.stringify({model:settings.llmModel,batchFallback:fallback,
  results:units.map((unit,i)=>({id:unit.id,pageNumber:unit.ownerPageNumber,source:unit.text,protected:entries[i].text,
   targetText:responses[i].targetText,mathTokens:unit.inlineMath.length}))},null,2));
},120000);
