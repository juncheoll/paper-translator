import { createBrowserAiEngine } from '../src/browser_ai/engine';
import { BROWSER_MODELS, BROWSER_TRANSLATION_MODEL, getBrowserModelIdentity, hyMtPrompt } from '../src/browser_ai/models';

function harness(cached = ['translation', 'embedding']) {
  const saved = new Map(cached.map(kind => [BROWSER_MODELS[kind].url, makeModel(kind)]));
  const instances = [], calls = [], downloads = [];
  function makeModel(kind) {
    return { url: BROWSER_MODELS[kind].url, size: BROWSER_MODELS[kind].bytes, validate: () => 'valid', remove: jest.fn() };
  }
  class CacheManager { async delete(url) { saved.delete(url); } }
  class ModelManager {
    async getModels() { return [...saved.values()]; }
    async downloadModel(url, options) {
      downloads.push(url); const kind = Object.keys(BROWSER_MODELS).find(key => BROWSER_MODELS[key].url === url);
      options.progressCallback({ loaded: BROWSER_MODELS[kind].bytes, total: BROWSER_MODELS[kind].bytes });
      const model = makeModel(kind); saved.set(url, model); return model;
    }
  }
  class Wllama {
    constructor() { this.loaded = false; instances.push(this); }
    setCompat(value) { expect(value).toBeNull(); }
    async loadModel(model, config) { this.loaded = true; this.model = model; calls.push(['load', model.url, config]); }
    isModelLoaded() { return this.loaded; }
    async exit() { this.loaded = false; calls.push(['exit', this.model?.url]); }
    async createCompletion(options) {
      calls.push(['chat', options]);
      return { choices: [{ text: '번역문', finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 20 } };
    }
    async createEmbedding(options) {
      calls.push(['embed', options]); return { data: [{ embedding: [3, 4, ...Array(766).fill(0)] }] };
    }
  }
  const gpu = jest.fn(async () => true), engine = createBrowserAiEngine({ wasmUrl: '/bundled.wasm',
    loadLibrary: async () => ({ CacheManager, ModelManager, Wllama }), getGpu: gpu });
  return { engine, calls, instances, downloads, gpu };
}

test('pinned identity separates browser embeddings and raw template retains context and source', () => {
  const identity = getBrowserModelIdentity();
  expect(identity.find(([name]) => name === 'embeddinggemma')[1]).toContain('mean-l2:retrieval-prefix-v1');
  expect(identity.find(([name]) => name === BROWSER_TRANSLATION_MODEL)[1]).toContain('ctx8192');
  const prompt = hyMtPrompt([{ role: 'system', content: 'Reference.' }, { role: 'user', content: 'Source [M1].' }]);
  expect(prompt).toBe('<｜hy_begin▁of▁sentence｜>Reference.<｜hy_place▁holder▁no▁3｜><｜hy_User｜>Source [M1].<｜hy_Assistant｜>');
});

test('inference never starts a model download; explicit prepare does and reports progress', async () => {
  const h = harness([]), progress = jest.fn();
  await expect(h.engine.request({ operation: 'chat', messages: [{ role: 'user', content: 'Text' }] }))
    .rejects.toMatchObject({ code: 'BROWSER_MODEL_NOT_READY' });
  expect(h.downloads).toHaveLength(0);
  await h.engine.request({ operation: 'prepare', model: 'translation' }, { onProgress: progress });
  expect(h.downloads).toEqual([BROWSER_MODELS.translation.url]);
  expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'download', progress: 1 }));
  const status = await h.engine.request({ operation: 'status' });
  expect(status.models.translation).toMatchObject({ loaded: true, cached: true });
  expect(status.models.embedding.cached).toBe(false);
});

test('same translation engine is reused and model swap frees it before loading embeddings', async () => {
  const h = harness(), request = { operation: 'chat', messages: [{ role: 'user', content: 'Source [M1]' }], temperature: .4, seed: 42, max_tokens: 250 };
  const response = await h.engine.request(request); await h.engine.request(request);
  expect(h.instances).toHaveLength(1);
  expect(response.choices[0].message.content).toBe('번역문');
  expect(h.calls.find(([type]) => type === 'chat')[1]).toMatchObject({ temperature: .4, seed: 42, max_tokens: 250 });
  const vectors = await h.engine.request({ operation: 'embed', input: ['A document', 'A query'], purpose: 'query' });
  expect(h.instances).toHaveLength(2);
  expect(h.calls.map(([type]) => type)).toEqual(['load', 'chat', 'chat', 'exit', 'load', 'embed', 'embed']);
  expect(h.calls.filter(([type]) => type === 'load')[1][2]).toMatchObject({ pooling_type: 'mean', n_ctx: 2048, embeddings: true });
  expect(h.calls.find(([type]) => type === 'embed')[1].input).toBe('task: search result | query: A document');
  expect(vectors[0]).toHaveLength(768); expect(vectors[0][0]).toBeCloseTo(.6); expect(vectors[0][1]).toBeCloseTo(.8);
  expect(h.downloads).toHaveLength(0);
});

test('queued cancellation does not run inference and status can be read without waiting for jobs', async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  await expect(h.engine.request({ operation: 'embed', input: ['text'] }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.instances).toHaveLength(0);
  await h.engine.request({ operation: 'prepare', model: 'embedding' });
  await h.engine.request({ operation: 'unload' });
  const status = await h.engine.request({ operation: 'status' });
  expect(status.activeModel).toBeNull(); expect(status.models.embedding.cached).toBe(true);
  await h.engine.request({ operation: 'delete', model: 'embedding' });
  expect((await h.engine.request({ operation: 'status' })).models.embedding.cached).toBe(false);
});

test('unavailable GPU fails clearly without silent CPU fallback or downloading', async () => {
  const h = harness([]); h.gpu.mockResolvedValue(false);
  await expect(h.engine.request({ operation: 'prepare', model: 'translation' })).rejects.toMatchObject({ code: 'BROWSER_GPU_UNAVAILABLE' });
  expect(h.instances).toHaveLength(0); expect(h.downloads).toHaveLength(0);
});
