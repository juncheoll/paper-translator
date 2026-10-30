jest.mock('webextension-polyfill', () => ({
  runtime: { id: 'paper-extension', getURL: path => `chrome-extension://paper-extension/${path}`, onConnect: { addListener: jest.fn() }, connect: jest.fn() },
  storage: { local: { get: jest.fn() } }, permissions: { contains: jest.fn() },
}));
jest.mock('../src/settings.js', () => ({ defaultData: {} }));
jest.mock('../src/services/translation.js', () => ({ __esModule: true, default: { translateStrict: jest.fn(), translateBatchStrict: jest.fn() } }));
jest.mock('../src/pdf/ollama_api.js', () => ({ ...jest.requireActual('../src/pdf/ollama_api.js'), embedWithOllama: jest.fn(), fetchOllamaModelIdentity: jest.fn(), checkApiConnection: jest.fn() }));
jest.mock('../src/i18n.js', () => ({ getMessage: () => '' }));
import browser from 'webextension-polyfill';
import TranslationService from '../src/services/translation.js';
import { embedWithOllama, fetchOllamaModelIdentity, checkApiConnection } from '../src/pdf/ollama_api.js';
import { registerPdfApiBroker } from '../src/pdf/api_broker.js';
import { PDF_API_PORT, requestPdfApi } from '../src/pdf/api_client.js';
const settings = { llmExecution: 'api', llmApiEndpoint: 'https://translation.example/v1', llmApiKey: 'translation-secret', llmModel: 'translator',
  embeddingExecution: 'api', embeddingApiEndpoint: 'https://vectors.example/v1', embeddingApiKey: 'embedding-secret', embeddingModel: 'embedder', embeddingApiType: 'ollama' };
const translation = { endpoint: settings.llmApiEndpoint, model: settings.llmModel };
const embedding = { endpoint: settings.embeddingApiEndpoint, model: settings.embeddingModel, type: 'ollama' };
const event = () => { const handlers = new Set(); return { addListener: fn => handlers.add(fn), fire: value => handlers.forEach(fn => fn(value)) }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let accept, client, server;
beforeAll(() => { registerPdfApiBroker(); accept = browser.runtime.onConnect.addListener.mock.calls[0][0]; });
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks();
  browser.storage.local.get.mockResolvedValue(settings); browser.permissions.contains.mockResolvedValue(true);
  embedWithOllama.mockResolvedValue([[1, 0]]); fetchOllamaModelIdentity.mockResolvedValue([]);
  checkApiConnection.mockResolvedValue({ ok: true, modelAvailable: true, models: ['translator'] });
  TranslationService.translateStrict.mockResolvedValue({ targetText: '번역' });
  client = { onMessage: event(), onDisconnect: event(), postMessage: jest.fn(), disconnect: jest.fn() };
  server = { name: PDF_API_PORT, sender: { id: 'paper-extension', url: 'chrome-extension://paper-extension/pdfjs/web/viewer.html?file=test.pdf' },
    onMessage: event(), onDisconnect: event(), postMessage: jest.fn(), disconnect: jest.fn() };
  server.postMessage.mockImplementation(message => client.onMessage.fire(message));
  let disconnected = false;
  const disconnect = () => { if (disconnected) return; disconnected = true; server.onDisconnect.fire(); client.onDisconnect.fire(); };
  client.disconnect.mockImplementation(disconnect); server.disconnect.mockImplementation(disconnect);
  browser.runtime.connect.mockImplementation(() => { Promise.resolve().then(() => accept(server)); return client; });
  client.postMessage.mockImplementation(message => Promise.resolve().then(() => server.onMessage.fire(message)));
});
afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

test('embedding uses independent saved configuration while translation can run in the browser', async () => {
  browser.storage.local.get.mockResolvedValue({ ...settings, llmExecution: 'browser' });
  await expect(requestPdfApi({ operation: 'embed', input: ['Source'], configuration: embedding })).resolves.toEqual([[1, 0]]);
  expect(embedWithOllama.mock.calls[0][1]).toMatchObject({ embeddingApiKey: 'embedding-secret', llmExecution: 'browser' });
  expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: ['https://vectors.example/*'] });
  expect(client.postMessage.mock.calls[0][0].payload).not.toHaveProperty('apiKey');
});

test('translation can use its API while embeddings run in the browser', async () => {
  browser.storage.local.get.mockResolvedValue({ ...settings, embeddingExecution: 'browser' });
  await expect(requestPdfApi({ operation: 'translate', configuration: translation, text: 'Source', target: 'ko', options: { temperature: .4, seed: 42 } })).resolves.toMatchObject({ targetText: '번역' });
  expect(TranslationService.translateStrict.mock.calls[0][3].llmApiKey).toBe('translation-secret');
  expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: ['https://translation.example/*'] });
});

test('embedding rejects the translation address and stale embedding format', async () => {
  await expect(requestPdfApi({ operation: 'embed', input: ['Source'], configuration: translation })).rejects.toMatchObject({ code: 'PDF_API_CONFIG_CHANGED' });
  await expect(requestPdfApi({ operation: 'embed', input: ['Source'], configuration: { ...embedding, type: 'openai' } })).rejects.toMatchObject({ code: 'PDF_API_CONFIG_CHANGED' });
  expect(embedWithOllama).not.toHaveBeenCalled();
});

test.each([
  { id: 'paper-extension', url: 'https://arxiv.org/pdf/paper.pdf' },
  { id: 'another-extension', url: 'chrome-extension://paper-extension/pdfjs/web/viewer.html' },
  { id: 'paper-extension', url: 'chrome-extension://paper-extension/offscreen.html' }, {},
])('untrusted senders never access saved server credentials', async sender => {
  server.sender = sender;
  await expect(requestPdfApi({ operation: 'embed', input: ['Source'], configuration: embedding })).rejects.toMatchObject({ code: 'PDF_API_DISCONNECTED' });
  expect(browser.storage.local.get).not.toHaveBeenCalled();
});

test('settings can check a configured service but cannot submit translation data', async () => {
  server.sender.url = 'chrome-extension://paper-extension/settings.html';
  await expect(requestPdfApi({ operation: 'check', service: 'translation', configuration: translation })).resolves.toMatchObject({ ok: true });
  expect(checkApiConnection.mock.calls[0][1].service).toBe('translation');
  await expect(requestPdfApi({ operation: 'translate', text: 'Source', target: 'ko', configuration: translation })).rejects.toMatchObject({ code: 'PDF_API_REQUEST' });
  expect(TranslationService.translateStrict).not.toHaveBeenCalled();
});

test('identity selects the embedding service and preserves selected configuration', async () => {
  await requestPdfApi({ operation: 'modelIdentity', service: 'embedding', configuration: embedding });
  expect(fetchOllamaModelIdentity.mock.calls[0][1].service).toBe('embedding');
});

test('caller URLs and options cannot turn broker into an arbitrary proxy', async () => {
  await expect(requestPdfApi({ operation: 'translate', configuration: translation, text: 'Source', target: 'ko', url: 'https://other.example' })).rejects.toMatchObject({ code: 'PDF_API_REQUEST' });
  await expect(requestPdfApi({ operation: 'translate', configuration: translation, text: 'Source', target: 'ko', options: { endpoint: 'https://other.example' } })).rejects.toMatchObject({ code: 'PDF_API_REQUEST' });
});

test('disconnection aborts upstream work and ignores late results', async () => {
  let resolve; embedWithOllama.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = requestPdfApi({ operation: 'embed', input: ['Source'], configuration: embedding });
  await flush(); server.disconnect();
  await expect(pending).rejects.toMatchObject({ code: 'PDF_API_DISCONNECTED' });
  expect(embedWithOllama.mock.calls[0][2].signal.aborted).toBe(true);
  resolve([[9, 9]]); await flush(); expect(server.postMessage).not.toHaveBeenCalled();
});

test('typed upstream status and deadline survive broker transport', async () => {
  embedWithOllama.mockRejectedValueOnce(Object.assign(new Error('Denied'), { code: 'HTTP_ERROR', status: 403 }));
  await expect(requestPdfApi({ operation: 'embed', input: ['Source'], configuration: embedding })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 403 });
  embedWithOllama.mockImplementation(() => new Promise(() => {}));
  const pending = requestPdfApi({ operation: 'embed', input: ['Source'], configuration: embedding });
  await flush(); const rejected = expect(pending).rejects.toMatchObject({ code: 'PDF_API_TIMEOUT' });
  await jest.advanceTimersByTimeAsync(75000); await rejected;
});
