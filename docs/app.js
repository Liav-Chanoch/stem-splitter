/* Stem Splitter — everything runs in this tab. No uploads, no accounts. */

import { separate, workerCount, STEM_NAMES } from "./separate.js";

const ORDER = ["drums", "bass", "guitar", "piano", "vocals", "other"];
const LABEL = { other: "synth / other" };
const label = (n) => LABEL[n] || n;

/* ---------- plain language -> settings -------------------------------
 * A lookup table, not a language model: offline, free, and unable to
 * invent a stem the model does not produce.
 */
const WORDS = [
  ["drums",  ["drum kit", "drumkit", "drums", "drum", "percussion", "beat",
              "kick", "snare", "hi hat", "hi-hat", "hihat", "hats", "cymbals"]],
  ["bass",   ["bass line", "bassline", "bass guitar", "bass", "808"]],
  ["guitar", ["electric guitar", "acoustic guitar", "guitars", "guitar", "gtr", "riff"]],
  ["piano",  ["piano", "keys", "keyboard", "rhodes", "organ"]],
  ["vocals", ["lead vocal", "backing vocal", "vocals", "vocal", "voice",
              "singing", "singer", "lyrics"]],
  ["other",  ["synth", "synths", "pad", "pads", "strings", "everything else", "other"]],
];
const IDIOMS = [
  [["instrumental", "karaoke"], "remove", ["vocals"]],
  [["acapella", "a cappella", "accapella", "vocals only"], "keep", ["vocals"]],
  [["drumless", "no drums", "without drums"], "remove", ["drums"]],
  [["just the beat", "drums only", "beat only"], "keep", ["drums"]],
];
const REMOVE = ["remove", "without", "take out", "strip", "get rid", "lose the", "kill the",
  "mute", "delete", "cut the", "drop the", "minus", "erase", "subtract"];
const KEEP = ["only", "just", "isolate", "solo", "extract", "keep", "give me",
  "pull out", "i want", "grab", "lift"];
const FLIP = ["except", "apart from", "other than", "but not", "besides"];

export function parsePrompt(text) {
  const low = ` ${text.toLowerCase().trim()} `;
  for (const [phrases, mode, stems] of IDIOMS) {
    if (phrases.some((p) => low.includes(p))) return reading(stems, mode);
  }
  const found = [];
  for (const [stem, words] of WORDS) {
    const hit = words.some((w) =>
      new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(low));
    if (hit && !found.includes(stem)) found.push(stem);
  }
  let mode = REMOVE.some((w) => low.includes(w)) ? "remove"
           : KEEP.some((w) => low.includes(w)) ? "keep" : "keep";
  if (FLIP.some((w) => low.includes(w))) mode = mode === "remove" ? "keep" : "remove";
  return reading(found, mode);
}

function reading(stems, mode) {
  if (!stems.length) {
    return { stems: [], mode, text:
      "Not sure which instrument you meant — try drums, bass, guitar, piano, vocals or synth." };
  }
  const named = stems.map(label).join(" + ");
  return { stems, mode, text: mode === "remove"
    ? `Take out ${named}, keep everything else.`
    : `Isolate ${named}, put everything else in one file.` };
}

/* ---------- small audio helpers ---------- */

function encodeWav(chans, rate) {
  const n = chans[0].length;
  const buf = new ArrayBuffer(44 + n * 4);
  const view = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + n * 4, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 2; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(44 + i * 4 + c * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}
const addUp = (parts, n) => {
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < n; i++) out[i] += p[i];
  return out;
};
const subtract = (a, b, n) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] - b[i];
  return out;
};

/* ---------- state ---------- */

const $ = (id) => document.getElementById(id);
const touch = matchMedia("(hover: none)").matches;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
let ctx, buffer, picked = new Set(), fromPrompt = false, mixer = null, result = null;
let songName = "song";
const audio = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
const THREADS = workerCount();

/* ---------- step 1: the song ---------- */

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
    $("drop").textContent = "Could not read that one — try a WAV or MP3";
    return;
  }
  $("drop").textContent = touch ? "Choose a different song" : "Drop another song to start over";
  songName = file.name.replace(/\.[^.]+$/, "");
  $("name").textContent = `${file.name} · ${fmt(buffer.duration)}`;
  $("loaded").hidden = false;
  ["step2", "step3"].forEach((s) => $(s).classList.remove("off"));
  result = null; $("results").innerHTML = ""; $("status").textContent = "";
  $("run").disabled = false;
  estimate();
  drawWave();
  renderChips();
  $("step2").scrollIntoView({ behavior: "smooth", block: "start" });
}

function estimate() {
  // Measured: about 7x slower than real time on one core, and parallel workers
  // recover roughly half of what perfect scaling would give, because each one
  // loads its own copy of the weights and they compete for memory bandwidth.
  const secs = buffer.duration * Math.max(3.4, 14 / THREADS);
  $("estimate").textContent =
    `Using ${THREADS} core${THREADS > 1 ? "s" : ""}, this should take around `
    + `${fmt(secs)}. Keep the tab open while it works.`;
}

function drawWave() {
  const cv = $("wave"), dpr = devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
  const g = cv.getContext("2d"), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  const data = buffer.getChannelData(0), step = Math.max(1, Math.floor(data.length / W));
  g.fillStyle = getComputedStyle(document.body).getPropertyValue("--accent").trim();
  g.globalAlpha = .55;
  for (let x = 0; x < W; x++) {
    let peak = 0;
    for (let i = x * step; i < (x + 1) * step && i < data.length; i++) {
      peak = Math.max(peak, Math.abs(data[i]));
    }
    const h = Math.max(1, peak * H * 0.9);
    g.fillRect(x, (H - h) / 2, 1, h);
  }
  g.globalAlpha = 1;
}
addEventListener("resize", () => buffer && drawWave());

/* ---------- step 2: what to pull out ---------- */

const EXAMPLES = ["take out the vocals", "just the drums", "instrumental",
                  "isolate the bass", "everything except the guitar"];
EXAMPLES.forEach((text) => {
  const el = document.createElement("button");
  el.className = "example"; el.type = "button"; el.textContent = text;
  el.onclick = () => { $("prompt").value = text; $("prompt").oninput(); };
  $("examples").appendChild(el);
});

function renderChips() {
  $("stems").innerHTML = "";
  ORDER.forEach((name) => {
    const el = document.createElement("div");
    el.className = "chip" + (picked.has(name) ? " on" : "");
    el.textContent = label(name);
    el.onclick = () => {
      picked.has(name) ? picked.delete(name) : picked.add(name);
      el.classList.toggle("on");
      if (!fromPrompt) { $("prompt").value = ""; $("reading").className = "reading"; }
      hint();
    };
    $("stems").appendChild(el);
  });
  hint();
}

function hint() {
  const n = picked.size;
  $("pickhint").textContent = (n === 0 || n === ORDER.length)
    ? "Nothing chosen — you will get every stem on its own."
    : `${[...picked].map(label).join(" + ")} ${n === 1 ? "goes" : "go"} into one file, `
      + "everything else into another. The two add back to the exact original.";
}

let timer = 0;
$("prompt").oninput = () => {
  clearTimeout(timer);
  const text = $("prompt").value.trim();
  if (!text) { $("reading").className = "reading"; return; }
  timer = setTimeout(() => {
    const read = parsePrompt(text);
    $("reading").textContent = read.text;
    $("reading").className = "reading show" + (read.stems.length ? "" : " miss");
    if (!read.stems.length) return;
    fromPrompt = true;
    picked = new Set(read.stems);
    renderChips();
    fromPrompt = false;
  }, 250);
};

/* ---------- step 3: run ---------- */

$("run").onclick = async () => {
  stopMix();
  $("run").disabled = true;
  $("bar").hidden = false;
  $("bar").querySelector("i").style.width = "4%";
  $("status").className = "status";
  $("status").textContent = "getting the model ready…";
  $("step3").scrollIntoView({ behavior: "smooth", block: "start" });

  const left = new Float32Array(buffer.getChannelData(0));
  const right = new Float32Array(
    buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0));
  const started = Date.now();

  try {
    const stems = await separate(left, right, buffer.sampleRate, {
      workers: THREADS,
      onProgress: (p) => {
        if (p.loaded) { $("status").textContent = "separating…"; return; }
        const pct = Math.round((p.done / p.of) * 100);
        $("bar").querySelector("i").style.width = `${Math.max(6, pct)}%`;
        $("status").textContent = `separating… ${pct}%`;
      },
    });
    finished(stems, ((Date.now() - started) / 1000));
  } catch (err) {
    $("status").className = "status err";
    $("status").textContent = err.message || String(err);
    $("run").disabled = false;
  } finally {
    $("bar").hidden = true;
  }
};

function finished(stems, seconds) {
  const n = stems.drums[0].length;
  const rate = buffer.sampleRate;
  const src = [buffer.getChannelData(0),
               buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)];

  // What the model could not place in any stem. Stems alone do not add back
  // up to the song; stems plus this do, exactly.
  const summed = [0, 1].map((c) => addUp(STEM_NAMES.map((s) => stems[s][c]), n));
  stems.residual = [0, 1].map((c) => subtract(src[c].subarray(0, n), summed[c], n));

  const files = ORDER.concat("residual").map((name) => [name, stems[name]]);

  if (picked.size && picked.size < ORDER.length) {
    const chosen = [...picked];
    const name = chosen.join("+");
    const sel = [0, 1].map((c) => addUp(chosen.map((s) => stems[s][c]), n));
    // Remainder taken from the original rather than by summing the other
    // stems, so the pair reconstructs the input exactly, residual included.
    const rest = [0, 1].map((c) => subtract(src[c].subarray(0, n), sel[c], n));
    files.unshift([`without-${name}`, rest]);
    // Summing a single stem just gives that stem back, and it is already in
    // the list, so only add the combined file when there is a combination.
    if (chosen.length > 1) files.unshift([name, sel]);
  }

  result = { files, rate, n };
  // Local-only hook, so the maths can be checked from the console during
  // development. Never present on the published site.
  if (["localhost", "127.0.0.1"].includes(location.hostname)) {
    window.__debug = { result, buffer, stems };
  }
  $("run").disabled = false;
  $("status").className = "status";
  $("status").textContent = `Done in ${fmt(seconds)}. Play them here, or save the ones you want.`;
  renderResults();
}

function renderResults() {
  const wrap = $("results");
  wrap.innerHTML = "";

  const head = document.createElement("div");
  head.style.marginBottom = "6px";
  const play = document.createElement("button");
  play.className = "primary"; play.textContent = "▶ Play together";
  const saveMix = document.createElement("button");
  saveMix.textContent = "Save this mix"; saveMix.style.marginLeft = "8px";
  const saveAll = document.createElement("button");
  saveAll.textContent = "Save every stem"; saveAll.style.marginLeft = "8px";
  head.append(play, saveMix, saveAll); wrap.appendChild(head);

  mixer = { tracks: [], nodes: [], playing: false, button: play };

  result.files.forEach(([name, chans]) => {
    const row = document.createElement("div"); row.className = "track";
    const nm = document.createElement("span"); nm.className = "nm";
    // The picked pair overlaps the stems, so it starts muted: unmute one on
    // its own to hear exactly what gets saved.
    const overlaps = name.includes("+") || name.startsWith("without-");
    nm.innerHTML = `${label(name)}${overlaps ? "<small>your selection</small>"
      : name === "residual" ? "<small>leftovers</small>" : ""}`;
    const mute = document.createElement("button"); mute.className = "tog"; mute.textContent = "mute";
    const solo = document.createElement("button"); solo.className = "tog"; solo.textContent = "solo";
    const save = document.createElement("button"); save.className = "tog save"; save.textContent = "save";
    const vol = document.createElement("input");
    vol.type = "range"; vol.min = 0; vol.max = 1.4; vol.step = 0.01; vol.value = 1;
    row.append(nm, mute, solo, save, vol); wrap.appendChild(row);

    const buf = audio().createBuffer(2, result.n, result.rate);
    buf.copyToChannel(chans[0], 0); buf.copyToChannel(chans[1], 1);
    const gain = audio().createGain(); gain.connect(audio().destination);
    const track = { name, buf, gain, vol, muted: overlaps, soloed: false, chans };
    if (overlaps) mute.classList.add("on");
    mute.onclick = () => {
      track.muted = !track.muted;
      mute.classList.toggle("on", track.muted);
      gains();
    };
    solo.onclick = () => {
      track.soloed = !track.soloed;
      solo.classList.toggle("on", track.soloed);
      // Soloing a muted track would otherwise give silence, which reads as a
      // bug rather than a choice.
      if (track.soloed && track.muted) { track.muted = false; mute.classList.remove("on"); }
      gains();
    };
    vol.oninput = gains;
    save.onclick = () => download(name, chans);
    mixer.tracks.push(track);
  });

  saveAll.onclick = () => result.files.forEach(([name, chans], i) =>
    setTimeout(() => download(name, chans), i * 350));

  saveMix.onclick = () => {
    // Exactly what the faders are currently playing: same gains, same rules.
    const anySolo = mixer.tracks.some((t) => t.soloed);
    const live = mixer.tracks.filter((t) => (anySolo ? t.soloed : true) && !t.muted);
    if (!live.length) {
      $("status").className = "status err";
      $("status").textContent = "Everything is muted — nothing to save.";
      return;
    }
    const n = result.n;
    const out = [new Float32Array(n), new Float32Array(n)];
    live.forEach((t) => {
      const g = parseFloat(t.vol.value);
      for (let c = 0; c < 2; c++) {
        const src = t.chans[c];
        for (let i = 0; i < n; i++) out[c][i] += src[i] * g;
      }
    });
    let peak = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[c][i]));
    // A sum of stems can go past full scale; turn it down rather than clip it.
    let note = "";
    if (peak > 1) {
      const trim = 1 / peak;
      for (let c = 0; c < 2; c++) for (let i = 0; i < n; i++) out[c][i] *= trim;
      const cut = -20 * Math.log10(trim);      // a positive number of dB removed
      if (cut >= 0.1) note = `, turned down ${cut.toFixed(1)} dB so it would not clip`;
    }
    download(`${songName} - mix`, out);
    $("status").className = "status";
    $("status").textContent =
      `Saved your mix: ${live.map((t) => label(t.name)).join(", ")}${note}.`;
  };

  play.onclick = () => {
    audio().resume();
    if (mixer.playing) { stopMix(); return; }
    gains();
    mixer.tracks.forEach((t) => {
      const src = audio().createBufferSource();
      src.buffer = t.buf; src.connect(t.gain); src.start();
      mixer.nodes.push(src);
    });
    mixer.playing = true; play.textContent = "■ Stop";
    mixer.nodes[0].onended = () => stopMix();
  };
}

function download(name, chans) {
  const url = URL.createObjectURL(encodeWav(chans, result.rate));
  const a = document.createElement("a");
  a.href = url; a.download = `${name}.wav`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function stopMix() {
  if (!mixer) return;
  mixer.nodes.forEach((n) => { try { n.stop(); } catch {} });
  mixer.nodes = []; mixer.playing = false;
  if (mixer.button) mixer.button.textContent = "▶ Play together";
}

function gains() {
  if (!mixer) return;
  const anySolo = mixer.tracks.some((t) => t.soloed);
  mixer.tracks.forEach((t) => {
    const on = (anySolo ? t.soloed : true) && !t.muted;
    t.gain.gain.value = on ? parseFloat(t.vol.value) : 0;
  });
}

/* ---------- nav highlighting ---------- */

const spy = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    ["1", "2", "3"].forEach((i) => $(`nav${i}`).classList.toggle("active", `step${i}` === e.target.id));
  });
}, { rootMargin: "-64px 0px -55% 0px" });
["step1", "step2", "step3"].forEach((id) => spy.observe($(id)));
