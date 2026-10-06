const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const binary = fs.readFileSync(path.join(__dirname, '..', 'normal-map.wasm'));
  const { instance } = await WebAssembly.instantiate(binary);
  const wasm = instance.exports;
  const width = 32;
  const height = 32;
  const bytes = width * height * 4;
  const input = new Uint8Array(wasm.memory.buffer, wasm.input_ptr(), bytes);
  const output = new Uint8Array(wasm.memory.buffer, wasm.output_ptr(), bytes);
  const center = (16 * width + 16) * 4;

  for (let index = 0; index < bytes; index += 4) input[index] = 128;
  assert.equal(wasm.generate_normals(width, height), 1);
  assert.deepEqual([...output.slice(center, center + 4)], [128, 128, 255, 255]);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) input[(y * width + x) * 4] = Math.round(x / (width - 1) * 255);
  }
  assert.equal(wasm.generate_normals(width, height), 1);
  assert.ok(output[center] < 128, 'A left-to-right depth rise should tilt the normal left');
  assert.ok(Math.abs(output[center + 1] - 128) <= 1);
  assert.ok(output[center + 2] > 128);
  assert.equal(output[center + 3], 255);
  assert.equal(wasm.generate_normals(0, height), 0);
  console.log('WASM normal map checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
