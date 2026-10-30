import { loadDocumentState, saveDocumentState } from "./document_index.js";

export const editableRegionLabels = ["text", "section_header", "caption", "picture", "footnote", "table", "formula",
  "title", "list_item", "page_header", "page_footer", "code", "document_index", "checkbox_selected", "checkbox_unselected", "form", "key_value_region"];
const validClass = (edit) => edit && editableRegionLabels.includes(edit.label) && typeof edit.excluded === "boolean";
const validBox = (box) => box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
  box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0;
const validEdit = (edit) => edit && (Array.isArray(edit.parts)
  ? edit.parts.length > 0 && edit.parts.every((part) => validClass(part) && validBox(part.bbox)) : validClass(edit));
const fitsPage = (edit, page) => !edit.parts || edit.parts.every(({ bbox: b }) =>
  b.x + b.width <= page.width + .001 && b.y + b.height <= page.height + .001);

// Region IDs can change between analyses. Anchor corrections to the original PDF page and geometry.
export function regionEditKey(page, region) {
  return region.editAnchor || JSON.stringify([page.pageNumber, ...[page.width, page.height, region.bbox.x, region.bbox.y,
    region.bbox.width, region.bbox.height].map((value) => Math.round(value * 10))]);
}

export function applyRegionEdits(layout, edits = {}) {
  const applied = [];
  const pages = (layout.pages || []).map((page) => {
    const counts = new Map();
    for (const region of page.regions) {
      const key = regionEditKey(page, region);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { ...page, regions: page.regions.flatMap((region) => {
      const key = regionEditKey(page, region), edit = edits[key];
      if (!validEdit(edit) || !fitsPage(edit, page) || counts.get(key) !== 1) return [region];
      if (edit.parts) {
        applied.push([key, edit.parts.map(({ label, excluded, bbox }) => [label, excluded, bbox])]);
        return edit.parts.map((part, index) => ({ ...region, ...part, bbox: { ...part.bbox },
          id: `manual:${key}:${index}`, cells: [], originalLabel: region.label, manual: true,
          editAnchor: key, editPart: index }));
      }
      applied.push([key, edit.label, edit.excluded]);
      return [{ ...region, originalLabel: region.label, label: edit.label, manual: true, excluded: edit.excluded }];
    }) };
  });
  return { ...layout, pages, ...(applied.length ? {
    layoutIdentity: [...(layout.layoutIdentity || []), ["region-edits-v1", applied.sort(([a], [b]) => a.localeCompare(b))]],
  } : {}) };
}

export function createRegionEditStore({ documentId, loadState = loadDocumentState, saveState = saveDocumentState }) {
  const key = `mtt-pdf:${documentId}:region-edits:v1`;
  let edits, loading, writing = false;
  async function load() {
    if (edits) return edits;
    if (!loading) loading = (async () => {
      const saved = await loadState(key);
      edits = saved?.version === 1 && saved.edits && typeof saved.edits === "object"
        ? Object.fromEntries(Object.entries(saved.edits).filter(([, edit]) => validEdit(edit))) : {};
      return edits;
    })().finally(() => { loading = null; });
    return loading;
  }
  return {
    apply: async (layout) => applyRegionEdits(layout, await load()),
    async save(page, region, edit) {
      if (writing) throw new Error("A region correction is already being saved");
      if (edit !== null && (!validEdit(edit) || !fitsPage(edit, page))) throw new Error("Invalid region correction");
      writing = true;
      try {
        await load();
        const previous = { version: 1, edits };
        const updated = { ...edits }, anchor = regionEditKey(page, region);
        if (edit === null) delete updated[anchor];
        else if (region.editAnchor) {
          const parts = edits[anchor]?.parts;
          if (!parts?.[region.editPart]) throw new Error("The original region has changed");
          const replacement = edit.parts || [{ ...parts[region.editPart], label: edit.label, excluded: edit.excluded }];
          updated[anchor] = { parts: [...parts.slice(0, region.editPart), ...replacement, ...parts.slice(region.editPart + 1)] };
        } else updated[anchor] = edit.parts ? { parts: edit.parts.map((part) => ({ label: part.label,
          excluded: part.excluded, bbox: { ...part.bbox } })) } : { label: edit.label, excluded: edit.excluded };
        try {
          if (await saveState(key, { version: 1, edits: updated }) === false) throw new Error("Region correction could not be persisted");
        } catch (error) {
          // saveDocumentState also has an in-memory fallback. Restore it on persistence failure.
          await saveState(key, previous).catch(() => {});
          throw error;
        }
        edits = updated;
      } finally { writing = false; }
    },
  };
}
