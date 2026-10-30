const letters = /^[\p{L}]$/u;
const normalize = (value) => String(value || "").normalize("NFKC").replace(/\u00ad/g, "");
const searchText = (value) => normalize(value).normalize('NFD');
const glyph = (value) => value === 'ℓ' ? value : normalize(value);
const graphemes = new Intl.Segmenter(undefined,{granularity:'grapheme'});
const union = (a, b) => ({ x:Math.min(a.x,b.x), y:Math.min(a.y,b.y),
  width:Math.max(a.x+a.width,b.x+b.width)-Math.min(a.x,b.x),
  height:Math.max(a.y+a.height,b.y+b.height)-Math.min(a.y,b.y) });

// PDF.js separates accents and lowered indices. Math-extension fonts can map a printed hat to "b".
export function extractFormulaVariables(items, viewport, region, styles = {}) {
  const box = region.bbox, pieces = [], accents = [];
  for (const [itemIndex,item] of items.entries()) {
    if (!item.transform || !item.str?.trim()) continue;
    const [x,baseline] = viewport.convertToViewportPoint(item.transform[4],item.transform[5]);
    const height = Math.abs(item.height) || Math.hypot(item.transform[2],item.transform[3]);
    const chars = [...graphemes.segment(item.str)].map(part=>part.segment), width = Math.abs(item.width);
    if (!height || x+width < box.x || x > box.x+box.width || baseline < box.y || baseline-height > box.y+box.height) continue;
    const style = styles[item.fontName];
    // shortcut: combined math items use proportional character hit areas; use glyph advances if finer areas are needed.
    chars.forEach((char,index) => {
      const value = glyph(char), decomposed = value.normalize('NFD');
      const data = { itemIndex, baseline, font:height,
        bbox:{ x:x+width*index/chars.length, y:baseline-height, width:width/chars.length, height } };
      const encodedHat = value === 'b' && style?.ascent >= 0 && style.ascent < .15 && style.descent <= -.4;
      if (/^[\^ˆ\u0302]$/.test(value) || encodedHat) { accents.push(data); return; }
      const letter = Array.from(decomposed)[0], combiningHat = /^\p{L}\u0302$/u.test(decomposed);
      if (!letters.test(letter) && !/^[\d,]$/.test(value)) return;
      pieces.push({ ...data, symbol:combiningHat ? letter : value, ...(combiningHat ? {accent:'hat'} : {}),
        variable:letters.test(letter) && !letters.test(glyph(chars[index-1])) && !letters.test(glyph(chars[index+1])) });
    });
  }
  // A hat must lie above and horizontally overlap its base; ordinary italic b is never reclassified.
  const decorated = new Map();
  for (const accent of accents) {
    const base = pieces.filter(t=>t.variable && !decorated.has(t) && t.baseline-accent.baseline >= t.font*.05 &&
      t.baseline-accent.baseline <= t.font*1.1 && accent.font <= t.font*1.3 &&
      Math.abs(accent.bbox.x+accent.bbox.width/2-t.bbox.x-t.bbox.width/2) <= t.font*.6)
      .sort((a,b)=>(a.baseline-accent.baseline)/a.font-(b.baseline-accent.baseline)/b.font)[0];
    if (base) decorated.set(base,accent);
  }
  const consumed = new Set(), result = [];
  for (const token of pieces.filter(t=>t.variable).sort((a,b)=>b.font-a.font || a.bbox.x-b.bbox.x)) {
    if (consumed.has(token)) continue;
    consumed.add(token);
    const lowered = pieces.filter(t=>!consumed.has(t) && t.font < token.font*.88 &&
      t.baseline > token.baseline+token.font*.06 && t.baseline < token.baseline+token.font*.8)
      .sort((a,b)=>a.bbox.x-b.bbox.x);
    const first = lowered.filter(t=>t.symbol!==',' && Math.abs(t.bbox.x-token.bbox.x-token.bbox.width)<token.font*.5)
      .sort((a,b)=>Math.abs(a.bbox.x-token.bbox.x-token.bbox.width)-Math.abs(b.bbox.x-token.bbox.x-token.bbox.width))[0];
    const indices = [];
    if (first) for (const part of lowered.slice(lowered.indexOf(first))) {
      const previous = indices.at(-1);
      if (previous && (Math.abs(part.baseline-first.baseline)>first.font*.2 || Math.abs(part.font-first.font)>first.font*.25 ||
        part.bbox.x-previous.bbox.x-previous.bbox.width > first.font*.5 || part.bbox.x < previous.bbox.x)) break;
      indices.push(part);
    }
    while (indices.at(-1)?.symbol===',') indices.pop();
    for (const part of indices) consumed.add(part);
    const accent = token.accent || (decorated.has(token) ? 'hat' : undefined);
    const subscript = indices.map(t=>t.symbol).join('');
    let bounds = token.bbox;
    if (decorated.has(token)) bounds = union(bounds,decorated.get(token).bbox);
    for (const part of indices) bounds = union(bounds,part.bbox);
    const base = `${token.symbol}${accent ? '\u0302' : ''}`;
    result.push({ symbol:base+(subscript ? subscript.length>1 ? `_{${subscript}}` : `_${subscript}` : ''),
      base:token.symbol, ...(accent ? {accent} : {}), ...(subscript ? {subscript} : {}), bbox:bounds });
  }
  return result;
}

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
function symbolPattern(base, subscript, accent) {
  const symbol = escape(base);
  const decorated = accent === 'hat' ? `(?:\\\\(?:wide)?hat\\s*\\{?\\s*${symbol}\\}?|b\\s*${symbol}|${symbol}\\s*[\\u0302ˆ^])` : symbol;
  const index = subscript ? Array.from(subscript).map(escape).join('\\s*') : '';
  return new RegExp(`(?<![\\p{L}\\p{N}_])${decorated}${index ? `\\s*(?:_\\s*\\{?\\s*)?${index}\\}?` : ""}(?![\\p{L}\\p{N}_\\p{M}])`,"u");
}
const definitionCue = /\b(?:denot\w*|represent\w*|defin\w*|refers? to|stands? for|where|let|spend\w*|subscripts?|indicat\w*|is the|are the|measures?|counts?|number of|probability|time per|tokens per|be the estimate)\b/i;

export function findVariableEvidence(pages, variable, anchor, limit = 3) {
  const base = searchText(variable.base), subscript = searchText(variable.subscript);
  if (!base || !letters.test(base)) return [];
  const direct = symbolPattern(base,subscript,variable.accent), indexed = symbolPattern(base,subscript);
  const basic = symbolPattern(base), sub = subscript && symbolPattern(subscript);
  const candidates = [];
  for (const page of pages) for (const unit of page.blocks || []) {
    if (!["paragraph","footnote"].includes(unit.kind) || unit.id === anchor.id || unit.ownerPageNumber && unit.ownerPageNumber !== page.pageNumber) continue;
    const aliases = (unit.inlineMath || []).flatMap(math => math.symbols || []).join(' ');
    const text = searchText(unit.text + ' ' + aliases), explicit = direct.test(text), identifier = explicit || indexed.test(text), baseMatch = basic.test(text);
    const subMatch = sub && sub.test(text) && /\bsubscripts?\b/i.test(text);
    if ((!identifier && !baseMatch && !subMatch) || !definitionCue.test(text)) continue;
    const distance = Math.abs(page.pageNumber-anchor.pageNumber)*12 + Math.abs((unit.bbox?.y || 0)-(anchor.bbox?.y || 0))/200;
    candidates.push({unit,pageNumber:page.pageNumber, text:unit.text,
      identifier, score:(explicit ? 40 : identifier ? 35 : baseMatch ? 20 : 0)+(subMatch ? 25 : 0)-distance,
      category:subMatch && !baseMatch ? 'subscript' : 'base'});
  }
  candidates.sort((a,b)=>b.score-a.score);
  const identifiers = candidates.filter(c=>c.identifier);
  if (!identifiers.length && variable.accent && subscript.length>1) return [];
  const ranked = identifiers.length ? identifiers : candidates;
  const selected = [], seen = new Set();
  const add = value => { if (value && !seen.has(value.text)) { selected.push(value); seen.add(value.text); } };
  add(ranked.find(c=>c.category==='base'));
  if (subscript) add(candidates.find(c=>c.category==='subscript'));
  for (const candidate of ranked) { if (selected.length >= limit) break; add(candidate); }
  return selected.slice(0,limit).map(({score,category,...source})=>source);
}
