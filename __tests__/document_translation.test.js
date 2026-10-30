jest.mock("webextension-polyfill", () => ({ __esModule: true, default: {} }));
jest.mock("../src/settings.js", () => ({ __esModule: true, default: {} }));
jest.mock("../src/i18n.js", () => ({ loadUiLanguage: jest.fn(), getMessage: () => "" }));
jest.mock("../src/pdf/reading_order", () => ({ extractOrderedPage: jest.fn() }), { virtual: true });
jest.mock("../src/pdf/translation_panel", () => ({ createPdfTranslationPanel: jest.fn() }));

import { createPdfTranslationController, splitTranslationText, getDocumentCacheId, makePageReference, fitReferenceContext, formatPdfTranslationError,
  requireLlmEndpoint, ollamaApiUrl, fetchOllamaModelIdentity } from "../src/pdf/document_translation";
import browser from "webextension-polyfill";
import { requestPdfApi } from "../src/pdf/api_client.js";
jest.mock("../src/pdf/api_client.js", () => ({ requestPdfApi: jest.fn() }));
import { requestBrowserAi } from "../src/browser_ai/client.js";
jest.mock("../src/browser_ai/client.js", () => ({ requestBrowserAi: jest.fn() }));

const copy = (value) => value == null ? value : structuredClone(value);
const fixtures = [1, 2, 3].map((n) => ({
  pageNumber: n, width: 600, height: 800, mode: "single", warnings: [],
  blocks: [{ id: `p${n}-b0`, text: `Source paragraph on page ${n}.`, kind: "paragraph", bbox: { x: 10, y: 150, width: 100, height: 20 } }],
}));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected controller state was not reached");
}

function harness({ pages = fixtures, currentPage = 1, states = new Map(), settingChanges = {}, ...overrides } = {}) {
  const rendered = [];
  const panel = Object.fromEntries(["setStatus", "setProgress", "setBusy", "setIndexReady", "destroy"].map((name) => [name, jest.fn()]));
  panel.showPage = jest.fn((page) => rendered.push(copy(page)));
  const readPage = jest.fn(async (page, { mode }) => ({ ...copy(pages.find((item) => item.pageNumber === page.pageNumber)), mode }));
  const embed = jest.fn(async (texts) => texts.map(() => [1, 0]));
  const translate = jest.fn(async (text) => ({ targetText: `Translated ${text}` }));
  const loadState = jest.fn(async (key) => copy(states.get(key)) || null);
  const saveState = jest.fn(async (key, value) => { states.set(key, copy(value)); return true; });
  const settings = { llmApiEndpoint: "http://localhost:11434/v1", llmModel: "hy-mt2:1.8b-q8",
    embeddingExecution: "api", embeddingApiEndpoint: "http://localhost:11434", embeddingApiKey: "", embeddingModel: "embeddinggemma", embeddingApiType: "ollama",
    translateTarget: "ko", llmContextTotalLimit: 0, ...settingChanges };
  const dependencies = { pdfDocument: { numPages: pages.length, getPage: async (n) => ({ pageNumber: n }) },
    panel, settings, documentId: "test-paper", modelIdentity: "model-digest", title: "Paper title",
    getCurrentPage: () => currentPage, readPage, embed, translate, translateBatch: null, loadState, saveState, ...overrides };
  const controller = createPdfTranslationController(dependencies);
  return { controller, panel, rendered, states, ...dependencies };
}

test.each([
  ['http://203.0.113.10:9000/v1', 'http://203.0.113.10:9000/api/embed'],
  ['https://lab.test/ollama/v1/', 'https://lab.test/ollama/api/embed'],
  ['http://localhost:11434/v1', 'http://localhost:11434/api/embed'],
  ['http://[::1]:11434/v1/', 'http://[::1]:11434/api/embed'],
])('PDF Ollama requests follow the configured API endpoint %s', (endpoint, expected) => {
  expect(requireLlmEndpoint(endpoint).protocol).toMatch(/^https?:$/);
  expect(ollamaApiUrl(endpoint, 'embed')).toBe(expected);
  expect(ollamaApiUrl(endpoint, 'tags')).toBe(expected.replace(/embed$/, 'tags'));
});

test.each(['', 'not a URL', 'file:///tmp/server', 'javascript:alert(1)'])('PDF endpoints reject non-HTTP addresses: %s', endpoint => {
  expect(()=>requireLlmEndpoint(endpoint)).toThrow('HTTP');
});

test('remote PDF document and query embeddings use the configured server and authorization without contacting localhost', async () => {
  const fetchSpy=jest.spyOn(global,'fetch').mockImplementation(async (url,request)=>({ok:true,
    json:async()=>({embeddings:JSON.parse(request.body).input.map(()=>[1,0])})}));
  try {
    const run=harness({pages:[fixtures[0]],embed:undefined,settingChanges:{llmExecution:'api',llmProvider:'custom',
      llmApiEndpoint:'https://translation-only.test/v1',llmApiKey:'translation-key',embeddingApiEndpoint:'http://203.0.113.10:9000/v1',embeddingApiKey:'test-server-key',llmContextTotalLimit:4000}});
    await run.controller.translatePage();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for(const [url,options]of fetchSpy.mock.calls){
      expect(url).toBe('http://203.0.113.10:9000/api/embed');
      expect(options).toMatchObject({method:'POST',headers:{Authorization:'Bearer test-server-key'},signal:expect.any(AbortSignal)});
      expect(JSON.parse(options.body)).toMatchObject({model:'embeddinggemma',truncate:false});
    }
    expect(run.translate).toHaveBeenCalledTimes(1);
    expect(run.rendered.at(-1).translations['p1-b0-s1'].status).toBe('done');
  } finally {fetchSpy.mockRestore();}
});

test('remote embedding caches are isolated by server even when model digests are unavailable', async () => {
  const states=new Map();
  const serverA={embeddingApiEndpoint:'http://203.0.113.10:9000/v1'},serverB={embeddingApiEndpoint:'https://another-server.test/v1'};
  const first=harness({pages:[fixtures[0]],states,modelIdentity:[],settingChanges:serverA}); await first.controller.translatePage();
  const second=harness({pages:[fixtures[0]],states,modelIdentity:[],settingChanges:serverB}); await second.controller.translatePage();
  expect(second.embed).toHaveBeenCalledTimes(1); expect(second.translate).toHaveBeenCalledTimes(1);
  const reopened=harness({pages:[fixtures[0]],states,modelIdentity:[],settingChanges:serverA}); await reopened.controller.translatePage();
  expect(reopened.readPage).not.toHaveBeenCalled(); expect(reopened.embed).not.toHaveBeenCalled(); expect(reopened.translate).not.toHaveBeenCalled();
});

test('model digests are fetched from the configured Ollama server and unavailable metadata stays optional', async () => {
  const settings={llmApiEndpoint:'https://lab.test/ollama/v1/',llmApiKey:'test-key',llmModel:'hy-mt2:1.8b-q8'};
  const fetchSpy=jest.spyOn(global,'fetch').mockResolvedValue({ok:true,json:async()=>({models:[
    {name:settings.llmModel,digest:'translation-digest'},{name:'embeddinggemma:latest',digest:'embedding-digest'},
    {name:'unrelated-model',digest:'other'},
  ]})});
  try {
    expect(await fetchOllamaModelIdentity(settings)).toEqual([[settings.llmModel,'translation-digest']]);
    expect(fetchSpy).toHaveBeenCalledWith('https://lab.test/ollama/api/tags',{
      headers:{Authorization:'Bearer test-key'},signal:expect.any(AbortSignal),credentials:'omit',redirect:'error'});
    fetchSpy.mockResolvedValueOnce({ok:false,status:403}); expect(await fetchOllamaModelIdentity(settings)).toEqual([]);
    fetchSpy.mockRejectedValueOnce(new DOMException('Timeout','TimeoutError')); expect(await fetchOllamaModelIdentity(settings)).toEqual([]);
  } finally {fetchSpy.mockRestore();}
});

test('server access denial during embedding is reported as HTTP 403 and does not cache a successful index', async () => {
  const fetchSpy=jest.spyOn(global,'fetch').mockResolvedValue({ok:false,status:403});
  try {
    const run=harness({pages:[fixtures[0]],embed:undefined,settingChanges:{embeddingApiEndpoint:'http://203.0.113.10:9000/v1'}});
    await run.controller.translatePage();
    expect(run.translate).not.toHaveBeenCalled(); expect(run.saveState).not.toHaveBeenCalled();
    expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('HTTP 403'));
    expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('접근을 거부'));
    expect(formatPdfTranslationError({code:'HTTP_ERROR',status:403})).toContain('접근을 거부');
  } finally {fetchSpy.mockRestore();}
});

test('embedding network errors identify API execution and the failed URL without exposing credentials', async () => {
  const fetchSpy=jest.spyOn(global,'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
  try {
    const run=harness({pages:[fixtures[0]],embed:undefined,settingChanges:{llmExecution:'api',
      embeddingApiEndpoint:'http://203.0.113.10:9000/v1',embeddingApiKey:'private-api-key'}});
    run.panel.setError=jest.fn();
    await run.controller.translatePage();
    const status=run.panel.setStatus.mock.calls.at(-1)[0];
    expect(run.panel.setError.mock.calls[0]).toEqual(['']);
    expect(run.panel.setError).toHaveBeenLastCalledWith(status);
    expect(status).toContain('API (Ollama / 서버)'); expect(status).toContain('임베딩 서버 요청에 실패');
    expect(status).toContain('http://203.0.113.10:9000/api/embed');
    expect(status).not.toMatch(/private-password|private-api-key|username/);
    expect(run.translate).not.toHaveBeenCalled(); expect(run.saveState).not.toHaveBeenCalled();
    expect(run.panel.setBusy).toHaveBeenLastCalledWith(false);
  } finally {fetchSpy.mockRestore();}
});

test('an embedding request has a deadline and reports its URL when the server stalls', async () => {
  const deadline=new AbortController();
  const timeoutSpy=jest.spyOn(AbortSignal,'timeout').mockReturnValue(deadline.signal);
  const fetchSpy=jest.spyOn(global,'fetch').mockImplementation((url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  try {
    const run=harness({pages:[fixtures[0]],embed:undefined,settingChanges:{embeddingApiEndpoint:'http://203.0.113.10:9000/v1'}});
    const pending=run.controller.translatePage();
    await until(()=>fetchSpy.mock.calls.length===1);
    expect(timeoutSpy).toHaveBeenCalledWith(60000);
    deadline.abort(new DOMException('Timed out','TimeoutError')); await pending;
    expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('임베딩 서버 응답 시간이 초과'));
    expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('/api/embed'));
    expect(run.saveState).not.toHaveBeenCalled(); expect(run.panel.setBusy).toHaveBeenLastCalledWith(false);
  } finally {fetchSpy.mockRestore();timeoutSpy.mockRestore();}
});

test('stopping an embedding request cancels the network request and keeps the stopped status', async () => {
  let requestSignal;
  const fetchSpy=jest.spyOn(global,'fetch').mockImplementation((url,{signal})=>new Promise((resolve,reject)=>{
    requestSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  try {
    const run=harness({pages:[fixtures[0]],embed:undefined});
    const pending=run.controller.translatePage(); await until(()=>!!requestSignal);
    run.controller.stop(); await pending;
    expect(requestSignal.aborted).toBe(true);
    expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('중지했습니다'));
    expect(run.saveState).not.toHaveBeenCalled(); expect(run.translate).not.toHaveBeenCalled();
  } finally {fetchSpy.mockRestore();}
});

test("Docling layout is applied before parsing and its identity separates derived indexes and translations", async () => {
  const states = new Map();
  const native = harness({ pages: [fixtures[0]], states });
  await native.controller.prepare();
  const layout = { pageNumber: 1, width: 600, height: 800, regions: [] };
  const loadLayout = jest.fn(async () => ({ pages: [layout], layoutIdentity: ["docling-native-v1", "model-a"], cache: "disk" }));
  const enhanced = harness({ pages: [fixtures[0]], states, loadLayout });
  await enhanced.controller.prepare();
  expect(enhanced.readPage).toHaveBeenCalledWith(expect.anything(), { mode: "auto", layout });
  expect(enhanced.embed).toHaveBeenCalled();
  expect(enhanced.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("Docling CPU"));
  const reopened = harness({ pages: [fixtures[0]], states, loadLayout });
  await reopened.controller.prepare();
  expect(reopened.readPage).not.toHaveBeenCalled();
  expect(reopened.embed).not.toHaveBeenCalled();
  const changed = harness({ pages: [fixtures[0]], states,
    loadLayout: async () => ({ pages: [layout], layoutIdentity: ["docling-native-v1", "model-b"] }) });
  await changed.controller.prepare();
  expect(changed.readPage).toHaveBeenCalledTimes(1);
});

test("browser execution uses browser embeddings with distinct query purpose and isolates API vectors", async () => {
  const states = new Map(); await harness({ pages: [fixtures[0]], states }).controller.prepare();
  const fetchSpy = jest.spyOn(global, 'fetch');
  requestBrowserAi.mockReset();
  requestBrowserAi.mockImplementation(async ({ operation, input }) => {
    if (operation !== 'embed') throw new Error('Unexpected browser operation');
    return input.map(() => [0, 1, 0]);
  });
  const run = harness({ pages: [fixtures[0]], states, embed: undefined,
    settingChanges: { llmExecution: 'browser', embeddingExecution: 'browser', llmApiEndpoint: '', llmModel: '', llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
  const calls = requestBrowserAi.mock.calls.map(([payload]) => payload);
  expect(calls.map(p => p.operation)).toEqual(['embed', 'embed']);
  expect(calls.map(p => p.purpose)).toEqual(['document', 'query']);
  expect(run.readPage).toHaveBeenCalledTimes(1);
  expect(run.rendered.at(-1).translations['p1-b0-s1'].status).toBe('done');
  const browserKey = [...states.keys()].find(key => key.includes('wllama') && key.includes('embeddinggemma') && states.get(key).index);
  expect(states.get(browserKey).index[0].vector).toEqual([0, 1, 0]);
  requestBrowserAi.mockClear();
  const reopened = harness({ pages: [fixtures[0]], states, embed: undefined,
    settingChanges: { llmExecution: 'browser', embeddingExecution: 'browser', llmApiEndpoint: 'https://unused-api.test', llmModel: 'old-api-model', llmContextTotalLimit: 4000 } });
  await reopened.controller.prepare();
  expect(reopened.readPage).not.toHaveBeenCalled(); expect(requestBrowserAi).not.toHaveBeenCalled();
});

test("an unavailable layout service reuses native caches and reports the fallback", async () => {
  const states = new Map();
  await harness({ pages: [fixtures[0]], states }).controller.prepare();
  const run = harness({ pages: [fixtures[0]], states, loadLayout: async () => ({ pages: [], warning: "unavailable" }) });
  await run.controller.prepare();
  expect(run.readPage).not.toHaveBeenCalled();
  expect(run.embed).not.toHaveBeenCalled();
  expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("Docling에 연결하지 못해"));
});

test("applying exclusions preserves completed source-matched translations despite renumbered blocks and reuses embeddings", async () => {
  const states = new Map(); let excluded = false;
  const blocks = ['First sentence.', 'Second sentence.'].map((text,i) => ({ id: `p1-b${i}`, kind: 'paragraph', text,
    sourceIndices: [i], textSpans: [{ start: 0, end: text.length, itemIndex: i, sourceStart: 0, sourceEnd: text.length }] }));
  const readPage = jest.fn(async () => ({ ...fixtures[0], blocks: excluded ? [{ ...blocks[1], id: 'p1-b0' }] : blocks }));
  const loadLayout = async () => ({ pages: [], layoutIdentity: ['model-a', excluded ? 'edited' : 'automatic'] });
  const run = harness({ pages: [fixtures[0]], states, readPage, loadLayout });
  await run.controller.translatePage();
  expect(run.translate).toHaveBeenCalledTimes(2); expect(run.embed).toHaveBeenCalledTimes(1);
  excluded = true; await run.controller.refreshLayout();
  expect(run.rendered.at(-1).blocks.map(b => b.text)).toEqual(['Second sentence.']);
  expect(run.rendered.at(-1).translations['p1-b0-s1'].text).toBe('Translated Second sentence.');
  expect(run.translate).toHaveBeenCalledTimes(2); expect(run.embed).toHaveBeenCalledTimes(1);
  const reopened = harness({ pages: [fixtures[0]], states, readPage, loadLayout });
  await reopened.controller.translatePage();
  expect(reopened.translate).not.toHaveBeenCalled(); expect(reopened.embed).not.toHaveBeenCalled();
  expect(reopened.rendered.at(-1).translations['p1-b0-s1'].text).toBe('Translated Second sentence.');
  excluded = false; await run.controller.refreshLayout();
  expect(run.rendered.at(-1).blocks).toHaveLength(2);
  expect(run.rendered.at(-1).translations['p1-b0-s1'].text).toBe('Translated First sentence.');
  expect(run.translate).toHaveBeenCalledTimes(2); expect(run.embed).toHaveBeenCalledTimes(1);
});

test("a changed classification invalidates only that source translation and never starts LLM generation on apply", async () => {
  let changed = false;
  const text = 'A body sentence.';
  const readPage = async () => ({ ...fixtures[0], blocks: [{ id: 'p1-b0', text, kind: changed ? 'heading' : 'paragraph',
    textSpans: [{ start: 0, end: text.length, itemIndex: 0, sourceStart: 0, sourceEnd: text.length }] }] });
  const run = harness({ pages: [fixtures[0]], readPage,
    loadLayout: async () => ({ pages: [], layoutIdentity: [String(changed)] }) });
  await run.controller.translatePage(); changed = true; await run.controller.refreshLayout();
  expect(run.translate).toHaveBeenCalledTimes(1);
  expect(run.rendered.at(-1).blocks[0].kind).toBe('heading');
  expect(run.rendered.at(-1).translations['p1-b0']).toBeUndefined();
  await run.controller.translatePage(); expect(run.translate).toHaveBeenCalledTimes(2);
});

test("long translation targets split without overlap, omission, or requests beyond the requested size", async () => {
  const text = Array.from({ length: 80 }, (_, i) => `Sentence ${i} describes a biological cell.`).join(" ");
  const parts = splitTranslationText(text);
  expect(parts.join(" ")).toBe(text);
  expect(parts.every((part) => part.length <= 900)).toBe(true);
  expect(splitTranslationText(`${"x".repeat(899)}. next`, 900).every((part) => part.length <= 900)).toBe(true);
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text }] };
  const run = harness({ pages: [page] });
  await run.controller.translatePage();
  expect(run.translate.mock.calls.map(([part]) => part).join(" ")).toBe(text);
  expect(run.rendered.at(-1).blocks).toHaveLength(80);
  expect(run.rendered.at(-1).translations["p1-b0-s1"].status).toBe("done");
});

test("hovering a sentence on another visible source page reveals its cached translation without moving the PDF or invoking a model", async () => {
  let currentPage = 1;
  const run = harness({ getCurrentPage: () => currentPage });
  expect(run.controller.getPageUnits(1)).toEqual([]);
  await run.controller.translateAll();
  run.panel.highlightSentence = jest.fn(() => true);
  run.translate.mockClear(); run.embed.mockClear(); run.readPage.mockClear(); run.saveState.mockClear();
  expect(run.controller.getPageUnits(2)[0].id).toBe("p2-b0-s1");
  expect(await run.controller.revealSourceSentence("p2-b0-s1", 2)).toBe(true);
  expect(run.rendered.at(-1).pageNumber).toBe(2);
  expect(currentPage).toBe(1);
  expect(run.panel.highlightSentence).toHaveBeenCalledWith("p2-b0-s1", 2);
  for (const tool of [run.translate, run.embed, run.readPage, run.saveState]) expect(tool).not.toHaveBeenCalled();
  await run.controller.showPage();
  expect(run.rendered.at(-1).pageNumber).toBe(1);
});

test("leaving the source while its translation page loads cannot reveal or highlight a stale sentence", async () => {
  const gate = deferred(); let current = true, loading = false;
  const states = new Map();
  const run = harness({ states, loadState: async (key) => {
    if (key.endsWith(":page:2")) { loading = true; return gate.promise; }
    return copy(states.get(key)) || null;
  } });
  await run.controller.prepare();
  run.panel.highlightSentence = jest.fn();
  const pending = run.controller.revealSourceSentence("p2-b0-s1", 2, () => current);
  await until(() => loading);
  current = false; gate.resolve(null);
  expect(await pending).toBe(false);
  expect(run.rendered.at(-1).pageNumber).toBe(1);
  expect(run.panel.highlightSentence).not.toHaveBeenCalled();
});

test("page changes update immediately and show cached translations before slow paragraph layout", async () => {
  const states = new Map(), saved = harness({ states }); await saved.controller.translateAll();
  const layout = deferred(); let currentPage = 1, requested = false;
  const pdfDocument = { numPages: 3, getPage: async n => ({ pageNumber: n,
    getTextContent: () => n === 2 ? (requested = true, layout.promise) : Promise.resolve({ items: [] }) }) };
  const run = harness({ states, pdfDocument, getCurrentPage: () => currentPage }); await run.controller.prepare();
  currentPage = 2; const showing = run.controller.showPage();
  expect(run.rendered.at(-1).pageNumber).toBe(2);
  expect(run.rendered.at(-1).blocks[0].id).toBe('p2-b0-s1');
  await until(() => requested && run.rendered.at(-1).translations['p2-b0-s1']?.status === 'done');
  expect(run.rendered.at(-1).translations['p2-b0-s1'].text).toBe('Translated Source paragraph on page 2.');
  currentPage = 3; await run.controller.showPage(); const rendered = run.rendered.length;
  layout.resolve({ items: [] }); await showing;
  expect(run.rendered).toHaveLength(rendered); expect(run.rendered.at(-1).pageNumber).toBe(3);
  expect(run.translate).not.toHaveBeenCalled(); expect(run.embed).not.toHaveBeenCalled();
});

test("page navigation invalidates an old hover and leaving a visible-page preview restores the current page", async () => {
  const gate = deferred(); let currentPage = 1, delaying = false;
  const run = harness({ getCurrentPage: () => currentPage, loadState: async key => {
    if (key.endsWith(':page:2')) { delaying = true; return gate.promise; }
    return null;
  } });
  await run.controller.prepare(); run.panel.highlightSentence = jest.fn(() => true);
  const hover = run.controller.revealSourceSentence('p2-b0-s1', 2); await until(() => delaying);
  currentPage = 3; await run.controller.showPage(); gate.resolve(null);
  expect(await hover).toBe(false); expect(run.rendered.at(-1).pageNumber).toBe(3);
  expect(run.panel.highlightSentence).not.toHaveBeenCalled();
  expect(await run.controller.revealSourceSentence('p2-b0-s1', 2)).toBe(true);
  expect(run.rendered.at(-1).pageNumber).toBe(2);
  await run.controller.clearSourcePreview(); expect(run.rendered.at(-1).pageNumber).toBe(3);
});

test("clearing a source preview cancels a pending reveal without suppressing a new page cache render", async () => {
  const states = new Map(), saved = harness({ states }); await saved.controller.translateAll();
  let currentPage = 1;
  const gate = deferred();
  const run = harness({ states, getCurrentPage: () => currentPage,
    loadState: async key => key.endsWith(':page:2') ? gate.promise : copy(states.get(key)) || null });
  await run.controller.prepare();
  const hover = run.controller.revealSourceSentence('p2-b0-s1', 2);
  run.controller.clearSourcePreview();
  currentPage = 3; await run.controller.showPage();
  expect(run.rendered.at(-1).translations['p3-b0-s1']?.status).toBe('done');
  gate.resolve(null); expect(await hover).toBe(false);
  expect(run.rendered.at(-1).pageNumber).toBe(3);
});

test("wrapped prose translates and renders each sentence while keeping the paragraph retrieval index", async () => {
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0],
    text: "The compiler records a trace\nacross several lines. The next sentence\nis separate.",
  }] };
  const run = harness({ pages: [page], settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  expect(run.translate.mock.calls.map(([text]) => text)).toEqual([
    "The compiler records a trace across several lines.", "The next sentence is separate.",
  ]);
  const savedIndex = run.saveState.mock.calls.find(([, state]) => state.index)[1].index;
  expect(savedIndex).toHaveLength(1);
  expect(savedIndex[0].blockIds).toEqual(["p1-b0"]);
  for (const [, , context] of run.translate.mock.calls) {
    expect(context).toContain("Surrounding paragraph: The compiler records a trace across several lines.");
    expect(context).not.toContain("Related source");
  }
  const rendered = run.rendered.at(-1);
  expect(rendered.blocks.map((unit) => unit.id)).toEqual(["p1-b0-s1", "p1-b0-s2"]);
  expect(Object.values(rendered.translations).every((result) => result.status === "done")).toBe(true);
  expect(run.panel.setProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
});

test("native paragraph indentation changes only presentation grouping and never translation units or cached source text", async () => {
  const source = "First sentence. Second sentence.";
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: source,
    textSpans: [{ start: 0, end: 15, itemIndex: 0, sourceStart: 0, sourceEnd: 15 },
      { start: 16, end: 32, itemIndex: 1, sourceStart: 0, sourceEnd: 16 }],
  }] };
  const items = [
    { str: "First sentence.", height: 10, transform: [10, 0, 0, 10, 40, 700] },
    { str: "Second sentence.", height: 10, transform: [10, 0, 0, 10, 54, 688] },
  ];
  const pdfDocument = { numPages: 1, getPage: async () => ({ pageNumber: 1,
    getTextContent: async () => ({ items }), getViewport: () => ({ transform: [1, 0, 0, -1, 0, 800] }) }) };
  const run = harness({ pages: [page], pdfDocument });
  await run.controller.translatePage();
  expect(run.translate.mock.calls.map(([text]) => text)).toEqual(["First sentence.", "Second sentence."]);
  const rendered = run.rendered.at(-1).blocks;
  expect(rendered.map((unit) => unit.id)).toEqual(["p1-b0-s1", "p1-b0-s2"]);
  expect(rendered[0].displayParagraphId).not.toBe(rendered[1].displayParagraphId);
  const indexed = run.saveState.mock.calls.find(([, state]) => state.index)[1];
  expect(indexed.pages[0].blocks[0].text).toBe(source);
  expect(indexed.pages[0].blocks[0].displayParagraphId).toBeUndefined();
});

test("display section hierarchy continues across pages without changing cached text or requesting translations", async () => {
  const pages = [
    { ...fixtures[0], blocks: [{ id: 'heading', kind: 'heading', text: '3.2 Model' }, fixtures[0].blocks[0]] },
    { ...fixtures[1], blocks: [fixtures[1].blocks[0]] },
  ];
  let currentPage = 2;
  const run = harness({ pages, getCurrentPage: () => currentPage }); await run.controller.prepare();
  const continued = run.rendered.at(-1).blocks[0];
  expect(continued.displaySection).toMatchObject({ id: 'heading', rootId: 'number:3', level: 2 });
  currentPage = 1; await run.controller.showPage();
  expect(run.rendered.at(-1).blocks[0].displaySection).toEqual(continued.displaySection);
  expect(run.translate).not.toHaveBeenCalled();
  const indexed = run.saveState.mock.calls.find(([, state]) => state.index)[1];
  expect(indexed.pages[0].blocks[0].displaySection).toBeUndefined();
});

test("an unusually long sentence stays one displayed and cached unit despite bounded model requests", async () => {
  const text = `${"A long technical clause without a full stop ".repeat(50).trim()}.`;
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text }] };
  const run = harness({ pages: [page] });
  await run.controller.translatePage();
  expect(run.translate.mock.calls.length).toBeGreaterThan(1);
  expect(run.translate.mock.calls.every(([part]) => part.length <= 900)).toBe(true);
  expect(run.translate.mock.calls.map(([part]) => part).join(" ")).toBe(text);
  expect(run.rendered.at(-1).blocks).toHaveLength(1);
  expect(Object.keys(run.rendered.at(-1).translations)).toEqual(["p1-b0-s1"]);
});

test("a reconstructed sentence excludes all of its source fragments from retrieved references", async () => {
  const pages = [
    { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "The trace is" },
      { ...fixtures[0].blocks[0], id: "p1-b1", text: "compiled into native code. A second sentence follows." }] },
    fixtures[1],
  ];
  const run = harness({ pages, settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage(1);
  expect(run.translate.mock.calls.map(([text]) => text)).toEqual([
    "The trace is compiled into native code.", "A second sentence follows.",
  ]);
  expect(run.translate.mock.calls[0][2]).toContain("Related source, page 2");
  expect(run.translate.mock.calls[0][2]).not.toContain("Related source, page 1");
  expect(run.rendered.at(-1).blocks[0].sourceBlockIds).toEqual(["p1-b0", "p1-b1"]);
});

test.each([5, 6, 7])("indexes with old layout extraction version %s are rebuilt and the new index is reused on reopening", async (version) => {
  const oldKey = JSON.stringify(["mtt-pdf", version, "test-paper", "embeddinggemma", "model-digest", {}]);
  const oldPage = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], kind: "caption" }] };
  const states = new Map([[oldKey, { version, pages: [oldPage], index: [], abstract: "" }]]);
  const first = harness({ pages: [fixtures[0]], states });
  await first.controller.prepare();
  expect(first.readPage).toHaveBeenCalledTimes(1);
  expect(first.rendered.at(-1).blocks[0].kind).toBe("paragraph");
  expect(states.get(oldKey).pages[0].blocks[0].kind).toBe("caption");
  const reopened = harness({ pages: [fixtures[0]], states });
  await reopened.controller.prepare();
  expect(reopened.readPage).not.toHaveBeenCalled();
  expect(reopened.embed).not.toHaveBeenCalled();
  expect(reopened.rendered.at(-1).blocks[0].kind).toBe("paragraph");
});

test.each([["paragraph", null, "p1-b0"], ["marked sentence", "sentences-v3", "p1-b0-s1"]])(
  "old %s translations are ignored while the existing document index is reused", async (_, version, unitId) => {
  const states = new Map();
  const first = harness({ pages: [fixtures[0]], states });
  await first.controller.prepare();
  const indexKey = first.saveState.mock.calls.find(([, state]) => state.index)[0];
  const oldTranslationKey = JSON.stringify([indexKey, ...(version ? [version] : []), first.modelIdentity, first.settings.llmApiEndpoint,
    first.settings.llmModel, "ko", { title: 300, heading: 250, paragraph: 2400, before: 450, after: 450, total: 0 }]);
  states.set(`${oldTranslationKey}:page:1`, { translations: { [unitId]: { status: "done", text: "Old marked translation" } } });
  const reopened = harness({ pages: [fixtures[0]], states });
  await reopened.controller.translatePage();
  expect(reopened.readPage).not.toHaveBeenCalled();
  expect(reopened.embed).not.toHaveBeenCalled();
  expect(reopened.translate).toHaveBeenCalledTimes(1);
  expect(reopened.rendered.at(-1).translations["p1-b0-s1"].text).not.toBe("Old marked translation");
});

test("cache identity distinguishes files with identical PDF fingerprints", async () => {
  const document = (bytes) => ({ fingerprints: ["same-fingerprint"], getData: async () => new Uint8Array(bytes) });
  const first = await getDocumentCacheId(document([1, 2, 3]));
  expect(await getDocumentCacheId(document([1, 2, 3]))).toBe(first);
  expect(await getDocumentCacheId(document([1, 2, 4]))).not.toBe(first);
});

test("page boundary references use adjacent page paragraphs and remain within character and byte limits", () => {
  const context = makePageReference(fixtures[1], fixtures[1].blocks[0], [], "Paper", "", {
    llmContextTotalLimit: 1000, llmContextBeforeLimit: 100, llmContextAfterLimit: 100,
  }, fixtures);
  expect(context).toContain("Previous paragraph: Source paragraph on page 1.");
  expect(context).toContain("Following paragraph: Source paragraph on page 3.");
  const fitted = fitReferenceContext("가나다😀".repeat(3000), "Source", 100);
  expect(new TextEncoder().encode(fitted + "Source").length).toBeLessThanOrEqual(100);
  expect(fitted).not.toMatch(/[\uD800-\uDBFF]$/);
});

test("sentence references remain centered after PDF hyphen and newline normalization", () => {
  const source = { ...fixtures[0].blocks[0],
    text: `${"Earlier sentence. ".repeat(100)}An experi\u00ad\nmental result is reported here. A following sentence.`,
  };
  const unit = { ...source, id: "p1-b0-s101", text: "An experimental result is reported here.",
    sourceBlockIds: [source.id], unitType: "sentence" };
  const context = makePageReference({ ...fixtures[0], blocks: [source] }, unit, [], "", "", {
    llmContextParagraphLimit: 100, llmContextTotalLimit: 200,
  });
  expect(context).toContain("An experimental result is reported here.");
  expect(context).toContain("A following sentence.");
});

test("running headers, page numbers and publication footers are excluded before indexing and sentence joining", async () => {
  const pages = [1, 2].map((n) => ({ ...fixtures[n - 1], blocks: [
    { id: `p${n}-header`, text: "Journal of Compiler Research", kind: "paragraph", bbox: { x: 10, y: 15, width: 220, height: 15 } },
    { ...fixtures[n - 1].blocks[0], text: "The trace is" },
    ...(n === 1 ? [{ id: "publisher", text: "Copyright © 2026 Publisher. All rights reserved.", kind: "footnote",
      bbox: { x: 10, y: 730, width: 220, height: 20 } }] : []),
    { ...fixtures[n - 1].blocks[0], id: `p${n}-body2`, text: "compiled into native code.", column: 2 },
    { id: `p${n}-number`, text: `${n}`, kind: "paragraph", bbox: { x: 290, y: 780, width: 10, height: 12 } },
  ] }));
  const run = harness({ pages });
  await run.controller.translateAll();
  expect(run.translate.mock.calls.map(([text]) => text)).toEqual([
    "The trace is compiled into native code.", "The trace is compiled into native code.",
  ]);
  const indexed = run.saveState.mock.calls.find(([, state]) => state.index)[1].index;
  expect(indexed.every((chunk) => !/Journal|Copyright|reserved/.test(chunk.text))).toBe(true);
  expect(run.rendered.at(-1).blocks).toHaveLength(1);
});

test("full translation indexes all pages once, prioritizes the current page, and reuses completed results", async () => {
  const run = harness({ currentPage: 2 });
  await run.controller.translateAll();
  expect(run.readPage).toHaveBeenCalledTimes(3);
  expect(run.embed).toHaveBeenCalledTimes(1);
  expect(run.embed.mock.calls[0][0]).toHaveLength(3);
  expect(run.translate.mock.calls.map(([text]) => text)).toEqual([
    "Source paragraph on page 2.", "Source paragraph on page 1.", "Source paragraph on page 3.",
  ]);
  expect(run.saveState.mock.calls.filter(([, state]) => state.index)).toHaveLength(1);
  await run.controller.translateAll();
  expect(run.translate).toHaveBeenCalledTimes(3);
  expect(run.embed).toHaveBeenCalledTimes(1);
});

test("RAG adds related sources only as reference and never selects which target paragraphs get translated", async () => {
  const run = harness({ settingChanges: { llmContextTotalLimit: 3000 } });
  await run.controller.translateAll();
  expect(run.translate).toHaveBeenCalledTimes(3);
  for (const [source, target, context] of run.translate.mock.calls) {
    expect(source).toMatch(/^Source paragraph on page [123]\.$/);
    expect(target).toBe("ko");
    expect(context).toContain("Related source, page");
    expect(context).toContain("Document title: Paper title");
  }
});

test("a reopened document displays saved page translations without repeating extraction or inference", async () => {
  const states = new Map();
  const first = harness({ states });
  await first.controller.translateAll();
  const reopened = harness({ states });
  await reopened.controller.prepare();
  await until(() => reopened.rendered.some((page) => page.translations["p1-b0-s1"]?.status === "done"));
  expect(reopened.readPage).not.toHaveBeenCalled();
  expect(reopened.embed).not.toHaveBeenCalled();
  await reopened.controller.translateAll();
  expect(reopened.translate).not.toHaveBeenCalled();
});

test("a late page-display cache read does not replace an active translation result", async () => {
  const states = new Map();
  const displayCache = deferred();
  const modelResponse = deferred();
  let currentPage = 1;
  let pageReads = 0;
  const run = harness({
    states,
    getCurrentPage: () => currentPage,
    loadState: async (key) => {
      if (key.endsWith(":page:2") && ++pageReads === 1) return displayCache.promise;
      return copy(states.get(key)) || null;
    },
    translate: jest.fn(() => modelResponse.promise),
  });
  await run.controller.prepare();
  currentPage = 2;
  const showingPage = run.controller.showPage();
  const translating = run.controller.translatePage(2);
  await until(() => run.translate.mock.calls.length === 1);
  displayCache.resolve(null);
  await showingPage;
  modelResponse.resolve({ targetText: "Translated second page" });
  await translating;
  expect(pageReads).toBe(2);
  expect(run.rendered.at(-1).translations["p2-b0-s1"]).toEqual({
    status: "done", text: "Translated second page",
  });
});

test("failed or truncated translation responses stay retryable and are never cached as done", async () => {
  const translate = jest.fn()
    .mockResolvedValueOnce({ targetText: "broken", isBroken: true })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ targetText: "Successful retry" });
  const run = harness({ pages: [fixtures[0]], translate });
  await run.controller.translatePage();
  expect(run.rendered.at(-1).translations["p1-b0-s1"].status).toBe("error");
  await run.controller.translatePage();
  expect(run.rendered.at(-1).translations["p1-b0-s1"].status).toBe("error");
  expect(run.saveState.mock.calls.some(([, state]) => state.translations?.["p1-b0-s1"]?.status === "done")).toBe(false);
  await run.controller.translatePage();
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toMatchObject({ status: "done", text: "Successful retry" });
});

test("model output limits recover once without references and the displayed result explains the context reduction", async () => {
  const translate = jest.fn().mockRejectedValueOnce(Object.assign(new Error("clipped"), { code: "OUTPUT_LIMIT" }))
    .mockResolvedValueOnce({ targetText: "복구한 번역" });
  const run = harness({ pages: [fixtures[0]], translate, settingChanges: { llmContextTotalLimit: 3000 } });
  await run.controller.translatePage();
  expect(translate.mock.calls[0][2]).toContain("Document title");
  expect(translate.mock.calls[1][2]).toBe("");
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toMatchObject({
    status: "done", text: "복구한 번역", notice: expect.stringContaining("주변 문맥 없이"),
  });
});

test("PDF errors expose the actual local failure category instead of one generic sentence failure", async () => {
  const translate = jest.fn().mockRejectedValue(Object.assign(new Error("HTTP details"), { code: "HTTP_ERROR", status: 503 }));
  const run = harness({ pages: [fixtures[0]], translate });
  await run.controller.translatePage();
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toMatchObject({
    status: "error", errorCode: "HTTP_ERROR", error: expect.stringContaining("HTTP 503"),
  });
  expect(formatPdfTranslationError({ code: "OUTPUT_LIMIT" })).toContain("출력 한도");
  expect(formatPdfTranslationError({ code: "TIMEOUT" })).toContain("응답 시간");
  expect(formatPdfTranslationError({ code: "EMPTY_OUTPUT" })).toContain("빈 번역");
});

const batchPage = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0],
  text: "First source sentence. Second source sentence. Third source sentence. Fourth source sentence.",
}] };
const batchAnswer = (entries) => entries.map(({ id, text }) => ({ id, targetText: `Batch ${text}` }));

test("four sentences use one translation request and one query embedding batch while preserving individual results", async () => {
  const translateBatch = jest.fn(async (entries) => batchAnswer(entries).reverse());
  const run = harness({ pages: [batchPage], translateBatch, settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  expect(translateBatch).toHaveBeenCalledTimes(1);
  expect(translateBatch.mock.calls[0][0].map(({ id }) => id)).toEqual(["p1-b0-s1", "p1-b0-s2", "p1-b0-s3", "p1-b0-s4"]);
  expect(run.translate).not.toHaveBeenCalled();
  expect(run.embed.mock.calls.map(([input]) => input.length)).toEqual([1, 4]);
  expect(run.rendered.at(-1).blocks.map((unit) => run.rendered.at(-1).translations[unit.id].text)).toEqual([
    "Batch First source sentence.", "Batch Second source sentence.", "Batch Third source sentence.", "Batch Fourth source sentence.",
  ]);
  expect(run.saveState.mock.calls.filter(([, state]) => state.translations)).toHaveLength(1);
  expect(run.panel.setProgress).toHaveBeenLastCalledWith({ completed: 4, total: 4 });
  await run.controller.translatePage();
  expect(translateBatch).toHaveBeenCalledTimes(1);
  expect(run.embed).toHaveBeenCalledTimes(2);
});

test("incomplete batch mappings are discarded and individually recovered without repeated bad batch attempts", async () => {
  const page = { ...batchPage, blocks: [{ ...batchPage.blocks[0], text: `${batchPage.blocks[0].text} Fifth source sentence.` }] };
  const translateBatch = jest.fn(async (entries) => batchAnswer(entries).slice(0, 2));
  const run = harness({ pages: [page], translateBatch });
  await run.controller.translatePage();
  expect(translateBatch).toHaveBeenCalledTimes(1);
  expect(run.translate).toHaveBeenCalledTimes(5);
  expect(Object.values(run.rendered.at(-1).translations).every((result) => result.status === "done" && !result.text.startsWith("Batch"))).toBe(true);
  expect(run.saveState.mock.calls.filter(([, state]) => state.translations)
    .every(([, state]) => Object.values(state.translations).every((result) => !result.text?.startsWith("Batch")))).toBe(true);
});

test("cached sentences and formulas stay complete while long sentences keep their individual bounded requests", async () => {
  const long = `${"A long clause with no full stop ".repeat(45).trim()}.`;
  const page = { ...fixtures[0], blocks: [
    fixtures[0].blocks[0], { ...fixtures[0].blocks[0], id: "formula", kind: "formula", text: "x = y" },
    { ...fixtures[0].blocks[0], id: "new", text: "Pending first sentence. Pending second sentence." },
    { ...fixtures[0].blocks[0], id: "heading", kind: "heading", text: "Methods" },
    { ...fixtures[0].blocks[0], id: "long", text: long },
  ] };
  const states = new Map();
  await harness({ pages: [page], states }).controller.translatePage();
  const snapshot = [...states.entries()].find(([key]) => key.endsWith(":page:1"))[1];
  for (const id of ["new-s1", "new-s2", "long-s1"]) delete snapshot.translations[id];
  const translateBatch = jest.fn(async (entries) => batchAnswer(entries));
  const run = harness({ pages: [page], states, translateBatch });
  await run.controller.translatePage();
  expect(translateBatch).toHaveBeenCalledTimes(1);
  expect(translateBatch.mock.calls[0][0].map(({ id }) => id)).toEqual(["new-s1", "new-s2"]);
  expect(run.translate.mock.calls.every(([part]) => part.length <= 900)).toBe(true);
  expect(run.translate.mock.calls.map(([part]) => part).join(" ")).toBe(long);
  expect(run.rendered.at(-1).translations.formula).toEqual({ status: "done", text: "x = y" });
});

test("stopping a pending batch prevents late cache writes, renders, progress, or single-sentence fallback", async () => {
  const gate = deferred();
  const translateBatch = jest.fn(() => gate.promise);
  const run = harness({ pages: [batchPage], translateBatch });
  const running = run.controller.translatePage();
  await until(() => translateBatch.mock.calls.length === 1);
  run.controller.stop();
  const renders = run.rendered.length;
  const writes = run.saveState.mock.calls.length;
  const progress = run.panel.setProgress.mock.calls.length;
  gate.resolve(batchAnswer(translateBatch.mock.calls[0][0]));
  await running;
  expect(run.rendered).toHaveLength(renders);
  expect(run.saveState).toHaveBeenCalledTimes(writes);
  expect(run.panel.setProgress).toHaveBeenCalledTimes(progress);
  expect(run.translate).not.toHaveBeenCalled();
});

test("stopping during a batch cache write prevents any late progress or rendering", async () => {
  const gate = deferred();
  const writing = jest.fn();
  const run = harness({ pages: [batchPage], translateBatch: async (entries) => batchAnswer(entries),
    saveState: async (_, value) => {
      if (value.translations) { writing(); await gate.promise; }
      return true;
    } });
  const running = run.controller.translatePage();
  await until(() => writing.mock.calls.length === 1);
  run.controller.stop();
  const renders = run.rendered.length;
  const progress = run.panel.setProgress.mock.calls.length;
  gate.resolve();
  await running;
  expect(run.rendered).toHaveLength(renders);
  expect(run.panel.setProgress).toHaveBeenCalledTimes(progress);
});

test("query embeddings survive a failed batch and retry within the same open PDF", async () => {
  const translateBatch = jest.fn().mockRejectedValueOnce(Object.assign(new Error("Offline"), { code: "CONNECTION_ERROR" }))
    .mockImplementation(async (entries) => batchAnswer(entries));
  const run = harness({ pages: [batchPage], translateBatch, settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  expect(run.embed).toHaveBeenCalledTimes(2);
  expect(Object.values(run.rendered.at(-1).translations).every((result) => result.status === "error")).toBe(true);
  await run.controller.translatePage();
  expect(run.embed).toHaveBeenCalledTimes(2);
  expect(translateBatch).toHaveBeenCalledTimes(2);
  expect(Object.values(run.rendered.at(-1).translations).every((result) => result.status === "done")).toBe(true);
});

const continuingPages = [
  { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "The trace is" }] },
  { ...fixtures[1], blocks: [{ ...fixtures[1].blocks[0], text: "compiled into native code. Another sentence follows." }] },
];

test("page two translates the complete spanning sentence and shares its result with page one and reopened documents", async () => {
  const states = new Map();
  let currentPage = 2;
  const run = harness({ pages: continuingPages, states, getCurrentPage: () => currentPage,
    settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage(2);
  expect(run.translate.mock.calls.map(([source]) => source)).toEqual([
    "The trace is compiled into native code.", "Another sentence follows.",
  ]);
  expect(run.rendered.at(-1).blocks[0].sourcePageNumbers).toEqual([1, 2]);
  expect(run.translate.mock.calls[0][2]).toContain("Surrounding paragraph: The trace is compiled into native code.");
  currentPage = 1;
  await run.controller.showPage();
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toMatchObject({ status: "done", text: "Translated The trace is compiled into native code." });
  await run.controller.translatePage(1);
  expect(run.translate).toHaveBeenCalledTimes(2);
  const reopened = harness({ pages: continuingPages, states, currentPage: 2, settingChanges: { llmContextTotalLimit: 4000 } });
  await reopened.controller.prepare();
  expect(reopened.rendered.at(-1).translations["p1-b0-s1"].status).toBe("done");
  await reopened.controller.translatePage(2);
  expect(reopened.translate).not.toHaveBeenCalled();
});

test("whole-document progress counts a shared sentence once despite appearing on both pages", async () => {
  const run = harness({ pages: continuingPages, currentPage: 2 });
  await run.controller.translateAll();
  expect(run.translate).toHaveBeenCalledTimes(2);
  expect(run.panel.setProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
});

test("a batch containing shared and local sentences persists each result under its canonical page", async () => {
  const states = new Map();
  const translateBatch = jest.fn(async (entries) => batchAnswer(entries));
  const run = harness({ pages: continuingPages, states, currentPage: 2, translateBatch });
  await run.controller.translatePage(2);
  expect(translateBatch).toHaveBeenCalledTimes(1);
  const ownerOne = [...states.entries()].find(([key]) => key.endsWith(":page:1"))[1].translations;
  const ownerTwo = [...states.entries()].find(([key]) => key.endsWith(":page:2"))[1].translations;
  expect(Object.keys(ownerOne)).toEqual(["p1-b0-s1"]);
  expect(Object.keys(ownerTwo)).toEqual(["p2-b0-s2"]);
  const reopened = harness({ pages: continuingPages, states, currentPage: 1, translateBatch });
  await reopened.controller.translateAll();
  expect(translateBatch).toHaveBeenCalledTimes(1);
  expect(reopened.translate).not.toHaveBeenCalled();
  expect(reopened.panel.setProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2 });
});

test("stop prevents a late model response from updating a page or scheduling remaining targets", async () => {
  const gate = deferred();
  const translate = jest.fn(() => gate.promise);
  const run = harness({ translate });
  const running = run.controller.translateAll();
  await until(() => translate.mock.calls.length === 1);
  run.controller.stop();
  const rendersAtStop = run.rendered.length;
  gate.resolve({ targetText: "Late answer" });
  await running;
  expect(run.rendered).toHaveLength(rendersAtStop);
  expect(translate).toHaveBeenCalledTimes(1);
  expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("중지"));
});

test("stop during a persistence write does not emit late progress or page renders", async () => {
  const gate = deferred();
  const writeStarted = jest.fn();
  const run = harness({ saveState: async (key, value) => {
    if (value.translations) { writeStarted(); await gate.promise; }
    return true;
  } });
  const running = run.controller.translateAll();
  await until(() => writeStarted.mock.calls.length === 1);
  run.controller.stop();
  const rendersAtStop = run.rendered.length;
  const progressAtStop = run.panel.setProgress.mock.calls.length;
  gate.resolve();
  await running;
  expect(run.rendered).toHaveLength(rendersAtStop);
  expect(run.panel.setProgress).toHaveBeenCalledTimes(progressAtStop);
  expect(run.translate).toHaveBeenCalledTimes(1);
});

test("changing reading mode and context preferences invalidates the corresponding translation cache", async () => {
  const states = new Map();
  const first = harness({ pages: [fixtures[0]], states });
  await first.controller.translatePage();
  await first.controller.setMode("two");
  await first.controller.translatePage();
  expect(first.readPage.mock.calls.map(([, options]) => options.mode)).toEqual(["auto", "two"]);
  expect(first.translate).toHaveBeenCalledTimes(2);
  const changedContext = harness({ pages: [fixtures[0]], states, settingChanges: { llmContextTotalLimit: 500 } });
  await changedContext.controller.translatePage();
  expect(changedContext.translate).toHaveBeenCalledTimes(1);
});

const localTest = process.env.MTT_LOCAL_AI_SMOKE === "1" ? test : test.skip;

test("a completed sentence retries alone, keeps its old text while running, and can be restored after reopening", async () => {
  const states = new Map();
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "First sentence. Second sentence." }] };
  const translateBatch = jest.fn(async (entries) => entries.map(({ id, text }) => ({ id, targetText: `Batch ${text}` })));
  const run = harness({ pages: [page], states, translateBatch, settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  const old = copy(run.rendered.at(-1).translations);
  run.embed.mockClear(); run.readPage.mockClear(); run.translate.mockClear(); translateBatch.mockClear(); run.saveState.mockClear();
  const gate = deferred();
  run.translate.mockReturnValueOnce(gate.promise);
  const retry = run.controller.retranslateSentence("p1-b0-s1");
  await until(() => run.translate.mock.calls.length === 1);
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toMatchObject({ text: old["p1-b0-s1"].text, status: "done", retranslating: true });
  expect(run.rendered.at(-1).translations["p1-b0-s2"]).toEqual(old["p1-b0-s2"]);
  expect(run.translate.mock.calls[0]).toMatchObject(["First sentence.", "ko", expect.any(String), { temperature: 0.4, seed: expect.any(Number) }]);
  gate.resolve({ targetText: "새로운 첫 문장" }); await retry;
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toEqual({ status: "done", text: "새로운 첫 문장", previousTranslation: old["p1-b0-s1"] });
  expect(run.embed).not.toHaveBeenCalled(); expect(run.readPage).not.toHaveBeenCalled(); expect(translateBatch).not.toHaveBeenCalled();
  expect(run.saveState).toHaveBeenCalledTimes(1);
  const reopened = harness({ pages: [page], states, settingChanges: { llmContextTotalLimit: 4000 } });
  await reopened.controller.prepare();
  expect(reopened.rendered.at(-1).translations["p1-b0-s1"].previousTranslation).toEqual(old["p1-b0-s1"]);
  await reopened.controller.restoreSentence("p1-b0-s1");
  expect(reopened.rendered.at(-1).translations).toEqual(old);
  expect(reopened.translate).not.toHaveBeenCalled(); expect(reopened.embed).not.toHaveBeenCalled();
  const restored = harness({ pages: [page], states, settingChanges: { llmContextTotalLimit: 4000 } });
  await restored.controller.prepare();
  expect(restored.rendered.at(-1).translations).toEqual(old);
});

test.each(["reduced", "none"])("%s retries omit retrieval context and do not embed or translate other sentences", async (mode) => {
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "Previous sentence. Target sentence. Following sentence." }] };
  const run = harness({ pages: [page], settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  run.translate.mockClear(); run.embed.mockClear(); run.readPage.mockClear();
  await run.controller.retranslateSentence("p1-b0-s2", mode);
  expect(run.translate).toHaveBeenCalledTimes(1);
  const [source, , context, options] = run.translate.mock.calls[0];
  expect(source).toBe("Target sentence.");
  expect(options).toMatchObject({ temperature: 0.1, seed: expect.any(Number) });
  if (mode === "none") expect(context).toBe("");
  else expect(context).toBe("Document title: Paper title\nPrevious sentence: Previous sentence.\nFollowing sentence: Following sentence.");
  expect(run.embed).not.toHaveBeenCalled(); expect(run.readPage).not.toHaveBeenCalled();
});

test.each(["standard", "reduced", "none"])("a %s heading retry changes only that heading and persists undo across reopening", async (mode) => {
  const states = new Map();
  const page = { ...fixtures[0], blocks: [
    { id: 'previous-heading', kind: 'heading', text: '3 Method' },
    { id: 'heading', kind: 'heading', text: '3.2 Expert Parallelism' },
    ...fixtures[0].blocks,
    { id: 'following-heading', kind: 'heading', text: '4 Evaluation' },
  ] };
  const settingChanges = { llmContextTotalLimit: 4000 };
  const run = harness({ pages: [page], states, settingChanges }); await run.controller.translatePage();
  const old = copy(run.rendered.at(-1).translations);
  run.translate.mockClear(); run.embed.mockClear(); run.readPage.mockClear();
  run.translate.mockResolvedValue({ targetText: '3.2 전문가 병렬화' });
  await run.controller.retranslateSentence('heading', mode);
  expect(run.translate).toHaveBeenCalledTimes(1);
  const [source, , context, options] = run.translate.mock.calls[0];
  expect(source).toBe('3.2 Expert Parallelism');
  expect(options).toMatchObject({ temperature: mode === 'standard' ? 0.4 : 0.1, seed: expect.any(Number) });
  if (mode === 'none') expect(context).toBe('');
  if (mode === 'reduced') expect(context).toBe('Document title: Paper title\nPrevious heading: 3 Method\nFollowing heading: 4 Evaluation');
  const changed = copy(old);
  changed.heading = { status: 'done', text: '3.2 전문가 병렬화', previousTranslation: old.heading };
  expect(run.rendered.at(-1).translations).toEqual(changed);
  expect(run.embed).not.toHaveBeenCalled(); expect(run.readPage).not.toHaveBeenCalled();
  const reopened = harness({ pages: [page], states, settingChanges }); await reopened.controller.prepare();
  expect(reopened.rendered.at(-1).translations).toEqual(changed);
  await reopened.controller.restoreSentence('heading');
  expect(reopened.rendered.at(-1).translations).toEqual(old);
  expect(reopened.translate).not.toHaveBeenCalled();
});

test("a failed heading retry preserves both its existing translation and saved undo", async () => {
  const page = { ...fixtures[0], blocks: [{ id: 'heading', kind: 'heading', text: '3.2 Expert Parallelism' }, ...fixtures[0].blocks] };
  const run = harness({ pages: [page] }); await run.controller.translatePage();
  run.translate.mockResolvedValueOnce({ targetText: '3.2 전문가 병렬화' });
  await run.controller.retranslateSentence('heading', 'none');
  const old = copy(run.rendered.at(-1).translations), saved = copy([...run.states]);
  run.translate.mockRejectedValue(Object.assign(new Error('Timeout'), { code: 'TIMEOUT' })); run.saveState.mockClear();
  await run.controller.retranslateSentence('heading', 'none');
  expect(run.rendered.at(-1).translations).toEqual(old);
  expect([...run.states]).toEqual(saved); expect(run.saveState).not.toHaveBeenCalled();
  expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining('기존 번역을 유지'));
});

test("a standard retry after reopening embeds only the selected query and reuses the document index", async () => {
  const states = new Map(), settings = { llmContextTotalLimit: 4000 };
  const first = harness({ states, settingChanges: settings }); await first.controller.translateAll();
  const reopened = harness({ states, settingChanges: settings }); await reopened.controller.prepare();
  await reopened.controller.retranslateSentence("p1-b0-s1");
  expect(reopened.readPage).not.toHaveBeenCalled();
  expect(reopened.embed).toHaveBeenCalledTimes(1);
  expect(reopened.embed.mock.calls[0][0]).toEqual(["Source paragraph on page 1."]);
  expect(reopened.translate).toHaveBeenCalledTimes(1);
  expect(reopened.saveState.mock.calls.every(([, value]) => !value.index)).toBe(true);
});

test.each(["TIMEOUT", "OUTPUT_LIMIT", "EMPTY", "BROKEN"])("%s during retranslating preserves the previous result and saved snapshot", async (reason) => {
  const run = harness({ pages: [fixtures[0]] });
  await run.controller.translatePage();
  const old = copy(run.rendered.at(-1).translations), states = copy([...run.states]);
  run.saveState.mockClear();
  if (reason === "EMPTY") run.translate.mockResolvedValue({ targetText: " " });
  else if (reason === "BROKEN") run.translate.mockResolvedValue({ targetText: "bad", isBroken: true });
  else run.translate.mockRejectedValue(Object.assign(new Error(reason), { code: reason }));
  await run.controller.retranslateSentence("p1-b0-s1", "none");
  expect(run.rendered.at(-1).translations).toEqual(old);
  expect([...run.states]).toEqual(states); expect(run.saveState).not.toHaveBeenCalled();
  expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("기존 번역을 유지"));
});

test("a partial long-sentence retry never replaces the old complete sentence", async () => {
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "A long scientific clause ".repeat(80).trim() + "." }] };
  const run = harness({ pages: [page] });
  await run.controller.translatePage();
  const old = copy(run.rendered.at(-1).translations);
  run.translate.mockResolvedValueOnce({ targetText: "첫 조각만 성공" }).mockRejectedValueOnce(Object.assign(new Error("Timeout"), { code: "TIMEOUT" }));
  run.saveState.mockClear();
  await run.controller.retranslateSentence("p1-b0-s1", "none");
  expect(run.rendered.at(-1).translations).toEqual(old);
  expect(run.saveState).not.toHaveBeenCalled();
});

test("a stopped retry cannot overwrite a newer successful retry when its late response arrives", async () => {
  const run = harness({ pages: [fixtures[0]] });
  await run.controller.translatePage();
  const old = copy(run.rendered.at(-1).translations);
  const gate = deferred();
  run.translate.mockReturnValueOnce(gate.promise).mockResolvedValueOnce({ targetText: "두 번째 재번역" });
  const stopped = run.controller.retranslateSentence("p1-b0-s1", "none");
  await until(() => run.rendered.at(-1).translations["p1-b0-s1"]?.retranslating);
  run.controller.stop();
  expect(run.rendered.at(-1).translations).toEqual(old);
  await run.controller.retranslateSentence("p1-b0-s1", "none");
  gate.resolve({ targetText: "취소된 요청의 늦은 결과" }); await stopped;
  expect(run.rendered.at(-1).translations["p1-b0-s1"].text).toBe("두 번째 재번역");
});

test("cancelling during replacement persistence restores the cached old snapshot before another operation can start", async () => {
  const states = new Map(), gate = deferred();
  let writing = false;
  const saveState = jest.fn(async (key, value) => {
    if (value.translations?.["p1-b0-s1"]?.text === "Replacement") { writing = true; await gate.promise; }
    states.set(key, copy(value)); return true;
  });
  const run = harness({ pages: [fixtures[0]], states, saveState });
  await run.controller.translatePage();
  const old = copy(run.rendered.at(-1).translations);
  run.translate.mockResolvedValue({ targetText: "Replacement" });
  const retry = run.controller.retranslateSentence("p1-b0-s1", "none");
  await until(() => writing);
  run.controller.stop();
  const calls = run.translate.mock.calls.length;
  await run.controller.retranslateSentence("p1-b0-s1", "none");
  expect(run.translate).toHaveBeenCalledTimes(calls);
  gate.resolve(); await retry;
  expect(run.rendered.at(-1).translations).toEqual(old);
  expect(run.panel.setBusy).toHaveBeenLastCalledWith(false);
  const reopened = harness({ pages: [fixtures[0]], states }); await reopened.controller.prepare();
  expect(reopened.rendered.at(-1).translations).toEqual(old);
});

test("a replacement storage failure leaves the existing translation and undo record intact", async () => {
  const run = harness({ pages: [fixtures[0]] }); await run.controller.translatePage();
  await run.controller.retranslateSentence("p1-b0-s1", "none");
  const old = copy(run.rendered.at(-1).translations);
  run.saveState.mockRejectedValueOnce(new Error("Storage failure"));
  run.translate.mockResolvedValue({ targetText: "Unstored replacement" });
  await run.controller.retranslateSentence("p1-b0-s1", "none");
  expect(run.rendered.at(-1).translations).toEqual(old);
});

test("retrying a shared sentence replaces and restores its one canonical cache on both pages", async () => {
  let currentPage = 2;
  const run = harness({ pages: continuingPages, getCurrentPage: () => currentPage });
  await run.controller.translatePage(2);
  const old = copy(run.rendered.at(-1).translations), id = "p1-b0-s1";
  run.translate.mockClear(); run.saveState.mockClear();
  run.translate.mockResolvedValue({ targetText: "페이지를 걸친 새 번역" });
  await run.controller.retranslateSentence(id, "none", 2);
  expect(run.translate).toHaveBeenCalledTimes(1);
  expect(run.translate.mock.calls[0][0]).toBe("The trace is compiled into native code.");
  expect(run.saveState.mock.calls.map(([key]) => key.endsWith(":page:1"))).toEqual([true]);
  expect(run.rendered.at(-1).translations["p2-b0-s2"]).toEqual(old["p2-b0-s2"]);
  currentPage = 1; await run.controller.showPage();
  expect(run.rendered.at(-1).translations[id].text).toBe("페이지를 걸친 새 번역");
  await run.controller.restoreSentence(id, 1);
  currentPage = 2; await run.controller.showPage();
  expect(run.rendered.at(-1).translations).toEqual(old);
});

test("each successful retry has a fresh seed and undo keeps only the immediately preceding version", async () => {
  const run = harness({ pages: [fixtures[0]] }); await run.controller.translatePage();
  const random = jest.spyOn(crypto, "getRandomValues");
  run.translate.mockClear();
  run.translate.mockResolvedValueOnce({ targetText: "첫 재번역" }).mockResolvedValueOnce({ targetText: "다음 재번역" });
  await run.controller.retranslateSentence("p1-b0-s1"); await run.controller.retranslateSentence("p1-b0-s1");
  const [first, second] = run.translate.mock.calls.map((call) => call[3].seed);
  expect(Number.isInteger(first)).toBe(true); expect(Number.isInteger(second)).toBe(true);
  expect(random).toHaveBeenCalledTimes(2); random.mockRestore();
  expect(run.rendered.at(-1).translations["p1-b0-s1"].previousTranslation).toEqual({ status: "done", text: "첫 재번역" });
});

localTest("sentence retry modes work with the actual local model and keep a restorable previous result", async () => {
  const page = { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "The router assigns tokens to experts." }] };
  const run = harness({ pages: [page], translate: undefined, settingChanges: { llmContextTotalLimit: 4000 } });
  await run.controller.translatePage();
  for (const mode of ["standard", "reduced", "none"]) {
    const previous = run.rendered.at(-1).translations["p1-b0-s1"];
    await run.controller.retranslateSentence("p1-b0-s1", mode);
    const result = run.rendered.at(-1).translations["p1-b0-s1"];
    expect(result.status).toBe("done");
    expect(result.text).toMatch(/[가-힣]/);
    expect(result.text.length).toBeLessThan(150);
    expect(result.previousTranslation.text).toBe(previous.text);
  }
  const previous = run.rendered.at(-1).translations["p1-b0-s1"].previousTranslation;
  await run.controller.restoreSentence("p1-b0-s1");
  expect(run.rendered.at(-1).translations["p1-b0-s1"]).toEqual(previous);
}, 60000);

localTest("the PDF controller indexes and translates with the actual local models", async () => {
  const embed = async (input, { signal } = {}) => {
    const response = await fetch("http://localhost:11434/api/embed", {
      method: "POST", signal, headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embeddinggemma", input, truncate: false }),
    });
    if (!response.ok) throw new Error(`Embedding failed: ${response.status}`);
    return (await response.json()).embeddings;
  };
  const pages = [
    { ...fixtures[0], blocks: [{ ...fixtures[0].blocks[0], text: "The trace is compiled" }] },
    { ...fixtures[1], blocks: [{ ...fixtures[1].blocks[0], text: "into native code. A just-in-time compiler\nrecords frequently executed paths." }] },
  ];
  const run = harness({ pages, currentPage: 2, translate: undefined, translateBatch: undefined, embed,
    settingChanges: { llmContextTotalLimit: 3000 } });
  await run.controller.translatePage();
  const rendered = run.rendered.at(-1);
  expect(rendered.blocks).toHaveLength(2);
  expect(rendered.blocks[0].sourcePageNumbers).toEqual([1, 2]);
  for (const unit of rendered.blocks) {
    expect(rendered.translations[unit.id].status).toBe("done");
    expect(rendered.translations[unit.id].text).toMatch(/[가-힣]/);
    expect(rendered.translations[unit.id].text.length).toBeLessThan(150);
  }
  expect(run.saveState.mock.calls.find(([, state]) => state.index)?.[1].index[0].vector).toHaveLength(768);
}, 60000);

test('visual formulas and tables are displayed without translation requests or query embeddings',async()=>{
 const page=copy(fixtures[0]);page.blocks.push(...['formula','table'].map((kind,i)=>({id:kind,kind,text:'R S values No Yes',
  bbox:{x:20,y:250+i*60,width:200,height:40},visualRegion:{pageNumber:1,width:600,height:800,bbox:{x:20,y:250+i*60,width:200,height:40}}})));
 const run=harness({pages:[page]});await run.controller.translatePage(1);
 expect(run.translate).toHaveBeenCalledTimes(1);
 expect(run.translate.mock.calls[0][0]).toBe(fixtures[0].blocks[0].text);
 expect(run.embed.mock.calls.flatMap(c=>c[0]).some(text=>text.includes('R S values'))).toBe(false);
 expect(run.rendered.at(-1).blocks.filter(b=>b.visualRegion)).toHaveLength(2);
 expect(run.rendered.at(-1).translations.table).toEqual({status:'done',text:'R S values No Yes'});
});

test('upgrading the visual layout reparses but reuses unchanged sentence translations and chunk vectors',async()=>{
 const page=copy(fixtures[0]),source=page.blocks[0];
 source.textSpans=[{start:0,end:source.text.length,itemIndex:0,sourceStart:0,sourceEnd:source.text.length}];
 const first=harness({pages:[page]});await first.controller.translatePage(1);
 const legacy=new Map();
 for(const [key,value] of first.states){
  if(key.endsWith(':layout')){legacy.set(key,copy(value));continue;}
  const separator=key.lastIndexOf(':page:'),base=separator>=0?key.slice(0,separator):key,suffix=separator>=0?key.slice(separator):'';
  const identity=JSON.parse(base),snapshot=copy(value);
  if(identity[0]==='mtt-pdf'){identity[1]-=1;snapshot.version-=1;}
  else{const inner=JSON.parse(identity[0]);inner[1]-=1;identity[0]=JSON.stringify(inner);}
  legacy.set(JSON.stringify(identity)+suffix,snapshot);
 }
 const changed=copy(page);changed.blocks[0].id='p1-new-body';
 const second=harness({pages:[changed],states:legacy});await second.controller.translatePage(1);
 expect(second.readPage).toHaveBeenCalledTimes(1);expect(second.translate).not.toHaveBeenCalled();expect(second.embed).not.toHaveBeenCalled();
 expect(second.rendered.at(-1).translations['p1-new-body-s1'].text).toContain('Translated Source paragraph');
});

function mathPage(){
 const page=copy(fixtures[0]);page.blocks[0]={...page.blocks[0],text:'Value x.',sourceIndices:[0,1,2],textSpans:[
  {start:0,end:6,itemIndex:0,sourceStart:0,sourceEnd:6},{start:6,end:7,itemIndex:1,sourceStart:0,sourceEnd:1},
  {start:7,end:8,itemIndex:2,sourceStart:0,sourceEnd:1}]};
 page.inlineMathRegions=[{itemIndices:[1],baseline:110,fontSize:10,visualRegion:{pageNumber:1,width:600,height:800,bbox:{x:20,y:100,width:6,height:10}}}];
 return page;
}
test('inline symbols are protected before generation, cached and preserved on failed sentence retry',async()=>{
 const page=mathPage(),run=harness({pages:[page],translate:jest.fn(async()=>({targetText:'값 [M1]입니다.'}))});
 await run.controller.translatePage(1);const id='p1-b0-s1';
 expect(run.translate.mock.calls[0][0]).toBe('Value [M1].');expect(run.translate.mock.calls[0][3].preserveMath).toBe(true);
 expect(run.rendered.at(-1).blocks[0].inlineMath[0].text).toBe('x');
 run.translate.mockResolvedValue({targetText:'기호 누락'});await run.controller.retranslateSentence(id,'none',1);
 expect(run.rendered.at(-1).translations[id].text).toBe('값 [M1]입니다.');
 expect(run.panel.setStatus.mock.calls.at(-1)[0]).toContain('수학 기호');
 const next=harness({pages:[page],states:run.states,translate:jest.fn()});await next.controller.translatePage(1);
 expect(next.translate).not.toHaveBeenCalled();
});
test('a batch that loses math tokens falls back to checked sentence requests',async()=>{
 const page=mathPage();const second=copy(page.blocks[0]);second.id='second';
 second.sourceIndices=second.sourceIndices.map(i=>i+3);second.textSpans=second.textSpans.map(s=>({...s,itemIndex:s.itemIndex+3}));page.blocks.push(second);
 page.inlineMathRegions.push({...page.inlineMathRegions[0],itemIndices:[4]});
 const translate=jest.fn(async()=>({targetText:'값 [M1]'}));
 const run=harness({pages:[page],translate,translateBatch:jest.fn(async(entries)=>entries.map(e=>({id:e.id,targetText:'기호를 잃은 번역'})))});
 await run.controller.translatePage(1);expect(run.translateBatch.mock.calls[0][0].every(e=>e.text.includes('[M1]'))).toBe(true);
 expect(translate).toHaveBeenCalledTimes(2);expect(Object.values(run.rendered.at(-1).translations).every(t=>t.status==='done')).toBe(true);
});
test('old completed translations without required math tokens are retried without invalidating unaffected content',async()=>{
 const page=mathPage(),states=new Map(),first=harness({pages:[page],states,translate:jest.fn(async()=>({targetText:'값 [M1]'}))});
 await first.controller.translatePage(1);
 for(const [key,state]of states)if(key.endsWith(':page:1'))state.translations['p1-b0-s1'].text='오래된 평문 x';
 const translate=jest.fn(async()=>({targetText:'새 값 [M1]'})),next=harness({pages:[page],states,translate});
 await next.controller.translatePage(1);expect(translate).toHaveBeenCalledTimes(1);
 expect(next.rendered.at(-1).translations['p1-b0-s1'].text).toBe('새 값 [M1]');
});


test("installed PDF API mode brokers document/query embeddings, batch translation and sentence retry", async () => {
  browser.runtime = { connect: jest.fn() };
  requestPdfApi.mockImplementation(async payload => {
    if (payload.operation === "embed") return payload.input.map(() => [1, 0]);
    if (payload.operation === "translateBatch") return batchAnswer(payload.entries);
    return { targetText: "다시 번역한 문장입니다.", sourceLang: "en" };
  });
  const fetchSpy = jest.spyOn(global, "fetch").mockRejectedValue(new Error("Viewer fetch must not run"));
  try {
    const run = harness({ pages: [batchPage], embed: undefined, translate: undefined, translateBatch: undefined,
      settingChanges: { llmExecution: "api", llmApiEndpoint: "http://lab.example:9000/v1", llmApiKey: "private-key", embeddingApiEndpoint: "http://embed.example:9001", embeddingModel: "embeddinggemma", llmContextTotalLimit: 4000 } });
    await run.controller.translatePage();
    expect(requestPdfApi.mock.calls.map(([payload]) => payload.operation)).toEqual(["embed", "embed", "translateBatch"]);
    expect(Object.values(run.rendered.at(-1).translations).every(result => result.status === "done")).toBe(true);
    await run.controller.retranslateSentence(run.rendered.at(-1).blocks[0].id, "standard");
    expect(requestPdfApi.mock.calls.at(-1)[0]).toMatchObject({ operation: "translate", options: { temperature: 0.4, seed: expect.any(Number) } });
    for (const [payload, options] of requestPdfApi.mock.calls) {
      expect(payload.configuration).toEqual(payload.operation === "embed" ? { endpoint: "http://embed.example:9001", model: "embeddinggemma", type: "ollama" } : { endpoint: "http://lab.example:9000/v1", model: "hy-mt2:1.8b-q8" });
      expect(JSON.stringify(payload)).not.toContain("private-key");
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { delete browser.runtime; requestPdfApi.mockReset(); fetchSpy.mockRestore(); }
});

test("an installed PDF never falls back to viewer fetch after background connection failure", async () => {
  browser.runtime = { connect: jest.fn() };
  requestPdfApi.mockRejectedValue(Object.assign(new Error("Disconnected"), { code: "PDF_API_DISCONNECTED" }));
  const fetchSpy = jest.spyOn(global, "fetch");
  try {
    const run = harness({ pages: [fixtures[0]], embed: undefined });
    await run.controller.translatePage();
    expect(run.panel.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("백그라운드 연결이 끊겼습니다"));
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { delete browser.runtime; requestPdfApi.mockReset(); fetchSpy.mockRestore(); }
});
