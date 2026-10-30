const fs = require('fs');
const acorn = require('acorn');
const { patchWllama } = require('../config/wllama-static-loader');
const source = fs.readFileSync(require.resolve('@wllama/wllama/esm/index.js'), 'utf8');

test('the pinned wllama package emits same-origin static workers without executing generated Blob scripts', () => {
  const result = patchWllama(source);
  expect(Object.keys(result.assets)).toEqual(['browser-ai/llama-worker.js', 'browser-ai/opfs-worker.js']);
  expect(result.code).not.toContain('this.worker = createWorker(completeCode)');
  expect(result.code).not.toContain('createWorker(OPFS_UTILS_WORKER_CODE)');
  expect(result.code).not.toContain('var createWorker =');
  expect(result.code).toContain('new URL("llama-worker.js", this.resources.wasmPath)');
  expect(result.code).toContain('this.abort(event.message || "Browser AI worker failed to start."');
  for (const script of [result.code, ...Object.values(result.assets)]) {
    expect(() => acorn.parse(script, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
  }
  expect(result.assets['browser-ai/llama-worker.js']).toContain('function wModuleInit()');
  expect(result.assets['browser-ai/llama-worker.js']).toContain('JSON.parse(new URL(self.location.href).searchParams.get("options"))');
});

test('unsupported dependency worker changes fail the build instead of silently using Blob workers', () => {
  expect(() => patchWllama(source.replace('var JSPI_STUB =', 'var CHANGED_JSPI_STUB ='))).toThrow('constants changed');
  expect(() => patchWllama(source.replace('this.worker = createWorker(completeCode)', 'this.worker = createChangedWorker(completeCode)'))).toThrow('initialization changed');
});
