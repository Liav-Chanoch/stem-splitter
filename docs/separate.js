/* Splitting the song across several workers, and putting it back together.
 *
 * Ported from demucs.cpp's threaded_inference.hpp: each worker gets a slice
 * padded by 0.75s of its neighbours, and the slices are recombined with a
 * triangular ramp across those overlaps so no seam is audible.
 */

const OVERLAP_SECONDS = 0.75;
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
  const total = channel.length;
  for (let i = 0; i < out.length; i++) {
    const src = start - overlap + i;
    out[i] = channel[Math.max(0, Math.min(total - 1, src))];  // clamp at the edges
  }
  return out;
}

export function separate(left, right, rate, { workers, onProgress }) {
  const total = left.length;
  const overlap = Math.floor(rate * OVERLAP_SECONDS);
  const count = Math.max(1, workers);
  const segLen = Math.ceil(total / count);

  const jobs = [];
  for (let i = 0; i < count; i++) {
    const start = i * segLen;
    const end = Math.min(total, start + segLen);
    if (start >= end) continue;
    jobs.push({ index: i, start, end,
                left: padded(left, start, end, overlap),
                right: padded(right, start, end, overlap) });
  }

  // Neighbouring segments share exactly 2*overlap samples, so fade each one in
  // and out across that whole shared span. The two ramps are then complementary
  // and sum to 1 at every sample, which keeps the blend ratio continuous.
  // demucs.cpp ramps over a different span, which steps the ratio abruptly at
  // the join and leaves a click there.
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
    let done = 0;
    let failed = false;
    const pool = jobs.map((job) => {
      const worker = new Worker("worker.js");
      worker.onmessage = (event) => {
        const d = event.data;
        if (d.msg === "LOADED") { onProgress?.({ loaded: true }); return; }
        if (d.msg === "FAILED") {
          if (!failed) { failed = true; pool.forEach((w) => w.terminate()); reject(new Error(d.error)); }
          return;
        }
        if (d.msg !== "SEGMENT_DONE") return;

        const length = d.stems[0].length;
        const isFirst = job.index === 0;
        const isLast = job.index === jobs.length - 1;
        for (let j = 0; j < length; j++) {
          const global = job.start + j - overlap;
          if (global < 0 || global >= total) continue;
          const weight = weightAt(j, length, isFirst, isLast);
          if (weight <= 0) continue;
          for (let s = 0; s < STEM_NAMES.length; s++) {
            acc[s][0][global] += d.stems[2 * s][j] * weight;
            acc[s][1][global] += d.stems[2 * s + 1][j] * weight;
          }
          weightSum[global] += weight;
        }

        worker.terminate();
        done += 1;
        onProgress?.({ done, of: jobs.length });
        if (done !== jobs.length || failed) return;

        for (let i = 0; i < total; i++) {
          const w = weightSum[i];
          if (w <= 0) continue;
          for (let s = 0; s < STEM_NAMES.length; s++) {
            acc[s][0][i] /= w;
            acc[s][1][i] /= w;
          }
        }
        const stems = {};
        STEM_NAMES.forEach((name, s) => { stems[name] = acc[s]; });
        resolve(stems);
      };
      worker.onerror = (e) => {
        if (!failed) { failed = true; pool.forEach((w) => w.terminate()); reject(new Error(e.message)); }
      };
      worker.postMessage(
        { msg: "SEGMENT", index: job.index, left: job.left, right: job.right },
        [job.left.buffer, job.right.buffer],
      );
      return worker;
    });
  });
}

export { STEM_NAMES };
