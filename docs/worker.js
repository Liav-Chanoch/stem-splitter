/* One Demucs instance, processing one segment of the song.
 *
 * The page runs several of these at once. Each holds its own WASM module and
 * its own copy of the weights, which is why no SharedArrayBuffer (and so no
 * COOP/COEP headers, which GitHub Pages cannot set) is needed anywhere.
 */

let wasm = null;
let modelBytes = null;

const MODEL_URL = "models/ggml-model-htdemucs-6s-f16.bin";
const CACHE = "stem-splitter-models-v1";
const TARGETS = 6;
const SLOTS = 7;                     // the export takes 7 target pairs, 6 get filled

const say = (msg, extra = {}) => postMessage({ msg, ...extra });

async function modelData() {
  // Cached so the 52MB download happens once per browser, not once per worker.
  const cache = await caches.open(CACHE);
  let response = await cache.match(MODEL_URL);
  if (!response) {
    response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`model download failed (${response.status})`);
    await cache.put(MODEL_URL, response.clone());
    response = await cache.match(MODEL_URL);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function ready() {
  if (wasm) return;
  importScripts("demucs.js");
  wasm = await libdemucs();
  modelBytes ||= await modelData();
  const ptr = wasm._malloc(modelBytes.byteLength);
  wasm.HEAPU8.set(modelBytes, ptr);
  wasm._modelInit(ptr, modelBytes.byteLength);
  wasm._free(ptr);
}

function alloc(values) {
  const ptr = wasm._malloc(values.length * 4);
  if (!ptr) throw new Error("out of memory");
  new Float32Array(wasm.HEAPF32.buffer, ptr, values.length).set(values);
  return ptr;
}

function run(left, right) {
  const n = left.length;
  const inputs = [alloc(left), alloc(right)];
  const outs = [];
  for (let i = 0; i < SLOTS; i++) {
    outs.push(i < TARGETS ? wasm._malloc(n * 4) : 0, i < TARGETS ? wasm._malloc(n * 4) : 0);
  }
  wasm._modelDemixSegment(inputs[0], inputs[1], n, ...outs, false);
  const stems = [];
  for (let i = 0; i < TARGETS * 2; i++) {
    // Copy off the heap before freeing; heap growth detaches these views.
    stems.push(new Float32Array(new Float32Array(wasm.HEAPF32.buffer, outs[i], n)));
  }
  [...inputs, ...outs].forEach((p) => p && wasm._free(p));
  return stems;
}

onmessage = async (event) => {
  const { msg, index, left, right } = event.data;
  try {
    if (msg === "SEGMENT") {
      await ready();
      say("LOADED", { index });
      const stems = run(left, right);
      postMessage({ msg: "SEGMENT_DONE", index, stems }, stems.map((s) => s.buffer));
    }
  } catch (err) {
    say("FAILED", { index, error: err?.message ?? String(err) });
  }
};
