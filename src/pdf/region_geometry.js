import { getMessage } from "../i18n.js";
import { projectLayoutRegion } from "./layout_overlay.js";
const msg = (key, fallback) => getMessage(key) || fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function resizeRegionRect(rect, edge, point, bounds, minimum = { width: 8, height: 8 }) {
  let { x, y, width, height } = rect, right = x + width, bottom = y + height;
  if (edge.includes("w")) x = clamp(point.x, 0, right - minimum.width);
  if (edge.includes("e")) right = clamp(point.x, x + minimum.width, bounds.width);
  if (edge.includes("n")) y = clamp(point.y, 0, bottom - minimum.height);
  if (edge.includes("s")) bottom = clamp(point.y, y + minimum.height, bounds.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function splitRegionRect(rect, axis, ratio = .5) {
  if (!axis) return [{ ...rect }];
  const size = axis === "horizontal" ? "height" : "width", coord = axis === "horizontal" ? "y" : "x";
  const offset = rect[size] * ratio;
  return [{ ...rect, [size]: offset }, { ...rect, [coord]: rect[coord] + offset, [size]: rect[size] - offset }];
}

// Inverse of the overlay projection: persist original page coordinates, never screen pixels.
export function unprojectRegionRect(rect, page, base, viewport) {
  const points = [rect.x, rect.x + rect.width].flatMap((x) => [rect.y, rect.y + rect.height].map((y) =>
    base.convertToViewportPoint(...viewport.convertToPdfPoint(x, y))));
  if (!points.flat().every(Number.isFinite)) throw new Error("Invalid page coordinates");
  const x = clamp(Math.min(...points.map(([x]) => x)), 0, page.width);
  const y = clamp(Math.min(...points.map(([, y]) => y)), 0, page.height);
  const box = { x, y, width: clamp(Math.max(...points.map(([x]) => x)), x, page.width) - x,
    height: clamp(Math.max(...points.map(([, y]) => y)), y, page.height) - y };
  return Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10000) / 10000]));
}

export function createPdfRegionGeometryEditor({ app, onSave, isCurrent = () => true }) {
  const doc = app.pdfViewer.container.ownerDocument, win = doc.defaultView;
  let session, drag, destroyed = false;
  const style = doc.createElement("style");
  style.textContent = `
    .mttPdfGeometryLayer { position:absolute; inset:0; z-index:10; touch-action:none; user-select:none; }
    .mttPdfGeometryLayer .mttPdfGeometryBox { position:absolute; box-sizing:border-box; border:2px solid #0284c7; background:#0ea5e918; }
    .mttPdfGeometryLayer .mttPdfGeometryPart { position:absolute; box-sizing:border-box; border:1px dashed #0284c7; pointer-events:none; }
    .mttPdfGeometryLayer .mttPdfGeometryPart b { background:#075985; color:#fff; padding:0 5px; font:600 13px/1.5 system-ui; }
    .mttPdfGeometryLayer .mttPdfGeometryHandle { position:absolute; width:12px; height:12px; padding:0; transform:translate(-50%,-50%);
      border:2px solid #075985; border-radius:2px; background:#fff; touch-action:none; }
    .mttPdfGeometryLayer .mttPdfGeometryDivider { position:absolute; padding:0; background:#f97316; border:0; touch-action:none; }
    .mttPdfGeometryLayer :focus-visible { outline:3px solid #0f172a; outline-offset:2px; }
    #mttPdfGeometryToolbar { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); z-index:1001;
      max-width:calc(100vw - 32px); box-sizing:border-box; width:560px; padding:12px 16px; border:1px solid #94a3b8;
      border-radius:10px; background:#fff; color:#182230; box-shadow:0 4px 20px #0003; font:14px/1.5 system-ui; }
    #mttPdfGeometryToolbar p { margin:0 0 8px; }
    #mttPdfGeometryToolbar .mttPdfGeometryActions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
    #mttPdfGeometryToolbar select, #mttPdfGeometryToolbar button { padding:6px 10px; font:inherit; }
    #mttPdfGeometryToolbar [role=alert] { color:#b91c1c; }
    @media print { .mttPdfGeometryLayer, #mttPdfGeometryToolbar { display:none !important; } }
  `;
  doc.head.append(style);
  function close() {
    drag = null;
    if (!session) return;
    session.layer.remove(); session.toolbar.remove(); session = null;
    if (!destroyed) doc.getElementById("mttPdfLayoutEditToggle")?.focus();
  }
  function draw() {
    const s = session;
    if (!s) return;
    const { rect: r, viewport: v } = s;
    const position = (element, box) => {
      element.style.left = `${box.x / v.width * 100}%`; element.style.top = `${box.y / v.height * 100}%`;
      element.style.width = `${box.width / v.width * 100}%`; element.style.height = `${box.height / v.height * 100}%`;
    };
    position(s.box, r);
    const parts = splitRegionRect(r, s.axis, s.ratio);
    s.parts.forEach((part, i) => { part.hidden = !s.axis; if (parts[i]) position(part, parts[i]); });
    for (const [edge, handle] of s.handles) {
      handle.style.left = `${(edge.includes("w") ? r.x : edge.includes("e") ? r.x + r.width : r.x + r.width / 2) / v.width * 100}%`;
      handle.style.top = `${(edge.includes("n") ? r.y : edge.includes("s") ? r.y + r.height : r.y + r.height / 2) / v.height * 100}%`;
    }
    s.divider.hidden = !s.axis;
    if (s.axis) {
      const horizontal = s.axis === "horizontal";
      position(s.divider, horizontal ? { x:r.x, y:r.y + r.height*s.ratio, width:r.width, height:0 }
        : { x:r.x + r.width*s.ratio, y:r.y, width:0, height:r.height });
      s.divider.style[horizontal ? "height" : "width"] = "8px";
      s.divider.style.transform = horizontal ? "translateY(-50%)" : "translateX(-50%)";
      s.divider.style.cursor = horizontal ? "row-resize" : "col-resize";
      s.divider.setAttribute("aria-orientation", horizontal ? "horizontal" : "vertical");
      s.divider.setAttribute("aria-valuenow", String(Math.round(s.ratio * 100)));
    }
    s.select.options[1].disabled = r.height < 16; s.select.options[2].disabled = r.width < 16;
  }
  function move(point, edge) {
    const s = session;
    if (!s || s.busy) return;
    if (edge === "divider") {
      const size = s.axis === "horizontal" ? "height" : "width", coord = s.axis === "horizontal" ? "y" : "x";
      s.ratio = clamp((point[coord] - s.rect[coord]) / s.rect[size], 8/s.rect[size], 1 - 8/s.rect[size]);
    } else {
      s.rect = resizeRegionRect(s.rect, edge, point, s.viewport,
        { width:s.axis === "vertical" ? 16 : 8, height:s.axis === "horizontal" ? 16 : 8 });
      if (s.axis) {
        const size = s.axis === "horizontal" ? s.rect.height : s.rect.width;
        s.ratio = clamp(s.ratio, 8/size, 1 - 8/size);
      }
    }
    draw();
  }
  const pointerMove = (event) => {
    if (!drag || !session || event.pointerId !== drag.id) return;
    const bounds = session.layer.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    event.preventDefault();
    move({ x:(event.clientX-bounds.left)/bounds.width*session.viewport.width,
      y:(event.clientY-bounds.top)/bounds.height*session.viewport.height }, drag.edge);
  };
  const pointerUp = () => { drag = null; };
  win.addEventListener("pointermove", pointerMove, { passive:false });
  win.addEventListener("pointerup", pointerUp); win.addEventListener("pointercancel", pointerUp);
  function bind(element, edge) {
    element.addEventListener("pointerdown", (event) => {
      if (!session || session.busy || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); element.focus();
      drag = { id:event.pointerId, edge }; element.setPointerCapture?.(event.pointerId);
    });
    element.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) || !session || session.busy) return;
      event.preventDefault(); event.stopPropagation();
      const s = session, r = s.rect, step = event.shiftKey ? 10 : 1;
      const point = edge === "divider" ? { x:r.x+r.width*s.ratio, y:r.y+r.height*s.ratio }
        : { x:edge.includes("w") ? r.x : r.x+r.width, y:edge.includes("n") ? r.y : r.y+r.height };
      point.x += event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      point.y += event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      move(point, edge);
    });
  }
  async function save() {
    const s = session;
    if (!s || s.busy || !isCurrent()) return;
    s.busy = true; drag = null; s.error.textContent = "";
    for (const control of s.controls) control.disabled = true;
    try {
      const parts = splitRegionRect(s.rect, s.axis, s.ratio).map((rect) => ({ label:s.region.label,
        excluded:!!s.region.excluded, bbox:unprojectRegionRect(rect, s.page, s.base, s.viewport) }));
      await onSave(s.page, s.region, { parts });
      if (session === s) close();
    } catch (_) {
      if (session === s) s.error.textContent = msg("PDF_Region_Save_Failed", "영역 수정을 저장하지 못했습니다. 기존 수정은 유지됩니다.");
    } finally {
      s.busy = false;
      if (session === s) { for (const control of s.controls) control.disabled = false; draw(); }
    }
  }
  const cancelEvent = () => close();
  for (const event of ["scalechanging", "rotationchanging", "pagechanging", "pagesinit"]) app.eventBus?.on(event, cancelEvent);
  const escape = (event) => { if (session && !session.busy && event.key === "Escape") { event.preventDefault(); close(); } };
  doc.addEventListener("keydown", escape);
  return {
    open(page, region) {
      if (destroyed || !isCurrent() || session?.busy) return false;
      const view = app.pdfViewer.getPageView(page.pageNumber - 1), v = view?.viewport;
      if (!view?.div?.isConnected || !view.pdfPage) return false;
      const base = view.pdfPage.getViewport({ scale:1 }), bounds = projectLayoutRegion(region, page, base, v);
      if (!bounds) return false;
      close();
      const layer = doc.createElement("div"); layer.className = "mttPdfGeometryLayer";
      const box = doc.createElement("div"); box.className = "mttPdfGeometryBox"; layer.append(box);
      const parts = [1,2].map((i) => { const part = doc.createElement("div"); part.className = "mttPdfGeometryPart";
        const label = doc.createElement("b"); label.textContent = String(i); part.append(label); layer.append(part); return part; });
      const handles = new Map();
      for (const edge of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
        const handle = doc.createElement("button"); handle.type = "button"; handle.className = "mttPdfGeometryHandle";
        handle.dataset.edge = edge; handle.style.cursor = `${edge}-resize`;
        handle.setAttribute("aria-label", `${msg("PDF_Region_Resize_Handle", "경계 조절 손잡이")} ${edge.toUpperCase()}`);
        bind(handle, edge); layer.append(handle); handles.set(edge, handle);
      }
      const divider = doc.createElement("div"); divider.className = "mttPdfGeometryDivider";
      divider.tabIndex = 0; divider.setAttribute("role", "separator");
      divider.setAttribute("aria-label", msg("PDF_Region_Split_Line", "분할선"));
      divider.setAttribute("aria-valuemin", "0"); divider.setAttribute("aria-valuemax", "100");
      bind(divider, "divider"); layer.append(divider); view.div.append(layer);
      const toolbar = doc.createElement("div"); toolbar.id = "mttPdfGeometryToolbar";
      toolbar.setAttribute("role", "region"); toolbar.setAttribute("aria-label", msg("PDF_Region_Geometry", "경계·분할 수정"));
      const help = doc.createElement("p"); help.textContent = msg("PDF_Region_Geometry_Help",
        "손잡이와 분할선을 드래그하세요. 저장 후 각 영역의 분류를 따로 지정할 수 있습니다. (방향키: 미세 조절)");
      const actions = doc.createElement("div"); actions.className = "mttPdfGeometryActions";
      const select = doc.createElement("select"); select.setAttribute("aria-label", msg("PDF_Region_Split", "영역 나누기"));
      for (const [value, key, fallback] of [["", "PDF_Region_No_Split", "나누지 않음"],
        ["horizontal", "PDF_Region_Split_Horizontal", "위·아래로 나누기"], ["vertical", "PDF_Region_Split_Vertical", "왼쪽·오른쪽으로 나누기"]]) {
        const option = doc.createElement("option"); option.value = value; option.textContent = msg(key, fallback); select.append(option);
      }
      const cancel = doc.createElement("button"); cancel.type = "button"; cancel.textContent = msg("PDF_Region_Cancel", "취소");
      const commit = doc.createElement("button"); commit.type = "button"; commit.textContent = msg("PDF_Region_Save", "저장");
      const error = doc.createElement("p"); error.setAttribute("role", "alert");
      actions.append(select, cancel, commit); toolbar.append(help, actions, error); doc.body.append(toolbar);
      session = { page, region, base, viewport:v, rect:{x:bounds.left/100*v.width, y:bounds.top/100*v.height,
        width:bounds.width/100*v.width, height:bounds.height/100*v.height}, axis:"", ratio:.5,
        layer, box, parts, handles, divider, toolbar, select, error, controls:[select,cancel,commit], busy:false };
      select.addEventListener("change", () => { if (!session || session.busy) return; session.axis = select.value; session.ratio = .5; draw(); });
      cancel.addEventListener("click", close); commit.addEventListener("click", () => { void save(); });
      draw(); handles.get("se").focus(); return true;
    },
    close,
    isOpen: () => !!session,
    destroy() {
      destroyed = true; close(); style.remove(); doc.removeEventListener("keydown", escape);
      win.removeEventListener("pointermove", pointerMove); win.removeEventListener("pointerup", pointerUp); win.removeEventListener("pointercancel", pointerUp);
      for (const event of ["scalechanging", "rotationchanging", "pagechanging", "pagesinit"]) app.eventBus?.off(event, cancelEvent);
    },
  };
}
