jest.mock('webextension-polyfill', () => ({ storage: { local: { get: jest.fn(), set: jest.fn() } } }));
import browser from 'webextension-polyfill';
import { defaultData, validateSetting, validateSettings, loadSettings, saveSettings } from '../src/settings.js';

beforeEach(() => { jest.clearAllMocks(); browser.storage.local.get.mockResolvedValue({}); browser.storage.local.set.mockResolvedValue(); });

test('translation, embeddings and layout have independent execution and server configuration', () => {
  const value = validateSettings({ llmExecution: 'api', llmApiEndpoint: 'https://translate.example.org/v1/',
    embeddingExecution: 'browser', embeddingApiEndpoint: 'http://127.0.0.1:11434',
    doclingExecution: 'server', doclingApiEndpoint: 'https://layout.example.org/' });
  expect(value.llmExecution).toBe('api');
  expect(value.embeddingExecution).toBe('browser');
  expect(value.doclingExecution).toBe('server');
  expect(value.llmApiEndpoint).toBe('https://translate.example.org/v1');
  expect(value.doclingApiEndpoint).toBe('https://layout.example.org');
});

test('saving only whitelisted settings uses local storage and retains separate credentials', async () => {
  await saveSettings({ llmApiKey: 'translation-key', embeddingApiKey: 'embedding-key', doclingApiKey: 'layout-key' });
  expect(browser.storage.local.set).toHaveBeenCalledWith(expect.objectContaining({ llmApiKey: 'translation-key', embeddingApiKey: 'embedding-key', doclingApiKey: 'layout-key' }));
  await expect(saveSettings({ historyList: ['legacy'] })).rejects.toThrow('Unknown setting');
  expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
});

test.each(['javascript:alert(1)', 'file:///private/document.pdf', 'https://user:secret@example.org/api', 'https://example.org?key=secret', 'https://example.org/#token'])('rejects API endpoint %s', endpoint => {
  expect(() => validateSetting('doclingApiEndpoint', endpoint)).toThrow();
});

test('server choices require endpoints but local Docling does not', () => {
  expect(validateSettings(defaultData)).toEqual(defaultData);
  expect(() => validateSettings({ doclingExecution: 'server' })).toThrow('Docling');
  expect(() => validateSettings({ llmApiEndpoint: '' })).toThrow('번역 API');
  expect(() => validateSettings({ embeddingApiEndpoint: '' })).toThrow('임베딩 API');
});

test('context limits are bounded integers and boolean strings from panel are normalized', () => {
  expect(validateSetting('llmContextTotalLimit', '12000')).toBe(12000);
  expect(validateSetting('llmContextTotalLimit', '0')).toBe(0);
  for (const value of ['', null, NaN, -1, 1.2, '12001']) expect(() => validateSetting('llmContextTotalLimit', value)).toThrow();
  expect(validateSetting('pdfLinkedHover', 'false')).toBe(false);
  expect(validateSetting('pdfLinkedHover', true)).toBe(true);
  expect(() => validateSetting('pdfLinkedHover', 'yes')).toThrow();
});

test('loading only known fields replaces individually damaged stored values', async () => {
  browser.storage.local.get.mockResolvedValue({ pdfLinkedHover: 'false', llmExecution: 'broken', embeddingModel: 'custom-embedding', llmContextTitleLimit: '30000' });
  const settings = await loadSettings();
  expect(browser.storage.local.get).toHaveBeenCalledWith(Object.keys(defaultData));
  expect(settings.pdfLinkedHover).toBe(false);
  expect(settings.llmExecution).toBe('api');
  expect(settings.embeddingModel).toBe('custom-embedding');
  expect(settings.llmContextTitleLimit).toBe(300);
});
