/* Stem Splitter — everything runs in this tab. No uploads, no accounts. */

const STEMS = ["drums", "bass", "other", "vocals", "guitar", "piano"];
const ORDER = ["drums", "bass", "guitar", "piano", "vocals", "other"];

/* ---------- plain-language input -------------------------------------
 * A lookup table rather than a language model: it runs offline, costs
 * nothing, and cannot invent a stem the model does not produce.
 * Longest phrases first, so "bass drum" is not read as "bass".
 */
const WORDS = [
  ["drums",  ["drum kit", "drumkit", "drums", "drum", "percussion", "beat",
              "kick", "snare", "hi hat", "hi-hat", "hihat", "hats", "cymbals"]],
  ["bass",   ["bass line", "bassline", "bass guitar", "bass", "808"]],
  ["guitar", ["electric guitar", "acoustic guitar", "guitars", "guitar", "gtr", "riff"]],
  ["piano",  ["piano", "keys", "keyboard", "rhodes", "organ"]],
  ["vocals", ["lead vocal", "backing vocal", "vocals", "vocal", "voice",
              "singing", "singer", "lyrics"]],
  ["other",  ["synth", "pad", "strings", "everything else", "other"]],
];

const IDIOMS = [
  [["instrumental", "karaoke"], "remove", ["vocals"]],
  [["acapella", "a cappella", "accapella", "vocals only"], "keep", ["vocals"]],
  [["drumless", "no drums", "without drums"], "remove", ["drums"]],
  [["just the beat", "drums only", "beat only"], "keep", ["drums"]],
];

const REMOVE_WORDS = ["remove", "without", "take out", "strip", "get rid", "lose the",
  "kill the", "mute", "delete", "cut the", "drop the", "minus", "erase", "subtract"];
const KEEP_WORDS = ["only", "just", "isolate", "solo", "extract", "keep", "give me",
  "pull out", "i want", "grab", "lift"];
const FLIP_WORDS = ["except", "apart from", "other than", "but not", "besides"];

function parsePrompt(text) {
  const lowered = ` ${text.toLowerCase().trim()} `;
  for (const [phrases, mode, stems] of IDIOMS) {
    if (phrases.some((p) => lowered.includes(p))) return finish(stems, mode);
  }
  const found = [];
  for (const [stem, words] of WORDS) {
    if (words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lowered))) {
      if (!found.includes(stem)) found.push(stem);
    }
  }
  let mode = REMOVE_WORDS.some((w) => lowered.includes(w)) ? "remove"
           : KEEP_WORDS.some((w) => lowered.includes(w)) ? "keep" : "keep";
  if (FLIP_WORDS.some((w) => lowered.includes(w))) mode = mode === "remove" ? "keep" : "remove";
  return finish(found, mode);
}

function finish(stems, mode) {
  if (!stems.length) {
    return { stems: [], mode, reading: "Could not tell which instrument you meant — "
      + "try drums, bass, guitar, piano, vocals or synth." };
  }
  const named = stems.join(" + ");
  return { stems, mode, reading: mode === "remove"
    ? `Take out ${named}, and keep everything else.`
    : `Isolate ${named}, and put everything else in one file.` };
}

/* ---------- audio helpers ---------- */

function encodeWav(channels, rate) {
  const n = channels[0].length;
  const bytes = new ArrayBuffer(44 + n * 4);
  const view = new DataView(bytes);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(44 + i * 4 + c * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}

const sum = (parts, n) => {
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < n; i++) out[i] += p[i];
  return out;
};
const minus = (a, b, n) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] - b[i];
  return out;
};

/* ---------- state ---------- */

const $ = (id) => document.getElementById(id);
const touch = matchMedia("(hover: none)").matches;
let ctx, buffer, worker, result = null, picked = new Set(), fromPrompt = false;
let mixer = null;

const audio = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/* ---------- file in ---------- */

if (touch) $("drop").textContent = "Choose a song";
$("drop").onclick = () => $("file").click();
$("file").onchange = () => { if ($("file").files[0]) load($("file").files[0]); $("file").value = ""; };
["dragenter", "dragover"].forEach((e) => $("drop").addEventListener(e, (ev) => {
  ev.preventDefault(); $("drop").classList.add("over");
}));
["dragleave", "drop"].forEach((e) => $("drop").addEventListener(e, (ev) => {
  ev.preventDefault(); $("drop").classList.remove("over");
}));
$("drop").addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) load(f); });

async function load(file) {
  stopMix();
  $("drop").textContent = `reading ${file.name}…`;
  try {
    buffer = await audio().decodeAudioData(await file.arrayBuffer());
  } catch {
    $("drop").textContent = "could not decode that — try WAV or MP3";
    return;
  }
  $("drop").textContent = touch ? "Choose another song" : "Drop another song to start over";
  $("name").textContent = `${file.name} · ${fmt(buffer.duration)}`;
  $("loaded").hidden = false;
  ["setup", "runcard"].forEach((c) => $(c).classList.remove("off"));
  result = null; $("results").innerHTML = ""; $("status").textContent = "";
  drawWave();
  renderChips();
}

function drawWave() {
  const cv = $("wave"), dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const data = buffer.getChannelData(0), step = Math.max(1, Math.floor(data.length / W));
  g.fillStyle = "#4a4038";
  for (let x = 0; x < W; x++) {
    let peak = 0;
    for (let i = x * step; i < (x + 1) * step && i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const h = Math.max(1, peak * H * 0.92);
    g.fillRect(x, (H - h) / 2, 1, h);
  }
}
addEventListener("resize", () => buffer && drawWave());

/* ---------- stem chips + prompt ---------- */

function renderChips() {
  $("stems").innerHTML = "";
  ORDER.forEach((name) => {
    const el = document.createElement("div");
    el.className = "chip" + (picked.has(name) ? " on" : "");
    el.textContent = name === "other" ? "synth / other" : name;
    el.onclick = () => {
      picked.has(name) ? picked.delete(name) : picked.add(name);
      el.classList.toggle("on");
      if (!fromPrompt) { $("prompt").value = ""; $("reading").textContent = ""; }
      hint();
    };
    $("stems").appendChild(el);
  });
  hint();
}

function hint() {
  const n = picked.size;
  $("pickhint").textContent = (n === 0 || n === ORDER.length)
    ? "Nothing selected — every stem is saved on its own."
    : `${[...picked].join(" + ")} ${n === 1 ? "goes" : "go"} into one file, everything else into `
      + `without-${[...picked].join("+")}.wav. The two add back to the exact original.`;
}

let promptTimer = 0;
$("prompt").oninput = () => {
  clearTimeout(promptTimer);
  const text = $("prompt").value.trim();
  if (!text) { $("reading").textContent = ""; return; }
  promptTimer = setTimeout(() => {
    const read = parsePrompt(text);
    $("reading").textContent = read.reading;
    $("reading").classList.toggle("miss", !read.stems.length);
    if (!read.stems.length) return;
    fromPrompt = true;
    picked = new Set(read.stems);
    renderChips();
    fromPrompt = false;
  }, 250);
};

/* ---------- run ---------- */

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker("worker.js");
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.msg === "STATUS") $("status").textContent = d.text;
    else if (d.msg === "FAILED") {
      $("status").innerHTML = `<span class="err">${d.error}</span>`;
      $("run").disabled = false; $("bar").hidden = true;
    } else if (d.msg === "DONE") {
      $("bar").hidden = true; $("run").disabled = false;
      finished(d.stems);
    }
  };
  return worker;
}

$("run").onclick = () => {
  stopMix();
  $("run").disabled = true;
  $("bar").hidden = false;
  $("status").textContent = "starting…";
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  ensureWorker().postMessage(
    { msg: "SEPARATE", left: new Float32Array(left), right: new Float32Array(right) },
  );
};

function finished(flat) {
  const n = flat[0].length;
  const rate = buffer.sampleRate;
  const stems = {};
  STEMS.forEach((name, i) => { stems[name] = [flat[2 * i], flat[2 * i + 1]]; });

  // Whatever the model could not place in any stem. Stems + residual is the
  // song again, exactly; the stems alone are not.
  const src = [buffer.getChannelData(0),
               buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)];
  const summed = [0, 1].map((c) => sum(STEMS.map((s) => stems[s][c]), n));
  stems.residual = [0, 1].map((c) => minus(src[c].subarray(0, n), summed[c], n));

  const files = [];
  ORDER.concat("residual").forEach((name) => files.push([name, stems[name]]));

  if (picked.size && picked.size < ORDER.length) {
    const chosen = [...picked];
    const label = chosen.join("+");
    const sel = [0, 1].map((c) => sum(chosen.map((s) => stems[s][c]), n));
    // Take the remainder from the original rather than by summing the other
    // stems, so the pair reconstructs the input exactly, residual included.
    const rest = [0, 1].map((c) => minus(src[c].subarray(0, n), sel[c], n));
    files.unshift([label, sel], [`without-${label}`, rest]);
  }

  result = { files, rate, n };
  renderResults();
}

function renderResults() {
  const wrap = $("results");
  wrap.innerHTML = "";
  $("status").textContent = "done — play them here, or save what you want.";

  const head = document.createElement("div");
  head.className = "transport";
  const play = document.createElement("button");
  play.className = "primary"; play.textContent = "Play stems";
  head.appendChild(play); wrap.appendChild(head);

  mixer = { tracks: [], nodes: [], playing: false, button: play };

  result.files.forEach(([name, chans]) => {
    const row = document.createElement("div"); row.className = "mixrow";
    const nm = document.createElement("span"); nm.className = "nm";
    nm.textContent = name === "other" ? "synth / other" : name;
    const mute = document.createElement("button"); mute.className = "tog"; mute.textContent = "M";
    const solo = document.createElement("button"); solo.className = "tog"; solo.textContent = "S";
    const save = document.createElement("button"); save.className = "tog"; save.textContent = "save";
    const vol = document.createElement("input");
    vol.type = "range"; vol.min = 0; vol.max = 1.4; vol.step = 0.01; vol.value = 1;
    row.append(nm, mute, solo, save, vol); wrap.appendChild(row);

    const buf = audio().createBuffer(2, result.n, result.rate);
    buf.copyToChannel(chans[0], 0); buf.copyToChannel(chans[1], 1);
    const gain = audio().createGain(); gain.connect(audio().destination);
    // The picked pair overlaps the stems, so it starts muted: unmute one on
    // its own to hear exactly what gets saved.
    const overlaps = name.includes("+") || name.startsWith("without-");
    const track = { name, buf, gain, vol, muted: overlaps, soloed: false };
    if (overlaps) mute.classList.add("on");
    mute.onclick = () => { track.muted = !track.muted; mute.classList.toggle("on"); gains(); };
    solo.onclick = () => { track.soloed = !track.soloed; solo.classList.toggle("on"); gains(); };
    vol.oninput = gains;
    save.onclick = () => {
      const url = URL.createObjectURL(encodeWav(chans, result.rate));
      const a = document.createElement("a");
      a.href = url; a.download = `${name}.wav`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
    mixer.tracks.push(track);
  });

  play.onclick = () => {
    audio().resume();
    if (mixer.playing) { stopMix(); return; }
    gains();
    mixer.tracks.forEach((t) => {
      const src = audio().createBufferSource();
      src.buffer = t.buf; src.connect(t.gain); src.start();
      mixer.nodes.push(src);
    });
    mixer.playing = true; play.textContent = "Stop";
    mixer.nodes[0].onended = () => stopMix();
  };
}

function stopMix() {
  if (!mixer) return;
  mixer.nodes.forEach((n) => { try { n.stop(); } catch {} });
  mixer.nodes = []; mixer.playing = false;
  if (mixer.button) mixer.button.textContent = "Play stems";
}

function gains() {
  if (!mixer) return;
  const anySolo = mixer.tracks.some((t) => t.soloed);
  mixer.tracks.forEach((t) => {
    const on = (anySolo ? t.soloed : true) && !t.muted;
    t.gain.gain.value = on ? parseFloat(t.vol.value) : 0;
  });
}
