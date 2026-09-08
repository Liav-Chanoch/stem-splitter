/* Splitting the song across several workers, and putting it back together.
 *
 * The song is cut into chunks of a bounded length, padded with 0.75s of their
 * neighbours, and handed to a small pool of workers that each keep one WASM
 * instance loaded. Chunks are recombined with complementary crossfades across
 * the padded region, so the weights always sum to one and no seam is audible.
 *
 * Bounded chunks rather than one slice per worker: a slice of a long song
 * takes minutes before it reports anything and holds its whole inference in
 * memory, whereas chunks report often and keep peak memory flat.
 */

const OVERLAP_SECONDS = 0.75;
const CHUNK_SECONDS = 30;
const STEM_NAMES = ["drums", "bass", "other", "vocals", "guitar", "piano"];

export function workerCount() {
  // Each worker holds its own copy of the weights, so this trades memory for
  // speed. Four is a safe ceiling on a laptop; phones get less.
  const cores = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 4;         // GB, where reported
  return Math.max(1, Math.min(cores - 1, memory >= 8 ? 4 : 2));
}

function padded(channel, start, end, overlap) {
  const out = new Float32Array(end - start + 2 * overlap);
  const last = channel.length - 1;
  for (let i = 0; i < out.length; i++) {
    out[i] = channel[Math.max(0, Math.min(last, start - overlap + i))];  // clamp at edges
  }
  return out;
}

export function separate(left, right, rate, { workers, onProgress }) {
  const total = left.length;
  const overlap = Math.floor(rate * OVERLAP_SECONDS);
  const chunkLen = Math.max(rate * 5, Math.floor(rate * CHUNK_SECONDS));

  const chunks = [];
  for (let start = 0; start < total; start += chunkLen) {
    const end = Math.min(total, start + chunkLen);
    chunks.push({ index: chunks.length, start, end });
  }
  const poolSize = Math.max(1, Math.min(workers, chunks.length));

  const fade = 2 * overlap;
  const weightAt = (j, length, isFirst, isLast) => {
    let w = 1;
    if (!isFirst) w = Math.min(w, j / fade);
    if (!isLast) w = Math.min(w, (length - j) / fade);
    return Math.max(0, Math.min(1, w));
  };

  const acc = STEM_NAMES.map(() => [new Float32Array(total), new Float32Array(total)]);
  const weightSum = new Float32Array(total);

  return new Promise((resolve, reject) => {
    let next = 0;
    let done = 0;
    let failed = false;
    const inFlight = new Map();          // worker index -> fraction of its chunk

    const report = () => {
      let partial = 0;
      inFlight.forEach((f) => { partial += f; });
      onProgress?.({ fraction: Math.min(0.999, (done + partial) / chunks.length),
                     done, of: chunks.length });
    };

    const stop = (err) => {
      if (failed) return;
      failed = true;
      pool.forEach((w) => w.terminate());
      reject(err);
    };

    const give = (worker, slot) => {
      if (next >= chunks.length) { worker.terminate(); return; }
      const chunk = chunks[next++];
      worker.__chunk = chunk;
      inFlight.set(slot, 0);
      worker.postMessage({
        msg: "SEGMENT",
        index: chunk.index,
        left: padded(left, chunk.start, chunk.end, overlap),
        right: padded(right, chunk.start, chunk.end, overlap),
      });
    };

    const pool = Array.from({ length: poolSize }, (_, slot) => {
      const worker = new Worker("worker.js");
      worker.onmessage = (event) => {
        const d = event.data;
        if (failed) return;

        // Emitted by the WASM module itself, mid-inference.
        if (d.msg === "PROGRESS_UPDATE") {
          inFlight.set(slot, Math.max(0, Math.min(1, d.data ?? 0)));
          report();
          return;
        }
        if (d.msg === "LOADED") { report(); return; }
        if (d.msg === "FAILED") { stop(new Error(d.error)); return; }
        if (d.msg !== "SEGMENT_DONE") return;

        const chunk = worker.__chunk;
        const length = d.stems[0].length;
        const isFirst = chunk.index === 0;
        const isLast = chunk.index === chunks.length - 1;
        for (let j = 0; j < length; j++) {
          const global = chunk.start + j - overlap;
          if (global < 0 || global >= total) continue;
          const weight = weightAt(j, length, isFirst, isLast);
          if (weight <= 0) continue;
          for (let s = 0; s < STEM_NAMES.length; s++) {
            acc[s][0][global] += d.stems[2 * s][j] * weight;
            acc[s][1][global] += d.stems[2 * s + 1][j] * weight;
          }
          weightSum[global] += weight;
        }

        done += 1;
        inFlight.delete(slot);
        report();

        if (done === chunks.length) {
          for (let i = 0; i < total; i++) {
            const w = weightSum[i];
            if (w <= 0) continue;
            for (let s = 0; s < STEM_NAMES.length; s++) { acc[s][0][i] /= w; acc[s][1][i] /= w; }
          }
          pool.forEach((w) => w.terminate());
          const stems = {};
          STEM_NAMES.forEach((name, s) => { stems[name] = acc[s]; });
          resolve(stems);
          return;
        }
        give(worker, slot);
      };
      worker.onerror = (e) => stop(new Error(e.message || "worker failed"));
      return worker;
    });

    pool.forEach((worker, slot) => give(worker, slot));
    report();
  });
}

export { STEM_NAMES, CHUNK_SECONDS };
