#!/usr/bin/env bash
# Fetch the Phase 4a spike's binaries. They are ~32MB and deliberately NOT in
# git; this script reproduces them exactly.
#
# Pinned to onnxruntime-web 1.20.1: the last line widely reported working on
# iOS WebKit. Newer JSEP builds are implicated in onnxruntime #26827.
# Note 1.20.1 ships ONLY the threaded JSEP wasm -- the non-threaded filenames
# 404, which is why they are not listed here.
set -euo pipefail
cd "$(dirname "$0")"

ORT=1.20.1
CDN="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT}/dist"

for f in ort.webgpu.min.mjs ort.wasm.min.mjs \
         ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm; do
  echo "fetching $f"
  curl -sLf -o "$f" "$CDN/$f"
done

# Stock COCO YOLO11n. NOT trained on cards -- Gate 4a measures whether the
# phone can RUN a model of this size, not whether it detects anything useful.
echo "fetching yolo11n.onnx"
curl -sLf -o yolo11n.onnx \
  "https://huggingface.co/aaurelions/yolo11n.onnx/resolve/main/yolo11n.onnx"

# Verify magic bytes: a 404 page saved as .wasm fails at runtime with a
# confusing error rather than an obvious one.
head -c4 ort-wasm-simd-threaded.jsep.wasm | grep -q $'\x00asm' \
  || { echo "wasm is not a wasm file"; exit 1; }
head -c2 yolo11n.onnx | od -An -tx1 | grep -q '08 09' \
  || { echo "onnx does not look like an ONNX protobuf"; exit 1; }

ls -la
echo "OK"

# Smaller variants, to test whether quantisation is a cheaper speed lever than
# input size. NOTE: all three graphs are FIXED at 640x640 -- yolo11n rejects any
# other input, which is why the spike varies the MODEL and not the size.
echo "fetching yolov10n fp16 + int8"
curl -sLf -o yolov10n-fp16.onnx \
  "https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model_fp16.onnx"
curl -sLf -o yolov10n-int8.onnx \
  "https://huggingface.co/onnx-community/yolov10n/resolve/main/onnx/model_quantized.onnx"
