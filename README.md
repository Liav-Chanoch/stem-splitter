# Stem Splitter

Splits a song into drums, bass, guitar, piano, vocals and synth — entirely in
the browser. No server, no upload, no account: the audio is decoded, separated
and played back inside the tab, and never leaves the machine it is opened on.

Live at **https://liav-chanoch.github.io/stem-splitter/**

## What it does

- **Say it in words.** "take out the vocals", "just the bass", "instrumental".
  The sentence sets the controls and shows what it understood before running,
  so a misreading is visible rather than silent.
- **Pick and rest.** Choose any set of stems and get two files: those stems
  summed, and everything else. The second is computed as *the original minus
  the first*, so the pair reconstructs the input exactly.
- **Residual.** What the model could not place in any stem is kept rather than
  discarded. Stems alone do not add back up to the song; stems plus residual do.
- **Mixer.** Every result gets a fader, mute, solo and its own save button.

## Stack

| Piece | What |
| --- | --- |
| Model | [Demucs v4](https://github.com/facebookresearch/demucs) `htdemucs_6s`, MIT |
| Inference | [demucs.cpp](https://github.com/sevagh/demucs.cpp) compiled to WebAssembly, MIT |
| Weights | 52MB float16, converted from Meta's own checkpoint (see `build/`) |
| Hosting | GitHub Pages, static |

The model is fetched once and kept in the Cache API, so later visits start
immediately and work offline.

## Speed, honestly

WebAssembly is much slower than a native GPU. Measured on an M-series MacBook
Air: 20 seconds of audio took 142 seconds, so roughly **7x slower than real
time**. A 4 minute song is about half an hour, and the tab has to stay open.

The build is single threaded. Threads would help a lot, but they need
SharedArrayBuffer, which needs COOP/COEP headers, which GitHub Pages cannot
set; the usual way around that is a service worker that injects them.

If that matters, the companion local tool runs the same model on the Mac's GPU
at about 4x *faster* than real time, and also splits drums into kick, snare,
toms and cymbals — which this version cannot do, because that needs a second
model.

## Rebuilding

Weights are converted from the Demucs checkpoint that `demucs` downloads:

```bash
python build/convert_weights.py \
  ~/.cache/huggingface/hub/models--adefossez--HTDemucs-6s/snapshots/*/5c90dfd2.safetensors \
  web/models/ggml-model-htdemucs-6s-f16.bin --kind 6s
```

Building the WASM needs the Emscripten SDK and demucs.cpp. Three changes to
demucs.cpp were needed for a current toolchain, none of them behavioural:

- drop `-msse4.2` and the `<nmmintrin.h>` include — x86 intrinsics the newer
  Emscripten clang rejects for a WASM target, and nothing in the file used them
- pin Eigen to the commit demucs.cpp expects; 3.4.0 does not compile under clang 24
- export `HEAPU8` and `HEAPF32`, which recent Emscripten no longer exposes by default

## Licence

MIT, matching Demucs and demucs.cpp.
