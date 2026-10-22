/**
 * CapacitorNativeEngine.ts
 *
 * Capacitor-native implementation of IMediaEngine.
 * Delegates audio chunking to FFmpeg/MediaCodec and transcription to whisper.cpp
 * via the NativeMediaProcessor Capacitor plugin.
 *
 * On native platforms this replaces WebMediaEngine entirely — no WASM, no Web Audio API.
 */

import type { IMediaEngine, SynkroManifest } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { NativeMediaProcessor } from '../../plugins/CapacitorMediaPlugin';
import {
  tokenizeBookText,
  alignChunk,
  resetAlignmentCursor,
} from '../textAligner';
import { Storage } from '../storage';

export class CapacitorNativeEngine implements IMediaEngine {
  public readonly CHUNK_DURATION = 60; // seconds — smaller on mobile for RAM safety
  private processingChunks = new Set<number>();
  private nativeFilePath: string | null = null;

  getChunkIndex(time: number): number {
    return Math.floor(time / this.CHUNK_DURATION);
  }

  onTimeUpdate(currentTime: number) {
    const idx = this.getChunkIndex(currentTime);
    const state = useAppStore.getState();
    const aligned = state.alignedChunks[idx];
    if (!aligned) {
      if (!state.isChunkBuffering && state.currentBook && idx < state.currentBook.chunks) {
        state.setChunkBuffering(true);
      }
    } else if (state.isChunkBuffering) {
      state.setChunkBuffering(false);
    }
    void this.ensureChunkProcessed(idx);
    void this.ensureChunkProcessed(idx + 1);
  }

  async ensureChunkProcessed(chunkIndex: number): Promise<void> {
    const state = useAppStore.getState();
    if (!state.currentBook || chunkIndex >= state.currentBook.chunks) return;
    if (state.alignedChunks[chunkIndex] || this.processingChunks.has(chunkIndex)) return;

    // Cache hit
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

    if (!this.nativeFilePath) { return; }

    this.processingChunks.add(chunkIndex);
    const startTime = chunkIndex * this.CHUNK_DURATION;

    try {
      useAppStore.getState().setLoadingMessage(`Native: processing chunk ${chunkIndex + 1}…`);
      const raw = await NativeMediaProcessor.processChunk({
        chunkFilePath: this.nativeFilePath,
        chunkIndex,
        startTime,
      });

      await Storage.putTranscript(state.currentBook.id, chunkIndex, raw);
      const aligned = alignChunk(
        state.currentBook.bookWords,
        raw.words,
        raw.chunkIndex,
        raw.startTime,
        raw.endTime,
      );
      state.addAlignedChunk(chunkIndex, raw, aligned);
      this.processingChunks.delete(chunkIndex);

      const currentChunk = this.getChunkIndex(state.currentTime);
      if (raw.chunkIndex === currentChunk && state.isChunkBuffering) {
        state.setChunkBuffering(false);
      }
    } catch (err) {
      console.error('[CapacitorNativeEngine] processChunk failed:', err);
      this.processingChunks.delete(chunkIndex);
    }
  }

  async loadBook(
    audioFile: File,
    textFile: File,
    _initialManifest?: SynkroManifest | null,
    _dirHandle?: FileSystemDirectoryHandle | null,
  ): Promise<void> {
    const state = useAppStore.getState();
    state.setLoadingMessage('Native: loading book…');

    // On Capacitor, files are accessed via native paths; for the web-mock we use a URL.
    // In a real Capacitor project, use `@capacitor/filesystem` to get the native path.
    this.nativeFilePath = URL.createObjectURL(audioFile);

    const textContent = await textFile.text();
    const { bookWords, paragraphs } = tokenizeBookText(textContent);
    resetAlignmentCursor();

    // Duration estimation (native side would provide this; we mock here)
    const duration = await new Promise<number>((resolve) => {
      const el = new Audio(this.nativeFilePath!);
      el.addEventListener('loadedmetadata', () => { resolve(el.duration); el.src = ''; });
      el.addEventListener('error', () => resolve(300));
    });

    const bookId = `${audioFile.name}_${audioFile.size}_${textFile.name}_${textFile.size}`
      .replace(/[^a-zA-Z0-9_]/g, '_');

    state.setBook({
      id: bookId,
      title: audioFile.name.replace(/\.[^.]+$/, ''),
      audioUrl: this.nativeFilePath,
      textUrl: URL.createObjectURL(textFile),
      text: textContent,
      bookWords,
      paragraphs,
      duration,
      chunks: Math.ceil(duration / this.CHUNK_DURATION),
    });

    state.setLoadingMessage('');
    void this.ensureChunkProcessed(0);
  }

  dispose(): void {
    if (this.nativeFilePath?.startsWith('blob:')) {
      URL.revokeObjectURL(this.nativeFilePath);
    }
    this.nativeFilePath = null;
  }
}
