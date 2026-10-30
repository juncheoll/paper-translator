import { findSentenceAtPoint } from "./source_highlight.js";

export function createPdfSourceHover({ app, pdfDocument, sourceHighlighter, getUnits, onHover, onLeave,
  isEnabled = () => true, isCurrent = () => true }) {
  const viewer = app.pdfViewer.container || document.getElementById("viewerContainer");
  if (!viewer) return { clear() {}, destroy() {} };
  const win = viewer.ownerDocument.defaultView;
  const listeners = new win.AbortController();
  const contents = new Map();
  let frame, point, sequence = 0, active = null, destroyed = false;
  function clear() {
    sequence++;
    if (frame != null) win.cancelAnimationFrame(frame);
    frame = null; point = null; active = null;
    sourceHighlighter?.clearHover();
    onLeave?.();
  }
  async function resolvePoint(position) {
    const token = ++sequence;
    const current = () => !destroyed && token === sequence && isCurrent() && isEnabled();
    const pageNumber = Number(position.target?.closest?.(".page[data-page-number]")?.dataset.pageNumber);
    const units = getUnits(pageNumber);
    if (!current() || position.buttons || !pageNumber || !units?.length) { clear(); return; }
    try {
      if (!contents.has(pageNumber)) {
        const pending = pdfDocument.getPage(pageNumber).then((page) =>
          page.getTextContent({ includeMarkedContent: true, disableNormalization: true }));
        contents.set(pageNumber, pending);
        pending.catch(() => { if (contents.get(pageNumber) === pending) contents.delete(pageNumber); });
      }
      const content = await contents.get(pageNumber);
      if (!current()) return;
      const unit = findSentenceAtPoint(app.pdfViewer.getPageView(pageNumber - 1), content.items, units, position, pageNumber);
      if (!unit) { clear(); return; }
      if (active?.id === unit.id && active.pageNumber === pageNumber) return;
      await Promise.all([onHover(unit, pageNumber, current),
        sourceHighlighter?.show(unit, pageNumber, { navigate: false })]);
      if (current()) active = { id: unit.id, pageNumber };
    } catch (_) { if (current()) clear(); }
  }
  viewer.addEventListener("pointermove", (event) => {
    if (!isEnabled() || event.buttons) { clear(); return; }
    point = { target: event.target, clientX: event.clientX, clientY: event.clientY, buttons: event.buttons };
    if (frame != null) return;
    frame = win.requestAnimationFrame(() => { frame = null; if (point) void resolvePoint(point); });
  }, { signal: listeners.signal });
  for (const event of ["pointerleave", "pointerdown", "scroll"]) viewer.addEventListener(event, clear,
    { signal: listeners.signal, capture: event === "scroll" });
  for (const event of ["pagechanging", "scalechanging", "rotationchanging"]) app.eventBus?.on(event, clear);
  return {
    clear,
    destroy() {
      destroyed = true; clear(); listeners.abort(); contents.clear();
      for (const event of ["pagechanging", "scalechanging", "rotationchanging"]) app.eventBus?.off(event, clear);
    },
  };
}
