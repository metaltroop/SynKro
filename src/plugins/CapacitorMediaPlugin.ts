import type { ChunkTranscript } from '../types';

/**
 * Skeleton for Capacitor Plugin that handles FFmpeg and whisper.cpp processing.
 * This should be registered as a Capacitor plugin using `@capacitor/core` in an actual native project.
 */
export interface NativeMediaProcessingPlugin {
  /**
   * Run FFmpeg command natively to chunk audio
   */
  chunkAudio(options: { 
    filePath: string, 
    outputDir: string, 
    chunkDurationSec: number 
  }): Promise<{ success: boolean; chunks: number }>;

  /**
   * Run whisper.cpp given an audio chunk and the actual text for alignment
   */
  processChunk(options: { 
    chunkFilePath: string, 
    textFilePath?: string, // The segment of text expected in this chunk
    chunkIndex: number,
    startTime: number
  }): Promise<ChunkTranscript>;
}

// In a real project, this would be: import { registerPlugin } from '@capacitor/core';
// export const NativeMediaProcessor = registerPlugin<NativeMediaProcessingPlugin>('NativeMediaProcessor');

// MOCK Native Plugin for UI development
export const NativeMediaProcessor: NativeMediaProcessingPlugin = {
  chunkAudio: async (options) => {
    console.log('[Native plugin] chunkAudio', options);
    // Simulate FFmpeg processing time
    await new Promise(r => setTimeout(r, 2000));
    return { success: true, chunks: 10 };
  },
  processChunk: async (options) => {
    console.log('[Native plugin] processChunk', options);
    // Simulate Whisper processing
    await new Promise(r => setTimeout(r, 3000));
    return {
      chunkIndex: options.chunkIndex,
      startTime: options.startTime,
      endTime: options.startTime + 60,
      words: [
        { word: 'Simulated', start: options.startTime + 1, end: options.startTime + 1.5 },
        { word: 'whisper', start: options.startTime + 1.6, end: options.startTime + 2.0 },
        { word: 'output', start: options.startTime + 2.1, end: options.startTime + 2.5 },
        { word: 'from', start: options.startTime + 2.6, end: options.startTime + 2.9 },
        { word: 'native', start: options.startTime + 3.0, end: options.startTime + 3.5 },
        { word: 'plugin.', start: options.startTime + 3.6, end: options.startTime + 4.0 },
      ]
    };
  }
};
