import { createDoclingLayoutClient, validateDoclingLayout } from "../src/pdf/docling_layout";

const documentId = "a".repeat(64), identity = "b".repeat(64);
const copy = (x) => structuredClone(x);
const data = { schema: 1, documentId, identity, cache: "computed", pages: [{ pageNumber: 1, width: 600, height: 800,
  regions: [{ id: 1, label: "text", confidence: 0.95, bbox: { x: 40, y: 100, width: 220, height: 30 },
    cells: [{ x: 40, y: 100, width: 220, height: 10 }] }] }] };
const info = { schema: 1, identity, config: { device: "cpu", batch_size: 1 } };
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => copy(body) });
function setup(overrides = {}) {
  const states = new Map();
  const pdfDocument = { numPages: 1, getData: jest.fn(async () => new Uint8Array([1, 2, 3])) };
  const loadState = jest.fn(async (key) => copy(states.get(key)));
  const saveState = jest.fn(async (key, value) => states.set(key, copy(value)));
  const request = jest.fn().mockResolvedValueOnce(response(info)).mockResolvedValueOnce(response(null, 404)).mockResolvedValueOnce(response(data));
  const dependencies = { pdfDocument, documentId, fetch: request, loadState, saveState, ...overrides };
  return { states, request, pdfDocument, dependencies, load: createDoclingLayoutClient(dependencies) };
}

test("uploads once, reuses memory/browser caches, and never uploads a PDF on a cache hit", async () => {
  const run = setup();
  expect((await run.load()).cache).toBe("computed");
  expect(run.request).toHaveBeenCalledTimes(3);
  expect(run.request.mock.calls[2][1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/pdf" }, credentials: "omit" });
  expect((await run.load()).cache).toBe("memory");
  run.request.mockResolvedValueOnce(response(info));
  expect((await createDoclingLayoutClient(run.dependencies)()).cache).toBe("browser");
  expect(run.request).toHaveBeenCalledTimes(4);
  expect(run.pdfDocument.getData).toHaveBeenCalledTimes(1);
});

test("a server disk hit avoids an upload and its result is cached in the browser", async () => {
  const request = jest.fn().mockResolvedValueOnce(response(info)).mockResolvedValueOnce(response({ ...data, cache: "disk" }));
  const run = setup({ fetch: request });
  expect((await run.load()).cache).toBe("disk");
  expect(run.pdfDocument.getData).not.toHaveBeenCalled();
  expect(run.dependencies.saveState).toHaveBeenCalledTimes(1);
});

test("server/model configuration changes invalidate the old layout, while an offline server can reuse it", async () => {
  const run = setup();
  await run.load();
  run.request.mockRejectedValueOnce(new TypeError("offline"));
  const offline = await createDoclingLayoutClient(run.dependencies)();
  expect(offline.warning).toBe("cached-offline");
  expect(offline.layoutIdentity).toEqual(["docling-native-v1", identity]);
  const nextIdentity = "c".repeat(64);
  run.request.mockResolvedValueOnce(response({ ...info, identity: nextIdentity }))
    .mockResolvedValueOnce(response({ ...data, identity: nextIdentity, cache: "disk" }));
  const changed = await createDoclingLayoutClient(run.dependencies)();
  expect(changed.layoutIdentity).toEqual(["docling-native-v1", nextIdentity]);
  expect(run.dependencies.saveState).toHaveBeenCalledTimes(2);
});

test("failed or invalid responses fall back without persisting bad analysis", async () => {
  const request = jest.fn().mockResolvedValueOnce(response(info)).mockResolvedValueOnce(response({ ...data, documentId: "wrong" }));
  const run = setup({ fetch: request });
  expect(await run.load()).toMatchObject({ pages: [], warning: "unavailable" });
  expect(run.dependencies.saveState).not.toHaveBeenCalled();
  const bad = copy(data); bad.pages[0].regions[0].bbox.width = Infinity;
  expect(() => validateDoclingLayout(bad, documentId, 1)).toThrow();
  expect(() => validateDoclingLayout(data, documentId, 2)).toThrow();
});

test("stopping an in-flight request propagates cancellation instead of switching to the native parser", async () => {
  const controller = new AbortController();
  const request = jest.fn((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
  const run = setup({ fetch: request });
  const pending = run.load({ signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(run.dependencies.saveState).not.toHaveBeenCalled();
});


test("a PDF starts a prepared helper only after the loopback service is unavailable", async () => {
  const ensureService = jest.fn(async () => ({ running: true }));
  const request = jest.fn().mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValueOnce(response(info)).mockResolvedValueOnce(response({ ...data, cache: "disk" }));
  const onStatus = jest.fn();
  const run = setup({ fetch: request, ensureService });
  expect((await run.load({ onStatus })).cache).toBe("disk");
  expect(ensureService).toHaveBeenCalledTimes(1);
  expect(onStatus).toHaveBeenCalledWith("starting");
  expect(run.pdfDocument.getData).not.toHaveBeenCalled();
  const healthy = setup({ ensureService });
  await healthy.load();
  expect(ensureService).toHaveBeenCalledTimes(1);
});

test("turning automatic start off and cached layouts do not launch a helper", async () => {
  const ensureService = jest.fn();
  const offline = jest.fn().mockRejectedValue(new TypeError("offline"));
  const disabled = setup({ fetch: offline, autoStart: false, ensureService });
  expect((await disabled.load()).warning).toBe("unavailable");
  expect(ensureService).not.toHaveBeenCalled();
  const cached = setup({ ensureService });
  await cached.load();
  cached.dependencies.fetch = offline;
  expect((await createDoclingLayoutClient(cached.dependencies)()).warning).toBe("cached-offline");
  expect(ensureService).not.toHaveBeenCalled();
});

test("a missing helper preserves native parsing fallback and cancellation never starts a late request", async () => {
  const ensureService = jest.fn().mockRejectedValue(Object.assign(new Error("Prepare the model"), { code: "DOCLING_MODEL_NOT_READY" }));
  const offline = jest.fn().mockRejectedValue(new TypeError("offline"));
  const run = setup({ fetch: offline, ensureService });
  expect(await run.load()).toMatchObject({ warning: "unavailable", error: "Prepare the model" });
  expect(run.dependencies.saveState).not.toHaveBeenCalled();
  const controller = new AbortController();
  const starting = setup({ fetch: offline, ensureService: async () => controller.abort() });
  await expect(starting.load({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(starting.pdfDocument.getData).not.toHaveBeenCalled();
});
