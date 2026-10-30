import { loadSettings, saveSettings, defaultData } from './settings.js';
import { requestBrowserAi } from './browser_ai/client.js';
import { requestDoclingHelper } from './docling_helper/client.js';
import { requestPdfApi } from './pdf/api_client.js';
import { requestDoclingApi } from './services/docling_client.js';

const form = document.querySelector('#settings-form');
const saveStatus = document.querySelector('#save-status');
const saveButton = document.querySelector('#save-button');
const jobs = new Map();
let dirty = false;

function message(element, text, error = false) {
  element.textContent = text;
  element.dataset.error = String(error);
}

function values() {
  return Object.fromEntries(Object.keys(defaultData).map(key => {
    const input = form.elements.namedItem(key);
    return [key, input.type === 'checkbox' ? input.checked : input.value];
  }));
}

function updateVisibility() {
  for (const element of form.querySelectorAll('[data-show]')) {
    const [key, value] = element.dataset.show.split(':');
    element.hidden = form.elements.namedItem(key).value !== value;
  }
  const selections = {
    translation: form.elements.llmExecution.value === 'browser' ? '브라우저' : 'API',
    embedding: form.elements.embeddingExecution.value === 'browser' ? '브라우저' : 'API',
    docling: form.elements.doclingExecution.value === 'local' ? '내 기기' : '서버',
  };
  for (const [kind, label] of Object.entries(selections)) form.querySelector(`[data-badge="${kind}"]`).textContent = label;
}

async function save() {
  saveButton.disabled = true;
  try {
    const saved = await saveSettings(values());
    dirty = false;
    message(saveStatus, '저장했습니다. 열려 있는 PDF에도 적용됩니다.');
    return saved;
  } catch (error) {
    message(saveStatus, error.message || '설정을 저장하지 못했습니다.', true);
    throw error;
  } finally { saveButton.disabled = false; }
}

function browserStatus(state, kind) {
  const model = state?.models?.[kind];
  if (!model) return '모델 상태를 확인하지 못했습니다.';
  const suffix = state.webgpu === false ? ' · WebGPU를 사용할 수 없습니다. Chrome 하드웨어 가속을 확인하세요.' : '';
  return `${model.name}: ${model.loaded ? '추론 준비 완료 · 메모리에 로드됨' : model.cached ? '다운로드됨 · 필요할 때 메모리에 로드' : '아직 다운로드하지 않음'}${suffix}`;
}

function helperStatus(state) {
  if (!state?.installed) return '도우미가 설치되어 있지 않습니다. 설치 안내에 따라 설치한 후 상태를 확인하세요.';
  if (state.busy) return '도우미가 작업 중입니다.';
  if (state.running && !state.managed) return '이미 실행 중인 분석 서비스에 연결했습니다. 이 화면에서는 해당 서비스를 중지하지 않습니다.';
  if (state.modelLoaded) return 'CPU 분석 준비 완료 · 모델이 메모리에 올라와 있습니다.';
  if (state.running) return '분석 서비스 실행 중 · 첫 분석 때 모델을 로드합니다.';
  return state.modelReady ? '모델 다운로드 완료 · 서비스는 중지되어 있습니다.' : '도우미 설치 완료 · 분석 준비를 눌러 모델을 다운로드하세요.';
}

function friendlyError(error) {
  const messages = {
    DOCLING_HELPER_NOT_INSTALLED: 'Docling 도우미를 먼저 설치하세요. 설치 안내에서 운영체제에 맞는 설치 파일을 확인할 수 있습니다.',
    DOCLING_MODEL_NOT_READY: '분석 준비를 눌러 Docling 모델을 먼저 다운로드하세요.',
    DOCLING_HELPER_FORBIDDEN: '도우미에 현재 확장이 등록되어 있지 않습니다. 이 프로젝트의 도우미 설치 파일로 다시 설치하세요.',
    BROWSER_GPU_UNAVAILABLE: 'WebGPU를 사용할 수 없습니다. Chrome의 하드웨어 가속을 확인하거나 API 실행을 선택하세요.',
    BROWSER_MODEL_NOT_READY: '해당 모델의 다운로드·준비를 먼저 완료하세요.',
  };
  return messages[error?.code] || error?.message || '작업을 완료하지 못했습니다.';
}

async function run(kind, task) {
  if (jobs.has(kind)) return;
  const controller = new AbortController();
  jobs.set(kind, controller);
  const card = form.querySelector(`[data-service="${kind}"]`);
  const status = card.querySelector('[data-status]');
  const progress = card.querySelector('progress');
  const cancel = card.querySelector('[data-cancel]');
  for (const button of card.querySelectorAll('[data-action]')) button.disabled = true;
  cancel.hidden = false;
  message(status, '연결하고 있습니다…');
  try {
    await task({ signal: controller.signal, onProgress(event) {
      const phases = { download: '모델 다운로드', load: '모델 로딩', prepare: '준비', starting: '시작', start: '서비스 시작', warmup: 'CPU 모델 로딩' };
      const label = phases[event?.phase] || '준비 중';
      const ratio = Number.isFinite(event?.progress) ? event.progress : Number.isFinite(event?.loaded) && event?.total > 0 ? event.loaded / event.total : null;
      progress.hidden = false;
      if (ratio == null) { progress.removeAttribute('value'); message(status, `${label}…`); }
      else { progress.value = Math.max(0, Math.min(1, ratio)); message(status, `${label} · ${Math.round(progress.value * 100)}%`); }
    } }, status);
  } catch (error) {
    message(status, error.name === 'AbortError' ? '작업을 취소했습니다. 완료한 다운로드와 기존 결과는 유지됩니다.' : friendlyError(error), error.name !== 'AbortError');
  } finally {
    jobs.delete(kind);
    progress.hidden = true;
    cancel.hidden = true;
    for (const button of card.querySelectorAll('[data-action]')) button.disabled = false;
  }
}

async function checkService(kind, options, status) {
  const settings = await save();
  if (kind === 'docling') {
    const info = await requestDoclingApi({ operation: 'info' }, options);
    message(status, `Docling 서버 연결 성공${info.modelLoaded ? ' · CPU 모델 준비 완료' : ' · 첫 분석 때 모델을 준비합니다.'}`);
    return;
  }
  const translation = kind === 'translation';
  const configuration = {
    endpoint: settings[translation ? 'llmApiEndpoint' : 'embeddingApiEndpoint'],
    model: settings[translation ? 'llmModel' : 'embeddingModel'],
    ...(translation ? {} : { type: settings.embeddingApiType }),
  };
  const state = await requestPdfApi({ operation: 'check', service: kind, configuration }, options);
  message(status, state.modelAvailable ? '서버 연결 성공 · 지정 모델을 확인했습니다.' : '서버 연결 성공 · 지정 모델이 목록에 없습니다. 서버의 모델 이름을 확인하세요.');
}

form.addEventListener('submit', event => { event.preventDefault(); void save().catch(() => {}); });
form.addEventListener('input', () => {
  dirty = true;
  message(saveStatus, '저장하지 않은 변경사항이 있습니다.');
  updateVisibility();
});
form.addEventListener('change', updateVisibility);
form.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.cancel) { jobs.get(button.dataset.cancel)?.abort(); return; }
  if (!button.dataset.action) return;
  const [action, kind] = button.dataset.action.split('-');
  void run(kind, async (options, status) => {
    if (action === 'check') return checkService(kind, options, status);
    if (kind === 'docling') {
      const result = await requestDoclingHelper({ operation: action }, options);
      message(status, helperStatus(result));
      return;
    }
    const result = await requestBrowserAi({ operation: action, ...(['prepare', 'delete'].includes(action) ? { model: kind } : {}) }, options);
    for (const modelKind of ['translation', 'embedding']) message(form.querySelector(`[data-status="${modelKind}"]`), browserStatus(result, modelKind));
  });
});

window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => { for (const controller of jobs.values()) controller.abort(); });

saveButton.disabled = true;
loadSettings().then(settings => {
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = value === true || value === 'true';
    else {
      if (input.tagName === 'SELECT' && !Array.from(input.options).some(option => option.value === String(value))) {
        input.add(new Option(value, value));
      }
      input.value = value;
    }
  }
  updateVisibility();
  message(saveStatus, '모든 설정은 이 브라우저에만 저장됩니다.');
  saveButton.disabled = false;
}).catch(error => message(saveStatus, `설정을 불러오지 못했습니다. ${friendlyError(error)}`, true));
