const textOf = (block) => String(block.text || "").normalize("NFKC").replace(/\s+/g, " ").trim();
const isSectionHeading = (text) => /^(?:\d+(?:\.\d+)*\.?\s+)?(?:abstract|introduction|background|methods?|materials and methods|results(?: and discussion)?|discussion|conclusions?|experiments?|evaluation|references|acknowledg(?:e)?ments|appendix(?:\s+[A-Z\d])?)$/i.test(text);

function marginOf(block, page) {
  const box = block.bbox;
  if (!box || !page.height || box.height > Math.min(48, page.height * 0.06)) return "";
  if (box.y + box.height <= page.height * 0.12) return "top";
  if (box.y >= page.height * 0.9) return "bottom";
  return "";
}

function marginSignature(text) {
  return text.toLowerCase()
    .replace(/^(?:page\s+)?\d+\s*(?:[|–—-]\s*)?/, "")
    .replace(/(?:\s*[|–—-])?\s+(?:page\s+)?\d+(?:\s*(?:\/|of)\s*\d+)?$/, "")
    .trim();
}

const pageNumber = /^(?:(?:page\s*)?\d{1,5}(?:\s*(?:\/|of)\s*\d{1,5})?|[ivxlcdm]{1,8})$/i;
const noticeStart = /^(?:permission to make (?:digital|hard)|this (?:work|article|paper) is licensed|licensed under|creative commons(?: attribution)?|all rights reserved|copyright\s*(?:(?:\(?c\)?|©|ⓒ)\s*)*(?:\d{4}|by\b)|[©ⓒ]\s*(?:\d{4}|the authors?\b)|open access (?:article )?(?:under|distributed))/i;
const identifierStart = /^(?:(?:e-)?issn\s*[:\d]|isbn(?:-\d{2})?\s*[:\d]|doi\s*:\s*10\.\d{4,9}\/|https?:\/\/(?:dx\.)?doi\.org\/)/i;
const dateStart = /^(?:received|accepted|revised|published(?: online)?|available online)\s*:?\s*(?:\d|january|february|march|april|may|june|july|august|september|october|november|december)/i;
const venueStart = /^(?:journal of\b|international journal of\b|(?:in )?proceedings of\b|transactions on\b|(?:vol(?:ume)?\.?|issue|no\.)\s*\d|(?:\d{4}\s+)?(?:ACM|IEEE|Springer|Elsevier|Wiley)\b|[A-Z][A-Z0-9-]{1,12}[’']?\d{2,4}\s*[,.:])/i;
const affiliationInstitution = /\b(?:university|department|institute|college|school|laborator(?:y|ies)|research cent(?:er|re)|hospital|corporation|inc\.?|ltd\.?)\b/i;
const narrativeNote = /\b(?:we|our|their|is|are|was|were|use|used|using|measured|measures|experiments?|results?|provided|provides|recommend(?:s|ed)?)\b/i;
const authorMarker = /^(?:\(?\d{1,2}\)?[.)]?|[*†‡])\s*(?=[A-Z])/;

function authorFooter(block, page) {
  const text = textOf(block);
  if (block.kind !== "footnote" || !block.bbox || block.bbox.y < page.height * 0.72 || text.length > 1500) return false;
  if (/\b(?:correspondence\s+to|corresponding author|author contact)\s*:/i.test(text)) return true;
  return authorMarker.test(text) && affiliationInstitution.test(text) && text.includes(",") && !narrativeNote.test(text);
}

function followsAuthorFooter(previous, next) {
  if (next.kind !== "footnote" || !previous.bbox || !next.bbox) return false;
  const text = textOf(next);
  if (text.length > 500 || authorMarker.test(text) || narrativeNote.test(text)) return false;
  const [above, below] = [previous.bbox, next.bbox].sort((a, b) => a.y - b.y);
  const overlap = Math.min(above.x + above.width, below.x + below.width) - Math.max(above.x, below.x);
  const gap = below.y - above.y - above.height;
  return gap >= -2 && gap <= 12 && overlap >= Math.min(above.width, below.width) * 0.6 &&
    (affiliationInstitution.test(text) || /^[A-Z][^.!?]*,\s*[A-Z][^!?]*[.]?$/.test(text));
}

function publicationInfo(block, page) {
  const text = textOf(block);
  const box = block.bbox;
  if (!box || !text || ["formula", "table", "caption"].includes(block.kind)) return false;
  const metadataArea = block.kind === "footnote" || box.y < page.height * 0.35 || box.y >= page.height * 0.6;
  if (!metadataArea) return false;
  if (noticeStart.test(text)) return text.length <= 2000;
  if (text.length > 300 || /\b(?:is|are|was|were|identifies|identified|used|we|our)\b/i.test(text)) return false;
  return identifierStart.test(text) || dateStart.test(text) || venueStart.test(text);
}

function followsNotice(previous, next) {
  if (next.kind !== "footnote" || /^\s*(?:[1-9]\d?[\s.)]|[*†‡])/.test(next.text)) return false;
  const a = previous.bbox, b = next.bbox;
  if (!a || !b) return false;
  const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const gap = b.y - (a.y + a.height);
  return overlap >= Math.min(a.width, b.width) * 0.6 && gap >= -2 && gap <= 12 &&
    /^(?:and\b|or\b|provided\b|that\b|for\b|to\b|of\b|without\b|under\b|with\b|by\b|is\b|are\b|personal\b|commercial\b|this notice\b|the (?:full|author|publisher|copyright|license)\b)|\b(?:copies|republish|redistribut|permission|copyright|licensed?|rights reserved|ISBN|ISSN|DOI)\b/i.test(textOf(next));
}

// Filter before sentence reconstruction so running matter cannot interrupt the article flow.
export function filterDocumentBody(pages) {
  if (!Array.isArray(pages)) throw new TypeError("PDF pages must be an array");
  const occurrences = new Map();
  for (const [pageIndex, page] of pages.entries()) {
    for (const block of page.blocks || []) {
      const text = textOf(block);
      const margin = marginOf(block, page);
      if (!margin || !text || text.length > 200 || isSectionHeading(text) || ["table", "formula", "caption"].includes(block.kind)) continue;
      const signature = `${margin}:${marginSignature(text)}`;
      if (!occurrences.has(signature)) occurrences.set(signature, new Set());
      occurrences.get(signature).add(pageIndex);
    }
  }
  return pages.map((page, pageIndex) => {
    const omitted = new Set();
    const blocks = page.blocks || [];
    for (const [index, block] of blocks.entries()) {
      if (block.layoutManual) continue;
      const text = textOf(block);
      const margin = marginOf(block, page);
      const recurring = margin && text.length <= 200 && !isSectionHeading(text) &&
        !["table", "formula", "caption"].includes(block.kind) &&
        occurrences.get(`${margin}:${marginSignature(text)}`)?.size >= 2;
      // Keep the first-page article title even when later pages repeat it as a running head.
      if (margin && !["table", "formula", "caption"].includes(block.kind) && pageNumber.test(text) ||
          recurring && !(pageIndex === 0 && margin === "top" && block.kind === "heading")) omitted.add(index);
      if (pageIndex === 0 && authorFooter(block, page)) {
        omitted.add(index);
        for (const direction of [-1, 1]) {
          let previous = block;
          for (let offset = 1; offset <= 3; offset++) {
            const nextIndex = index + offset * direction;
            const next = blocks[nextIndex];
            if (!next || next.bbox?.y < page.height * 0.72 || !followsAuthorFooter(previous, next)) break;
            omitted.add(nextIndex);
            previous = next;
          }
        }
      }
      if (pageIndex !== 0 || !publicationInfo(block, page)) continue;
      omitted.add(index);
      if (!noticeStart.test(text)) continue;
      let previous = block;
      let length = text.length;
      for (let nextIndex = index + 1; nextIndex < Math.min(blocks.length, index + 12); nextIndex++) {
        const next = blocks[nextIndex];
        if (length + textOf(next).length > 2500 || !followsNotice(previous, next)) break;
        omitted.add(nextIndex);
        length += textOf(next).length;
        previous = next;
      }
    }
    return { ...page, blocks: blocks.filter((block, index) => block.layoutManual || !omitted.has(index)),
      excludedBlockCount: (page.excludedBlockCount || 0) + omitted.size };
  });
}
