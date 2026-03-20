import { create } from 'zustand';
import type { Book, StorageMode, ChunkTranscript } from '../types';

interface AppState {
  currentBook: Book | null;
  transcripts: Record<number, ChunkTranscript>;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  storageMode: StorageMode;
  
  isChunkBuffering: boolean;
  loadingMessage: string;
  
  // Actions
  setBook: (book: Book) => void;
  setCurrentTime: (time: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setChunkBuffering: (buffering: boolean) => void;
  setLoadingMessage: (msg: string) => void;
  setPlaybackRate: (rate: number) => void;
  setStorageMode: (mode: StorageMode) => void;
  addTranscript: (chunkIndex: number, transcript: ChunkTranscript) => void;
}

export const useAppStore = create<AppState>((set) => ({
  currentBook: null,
  transcripts: {},
  currentTime: 0,
  isPlaying: false,
  playbackRate: 1.0,
  storageMode: 'SMART',
  isChunkBuffering: false,
  loadingMessage: '',

  setBook: (book) => set({ currentBook: book, transcripts: {}, currentTime: 0, isChunkBuffering: false }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setChunkBuffering: (buffering) => set({ isChunkBuffering: buffering }),
  setLoadingMessage: (msg) => set({ loadingMessage: msg }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setStorageMode: (mode) => set({ storageMode: mode }),
  addTranscript: (chunkIndex, transcript) => set((state) => ({
    transcripts: {
      ...state.transcripts,
      [chunkIndex]: transcript,
    }
  })),
}));
