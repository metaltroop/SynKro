// ─── Core word types ───────────────────────────────────────────────────────────

/** A word as output by Whisper — carries an audio timestamp. */
export interface WordTimestamp {
  word: string;
  start: number; // seconds, global
  end: number;   // seconds, global
}

/** A word tokenised from the book text, with optional aligned timestamp. */
export interface BookWord {
  /** Original text including punctuation. */
  text: string;
  /** Cleaned lowercase form used for matching. */
  normalized: string;
  /** Global-time start, assigned after alignment (undefined until aligned). */
  start?: number;
  /** Global-time end, assigned after alignment (undefined until aligned). */
  end?: number;
  /** Index into the flat BookWord[] array. */
  index: number;
  /** Index of the paragraph this word belongs to. */
  paragraphIndex: number;
  /** Index within its own paragraph. */
  wordIndexInParagraph: number;
}

/** A paragraph as tokenised from book text. */
export interface BookParagraph {
  index: number;
  words: BookWord[];
}

/** A chunk of aligned text — what the UI actually renders. */
export interface AlignedChunk {
  chunkIndex: number;
  startTime: number;
  endTime: number;
  /** Words with timestamps resolved against real book text. */
  words: BookWord[];
  /** True when audio does not match book text and shows direct Whisper tokens. */
  isDirectTranscript?: boolean;
}

// ─── Transcript (raw Whisper output) ──────────────────────────────────────────

export interface ChunkTranscript {
  chunkIndex: number;
  startTime: number;
  endTime: number;
  words: WordTimestamp[];
}

// ─── Book ─────────────────────────────────────────────────────────────────────

export interface Book {
  /** Deterministic hash: `${audioName}_${audioSize}_${textName}_${textSize}`. */
  id: string;
  title: string;
  audioUrl: string;
  textUrl: string;
  text: string;
  /** Flat array of all tokenised book words. */
  bookWords: BookWord[];
  /** Grouped by paragraph. */
  paragraphs: BookParagraph[];
  duration: number;
  chunks: number;
  audioFileName?: string;
  textFileName?: string;
  dirHandle?: FileSystemDirectoryHandle;
  coverUrl?: string;
  totalPages?: number;
  pageWordIndices?: number[];
  isCompileFullEnabled?: boolean;
}

// ─── v2 Portable Manifest & Metadata ──────────────────────────────────────────

export interface SynkroManifest {
  version: 2;
  bookId: string;
  title: string;
  audioFileName: string;
  textFileName: string;
  duration: number;
  chunkDuration: number;
  totalChunks: number;
  syncOffsetMs: number;
  playbackRate: number;
  lastPlayedTime: number;
  updatedAt: string;
  coverUrl?: string;
  isCompileFullEnabled?: boolean;
  transcripts: Record<number, ChunkTranscript>;
}

export interface BookMetadata {
  id: string;
  title: string;
  duration: number;
  totalChunks: number;
  compiledChunks: number;
  lastPlayedTime: number;
  updatedAt: string;
  audioFileName?: string;
  textFileName?: string;
  syncOffsetMs?: number;
  playbackRate?: number;
  dirHandle?: FileSystemDirectoryHandle;
  coverUrl?: string;
  isCompileFullEnabled?: boolean;
}

export type ReadingViewMode = 'scroll' | 'book';

// ─── Storage ──────────────────────────────────────────────────────────────────

export type StorageMode = 'SMART' | 'KEEP_ALL' | 'LITE_MODE';

// ─── Media Engine Interface (Platform Adapter) ────────────────────────────────

export interface IMediaEngine {
  /** Load audio + text, populate book state, kick off chunk 0. */
  loadBook(
    audioFile: File,
    textFile: File,
    initialManifest?: SynkroManifest | null,
    dirHandle?: FileSystemDirectoryHandle | null,
  ): Promise<void>;
  /** Ensure chunk N is processed (idempotent). */
  ensureChunkProcessed(chunkIndex: number): void;
  /** Notify engine of current playback time. */
  onTimeUpdate(currentTime: number): void;
  /** Full-book pre-transcription compilation methods */
  startFullTranscription?(): void;
  stopFullTranscription?(): void;
  /** Cleanup resources. */
  dispose(): void;
}