const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
jest.mock('webextension-polyfill', () => ({ storage: { local: { get: jest.fn(), set: jest.fn() } } }));
jest.mock('../src/browser_ai/client.js', () => ({ requestBrowserAi: jest.fn() }));
jest.mock('../src/docling_helper/client.js', () => ({ requestDoclingHelper: jest.fn() }));
jest.mock('../src/pdf/api_client.js', () => ({ requestPdfApi: jest.fn() }));
jest.mock('../src/services/docling_client.js', () => ({ requestDoclingApi: jest.fn() }));

let dom, browser, requestBrowserAi, requestPdfApi, requestDoclingApi;
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = { webgpu: true, models: {
  translation: { name: 'Hy-MT2', cached: true, loaded: true },
  embedding: { name: 'EmbeddingGemma', cached: true, loaded: false },
} };

beforeEach(async () => {
  jest.resetModules();
  dom = new JSDOM(fs.readFileSync(path.join(__dirname, '../public/settings.html'), 'utf8'), { url: 'https://extension.test/settings.html' });
  global.window = dom.window; global.document = dom.window.document; global.Option = dom.window.Option;
  browser = require('webextension-polyfill');
  ({ requestBrowserAi } = require('../src/browser_ai/client.js'));
  ({ requestPdfApi } = require('../src/pdf/api_client.js'));
  ({ requestDoclingApi } = require('../src/services/docling_client.js'));
  browser.storage.local.get.mockResolvedValue({}); browser.storage.local.set.mockResolvedValue();
  requestBrowserAi.mockResolvedValue(state);
  requestPdfApi.mockResolvedValue({ ok: true, modelAvailable: true, models: ['custom-embed'] });
  requestDoclingApi.mockResolvedValue({ schema: 1, modelLoaded: true });
  require('../src/settings_ui.js');
  await tick();
});

afterEach(() => { dom.window.close(); delete global.window; delete global.document; delete global.Option; });

function setField(name, value) {
  const input = document.querySelector(`[name="${name}"]`);
  if (input.type === 'checkbox') input.checked = value; else input.value = value;
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

test('all settings have labeled controls and execution selections reveal independently', () => {
  const { defaultData } = require('../src/settings.js');
  for (const key of Object.keys(defaultData)) {
    const input = document.querySelector(`[name="${key}"]`);
    expect(input).not.toBeNull();
    expect(input.closest('label')).not.toBeNull();
  }
  setField('llmExecution', 'browser');
  setField('doclingExecution', 'server');
  expect(document.querySelector('[data-show="llmExecution:browser"]').hidden).toBe(false);
  expect(document.querySelector('[data-show="llmExecution:api"]').hidden).toBe(true);
  expect(document.querySelector('[data-show="embeddingExecution:api"]').hidden).toBe(false);
  expect(document.querySelector('[data-show="doclingExecution:server"]').hidden).toBe(false);
  expect(document.querySelector('#save-status').textContent).toContain('저장하지 않은');
});

test('save and embedding check preserve separate endpoints, keys and execution choices', async () => {
  setField('llmExecution', 'browser');
  setField('embeddingApiEndpoint', 'https://embed.example.org/v1');
  setField('embeddingModel', 'custom-embed');
  setField('embeddingApiKey', 'embed-secret');
  setField('embeddingApiType', 'openai');
  document.querySelector('[data-action="check-embedding"]').click();
  await tick();
  expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({
    llmExecution: 'browser', embeddingExecution: 'api', embeddingApiEndpoint: 'https://embed.example.org/v1',
    embeddingApiKey: 'embed-secret', embeddingApiType: 'openai', doclingExecution: 'local',
  }));
  expect(requestPdfApi).toHaveBeenCalledWith({ operation: 'check', service: 'embedding',
    configuration: { endpoint: 'https://embed.example.org/v1', model: 'custom-embed', type: 'openai' } }, expect.objectContaining({ signal: expect.anything() }));
  expect(document.querySelector('[data-status="embedding"]').textContent).toContain('서버 연결 성공');
  expect(requestDoclingApi).not.toHaveBeenCalled();
});

test('browser model preparation can be cancelled without changing saved settings', async () => {
  requestBrowserAi.mockImplementationOnce((_payload, options) => new Promise((_resolve, reject) => {
    options.onProgress({ phase: 'download', progress: .5 });
    options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
  }));
  setField('llmExecution', 'browser');
  document.querySelector('[data-action="prepare-translation"]').click();
  expect(document.querySelector('[data-progress="translation"]').value).toBe(.5);
  expect(document.querySelector('[data-action="prepare-translation"]').disabled).toBe(true);
  document.querySelector('[data-cancel="translation"]').click();
  await tick();
  expect(requestBrowserAi).toHaveBeenCalledWith({ operation: 'prepare', model: 'translation' }, expect.anything());
  expect(document.querySelector('[data-status="translation"]').textContent).toContain('취소');
  expect(document.querySelector('[data-action="prepare-translation"]').disabled).toBe(false);
  expect(document.querySelector('[data-cancel="translation"]').hidden).toBe(true);
  expect(browser.storage.local.set).not.toHaveBeenCalled();
});

test('remote layout check saves independent config and uses the Docling API', async () => {
  setField('doclingExecution', 'server');
  setField('doclingApiEndpoint', 'https://layout.example.org');
  setField('doclingApiKey', 'layout-secret');
  document.querySelector('[data-action="check-docling"]').click();
  await tick();
  expect(requestDoclingApi).toHaveBeenCalledWith({ operation: 'info' }, expect.objectContaining({ signal: expect.anything() }));
  expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ doclingExecution: 'server', doclingApiKey: 'layout-secret' }));
  expect(document.querySelector('[data-status="docling"]').textContent).toContain('서버 연결 성공');
});

test('invalid settings are shown and never sent to a server', async () => {
  setField('llmApiEndpoint', 'file:///private/file');
  document.querySelector('[data-action="check-translation"]').click();
  await tick();
  expect(browser.storage.local.set).not.toHaveBeenCalled();
  expect(requestPdfApi).not.toHaveBeenCalled();
  expect(document.querySelector('#save-status').dataset.error).toBe('true');
  expect(document.querySelector('[data-status="translation"]').dataset.error).toBe('true');
});
