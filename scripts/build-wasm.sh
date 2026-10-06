#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
rustc --edition=2024 --target=wasm32-unknown-unknown -O --crate-type=cdylib -C panic=abort -C link-arg=--strip-all wasm/normal_map.rs -o normal-map.wasm
chmod 644 normal-map.wasm
