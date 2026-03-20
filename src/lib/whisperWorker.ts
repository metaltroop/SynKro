import { pipeline, env, read_audio } from '@huggingface/transformers';

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

let fullAudioData: Float32Array | null = null;

// Start model loading immediately on worker boot to save time
const modelPromise = PipelineSingleton.getInstance((x: any) => {
  // Send model download/loading progress back to UI
  self.postMessage({ type: 'PROGRESS', payload: { 
    message: x.status === 'progress' ? `Downloading AI Model: ${Math.round(x.progress)}%` : `Initializing AI engine: ${x.status}...`,
    detail: x
  }});
});

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'PROCESS_CHUNK') {
    const { chunkIndex, startTime, audioFile, chunkDuration } = payload;
    
    console.log(`[Whisper Worker] Received chunk request: ${chunkIndex}`);
    
    try {
      // 1. Ensure model is loading (it started on line 24)
      const transcriber = await modelPromise;

      // 2. Decode full audio if not already cached
      if (!fullAudioData) {
        self.postMessage({ type: 'PROGRESS', payload: { message: 'Decoding audio file (once)...' } });
        console.log(`[Whisper Worker] Decoding full audio file...`);
        // Transformers.js read_audio handles file -> Float32Array @ 16kHz
        fullAudioData = await read_audio(audioFile, 16000);
        console.log(`[Whisper Worker] Decoding complete. Buffer size: ${fullAudioData.length} samples`);
      }

      // 3. Extract specific segment
      const sampleRate = 16000;
      const startSample = Math.floor(startTime * sampleRate);
      const endSample = Math.min(
        fullAudioData.length,
        Math.floor((startTime + chunkDuration) * sampleRate)
      );

      if (startSample >= fullAudioData.length) {
        console.warn(`[Whisper Worker] Chunk ${chunkIndex} start sample exceeds audio length`);
        return;
      }

      const chunkBuffer = fullAudioData.slice(startSample, endSample);
      
      console.log(`[Whisper Worker] Running inference for chunk ${chunkIndex}`);
      self.postMessage({ type: 'PROGRESS', payload: { message: `Transcribing segment ${chunkIndex}...` } });
      
      const output = await transcriber(chunkBuffer, {
          chunk_length_s: 30,
          stride_length_s: 5,
          return_timestamps: 'word'
      });
      
      console.log(`[Whisper Worker] Inference complete for chunk ${chunkIndex}`, output);
      
      // Map the output to match our `ChunkTranscript` interface
      const words = output.chunks.map((chunk: any) => ({
        word: chunk.text.trim(),
        start: startTime + chunk.timestamp[0],
        end: startTime + chunk.timestamp[1]
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
