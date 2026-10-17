/**
 * whisperWorker.ts
 *
 * Runs inside a dedicated Web Worker.
 *
 * Offline-first configuration:
 *  • env.allowLocalModels = true  →  looks in /models/ first
 *  • env.useBrowserCache = true   →  caches remote downloads in Cache API
 *  • Falls back to remote (Hugging Face Hub) if /models/ files are absent
 *
 * Device selection:
 *  • Uses WebGPU when navigator.gpu is available
 *  • Falls back to 'wasm' (works on all browsers including mobile WebViews)
 *
 * Zero-copy:
 *  • Receives Float32Array via Transferable (zero-copy from main thread)
 *  • Timestamp mapping clamps paddingTime to avoid negative offsets
 */

import { pipeline, env } from '@huggingface/transformers';

// ─── Offline-first env config ─────────────────────────────────────────────────

env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = true;
env.allowRemoteModels = true; // fallback when /models/ files are absent

// ─── WebGPU detection ─────────────────────────────────────────────────────────

async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  // NOTE: For q8 (INT8 quantized models Xenova/whisper-tiny.en), WASM with SIMD
  // is the only supported, reliable path in onnxruntime-web. WebGPU EP currently
  // does not support INT8 quantization (DequantizeLinear/QuantizeLinear) and causes
  // either shader compilation stalls or CPU-GPU ping-pong bottlenecks.
  return 'wasm';
}

// ─── Model singleton ──────────────────────────────────────────────────────────

type TranscriberPipeline = Awaited<ReturnType<typeof pipeline>>;

class PipelineSingleton {
  static readonly task = 'automatic-speech-recognition' as const;
  static readonly model = 'Xenova/whisper-tiny.en';
  static instance: TranscriberPipeline | null = null;

  static async getInstance(
    progressCallback: (x: Record<string, unknown>) => void,
  ): Promise<TranscriberPipeline> {
    if (this.instance) return this.instance;

    const device = await detectDevice();
    self.postMessage({
      type: 'PROGRESS',
      payload: { message: `AI engine: initialising on ${device.toUpperCase()}…` },
    });

    this.instance = await pipeline(this.task, this.model, {
      dtype: 'q8' as Parameters<typeof pipeline>[2] extends { dtype?: infer D } ? D : never,
      device,
      progress_callback: progressCallback,
    });

    return this.instance;
  }
}

// ─── Eager model load ─────────────────────────────────────────────────────────

// ─── Sequential Task Queue ───────────────────────────────────────────────────

interface ChunkTask {
  chunkIndex: number;
  startTime: number;
  paddingTime: number;
  audioData: Float32Array;
  chunkDuration: number;
}

const taskQueue: ChunkTask[] = [];
let isProcessingQueue = false;
let activeChunkIndex: number | null = null;

const modelPromise = PipelineSingleton.getInstance((x) => {
  if (isProcessingQueue) return;
  const msg =
    x['status'] === 'progress'
      ? `Downloading AI model: ${Math.round((x['progress'] as number) ?? 0)}%`
      : `AI engine: ${String(x['status'])}…`;
  self.postMessage({ type: 'PROGRESS', payload: { message: msg } });
});

async function processQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  try {
    const transcriber = await modelPromise;

    while (taskQueue.length > 0) {
      const task = taskQueue.shift()!;
      activeChunkIndex = task.chunkIndex;
      const safePadding = Math.max(0, task.paddingTime);

      console.log(
        `[WhisperWorker] Processing chunk=${task.chunkIndex}`,
        `audio=${(task.audioData.length / 16000).toFixed(1)}s`,
        `startTime=${task.startTime}s`,
        `padding=${safePadding.toFixed(2)}s`,
        `queueRemaining=${taskQueue.length}`,
      );

      self.postMessage({
        type: 'PROGRESS',
        payload: { message: `Transcribing segment ${task.chunkIndex + 1}…` },
      });

      try {
        const output = await (transcriber as (
          data: Float32Array,
          opts: Record<string, unknown>,
        ) => Promise<{ chunks: Array<{ text: string; timestamp: [number, number | null] }> }>)(
          task.audioData,
          {
            return_timestamps: 'word',
          },
        );

        // Filter out words in the pre-roll frames that belong to the previous chunk
        const words = output.chunks
          .filter(
            (c) =>
              c.timestamp[0] !== null &&
              (c.timestamp[1] ?? c.timestamp[0] + 0.2) > safePadding + 0.03,
          )
          .map((c) => {
            const rawStart = c.timestamp[0] - safePadding;
            const rawEnd = (c.timestamp[1] ?? c.timestamp[0] + 0.3) - safePadding;
            const localStart = Math.max(0, rawStart);
            const localEnd = Math.max(localStart + 0.05, rawEnd);
            return {
              word: c.text.trim(),
              start: task.startTime + localStart,
              end: task.startTime + localEnd,
            };
          })
          .filter((w) => w.word.length > 0);

        const result = {
          chunkIndex: task.chunkIndex,
          startTime: task.startTime,
          endTime:
            words.length > 0
              ? words[words.length - 1].end
              : task.startTime + task.chunkDuration,
          words,
        };

        self.postMessage({ type: 'CHUNK_COMPLETE', payload: result });
      } catch (err) {
        console.error(`[WhisperWorker] chunk ${task.chunkIndex} failed:`, err);
        self.postMessage({
          type: 'ERROR',
          payload: { chunkIndex: task.chunkIndex, error: String(err) },
        });
      } finally {
        activeChunkIndex = null;
      }
    }
  } catch (err) {
    console.error('[WhisperWorker] Model initialisation failed:', err);
  } finally {
    isProcessingQueue = false;
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent) => {
  const { type, payload } = e.data as {
    type: string;
    payload: ChunkTask;
  };

  if (type !== 'PROCESS_CHUNK') return;

  // Deduplicate: ignore if this chunk is already being processed or queued
  if (
    activeChunkIndex === payload.chunkIndex ||
    taskQueue.some((t) => t.chunkIndex === payload.chunkIndex)
  ) {
    return;
  }

  taskQueue.push(payload);
  void processQueue();
};

