/**
 * WebMediaEngine.ts
 *
 * Browser implementation of IMediaEngine.
 * Fixes:
 *  • AudioContext reuse (single shared ctx, close via try/finally when needed)
 *  • Zero-copy ArrayBuffer transfer to whisperWorker
 *  • Deterministic book ID
 *  • Object URL cleanup
 *  • IndexedDB cache-before-worker (StorageMode-aware)
 *  • Accurate paddingTime clamping
 */

import type { IMediaEngine, ChunkTranscript, AlignedChunk } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { Storage } from '../storage';
import {
  tokenizeBookText,
  alignChunk,
  resetAlignmentCursor,
} from '../textAligner';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// ─── Shared AudioContext ───────────────────────────────────────────────────────

// One shared AudioContext for the lifetime of the engine instance.
// We do NOT close it between chunks — closing and recreating hits browser limits.
let _sharedAudioCtx: AudioContext | null = null;

function getSharedAudioCtx(): AudioContext {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === 'closed') {
    _sharedAudioCtx = new AudioContext({ sampleRate: 16000 });
  }
  return _sharedAudioCtx;
}

// ─── Book ID hash ─────────────────────────────────────────────────────────────

function makeBookId(audio: File, text: File): string {
  return `${audio.name}_${audio.size}_${text.name}_${text.size}`
    .replace(/[^a-zA-Z0-9_]/g, '_');
}

// ─── WebMediaEngine ───────────────────────────────────────────────────────────

export class WebMediaEngine implements IMediaEngine {
  private worker: Worker | null = null;
  private processingChunks = new Set<number>();
  private audioFile: File | null = null;
  private previousAudioUrl: string | null = null;
  private previousTextUrl: string | null = null;
  private audioStartOffset = 0;
  private detectedBitrate = 128;
  private detectedSampleRate = 44100;

  public readonly CHUNK_DURATION = 30; // seconds — Whisper's native 30s window

  constructor() {
    this._initWorker();
  }

  // ─── Worker lifecycle ────────────────────────────────────────────────────

  private _initWorker() {
    if (typeof Worker === 'undefined') return;
    this.worker = new Worker(
      new URL('../whisperWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.onmessage = (e: MessageEvent) => {
      const { type, payload } = e.data as {
        type: string;
        payload: ChunkTranscript & { message?: string; chunkIndex?: number };
      };

      if (type === 'CHUNK_COMPLETE') {
        this._handleChunkComplete(payload as ChunkTranscript);
      } else if (type === 'PROGRESS') {
        useAppStore.getState().setLoadingMessage(
          (payload as unknown as { message: string }).message,
        );
      } else if (type === 'ERROR') {
        console.error('[WebMediaEngine] Worker error:', payload);
        if (typeof payload.chunkIndex === 'number') {
          this.processingChunks.delete(payload.chunkIndex);
        }
      }
    };
  }

  private _handleChunkComplete(raw: ChunkTranscript) {
    const state = useAppStore.getState();
    const book = state.currentBook;
    this.processingChunks.delete(raw.chunkIndex);

    // Persist to IndexedDB
    if (book) {
      void Storage.putTranscript(book.id, raw.chunkIndex, raw);

      // Run text alignment
      const aligned: AlignedChunk = alignChunk(
        book.bookWords,
        raw.words,
        raw.chunkIndex,
        raw.startTime,
        raw.endTime,
      );
      state.addAlignedChunk(raw.chunkIndex, raw, aligned);

      // Evict per StorageMode
      const mode = state.storageMode;
      const currentChunk = this.getChunkIndex(state.currentTime);
      const keep = Storage.keepWindowIndices(currentChunk, book.chunks, mode);
      void Storage.evictChunks(book.id, keep);

      // Clear buffering flag if this is the needed chunk
      if (raw.chunkIndex === currentChunk && state.isChunkBuffering) {
        state.setChunkBuffering(false);
      }

      // Pre-buffer lookahead: proactively keep next chunks queued in the worker
      void this.ensureChunkProcessed(raw.chunkIndex + 1);
      void this.ensureChunkProcessed(raw.chunkIndex + 2);
    }
  }

  // ─── IMediaEngine ─────────────────────────────────────────────────────────

  getChunkIndex(time: number): number {
    return Math.floor(time / this.CHUNK_DURATION);
  }

  onTimeUpdate(currentTime: number) {
    const currentChunkIndex = this.getChunkIndex(currentTime);
    const state = useAppStore.getState();
    const isCurrentReady = !!(state.alignedChunks[currentChunkIndex] || state.transcripts[currentChunkIndex]);

    if (!isCurrentReady) {
      if (!state.isChunkBuffering && state.currentBook &&
          currentChunkIndex < state.currentBook.chunks) {
        state.setChunkBuffering(true);
      }
    } else if (state.isChunkBuffering) {
      state.setChunkBuffering(false);
    }

    // Keep next 2 chunks continuously warm in the pipeline
    void this.ensureChunkProcessed(currentChunkIndex);
    void this.ensureChunkProcessed(currentChunkIndex + 1);
    void this.ensureChunkProcessed(currentChunkIndex + 2);
  }

  /**
   * Fast, stateless MPEG Layer 3 frame sync finder.
   * Scans within +/- 32 bytes of the mathematical ideal byte to lock onto exact 0xFF 0xFA/0xFB sync.
   * Completely immune to async race conditions across concurrent chunks!
   */
  private async _findFrameSyncNear(idealByte: number): Promise<number> {
    if (!this.audioFile) return idealByte;
    const start = Math.max(this.audioStartOffset, idealByte - 32);
    const readLen = Math.min(64, this.audioFile.size - start);
    if (readLen <= 4) return idealByte;

    const sliceBuf = await this.audioFile.slice(start, start + readLen).arrayBuffer();
    const u8 = new Uint8Array(sliceBuf);

    for (let i = 0; i < u8.length - 4; i++) {
      if (u8[i] === 0xFF && (u8[i + 1] & 0xFE) === 0xFA) {
        return start + i;
      }
    }
    return idealByte;
  }

  async ensureChunkProcessed(chunkIndex: number): Promise<void> {
    const state = useAppStore.getState();
    if (!state.currentBook || chunkIndex >= state.currentBook.chunks) return;
    if (state.alignedChunks[chunkIndex] || this.processingChunks.has(chunkIndex)) return;

    // ── Cache hit ──────────────────────────────────────────────────────
    const cached = await Storage.getTranscript(state.currentBook.id, chunkIndex);
    if (cached) {
      const aligned = alignChunk(
        state.currentBook.bookWords,
        cached.words,
        cached.chunkIndex,
        cached.startTime,
        cached.endTime,
      );
      state.addAlignedChunk(chunkIndex, cached, aligned);
      return;
    }

    // ── Decode slice + send to worker (Memory-safe: ~1 MB per chunk) ───
    this.processingChunks.add(chunkIndex);

    if (!this.worker) {
      this._initWorker();
    }

    if (!this.worker || !this.audioFile) {
      this.processingChunks.delete(chunkIndex);
      return;
    }

    const SAMPLES_PER_FRAME = 1152;
    const sampleRate = this.detectedSampleRate || 44100;
    const framesPerChunk = Math.floor((this.CHUNK_DURATION * sampleRate) / SAMPLES_PER_FRAME);
    const exactChunkDuration = (framesPerChunk * SAMPLES_PER_FRAME) / sampleRate;
    const byteRate = ((this.detectedBitrate || 128) * 1000) / 8;
    const bytesPerChunk = exactChunkDuration * byteRate;

    const exactStartTime = chunkIndex * exactChunkDuration;

    // Exact non-overlapping start byte
    const idealStartByte = this.audioStartOffset + Math.round(chunkIndex * bytesPerChunk);
    const exactStartByte =
      chunkIndex === 0
        ? this.audioStartOffset
        : await this._findFrameSyncNear(idealStartByte);

    // Preroll 4 frames (~1,672 bytes) before exactStartByte to prime MP3 bit reservoir
    const PREROLL_BYTES = chunkIndex === 0 ? 0 : 4 * 418;
    const idealPrerollByte = Math.max(this.audioStartOffset, exactStartByte - PREROLL_BYTES);
    const sliceStartByte =
      chunkIndex === 0
        ? this.audioStartOffset
        : await this._findFrameSyncNear(idealPrerollByte);

    const paddingBytes = Math.max(0, exactStartByte - sliceStartByte);
    const paddingTime = byteRate > 0 ? paddingBytes / byteRate : 0;

    // Exact non-overlapping end byte (meets next chunk's start byte)
    const idealEndByte = this.audioStartOffset + Math.round((chunkIndex + 1) * bytesPerChunk);
    const exactEndByte = await this._findFrameSyncNear(idealEndByte);
    const sliceEndByte = Math.min(this.audioFile.size, exactEndByte + 4 * 418);

    try {
      const chunkBlob = this.audioFile.slice(sliceStartByte, sliceEndByte, this.audioFile.type);

      useAppStore.getState().setLoadingMessage(`Decoding segment ${chunkIndex + 1}…`);
      const { audioData } = await this._decodeAudioSlice(chunkBlob, true);

      // Zero-copy transfer: pass audioData.buffer in the transfer list.
      this.worker.postMessage(
        {
          type: 'PROCESS_CHUNK',
          payload: {
            chunkIndex,
            startTime: exactStartTime,
            paddingTime,
            audioData, // Float32Array
            chunkDuration: this.CHUNK_DURATION,
          },
        },
        [audioData.buffer], // Transferable zero-copy
      );
    } catch (err) {
      console.error('[WebMediaEngine] Error decoding chunk slice', chunkIndex, err);
      useAppStore.getState().setLoadingMessage(`Error preparing segment ${chunkIndex + 1}`);
      this.processingChunks.delete(chunkIndex);
    }
  }

  async loadBook(audioFile: File, textFile: File): Promise<void> {
    const state = useAppStore.getState();
    state.setLoadingMessage('Initialising book…');

    // ── Revoke previous Object URLs ─────────────────────────────────────
    if (this.previousAudioUrl) URL.revokeObjectURL(this.previousAudioUrl);
    if (this.previousTextUrl) URL.revokeObjectURL(this.previousTextUrl);

    this.audioFile = audioFile;
    const audioUrl = URL.createObjectURL(audioFile);
    const textUrl = URL.createObjectURL(textFile);
    this.previousAudioUrl = audioUrl;
    this.previousTextUrl = textUrl;

    // ── Audio metadata & ID3v2 stream offset ──────────────────────────
    state.setLoadingMessage('Reading audio stream headers…');
    let detectedDuration: number | null = null;
    let startOffset = 0;

    try {
      const headerBuf = await audioFile.slice(0, 131072).arrayBuffer();
      const u8 = new Uint8Array(headerBuf);

      if (u8.length >= 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
        const tagSize =
          ((u8[6] & 0x7f) << 21) |
          ((u8[7] & 0x7f) << 14) |
          ((u8[8] & 0x7f) << 7) |
          (u8[9] & 0x7f);
        const hasFooter = (u8[5] & 0x10) !== 0;
        startOffset = 10 + tagSize + (hasFooter ? 10 : 0);
      }

      this.audioStartOffset = startOffset;

      // Read first frame header after ID3v2
      if (startOffset < u8.length - 4) {
        for (let i = startOffset; i < Math.min(u8.length - 4, startOffset + 8192); i++) {
          if (u8[i] === 0xFF && (u8[i + 1] & 0xE0) === 0xE0) {
            const h = (u8[i] << 24) | (u8[i + 1] << 16) | (u8[i + 2] << 8) | u8[i + 3];
            const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
            const mpeg1SampleRates = [44100, 48000, 32000];
            const bIdx = (h >> 12) & 0x0F;
            const sIdx = (h >> 10) & 0x03;

            this.detectedBitrate = mpeg1Bitrates[bIdx] || 128;
            this.detectedSampleRate = mpeg1SampleRates[sIdx] || 44100;
            this.audioStartOffset = i;

            // Check for Info / Xing header inside first frame
            const infoOffset = i + 36;
            if (infoOffset + 12 < u8.length) {
              const magic = String.fromCharCode(u8[infoOffset], u8[infoOffset + 1], u8[infoOffset + 2], u8[infoOffset + 3]);
              if (magic === 'Info' || magic === 'Xing') {
                const flags =
                  (u8[infoOffset + 4] << 24) |
                  (u8[infoOffset + 5] << 16) |
                  (u8[infoOffset + 6] << 8) |
                  u8[infoOffset + 7];
                if (flags & 0x01) {
                  const totalFrames =
                    (u8[infoOffset + 8] << 24) |
                    (u8[infoOffset + 9] << 16) |
                    (u8[infoOffset + 10] << 8) |
                    u8[infoOffset + 11];
                  if (totalFrames > 0) {
                    detectedDuration = (totalFrames * 1152) / this.detectedSampleRate;
                  }
                }
              }
            }
            break;
          }
        }
      }
    } catch (err) {
      console.warn('[WebMediaEngine] Error parsing stream headers:', err);
    }

    // ── Duration resolution ─────────────────────────────────────────────
    let duration = detectedDuration;
    if (!duration || !Number.isFinite(duration) || duration <= 0) {
      duration = await new Promise<number>((resolve) => {
        const el = new Audio();
        el.preload = 'metadata';
        const onLoaded = () => {
          const d = el.duration;
          cleanup();
          resolve(Number.isFinite(d) && d > 0 ? d : 300);
        };
        const onError = () => {
          cleanup();
          resolve(300);
        };
        const cleanup = () => {
          el.removeEventListener('loadedmetadata', onLoaded);
          el.removeEventListener('error', onError);
          el.src = '';
        };
        el.addEventListener('loadedmetadata', onLoaded);
        el.addEventListener('error', onError);
        el.src = audioUrl;
        setTimeout(() => {
          if (el.duration && Number.isFinite(el.duration) && el.duration > 0) {
            onLoaded();
          } else {
            onError();
          }
        }, 3000);
      });
    }

    // ── Text extraction ─────────────────────────────────────────────────
    const textContent = await this._extractText(textFile);

    // ── Tokenise book text ──────────────────────────────────────────────
    state.setLoadingMessage('Tokenising book text…');
    const { bookWords, paragraphs } = tokenizeBookText(textContent);
    resetAlignmentCursor();

    // ── Deterministic book ID ──────────────────────────────────────────
    const bookId = makeBookId(audioFile, textFile);

    state.setBook({
      id: bookId,
      title: audioFile.name.replace(/\.[^.]+$/, ''),
      audioUrl,
      textUrl,
      text: textContent,
      bookWords,
      paragraphs,
      duration,
      chunks: Math.ceil(duration / this.CHUNK_DURATION),
    });

    state.setLoadingMessage('');

    // Kick off chunks 0, 1, and 2 immediately into the worker sequential queue
    void this.ensureChunkProcessed(0);
    void this.ensureChunkProcessed(1);
    void this.ensureChunkProcessed(2);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.audioFile = null;
    this.audioStartOffset = 0;
    this.processingChunks.clear();
    if (this.previousAudioUrl) {
      URL.revokeObjectURL(this.previousAudioUrl);
      this.previousAudioUrl = null;
    }
    if (this.previousTextUrl) {
      URL.revokeObjectURL(this.previousTextUrl);
      this.previousTextUrl = null;
    }
    _sharedAudioCtx?.close().catch(() => {/* ignore */});
    _sharedAudioCtx = null;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Decode a single 30s audio Blob slice to 16 kHz mono Float32Array.
   * Returns audio data and the exact byte count discarded during MPEG sync search.
   * Keeps memory footprint strictly bounded to ~1-2 MB.
   */
  private async _decodeAudioSlice(
    blob: Blob,
    isStartOfChunk0: boolean,
  ): Promise<{ audioData: Float32Array; bytesDiscarded: number }> {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = getSharedAudioCtx();

    let bufferToDecode = arrayBuffer;
    let bytesDiscarded = 0;

    // Slices past byte 0 may start mid-frame: scan for valid MPEG frame sync
    if (!isStartOfChunk0) {
      const u8 = new Uint8Array(arrayBuffer);
      for (let i = 0; i < Math.min(u8.length - 4, 8192); i++) {
        if (u8[i] === 0xFF && (u8[i + 1] & 0xE0) === 0xE0) {
          const layer = (u8[i + 1] >> 1) & 0x03;
          if (layer !== 0) {
            bufferToDecode = arrayBuffer.slice(i);
            bytesDiscarded = i;
            break;
          }
        }
      }
    }

    let decoded: AudioBuffer;
    try {
      decoded = await audioCtx.decodeAudioData(bufferToDecode);
    } catch {
      // Fallback: decode untrimmed buffer
      decoded = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
      bytesDiscarded = 0;
    }

    if (decoded.sampleRate === 16000 && decoded.numberOfChannels === 1) {
      return { audioData: decoded.getChannelData(0), bytesDiscarded };
    }

    // Resample 30s slice to mono 16 kHz
    const targetLength = Math.max(1, Math.ceil(decoded.duration * 16000));
    const offline = new OfflineAudioContext(1, targetLength, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const resampled = await offline.startRendering();
    return { audioData: resampled.getChannelData(0), bytesDiscarded };
  }

  /** Extract plain text from TXT or PDF. */
  private async _extractText(file: File): Promise<string> {
    const { setLoadingMessage } = useAppStore.getState();
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      setLoadingMessage('Parsing PDF…');
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let out = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        setLoadingMessage(`Extracting text (page ${i}/${pdf.numPages})…`);
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        out += content.items.map((it: Record<string, unknown>) => it['str'] as string).join(' ') + '\n';
      }
      return out;
    }
    setLoadingMessage('Reading text file…');
    return file.text();
  }
}
