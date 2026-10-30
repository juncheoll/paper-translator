import { JSDOM } from "jsdom";
import { createPdfSourceHighlighter, getSentenceSourceRects, mapSourceOffsets, findSentenceAtPoint } from "../src/pdf/source_highlight";
import { createPdfSourceHover } from "../src/pdf/source_hover";

let dom;
let measured;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body><div class="page"><div class="textLayer"></div></div></body>');
  measured = [];
  Object.defineProperty(dom.window.Range.prototype, "getClientRects", { configurable: true, writable: true,
    value: function () {
      measured.push({ text: this.toString(), start: this.startOffset, end: this.endOffset });
      return [{ left: 120 + this.startOffset, top: 230 + measured.length * 15,
        width: this.toString().length, height: 12 }];
    } });
});
afterEach(() => { dom.window.close(); jest.useRealTimers(); });

function fixture(strings = ["Intro. The target", " sentence ends. Next."]) {
  const doc = dom.window.document;
  const page = doc.querySelector(".page");
  page.getBoundingClientRect = () => ({ left: 100, top: 200, width: 600, height: 800 });
  Object.defineProperties(page, { offsetWidth: { configurable: true, value: 600 }, offsetHeight: { configurable: true, value: 800 } });
  const layer = page.querySelector(".textLayer");
  const divs = strings.map((text) => {
    const div = doc.createElement("span");
    div.setAttribute("role", "presentation");
    div.textContent = text;
    if (text) layer.append(div);
    return div;
  });
  const items = [{ type: "beginMarkedContentProps", id: "tag" },
    ...strings.map((str) => ({ str })), { type: "endMarkedContent" }];
  const pageView = { div: page, textLayer: { div: layer, highlighter: { textDivs: divs, textContentItemsStr: strings } } };
  const listeners = new Map();
  const eventBus = {
    on: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    off: (name, listener) => listeners.get(name)?.delete(listener),
    dispatch: (name, event = {}) => { for (const listener of [...listeners.get(name) || []]) listener(event); },
  };
  const app = { eventBus, pdfViewer: { getPageView: () => pageView, scrollPageIntoView: jest.fn() } };
  const pdfDocument = { getPage: async () => ({ getTextContent: async () => ({ items }) }) };
  return { doc, page, layer, divs, items, pageView, app, pdfDocument, listeners };
}

const sentence = { sourceRanges: [{ itemIndex: 1, start: 7, end: 17 }, { itemIndex: 2, start: 0, end: 15 }] };

test("maps sentence character offsets through added whitespace, ligatures and combining text", () => {
  expect(mapSourceOffsets("The target", "The  target\n", 4, 10)).toEqual({ start: 5, end: 11 });
  expect(mapSourceOffsets("An oﬃce", "An office ", 3, 7)).toEqual({ start: 3, end: 9 });
  expect(mapSourceOffsets("Cafe\u0301", "Café", 3, 5)).toEqual({ start: 3, end: 4 });
  expect(mapSourceOffsets("The target", "The different target", 4, 10)).toBeNull();
  expect(mapSourceOffsets("The target", "The target", -1, 5)).toBeNull();
});

test("reverse hover resolves the actual sentence characters when two sentences share one PDF text span", () => {
  const run = fixture(["First. Second."]);
  dom.window.Range.prototype.getClientRects = function () {
    return [{ left: 120 + this.startOffset * 5, top: 230, width: (this.endOffset - this.startOffset) * 5, height: 12 }];
  };
  const units = [
    { id: "first", sourceRanges: [{ itemIndex: 1, start: 0, end: 6 }] },
    { id: "second", sourceRanges: [{ itemIndex: 1, start: 7, end: 14 }] },
  ];
  const hit = (x, target = run.divs[0]) => findSentenceAtPoint(run.pageView, run.items, units,
    { target, clientX: x, clientY: 235 }, 1);
  expect(hit(125)?.id).toBe("first");
  expect(hit(160)?.id).toBe("second");
  expect(hit(152)).toBeNull();
  run.divs[0].innerHTML = '<span class="highlight">First.</span> Second.';
  expect(hit(125, run.divs[0].firstChild)?.id).toBe("first");
  run.doc.elementsFromPoint = () => [run.divs[0]];
  expect(hit(160, run.layer)?.id).toBe("second");
});

test("hovering the PDF highlights the same exact source sentence and notifies the translation panel together", async () => {
  const run = fixture(["First. Second."]);
  const viewer = run.doc.createElement("div");
  run.page.before(viewer); viewer.append(run.page); run.page.dataset.pageNumber = "1";
  run.app.pdfViewer.container = viewer; run.app.page = 1;
  dom.window.Range.prototype.getClientRects = function () {
    return [{ left: 120 + this.startOffset * 5, top: 230, width: (this.endOffset - this.startOffset) * 5, height: 12 }];
  };
  let frame;
  dom.window.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  dom.window.cancelAnimationFrame = () => { frame = null; };
  const units = [{ id: "first", sourceRanges: [{ itemIndex: 1, start: 0, end: 6 }] },
    { id: "second", sourceRanges: [{ itemIndex: 1, start: 7, end: 14 }] }];
  const sourceHighlighter = createPdfSourceHighlighter(run), onHover = jest.fn(async () => true), onLeave = jest.fn();
  const hover = createPdfSourceHover({ ...run, sourceHighlighter, getUnits: () => units, onHover, onLeave });
  run.divs[0].dispatchEvent(new dom.window.MouseEvent("pointermove", { bubbles: true, clientX: 160, clientY: 235 }));
  frame();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(onHover).toHaveBeenCalledWith(units[1], 1, expect.any(Function));
  expect(run.doc.querySelectorAll("#mttPdfSourceHighlight > div")).toHaveLength(1);
  expect(run.doc.querySelector("#mttPdfSourceHighlight > div").style.width).toBe("35px");
  expect(run.app.pdfViewer.scrollPageIntoView).not.toHaveBeenCalled();
  expect(run.app.page).toBe(1);
  viewer.dispatchEvent(new dom.window.Event("pointerleave"));
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  expect(onLeave).toHaveBeenCalled();
  hover.destroy(); sourceHighlighter.destroy();
});

test("reverse hover respects page-specific ranges, scaling, source whitespace and ligatures", () => {
  const run = fixture(["An oﬃce. Next."]);
  run.divs[0].textContent = "An  office. Next.";
  Object.defineProperty(run.page, "offsetWidth", { value: 300 });
  Object.defineProperty(run.page, "offsetHeight", { value: 400 });
  dom.window.Range.prototype.getClientRects = function () {
    return [{ left: 120 + this.startOffset * 5, top: 230, width: (this.endOffset - this.startOffset) * 5, height: 12 }];
  };
  const shared = { id: "shared", sourceRanges: [
    { pageNumber: 1, itemIndex: 1, start: 0, end: 8 },
    { pageNumber: 2, itemIndex: 1, start: 9, end: 14 },
  ] };
  const point = { target: run.divs[0], clientX: 125, clientY: 235 };
  expect(findSentenceAtPoint(run.pageView, run.items, [shared], point, 1)).toBe(shared);
  expect(findSentenceAtPoint(run.pageView, run.items, [shared], point, 2)).toBeNull();
  expect(findSentenceAtPoint(run.pageView, run.items, [shared], { ...point, clientX: 185 }, 2)).toBe(shared);
});

test("measures only the translated sentence across PDF text items and preserves user selection", () => {
  const run = fixture(["Intro. The target", " sentence ends. Next.", ""]);
  const selection = run.doc.getSelection();
  const selected = run.doc.createRange();
  selected.setStart(run.divs[0].firstChild, 0);
  selected.setEnd(run.divs[0].firstChild, 6);
  selection.addRange(selected);
  const rects = getSentenceSourceRects(run.pageView, run.items, sentence.sourceRanges);
  expect(measured.map((range) => range.text)).toEqual(["The target", "sentence ends."]);
  expect(rects).toHaveLength(2);
  expect(rects[0]).toEqual({ left: 27, top: 45, width: 10, height: 12 });
  expect(selection.toString()).toBe("Intro.");
});

test("find highlights and injected spaces do not turn a sentence range into a whole-line highlight", () => {
  const run = fixture(["Intro. The target"]);
  run.divs[0].innerHTML = 'Intro. <span class="highlight">The </span><span> target</span>\n';
  getSentenceSourceRects(run.pageView, run.items, [{ itemIndex: 1, start: 7, end: 17 }]);
  expect(measured.map((range) => range.text)).toEqual(["The  target"]);
  expect(measured[0].text).not.toContain("Intro.");
});

test("uses live rotated and scaled DOM rectangles instead of the paragraph bounding box", () => {
  const run = fixture(["Target sentence."]);
  Object.defineProperty(run.page, "offsetWidth", { value: 300 });
  Object.defineProperty(run.page, "offsetHeight", { value: 400 });
  dom.window.Range.prototype.getClientRects = () => [{ left: 180, top: 260, width: 20, height: 100 }];
  const rects = getSentenceSourceRects(run.pageView, run.items, [{ itemIndex: 1, start: 0, end: 16 }]);
  expect(rects).toEqual([{ left: 40, top: 30, width: 10, height: 50 }]);
});

test("fallback DOM mapping skips empty items and unmappable ranges produce no unrelated highlight", () => {
  const run = fixture(["Intro.", "", "Target sentence."]);
  delete run.pageView.textLayer.highlighter;
  expect(getSentenceSourceRects(run.pageView, run.items, [{ itemIndex: 3, start: 0, end: 16 }])).toHaveLength(1);
  run.divs[2].textContent = "Different sentence.";
  expect(getSentenceSourceRects(run.pageView, run.items, [{ itemIndex: 3, start: 0, end: 16 }])).toEqual([]);
});

test("highlighter draws separate sentence rectangles, clears on zoom, and removes event listeners", async () => {
  jest.useFakeTimers();
  const run = fixture();
  const highlighter = createPdfSourceHighlighter(run);
  expect(await highlighter.show(sentence, 1)).toBe(true);
  expect(run.app.pdfViewer.scrollPageIntoView).toHaveBeenCalledWith({ pageNumber: 1 });
  expect(run.doc.querySelectorAll("#mttPdfSourceHighlight > div")).toHaveLength(2);
  run.app.eventBus.dispatch("scalechanging");
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  expect(await highlighter.show(sentence, 1)).toBe(true);
  jest.advanceTimersByTime(1800);
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  highlighter.destroy();
  expect([...run.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  expect(await highlighter.show(sentence, 1)).toBe(false);
});

test("shared sentence highlighting uses only the raw character ranges for the chosen page", async () => {
  const run = fixture(["Page two text."]);
  const highlighter = createPdfSourceHighlighter(run);
  const unit = { sourceRanges: [
    { pageNumber: 1, itemIndex: 1, start: 0, end: 4 },
    { pageNumber: 2, itemIndex: 1, start: 5, end: 8 },
  ] };
  expect(await highlighter.show(unit, 2)).toBe(true);
  expect(measured.map(({ text }) => text)).toEqual(["two"]);
  highlighter.destroy();
});

test("waits for the requested page text layer and cancels stale asynchronous clicks", async () => {
  const run = fixture();
  const layer = run.pageView.textLayer;
  run.pageView.textLayer = null;
  const highlighter = createPdfSourceHighlighter(run);
  const pending = highlighter.show(sentence, 1);
  for (let i = 0; i < 10 && !run.listeners.get("textlayerrendered")?.size; i++) await Promise.resolve();
  run.pageView.textLayer = layer;
  run.app.eventBus.dispatch("textlayerrendered", { pageNumber: 1 });
  expect(await pending).toBe(true);
  let finishPage;
  run.pdfDocument.getPage = () => new Promise((resolve) => { finishPage = resolve; });
  const stale = highlighter.show(sentence, 2);
  highlighter.clear();
  finishPage({ getTextContent: async () => ({ items: run.items }) });
  expect(await stale).toBe(false);
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  highlighter.destroy();
});

test("hover highlighting never changes the page or scrolls and lasts until pointer leave", async () => {
  jest.useFakeTimers();
  const run = fixture();
  run.app.page = 1;
  const scrolled = jest.fn();
  dom.window.Element.prototype.scrollIntoView = scrolled;
  const highlighter = createPdfSourceHighlighter(run);
  expect(await highlighter.show(sentence, 1, { navigate: false })).toBe(true);
  expect(run.app.page).toBe(1);
  expect(run.app.pdfViewer.scrollPageIntoView).not.toHaveBeenCalled();
  expect(scrolled).not.toHaveBeenCalled();
  jest.advanceTimersByTime(5000);
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).not.toBeNull();
  highlighter.clearHover();
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  await highlighter.show(sentence, 1);
  highlighter.clearHover();
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).not.toBeNull();
  expect(run.app.pdfViewer.scrollPageIntoView).toHaveBeenCalledTimes(1);
  highlighter.destroy();
});

test("leaving while a hover request is loading prevents a late highlight or navigation", async () => {
  const run = fixture();
  let finish;
  run.pdfDocument.getPage = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
  const highlighter = createPdfSourceHighlighter(run);
  const pending = highlighter.show(sentence, 1, { navigate: false });
  highlighter.clearHover();
  finish({ getTextContent: async () => ({ items: run.items }) });
  expect(await pending).toBe(false);
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  expect(run.app.pdfViewer.scrollPageIntoView).not.toHaveBeenCalled();
  highlighter.destroy();
});

test("changing pages cancels a pending highlight instead of pulling the reader back", async () => {
  const run = fixture();
  const layer = run.pageView.textLayer;
  run.pageView.textLayer = null;
  const highlighter = createPdfSourceHighlighter(run);
  const pending = highlighter.show(sentence, 1);
  for (let i = 0; i < 10 && !run.listeners.get("textlayerrendered")?.size; i++) await Promise.resolve();
  run.app.eventBus.dispatch("pagechanging", { pageNumber: 2 });
  run.pageView.textLayer = layer;
  run.app.eventBus.dispatch("textlayerrendered", { pageNumber: 1 });
  expect(await pending).toBe(false);
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  highlighter.destroy();
});

test("missing text layers time out and missing provenance never falls back to a paragraph", async () => {
  jest.useFakeTimers();
  const run = fixture();
  run.pageView.textLayer = null;
  const highlighter = createPdfSourceHighlighter(run);
  const pending = highlighter.show(sentence, 1);
  for (let i = 0; i < 10 && !run.listeners.get("textlayerrendered")?.size; i++) await Promise.resolve();
  jest.advanceTimersByTime(5001);
  expect(await pending).toBe(false);
  expect(await highlighter.show({ bbox: { x: 1, y: 1, width: 500, height: 700 } }, 1)).toBe(false);
  expect(run.doc.querySelector("#mttPdfSourceHighlight")).toBeNull();
  highlighter.destroy();
});
