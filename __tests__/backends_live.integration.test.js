// Opt-in: sends only the synthetic text below to the lab API; normal tests make no requests.
import fs from 'node:fs';
import path from 'node:path';
jest.mock('webextension-polyfill', () => ({ runtime: { id: 'paper-live-check', getURL: value => `chrome-extension://paper-live-check/${value}`,
  onConnect: { addListener: jest.fn() }, connect: jest.fn() }, storage: { local: { get: jest.fn() } },
  permissions: { contains: jest.fn(async () => true) }, i18n: { detectLanguage: jest.fn(async () => ({ languages: [{ language: 'en' }] })) } }));
import browser from 'webextension-polyfill';
import { defaultData } from '../src/settings.js';
import { createPdfTranslationController } from '../src/pdf/document_translation.js';
import { registerPdfApiBroker } from '../src/pdf/api_broker.js';
import { requestPdfApi, PDF_API_PORT } from '../src/pdf/api_client.js';
const live = process.env.PAPER_LIVE_BACKENDS === '1' ? test : test.skip;
const event = () => { const handlers = new Set(); return { addListener: fn => handlers.add(fn), fire: value => handlers.forEach(fn => fn(value)) }; };
const copy = value => value == null ? value : structuredClone(value);

live('new controller → port → saved-config broker → actual lab Ollama; cache and sentence retry', async () => {
  const endpoint = process.env.PAPER_LIVE_API_ENDPOINT;
  if (!endpoint) throw new Error('Set PAPER_LIVE_API_ENDPOINT to the authorized Ollama /v1 endpoint.');
  const embeddingEndpoint = process.env.PAPER_LIVE_EMBEDDING_ENDPOINT || endpoint.replace(/\/v1\/?$/, '');
  const proofDirectory = path.resolve(__dirname, '../../output/paper-backend-check');
  fs.mkdirSync(proofDirectory, { recursive: true });
  const proof = { checkedAt: new Date().toISOString(), syntheticOnly: true, realChrome: false,
    transport: 'New controller → requestPdfApi → simulated Chrome runtime Port → actual background broker → real HTTP API',
    requests: [], errors: [] };
  const saveProof = () => fs.writeFileSync(path.join(proofDirectory, 'result.json'), JSON.stringify(proof, null, 2) + '\n');
  const actualFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const started = Date.now();
    let body; try {
      const raw = typeof options.body === 'string' ? options.body : url instanceof Request && url.method !== 'GET' ? await url.clone().text() : '';
      body = raw ? JSON.parse(raw) : null;
    } catch (_) {}
    const record = { url: typeof url === 'string' ? url : url.url, method: options.method || url.method || 'GET', ...(body?.model ? { model: body.model } : {}),
      ...(Array.isArray(body?.input) ? { inputCount: body.input.length } : {}),
      ...(body?.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body?.seed !== undefined ? { seed: body.seed } : {}) };
    proof.requests.push(record);
    try {
      const response = await actualFetch(url, options);
      record.status = response.status; record.elapsedMs = Date.now() - started;
      return response;
    } catch (error) { record.error = error.message; record.elapsedMs = Date.now() - started; throw error; }
  };
  const settings = { ...defaultData, llmExecution: 'api', llmApiEndpoint: endpoint, llmApiKey: '', llmModel: 'hy-mt2:1.8b-q8',
    embeddingExecution: 'api', embeddingApiEndpoint: embeddingEndpoint, embeddingApiKey: '', embeddingModel: 'embeddinggemma', embeddingApiType: 'ollama',
    translateTarget: 'ko', llmContextTotalLimit: 2400 };
  proof.configuration = { translation: { execution: settings.llmExecution, endpoint: settings.llmApiEndpoint, model: settings.llmModel },
    embedding: { execution: settings.embeddingExecution, endpoint: settings.embeddingApiEndpoint, model: settings.embeddingModel, type: settings.embeddingApiType } };
  const controllers = [];
  try {
    // One bounded reachability check only. Do not alter or troubleshoot an unavailable server.
    try {
      const available = await fetch(`${embeddingEndpoint.replace(/\/+$/, '')}/api/version`, { signal: AbortSignal.timeout(10000) });
      if (!available.ok) throw new Error(`HTTP ${available.status}`);
      proof.serverVersion = (await available.json()).version; proof.available = true;
    } catch (error) { proof.available = false; proof.errors.push(`Remote unavailable: ${error.message}`); saveProof(); return; }
    browser.storage.local.get.mockImplementation(async keys => Object.fromEntries(keys.map(key => [key, settings[key]])));
    registerPdfApiBroker();
    const accept = browser.runtime.onConnect.addListener.mock.calls[0][0];
    browser.runtime.connect.mockImplementation(({ name }) => {
      if (name !== PDF_API_PORT) throw new Error(`Unexpected port ${name}`);
      const client = { onMessage: event(), onDisconnect: event() }, server = { name,
        sender: { id: browser.runtime.id, url: browser.runtime.getURL('pdfjs/web/viewer.html') }, onMessage: event(), onDisconnect: event() };
      let disconnected = false;
      const disconnect = () => { if (disconnected) return; disconnected = true; server.onDisconnect.fire(); client.onDisconnect.fire(); };
      client.disconnect = disconnect; server.disconnect = disconnect;
      client.postMessage = message => queueMicrotask(() => { if (!disconnected) server.onMessage.fire(message); });
      server.postMessage = message => { if (!disconnected) client.onMessage.fire(message); };
      queueMicrotask(() => accept(server));
      return client;
    });
    const modelIdentity = await requestPdfApi({ operation: 'modelIdentity', service: 'translation', configuration: { endpoint: settings.llmApiEndpoint, model: settings.llmModel } });
    const embeddingModelIdentity = await requestPdfApi({ operation: 'modelIdentity', service: 'embedding', configuration: { endpoint: settings.embeddingApiEndpoint, model: settings.embeddingModel, type: settings.embeddingApiType } });
    proof.modelIdentity = { translation: modelIdentity, embedding: embeddingModelIdentity };
    const source = ['In this spreadsheet, a cell contains a formula.', 'Expert parallelism distributes experts across GPUs.', 'Our synthetic experiment uses eight devices.'];
    const page = { pageNumber: 1, width: 600, height: 800, mode: 'single', warnings: [],
      blocks: source.map((text, i) => ({ id: `p1-b${i}`, text, kind: 'paragraph', bbox: { x: 40, y: 150 + i * 50, width: 500, height: 20 } })) };
    proof.source = source;
    const states = new Map();
    function makeController() {
      const panel = Object.fromEntries(['setStatus', 'setProgress', 'setBusy', 'setIndexReady', 'destroy', 'setError'].map(name => [name, jest.fn()]));
      panel.showPage = jest.fn();
      const readPage = jest.fn(async () => copy(page));
      const controller = createPdfTranslationController({ pdfDocument: { numPages: 1, getPage: async () => ({ pageNumber: 1 }) }, panel, settings,
        documentId: 'synthetic-live-paper', title: 'Synthetic lab pipeline test', modelIdentity, embeddingModelIdentity, readPage,
        loadState: async key => copy(states.get(key)) || null, saveState: async (key, value) => { states.set(key, copy(value)); return true; } });
      controllers.push(controller);
      return { controller, panel, readPage, results: () => copy(panel.showPage.mock.calls.at(-1)?.[0]?.translations || {}) };
    }
    const first = makeController(), started = Date.now();
    await first.controller.translatePage(1);
    const translations = first.results();
    proof.initialElapsedMs = Date.now() - started;
    proof.initialTranslations = translations;
    proof.initialStatuses = first.panel.setStatus.mock.calls.map(([message]) => message);
    expect(Object.keys(translations)).toHaveLength(3);
    expect(Object.values(translations).every(result => result.status === 'done' && result.text)).toBe(true);
    const savedIndex = [...states.values()].find(value => Array.isArray(value.index));
    proof.index = { chunks: savedIndex.index.length, dimensions: [...new Set(savedIndex.index.map(chunk => chunk.vector.length))] };
    expect(proof.index.chunks).toBe(3); expect(proof.index.dimensions).toEqual([768]);
    const countBeforeReopen = proof.requests.length, reopened = makeController();
    await reopened.controller.translatePage(1);
    proof.cacheReuse = { networkRequests: proof.requests.length - countBeforeReopen, parsedPages: reopened.readPage.mock.calls.length,
      translationsUnchanged: JSON.stringify(reopened.results()) === JSON.stringify(translations) };
    expect(proof.cacheReuse).toEqual({ networkRequests: 0, parsedPages: 0, translationsUnchanged: true });
    const retryId = Object.keys(translations)[0], before = reopened.results(), countBeforeRetry = proof.requests.length;
    await reopened.controller.retranslateSentence(retryId, 'standard', 1);
    const after = reopened.results();
    proof.retry = { id: retryId, before: before[retryId], after: after[retryId],
      otherTranslationsUnchanged: Object.keys(before).filter(id => id !== retryId).every(id => JSON.stringify(before[id]) === JSON.stringify(after[id])),
      requests: proof.requests.slice(countBeforeRetry) };
    expect(after[retryId].status).toBe('done'); expect(after[retryId].previousTranslation.text).toBe(before[retryId].text);
    expect(proof.retry.otherTranslationsUnchanged).toBe(true);
    expect(proof.retry.requests.filter(request => request.url.endsWith('/chat/completions'))).toHaveLength(1);
    expect(proof.retry.requests.find(request => request.url.endsWith('/chat/completions')).temperature).toBe(.4);
    proof.success = true;
  } catch (error) {
    proof.success = false; proof.errors.push(error.stack || error.message); throw error;
  } finally {
    for (const controller of controllers) controller.destroy();
    global.fetch = actualFetch; saveProof();
  }
}, 180000);
