/* Runs Demucs inside a Web Worker so the page stays responsive.
 *
 * The WASM module is demucs.cpp compiled with Emscripten. It takes the whole
 * track in one call and does its own internal segmenting and overlap-add, so
 * there is no chunking to do here.
 */

let wasm = null;
let modelBytes = null;

const MODEL_URL = "models/ggml-model-htdemucs-6s-f16.bin";
const CACHE = "stem-splitter-models-v1";
const TARGETS = 6;                       // htdemucs_6s
const MAX_TARGET_SLOTS = 7;              // what the exported function expects

function say(msg, extra = {}) {
  postMessage({ msg, ...extra });
}

async function fetchModel() {
  // 52MB, so keep it in the Cache API: downloaded once, instant on every
  // later visit, and it works offline afterwards.
  const cache = await caches.open(CACHE);
  let response = await cache.match(MODEL_URL);
  if (!response) {
    say("STATUS", { text: "downloading the model (52MB, once only)…" });
    response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`model download failed (${response.status})`);
    await cache.put(MODEL_URL, response.clone());
  } else {
    say("STATUS", { text: "model already cached" });
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function ensureLoaded() {
  if (wasm) return;
  importScripts("demucs.js");
  wasm = await libdemucs();
  if (!modelBytes) modelBytes = await fetchModel();

  say("STATUS", { text: "loading the model…" });
  const ptr = wasm._malloc(modelBytes.byteLength);
  wasm.HEAPU8.set(modelBytes, ptr);
  wasm._modelInit(ptr, modelBytes.byteLength);
  wasm._free(ptr);
}

function allocFloats(values) {
  const ptr = wasm._malloc(values.length * 4);
  if (!ptr) throw new Error("out of memory");
  new Float32Array(wasm.HEAPF32.buffer, ptr, values.length).set(values);
  return ptr;
}

function separate(left, right) {
  const n = left.length;
  const inputs = [allocFloats(left), allocFloats(right)];
  const outputs = [];
  for (let i = 0; i < MAX_TARGET_SLOTS; i++) {
    if (i < TARGETS) {
      outputs.push(wasm._malloc(n * 4), wasm._malloc(n * 4));
    } else {
      outputs.push(0, 0);               // slot the module declares but never fills
    }
  }

  wasm._modelDemixSegment(inputs[0], inputs[1], n, ...outputs, false);

  const stems = [];
  for (let i = 0; i < TARGETS; i++) {
    // Copy out before freeing: these are views onto the WASM heap, and heap
    // growth can detach them.
    stems.push(
      new Float32Array(new Float32Array(wasm.HEAPF32.buffer, outputs[2 * i], n)),
      new Float32Array(new Float32Array(wasm.HEAPF32.buffer, outputs[2 * i + 1], n)),
    );
  }
  [...inputs, ...outputs].forEach((p) => p && wasm._free(p));
  return stems;
}

onmessage = async (event) => {
  const { msg } = event.data;
  try {
    if (msg === "WARM") {
      await ensureLoaded();
      say("READY");
      return;
    }
    if (msg === "SEPARATE") {
      await ensureLoaded();
      say("STATUS", { text: "separating…" });
      const stems = separate(event.data.left, event.data.right);
      const buffers = stems.map((s) => s.buffer);
      postMessage({ msg: "DONE", stems }, buffers);
    }
  } catch (err) {
    say("FAILED", { error: err && err.message ? err.message : String(err) });
  }
};
