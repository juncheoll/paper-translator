import { getMessage } from "../i18n.js";

const regionStyles = {
  title: ["#b45309", "PDF_Translation_Heading", "제목"],
  section_header: ["#b45309", "PDF_Translation_Heading", "제목"],
  text: ["#2563eb", "PDF_Translation_Paragraph", "본문"],
  list_item: ["#2563eb", "PDF_Translation_Paragraph", "본문"],
  caption: ["#9333b8", "PDF_Translation_Caption", "캡션"],
  picture: ["#15803d", "PDF_Layout_Picture", "그림"],
};

// Docling coordinates follow the page's original displayed rotation. Project through PDF space
// so zoom, user rotation, crop offsets and page user units share PDF.js's own transforms.
export function projectLayoutRegion(region, page, baseViewport, viewport) {
  const box = region?.bbox;
  if (!box || ![box.x, box.y, box.width, box.height, viewport.width, viewport.height].every(Number.isFinite) ||
      box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0 ||
      Math.abs(baseViewport.width - page.width) > 1 || Math.abs(baseViewport.height - page.height) > 1) return null;
  const points = [box.x, box.x + box.width].flatMap((x) => [box.y, box.y + box.height].map((y) =>
    viewport.convertToViewportPoint(...baseViewport.convertToPdfPoint(x, y))));
  if (!points.flat().every(Number.isFinite)) return null;
  const left = Math.max(0, Math.min(...points.map(([x]) => x)));
  const top = Math.max(0, Math.min(...points.map(([, y]) => y)));
  const right = Math.min(viewport.width, Math.max(...points.map(([x]) => x)));
  const bottom = Math.min(viewport.height, Math.max(...points.map(([, y]) => y)));
  if (right <= left || bottom <= top) return null;
  return { left: left / viewport.width * 100, top: top / viewport.height * 100,
    width: (right - left) / viewport.width * 100, height: (bottom - top) / viewport.height * 100 };
}

export function createPdfLayoutOverlay({ app, enabled = false, isCurrent = () => true, onEditRegion }) {
  const doc = app.pdfViewer.container.ownerDocument;
  const win = doc.defaultView;
  const layers = new Map();
  let pages = [], destroyed = false, frame, editing = false;
  const style = doc.createElement("style");
  style.textContent = `
    .mttDoclingLayoutOverlay { position:absolute; inset:0; z-index:8; overflow:hidden; }
    .mttDoclingLayoutOverlay, .mttDoclingLayoutOverlay * { pointer-events:none !important; user-select:none !important; }
    .mttDoclingLayoutOverlay[data-editing=true] .mttDoclingLayoutRegion,
    .mttDoclingLayoutOverlay[data-editing=true] .mttDoclingLayoutRegion * { pointer-events:auto !important; cursor:pointer; }
    .mttDoclingLayoutOverlay [data-excluded=true] { border-style:dashed !important; opacity:.7; }
    .mttDoclingLayoutOverlay .mttDoclingLayoutRegion:focus { outline:3px solid #0f172a; outline-offset:2px; }
    .mttDoclingLayoutOverlay .mttDoclingLayoutRegion { position:absolute; box-sizing:border-box; border:1.5px solid var(--mtt-layout-color); }
    .mttDoclingLayoutOverlay .mttDoclingLayoutLabel { position:absolute; left:0; top:0; transform:translateY(-100%);
      width:max-content; max-width:250px; padding:1px 4px; border-radius:2px; background:var(--mtt-layout-color);
      color:#fff; font:600 11px/1.35 system-ui,sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    @media print { .mttDoclingLayoutOverlay { display:none !important; } }
  `;
  doc.head.append(style);

  function clear() {
    if (frame != null) win.cancelAnimationFrame(frame);
    frame = null;
    for (const { layer } of layers.values()) layer.remove();
    layers.clear();
  }
  function refresh() {
    frame = null;
    if (destroyed || !enabled || !isCurrent()) return;
    for (const page of pages) {
      const view = app.pdfViewer.getPageView(page.pageNumber - 1);
      const current = layers.get(page.pageNumber);
      // PDF.js evicts rendered pages from its buffer. Do not retain detached layers or
      // create thousands of diagnostic elements for pages that have never been rendered.
      if (!view?.div?.isConnected || !view.pdfPage || !view.div.querySelector("canvas")) {
        current?.layer.remove(); layers.delete(page.pageNumber); continue;
      }
      const viewport = view.viewport;
      const signature = JSON.stringify([viewport.width, viewport.height, viewport.transform]);
      if (current?.page === page && current.signature === signature && current.layer.parentNode === view.div) continue;
      current?.layer.remove();
      const layer = doc.createElement("div");
      layer.className = "mttDoclingLayoutOverlay";
      layer.dataset.mtt = "docling-layout";
      layer.setAttribute("aria-hidden", String(!editing));
      layer.dataset.editing = String(editing);
      const base = view.pdfPage.getViewport({ scale: 1 });
      for (const region of page.regions) {
        const bounds = projectLayoutRegion(region, page, base, viewport);
        if (!bounds) continue;
        const [color, key, fallback] = regionStyles[region.label] || ["#64748b", null, null];
        const box = doc.createElement("div");
        box.className = "mttDoclingLayoutRegion";
        box.dataset.regionId = String(region.id);
        box.dataset.regionLabel = region.label;
        box.dataset.excluded = String(!!region.excluded);
        box.style.setProperty("--mtt-layout-color", color);
        for (const [axis, value] of Object.entries(bounds)) box.style[axis] = `${value}%`;
        // Keep labels out of the PDF text layer and its span-based whitespace/highlight helpers.
        const label = doc.createElement("div");
        label.className = "mttDoclingLayoutLabel";
        label.textContent = key ? `${getMessage(key) || fallback} · ${region.label}` : region.label;
        if (region.manual) label.textContent += ` · ${getMessage("PDF_Region_Manual") || "수정"}`;
        if (region.excluded) label.textContent += ` · ${getMessage("PDF_Region_Excluded") || "제외"}`;
        if (editing) {
          box.tabIndex = 0; box.setAttribute("role", "button"); box.setAttribute("aria-label", label.textContent);
          const edit = (event) => { event.preventDefault(); event.stopPropagation(); if (editing && isCurrent()) onEditRegion?.(page, region); };
          box.addEventListener("click", edit);
          box.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) edit(event); });
        }
        if (bounds.top * viewport.height / 100 < 18) label.style.transform = "none";
        box.append(label); layer.append(box);
      }
      view.div.append(layer);
      layers.set(page.pageNumber, { layer, page, signature });
    }
  }
  function schedule() {
    if (destroyed || !enabled || frame != null) return;
    frame = win.requestAnimationFrame(refresh);
  }
  const reposition = () => { clear(); schedule(); };
  const events = { pagerendered: schedule, textlayerrendered: schedule, pagesinit: schedule,
    pagechanging: schedule, scalechanging: reposition, rotationchanging: reposition };
  for (const [event, handler] of Object.entries(events)) app.eventBus?.on(event, handler);
  return {
    setLayout(value = []) { if (destroyed) return; pages = value; clear(); schedule(); },
    setEnabled(value) { if (destroyed) return; enabled = !!value; if (enabled) schedule(); else clear(); },
    setEditing(value) { if (destroyed) return; editing = !!value; clear(); schedule(); },
    destroy() {
      if (destroyed) return;
      destroyed = true; clear(); pages = []; style.remove();
      for (const [event, handler] of Object.entries(events)) app.eventBus?.off(event, handler);
    },
  };
}
