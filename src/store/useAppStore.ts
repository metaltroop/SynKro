import { create } from 'zustand';
import type { Book, StorageMode, ChunkTranscript, AlignedChunk } from '../types';

interface AppState {
  currentBook: Book | null;
  /** Raw Whisper transcripts, keyed by chunkIndex */
  transcripts: Record<number, ChunkTranscript>;
  /** Text-aligned chunks (real book words with timestamps), keyed by chunkIndex */
  alignedChunks: Record<number, AlignedChunk>;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  storageMode: StorageMode;
  isChunkBuffering: boolean;
  loadingMessage: string;
  isFullTranscribing: boolean;
  fullTranscribeETA: string | null;
  syncOffsetMs: number;
  readingViewMode: 'scroll' | 'book';
  currentPageIndex: number;

  // ── Actions ────────────────────────────────────────────────────────────────
  setBook: (book: Book) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setChunkBuffering: (buffering: boolean) => void;
  setLoadingMessage: (msg: string) => void;
  setPlaybackRate: (rate: number) => void;
  setStorageMode: (mode: StorageMode) => void;
  setFullTranscribing: (val: boolean) => void;
  setFullTranscribeETA: (eta: string | null) => void;
  setSyncOffsetMs: (ms: number) => void;
  setReadingViewMode: (mode: 'scroll' | 'book') => void;
  setCurrentPageIndex: (page: number) => void;
  /**
   * Stores both the raw transcript and the aligned chunk together.
   * Called by engines after alignment completes.
   */
  addAlignedChunk: (
    chunkIndex: number,
    transcript: ChunkTranscript,
    aligned: AlignedChunk,
  ) => void;
  /** Legacy compat — some code paths still call addTranscript directly. */
  addTranscript: (chunkIndex: number, transcript: ChunkTranscript) => void;
  /** Evict chunks from in-memory store (called by SMART / LITE_MODE). */
  evictInMemory: (keepIndices: Set<number>) => void;
  /** Go back to the library (clears current book). */
  resetBook: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentBook: null,
  transcripts: {},
  alignedChunks: {},
  currentTime: 0,
  isPlaying: false,
  playbackRate: 1.0,
  storageMode: 'SMART',
  isChunkBuffering: false,
  loadingMessage: '',
  isFullTranscribing: false,
  fullTranscribeETA: null,
  syncOffsetMs: 0,
  readingViewMode: 'scroll',
  currentPageIndex: 0,

  setBook: (book) =>
    set({
      currentBook: book,
      transcripts: {},
      alignedChunks: {},
      currentTime: 0,
      isPlaying: false,
      isChunkBuffering: false,
      isFullTranscribing: false,
      fullTranscribeETA: null,
      syncOffsetMs: 0,
      readingViewMode: 'scroll',
      currentPageIndex: 0,
    }),

  setCurrentTime: (time) => set({ currentTime: time }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setChunkBuffering: (buffering) => set({ isChunkBuffering: buffering }),
  setLoadingMessage: (msg) => set({ loadingMessage: msg }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setStorageMode: (mode) => set({ storageMode: mode }),
  setFullTranscribing: (val) => set({ isFullTranscribing: val }),
  setFullTranscribeETA: (eta) => set({ fullTranscribeETA: eta }),
  setSyncOffsetMs: (ms) => set({ syncOffsetMs: ms }),
  setReadingViewMode: (mode) => set({ readingViewMode: mode }),
  setCurrentPageIndex: (page) => set({ currentPageIndex: page }),

  addAlignedChunk: (chunkIndex, transcript, aligned) =>
    set((state) => ({
      transcripts: { ...state.transcripts, [chunkIndex]: transcript },
      alignedChunks: { ...state.alignedChunks, [chunkIndex]: aligned },
    })),

  addTranscript: (chunkIndex, transcript) =>
    set((state) => ({
      transcripts: { ...state.transcripts, [chunkIndex]: transcript },
    })),

  evictInMemory: (keepIndices) =>
    set((state) => {
      const transcripts: Record<number, ChunkTranscript> = {};
      const alignedChunks: Record<number, AlignedChunk> = {};
      for (const idx of keepIndices) {
        if (state.transcripts[idx]) transcripts[idx] = state.transcripts[idx];
        if (state.alignedChunks[idx]) alignedChunks[idx] = state.alignedChunks[idx];
      }
      return { transcripts, alignedChunks };
    }),

  resetBook: () =>
    set({
      currentBook: null,
      transcripts: {},
      alignedChunks: {},
      currentTime: 0,
      isPlaying: false,
      isChunkBuffering: false,
      loadingMessage: '',
      isFullTranscribing: false,
      fullTranscribeETA: null,
      syncOffsetMs: 0,
      readingViewMode: 'scroll',
      currentPageIndex: 0,
    }),
}));
