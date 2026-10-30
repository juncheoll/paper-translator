import { JSDOM } from "jsdom";
import { createPdfLayoutOverlay, projectLayoutRegion } from "../src/pdf/layout_overlay";

jest.mock("../src/i18n.js", () => ({ getMessage: () => "" }));

function viewport(rotation = 0, scale = 1) {
  const transform = {
    0: [scale, 0, 0, -scale, 0, 800 * scale],
    90: [0, scale, scale, 0, 0, 0],
    180: [-scale, 0, 0, scale, 600 * scale, 0],
    270: [0, -scale, -scale, 0, 800 * scale, 600 * scale],
  }[rotation];
  const [a, b, c, d, e, f] = transform;
  return { rotation, transform, width: (rotation % 180 ? 800 : 600) * scale,
    height: (rotation % 180 ? 600 : 800) * scale,
    convertToViewportPoint: (x, y) => [a * x + c * y + e, b * x + d * y + f],
    convertToPdfPoint: (x, y) => [(d * (x-e) - c * (y-f))/(a*d-b*c), (-b * (x-e) + a * (y-f))/(a*d-b*c)] };
}
const region = { id: 1, label: "text", confidence: .95, bbox: { x: 100, y: 200, width: 80, height: 30 } };
const layout = { pageNumber: 1, width: 600, height: 800, regions: [region,
  { ...region, id: 2, label: "picture", bbox: { x: 300, y: 50, width: 100, height: 100 } }] };

test.each([
  [0, [100/600*100, 25, 80/600*100, 3.75]],
  [90, [71.25, 100/600*100, 3.75, 80/600*100]],
  [180, [70, 71.25, 80/600*100, 3.75]],
  [270, [25, 70, 3.75, 80/600*100]],
])("region positions remain correct at rotation %s and different zoom levels", (rotation, expected) => {
  for (const scale of [.5, 1, 2.5]) {
    const bounds = projectLayoutRegion(region, layout, viewport(), viewport(rotation, scale));
    Object.values(bounds).forEach((value, i) => expect(value).toBeCloseTo(expected[i]));
  }
});

test("native PDF rotation is preserved, incompatible coordinates are skipped and margins are clipped", () => {
  const rotatedLayout = { width: 800, height: 600 };
  const rotatedRegion = { bbox: { x: 570, y: 100, width: 30, height: 80 } };
  const result = projectLayoutRegion(rotatedRegion, rotatedLayout, viewport(90), viewport(0, 2));
  expect(result.left).toBeCloseTo(100/600*100);
  expect(result.top).toBe(25);
  expect(projectLayoutRegion(region, { width: 1200, height: 800 }, viewport(), viewport())).toBeNull();
  expect(projectLayoutRegion({ bbox: { x: -5, y: -5, width: 10, height: 10 } }, layout, viewport(), viewport())).toEqual({
    left: 0, top: 0, width: 5/600*100, height: 5/800*100,
  });
});

function fixture(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="viewer"><div class="page"><canvas></canvas><div class="textLayer"><span role="presentation">Native text.</span></div></div></div></body>');
  const doc = dom.window.document, callbacks = new Map(), events = new Map();
  let seq = 0, current = true;
  dom.window.requestAnimationFrame = (fn) => { callbacks.set(++seq, fn); return seq; };
  dom.window.cancelAnimationFrame = (id) => callbacks.delete(id);
  const view = { div: doc.querySelector('.page'), viewport: viewport(), pdfPage: { getViewport: jest.fn(() => viewport()) } };
  const app = { eventBus: { on: (name, fn) => events.set(name, fn), off: (name) => events.delete(name) },
    pdfViewer: { container: doc.querySelector('#viewer'), getPageView: () => view } };
  const overlay = createPdfLayoutOverlay({ app, isCurrent: () => current, ...options });
  const frame = () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(fn => fn()); };
  return { dom, doc, app, view, events, overlay, frame, callbacks, stale: () => { current = false; } };
}

test("the overlay defaults off; toggling reuses geometry, leaves native spans alone and never captures input", () => {
  const run = fixture();
  run.overlay.setLayout([layout]); run.frame();
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay')).toBeNull();
  expect(run.view.pdfPage.getViewport).not.toHaveBeenCalled();
  run.overlay.setEnabled(true); run.frame();
  expect(run.doc.querySelectorAll('.mttDoclingLayoutRegion')).toHaveLength(2);
  expect(run.doc.querySelector('[data-region-label="text"]').textContent).toContain('text');
  expect(run.doc.querySelector('[data-region-label="picture"]').textContent).toContain('그림');
  expect(run.doc.querySelectorAll('.page span')).toHaveLength(1);
  expect(run.doc.querySelector('.textLayer').textContent).toBe('Native text.');
  expect(run.dom.window.getComputedStyle(run.doc.querySelector('.mttDoclingLayoutRegion')).pointerEvents).toBe('none');
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay').getAttribute('aria-hidden')).toBe('true');
  run.events.get('textlayerrendered')(); run.frame();
  expect(run.doc.querySelectorAll('.mttDoclingLayoutOverlay')).toHaveLength(1);
  run.overlay.setEnabled(false);
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay')).toBeNull();
  run.overlay.destroy(); run.dom.window.close();
});

test("region interaction is enabled only in explicit edit mode and supports the keyboard", () => {
  const onEditRegion = jest.fn(), run = fixture({ onEditRegion });
  run.overlay.setLayout([layout]); run.overlay.setEnabled(true); run.frame();
  run.doc.querySelector('.mttDoclingLayoutRegion').click(); expect(onEditRegion).not.toHaveBeenCalled();
  run.overlay.setEditing(true); run.frame();
  const box = run.doc.querySelector('.mttDoclingLayoutRegion');
  expect(box.getAttribute('role')).toBe('button');
  expect(run.dom.window.getComputedStyle(box).pointerEvents).toBe('auto');
  box.dispatchEvent(new run.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(onEditRegion).toHaveBeenCalledWith(layout, region);
  run.overlay.setEditing(false); run.frame();
  expect(run.doc.querySelector('.mttDoclingLayoutRegion').getAttribute('role')).toBeNull();
  run.overlay.destroy(); run.dom.window.close();
});

test("zoom, rotation, canvas reset and document replacement cannot leave old or duplicate outlines", () => {
  const run = fixture(); run.overlay.setLayout([layout]); run.overlay.setEnabled(true); run.frame();
  run.events.get('scalechanging')();
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay')).toBeNull();
  run.view.viewport = viewport(90, 2); run.frame();
  expect(parseFloat(run.doc.querySelector('[data-region-id="1"]').style.left)).toBeCloseTo(71.25);
  run.doc.querySelector('.mttDoclingLayoutOverlay').remove();
  run.events.get('pagerendered')(); run.frame();
  expect(run.doc.querySelectorAll('.mttDoclingLayoutOverlay')).toHaveLength(1);
  run.doc.querySelector('canvas').remove(); run.events.get('pagerendered')(); run.frame();
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay')).toBeNull();
  run.overlay.setEnabled(true); run.stale(); run.frame();
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay')).toBeNull();
  run.overlay.destroy();
  expect(run.events.size).toBe(0);
  expect(run.callbacks.size).toBe(0);
  expect(run.doc.querySelector('style')).toBeNull();
  run.overlay.setEnabled(true); run.overlay.setLayout([layout]); run.frame();
  expect(run.doc.querySelector('.mttDoclingLayoutOverlay')).toBeNull();
  run.dom.window.close();
});
