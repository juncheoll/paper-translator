import { getMessage } from "../i18n.js";
import { validMathTranslation } from "./inline_math.js";
import { getDisplaySections } from "./display_paragraphs.js";

const text = (key, fallback) => getMessage(key) || fallback;

export function createPdfTranslationPanel({
  onTranslatePage, onTranslateAll, onStop, onModeChange, onJumpToBlock, onHoverSentence, onLeaveSentence,
  onRetranslateSentence, onRestoreSentence,
  renderVisual, renderInlineMath, releaseVisual, hideVisualTooltip,
  sourceVariableTooltip = true, onSourceVariableTooltipChange,
  linkedHover = true, onLinkedHoverChange, layoutOverlay = false, onLayoutOverlayChange, onLayoutEditingChange,
} = {}) {
  const doc = document;
  const win = doc.defaultView;
  const listeners = new win.AbortController();
  let destroyed = false;
  let busy = false;
  let currentPage = 1;
  let currentMode = "auto";
  const rows = new Map();
  const paragraphs = new Map();
  const sizeKey = "mttPdfTranslationPanelSize";
  const previousWidth = doc.documentElement.style.getPropertyValue("--mttPdfTranslateWidth");
  let preferredSize = {};
  let panelSize;
  let drag = null;
  let activePreview = null;
  let menuRecord = null;
  let linkedHoverEnabled = linkedHover;
  let sourceHighlightId = null;
  let layoutEditing = false, layoutEditable = false;
  try {
    const saved = JSON.parse(win.localStorage.getItem(sizeKey));
    if (Number.isFinite(saved?.width) && saved.width > 0) preferredSize.width = saved.width;
  } catch (_) {}

  const make = (tag, className, content) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = content;
    return element;
  };
  const button = (label, action, className = "") => {
    const element = make("button", className, label);
    element.type = "button";
    element.addEventListener("click", () => { if (!destroyed) action?.(); }, { signal: listeners.signal });
    return element;
  };
  const icon = (path) => {
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("mttPdfTranslateIcon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const shape = doc.createElementNS(svg.namespaceURI, "path");
    shape.setAttribute("d", path);
    svg.append(shape);
    return svg;
  };
  const style = make("style");
  style.id = "mttPdfTranslateStyle";
  style.textContent = `
    html.mttPdfTranslateOpen #outerContainer { width:calc(100% - var(--mttPdfTranslateWidth, min(400px, 45vw))); }
    #mttPdfTranslatePanel { position:fixed; inset:0 0 auto auto; width:min(400px,45vw); height:100vh;
      max-width:85vw; max-height:100vh; z-index:100;
      --mttPdfAccent:#147d73; --mttPdfInk:#263733; --mttPdfLine:#dfe7e3;
      box-sizing:border-box; display:flex; flex-direction:column; background:#fafbf9; color:var(--mttPdfInk);
      border-left:1px solid var(--mttPdfLine); box-shadow:-6px 0 28px #223c3010;
      font:14px/1.8 system-ui,sans-serif; direction:ltr; }
    #mttPdfTranslatePanel[hidden] { display:none; }
    #mttPdfTranslatePanel * { box-sizing:border-box; }
    #mttPdfTranslatePanel .mttPdfTranslateIcon { width:16px; height:16px; flex:none; fill:none;
      stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; pointer-events:none; }
    #mttPdfTranslatePanel .mttPdfTranslateHeader { display:flex; align-items:center; gap:8px;
      padding:10px 14px 6px; flex:none; }
    #mttPdfTranslatePanel .mttPdfTranslateBrand { display:grid; place-items:center; width:28px; height:28px;
      border:1px solid #d5e7df; border-radius:9px; background:#eaf4ef; color:var(--mttPdfAccent); flex:none; }
    #mttPdfTranslatePanel h2 { margin:0; font-size:13px; font-weight:650; letter-spacing:-.2px; flex:1;
      min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #mttPdfTranslatePanel button, #mttPdfTranslatePanel select { font:inherit; color:inherit; margin:0;
      border:1px solid var(--mttPdfLine); border-radius:8px; background:#fff; padding:5px 9px; cursor:pointer; }
    #mttPdfTranslatePanel button { display:inline-flex; justify-content:center; align-items:center; gap:6px;
      line-height:1.5; transition:background .15s,border-color .15s,box-shadow .15s; }
    #mttPdfTranslatePanel button:not(:disabled):hover { background:#f0f5f1; border-color:#bacfc3; }
    #mttPdfTranslatePanel button:not(:disabled):active { background:#e5eee8; }
    #mttPdfTranslatePanel button:disabled, #mttPdfTranslatePanel select:disabled { opacity:.5; cursor:default; }
    #mttPdfTranslatePanel button:focus-visible, #mttPdfTranslatePanel select:focus-visible, #mttPdfTranslatePanel input:focus-visible {
      outline:2px solid var(--mttPdfAccent); outline-offset:3px; }
    #mttPdfTranslatePanel .mttPdfTranslatePrimary { color:#fff; background:var(--mttPdfAccent);
      border-color:var(--mttPdfAccent); box-shadow:0 2px 4px #147d731a; }
    #mttPdfTranslatePanel .mttPdfTranslatePrimary:not(:disabled):hover { background:#10695f; border-color:#10695f; }
    #mttPdfTranslatePanel .mttPdfTranslateHeader button { min-height:28px; padding:3px 7px; font-size:11px; flex:none;
      border-color:transparent; background:transparent; color:#63746b; }
    #mttPdfTranslatePanel .mttPdfTranslateHeader .mttPdfTranslateClose { width:28px; padding:0; font:22px/1 system-ui; }
    #mttPdfTranslatePanel .mttPdfTranslateSettingsToggle[aria-expanded="true"] { color:#176b57; background:#e6f0e9; border-color:#d0e2d7; }
    #mttPdfTranslatePanel .mttPdfTranslateControls { display:flex; flex-wrap:wrap; gap:6px; padding:5px 14px 11px; flex:none; font-size:12px; }
    #mttPdfTranslatePanel .mttPdfTranslateControls button { min-height:30px; padding:5px 10px; }
    #mttPdfTranslatePanel .mttPdfTranslateControls .mttPdfTranslateStop { color:#a34035; border-color:#eddbd5; background:#fff8f4; }
    #mttPdfTranslatePanel .mttPdfTranslateControls button[hidden] { display:none; }
    #mttPdfTranslatePanel .mttPdfTranslateSettings { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));
      align-items:center; gap:10px 12px; margin:0 14px 12px; padding:12px; border:1px solid var(--mttPdfLine); border-radius:12px;
      background:#fff; box-shadow:0 3px 10px #26373304; font-size:12px; overflow:auto; max-height:40%; min-height:0; flex:0 1 auto; }
    #mttPdfTranslatePanel .mttPdfTranslateSettings[hidden] { display:none; }
    #mttPdfTranslatePanel .mttPdfTranslateOrder { display:flex; align-items:center; flex-wrap:wrap; gap:6px; grid-column:1 / -1;
      padding-bottom:10px; border-bottom:1px solid #edf0ed; color:#63746b; }
    #mttPdfTranslatePanel .mttPdfTranslateOrder select { margin-inline-start:auto; padding:3px 8px; }
    #mttPdfTranslatePanel .mttPdfTranslateSettings > button { justify-self:start; }
    #mttPdfTranslatePanel .mttPdfTranslateFooter { display:flex; flex-wrap:wrap; align-items:center; gap:2px 8px;
      padding:7px 14px 7px 32px; border-top:1px solid var(--mttPdfLine); background:#f5f8f4; flex:none; }
    #mttPdfTranslatePanel .mttPdfTranslateStatus, #mttPdfTranslatePanel .mttPdfTranslateProgress {
      margin:0; padding:0; color:#66776e; font-size:11px; white-space:nowrap; }
    #mttPdfTranslatePanel .mttPdfTranslateStatus { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
    #mttPdfTranslatePanel .mttPdfTranslateProgress { color:#28735e; font-variant-numeric:tabular-nums; }
    #mttPdfTranslatePanel .mttPdfTranslateStatus:empty, #mttPdfTranslatePanel .mttPdfTranslateProgress:empty { display:none; }
    #mttPdfTranslatePanel .mttPdfTranslateWarnings { margin:0 14px 10px; padding:9px 11px; border:1px solid #efdfb6; border-radius:10px;
      background:#fff8e8; color:#77521f; font-size:12px; white-space:pre-wrap; }
    #mttPdfTranslatePanel .mttPdfTranslateFailure { color:#93372d; border-color:#eccfc7; background:#fff4ef;
      overflow:auto; overflow-wrap:anywhere; max-height:25%; min-height:0; flex:0 1 auto; }
    #mttPdfTranslatePanel .mttPdfTranslateBody { overflow:auto; flex:1; min-height:0; padding:3px 14px 24px;
      overscroll-behavior:contain; overflow-wrap:anywhere; scrollbar-width:thin; scrollbar-color:#c9d4cc transparent; }
    #mttPdfTranslatePanel .mttPdfTranslateBlock { --mttPdfSectionRgb:59,130,246; margin:0 0 10px; padding:12px 13px;
      border:1px solid rgba(var(--mttPdfSectionRgb),.11); border-radius:11px;
      background:rgba(var(--mttPdfSectionRgb),.035); }
    #mttPdfTranslatePanel .mttPdfTranslateParagraph { text-align:start; }
    #mttPdfTranslatePanel .mttPdfTranslateBlockText { white-space:inherit; }
    #mttPdfTranslatePanel .mttPdfInlineMath { mix-blend-mode:multiply; }
    #mttPdfTranslatePanel .mttPdfTranslateHeading { margin:22px 0 10px; padding:10px 13px; font-size:17px; font-weight:700;
      letter-spacing:-.35px; line-height:1.55; border-left:3px solid rgba(var(--mttPdfSectionRgb),.55);
      background:rgba(var(--mttPdfSectionRgb),.075); }
    #mttPdfTranslatePanel .mttPdfTranslateHeading:first-child { margin-top:0; }
    #mttPdfTranslatePanel .mttPdfTranslateHeading[data-heading-level="2"] { margin-top:18px; margin-left:4px; font-size:15px; border-left-width:2px; }
    #mttPdfTranslatePanel .mttPdfTranslateHeading[data-heading-level="3"] { margin-top:14px; margin-left:8px; font-size:14px; border-left-width:2px; }
    #mttPdfTranslatePanel .mttPdfTranslateCaption, #mttPdfTranslatePanel .mttPdfTranslateFootnote { font-size:12px; line-height:1.75; color:#68756c;
      background:#f0f3f0; border-color:#e3e9e2; }
    #mttPdfTranslatePanel .mttPdfTranslateFormula, #mttPdfTranslatePanel .mttPdfTranslateTable { background:#fff; padding:12px; border-color:var(--mttPdfLine); }
    #mttPdfTranslatePanel .mttPdfTranslateInteractive { cursor:pointer; border-radius:3px; }
    #mttPdfTranslatePanel[data-linked-hover="true"] .mttPdfTranslateInteractive:hover { background:#f9e8b1; }
    #mttPdfTranslatePanel .mttPdfTranslateSourceActive { background:#f9e8b1; box-shadow:0 0 0 1px #dfbb63;
      border-radius:3px; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
    #mttPdfTranslatePanel .mttPdfTranslateLinkedHover { display:flex; align-items:center; gap:7px; font-size:11px; line-height:1.5; cursor:pointer; }
    #mttPdfTranslatePanel .mttPdfTranslateLinkedHover input { margin:0; width:28px; height:16px; flex:none;
      appearance:none; border:1px solid #b5c3b9; border-radius:20px; background:#d6dfd8; cursor:pointer; }
    #mttPdfTranslatePanel .mttPdfTranslateLinkedHover input::after { content:""; display:block; width:12px; height:12px;
      margin:1px; border-radius:50%; background:#fff; box-shadow:0 1px 3px #26373326; transition:transform .15s; }
    #mttPdfTranslatePanel .mttPdfTranslateLinkedHover input:checked { background:var(--mttPdfAccent); border-color:var(--mttPdfAccent); }
    #mttPdfTranslatePanel .mttPdfTranslateLinkedHover input:checked::after { transform:translateX(12px); }
    #mttPdfTranslatePanel .mttPdfTranslateInteractive:focus-visible { outline:2px solid var(--mttPdfAccent); outline-offset:3px; }
    #mttPdfTranslatePanel .mttPdfTranslateSentence[aria-busy="true"] { background:#e8f2ed; }
    #mttPdfTranslatePanel .mttPdfTranslateSentence[aria-busy="true"]::after { content:""; display:inline-block;
      width:10px; height:10px; margin-left:5px; border:2px solid #b8d6c8; border-top-color:var(--mttPdfAccent);
      border-radius:50%; animation:mttPdfRetrySpin 1s linear infinite; }
    @keyframes mttPdfRetrySpin { to { transform:rotate(360deg); } }
    #mttPdfTranslatePanel .mttPdfTranslateMenu { position:fixed; z-index:200; width:248px; max-width:calc(100vw - 16px);
      padding:6px; border:1px solid #dce5df; border-radius:13px; background:#fff; box-shadow:0 12px 36px #17352826,0 2px 6px #1735280a; }
    #mttPdfTranslatePanel .mttPdfTranslateMenu[hidden] { display:none; }
    #mttPdfTranslatePanel .mttPdfTranslateMenu button { display:flex; justify-content:flex-start; gap:10px; width:100%; text-align:start;
      border:0; padding:10px; border-radius:8px; font-size:12px; }
    #mttPdfTranslatePanel .mttPdfTranslateMenu button .mttPdfTranslateIcon { color:#73877a; }
    #mttPdfTranslatePanel .mttPdfTranslateMenu button:not(:disabled):hover,
    #mttPdfTranslatePanel .mttPdfTranslateMenu button:focus-visible { background:#eaf3ed; color:#176b57; }
    #mttPdfTranslatePanel .mttPdfTranslateMenu button:focus-visible { outline:none; box-shadow:inset 0 0 0 2px #147d73; }
    #mttPdfTranslatePanel .mttPdfTranslateMenu button[data-action="restore"] { border-top:1px solid #e8eee8;
      border-radius:0 0 8px 8px; margin-top:4px; padding-top:12px; }
    #mttPdfTranslatePanel .mttPdfTranslatePending { color:#68776d; }
    #mttPdfTranslatePanel .mttPdfTranslateError { color:#a34035; }
    #mttPdfTranslatePanel .mttPdfTranslateNotice { margin-left:2px; font-size:11px; color:#936315; }
    #mttPdfTranslatePanel .mttPdfTranslateNotice:not([hidden])::after { content:"†"; }
    #mttPdfTranslatePanel .mttPdfTranslateFormula, #mttPdfTranslatePanel .mttPdfTranslateTable { font-family:ui-monospace,monospace; white-space:pre-wrap; }
    #mttPdfTranslatePanel .mttPdfTranslateResize { position:absolute; left:-5px; top:0; bottom:0; width:10px;
      z-index:1; cursor:col-resize; touch-action:none; user-select:none; }
    #mttPdfTranslatePanel .mttPdfTranslateResize::after { content:""; position:absolute; left:4px; top:0; bottom:0;
      width:1px; background:var(--mttPdfLine); }
    #mttPdfTranslatePanel .mttPdfTranslateResize:hover::after,
    #mttPdfTranslatePanel .mttPdfTranslateResize:focus-visible::after,
    html.mttPdfTranslateResizing #mttPdfTranslatePanel .mttPdfTranslateResize::after { width:3px; background:var(--mttPdfAccent); }
    #mttPdfTranslatePanel .mttPdfTranslateResize:focus-visible { outline:2px solid var(--mttPdfAccent); outline-offset:-3px; }
    html.mttPdfTranslateResizing, html.mttPdfTranslateResizing * { user-select:none !important; cursor:col-resize !important; }
    #mttPdfTranslateToggle { width:auto; min-width:36px; padding:0 7px; font:12px system-ui,sans-serif; }
    #mttPdfTranslateToggle::before { content:none; }
    @media (prefers-reduced-motion:reduce) {
      #mttPdfTranslatePanel button, #mttPdfTranslatePanel input::after { transition:none; }
      #mttPdfTranslatePanel .mttPdfTranslateSentence[aria-busy="true"]::after { animation:none; }
    }
    @media (forced-colors:active) {
      #mttPdfTranslatePanel .mttPdfTranslateLinkedHover input { appearance:auto; }
      #mttPdfTranslatePanel .mttPdfTranslateLinkedHover input::after { display:none; }
      #mttPdfTranslatePanel .mttPdfTranslateSourceActive { outline:1px solid Highlight; }
      #mttPdfTranslatePanel .mttPdfTranslateMenu button:focus-visible { outline:2px solid Highlight; outline-offset:-2px; }
    }
    @media (max-width:650px) {
      html.mttPdfTranslateOpen #outerContainer { width:100%; }
      #mttPdfTranslatePanel { box-shadow:-4px 0 16px #0002; }
    }
    @media print {
      #mttPdfTranslatePanel, #mttPdfTranslateToggle { display:none !important; }
      html.mttPdfTranslateOpen #outerContainer { width:100%; }
    }
  `;
  doc.head.append(style);

  const panel = make("aside");
  panel.id = "mttPdfTranslatePanel";
  panel.dataset.linkedHover = String(linkedHoverEnabled);
  panel.dataset.mtt = "pdf-translation";
  panel.setAttribute("aria-label", text("PDF_Translation", "PDF 번역"));
  const header = make("div", "mttPdfTranslateHeader");
  const brand = make("span", "mttPdfTranslateBrand");
  brand.setAttribute("aria-hidden", "true");
  brand.append(icon("M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Zm0 0v14M6 9h3m-3 4h3m6-4h3m-3 4h3"));
  const title = make("h2", "", text("PDF_Translation", "PDF 번역"));
  const settings = make("div", "mttPdfTranslateSettings");
  settings.id = "mttPdfTranslateSettings";
  settings.hidden = true;
  const settingsButton = button(text("PDF_Translation_Settings", "설정"), () => setSettingsOpen(settings.hidden), "mttPdfTranslateSettingsToggle");
  settingsButton.setAttribute("aria-controls", settings.id);
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.prepend(icon("M4 7h9m4 0h3M4 17h3m4 0h9M13 4v6M7 14v6"));
  const closeButton = button("×", () => close(), "mttPdfTranslateClose");
  closeButton.setAttribute("aria-label", text("PDF_Translation_Close", "번역 패널 닫기"));
  closeButton.title = closeButton.getAttribute("aria-label");
  header.append(brand, title, settingsButton, closeButton);

  const controls = make("div", "mttPdfTranslateControls");
  const pageButton = button(text("PDF_Translate_Page", "이 페이지 번역"), () => onTranslatePage?.(currentPage), "mttPdfTranslatePrimary");
  const allButton = button(text("PDF_Translate_All", "전체 번역"), () => onTranslateAll?.());
  pageButton.prepend(icon("M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h5"));
  allButton.prepend(icon("M8 3h11v14H8ZM5 7H3v14h11v-2"));
  const stopButton = button(text("PDF_Translation_Stop", "중지"), () => onStop?.(), "mttPdfTranslateStop");
  stopButton.prepend(icon("M6 6h12v12H6Z"));
  controls.append(pageButton, allButton, stopButton);

  const orderRow = make("label", "mttPdfTranslateOrder", text("PDF_Reading_Order", "읽기 순서"));
  const orderSelect = make("select");
  orderSelect.setAttribute("aria-label", text("PDF_Reading_Order", "읽기 순서"));
  for (const [value, key, fallback] of [
    ["auto", "PDF_Layout_Auto", "자동"],
    ["single", "PDF_Layout_Single", "한 단"],
    ["two", "PDF_Layout_Two", "두 단"],
  ]) {
    const option = make("option", "", text(key, fallback));
    option.value = value;
    orderSelect.append(option);
  }
  orderSelect.addEventListener("change", () => {
    currentMode = orderSelect.value;
    onModeChange?.(currentMode, currentPage);
  }, { signal: listeners.signal });
  orderRow.append(orderSelect);
  const linkedHoverRow = make("label", "mttPdfTranslateLinkedHover");
  const linkedHoverInput = make("input");
  linkedHoverInput.type = "checkbox";
  linkedHoverInput.checked = linkedHoverEnabled;
  linkedHoverInput.addEventListener("change", () => {
    setLinkedHoverEnabled(linkedHoverInput.checked);
    onLinkedHoverChange?.(linkedHoverEnabled);
  }, { signal: listeners.signal });
  linkedHoverRow.append(linkedHoverInput, doc.createTextNode(text("PDF_Linked_Hover", "원문·번역 연결 강조")));
  const sourceVariableRow = make("label", "mttPdfTranslateLinkedHover mttPdfTranslateSourceVariables");
  const sourceVariableInput = make("input"); sourceVariableInput.type = "checkbox";
  sourceVariableInput.checked = !!sourceVariableTooltip;
  sourceVariableInput.addEventListener("change", () => onSourceVariableTooltipChange?.(sourceVariableInput.checked), { signal: listeners.signal });
  sourceVariableRow.append(sourceVariableInput, doc.createTextNode(text("PDF_Source_Variable_Tooltip", "원본 PDF 변수 설명")));
  const layoutRow = make("label", "mttPdfTranslateLinkedHover mttPdfTranslateLayoutOverlay");
  const layoutInput = make("input");
  layoutInput.type = "checkbox";
  layoutInput.checked = !!layoutOverlay;
  layoutRow.title = text("PDF_Show_Docling_Regions_Help", "Docling의 원래 영역 경계와 분류를 표시합니다. 번역에서 제외된 영역도 포함합니다.");
  layoutInput.addEventListener("change", () => onLayoutOverlayChange?.(layoutInput.checked), { signal: listeners.signal });
  layoutRow.append(layoutInput, doc.createTextNode(text("PDF_Show_Docling_Regions", "Docling 영역 표시")));
  const editLayoutButton = button(text("PDF_Region_Edit_Mode", "영역 수정"), () => {
    setLayoutEditing(!layoutEditing); onLayoutEditingChange?.(layoutEditing);
  });
  editLayoutButton.id = "mttPdfLayoutEditToggle";
  editLayoutButton.setAttribute("aria-pressed", "false");
  const status = make("p", "mttPdfTranslateStatus", text("PDF_Translation_Idle", "현재 페이지를 번역하거나 전체 번역을 시작하세요."));
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const progress = make("p", "mttPdfTranslateProgress");
  const footer = make("div", "mttPdfTranslateFooter");
  status.title = status.textContent;
  footer.append(status, progress);
  const warnings = make("div", "mttPdfTranslateWarnings");
  warnings.hidden = true;
  const failure = make("div", "mttPdfTranslateWarnings mttPdfTranslateFailure");
  failure.hidden = true;
  failure.setAttribute("role", "alert");
  const body = make("div", "mttPdfTranslateBody");
  const resizeHandle = make("div", "mttPdfTranslateResize");
  resizeHandle.setAttribute("role", "separator");
  resizeHandle.tabIndex = 0;
  resizeHandle.setAttribute("aria-orientation", "vertical");
  resizeHandle.setAttribute("aria-label", text("PDF_Translation_Resize", "번역 패널 너비 조절 (좌우 화살표 키)"));
  resizeHandle.title = resizeHandle.getAttribute("aria-label");
  resizeHandle.setAttribute("aria-controls", panel.id);
  resizeHandle.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight");
  settings.append(orderRow, linkedHoverRow, sourceVariableRow, layoutRow, editLayoutButton);
  panel.append(header, controls, settings, warnings, failure, body, footer, resizeHandle);
  const menu = make("div", "mttPdfTranslateMenu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", text("PDF_Retranslate_Sentence", "다시 번역"));
  const menuButtons = [];
  for (const [mode, key, label, path] of [
    ["standard", "PDF_Retranslate_Sentence", "다시 번역", "M20 7v5h-5M4 17v-5h5m-4-4a8 8 0 0 1 13-2l2 2M4 16l2 2a8 8 0 0 0 13-2"],
    ["reduced", "PDF_Retranslate_Reduced_Context", "문맥을 줄여서 번역", "M4 6h16M4 12h10M4 18h6m7-1h5"],
    ["none", "PDF_Retranslate_Without_Context", "문맥 없이 번역", "M7 5H4v14h3M17 5h3v14h-3M9 12h6"],
    ["restore", "PDF_Restore_Previous_Translation", "이전 번역으로 되돌리기", "m9 5-5 5 5 5m-5-5h10a6 6 0 0 1 0 12"],
  ]) {
    const item = button(text(key, label), () => {
      const record = menuRecord;
      if (item.disabled || !record?.row.isConnected || record.pageNumber !== currentPage) return;
      closeMenu(true);
      if (mode === "restore") onRestoreSentence?.(record.block, record.pageNumber);
      else onRetranslateSentence?.(record.block, record.pageNumber, mode);
    });
    item.dataset.action = mode;
    item.prepend(icon(path));
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    menuButtons.push(item); menu.append(item);
  }
  panel.append(menu);
  function closeMenu(focus = false) {
    const record = menuRecord;
    menu.hidden = true; menuRecord = null;
    if (focus && record?.row.isConnected) record.row.focus({ preventScroll: true });
    else if (record && activePreview === record) { activePreview = null; onLeaveSentence?.(); }
  }
  function refreshMenu() {
    for (const item of menuButtons) item.disabled = busy || layoutEditing || (item.dataset.action === "restore"
      ? !onRestoreSentence || menuRecord?.result?.previousTranslation?.status !== "done" || !menuRecord?.result?.previousTranslation?.text
      : !onRetranslateSentence);
  }
  const canRetry = (block) => block.unitType === "sentence" || block.kind === "heading";
  function openMenu(record, event) {
    if (!canRetry(record.block) || !onRetranslateSentence || destroyed ||
        !record.row.isConnected || record.pageNumber !== currentPage) return;
    event.preventDefault(); event.stopPropagation();
    menuRecord = record;
    menu.hidden = false;
    refreshMenu();
    const rect = record.row.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const x = event.clientX || rect.left, y = event.clientY || rect.bottom;
    menu.style.left = `${Math.max(8, Math.min(x, win.innerWidth - size.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, win.innerHeight - size.height - 8))}px`;
    menuButtons.find((item) => !item.disabled)?.focus({ preventScroll: true });
  }
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (event.key === "Tab") { closeMenu(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const enabled = menuButtons.filter((item) => !item.disabled);
    if (!enabled.length) return;
    const current = enabled.indexOf(doc.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 :
      (current + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
    enabled[next].focus({ preventScroll: true });
  }, { signal: listeners.signal });
  doc.addEventListener("pointerdown", (event) => { if (!menu.contains(event.target)) closeMenu(false); },
    { signal: listeners.signal, capture: true });
  body.addEventListener("scroll", () => closeMenu(false), { signal: listeners.signal });
  body.addEventListener("contextmenu", (event) => {
    const paragraph = event.target.closest?.(".mttPdfTranslateBlock");
    if (!paragraph) return;
    let nearest, distance = Infinity;
    for (const record of rows.values()) {
      if (!canRetry(record.block) || !paragraph.contains(record.row)) continue;
      for (const rect of record.row.getClientRects()) {
        const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right);
        const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom);
        const next = dx * dx + dy * dy;
        if (next < distance) { nearest = record; distance = next; }
      }
    }
    if (nearest) openMenu(nearest, event);
  }, { signal: listeners.signal });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      if (!menu.hidden) { event.preventDefault(); closeMenu(true); }
      else if (!settings.hidden) { event.preventDefault(); setSettingsOpen(false); settingsButton.focus(); }
      else close();
    }
  }, { signal: listeners.signal });
  doc.body.append(panel);

  const toggle = button(text("PDF_Translation", "PDF 번역"), () => panel.hidden ? open() : close(), "toolbarButton");
  toggle.id = "mttPdfTranslateToggle";
  toggle.setAttribute("aria-controls", panel.id);
  (doc.getElementById("toolbarViewerRight") || doc.getElementById("toolbarViewer") || doc.body).prepend(toggle);

  function refreshButtons() {
    pageButton.disabled = allButton.disabled = busy || layoutEditing;
    stopButton.disabled = !busy;
    stopButton.hidden = !busy;
    orderSelect.disabled = busy || layoutEditing;
    editLayoutButton.disabled = busy || !layoutEditable;
    panel.setAttribute("aria-busy", String(busy));
    refreshMenu();
  }
  function setSettingsOpen(value) {
    if (!value && settings.contains(doc.activeElement)) settingsButton.focus();
    settings.hidden = !value;
    settingsButton.setAttribute("aria-expanded", String(!!value));
  }
  function setLayoutEditing(value) {
    const hadFocus = doc.activeElement === editLayoutButton;
    layoutEditing = !!value;
    editLayoutButton.textContent = layoutEditing ? text("PDF_Region_Apply", "수정 적용") : text("PDF_Region_Edit_Mode", "영역 수정");
    editLayoutButton.setAttribute("aria-pressed", String(layoutEditing));
    // Keep Apply reachable even when the settings are collapsed.
    const editParent = layoutEditing ? controls : settings;
    if (editLayoutButton.parentNode !== editParent) editParent.append(editLayoutButton);
    if (hadFocus) (!layoutEditing && settings.hidden ? settingsButton : editLayoutButton).focus();
    body.inert = layoutEditing;
    if (layoutEditing) closeMenu(false);
    refreshButtons();
  }
  function resize() { win.dispatchEvent(new win.Event("resize")); }
  function applySize() {
    const maxWidth = win.innerWidth * 0.85;
    const minWidth = Math.min(260, maxWidth);
    const clamp = (value, min, max) => Math.min(max, Math.max(Math.min(min, max), value));
    panelSize = {
      width: clamp(preferredSize.width ?? Math.min(400, win.innerWidth * 0.45), minWidth, maxWidth),
      height: win.innerHeight,
    };
    panel.style.width = `${panelSize.width}px`;
    panel.style.height = `${panelSize.height}px`;
    resizeHandle.setAttribute("aria-valuemin", String(minWidth));
    resizeHandle.setAttribute("aria-valuemax", String(maxWidth));
    resizeHandle.setAttribute("aria-valuenow", String(panelSize.width));
    doc.documentElement.style.setProperty("--mttPdfTranslateWidth", `${panelSize.width}px`);
  }
  function saveSize() {
    try { win.localStorage.setItem(sizeKey, JSON.stringify({ width: panelSize.width })); } catch (_) {}
  }
  function finishResize(event) {
    if (!drag || (event?.pointerId != null && event.pointerId !== drag.pointerId)) return;
    try { resizeHandle.releasePointerCapture?.(drag.pointerId); } catch (_) {}
    drag = null;
    doc.documentElement.classList.remove("mttPdfTranslateResizing");
    saveSize();
  }
  resizeHandle.addEventListener("pointerdown", (event) => {
    if (drag || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { x: event.clientX, width: panelSize.width, pointerId: event.pointerId };
    resizeHandle.focus({ preventScroll: true });
    doc.documentElement.classList.add("mttPdfTranslateResizing");
    try { resizeHandle.setPointerCapture?.(event.pointerId); } catch (_) {}
  }, { signal: listeners.signal });
  win.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    preferredSize = { width: drag.width + drag.x - event.clientX };
    applySize();
    resize();
  }, { signal: listeners.signal });
  for (const event of ["pointerup", "pointercancel", "blur"]) {
    win.addEventListener(event, finishResize, { signal: listeners.signal });
  }
  win.addEventListener("resize", () => {
    closeMenu(false);
    const before = panelSize;
    applySize();
    if (before && (before.width !== panelSize.width || before.height !== panelSize.height)) resize();
  }, { signal: listeners.signal });
  resizeHandle.addEventListener("keydown", (event) => {
    const delta = { ArrowLeft: 16, ArrowRight: -16 }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    preferredSize = { width: panelSize.width + delta * (event.shiftKey ? 3 : 1) };
    applySize();
    saveSize();
    resize();
  }, { signal: listeners.signal });
  function open() {
    if (destroyed) return;
    panel.hidden = false;
    doc.documentElement.classList.add("mttPdfTranslateOpen");
    toggle.setAttribute("aria-expanded", "true");
    resize();
  }
  function close() {
    if (destroyed) return;
    if (layoutEditing) { setLayoutEditing(false); onLayoutEditingChange?.(false); }
    finishResize();
    closeMenu(false);
    activePreview = null;
    clearSentenceHighlight();
    onLeaveSentence?.();
    hideVisualTooltip?.();
    panel.hidden = true;
    doc.documentElement.classList.remove("mttPdfTranslateOpen");
    toggle.setAttribute("aria-expanded", "false");
    resize();
  }
  function reconcile(parent, children) {
    children.forEach((child, index) => {
      if (parent.childNodes[index] !== child) parent.insertBefore(child, parent.childNodes[index] || null);
    });
    while (parent.childNodes.length > children.length) parent.lastChild.remove();
  }
  function clearSentenceHighlight() {
    if (sourceHighlightId) rows.get(sourceHighlightId)?.row.classList.remove("mttPdfTranslateSourceActive");
    sourceHighlightId = null;
  }
  function setLinkedHoverEnabled(enabled) {
    linkedHoverEnabled = !!enabled;
    panel.dataset.linkedHover = String(linkedHoverEnabled);
    linkedHoverInput.checked = linkedHoverEnabled;
    if (!linkedHoverEnabled) {
      clearSentenceHighlight(); activePreview = null; onLeaveSentence?.();
    }
  }
  function showPage({ pageNumber, blocks = [], translations = {}, warnings: messages = [], mode = "auto" }) {
    if (destroyed) return;
    const previousScroll = body.scrollTop;
    const changedPage = currentPage !== pageNumber;
    if (changedPage) clearSentenceHighlight();
    if (changedPage) closeMenu(false);
    if (changedPage && activePreview) onLeaveSentence?.();
    if (changedPage) activePreview = null;
    currentPage = pageNumber;
    currentMode = mode === "structured" ? "auto" : mode;
    orderSelect.value = currentMode;
    title.textContent = `${text("PDF_Translation", "PDF 번역")} · ${currentPage} ${text("PDF_Translation_Page", "페이지")}`;
    title.title = title.textContent;
    warnings.textContent = (Array.isArray(messages) ? messages : [messages]).filter(Boolean).join("\n");
    warnings.hidden = !warnings.textContent;
    const activeIds = new Set();
    const groups = new Map();
    const sections = getDisplaySections([{ pageNumber, blocks }]);
    let previousGroupId = null, currentGroupId = "";
    blocks.forEach((block) => {
      activeIds.add(block.id);
      let record = rows.get(block.id);
      if (!record) {
        const row = make("span", "mttPdfTranslateSentence");
        row.dataset.blockId = block.id;
        const content = make("span", "mttPdfTranslateBlockText");
        const notice = make("span", "mttPdfTranslateNotice");
        notice.setAttribute("role", "note");
        record = { row, content, notice, block, pageNumber, space: doc.createTextNode(" ") };
        row.addEventListener("contextmenu", (event) => openMenu(record, event), { signal: listeners.signal });
        const valid = () => !destroyed && row.isConnected && record.pageNumber === currentPage;
        const hover = () => { if (valid() && linkedHoverEnabled) { activePreview = record; onHoverSentence?.(record.block, currentPage); } };
        const leave = () => {
          if (menuRecord === record) return;
          if (activePreview === record) { activePreview = null; onLeaveSentence?.(); }
        };
        const navigate = () => { if (valid()) onJumpToBlock?.(record.block, currentPage); };
        if (onJumpToBlock || onHoverSentence || onRetranslateSentence) {
          row.classList.add("mttPdfTranslateInteractive");
          row.tabIndex = 0;
          row.setAttribute("role", "link");
          row.addEventListener("mouseenter", hover, { signal: listeners.signal });
          row.addEventListener("mouseleave", leave, { signal: listeners.signal });
          row.addEventListener("focus", hover, { signal: listeners.signal });
          row.addEventListener("blur", leave, { signal: listeners.signal });
          row.addEventListener("click", () => {
            const selection = doc.getSelection();
            if (selection && !selection.isCollapsed && Array.from({ length: selection.rangeCount }, (_, i) =>
              selection.getRangeAt(i)).some((range) => range.intersectsNode(row))) return;
            navigate();
          }, { signal: listeners.signal });
          row.addEventListener("keydown", (event) => {
            if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") { openMenu(record, event); return; }
            if (!["Enter", " "].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation(); navigate();
          }, { signal: listeners.signal });
        }
        row.append(content, notice);
        rows.set(block.id, record);
      }
      record.block = block;
      record.pageNumber = pageNumber;
      record.row.classList.toggle("mttPdfTranslateSourceActive", sourceHighlightId === block.id);
      if (onRetranslateSentence && canRetry(block)) record.row.setAttribute("aria-haspopup", "menu");
      else record.row.removeAttribute("aria-haspopup");
      const result = translations instanceof Map ? translations.get(block.id) : translations[block.id];
      record.result = result;
      record.row.setAttribute("aria-busy", String(!!result?.retranslating));
      record.notice.hidden = !result?.notice;
      record.notice.setAttribute("aria-label", result?.notice || "");
      record.notice.title = result?.notice || "";
      record.row.title = [onJumpToBlock || onHoverSentence
        ? text("PDF_Sentence_Interaction_Help", "마우스를 올리면 원문 강조 · 클릭하면 원문으로 이동") : "",
        onRetranslateSentence && canRetry(block)
          ? text("PDF_Sentence_Retry_Help", "우클릭하여 재번역하거나 이전 번역으로 되돌리기") : "", result?.notice,
        result?.status === "error" ? result.error : ""].filter(Boolean).join("\n");
      record.content.className = "mttPdfTranslateBlockText";
      let displayed;
      let rich = false;
      const translated = typeof result === "string" ? result : result?.text;
      if (block.visualRegion && renderVisual) {
        rich = true;
        renderVisual(record.content, block);
      } else if (block.inlineMath?.length && translated && renderInlineMath && validMathTranslation(translated, block)) {
        rich = true;
        renderInlineMath(record.content, block, translated);
      } else if (["formula", "table"].includes(block.kind)) {
        displayed = block.text;
      } else if (typeof result === "string" || result?.text) {
        displayed = typeof result === "string" ? result : result.text;
      } else if (result?.status === "error") {
        displayed = result.error || text("PDF_Translation_Error", "문장을 번역하지 못했습니다. 이 페이지 번역을 눌러 다시 시도하세요.");
        record.content.classList.add("mttPdfTranslateError");
      } else {
        displayed = result?.status === "running" || result?.status === "translating"
          ? text("PDF_Translation_Running", "번역 중…") : text("PDF_Translation_Pending", "번역 대기 중");
        record.content.classList.add("mttPdfTranslatePending");
      }
      if (!rich) {
        releaseVisual?.(record.content);
        if (record.content.textContent !== displayed) record.content.textContent = displayed;
      }
      const groupId = block.displayParagraphId || `${block.kind}:${block.sourceBlockIds?.[0] || block.id.replace(/-s\d+$/, "")}`;
      if (previousGroupId !== groupId) {
        currentGroupId = groups.has(groupId) ? `${groupId}:${block.id}` : groupId;
        previousGroupId = groupId;
      }
      if (!groups.has(currentGroupId)) groups.set(currentGroupId, { kind: block.kind, records: [] });
      groups.get(currentGroupId).records.push(record);
    });
    for (const [id, record] of rows) {
      if (!activeIds.has(id)) {
        if (menuRecord === record) closeMenu(false);
        if (activePreview === record) { activePreview = null; onLeaveSentence?.(); }
        releaseVisual?.(record.content); record.row.remove(); rows.delete(id);
      }
    }
    const containers = [];
    for (const [id, group] of groups) {
      let paragraph = paragraphs.get(id);
      if (!paragraph || paragraph.kind !== group.kind) {
        paragraph?.node.remove();
        const tag = group.kind === "heading" ? "h3" : ["formula", "table"].includes(group.kind) ? "pre" : "p";
        const kind = group.kind ? group.kind[0].toUpperCase() + group.kind.slice(1) : "Paragraph";
        paragraph = { node: make(tag, `mttPdfTranslateBlock mttPdfTranslate${kind}`), kind: group.kind };
        paragraph.node.dataset.paragraphId = id;
        paragraphs.set(id, paragraph);
      }
      const first = group.records[0].block, section = first.displaySection || sections.get(first.id);
      const colors = ['59,130,246', '13,148,136', '139,92,246', '180,120,32'];
      paragraph.node.style.setProperty('--mttPdfSectionRgb', colors[(section?.color || 0) % colors.length]);
      paragraph.node.dataset.sectionId = section?.id || '';
      if (group.kind === 'heading') {
        paragraph.node.dataset.headingLevel = section?.level ? String(Math.min(3, section.level)) : 'unknown';
        paragraph.node.setAttribute('aria-level', String(Math.min(6, 2 + (section?.level || 1))));
      }
      reconcile(paragraph.node, group.records.flatMap((record, index) => index ? [record.space, record.row] : [record.row]));
      containers.push(paragraph.node);
    }
    for (const [id, paragraph] of paragraphs) if (!groups.has(id)) { paragraph.node.remove(); paragraphs.delete(id); }
    if (!blocks.length) body.textContent = text("PDF_Translation_No_Text", "번역할 텍스트가 없습니다. 스캔 PDF에는 OCR이 필요합니다.");
    else reconcile(body, containers);
    body.scrollTop = changedPage ? 0 : previousScroll;
    refreshMenu();
  }

  applySize();
  refreshButtons();
  open();
  return {
    setError(message) { if (!destroyed) { failure.textContent = message || ""; failure.hidden = !message; } },
    setStatus(message) { if (!destroyed) status.title = status.textContent = message || ""; },
    setProgress({ completed, total, indexed, indexTotal } = {}) {
      if (destroyed) return;
      const parts = [];
      if (indexTotal != null) parts.push(`${text("PDF_Translation_Index", "문맥 준비")} ${indexed || 0}/${indexTotal}`);
      if (total != null) parts.push(`${text("PDF_Translation_Progress", "번역")} ${completed || 0}/${total}`);
      progress.textContent = parts.join(" · ");
    },
    showPage,
    highlightSentence(id, pageNumber) {
      if (destroyed || panel.hidden || !linkedHoverEnabled || currentPage !== pageNumber) return false;
      const record = rows.get(id);
      if (!record || record.pageNumber !== pageNumber) { clearSentenceHighlight(); return false; }
      if (sourceHighlightId === id) return true;
      clearSentenceHighlight(); sourceHighlightId = id;
      record.row.classList.add("mttPdfTranslateSourceActive");
      const rect = record.row.getBoundingClientRect(), bounds = body.getBoundingClientRect();
      if (rect.top < bounds.top || rect.bottom > bounds.bottom) body.scrollTop += rect.top - bounds.top - (bounds.height - rect.height) / 2;
      return true;
    },
    clearSentenceHighlight,
    setLinkedHoverEnabled,
    setSourceVariableTooltipEnabled(value) { if (!destroyed) sourceVariableInput.checked = !!value; },
    setLayoutOverlayEnabled(value) { if (!destroyed) layoutInput.checked = !!value; },
    setLayoutEditing(value) { if (!destroyed) setLayoutEditing(value); },
    setLayoutEditable(value) { layoutEditable = !!value; if (!destroyed) refreshButtons(); },
    isOpen: () => !destroyed && !panel.hidden,
    setBusy(value) { busy = !!value; if (busy) closeMenu(false); refreshButtons(); },
    setIndexReady(value) { if (!destroyed) panel.dataset.indexReady = String(!!value); },
    open, close,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      listeners.abort();
      for (const record of rows.values()) releaseVisual?.(record.content);
      hideVisualTooltip?.();
      panel.remove(); toggle.remove(); style.remove(); rows.clear(); paragraphs.clear();
      if (previousWidth) doc.documentElement.style.setProperty("--mttPdfTranslateWidth", previousWidth);
      else doc.documentElement.style.removeProperty("--mttPdfTranslateWidth");
    },
  };
}
