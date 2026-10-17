#!/usr/bin/env node
/**
 * download-model.mjs
 *
 * Downloads the required ONNX files for Xenova/whisper-tiny.en from the
 * Hugging Face Hub into public/models/Xenova/whisper-tiny.en/ so the app
 * can run 100% offline (env.allowLocalModels = true, env.localModelPath = '/models/').
 *
 * Usage:
 *   npm run setup:model
 *
 * Files downloaded:
 *   config.json
 *   tokenizer.json
 *   tokenizer_config.json
 *   preprocessor_config.json
 *   onnx/model_quantized.onnx   (q8 — ~40 MB)
 *   onnx/decoder_model_merged_quantized.onnx
 *   special_tokens_map.json
 *   generation_config.json
 *   vocab.json
 *   merges.txt
 */

import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MODEL_DIR = path.join(ROOT, 'public', 'models', 'Xenova', 'whisper-tiny.en');

const HF_BASE =
  'https://huggingface.co/Xenova/whisper-tiny.en/resolve/main';

/** Files to fetch. Paths are relative to the model root on HF Hub. */
const FILES = [
  // Config / tokeniser / processor (same for all dtype variants)
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'special_tokens_map.json',
  'generation_config.json',
  'vocab.json',
  'merges.txt',
  // ONNX — Whisper is encoder-decoder; dtype 'q8' maps to the _quantized suffix
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

async function download(relPath) {
  const url = `${HF_BASE}/${relPath}`;
  const dest = path.join(MODEL_DIR, relPath);

  if (existsSync(dest)) {
    console.log(`  ✓ skip (exists) ${relPath}`);
    return;
  }

  mkdirSync(path.dirname(dest), { recursive: true });

  console.log(`  ↓ ${relPath}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(res.body, createWriteStream(dest));
  console.log(`  ✓ ${relPath}`);
}

console.log(`\n🤖 Downloading whisper-tiny.en to:\n   ${MODEL_DIR}\n`);

for (const file of FILES) {
  await download(file);
}

console.log('\n✅ Model ready. Run `npm run dev` to start the app offline.\n');
