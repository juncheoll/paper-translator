import { JSDOM } from "jsdom";
import { createPdfRegionEditor } from "../src/pdf/region_editor";
jest.mock("../src/i18n.js", () => ({ getMessage: () => "" }));
const page = { pageNumber: 1 }, region = { label: "caption" };
const settle = () => new Promise(setImmediate);

test("classification changes, exclusion and reset are explicit saved actions", async () => {
  const dom = new JSDOM('<!doctype html><body></body>'), doc = dom.window.document, onSave = jest.fn(async () => {});
  const editor = createPdfRegionEditor({ doc, onSave });
  editor.open(page, region);
  const select = doc.querySelector('select'), form = doc.querySelector('form');
  select.value = 'text'; form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle();
  expect(onSave).toHaveBeenLastCalledWith(page, region, { label: 'text', excluded: false });
  editor.open(page, region); select.value = 'exclude'; form.dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle();
  expect(onSave).toHaveBeenLastCalledWith(page, region, { label: 'caption', excluded: true });
  const edited = { ...region, manual: true }; editor.open(page, edited);
  [...doc.querySelectorAll('button')].find(b => b.textContent === '자동 분류로 복원').click(); await settle();
  expect(onSave).toHaveBeenLastCalledWith(page, edited, null);
  editor.destroy(); dom.window.close();
});

test("cancel does not save and persistence errors keep the dialog available for retry", async () => {
  const dom = new JSDOM('<!doctype html><body></body>'), doc = dom.window.document;
  const onSave = jest.fn(async () => { throw new Error('quota'); });
  const editor = createPdfRegionEditor({ doc, onSave }); editor.open(page, region);
  [...doc.querySelectorAll('button')].find(b => b.textContent === '취소').click();
  expect(onSave).not.toHaveBeenCalled();
  editor.open(page, region); doc.querySelector('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle();
  expect(doc.querySelector('dialog').hasAttribute('open')).toBe(true);
  expect(doc.querySelector('[role=alert]').textContent).toContain('저장하지 못했습니다');
  expect(doc.querySelector('select').disabled).toBe(false);
  editor.destroy(); dom.window.close();
});

test('geometry editing carries the selected classification without saving prematurely', () => {
  const dom = new JSDOM('<!doctype html><body></body>'), doc = dom.window.document;
  const onSave = jest.fn(), onEditGeometry = jest.fn();
  const editor = createPdfRegionEditor({doc,onSave,onEditGeometry}); editor.open(page,region);
  doc.querySelector('select').value='text';
  [...doc.querySelectorAll('button')].find(b=>b.textContent==='경계·분할 수정').click();
  expect(onSave).not.toHaveBeenCalled();
  expect(onEditGeometry).toHaveBeenCalledWith(page,{...region,label:'text',excluded:false});
  expect(doc.querySelector('dialog').open).toBe(false);
  editor.open(page,{...region,manual:true,editAnchor:'original'});
  expect(doc.querySelector('p').textContent).toContain('원래 영역 전체');
  expect([...doc.querySelectorAll('button')].some(b=>b.textContent==='원래 영역으로 복원')).toBe(true);
  editor.destroy(); dom.window.close();
});
