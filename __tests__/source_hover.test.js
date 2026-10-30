import { JSDOM } from "jsdom";
import { createPdfSourceHover } from "../src/pdf/source_hover";
import { findSentenceAtPoint } from "../src/pdf/source_highlight";

jest.mock("../src/pdf/source_highlight", () => ({ findSentenceAtPoint: jest.fn() }));
let dom;
afterEach(() => dom?.window.close());
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  dom = new JSDOM('<div id="viewerContainer"><div class="page" data-page-number="2"><div class="textLayer"><span>Source</span></div></div></div>');
  const win = dom.window, viewer = win.document.getElementById("viewerContainer"), span = viewer.querySelector("span");
  const frames = new Map(); let next = 0, enabled = true;
  win.requestAnimationFrame = (callback) => { frames.set(++next, callback); return next; };
  win.cancelAnimationFrame = (id) => frames.delete(id);
  const events = new Map();
  const eventBus = { on: (name, fn) => events.set(name, fn), off: (name) => events.delete(name) };
  const app = { page: 1, eventBus, pdfViewer: { container: viewer, getPageView: jest.fn(() => ({})) } };
  const getTextContent = jest.fn(async () => ({ items: [{ str: "Source" }] }));
  const pdfDocument = { getPage: jest.fn(async () => ({ getTextContent })) };
  const unit = { id: "sentence" }, onHover = jest.fn(async () => true), onLeave = jest.fn();
  const sourceHighlighter = { show: jest.fn(async () => true), clearHover: jest.fn() };
  findSentenceAtPoint.mockReset().mockReturnValue(unit);
  const hover = createPdfSourceHover({ app, pdfDocument, sourceHighlighter, getUnits: () => [unit], onHover, onLeave, isEnabled: () => enabled });
  const move = (x = 100, buttons = 0) => span.dispatchEvent(new win.MouseEvent("pointermove", { bubbles: true, clientX: x, clientY: 100, buttons }));
  const frame = async () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn()); await settle(); };
  return { win, viewer, span, frames, app, pdfDocument, getTextContent, sourceHighlighter, unit, onHover, onLeave, hover, move, frame, events,
    disable: () => { enabled = false; hover.clear(); } };
}

test("PDF pointer motion uses the latest frame, caches text, and notifies only once per sentence", async () => {
  const run = fixture(); run.move(100); run.move(200);
  expect(run.frames.size).toBe(1); await run.frame();
  expect(findSentenceAtPoint.mock.calls[0][3].clientX).toBe(200);
  expect(run.onHover).toHaveBeenCalledWith(run.unit, 2, expect.any(Function));
  expect(run.sourceHighlighter.show).toHaveBeenCalledWith(run.unit, 2, { navigate: false });
  expect(run.app.page).toBe(1);
  run.move(205); await run.frame();
  expect(run.onHover).toHaveBeenCalledTimes(1);
  expect(run.sourceHighlighter.show).toHaveBeenCalledTimes(1);
  expect(run.getTextContent).toHaveBeenCalledTimes(1);
  run.hover.destroy();
});

test("leaving or disabling during a text fetch prevents a stale highlight", async () => {
  const run = fixture(); let finish;
  run.getTextContent.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  run.move(); await run.frame();
  run.viewer.dispatchEvent(new run.win.Event("pointerleave"));
  finish({ items: [] }); await settle();
  expect(run.onHover).not.toHaveBeenCalled();
  expect(run.sourceHighlighter.show).not.toHaveBeenCalled();
  expect(run.sourceHighlighter.clearHover).toHaveBeenCalled();
  run.disable(); run.move(); await run.frame();
  expect(run.getTextContent).toHaveBeenCalledTimes(1);
  run.hover.destroy();
});

test("both source and translation hover marks clear when leaving the source or turning the link off", async () => {
  const run = fixture();
  run.move(); await run.frame();
  expect(run.onHover).toHaveBeenCalledTimes(1);
  expect(run.sourceHighlighter.show).toHaveBeenCalledTimes(1);
  run.viewer.dispatchEvent(new run.win.Event("pointerleave"));
  expect(run.onLeave).toHaveBeenCalled();
  expect(run.sourceHighlighter.clearHover).toHaveBeenCalled();
  run.move(); await run.frame();
  run.disable();
  const shown = run.sourceHighlighter.show.mock.calls.length;
  run.move(); await run.frame();
  expect(run.sourceHighlighter.show).toHaveBeenCalledTimes(shown);
  expect(run.sourceHighlighter.clearHover.mock.calls.length).toBeGreaterThan(1);
  run.hover.destroy();
});

test("dragging, zoom, scrolling, page changes and destroy clear links without interfering with source selection", async () => {
  const run = fixture(); run.move(100, 1); await run.frame();
  expect(run.pdfDocument.getPage).not.toHaveBeenCalled();
  run.move(); await run.frame();
  const current = run.onHover.mock.calls[0][2]; expect(current()).toBe(true);
  run.events.get("scalechanging")(); expect(current()).toBe(false);
  run.move(); await run.frame(); run.viewer.dispatchEvent(new run.win.Event("scroll"));
  expect(run.onLeave).toHaveBeenCalled();
  run.move(); await run.frame(); run.events.get("pagechanging")();
  run.hover.destroy(); expect(run.events.size).toBe(0);
  const count = run.onHover.mock.calls.length;
  run.move(); await run.frame(); expect(run.onHover).toHaveBeenCalledTimes(count);
});

test("a pending panel reveal remains replaceable while the pointer moves within the same sentence", async () => {
  const run = fixture(), finishes = [];
  run.onHover.mockImplementation(() => new Promise((resolve) => finishes.push(resolve)));
  run.move(); await run.frame(); const firstCurrent = run.onHover.mock.calls[0][2];
  run.move(110); await run.frame();
  expect(run.onHover).toHaveBeenCalledTimes(2); expect(firstCurrent()).toBe(false);
  const secondCurrent = run.onHover.mock.calls[1][2]; expect(secondCurrent()).toBe(true);
  finishes.forEach((finish) => finish(true)); await settle();
  run.move(115); await run.frame(); expect(run.onHover).toHaveBeenCalledTimes(2);
  run.hover.destroy();
});
