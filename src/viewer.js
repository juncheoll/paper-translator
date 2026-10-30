import browser from 'webextension-polyfill';
import { initializePdfDocumentTranslation } from './pdf/document_translation.js';
import { loadSettings } from './settings.js';
import { bootstrapPdfViewer } from './viewer_bootstrap.js';
void bootstrapPdfViewer({ window, runtime: browser.runtime, loadSettings,
  initializeTranslation: initializePdfDocumentTranslation,
  loadModule: url => import(/* webpackIgnore: true */ url),
}).catch(error => {
  console.error(error);
  const status = document.createElement('p'); status.setAttribute('role', 'alert');
  status.style.cssText = 'padding:24px;color:#a34035;background:#fff;font:16px system-ui';
  status.textContent = 'PDF 뷰어를 시작하지 못했습니다. 확장프로그램을 새로고침한 뒤 다시 여세요. ' + error.message;
  document.body.append(status);
});
