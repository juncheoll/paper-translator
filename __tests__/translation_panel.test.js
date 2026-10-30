import { JSDOM } from "jsdom";
import { createPdfTranslationPanel } from "../src/pdf/translation_panel";

jest.mock("../src/i18n.js", () => ({ getMessage: () => "" }));

let dom;
const previousDocument = global.document;
const previousWindow = global.window;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><head></head><body><div id="outerContainer"><div id="toolbarViewerRight"></div><div id="viewerContainer">Original PDF</div></div></body>', { url: "https://pdf.test/" });
  global.document = dom.window.document;
  global.window = dom.window;
});
afterEach(() => {
  dom.window.close();
  global.document = previousDocument;
  global.window = previousWindow;
});

const findButton = (label) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === label);
const pointer = (target, type, x, y) => target.dispatchEvent(new window.MouseEvent(type, {
  bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y,
}));

const retryUnits = ["one", "two"].map((id) => ({ id, kind: "paragraph", unitType: "sentence", text: `Source ${id}.`, displayParagraphId: "one-paragraph" }));
const retryTranslations = { one: { status: "done", text: "첫 번역" }, two: { status: "done", text: "둘째 번역" } };
const sentenceRow = (id = "one") => document.querySelector(`[data-block-id="${id}"]`);
const menu = () => document.querySelector('[role="menu"]');
const menuAction = (action) => menu().querySelector(`[data-action="${action}"]`);
const contextMenu = (row = sentenceRow()) => row.dispatchEvent(new window.MouseEvent("contextmenu", {
  bubbles: true, cancelable: true, clientX: 900, clientY: 700,
}));

test('request failures remain readable across page renders and can be cleared for a retry', () => {
  const panel=createPdfTranslationPanel();
  const message='API · PDF 임베딩 요청 실패 · http://203.0.113.10:9000/api/embed';
  panel.setError(message);
  const alert=document.querySelector('.mttPdfTranslateFailure');
  expect(alert.getAttribute('role')).toBe('alert'); expect(alert.hidden).toBe(false); expect(alert.textContent).toBe(message);
  panel.showPage({pageNumber:1,blocks:retryUnits,translations:retryTranslations});
  expect(alert.hidden).toBe(false); expect(alert.textContent).toBe(message);
  panel.setError(''); expect(alert.hidden).toBe(true); panel.destroy();
});

test("paragraph boxes share section colors while source heading numbers control visible hierarchy", () => {
  const panel = createPdfTranslationPanel({ onJumpToBlock: jest.fn() });
  const blocks = [{ id: 'h1', kind: 'heading', text: '1 METHOD' }, ...retryUnits,
    { id: 'h2', kind: 'heading', text: '1.2 Model' }, { id: 'p2', kind: 'paragraph', text: 'Next.' },
    { id: 'h3', kind: 'heading', text: '1.2.3 Details' }, { id: 'h4', kind: 'heading', text: '2 EXPERIMENTS' }];
  panel.showPage({ pageNumber: 1, blocks, translations: { ...retryTranslations, h1: '방법', h2: '모델', h3: '세부사항' } });
  const box = id => document.querySelector(`[data-block-id="${id}"]`).parentElement;
  expect(box('h1').dataset.headingLevel).toBe('1'); expect(box('h2').dataset.headingLevel).toBe('2');
  expect(box('h3').getAttribute('aria-level')).toBe('5');
  expect(box('one')).toBe(box('two')); expect(box('p2')).not.toBe(box('one'));
  expect(box('one').style.getPropertyValue('--mttPdfSectionRgb')).toBe(box('p2').style.getPropertyValue('--mttPdfSectionRgb'));
  expect(box('h4').style.getPropertyValue('--mttPdfSectionRgb')).not.toBe(box('h1').style.getPropertyValue('--mttPdfSectionRgb'));
  const row = sentenceRow('one'); panel.showPage({ pageNumber: 2, blocks: [{ ...retryUnits[0],
    displaySection: { id: 'prior-page-section', color: 2, level: 2 } }], translations: retryTranslations });
  expect(sentenceRow('one')).toBe(row); expect(box('one').dataset.sectionId).toBe('prior-page-section');
  expect(box('one').style.getPropertyValue('--mttPdfSectionRgb')).toBe('139,92,246');
  panel.destroy();
});

test("settings start collapsed, preserve values, and keep translation and stop actions outside", () => {
  const onTranslatePage = jest.fn(), onTranslateAll = jest.fn(), onStop = jest.fn(), onModeChange = jest.fn();
  const panel = createPdfTranslationPanel({ onTranslatePage, onTranslateAll, onStop, onModeChange });
  panel.showPage({ pageNumber: 4, blocks: retryUnits, translations: retryTranslations });
  const settings = document.getElementById('mttPdfTranslateSettings'), toggle = findButton('설정');
  expect(settings.hidden).toBe(true); expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-controls')).toBe(settings.id);
  findButton('이 페이지 번역').click(); findButton('전체 번역').click();
  expect(onTranslatePage).toHaveBeenCalledWith(4); expect(onTranslateAll).toHaveBeenCalledTimes(1);
  expect(findButton('중지').hidden).toBe(true);
  toggle.click();
  expect(settings.hidden).toBe(false); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const order = settings.querySelector('select'); order.value = 'two';
  order.dispatchEvent(new window.Event('change', { bubbles: true }));
  const checkbox = settings.querySelector('.mttPdfTranslateLinkedHover input'); checkbox.click();
  toggle.click(); toggle.click();
  expect(order.value).toBe('two'); expect(checkbox.checked).toBe(false);
  expect(onModeChange).toHaveBeenCalledTimes(1); expect(onModeChange).toHaveBeenCalledWith('two', 4);
  toggle.click(); panel.setBusy(true);
  expect(settings.hidden).toBe(true); expect(findButton('중지').hidden).toBe(false);
  expect(settings.contains(findButton('중지'))).toBe(false);
  findButton('중지').click(); expect(onStop).toHaveBeenCalledTimes(1);
  panel.setBusy(false); expect(findButton('중지').hidden).toBe(true);
  panel.destroy();
});

test("Escape closes the settings before the panel and restores focus", () => {
  const panel = createPdfTranslationPanel(), toggle = findButton('설정'); toggle.click();
  const settings = document.getElementById('mttPdfTranslateSettings'), select = settings.querySelector('select');
  select.focus(); select.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(settings.hidden).toBe(true); expect(document.activeElement).toBe(toggle); expect(panel.isOpen()).toBe(true);
  toggle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  expect(panel.isOpen()).toBe(false); panel.destroy();
});

test("Apply remains available outside collapsed settings during region editing", () => {
  const onLayoutEditingChange = jest.fn(), panel = createPdfTranslationPanel({ onLayoutEditingChange });
  const settings = document.getElementById('mttPdfTranslateSettings'), toggle = findButton('설정');
  panel.setLayoutEditable(true); toggle.click();
  const edit = document.getElementById('mttPdfLayoutEditToggle'); edit.click();
  expect(document.querySelector('.mttPdfTranslateControls').contains(edit)).toBe(true);
  toggle.click(); expect(settings.hidden).toBe(true); expect(settings.contains(edit)).toBe(false);
  edit.focus(); edit.click();
  expect(onLayoutEditingChange.mock.calls).toEqual([[true], [false]]);
  expect(settings.contains(edit)).toBe(true); expect(document.activeElement).toBe(toggle);
  panel.setStatus('진행 상태 전체 메시지');
  expect(document.querySelector('.mttPdfTranslateFooter [role="status"]').title).toBe('진행 상태 전체 메시지');
  panel.destroy();
});

test("moving the region edit action preserves keyboard focus and repeated state updates", () => {
  const panel = createPdfTranslationPanel(); panel.setLayoutEditable(true); findButton('설정').click();
  const edit = document.getElementById('mttPdfLayoutEditToggle'); edit.focus(); edit.click();
  expect(document.activeElement).toBe(edit);
  panel.setLayoutEditing(true); expect(document.activeElement).toBe(edit);
  edit.click(); expect(document.activeElement).toBe(edit);
  expect(document.getElementById('mttPdfTranslateSettings').contains(edit)).toBe(true);
  panel.destroy();
});

test("Docling region display defaults off and changes only the independent display preference", () => {
  const onLayoutOverlayChange = jest.fn(), onTranslatePage = jest.fn(), onModeChange = jest.fn();
  const panel = createPdfTranslationPanel({ onLayoutOverlayChange, onTranslatePage, onModeChange });
  const checkbox = document.querySelector('.mttPdfTranslateLayoutOverlay input');
  expect(checkbox.checked).toBe(false);
  checkbox.click(); expect(onLayoutOverlayChange).toHaveBeenLastCalledWith(true);
  panel.setLayoutOverlayEnabled(false); expect(checkbox.checked).toBe(false);
  expect(onLayoutOverlayChange).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.mttPdfTranslateLinkedHover input').checked).toBe(true);
  expect(onTranslatePage).not.toHaveBeenCalled(); expect(onModeChange).not.toHaveBeenCalled();
  panel.destroy();
});

test("region edit mode waits for layout data, suspends translation controls and applies once on exit", () => {
  const onLayoutEditingChange = jest.fn(), panel = createPdfTranslationPanel({ onLayoutEditingChange });
  const toggle = document.getElementById('mttPdfLayoutEditToggle');
  expect(toggle.disabled).toBe(true); panel.setLayoutEditable(true); toggle.click();
  expect(onLayoutEditingChange).toHaveBeenLastCalledWith(true);
  expect(toggle.textContent).toBe('수정 적용');
  expect(findButton('이 페이지 번역').disabled).toBe(true);
  expect(document.querySelector('.mttPdfTranslateBody').inert).toBe(true);
  toggle.click(); expect(onLayoutEditingChange).toHaveBeenLastCalledWith(false);
  expect(findButton('이 페이지 번역').disabled).toBe(false);
  expect(document.querySelector('.mttPdfTranslateBody').inert).toBe(false);
  panel.destroy();
});

test("linked hover defaults on, can be toggled off in both directions, and leaves explicit source navigation available", () => {
  const onHoverSentence = jest.fn(), onLeaveSentence = jest.fn(), onJumpToBlock = jest.fn(), onLinkedHoverChange = jest.fn();
  const panel = createPdfTranslationPanel({ onHoverSentence, onLeaveSentence, onJumpToBlock, onLinkedHoverChange });
  panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: retryTranslations });
  const checkbox = document.querySelector(".mttPdfTranslateLinkedHover input");
  expect(checkbox.checked).toBe(true);
  sentenceRow().dispatchEvent(new window.Event("mouseenter"));
  expect(onHoverSentence).toHaveBeenCalledTimes(1);
  expect(panel.highlightSentence("one", 1)).toBe(true);
  checkbox.click();
  expect(onLinkedHoverChange).toHaveBeenCalledWith(false);
  expect(onLeaveSentence).toHaveBeenCalled();
  expect(document.querySelector(".mttPdfTranslateSourceActive")).toBeNull();
  sentenceRow().dispatchEvent(new window.Event("mouseenter"));
  expect(onHoverSentence).toHaveBeenCalledTimes(1);
  expect(panel.highlightSentence("one", 1)).toBe(false);
  sentenceRow().click(); expect(onJumpToBlock).toHaveBeenCalledWith(retryUnits[0], 1);
  panel.setLinkedHoverEnabled(true);
  expect(checkbox.checked).toBe(true);
  expect(onLinkedHoverChange).toHaveBeenCalledTimes(1);
  expect(panel.highlightSentence("two", 1)).toBe(true);
  panel.destroy();
});

test("reverse highlighting scrolls only the translation body when needed, preserves results, and clears on page change or close", () => {
  const panel = createPdfTranslationPanel();
  panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: retryTranslations });
  const body = document.querySelector(".mttPdfTranslateBody");
  body.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 });
  sentenceRow("two").getBoundingClientRect = () => ({ top: 500, bottom: 530, height: 30 });
  const scrollIntoView = jest.fn(); window.Element.prototype.scrollIntoView = scrollIntoView;
  expect(panel.highlightSentence("two", 1)).toBe(true);
  expect(body.scrollTop).toBe(315);
  expect(document.querySelectorAll(".mttPdfTranslateSourceActive")).toHaveLength(1);
  expect(sentenceRow("two").textContent).toBe("둘째 번역");
  panel.highlightSentence("two", 1); expect(body.scrollTop).toBe(315);
  expect(scrollIntoView).not.toHaveBeenCalled();
  panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: retryTranslations });
  expect(sentenceRow("two").classList.contains("mttPdfTranslateSourceActive")).toBe(true);
  panel.showPage({ pageNumber: 2, blocks: retryUnits, translations: retryTranslations });
  expect(document.querySelector(".mttPdfTranslateSourceActive")).toBeNull();
  expect(panel.highlightSentence("one", 1)).toBe(false);
  panel.highlightSentence("one", 2); panel.close();
  expect(document.querySelector(".mttPdfTranslateSourceActive")).toBeNull();
  expect(panel.highlightSentence("one", 2)).toBe(false);
  panel.destroy();
});

test.each(["standard", "reduced", "none"])("the %s context-menu action targets only the clicked sentence without navigating", (mode) => {
  const onRetranslateSentence = jest.fn(), onJumpToBlock = jest.fn();
  const panel = createPdfTranslationPanel({ onRetranslateSentence, onJumpToBlock });
  panel.showPage({ pageNumber: 4, blocks: retryUnits, translations: retryTranslations });
  expect(contextMenu(sentenceRow("two"))).toBe(false);
  expect(menu().hidden).toBe(false);
  expect(menu().querySelectorAll('[role="menuitem"]')).toHaveLength(4);
  expect(menuAction("restore").disabled).toBe(true);
  menuAction(mode).click();
  expect(onRetranslateSentence).toHaveBeenCalledWith(retryUnits[1], 4, mode);
  expect(onJumpToBlock).not.toHaveBeenCalled();
  expect(menu().hidden).toBe(true);
  expect(document.querySelectorAll(".mttPdfTranslateBody p")).toHaveLength(1);
  expect(sentenceRow().textContent).toBe("첫 번역");
  panel.destroy();
});

test("undo is enabled only for a saved previous translation and emits the sentence-specific restore action", () => {
  const onRestoreSentence = jest.fn();
  const panel = createPdfTranslationPanel({ onRetranslateSentence: jest.fn(), onRestoreSentence });
  panel.showPage({ pageNumber: 2, blocks: retryUnits, translations: {
    ...retryTranslations, one: { status: "done", text: "새 번역", previousTranslation: retryTranslations.one },
  } });
  contextMenu();
  expect(menuAction("restore").disabled).toBe(false);
  menuAction("restore").click();
  expect(onRestoreSentence).toHaveBeenCalledWith(retryUnits[0], 2);
  panel.destroy();
});

test.each(["standard", "reduced", "none", "restore"])("headings expose the %s action including on their box padding", (mode) => {
  const heading = { id: 'heading', kind: 'heading', unitType: 'block', text: '3.2 Expert Parallelism' };
  const onRetranslateSentence = jest.fn(), onRestoreSentence = jest.fn();
  const panel = createPdfTranslationPanel({ onRetranslateSentence, onRestoreSentence });
  panel.showPage({ pageNumber: 4, blocks: [heading, ...retryUnits], translations: {
    ...retryTranslations, heading: { status: 'done', text: '3.2 전문가 병렬화',
      previousTranslation: { status: 'done', text: '이전 제목' } },
  } });
  const row = sentenceRow('heading');
  expect(row.getAttribute('aria-haspopup')).toBe('menu');
  expect(row.title).toContain('우클릭');
  if (mode === 'restore') {
    row.getClientRects = () => [{ left: 10, right: 200, top: 10, bottom: 30 }];
    expect(contextMenu(row.closest('.mttPdfTranslateBlock'))).toBe(false);
  } else expect(contextMenu(row)).toBe(false);
  expect(menu().hidden).toBe(false); expect(menuAction(mode).disabled).toBe(false);
  menuAction(mode).click();
  if (mode === 'restore') expect(onRestoreSentence).toHaveBeenCalledWith(heading, 4);
  else expect(onRetranslateSentence).toHaveBeenCalledWith(heading, 4, mode);
  expect(sentenceRow('one').textContent).toBe('첫 번역'); panel.destroy();
});

test("running retries preserve visible text and disable menu actions while busy", () => {
  const onRetranslateSentence = jest.fn();
  const panel = createPdfTranslationPanel({ onRetranslateSentence });
  panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: {
    ...retryTranslations, one: { ...retryTranslations.one, retranslating: true },
  } });
  panel.setBusy(true); contextMenu();
  expect(sentenceRow().textContent).toBe("첫 번역");
  expect(sentenceRow().getAttribute("aria-busy")).toBe("true");
  expect(Array.from(menu().querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
  menuAction("standard").click(); expect(onRetranslateSentence).not.toHaveBeenCalled();
  panel.setBusy(false); contextMenu(); menuAction("none").click();
  expect(onRetranslateSentence).toHaveBeenCalledTimes(1);
  panel.destroy();
});

test("keyboard menus support navigation and Escape returns to the sentence without closing the panel", () => {
  const panel = createPdfTranslationPanel({ onRetranslateSentence: jest.fn() });
  panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: retryTranslations });
  sentenceRow().focus();
  sentenceRow().dispatchEvent(new window.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
  expect(menu().hidden).toBe(false);
  expect(sentenceRow().getAttribute("aria-haspopup")).toBe("menu");
  expect(document.activeElement).toBe(menuAction("standard"));
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(menuAction("reduced"));
  document.activeElement.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(menu().hidden).toBe(true); expect(document.activeElement).toBe(sentenceRow());
  expect(document.getElementById("mttPdfTranslatePanel").hidden).toBe(false);
  panel.destroy();
});

test("moving focus into the menu keeps a source-page preview until the menu is dismissed", () => {
  let panel;
  const onRetranslateSentence = jest.fn(), onLeaveSentence = jest.fn(() =>
    panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: retryTranslations }));
  panel = createPdfTranslationPanel({ onRetranslateSentence, onHoverSentence: jest.fn(), onLeaveSentence });
  panel.showPage({ pageNumber: 2, blocks: retryUnits, translations: retryTranslations });
  sentenceRow().focus(); contextMenu();
  expect(menu().hidden).toBe(false); expect(onLeaveSentence).not.toHaveBeenCalled();
  sentenceRow().dispatchEvent(new window.Event('mouseleave'));
  expect(menu().hidden).toBe(false); expect(onLeaveSentence).not.toHaveBeenCalled();
  menuAction('reduced').click();
  expect(onRetranslateSentence).toHaveBeenCalledWith(retryUnits[0], 2, 'reduced');
  expect(document.activeElement).toBe(sentenceRow()); expect(onLeaveSentence).not.toHaveBeenCalled();
  contextMenu(); pointer(document.body, 'pointerdown', 0, 0);
  expect(menu().hidden).toBe(true); expect(onLeaveSentence).toHaveBeenCalledTimes(1);
  panel.destroy();
});

test("right-clicking paragraph padding selects the nearest sentence without translating the whole paragraph", () => {
  const onRetranslateSentence = jest.fn(), panel = createPdfTranslationPanel({ onRetranslateSentence });
  panel.showPage({ pageNumber: 3, blocks: retryUnits, translations: retryTranslations });
  sentenceRow('one').getClientRects = () => [{ left: 10, right: 110, top: 10, bottom: 30 }];
  sentenceRow('two').getClientRects = () => [{ left: 10, right: 110, top: 40, bottom: 60 }];
  const paragraph = document.querySelector('.mttPdfTranslateParagraph');
  expect(paragraph.dispatchEvent(new window.MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 5, clientY: 54,
  }))).toBe(false);
  expect(menu().hidden).toBe(false); menuAction('none').click();
  expect(onRetranslateSentence).toHaveBeenCalledWith(retryUnits[1], 3, 'none');
  expect(sentenceRow('one').textContent).toBe('첫 번역'); panel.destroy();
});

test("menus close on outside clicks, scrolling or page changes and visual units retain the native menu", () => {
  const panel = createPdfTranslationPanel({ onRetranslateSentence: jest.fn() });
  panel.showPage({ pageNumber: 1, blocks: retryUnits, translations: retryTranslations });
  contextMenu(); pointer(document.body, "pointerdown", 0, 0); expect(menu().hidden).toBe(true);
  contextMenu(); document.querySelector(".mttPdfTranslateBody").dispatchEvent(new window.Event("scroll")); expect(menu().hidden).toBe(true);
  contextMenu(); panel.showPage({ pageNumber: 2, blocks: retryUnits, translations: retryTranslations }); expect(menu().hidden).toBe(true);
  panel.showPage({ pageNumber: 2, blocks: [{ ...retryUnits[0], kind: "formula", unitType: "block" }] });
  expect(contextMenu()).toBe(true); expect(menu().hidden).toBe(true);
  panel.showPage({ pageNumber: 2, blocks: [{ ...retryUnits[0], kind: "table", unitType: "block" }] });
  expect(contextMenu()).toBe(true); expect(menu().hidden).toBe(true);
  const row = sentenceRow(); panel.destroy();
  expect(contextMenu(row)).toBe(true);
});

test("bottom-left corner resizes both dimensions and retains size after closing or reopening", () => {
  const panel = createPdfTranslationPanel();
  const element = document.getElementById("mttPdfTranslatePanel");
  const handle = element.querySelector(".mttPdfTranslateResize");
  expect(handle.getAttribute("aria-label")).toContain("크기 조절");
  expect(element.style.width).toBe("400px");
  expect(element.style.height).toBe("768px");
  pointer(handle, "pointerdown", 900, 750);
  pointer(window, "pointermove", 600, 500);
  expect(element.style.width).toBe("700px");
  expect(element.style.height).toBe("518px");
  expect(document.documentElement.style.getPropertyValue("--mttPdfTranslateWidth")).toBe("700px");
  expect(document.documentElement.classList.contains("mttPdfTranslateResizing")).toBe(true);
  pointer(window, "pointerup", 600, 500);
  expect(document.documentElement.classList.contains("mttPdfTranslateResizing")).toBe(false);
  panel.close();
  panel.open();
  expect(element.style.width).toBe("700px");
  panel.destroy();
  expect(document.documentElement.style.getPropertyValue("--mttPdfTranslateWidth")).toBe("");
  const reopened = createPdfTranslationPanel();
  expect(document.getElementById("mttPdfTranslatePanel").style.width).toBe("700px");
  expect(document.getElementById("mttPdfTranslatePanel").style.height).toBe("518px");
  reopened.destroy();
});

test("resize is bounded to the viewport and arrow keys resize without triggering viewer shortcuts", () => {
  const panel = createPdfTranslationPanel();
  const element = document.getElementById("mttPdfTranslatePanel");
  const handle = element.querySelector(".mttPdfTranslateResize");
  const viewerKey = jest.fn();
  window.addEventListener("keydown", viewerKey);
  handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  handle.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
  expect(element.style.width).toBe("416px");
  expect(element.style.height).toBe("752px");
  expect(viewerKey).not.toHaveBeenCalled();
  pointer(handle, "pointerdown", 900, 750);
  pointer(window, "pointermove", -2000, -2000);
  expect(parseFloat(element.style.width)).toBeCloseTo(window.innerWidth * 0.85);
  expect(element.style.height).toBe("200px");
  pointer(window, "pointerup", -2000, -2000);
  pointer(handle, "pointerdown", 100, 200);
  pointer(window, "pointermove", 4000, 4000);
  expect(element.style.width).toBe("260px");
  expect(element.style.height).toBe("768px");
  pointer(window, "pointerup", 4000, 4000);
  window.innerWidth = 240;
  window.innerHeight = 150;
  window.dispatchEvent(new window.Event("resize"));
  expect(parseFloat(element.style.width)).toBeCloseTo(204);
  expect(element.style.height).toBe("150px");
  panel.destroy();
});

test("unavailable storage does not block resizing and destroy stops an active drag", () => {
  jest.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  const panel = createPdfTranslationPanel();
  const handle = document.querySelector(".mttPdfTranslateResize");
  pointer(handle, "pointerdown", 900, 750);
  pointer(window, "pointermove", 800, 650);
  panel.destroy();
  pointer(window, "pointermove", 600, 500);
  expect(document.documentElement.classList.contains("mttPdfTranslateResizing")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--mttPdfTranslateWidth")).toBe("");
  expect(document.querySelector("#mttPdfTranslatePanel")).toBeNull();
});

test("viewport clamping notifies an earlier viewer resize listener once with the updated width", () => {
  window.localStorage.setItem("mttPdfTranslationPanelSize", JSON.stringify({ width: 700, height: 500 }));
  const viewerResize = jest.fn(() => document.documentElement.style.getPropertyValue("--mttPdfTranslateWidth"));
  window.addEventListener("resize", viewerResize);
  const panel = createPdfTranslationPanel();
  viewerResize.mockClear();
  window.innerWidth = 400;
  window.dispatchEvent(new window.Event("resize"));
  expect(viewerResize).toHaveBeenCalledTimes(2);
  expect(viewerResize.mock.results.at(-1).value).toBe("340px");
  panel.destroy();
});

test("translation controls follow current page and busy state", () => {
  const onTranslatePage = jest.fn();
  const onTranslateAll = jest.fn();
  const onStop = jest.fn();
  const onModeChange = jest.fn();
  const panel = createPdfTranslationPanel({ onTranslatePage, onTranslateAll, onStop, onModeChange });
  expect(findButton("이 페이지 번역").disabled).toBe(false);
  expect(findButton("중지").disabled).toBe(true);
  panel.showPage({ pageNumber: 3, blocks: [{ id: "p3-b1", text: "Source", kind: "paragraph" }] });
  panel.setIndexReady(true);
  findButton("이 페이지 번역").click();
  findButton("전체 번역").click();
  expect(onTranslatePage).toHaveBeenCalledWith(3);
  expect(onTranslateAll).toHaveBeenCalledTimes(1);
  const select = document.querySelector("#mttPdfTranslatePanel select");
  select.value = "two";
  select.dispatchEvent(new window.Event("change"));
  expect(onModeChange).toHaveBeenCalledWith("two", 3);
  panel.setBusy(true);
  findButton("이 페이지 번역").click();
  expect(onTranslatePage).toHaveBeenCalledTimes(1);
  expect(select.disabled).toBe(true);
  findButton("중지").click();
  expect(onStop).toHaveBeenCalledTimes(1);
  panel.destroy();
});

test("translation can retry preparation after indexing is stopped or fails", () => {
  const onTranslatePage = jest.fn();
  const onTranslateAll = jest.fn();
  const panel = createPdfTranslationPanel({ onTranslatePage, onTranslateAll });
  panel.setBusy(true);
  panel.setIndexReady(false);
  expect(findButton("이 페이지 번역").disabled).toBe(true);
  panel.setStatus("Index preparation failed; try again");
  panel.setBusy(false);
  findButton("이 페이지 번역").click();
  findButton("전체 번역").click();
  expect(onTranslatePage).toHaveBeenCalledWith(1);
  expect(onTranslateAll).toHaveBeenCalledTimes(1);
  expect(document.getElementById("mttPdfTranslatePanel").getAttribute("aria-busy")).toBe("false");
  panel.destroy();
});

test("renders translated text safely, retains order, and preserves formulas", () => {
  const onJumpToBlock = jest.fn();
  const panel = createPdfTranslationPanel({ onJumpToBlock });
  const blocks = [
    { id: "p1-b1", text: "Heading", kind: "heading" },
    { id: "p1-b2", text: "Source paragraph", kind: "paragraph", bbox: { x: 10, y: 20 } },
    { id: "p1-b3", text: "x < y & y > 0", kind: "formula" },
  ];
  panel.showPage({ pageNumber: 1, blocks, translations: {
    "p1-b1": { text: "제목", status: "done" },
    "p1-b2": { text: '<img src="x" onerror="bad()">', status: "done" },
    "p1-b3": { text: "wrong translated formula", status: "done" },
  }, warnings: ["Check the column order"] });
  const rows = Array.from(document.querySelectorAll(".mttPdfTranslateSentence"));
  expect(rows.map((row) => row.dataset.blockId)).toEqual(blocks.map((block) => block.id));
  expect(rows[1].querySelector(".mttPdfTranslateBlockText").textContent).toBe('<img src="x" onerror="bad()">');
  expect(document.querySelector("#mttPdfTranslatePanel img")).toBeNull();
  expect(rows[2].textContent).toContain("x < y & y > 0");
  expect(rows[2].textContent).not.toContain("wrong translated");
  rows[1].click();
  expect(onJumpToBlock).toHaveBeenCalledWith(blocks[1], 1);
  panel.destroy();
});

test("updates a pending block without resetting scroll, and clears old page content", () => {
  const panel = createPdfTranslationPanel();
  const blocks = [{ id: "p1-b1", text: "Source", kind: "paragraph" }];
  panel.showPage({ pageNumber: 1, blocks });
  const body = document.querySelector(".mttPdfTranslateBody");
  const row = body.querySelector("p");
  body.scrollTop = 120;
  panel.showPage({ pageNumber: 1, blocks, translations: { "p1-b1": { text: "번역", status: "done" } } });
  expect(body.querySelector("p")).toBe(row);
  expect(body.scrollTop).toBe(120);
  expect(body.textContent).toContain("번역");
  panel.showPage({ pageNumber: 2, blocks: [], warnings: [] });
  expect(body.scrollTop).toBe(0);
  expect(body.querySelector("p")).toBeNull();
  expect(body.textContent).toContain("OCR");
  panel.showPage({ pageNumber: 2, blocks: [{ id: "p2-b1", text: "Second", kind: "paragraph" }], translations: { "p2-b1": { status: "error", error: "Server unavailable" } } });
  expect(body.textContent).toContain("Server unavailable");
  expect(body.textContent).not.toContain("OCR");
  panel.destroy();
});

test("shows original paragraph flow while retaining independent sentence spans, headings and formulas", () => {
  const panel = createPdfTranslationPanel();
  const blocks = [
    { id: "p1-b1", text: "Heading", kind: "heading" },
    { id: "p1-b2-s1", text: "A sentence wraps across PDF lines.", kind: "paragraph", unitType: "sentence" },
    { id: "p1-b2-s2", text: "The following sentence is separate.", kind: "paragraph", unitType: "sentence" },
    { id: "p1-b3", text: "E = mc²", kind: "formula" },
  ];
  panel.showPage({ pageNumber: 1, blocks, translations: {
    "p1-b2-s1": { status: "done", text: "PDF의 여러 줄에 걸친 한 문장입니다." },
    "p1-b2-s2": { status: "running" },
  } });
  const rows = [...document.querySelectorAll(".mttPdfTranslateSentence")];
  expect(rows).toHaveLength(4);
  expect(rows[1].parentElement).toBe(rows[2].parentElement);
  expect(rows[1].parentElement.tagName).toBe("P");
  expect(rows[1].parentElement.textContent).toBe("PDF의 여러 줄에 걸친 한 문장입니다. 번역 중…");
  expect(document.querySelectorAll(".mttPdfTranslateBlock")).toHaveLength(3);
  expect(document.querySelector(".mttPdfTranslateHeading").tagName).toBe("H3");
  expect(document.querySelector(".mttPdfTranslateFormula").textContent).toBe("E = mc²");
  expect(document.querySelector(".mttPdfTranslateBlockHeader")).toBeNull();
  expect(document.querySelector(".mttPdfTranslateBody button")).toBeNull();
  panel.destroy();
});

test("a recovered translation exposes its reduced-context notice and removes stale notices on retry", () => {
  const panel = createPdfTranslationPanel();
  const blocks = [{ id: "sentence", text: "Source", kind: "paragraph", unitType: "sentence" }];
  panel.showPage({ pageNumber: 1, blocks, translations: {
    sentence: { status: "done", text: "번역", notice: "주변 문맥 없이 다시 번역했습니다." },
  } });
  const notice = document.querySelector(".mttPdfTranslateNotice");
  expect(notice.hidden).toBe(false);
  expect(notice.title).toContain("문맥 없이");
  expect(notice.getAttribute("aria-label")).toContain("문맥 없이");
  panel.showPage({ pageNumber: 1, blocks, translations: { sentence: { status: "running" } } });
  expect(notice.hidden).toBe(true);
  expect(notice.textContent).toBe("");
  panel.destroy();
});

test("a spanning sentence hovers and navigates to its source on the currently displayed page", () => {
  const onJumpToBlock = jest.fn();
  const onHoverSentence = jest.fn();
  const onLeaveSentence = jest.fn();
  const panel = createPdfTranslationPanel({ onJumpToBlock, onHoverSentence, onLeaveSentence });
  const unit = { id: "shared", kind: "paragraph", unitType: "sentence", text: "A full sentence.", sourcePageNumbers: [1, 2] };
  panel.showPage({ pageNumber: 2, blocks: [unit] });
  let sentence = document.querySelector(".mttPdfTranslateSentence");
  sentence.dispatchEvent(new window.Event("mouseenter"));
  expect(onHoverSentence).toHaveBeenLastCalledWith(unit, 2);
  expect(onJumpToBlock).not.toHaveBeenCalled();
  sentence.dispatchEvent(new window.Event("mouseleave"));
  expect(onLeaveSentence).toHaveBeenCalledTimes(1);
  sentence.click();
  panel.showPage({ pageNumber: 1, blocks: [unit] });
  sentence = document.querySelector(".mttPdfTranslateSentence");
  sentence.click();
  expect(onJumpToBlock.mock.calls).toEqual([[unit, 2], [unit, 1]]);
  expect(document.querySelector(".mttPdfTranslateBody button")).toBeNull();
  panel.destroy();
});

test("copy selection survives unrelated sentence updates and dragging text does not navigate", () => {
  const onJumpToBlock = jest.fn();
  const panel = createPdfTranslationPanel({ onJumpToBlock });
  const blocks = ["first", "second"].map((id) => ({ id, kind: "paragraph", displayParagraphId: "paragraph" }));
  const translations = { first: { text: "첫 번째 번역입니다.", status: "done" }, second: { status: "running" } };
  panel.showPage({ pageNumber: 1, blocks, translations });
  const sentence = document.querySelector(".mttPdfTranslateSentence");
  const node = sentence.querySelector(".mttPdfTranslateBlockText").firstChild;
  const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 5);
  document.getSelection().addRange(range);
  panel.showPage({ pageNumber: 1, blocks, translations: { ...translations, second: { text: "두 번째 번역입니다.", status: "done" } } });
  expect(document.getSelection().toString()).toBe("첫 번째 ");
  sentence.click();
  expect(onJumpToBlock).not.toHaveBeenCalled();
  document.getSelection().removeAllRanges();
  sentence.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onJumpToBlock).toHaveBeenCalledWith(blocks[0], 1);
  panel.destroy();
});

test("toggle and destroy restore original viewer layout and remove event handlers", () => {
  const onTranslatePage = jest.fn();
  const panel = createPdfTranslationPanel({ onTranslatePage });
  const toggle = document.getElementById("mttPdfTranslateToggle");
  const pageButton = findButton("이 페이지 번역");
  expect(document.documentElement.classList.contains("mttPdfTranslateOpen")).toBe(true);
  toggle.click();
  expect(document.getElementById("mttPdfTranslatePanel").hidden).toBe(true);
  expect(document.documentElement.classList.contains("mttPdfTranslateOpen")).toBe(false);
  toggle.click();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  panel.setStatus("Preparing context");
  panel.setProgress({ indexed: 2, indexTotal: 5, completed: 1, total: 4 });
  expect(document.querySelector("[role=status]").textContent).toBe("Preparing context");
  expect(document.querySelector(".mttPdfTranslateProgress").textContent).toContain("2/5");
  panel.setIndexReady(true);
  panel.destroy();
  pageButton.click();
  expect(onTranslatePage).not.toHaveBeenCalled();
  expect(document.querySelector("#mttPdfTranslatePanel,#mttPdfTranslateToggle,#mttPdfTranslateStyle")).toBeNull();
  expect(document.documentElement.classList.contains("mttPdfTranslateOpen")).toBe(false);
  expect(document.getElementById("viewerContainer").textContent).toBe("Original PDF");
});

test('visual source blocks use the renderer instead of flattened or translated cell text',()=>{
 const renderVisual=jest.fn((container,block)=>{if(!container.querySelector('img')){const image=document.createElement('img');image.alt=block.kind;container.append(image);}});
 const releaseVisual=jest.fn(),panel=createPdfTranslationPanel({renderVisual,releaseVisual});
 const blocks=['formula','table'].map(kind=>({id:kind,kind,text:'Flattened source',visualRegion:{pageNumber:1,bbox:{x:1,y:1,width:100,height:30}}}));
 panel.showPage({pageNumber:1,blocks,translations:{table:{status:'done',text:'Wrong translated cells'}}});
 expect(document.querySelectorAll('.mttPdfTranslateBody img')).toHaveLength(2);
 expect(document.querySelector('.mttPdfTranslateBody').textContent).not.toContain('Wrong translated cells');
 const image=document.querySelector('img');panel.showPage({pageNumber:1,blocks});expect(document.querySelector('img')).toBe(image);
 panel.showPage({pageNumber:2,blocks:[]});expect(releaseVisual).toHaveBeenCalledTimes(2);panel.destroy();
});

test('source variable explanations have their own saved-preference checkbox without disabling panel interactions',()=>{
 const onSourceVariableTooltipChange=jest.fn();
 const panel=createPdfTranslationPanel({sourceVariableTooltip:false,onSourceVariableTooltipChange});
 const input=document.querySelector('.mttPdfTranslateSourceVariables input');
 expect(input.checked).toBe(false);expect(input.parentElement.textContent).toContain('원본 PDF 변수 설명');
 input.click();expect(onSourceVariableTooltipChange).toHaveBeenCalledWith(true);
 panel.setSourceVariableTooltipEnabled(false);expect(input.checked).toBe(false);
 expect(onSourceVariableTooltipChange).toHaveBeenCalledTimes(1);
 expect(document.querySelector('.mttPdfTranslateLinkedHover input').checked).toBe(true);
 panel.destroy();
});

test('inline math renderer receives validated translations and keeps sentence/source actions',()=>{
 const renderInlineMath=jest.fn((container)=>{if(!container.querySelector('img'))container.append(document.createElement('img'));});
 const onJumpToBlock=jest.fn(),panel=createPdfTranslationPanel({renderInlineMath,onJumpToBlock});
 const block={id:'inline',kind:'paragraph',unitType:'sentence',text:'Value x.',inlineMath:[{token:'[M1]',text:'x'}]};
 panel.showPage({pageNumber:1,blocks:[block],translations:{inline:{status:'done',text:'값 [M1]'}}});
 const image=document.querySelector('.mttPdfTranslateBody img');expect(image).not.toBeNull();
 expect(renderInlineMath).toHaveBeenCalledWith(expect.anything(),block,'값 [M1]');
 panel.showPage({pageNumber:1,blocks:[block],translations:{inline:{status:'done',text:'값 [M1]'}}});
 expect(document.querySelector('.mttPdfTranslateBody img')).toBe(image);
 document.querySelector('.mttPdfTranslateSentence').click();expect(onJumpToBlock).toHaveBeenCalledWith(block,1);panel.destroy();
});
