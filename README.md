# Stem Splitter

Splits a song into drums, bass, guitar, piano, vocals and synth — entirely in
the browser. No server, no upload, no account: the audio is decoded, separated
and played back inside the tab, and never leaves the machine it is opened on.

Live at **https://liav-chanoch.github.io/stem-splitter/**

No server, no account, no upload: the page does the work.

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
- **Save the mix you made.** *Save this mix* bounces exactly what the faders
  are playing — mutes, solos and levels included — to a single file, turning it
  down if the sum would clip. *Save every stem* writes them all separately.

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
Air with 20 seconds of audio:

| | Time | vs real time |
| --- | --- | --- |
| One worker | 142s | 7.1x slower |
| Four workers | 65s | 3.2x slower |

So a 4 minute song lands around 12 minutes, and the tab has to stay open.

The parallelism does not need SharedArrayBuffer, and therefore does not need
the COOP/COEP headers that GitHub Pages cannot set. Instead of threads sharing
one module, the song is cut into one slice per worker and each worker runs its
own WASM instance, following demucs.cpp's `threaded_inference.hpp`. The cost is
one copy of the weights per worker, which is why the worker count is capped by
`deviceMemory` as well as by core count.

Slices are padded with 0.75s of their neighbours and recombined with a
crossfade. demucs.cpp's own ramp spans a different width to the shared region,
which steps the blend ratio at each join; this uses complementary ramps over
the full shared span, so the weights always sum to one and no seam is audible.
Verified: the largest sample-to-sample jump at a join is smaller than the
largest jump elsewhere in every stem.

If that matters, the companion local tool runs the same model on the Mac's GPU
at about 4x *faster* than real time, and also splits drums into kick, snare,
toms and cymbals — which this version cannot do, because that needs a second
model.

## Rebuilding

Weights are converted from the Demucs checkpoint that `demucs` downloads:

```bash
python build/convert_weights.py \
  ~/.cache/huggingface/hub/models--adefossez--HTDemucs-6s/snapshots/*/5c90dfd2.safetensors \
  docs/models/ggml-model-htdemucs-6s-f16.bin --kind 6s
```

Building the WASM needs the Emscripten SDK and demucs.cpp. Three changes to
demucs.cpp were needed for a current toolchain, none of them behavioural:

- drop `-msse4.2` and the `<nmmintrin.h>` include — x86 intrinsics the newer
  Emscripten clang rejects for a WASM target, and nothing in the file used them
- pin Eigen to the commit demucs.cpp expects; 3.4.0 does not compile under clang 24
- export `HEAPU8` and `HEAPF32`, which recent Emscripten no longer exposes by default

## Licence

MIT, matching Demucs and demucs.cpp.
