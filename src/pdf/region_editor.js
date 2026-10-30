import { getMessage } from "../i18n.js";
import { editableRegionLabels } from "./layout_edits.js";

const msg = (key, fallback) => getMessage(key) || fallback;

export function createPdfRegionEditor({ doc = document, onSave, onEditGeometry }) {
  const dialog = doc.createElement("dialog");
  dialog.id = "mttPdfRegionEditor";
  const style = doc.createElement("style");
  style.textContent = `
    #mttPdfRegionEditor { position:fixed; inset:0; margin:auto; width:min(380px,85vw); padding:20px;
      border:1px solid #cbd5e1; border-radius:10px; background:#fff; color:#182230; font:14px/1.6 system-ui; z-index:1000; }
    #mttPdfRegionEditor::backdrop { background:#0f172a55; }
    #mttPdfRegionEditor h2 { margin:0 0 10px; font-size:18px; }
    #mttPdfRegionEditor label { display:block; margin:12px 0; }
    #mttPdfRegionEditor select { display:block; width:100%; padding:7px; margin-top:4px; font:inherit; }
    #mttPdfRegionEditor footer { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; flex-wrap:wrap; }
    #mttPdfRegionEditor button { padding:6px 12px; font:inherit; cursor:pointer; }
    #mttPdfRegionEditor [role=alert] { color:#b91c1c; white-space:pre-wrap; }
    @media print { #mttPdfRegionEditor { display:none !important; } }
  `;
  doc.head.append(style);
  const form = doc.createElement("form");
  const heading = doc.createElement("h2");
  heading.id = "mttPdfRegionEditorTitle";
  heading.textContent = msg("PDF_Region_Edit_Title", "영역 분류 수정");
  dialog.setAttribute("aria-labelledby", heading.id);
  const info = doc.createElement("p");
  const field = doc.createElement("label");
  field.textContent = msg("PDF_Region_Classification", "분류 / 번역 대상");
  const select = doc.createElement("select");
  for (const value of [...editableRegionLabels, "exclude"]) {
    const option = doc.createElement("option");
    option.value = value;
    const names = { text: ["PDF_Translation_Paragraph", "본문"], section_header: ["PDF_Translation_Heading", "제목"],
      title: ["PDF_Translation_Heading", "제목"], caption: ["PDF_Translation_Caption", "캡션"], picture: ["PDF_Layout_Picture", "그림"],
      table: ["PDF_Translation_Table", "표"], formula: ["PDF_Translation_Formula", "수식"] };
    option.textContent = value === "exclude" ? msg("PDF_Region_Exclude", "번역에서 제외")
      : names[value] ? `${msg(...names[value])} (${value})` : value;
    select.append(option);
  }
  field.append(select);
  const error = doc.createElement("p"); error.setAttribute("role", "alert");
  const footer = doc.createElement("footer");
  const button = (key, fallback) => {
    const element = doc.createElement("button"); element.type = "button";
    element.textContent = msg(key, fallback); footer.append(element); return element;
  };
  const reset = button("PDF_Region_Reset", "자동 분류로 복원");
  const geometry = button("PDF_Region_Geometry", "경계·분할 수정");
  geometry.hidden = !onEditGeometry;
  const cancel = button("PDF_Region_Cancel", "취소");
  const save = button("PDF_Region_Save", "저장"); save.type = "submit";
  form.append(heading, info, field, error, footer); dialog.append(form); doc.body.append(dialog);
  let selected, busy = false, destroyed = false;
  const close = () => {
    if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); selected = null;
    if (!destroyed) doc.getElementById("mttPdfLayoutEditToggle")?.focus();
  };
  async function commit(restore) {
    if (busy || !selected || destroyed) return;
    const record = selected;
    busy = true; for (const el of [select, reset, geometry, cancel, save]) el.disabled = true;
    error.textContent = "";
    try {
      const edit = restore ? null : { label: select.value === "exclude" ? record.region.label : select.value,
        excluded: select.value === "exclude" };
      await onSave(record.page, record.region, edit);
      if (!destroyed) close();
    } catch (_) {
      if (!destroyed) error.textContent = msg("PDF_Region_Save_Failed", "영역 수정을 저장하지 못했습니다. 기존 수정은 유지됩니다.");
    } finally {
      busy = false;
      if (!destroyed) {
        for (const el of [select, reset, geometry, cancel, save]) el.disabled = false;
        reset.disabled = !selected?.region.manual;
      }
    }
  }
  form.addEventListener("submit", (event) => { event.preventDefault(); void commit(false); });
  reset.addEventListener("click", () => { void commit(true); });
  geometry.addEventListener("click", () => {
    if (busy || !selected) return;
    const record = selected;
    const region = { ...record.region, label: select.value === "exclude" ? record.region.label : select.value,
      excluded: select.value === "exclude" };
    close(); onEditGeometry?.(record.page, region);
  });
  cancel.addEventListener("click", () => { if (!busy) close(); });
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  return {
    open(page, region) {
      if (destroyed || busy) return;
      selected = { page, region }; error.textContent = "";
      info.textContent = `${page.pageNumber} · ${region.originalLabel || region.label}`;
      if (region.editAnchor) info.textContent += ` · ${msg("PDF_Region_Restore_Geometry_Help", "복원하면 원래 영역 전체로 되돌아갑니다.")}`;
      reset.textContent = region.editAnchor ? msg("PDF_Region_Reset_Geometry", "원래 영역으로 복원")
        : msg("PDF_Region_Reset", "자동 분류로 복원");
      select.value = region.excluded ? "exclude" : region.label;
      reset.disabled = !region.manual;
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
      }
      select.focus();
    },
    close,
    isSaving: () => busy,
    destroy() { destroyed = true; close(); dialog.remove(); style.remove(); },
  };
}
