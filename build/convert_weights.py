#!/usr/bin/env python3
"""Convert Demucs weights to the GGML-style binary demucs.cpp reads.

Based on demucs.cpp's own convert-pth-to-ggml.py, with two changes forced by
what is actually on this machine: current Demucs ships weights as safetensors
rather than a .th pickle, and those tensors are already float16, which is what
the C++ loader wants (it reads every tensor as Eigen::half).
"""

import argparse
import struct
import sys
from pathlib import Path

import numpy as np
from safetensors.torch import load_file

MAGIC = {"4s": 0x646D6334, "6s": 0x646D6336, "v3": 0x646D6333}


def convert(src: Path, dest: Path, kind: str) -> None:
    tensors = load_file(str(src))
    print(f"{len(tensors)} tensors from {src.name}")

    with dest.open("wb") as out:
        out.write(struct.pack("i", MAGIC[kind]))
        written = 0
        for name, tensor in tensors.items():
            data = tensor.squeeze().numpy()
            if data.dtype != np.float16:
                data = data.astype(np.float16)
            dims = data.shape
            encoded = name.encode("utf-8")
            out.write(struct.pack("ii", len(dims), len(encoded)))
            for d in dims:
                out.write(struct.pack("i", d))
            out.write(encoded)
            data.tofile(out)
            written += data.size
    print(f"{written/1e6:.1f}M params -> {dest} ({dest.stat().st_size/1e6:.1f}MB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("dest", type=Path)
    ap.add_argument("--kind", choices=sorted(MAGIC), default="6s")
    args = ap.parse_args()
    if not args.src.is_file():
        sys.exit(f"no such file: {args.src}")
    args.dest.parent.mkdir(parents=True, exist_ok=True)
    convert(args.src, args.dest, args.kind)
