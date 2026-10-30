const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function characterMap(text) {
  const result = [];
  for (const { index, segment } of graphemes.segment(text)) {
    for (const char of segment.normalize("NFKC")) {
      if (/\s/u.test(char)) continue;
      result.push({ char, start: index, end: index + segment.length });
    }
  }
  return result;
}

// PDF.js search markup and the extension may insert whitespace without changing the printed text.
export function mapSourceOffsets(source, rendered, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length) return null;
  const raw = characterMap(source), dom = characterMap(rendered);
  if (raw.length !== dom.length || raw.some((entry, index) => entry.char !== dom[index].char)) return null;
  const first = raw.findIndex((entry) => entry.end > start && entry.start < end);
  let last = first;
  while (last + 1 < raw.length && raw[last + 1].start < end) last++;
  return first < 0 ? null : { start: dom[first].start, end: dom[last].end };
}

function textNodes(element) {
  const result = [];
  const walker = element.ownerDocument.createTreeWalker(element, 4);
  let node;
  while ((node = walker.nextNode())) result.push(node);
  return result;
}

function textBoundary(nodes, offset, end = false) {
  let consumed = 0;
  for (const node of nodes) {
    const length = node.textContent.length;
    if (offset < consumed + length || end && offset === consumed + length) return [node, offset - consumed];
    consumed += length;
  }
  const last = nodes.at(-1);
  return last && offset === consumed ? [last, last.textContent.length] : null;
}

function mappedDivs(pageView, items) {
  const layer = pageView?.textLayer;
  if (!layer?.div?.isConnected || layer.div.hidden) return null;
  const textItems = items.filter((item) => typeof item.str === "string");
  let divs = layer.highlighter?.textDivs;
  if (!divs || divs.length !== textItems.length) {
    const rendered = [...layer.div.querySelectorAll('span[role="presentation"]')];
    if (rendered.length !== textItems.filter((item) => item.str !== "").length) return null;
    let index = 0;
    divs = textItems.map((item) => item.str === "" ? null : rendered[index++]);
  }
  const byItem = new Map();
  let index = 0;
  for (const [itemIndex, item] of items.entries()) {
    if (typeof item.str !== "string") continue;
    byItem.set(itemIndex, divs[index++]);
  }
  return byItem;
}

export function getSentenceSourceRects(pageView, items, sourceRanges) {
  const divs = mappedDivs(pageView, items);
  if (!divs || !sourceRanges?.length || !pageView.div) return [];
  const page = pageView.div;
  const pageRect = page.getBoundingClientRect();
  const scaleX = page.offsetWidth ? pageRect.width / page.offsetWidth : 1;
  const scaleY = page.offsetHeight ? pageRect.height / page.offsetHeight : 1;
  if (!(scaleX > 0 && scaleY > 0)) return [];
  const originX = pageRect.left + (page.clientLeft || 0) * scaleX;
  const originY = pageRect.top + (page.clientTop || 0) * scaleY;
  const rects = [];
  const seen = new Set();
  for (const source of sourceRanges) {
    const item = items[source.itemIndex];
    const div = divs.get(source.itemIndex);
    if (typeof item?.str === "string" && !item.str.slice(source.start, source.end).trim()) continue;
    if (typeof item?.str !== "string" || !div?.isConnected) return [];
    const nodes = textNodes(div);
    const offsets = mapSourceOffsets(item.str, nodes.map((node) => node.textContent).join(""), source.start, source.end);
    if (!offsets) return [];
    const start = textBoundary(nodes, offsets.start), end = textBoundary(nodes, offsets.end, true);
    if (!start || !end) return [];
    const range = page.ownerDocument.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    for (const rect of range.getClientRects()) {
      if (!(rect.width > 0 && rect.height > 0)) continue;
      const local = { left: (rect.left - originX) / scaleX, top: (rect.top - originY) / scaleY,
        width: rect.width / scaleX, height: rect.height / scaleY };
      const key = Object.values(local).map((value) => Math.round(value * 4)).join(":");
      if (!seen.has(key)) { rects.push(local); seen.add(key); }
    }
  }
  return rects;
}

export function findSentenceAtPoint(pageView, items, units, { target, clientX, clientY }, pageNumber) {
  const divs = mappedDivs(pageView, items);
  const page = pageView?.div;
  if (!divs || !page) return null;
  let hit = [...divs].find(([, div]) => div && target && div.contains(target));
  // Link annotations can sit above their printed citation text.
  if (!hit) {
    const underneath = page.ownerDocument.elementsFromPoint?.(clientX, clientY) || [];
    hit = [...divs].find(([, div]) => div && underneath.some((element) => div === element || div.contains(element)));
  }
  if (!hit) return null;
  const [itemIndex] = hit;
  const bounds = page.getBoundingClientRect();
  const scaleX = page.offsetWidth ? bounds.width / page.offsetWidth : 1;
  const scaleY = page.offsetHeight ? bounds.height / page.offsetHeight : 1;
  if (!(scaleX > 0 && scaleY > 0)) return null;
  const x = (clientX - bounds.left) / scaleX - (page.clientLeft || 0);
  const y = (clientY - bounds.top) / scaleY - (page.clientTop || 0);
  for (const unit of units) {
    const ranges = (unit.sourceRanges || []).filter((range) => range.itemIndex === itemIndex &&
      (range.pageNumber == null || range.pageNumber === pageNumber));
    if (ranges.length && getSentenceSourceRects(pageView, items, ranges).some((rect) =>
      x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height)) return unit;
  }
  return null;
}

export function createPdfSourceHighlighter({ app, pdfDocument, isCurrent = () => true, durationMs = 1800 }) {
  let sequence = 0;
  let overlay = null;
  let timer;
  let cancelWait;
  let destroyed = false;
  let activePage = null;
  let hovering = false;
  const contents = new Map();
  const eventBus = app.eventBus;
  const clear = () => {
    sequence++;
    cancelWait?.();
    cancelWait = null;
    clearTimeout(timer);
    overlay?.remove();
    overlay = null;
    activePage = null;
    hovering = false;
  };
  for (const name of ["scalechanging", "rotationchanging"]) eventBus?.on(name, clear);
  const onPageChange = (event) => { if (activePage != null && event.pageNumber !== activePage) clear(); };
  eventBus?.on("pagechanging", onPageChange);

  const waitForLayer = (pageNumber, items, current) => new Promise((resolve) => {
    const deadline = Date.now() + 5000;
    let poll;
    const finish = (view) => {
      clearTimeout(poll);
      eventBus?.off("textlayerrendered", onRendered);
      if (cancelWait === cancel) cancelWait = null;
      resolve(view);
    };
    const cancel = () => finish(null);
    const check = () => {
      if (!current() || Date.now() >= deadline) { finish(null); return; }
      const view = app.pdfViewer.getPageView(pageNumber - 1);
      if (mappedDivs(view, items)) { finish(view); return; }
      clearTimeout(poll);
      poll = setTimeout(check, 50);
    };
    const onRendered = (event) => { if (event.pageNumber === pageNumber) check(); };
    cancelWait = cancel;
    eventBus?.on("textlayerrendered", onRendered);
    check();
  });

  return {
    async show(unit, pageNumber, { navigate = true } = {}) {
      clear();
      const sourceRanges = unit?.sourceRanges?.filter((range) => range.pageNumber == null || range.pageNumber === pageNumber);
      if (destroyed || !sourceRanges?.length) return false;
      const token = sequence;
      const current = () => !destroyed && token === sequence && isCurrent();
      activePage = pageNumber;
      hovering = !navigate;
      if (navigate) {
        app.page = pageNumber;
        app.pdfViewer.scrollPageIntoView({ pageNumber });
      }
      try {
        if (!contents.has(pageNumber)) {
          const pending = pdfDocument.getPage(pageNumber).then((page) => page.getTextContent({ includeMarkedContent: true, disableNormalization: true }));
          contents.set(pageNumber, pending);
          pending.catch(() => { if (contents.get(pageNumber) === pending) contents.delete(pageNumber); });
        }
        const content = await contents.get(pageNumber);
        if (!current()) return false;
        const view = await waitForLayer(pageNumber, content.items, current);
        if (!view || !current()) return false;
        const rects = getSentenceSourceRects(view, content.items, sourceRanges);
        if (!rects.length) return false;
        const doc = view.div.ownerDocument;
        overlay = doc.createElement("div");
        overlay.id = "mttPdfSourceHighlight";
        overlay.dataset.mtt = "source-highlight";
        overlay.setAttribute("aria-hidden", "true");
        Object.assign(overlay.style, { position: "absolute", inset: "0", pointerEvents: "none", zIndex: "10" });
        for (const bounds of rects) {
          const mark = doc.createElement("div");
          Object.assign(mark.style, { position: "absolute", left: `${bounds.left}px`, top: `${bounds.top}px`,
            width: `${bounds.width}px`, height: `${bounds.height}px`, background: "#fbbf2466",
            boxShadow: "0 0 0 1px #f59e0b", borderRadius: "2px" });
          overlay.append(mark);
        }
        view.div.append(overlay);
        if (navigate) {
          overlay.firstElementChild?.scrollIntoView?.({ block: "center", behavior: "smooth" });
          timer = setTimeout(clear, durationMs);
        }
        return true;
      } catch (_) { return false; }
    },
    clear,
    clearHover() { if (hovering) clear(); },
    destroy() {
      clear();
      destroyed = true;
      contents.clear();
      for (const name of ["scalechanging", "rotationchanging"]) eventBus?.off(name, clear);
      eventBus?.off("pagechanging", onPageChange);
    },
  };
}
