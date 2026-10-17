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
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export type StorageMode = 'SMART' | 'KEEP_ALL' | 'LITE_MODE';

// ─── Media Engine Interface (Platform Adapter) ────────────────────────────────

export interface IMediaEngine {
  /** Load audio + text, populate book state, kick off chunk 0. */
  loadBook(audioFile: File, textFile: File): Promise<void>;
  /** Ensure chunk N is processed (idempotent). */
  ensureChunkProcessed(chunkIndex: number): void;
  /** Notify engine of current playback time. */
  onTimeUpdate(currentTime: number): void;
  /** Cleanup resources. */
  dispose(): void;
}