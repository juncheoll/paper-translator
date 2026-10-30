import { applyRegionEdits, createRegionEditStore, regionEditKey } from "../src/pdf/layout_edits";

const region = { id: 1, label: "picture", confidence: .5, bbox: { x: 40, y: 100, width: 200, height: 30 }, cells: [] };
const page = { pageNumber: 1, width: 600, height: 800, regions: [region] };
const layout = { pages: [page], layoutIdentity: ["docling-native-v1", "model"] };
function storage() {
  const data = new Map();
  const loadState = async key => structuredClone(data.get(key));
  const saveState = jest.fn(async (key, value) => { data.set(key, structuredClone(value)); return true; });
  return { data, loadState, saveState };
}

test("corrections survive reopening the same PDF and region ID changes, without modifying the raw cache", async () => {
  const db = storage(), store = createRegionEditStore({ documentId: "pdf-a", ...db });
  const before = structuredClone(layout);
  await store.save(page, region, { label: "text", excluded: false });
  const result = await createRegionEditStore({ documentId: "pdf-a", ...db }).apply({ ...layout,
    pages: [{ ...page, regions: [{ ...region, id: 999 }] }] });
  expect(result.pages[0].regions[0]).toMatchObject({ id: 999, label: "text", originalLabel: "picture", manual: true });
  expect(result.layoutIdentity).not.toEqual(layout.layoutIdentity);
  expect(layout).toEqual(before);
  expect((await createRegionEditStore({ documentId: "pdf-b", ...db }).apply(layout)).layoutIdentity).toEqual(layout.layoutIdentity);
});

test("exclusion is persisted and resetting restores the exact automatic cache identity", async () => {
  const db = storage(), store = createRegionEditStore({ documentId: "pdf-a", ...db });
  await store.save(page, region, { label: "picture", excluded: true });
  expect((await store.apply(layout)).pages[0].regions[0].excluded).toBe(true);
  await store.save(page, region, null);
  expect(await store.apply(layout)).toEqual(layout);
  expect(await createRegionEditStore({ documentId: "pdf-a", ...db }).apply(layout)).toEqual(layout);
});

test("failed persistence restores the previous edit in memory and storage", async () => {
  const db = storage(), store = createRegionEditStore({ documentId: "pdf-a", ...db });
  await store.save(page, region, { label: "text", excluded: false });
  db.saveState.mockImplementationOnce(async (key, value) => { db.data.set(key, value); return false; });
  await expect(store.save(page, region, { label: "picture", excluded: true })).rejects.toThrow();
  expect((await store.apply(layout)).pages[0].regions[0]).toMatchObject({ label: "text", excluded: false });
  expect((await createRegionEditStore({ documentId: "pdf-a", ...db }).apply(layout)).pages[0].regions[0].label).toBe("text");
});

test("ambiguous or changed geometry is never edited by an unrelated saved correction", () => {
  const edits = { [regionEditKey(page, region)]: { label: "text", excluded: false } };
  const ambiguous = { ...layout, pages: [{ ...page, regions: [region, { ...region, id: 2 }] }] };
  expect(applyRegionEdits(ambiguous, edits).pages[0].regions.every(r => !r.manual)).toBe(true);
  const changed = { ...layout, pages: [{ ...page, regions: [{ ...region, bbox: { ...region.bbox, y: 200 } }] }] };
  expect(applyRegionEdits(changed, edits).layoutIdentity).toEqual(layout.layoutIdentity);
});

test("resized and split geometry survives reopening, per-part changes and another split", async () => {
  const db = storage(), store = createRegionEditStore({ documentId:'split-pdf', ...db });
  const part = (x, width, label = 'text') => ({ label, excluded:false, bbox:{ x, y:110, width, height:20 } });
  await store.save(page, region, { parts:[part(45,95), part(140,90,'picture')] });
  let result = await createRegionEditStore({ documentId:'split-pdf', ...db }).apply(layout);
  expect(result.pages[0].regions).toHaveLength(2);
  expect(result.pages[0].regions[0]).toMatchObject({ bbox:part(45,95).bbox, cells:[], editPart:0 });
  const identity = result.layoutIdentity;
  await store.save(result.pages[0], result.pages[0].regions[1], { label:'picture', excluded:true });
  result = await store.apply(layout);
  expect(result.pages[0].regions[0].excluded).toBe(false);
  expect(result.pages[0].regions[1].excluded).toBe(true);
  expect(result.layoutIdentity).not.toEqual(identity);
  // Editing a child preserves both its geometry and its independently classified sibling.
  await store.save(result.pages[0], result.pages[0].regions[0], { parts:[part(45,40), part(85,55)] });
  result = await store.apply(layout);
  expect(result.pages[0].regions).toHaveLength(3);
  expect(result.pages[0].regions[2]).toMatchObject({ label:'picture', excluded:true, bbox:part(140,90).bbox });
  const before = structuredClone(result);
  await store.save(result.pages[0], result.pages[0].regions[1], { label:'caption', excluded:false });
  result = await createRegionEditStore({ documentId:'split-pdf', ...db }).apply(layout);
  expect(result.pages[0].regions[1]).toMatchObject({ label:'caption', bbox:before.pages[0].regions[1].bbox });
  await store.save(result.pages[0], result.pages[0].regions[1], null);
  expect(await store.apply(layout)).toEqual(layout);
});

test("invalid geometry cannot overwrite existing corrections; failed split persistence rolls back", async () => {
  const db = storage(), store = createRegionEditStore({ documentId:'split-pdf', ...db });
  await store.save(page, region, { label:'caption', excluded:false });
  for (const bbox of [{ x:-1,y:0,width:10,height:10 }, { x:0,y:0,width:NaN,height:10 },
    { x:0,y:0,width:0,height:10 }, { x:590,y:0,width:20,height:10 }]) {
    await expect(store.save(page, region, { parts:[{ label:'text', excluded:false, bbox }] })).rejects.toThrow();
  }
  db.saveState.mockImplementationOnce(async () => false);
  await expect(store.save(page, region, { parts:[{ label:'text', excluded:false, bbox:region.bbox }] })).rejects.toThrow();
  expect((await store.apply(layout)).pages[0].regions[0].label).toBe('caption');
  expect((await createRegionEditStore({ documentId:'split-pdf', ...db }).apply(layout)).pages[0].regions[0].label).toBe('caption');
});
