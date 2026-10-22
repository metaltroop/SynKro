/**
 * audioManager.ts
 *
 * Thin orchestration façade. All heavy lifting is in the engine implementations.
 * Components only need this class — they never import engines directly.
 */

import type { IMediaEngine } from '../types';
import { createMediaEngine } from './mediaEngine';

export class AudioManager {
  private static engine: IMediaEngine | null = null;
  private static engineReady: Promise<void> | null = null;

  // Expose CHUNK_DURATION for components that need it (e.g. TextViewer chunk index).
  // WebMediaEngine uses 180s, Capacitor uses 60s — we read from the engine if loaded,
  // default to 180 otherwise.
  static get CHUNK_DURATION(): number {
    const e = this.engine as (IMediaEngine & { CHUNK_DURATION?: number }) | null;
    return e?.CHUNK_DURATION ?? 30;
  }

  /**
   * Must be called once on app boot (AudioPlayer useEffect).
   * Idempotent — safe to call multiple times.
   */
  static initialize(): Promise<void> {
    if (this.engineReady) return this.engineReady;
    this.engineReady = createMediaEngine().then((engine) => {
      this.engine = engine;
    });
    return this.engineReady;
  }

  static getChunkIndex(time: number): number {
    return this.engine
      ? (this.engine as IMediaEngine & { getChunkIndex?: (t: number) => number })
          .getChunkIndex?.(time) ?? Math.floor(time / this.CHUNK_DURATION)
      : Math.floor(time / this.CHUNK_DURATION);
  }

  static onTimeUpdate(currentTime: number): void {
    this.engine?.onTimeUpdate(currentTime);
  }

  static async loadBook(
    audioFile: File,
    textFile: File,
    initialManifest?: import('../types').SynkroManifest | null,
    dirHandle?: FileSystemDirectoryHandle | null,
  ): Promise<void> {
    await this.initialize();
    await this.engine!.loadBook(audioFile, textFile, initialManifest, dirHandle);
  }

  static startFullTranscription(): void {
    this.engine?.startFullTranscription?.();
  }

  static stopFullTranscription(): void {
    this.engine?.stopFullTranscription?.();
  }

  static dispose(): void {
    this.engine?.dispose();
    this.engine = null;
    this.engineReady = null;
  }
}
