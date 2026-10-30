jest.mock('webextension-polyfill', () => ({ i18n: { detectLanguage: jest.fn(async () => ({ languages: [{ language: 'en' }] })) } }));
jest.mock('ky', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('../src/browser_ai/client.js', () => ({ requestBrowserAi: jest.fn() }));
import ky from 'ky';
import TranslationService from '../src/services/translation.js';
import { requestBrowserAi } from '../src/browser_ai/client.js';
const settings = { llmExecution: 'api', llmApiEndpoint: 'https://translation.example/v1', llmModel: 'hy-mt2:1.8b-q8', llmApiKey: 'translation-secret' };
const response = (content = '번역 [M1]', finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }], usage: { completion_tokens: 20 } });
beforeEach(() => { jest.clearAllMocks(); ky.post.mockReturnValue({ json: async () => response() }); });

test('strict translation keeps reference separate, sampling and math placeholders, with no legacy translator', async () => {
  const signal = new AbortController().signal;
  const result = await TranslationService.translateStrict('Source [M1].', 'en', 'ko', settings, 'Reference paragraph.', { signal, sentenceOnly: true, preserveMath: true, temperature: .4, seed: 42 });
  expect(result).toMatchObject({ targetText: '번역 [M1]', sourceLang: 'en', targetLang: 'ko' });
  const [url, options] = ky.post.mock.calls[0];
  expect(url).toBe('https://translation.example/v1/chat/completions');
  expect(options).toMatchObject({ signal, retry: 0, credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer translation-secret' } });
  expect(options.json).toMatchObject({ temperature: .4, seed: 42, max_tokens: 1024 });
  expect(options.json.messages[0].content).toContain('Reference paragraph.');
  expect(options.json.messages[1].content).toContain('Korean');
  expect(options.json.messages[1].content).toContain('exactly once and unchanged');
  expect(options.json.messages[1].content).not.toContain('Reference paragraph.');
});

test('browser mode uses only browser runtime and ignores saved server identity', async () => {
  requestBrowserAi.mockResolvedValue(response());
  await TranslationService.translateStrict('Source [M1]', 'en', 'ko', { ...settings, llmExecution: 'browser', llmModel: 'unrelated-server-model' }, '', { sentenceOnly: true });
  expect(ky.post).not.toHaveBeenCalled();
  expect(requestBrowserAi.mock.calls[0][0]).toMatchObject({ operation: 'chat', model: 'hy-mt2:1.8b-q8' });
});

test('batch maps numbered results to IDs and preserves per-item math instructions', async () => {
  ky.post.mockReturnValue({ json: async () => response('[S2] 둘 [M1]\n[S1] 하나 [M1]') });
  const entries = [{ id: 'one', text: 'One [M1].' }, { id: 'two', text: 'Two [M1].' }];
  const result = await TranslationService.translateBatchStrict(entries, 'en', 'ko', settings, 'Reference', { preserveMath: true });
  expect(result.map(item => [item.id, item.targetText])).toEqual([['one', '하나 [M1]'], ['two', '둘 [M1]']]);
  expect(ky.post.mock.calls[0][1].json.messages[1].content).toContain('within its item');
});

test.each(['[S1] 하나', '[S1] 하나\n[S1] 반복', '[S1] 하나 [S2] 둘', '설명\n[S1] 하나\n[S2] 둘'])('batch rejects damaged labels: %s', async content => {
  ky.post.mockReturnValue({ json: async () => response(content) });
  await expect(TranslationService.translateBatchStrict([{ id: 'one', text: 'One.' }, { id: 'two', text: 'Two.' }], 'en', 'ko', settings)).rejects.toMatchObject({ code: 'BATCH_FORMAT' });
});

test.each([[response('', 'length'), 'OUTPUT_LIMIT'], [response(''), 'EMPTY_OUTPUT'], [{ choices: [] }, 'INVALID_RESPONSE'], [response('', 'content_filter'), 'CONTENT_FILTER']])('response failures retain typed categories', async (data, code) => {
  ky.post.mockReturnValue({ json: async () => data });
  await expect(TranslationService.translateStrict('Source', 'en', 'ko', settings)).rejects.toMatchObject({ code });
});

test('cancellation ignores late completion and errors retain status without private provider body', async () => {
  const controller = new AbortController();
  ky.post.mockReturnValue({ json: async () => { controller.abort(); return response(); } });
  await expect(TranslationService.translateStrict('Source', 'en', 'ko', settings, '', { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  ky.post.mockReturnValue({ json: async () => { throw Object.assign(new Error('private response'), { response: { status: 403 } }); } });
  await expect(TranslationService.translateStrict('Source', 'en', 'ko', settings)).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 403, message: expect.not.stringContaining('private response') });
});

test('batch cancellation aborts the same request and rejects a late complete batch', async () => {
  const controller = new AbortController();
  ky.post.mockReturnValue({ json: async () => { controller.abort(); return response('[S1] 하나\n[S2] 둘'); } });
  await expect(TranslationService.translateBatchStrict([{ id: 'one', text: 'One.' }, { id: 'two', text: 'Two.' }], 'en', 'ko', settings, '', { signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  expect(ky.post.mock.calls[0][1]).toMatchObject({ signal: controller.signal, credentials: 'omit', redirect: 'error' });
});

test('generic OpenAI-compatible models retain isolated context and tolerant language-prefix parsing', async () => {
  ky.post.mockReturnValue({ json: async () => response('en\t셀') });
  const result = await TranslationService.translateStrict('cell', 'auto', 'ko', { ...settings, llmModel: 'generic-model' }, 'Spreadsheet formulas', { sentenceOnly: true });
  expect(result).toMatchObject({ targetText: '셀', sourceLang: 'en', targetLang: 'ko' });
  const messages = ky.post.mock.calls[0][1].json.messages;
  expect(messages[0].content).toContain('source ISO 639-1 code');
  expect(messages[1].content).toContain('<background>\nSpreadsheet formulas\n</background>');
  expect(messages[1].content).toMatch(/<text>\ncell\n<\/text>$/);
});
