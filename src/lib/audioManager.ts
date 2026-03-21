import { useAppStore } from '../store/useAppStore';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Configure pdfjs worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export class AudioManager {
  private static worker: Worker | null = null;
  private static processingChunks = new Set<number>();
  private static CHUNK_DURATION = 180; // 3-minute chunks
  private static audioFile: File | null = null;

  static initialize() {
    if (typeof Worker !== 'undefined') {
      this.worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const { type, payload } = e.data;
        if (type === 'CHUNK_COMPLETE') {
          console.log('[AudioManager] Received transcript for chunk', payload.chunkIndex);
          const state = useAppStore.getState();
          state.addTranscript(payload.chunkIndex, payload);
          this.processingChunks.delete(payload.chunkIndex);

          // Force-check if we can stop buffering now that this chunk has arrived
          const currentChunk = this.getChunkIndex(state.currentTime);
          if (payload.chunkIndex === currentChunk && state.isChunkBuffering) {
            state.setChunkBuffering(false);
          }
        } else if (type === 'PROGRESS') {
          // Update the UI with detailed progress from the worker
          useAppStore.getState().setLoadingMessage(payload.message);
        } else if (type === 'ERROR') {
          console.error('[AudioManager] Worker error:', payload);
          this.processingChunks.delete(payload.chunkIndex);
        }
      };
    }
  }

  static getChunkIndex(time: number): number {
    return Math.floor(time / this.CHUNK_DURATION);
  }

  static onTimeUpdate(currentTime: number) {
    const currentChunkIndex = this.getChunkIndex(currentTime);
    const nextChunkIndex = currentChunkIndex + 1;
    const state = useAppStore.getState();
    const transcript = state.transcripts[currentChunkIndex];

    if (!transcript) {
      if (!state.isChunkBuffering && state.currentBook && currentChunkIndex < state.currentBook.chunks) {
        useAppStore.getState().setChunkBuffering(true);
      }
    } else if (state.isChunkBuffering) {
      useAppStore.getState().setChunkBuffering(false);
    }

    this.ensureChunkProcessed(currentChunkIndex);
    this.ensureChunkProcessed(nextChunkIndex);
  }

  private static async decodeAudioSlice(blob: Blob): Promise<Float32Array> {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    if (decodedBuffer.sampleRate !== 16000) {
      const offlineCtx = new OfflineAudioContext(1, decodedBuffer.duration * 16000, 16000);
      const source = offlineCtx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      const resampled = await offlineCtx.startRendering();
      return resampled.getChannelData(0);
    }
    
    return decodedBuffer.getChannelData(0);
  }

  private static async ensureChunkProcessed(chunkIndex: number) {
    const state = useAppStore.getState();
    if (!state.currentBook || chunkIndex >= state.currentBook.chunks) return;

    if (state.transcripts[chunkIndex] || this.processingChunks.has(chunkIndex)) return;

    this.processingChunks.add(chunkIndex);
    const startTime = chunkIndex * this.CHUNK_DURATION;
    const duration = state.currentBook.duration;

    if (this.worker && this.audioFile) {
      // PROPORTIONAL SLICING: Handle massive books by slicing the compressed file BEFORE decoding
      // This is much more memory efficient than decoding the whole 30-hour MP3
      const fileSize = this.audioFile.size;
      const startByte = Math.floor((startTime / duration) * fileSize);
      const endByte = Math.floor(((startTime + this.CHUNK_DURATION) / duration) * fileSize);
      
      // Add a small buffer (500KB) to ensure we don't cut off a frame header abruptly
      const slicePadding = 500 * 1024;
      const actualStartByte = Math.max(0, startByte - slicePadding);
      const actualEndByte = Math.min(fileSize, endByte + slicePadding);
      
      const chunkBlob = this.audioFile.slice(actualStartByte, actualEndByte, this.audioFile.type);
      
      try {
        useAppStore.getState().setLoadingMessage(`Decoding segment ${chunkIndex}...`);
        const audioData = await this.decodeAudioSlice(chunkBlob);
        
        // Calculate how many seconds of "extra" audio we included at the start due to padding
        const paddingBytes = startByte - actualStartByte;
        const paddingTime = (paddingBytes / fileSize) * duration;

        this.worker.postMessage({
          type: 'PROCESS_CHUNK',
          payload: {
            chunkIndex,
            startTime,
            paddingTime, // Worker needs this to adjust timestamps
            audioData, // Send decoded Float32Array instead of Blob
            chunkDuration: this.CHUNK_DURATION
          }
        });
      } catch (err) {
        useAppStore.getState().setLoadingMessage(`Error decoding segment ${chunkIndex}`);
        console.error('[AudioManager] Failed to decode audio slice on main thread:', err);
        this.processingChunks.delete(chunkIndex);
      }
    } else {
      this.processingChunks.delete(chunkIndex);
    }
  }

  // Extract PDF text
  static async extractText(file: File): Promise<string> {
    const { setLoadingMessage } = useAppStore.getState();
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      setLoadingMessage('Parsing PDF Document...');
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        setLoadingMessage(`Extracting Text (Page ${i}/${pdf.numPages})...`);
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += pageText + '\n';
      }
      return fullText;
    }
    setLoadingMessage('Reading Text File...');
    return await file.text();
  }

  static async loadBook(audioFile: File, textFile: File) {
    const { setLoadingMessage, setBook } = useAppStore.getState();
    setLoadingMessage('Initializing Book Layout...');
    
    this.audioFile = audioFile;
    const audioUrl = URL.createObjectURL(audioFile);
    
    // Fast metadata extraction via Audio element (Main Thread)
    const duration = await new Promise<number>((resolve) => {
      const audioObj = new Audio(audioUrl);
      audioObj.addEventListener('loadedmetadata', () => {
        const d = audioObj.duration;
        audioObj.src = ''; // Release memory
        resolve(d);
      });
      audioObj.addEventListener('error', () => resolve(300));
    });

    const chunkCount = Math.ceil(duration / this.CHUNK_DURATION);
    const textContent = await this.extractText(textFile);

    setBook({
      id: `book_${Date.now()}`,
      title: audioFile.name,
      audioUrl,
      textUrl: URL.createObjectURL(textFile),
      text: textContent,
      duration,
      chunks: chunkCount,
    });
    
    setLoadingMessage('');
    
    // Kick off first chunk processing immediately
    this.ensureChunkProcessed(0);
  }
}
