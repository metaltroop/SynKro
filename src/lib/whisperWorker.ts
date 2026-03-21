import { pipeline, env } from '@huggingface/transformers';

// Disable local models to fetch from HF Hub
env.allowLocalModels = false;

// We use a singleton class for the pipeline to load it only once
class PipelineSingleton {
  static task = 'automatic-speech-recognition';
  static model = 'Xenova/whisper-tiny.en';
  static instance: any = null;

  static async getInstance(progress_callback?: any) {
      if (this.instance === null) {
          this.instance = await pipeline(this.task as any, this.model, { progress_callback });
      }
      return this.instance;
  }
}

// Model is shared across all chunk requests
const modelPromise = PipelineSingleton.getInstance((x: any) => {
  self.postMessage({ type: 'PROGRESS', payload: { 
    message: x.status === 'progress' ? `Downloading AI Model: ${Math.round(x.progress)}%` : `AI Engine: ${x.status}...`,
    detail: x
  }});
});

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'PROCESS_CHUNK') {
    const { chunkIndex, startTime, paddingTime, audioData, chunkDuration } = payload;
    
    console.log(`[Whisper Worker] Chunk ${chunkIndex}: Audio data received (${Math.round(audioData.length / 16000)}s length)`);
    
    try {
      // 1. Ensure model is ready
      const transcriber = await modelPromise;

      // 2. Transcribe
      console.log(`[Whisper Worker] Transcribing chunk ${chunkIndex}...`);
      self.postMessage({ type: 'PROGRESS', payload: { message: `Analyzing audio ${chunkIndex}...` } });
      
      const output = await transcriber(audioData, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: 'word'
      });
      
      // 4. Map timestamps back to global time
      // Subtract paddingTime (extra audio at start of slice) and add global startTime
      const words = output.chunks.map((chunk: any) => ({
        word: chunk.text.trim(),
        start: startTime + (chunk.timestamp[0] - paddingTime),
        end: startTime + (chunk.timestamp[1] - paddingTime)
      }));

      const result = {
        chunkIndex,
        startTime,
        endTime: words.length > 0 ? words[words.length - 1].end : startTime + chunkDuration,
        words
      };
      
      self.postMessage({ type: 'CHUNK_COMPLETE', payload: result });

    } catch (err) {
      console.error(`[Web Worker] Failed to process chunk ${chunkIndex}`, err);
      self.postMessage({ type: 'ERROR', payload: { chunkIndex, error: String(err) } });
    }
  }
};
