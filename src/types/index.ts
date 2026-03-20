export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface ChunkTranscript {
  chunkIndex: number;
  startTime: number;
  endTime: number;
  words: WordTimestamp[];
}

export interface Book {
  id: string; // Hash of audio + text
  title: string;
  audioUrl: string | File;
  textUrl: string | File;
  text: string;
  duration: number; // total duration
  chunks: number; // total number of chunks
}

export type StorageMode = 'SMART' | 'KEEP_ALL' | 'LITE_MODE';