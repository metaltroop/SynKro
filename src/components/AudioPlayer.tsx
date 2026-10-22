/**
 * AudioPlayer.tsx
 *
 * Fixed-bottom audio player with:
 *  • playbackRate wired to store + toggle button (0.75 / 1 / 1.25 / 1.5 / 2×)
 *  • StorageMode selector (SMART / KEEP_ALL / LITE_MODE)
 *  • "Back to Library" button
 *  • Touch-friendly progress scrubber (onTouchMove + onMouseMove)
 *  • Safe-area bottom padding
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { AudioManager } from '../lib/audioManager';
import { Storage } from '../lib/storage';
import { Play, Pause, Rewind, FastForward, Library, Gauge, Sliders } from 'lucide-react';
import type { StorageMode } from '../types';

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
type PlaybackRate = (typeof PLAYBACK_RATES)[number];

const STORAGE_LABELS: Record<StorageMode, string> = {
  SMART: 'Smart',
  KEEP_ALL: 'Keep All',
  LITE_MODE: 'Lite',
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const AudioPlayer: React.FC = () => {
  const {
    currentBook,
    isPlaying,
    isChunkBuffering,
    currentTime,
    playbackRate,
    storageMode,
    transcripts,
    alignedChunks,
    syncOffsetMs,
    setIsPlaying,
    setCurrentTime,
    setPlaybackRate,
    setStorageMode,
    setSyncOffsetMs,
    resetBook,
  } = useAppStore();

  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const isSeekingRef = useRef(false);
  const [showStorageMenu, setShowStorageMenu] = useState(false);
  const [showSyncPopover, setShowSyncPopover] = useState(false);

  // ── Engine initialisation ──────────────────────────────────────────────────
  useEffect(() => {
    void AudioManager.initialize();
  }, []);

  // ── Playback state ────────────────────────────────────────────────────────
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !currentBook) return;
    if (isPlaying && !isChunkBuffering) {
      el.play().catch(() => {/* autoplay blocked */});
    } else {
      el.pause();
    }
  }, [isPlaying, isChunkBuffering, currentBook]);

  // ── Playback rate ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  // ── Seek sync (external: word click) ─────────────────────────────────────
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (Math.abs(el.currentTime - currentTime) > 0.5) {
      isSeekingRef.current = true;
      el.currentTime = currentTime;
    }
  }, [currentTime]);

  // ── High-precision 60fps time tracking ───────────────────────────────────
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !isPlaying || isChunkBuffering) return;

    let animId: number;
    let lastTime = -1;

    const tick = () => {
      if (el && !isSeekingRef.current && !el.paused) {
        const t = el.currentTime;
        if (Math.abs(t - lastTime) >= 0.025) {
          lastTime = t;
          setCurrentTime(t);
          AudioManager.onTimeUpdate(t);
        }
      }
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, isChunkBuffering, setCurrentTime]);

  // Fallback / standard time update
  const handleTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (!el || isSeekingRef.current) return;
    const t = el.currentTime;
    setCurrentTime(t);
    AudioManager.onTimeUpdate(t);
  }, [setCurrentTime]);

  const handleSeeked = useCallback(() => {
    isSeekingRef.current = false;
  }, []);

  // ── Scrubber interaction (mouse + touch) ──────────────────────────────────
  const seekTo = useCallback(
    (clientX: number) => {
      const el = scrubberRef.current;
      if (!el || !currentBook) return;
      const rect = el.getBoundingClientRect();
      const pos = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      setCurrentTime(pos * currentBook.duration);
    },
    [currentBook, setCurrentTime],
  );

  const handleScrubberClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => seekTo(e.clientX),
    [seekTo],
  );

  const handleScrubberTouch = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      e.preventDefault();
      seekTo(e.touches[0].clientX);
    },
    [seekTo],
  );

  // ── Rate cycle ────────────────────────────────────────────────────────────
  const cycleRate = useCallback(() => {
    const idx = PLAYBACK_RATES.indexOf(playbackRate as PlaybackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  }, [playbackRate, setPlaybackRate]);

  // ── Back to library ───────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
    }
    setIsPlaying(false);
    Storage.clearLastActiveBookId();
    AudioManager.dispose();
    resetBook();
  }, [setIsPlaying, resetBook]);

  if (!currentBook) return null;

  const progress = currentBook.duration > 0
    ? (currentTime / currentBook.duration) * 100
    : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-zinc-950/90 backdrop-blur-xl border-t border-zinc-800/80 pb-safe shadow-2xl">
      <div className="max-w-4xl mx-auto px-4 pt-3 pb-4 flex flex-col gap-2">
        {/* Hidden audio element */}
        <audio
          ref={audioRef}
          src={currentBook.audioUrl}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleSeeked}
          onEnded={() => setIsPlaying(false)}
          className="hidden"
        />

        {/* Top row: back / title / storage */}
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <button
            type="button"
            onClick={handleBack}
            title="Back to library"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 hover:text-white transition-all cursor-pointer border border-zinc-700/60 font-medium"
          >
            <Library size={14} />
            <span>Library</span>
          </button>

          <span className="flex-1 text-center text-zinc-300 font-medium truncate px-2 text-xs">
            {currentBook.title}
          </span>

          <div className="relative">
            <button
              onClick={() => setShowStorageMenu((v) => !v)}
              title="Storage mode"
              className="flex items-center gap-1 hover:text-white transition-colors"
            >
              <span>{STORAGE_LABELS[storageMode]}</span>
            </button>

            {showStorageMenu && (
              <div className="absolute bottom-full right-0 mb-2 bg-zinc-800 border border-zinc-700 rounded-xl overflow-hidden shadow-2xl z-50">
                {(Object.keys(STORAGE_LABELS) as StorageMode[]).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => { setStorageMode(mode); setShowStorageMenu(false); }}
                    className={`block w-full text-left px-4 py-2.5 text-sm transition-colors ${
                      storageMode === mode
                        ? 'bg-purple-600 text-white'
                        : 'hover:bg-zinc-700 text-zinc-300'
                    }`}
                  >
                    {STORAGE_LABELS[mode]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Segmented Timeline Pre-Transcription Bar ("Shader Compilation") */}
        {currentBook.chunks > 0 && (
          <div
            className="flex h-1.5 w-full bg-zinc-800/80 rounded-full overflow-hidden gap-[1px]"
            title="Full Book Compilation Timeline: Purple = Pre-transcribed, Dark = Pending"
          >
            {Array.from({ length: currentBook.chunks }).map((_, i) => {
              const isCompiled = !!(transcripts[i] || alignedChunks[i]);
              return (
                <div
                  key={i}
                  className={`flex-1 h-full transition-colors ${
                    isCompiled ? 'bg-purple-500' : 'bg-zinc-800'
                  }`}
                />
              );
            })}
          </div>
        )}

        {/* Progress scrubber */}
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="w-10 text-right tabular-nums">{formatTime(currentTime)}</span>

          <div
            ref={scrubberRef}
            className="flex-1 h-2 bg-zinc-700 rounded-full relative cursor-pointer group touch-none"
            onClick={handleScrubberClick}
            onTouchMove={handleScrubberTouch}
            onTouchStart={handleScrubberTouch}
          >
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-purple-600 to-pink-500 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-4 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ left: `${progress}%` }}
            />
          </div>

          <span className="w-10 tabular-nums">{formatTime(currentBook.duration)}</span>
        </div>

        {/* Controls */}
        <div className="flex justify-center items-center gap-6">
          <button
            onClick={() => setCurrentTime(Math.max(0, currentTime - 15))}
            className="text-zinc-400 hover:text-white transition-colors active:scale-90"
            aria-label="Rewind 15s"
          >
            <Rewind size={20} />
          </button>

          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="w-14 h-14 flex items-center justify-center bg-purple-600 hover:bg-purple-500 rounded-full text-white shadow-lg shadow-purple-900/50 transition-all active:scale-95"
            aria-label={isPlaying ? 'Pause' : 'Play'}
          >
            {isChunkBuffering ? (
              <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : isPlaying ? (
              <Pause size={26} fill="currentColor" />
            ) : (
              <Play size={26} fill="currentColor" className="ml-1" />
            )}
          </button>

          <button
            onClick={() =>
              setCurrentTime(Math.min(currentBook.duration, currentTime + 15))
            }
            className="text-zinc-400 hover:text-white transition-colors active:scale-90"
            aria-label="Skip 15s"
          >
            <FastForward size={20} />
          </button>

          {/* Playback rate toggle */}
          <button
            onClick={cycleRate}
            title="Playback speed"
            className="flex items-center gap-1 text-zinc-400 hover:text-white transition-colors text-sm font-mono"
          >
            <Gauge size={16} />
            {playbackRate}×
          </button>

          {/* Live Audio-Text Sync Offset Slider Popover */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowSyncPopover((v) => !v)}
              title="Adjust audio-text timing sync"
              className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border transition-all cursor-pointer font-mono ${
                syncOffsetMs !== 0
                  ? 'bg-purple-950/60 border-purple-500/50 text-purple-300'
                  : 'bg-zinc-800/80 border-zinc-700/60 text-zinc-400 hover:text-white'
              }`}
            >
              <Sliders size={14} />
              <span>{syncOffsetMs > 0 ? `+${syncOffsetMs}` : `${syncOffsetMs}`}ms</span>
            </button>

            {showSyncPopover && (
              <div className="absolute bottom-full right-0 mb-3 w-64 p-3.5 bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl z-50 flex flex-col gap-2.5">
                <div className="flex items-center justify-between text-xs text-zinc-300 font-semibold">
                  <span>Audio Sync Offset</span>
                  <span className="font-mono text-purple-400">
                    {syncOffsetMs > 0 ? `+${syncOffsetMs}` : `${syncOffsetMs}`}ms
                  </span>
                </div>

                <input
                  type="range"
                  min={-2000}
                  max={2000}
                  step={50}
                  value={syncOffsetMs}
                  onChange={(e) => setSyncOffsetMs(parseInt(e.target.value, 10))}
                  className="w-full accent-purple-500 h-1.5 bg-zinc-700 rounded-lg cursor-pointer"
                />

                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>Text leads (-2s)</span>
                  <span>Audio leads (+2s)</span>
                </div>

                <div className="grid grid-cols-3 gap-1 pt-1 border-t border-zinc-800 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setSyncOffsetMs(syncOffsetMs - 100)}
                    className="py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                  >
                    -100ms
                  </button>
                  <button
                    type="button"
                    onClick={() => setSyncOffsetMs(0)}
                    className="py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-medium cursor-pointer"
                  >
                    Reset (0)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSyncOffsetMs(syncOffsetMs + 100)}
                    className="py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 cursor-pointer"
                  >
                    +100ms
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
