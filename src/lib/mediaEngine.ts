/**
 * mediaEngine.ts
 *
 * Platform Adapter Pattern.
 *
 * IMediaEngine is the single contract consumed by AudioManager.
 * Two implementations exist:
 *
 *  • WebMediaEngine    — browser: Web Audio API + whisperWorker.ts
 *  • CapacitorNativeEngine — Android/iOS: native FFmpeg + whisper.cpp via Capacitor
 *
 * `createMediaEngine()` selects the right implementation at runtime.
 */

import type { IMediaEngine } from '../types';

// ─── Runtime detection ────────────────────────────────────────────────────────

function isNativePlatform(): boolean {
  try {
    // Capacitor injects this global when running inside a native WebView
    return !!(window as unknown as Record<string, unknown>)['Capacitor']
      && !!((window as unknown as Record<string, Record<string, unknown>>)['Capacitor'] as Record<string, unknown>)['isNativePlatform'];
  } catch {
    return false;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Returns the appropriate IMediaEngine for the current runtime.
 * Import this function instead of instantiating engines directly.
 */
export async function createMediaEngine(): Promise<IMediaEngine> {
  if (isNativePlatform()) {
    const { CapacitorNativeEngine } = await import('./engines/CapacitorNativeEngine');
    return new CapacitorNativeEngine();
  }
  const { WebMediaEngine } = await import('./engines/WebMediaEngine');
  return new WebMediaEngine();
}
