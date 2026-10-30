import browser from 'webextension-polyfill';
import { CONTEXT_LIMIT_DEFAULTS, CONTEXT_LIMIT_MAX } from './context_limits.js';

export const defaultData = Object.freeze({
  llmExecution: 'api',
  llmApiEndpoint: 'http://localhost:11434/v1',
  llmApiKey: '',
  llmModel: 'hy-mt2:1.8b-q8',
  embeddingExecution: 'api',
  embeddingApiEndpoint: 'http://localhost:11434',
  embeddingApiKey: '',
  embeddingModel: 'embeddinggemma',
  embeddingApiType: 'ollama',
  doclingExecution: 'local',
  doclingApiEndpoint: '',
  doclingApiKey: '',
  pdfDoclingAutoStart: true,
  pdfAutoOpen: true,
  translateTarget: 'ko',
  uiLanguage: 'ko',
  pdfLinkedHover: true,
  pdfSourceVariableTooltip: true,
  pdfShowDoclingRegions: false,
  ...CONTEXT_LIMIT_DEFAULTS,
});

const choices = {
  llmExecution: ['api', 'browser'], embeddingExecution: ['api', 'browser'],
  embeddingApiType: ['ollama', 'openai'], doclingExecution: ['local', 'server'],
  uiLanguage: ['ko', 'en', 'auto'],
};
const endpointKeys = new Set(['llmApiEndpoint', 'embeddingApiEndpoint', 'doclingApiEndpoint']);
const booleans = new Set(['pdfDoclingAutoStart', 'pdfAutoOpen', 'pdfLinkedHover', 'pdfSourceVariableTooltip', 'pdfShowDoclingRegions']);
const limits = new Set(Object.keys(CONTEXT_LIMIT_DEFAULTS));

export function validateSetting(key, value) {
  if (!Object.hasOwn(defaultData, key)) throw new Error(`Unknown setting: ${key}`);
  if (booleans.has(key)) {
    if (![true, false, 'true', 'false'].includes(value)) throw new Error(`올바른 켜기/끄기 값이 필요합니다: ${key}`);
    return value === true || value === 'true';
  }
  if (limits.has(key)) {
    if (value === '' || value == null || !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > CONTEXT_LIMIT_MAX) {
      throw new Error(`문맥 범위는 0–${CONTEXT_LIMIT_MAX.toLocaleString()} 사이의 정수여야 합니다.`);
    }
    return Number(value);
  }
  if (typeof value !== 'string' || value.length > 8192) throw new Error(`올바른 설정값이 필요합니다: ${key}`);
  const result = value.trim();
  if (choices[key] && !choices[key].includes(result)) throw new Error(`지원하지 않는 선택입니다: ${key}`);
  if (endpointKeys.has(key) && result) {
    let url;
    try { url = new URL(result); } catch (_) { throw new Error('API 주소 전체를 입력하세요. 예: http://localhost:11434/v1'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('API 주소는 사용자 정보·쿼리·해시가 없는 HTTP 또는 HTTPS 주소여야 합니다.');
    }
    return result.replace(/\/+$/, '');
  }
  if (key === 'translateTarget' && !/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(result)) throw new Error('번역 언어 코드를 확인하세요. 예: ko, en, ja');
  if (['llmModel', 'embeddingModel'].includes(key) && (!result || result.length > 1000)) throw new Error('사용할 모델 이름을 입력하세요.');
  return result;
}

export function validateSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('올바른 설정 객체가 필요합니다.');
  const settings = { ...defaultData };
  for (const [key, value] of Object.entries(values)) settings[key] = validateSetting(key, value);
  if (settings.llmExecution === 'api' && !settings.llmApiEndpoint) throw new Error('번역 API 주소를 입력하세요.');
  if (settings.embeddingExecution === 'api' && !settings.embeddingApiEndpoint) throw new Error('임베딩 API 주소를 입력하세요.');
  if (settings.doclingExecution === 'server' && !settings.doclingApiEndpoint) throw new Error('Docling 서버 주소를 입력하세요.');
  return settings;
}

export async function loadSettings() {
  const stored = await browser.storage.local.get(Object.keys(defaultData));
  const settings = { ...defaultData };
  for (const [key, value] of Object.entries(stored)) {
    try { settings[key] = validateSetting(key, value); } catch (_) { /* Invalid saved fields use their safe default. */ }
  }
  return settings;
}

export async function saveSettings(values) {
  const settings = validateSettings(values);
  await browser.storage.local.set(settings);
  return settings;
}

export default { getDefaultDataAll: async () => ({ ...defaultData }) };
