export async function bootstrapPdfViewer({ window: win, runtime, loadSettings, initializeTranslation, loadModule }) {
  const doc = win.document;
  const settings = await loadSettings().catch(() => ({ uiLanguage: 'ko' }));
  initializeTranslation();
  const loaded = new Promise(resolve => doc.addEventListener('webviewerloaded', () => {
    const app = win.PDFViewerApplication;
    // Set before PDF.js run() can read preferences or try its packaged demo URL.
    win.PDFViewerApplicationOptions.set('defaultUrl', '');
    win.PDFViewerApplicationOptions.set('localeProperties', {
      lang: settings.uiLanguage === 'auto' ? win.navigator.language : settings.uiLanguage || 'ko',
    });
    resolve(app);
  }, { once: true }));
  await loadModule(runtime.getURL('pdfjs/build/pdf.mjs'));
  await loadModule(runtime.getURL('pdfjs/web/viewer.mjs'));
  const app = await loaded;
  await app.initializedPromise;
  const controls = doc.createElement('div'); controls.id = 'paperViewerLinks';
  const button = doc.createElement('button'); button.type = 'button'; button.textContent = '번역 설정';
  button.addEventListener('click', () => { void runtime.openOptionsPage(); });
  controls.append(button);
  (doc.getElementById('toolbarViewerRight') || doc.body).append(controls);
  if (new URLSearchParams(win.location.search).get('file')) return;
  const welcome = doc.createElement('section'); welcome.id = 'paperWelcome';
  const heading = doc.createElement('h1'); heading.textContent = '논문을 펼쳐보세요.';
  const paragraph = doc.createElement('p'); paragraph.textContent = 'PDF 파일을 선택하거나 이 창으로 끌어놓으세요.';
  const choose = doc.createElement('button'); choose.type = 'button'; choose.textContent = 'PDF 파일 선택';
  choose.addEventListener('click', () => app._openFileInput?.click());
  welcome.append(heading, paragraph, choose);
  (app.appConfig?.mainContainer || doc.getElementById('viewerContainer')).append(welcome);
  app.eventBus.on('documentloaded', () => welcome.remove());
  if (app.pdfDocument) welcome.remove();
}
