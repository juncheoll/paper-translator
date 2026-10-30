jest.mock('webextension-polyfill', () => ({
  runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}` },
  storage: { local: { get: jest.fn() } },
}));
jest.mock('../src/services/docling_uploads.js', () => ({ takeDoclingUpload: jest.fn(), purgeDoclingUploads: jest.fn() }));
import { doclingConfiguration } from '../src/services/docling_config.js';
import { executeDoclingRequest, trustedDoclingSender } from '../src/services/docling_broker.js';
import { createDoclingLayoutClient } from '../src/pdf/docling_layout.js';

const documentId = 'a'.repeat(64), identity = 'b'.repeat(64);
const settings = { doclingExecution: 'server', doclingApiEndpoint: 'https://layout.example.org/docling/', doclingApiKey: 'secret' };
const configuration = doclingConfiguration(settings);
const makeRequest = () => jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ schema: 1 }) }));
const invoke = (payload, options = {}) => executeDoclingRequest({ configuration, ...payload }, new AbortController().signal,
  { readSettings: async () => settings, ...options });

test('local/server config stays independent and rejects embedded credentials and query strings', () => {
  expect(doclingConfiguration({})).toEqual({ execution: 'local', endpoint: 'http://127.0.0.1:8876' });
  expect(configuration.endpoint).toBe('https://layout.example.org/docling');
  expect(() => doclingConfiguration({ ...settings, doclingApiEndpoint: 'https://user:pass@example.org' })).toThrow();
  expect(() => doclingConfiguration({ ...settings, doclingApiEndpoint: 'https://example.org?key=secret' })).toThrow();
});

test('only exact extension viewer/settings senders can access the Docling API', () => {
  expect(trustedDoclingSender({ id: 'test-extension', url: 'chrome-extension://test-extension/settings.html' })).toBe(true);
  expect(trustedDoclingSender({ id: 'test-extension', url: 'chrome-extension://test-extension/pdfjs/web/viewer.html?file=x' })).toBe(true);
  expect(trustedDoclingSender({ id: 'test-extension', url: 'https://example.org/settings.html' })).toBe(false);
  expect(trustedDoclingSender({ id: 'other', url: 'chrome-extension://test-extension/settings.html' })).toBe(false);
});

test('broker derives URL and token from saved settings and sends credentials only to that endpoint', async () => {
  const request = makeRequest();
  await invoke({ operation: 'info' }, { request });
  expect(request).toHaveBeenCalledWith('https://layout.example.org/docling/v1/info', expect.objectContaining({
    credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer secret' },
  }));
  await expect(invoke({ operation: 'info', configuration: { ...configuration, endpoint: 'https://evil.example' } }, { request }))
    .rejects.toMatchObject({ code: 'DOCLING_CONFIG_CHANGED' });
  expect(request).toHaveBeenCalledTimes(1);
});

test('server requests omit Authorization when the saved API key is empty', async () => {
  const request = makeRequest();
  await invoke({ operation: 'info' }, { request,
    readSettings: async () => ({ ...settings, doclingApiKey: '' }),
  });
  expect(request).toHaveBeenCalledWith('https://layout.example.org/docling/v1/info', expect.objectContaining({
    headers: {}, credentials: 'omit', redirect: 'error',
  }));
  expect(request.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
});

test('cache miss is returned without upload; HTTP403 is preserved', async () => {
  const request = jest.fn(async () => ({ ok: false, status: 404 }));
  expect(await invoke({ operation: 'cache', documentId }, { request })).toBeNull();
  await expect(invoke({ operation: 'info' }, { request: async () => ({ ok: false, status: 403 }) }))
    .rejects.toMatchObject({ code: 'DOCLING_HTTP_ERROR', status: 403 });
});

test('analysis consumes only an upload ID and sends the original PDF Blob', async () => {
  const body = new Blob(['%PDF-1.7\nfixture'], { type: 'application/pdf' });
  const request = makeRequest(), takeUpload = jest.fn(async () => body);
  await invoke({ operation: 'analyze', documentId, uploadId: '12345678-1234-1234-1234-123456789abc' }, { request, takeUpload });
  expect(takeUpload).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST', body, headers: { 'Content-Type': 'application/pdf' } });
  await expect(invoke({ operation: 'analyze', documentId, uploadId: '../../private' }, { request, takeUpload }))
    .rejects.toMatchObject({ code: 'DOCLING_API_REQUEST' });
});

test('server failure never starts the local Native helper, and endpoint caches stay separate', async () => {
  const ensureService = jest.fn(), loadState = jest.fn(async () => null);
  const load = createDoclingLayoutClient({ pdfDocument: { numPages: 1 }, documentId, settings,
    fetch: async () => { throw new TypeError('offline'); }, ensureService, loadState, saveState: jest.fn() });
  expect(await load()).toMatchObject({ warning: 'unavailable', pages: [] });
  expect(ensureService).not.toHaveBeenCalled();
  expect(loadState.mock.calls[0][0]).toContain('https://layout.example.org/docling');
});

test('same endpoint cached geometry remains usable offline without replacing text or positions', async () => {
  const data = { schema: 1, documentId, identity, pages: [{ pageNumber: 1, width: 600, height: 800, regions: [] }] };
  const load = createDoclingLayoutClient({ pdfDocument: { numPages: 1 }, documentId, settings,
    fetch: async () => { throw new TypeError('offline'); }, loadState: async () => data });
  expect(await load()).toMatchObject({ warning: 'cached-offline', pages: data.pages });
});

test('cancellation aborts the upstream fetch', async () => {
  const controller = new AbortController();
  let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const request = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError'))); begin();
  });
  const pending = executeDoclingRequest({ operation: 'info', configuration }, controller.signal, { readSettings: async () => settings, request });
  await started; controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
