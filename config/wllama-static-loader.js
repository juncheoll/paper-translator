// Package the pinned runtime's generated workers as extension-owned static scripts.
const acorn = require('acorn');

function patchWllama(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const constants = {};
  for (const statement of ast.body) if (statement.type === 'VariableDeclaration') {
    for (const declaration of statement.declarations) {
      const name = declaration.id.name, init = declaration.init;
      if (!['WLLAMA_EMSCRIPTEN_CODE', 'LLAMA_CPP_WORKER_CODE', 'OPFS_UTILS_WORKER_CODE', 'JSPI_STUB'].includes(name)) continue;
      if (init.type === 'Literal' && typeof init.value === 'string') constants[name] = init.value;
      else if (init.type === 'TemplateLiteral' && !init.expressions.length) constants[name] = init.quasis[0].value.cooked;
      else throw new Error(`Unsupported wllama worker constant: ${name}`);
    }
  }
  if (Object.keys(constants).length !== 4) throw new Error('Pinned wllama worker constants changed. Review the static worker adapter.');
  const main = (constants.JSPI_STUB + constants.WLLAMA_EMSCRIPTEN_CODE).replace('var Module', 'var ___Module');
  const assets = {
    'browser-ai/llama-worker.js': 'const RUN_OPTIONS = JSON.parse(new URL(self.location.href).searchParams.get("options"));\n' +
      'function wModuleInit() { ' + main + '; return Module; }\n' + constants.LLAMA_CPP_WORKER_CODE,
    'browser-ai/opfs-worker.js': constants.OPFS_UTILS_WORKER_CODE,
  };
  const start = source.indexOf('      let moduleCode = JSPI_STUB + (yield this.getModuleCode());');
  const needle = '      this.worker = createWorker(completeCode);';
  const end = source.indexOf(needle, start);
  if (start < 0 || end < start) throw new Error('Pinned wllama worker initialization changed.');
  source = source.slice(0, start) + `      if (this.resources.compat || this.nbThread > 1 || this.resources.noWebGPU) {
        throw new Error("This bundled browser AI runtime requires WebGPU and a single worker.");
      }
      const workerUrl = new URL("llama-worker.js", this.resources.wasmPath);
      workerUrl.searchParams.set("options", JSON.stringify({ pathConfig: { "wllama.wasm": this.resources.wasmPath }, nbThread: 0, compat: false }));
      this.worker = new Worker(workerUrl, { type: "module" });` + source.slice(end + needle.length);
  const blob = 'new Blob([moduleCode], { type: "text/javascript" })';
  if (source.split(blob).length !== 2) throw new Error('Pinned wllama module message changed.');
  source = source.replace(blob, 'null');
  const opfs = 'createWorker(OPFS_UTILS_WORKER_CODE)';
  if (source.split(opfs).length !== 2) throw new Error('Pinned wllama OPFS worker changed.');
  source = source.replace(opfs, `new Worker(typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("browser-ai/opfs-worker.js") : new URL("/browser-ai/opfs-worker.js", self.location.href), { type: "module" })`);
  const onerror = 'this.worker.onerror = this.logger.error;';
  if (source.split(onerror).length !== 2) throw new Error('Pinned wllama worker error handler changed.');
  source = source.replace(onerror, `this.worker.onerror = event => {
        this.abort(event.message || "Browser AI worker failed to start.", event.error?.stack || "");
        this.worker?.terminate();
      };`);
  const factory = ast.body.find(statement => statement.type === 'VariableDeclaration' &&
    statement.declarations.some(declaration => declaration.id.name === 'createWorker'));
  if (!factory) throw new Error('Pinned wllama worker factory changed.');
  source = source.replace(source.slice(factory.start, factory.end), '');
  return { code: source, assets };
}

module.exports = function(source) {
  this.cacheable?.();
  const result = patchWllama(source);
  for (const [name, contents] of Object.entries(result.assets)) this.emitFile(name, contents);
  return result.code;
};
module.exports.patchWllama = patchWllama;
