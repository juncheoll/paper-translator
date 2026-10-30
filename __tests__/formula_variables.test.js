import {extractFormulaVariables,findVariableEvidence} from '../src/pdf/formula_variables';
const viewport={convertToViewportPoint:(x,y)=>[x,800-y]};
const item=(str,x,baseline,height=10,width=8)=>({str,width,height,transform:[height,0,0,height,x,800-baseline]});
const region={bbox:{x:20,y:90,width:250,height:50}};
test('lowered small PDF items become subscript variables; operators and equation numbers are not variables',()=>{
 const variables=extractFormulaVariables([item('R',30,110),item('S',38,112,7,5),item('/T',45,110,10,12),
  item('E',57,112,7,5),item('τ H',75,110,10,18),item('S',93,112,7,5),item('(8)',220,110),item('sin',120,110,10,20),item('R',20,200)],viewport,region);
 expect(variables.map(v=>v.symbol)).toEqual(expect.arrayContaining(['R_S','T_E','τ','H_S']));
 expect(variables.some(v=>['S','E','sin','8'].includes(v.symbol))).toBe(false);
 expect(variables.find(v=>v.symbol==='R_S').bbox).toEqual({x:30,y:100,width:13,height:12});
});
const block=(id,text,y=200)=>({id,text,kind:'paragraph',bbox:{y}});
test('evidence uses nearby definitions plus explicit subscript explanations, without guessing from substrings',()=>{
 const pages=[{pageNumber:1,blocks:[block('far','Let R denote a different reward.')]},
  {pageNumber:8,blocks:[block('research','Research is the topic.'),block('body','Let R denote the number of decoded tokens.',410),
    block('suffix','For Method One and Method Two (subscripts S and E),',420),
    block('not-definition','The R value improves our results.',300),{...block('eq','R S = 2'),kind:'formula'}]}];
 const result=findVariableEvidence(pages,{base:'R',subscript:'S'},{id:'eq',pageNumber:8,bbox:{y:440}});
 expect(result.slice(0,2).map(e=>e.unit.id)).toEqual(['body','suffix']);
 expect(result.some(e=>['research','not-definition','eq'].includes(e.unit.id))).toBe(false);
 expect(findVariableEvidence(pages,{base:'z'},{pageNumber:8})).toEqual([]);
});
test('direct underscore/brace notation and unicode mathematical letters are normalized',()=>{
 const pages=[{pageNumber:2,blocks:[block('definition','We define R_{S} as the expected reward.'),block('other','Let 𝑇 denote decode time.')]}];
 expect(findVariableEvidence(pages,{base:'R',subscript:'S'},{pageNumber:2})[0].unit.id).toBe('definition');
 expect(findVariableEvidence(pages,{base:'T'},{pageNumber:2})[0].unit.id).toBe('other');
});

const accentStyles={extension:{ascent:.04,descent:-.6},italic:{ascent:.694,descent:-.194}};
test('a math-extension b is a hat, and comma-separated lowered indices form one variable',()=>{
 const variables=extractFormulaVariables([
  {...item('b',32,107.5,10,5.5),fontName:'extension'}, {...item('E',30,110),fontName:'italic'},
  {...item('ℓ,v',38,111.5,7,9.7),fontName:'italic'}, {...item('b',90,110),fontName:'italic'}
 ],viewport,region,accentStyles);
 expect(variables.map(v=>v.symbol)).toEqual(['Ê_{ℓ,v}','b']);
 expect(variables[0]).toMatchObject({base:'E',accent:'hat',subscript:'ℓ,v'});
 expect(variables[0].bbox.y).toBe(97.5);expect(variables[0].bbox.x+variables[0].bbox.width).toBeCloseTo(47.7);
 expect(variables[1].accent).toBeUndefined();
});
test.each(['^','ˆ','\u0302'])('separate %s hat marks and split numeric/letter indices are joined geometrically',mark=>{
 const variables=extractFormulaVariables([item(mark,32,107.5,10,5),item('E',30,110),item('ℓ',38,111.5,7,3),
  item(',',41,111.5,7,2),item('1',43,111.5,7,3)],viewport,region);
 expect(variables).toHaveLength(1);expect(variables[0].symbol).toBe('Ê_{ℓ,1}');
});
test('combined Unicode circumflexes are retained and an ordinary b above E is never treated as an accent',()=>{
 expect(extractFormulaVariables([item('Ê',30,110)],viewport,region)[0]).toMatchObject({symbol:'Ê',base:'E',accent:'hat'});
 const variables=extractFormulaVariables([{...item('b',32,107.5),fontName:'italic'},item('E',30,110)],viewport,region,accentStyles);
 expect(variables.some(v=>v.accent)).toBe(false);expect(variables.map(v=>v.symbol)).toContain('b');
});
test('compound decorated identifiers prefer their full definition over unrelated bare E explanations',()=>{
 const pages=[{pageNumber:4,blocks:[block('target','El,v be the estimate of El(v) supplied to the selector.'),
  block('expectation','Let E denote mathematical expectation.'),block('encoded','Let bEl,s be the estimate for the root node.')]}];
 const query={base:'E',accent:'hat',subscript:'ℓ,v'};
 expect(findVariableEvidence(pages,query,{pageNumber:4}).map(e=>e.unit.id)).toEqual(['target']);
 expect(findVariableEvidence(pages,{...query,subscript:'ℓ,s'},{pageNumber:4})[0].unit.id).toBe('encoded');
 expect(findVariableEvidence([{pageNumber:4,blocks:[pages[0].blocks[1]]}],query,{pageNumber:4})).toEqual([]);
});
