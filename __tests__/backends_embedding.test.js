import { embedWithOllama, fetchOllamaModelIdentity, checkApiConnection, requireLlmEndpoint } from '../src/pdf/ollama_api.js';
jest.mock('../src/i18n.js', () => ({ getMessage: () => '' }));
const settings = { llmApiEndpoint: 'https://translation.example/v1', llmApiKey: 'translation-secret', llmModel: 'translator',
  embeddingExecution: 'api', embeddingApiEndpoint: 'https://vectors.example/v1', embeddingApiKey: 'embedding-secret', embeddingModel: 'embed-model', embeddingApiType: 'ollama' };
beforeEach(() => { global.fetch = jest.fn(); });

test('Ollama embeddings use only their own endpoint, key and model', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ embeddings: [[1, 0], [0, 1]] }) });
  await expect(embedWithOllama(['A', 'B'], settings)).resolves.toEqual([[1, 0], [0, 1]]);
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('https://vectors.example/api/embed');
  expect(options.headers.Authorization).toBe('Bearer embedding-secret');
  expect(options.redirect).toBe('error');
  expect(JSON.parse(options.body)).toEqual({ model: 'embed-model', input: ['A', 'B'], truncate: false });
});

test('OpenAI embeddings preserve caller order using validated indices', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }) });
  await expect(embedWithOllama(['A', 'B'], { ...settings, embeddingApiType: 'openai' })).resolves.toEqual([[1, 0], [0, 1]]);
  expect(fetch.mock.calls[0][0]).toBe('https://vectors.example/v1/embeddings');
});

test.each([
  { embeddings: [[1, 0]] }, { embeddings: [[1, 0], [0]] }, { embeddings: [[1, 0], [0, NaN]] }, { embeddings: [[1, 0], [0, 0]] },
])('rejects malformed vectors instead of poisoning the RAG index', async data => {
  fetch.mockResolvedValue({ ok: true, json: async () => data });
  await expect(embedWithOllama(['A', 'B'], settings)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('duplicate OpenAI response indices are rejected', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] }) });
  await expect(embedWithOllama(['A', 'B'], { ...settings, embeddingApiType: 'openai' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('identity requests select the specified service and tolerate unsupported metadata', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'embed-model:latest', digest: 'digest' }, { name: 'translator', digest: 'other' }] }) });
  await expect(fetchOllamaModelIdentity(settings, { service: 'embedding' })).resolves.toEqual([['embed-model:latest', 'digest']]);
  expect(fetch.mock.calls[0][0]).toBe('https://vectors.example/api/tags');
  fetch.mockRejectedValue(new TypeError('offline'));
  await expect(fetchOllamaModelIdentity(settings)).resolves.toEqual([]);
});

test('connection check reports missing selected model and propagates denied access', async () => {
  fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'another-model' }] }) });
  await expect(checkApiConnection(settings)).resolves.toEqual({ ok: true, modelAvailable: false, models: ['another-model'] });
  expect(fetch.mock.calls[0][0]).toBe('https://translation.example/v1/models');
  fetch.mockResolvedValue({ ok: false, status: 403 });
  await expect(checkApiConnection(settings, { service: 'embedding' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 403 });
});

test('cancelled responses are ignored and URL credentials are rejected', async () => {
  const controller = new AbortController();
  fetch.mockImplementation(async () => { controller.abort(); return { ok: true, json: async () => ({ embeddings: [[1]] }) }; });
  await expect(embedWithOllama(['A'], settings, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => requireLlmEndpoint('https://user:secret@vectors.example/v1')).toThrow();
  expect(() => requireLlmEndpoint('file:///etc/passwd')).toThrow();
});
