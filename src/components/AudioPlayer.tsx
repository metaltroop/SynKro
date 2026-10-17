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
import { Play, Pause, Rewind, FastForward, Library, Gauge } from 'lucide-react';
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
    setIsPlaying,
    setCurrentTime,
    setPlaybackRate,
    setStorageMode,
    resetBook,
  } = useAppStore();

  const audioRef = useRef<HTMLAudioElement>(null);
  const scrubberRef = useRef<HTMLDivElement>(null);
  const isSeekingRef = useRef(false);
  const [showStorageMenu, setShowStorageMenu] = useState(false);

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

  // ── Time update ───────────────────────────────────────────────────────────
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
    AudioManager.dispose();
    resetBook();
  }, [setIsPlaying, resetBook]);

  if (!currentBook) return null;

  const progress = currentBook.duration > 0
    ? (currentTime / currentBook.duration) * 100
    : 0;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-zinc-900/95 backdrop-blur-md border-t border-zinc-800 pb-safe shadow-2xl">
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
        </div>
      </div>
    </div>
  );
};
