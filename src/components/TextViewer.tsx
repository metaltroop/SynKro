/**
 * TextViewer.tsx
 *
 * Renders real book text (AlignedChunk.words) with accurate word-by-word highlighting.
 *
 * v2 Features:
 *  • Redesigned Frosted-Glass Top Navbar with Book Title, Live Sync, and Compilation Hub
 *  • Dual Reading Modes: Continuous Scroll View vs Paginated Book View (Kindle/Apple Books style)
 *  • Jump To Feature: Jump to Page #, Segment #, or % of book instantly
 *  • Desktop/Laptop constraint on 100% full-book compilation
 *  • Word hover indicator and smooth auto-scroll / page-turn synchronization
 */

import React, { useMemo, useRef, useEffect, useCallback, useState, memo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { AudioManager } from '../lib/audioManager';
import { Storage } from '../lib/storage';
import {
  Library,
  Cpu,
  Download,
  FolderCheck,
  BookOpen,
  Scroll,
  ChevronLeft,
  ChevronRight,
  Compass,
  X,
} from 'lucide-react';
import type { BookWord, SynkroManifest } from '../types';
import { downloadManifestFile, isDesktopOrLaptop } from '../lib/folderManager';

// ─── Word span ────────────────────────────────────────────────────────────────

interface WordSpanProps {
  word: BookWord;
  isActive: boolean;
  isPassed: boolean;
  onClick: (start: number) => void;
  spanRef?: React.RefObject<HTMLSpanElement | null>;
}

const WordSpan = memo(function WordSpan({
  word,
  isActive,
  isPassed,
  onClick,
  spanRef,
}: WordSpanProps) {
  return (
    <span
      ref={spanRef}
      className={`word-interactive inline transition-all duration-150 rounded px-1 py-0.5 select-none ${
        isActive
          ? 'bg-purple-500/45 text-purple-100 font-medium scale-[1.04] shadow-[0_0_12px_rgba(168,85,247,0.6)]'
          : isPassed
          ? 'text-zinc-500'
          : 'text-zinc-200'
      }`}
      onClick={() => onClick(word.start ?? 0)}
    >
      {word.text}
    </span>
  );
});

// ─── Paragraph row ────────────────────────────────────────────────────────────

interface ParagraphRowProps {
  words: BookWord[];
  activeWordIndex: number;
  passedWordIndex: number;
  onWordClick: (start: number) => void;
  activeRef: React.RefObject<HTMLSpanElement | null>;
}

const ParagraphRow = memo(function ParagraphRow({
  words,
  activeWordIndex,
  passedWordIndex,
  onWordClick,
  activeRef,
}: ParagraphRowProps) {
  return (
    <p className="mb-5 leading-relaxed flex flex-wrap gap-x-[0.3em] gap-y-1">
      {words.map((w) => {
        const isActive = w.index === activeWordIndex;
        const isPassed = w.index <= passedWordIndex && !isActive;
        return (
          <WordSpan
            key={w.index}
            word={w}
            isActive={isActive}
            isPassed={isPassed}
            onClick={onWordClick}
            spanRef={isActive ? activeRef : undefined}
          />
        );
      })}
    </p>
  );
});

// ─── Loading overlay ──────────────────────────────────────────────────────────

function LoadingOverlay({ message }: { message: string }) {
  return (
    <div className="relative flex flex-col items-center justify-center min-h-[400px] overflow-hidden rounded-2xl">
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/70 backdrop-blur-md rounded-2xl border border-white/5 shadow-2xl">
        <div className="h-12 w-12 border-4 border-zinc-800 border-t-purple-500 rounded-full animate-spin mb-6 shadow-[0_0_20px_rgba(168,85,247,0.4)]" />
        <p className="text-white font-medium text-lg text-center tracking-wide">
          {message || 'Decoding segment…'}
        </p>
        <div className="mt-4 flex gap-1">
          {[0, 150, 300].map((d) => (
            <span
              key={d}
              className="w-1.5 h-1.5 bg-purple-500 rounded-full animate-bounce"
              style={{ animationDelay: `${d}ms` }}
            />
          ))}
        </div>
      </div>
      {/* Skeleton background */}
      <div className="absolute inset-0 p-8 flex flex-wrap gap-x-3 gap-y-4 opacity-20 select-none pointer-events-none content-start">
        {Array.from({ length: 120 }).map((_, i) => (
          <div
            key={i}
            className="h-5 bg-zinc-700/50 rounded animate-pulse"
            style={{ width: `${45 + (i * 37) % 60}px`, animationDelay: `${(i * 0.07) % 2}s` }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── TextViewer ───────────────────────────────────────────────────────────────

export const TextViewer: React.FC = () => {
  const {
    currentBook,
    alignedChunks,
    transcripts,
    currentTime,
    loadingMessage,
    isFullTranscribing,
    fullTranscribeETA,
    syncOffsetMs,
    playbackRate,
    readingViewMode,
    currentPageIndex,
    setReadingViewMode,
    setCurrentPageIndex,
  } = useAppStore();

  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledWordIndex = useRef<number>(-1);

  // Jump to popover state
  const [showJumpModal, setShowJumpModal] = useState(false);
  const [jumpPageInput, setJumpPageInput] = useState('');
  const [jumpSegmentInput, setJumpSegmentInput] = useState('');

  const currentChunkIndex = Math.floor(currentTime / AudioManager.CHUNK_DURATION);
  const activeAligned = alignedChunks[currentChunkIndex];
  const isDirectMode = Boolean(activeAligned?.isDirectTranscript);

  // ── Continuous Scrollable Word Collection ─────────────────────────────────
  const displayWords: BookWord[] = useMemo(() => {
    if (isDirectMode || (!activeAligned && transcripts[currentChunkIndex])) {
      const allWords: BookWord[] = [];
      const maxProcessedChunk = Math.max(
        currentChunkIndex,
        ...Object.keys(alignedChunks).map(Number),
        ...Object.keys(transcripts).map(Number),
      );

      for (let c = 0; c <= maxProcessedChunk; c++) {
        const chunk = alignedChunks[c];
        const raw = transcripts[c];
        const chunkWords: BookWord[] =
          chunk && chunk.words.length > 0
            ? chunk.words
            : raw && raw.words.length > 0
            ? raw.words.map((w, i) => ({
                text: w.word,
                normalized: w.word.toLowerCase(),
                index: c * 10000 + i,
                paragraphIndex: c,
                wordIndexInParagraph: i,
                start: w.start,
                end: w.end,
              }))
            : [];

        for (let i = 0; i < chunkWords.length; i++) {
          const w = chunkWords[i];
          const last = allWords[allWords.length - 1];

          if (
            last &&
            w.start !== undefined &&
            last.end !== undefined &&
            w.start <= last.end + 0.15 &&
            w.normalized === last.normalized
          ) {
            continue;
          }

          allWords.push({
            ...w,
            index: c * 10000 + i,
            paragraphIndex: c,
            wordIndexInParagraph: i,
          });
        }
      }
      if (allWords.length > 0) return allWords;
    }

    if (activeAligned && activeAligned.words.length > 0) {
      return activeAligned.words;
    }

    if (transcripts[currentChunkIndex]?.words?.length) {
      return transcripts[currentChunkIndex].words.map((w, i) => ({
        text: w.word,
        normalized: w.word.toLowerCase(),
        index: currentChunkIndex * 10000 + i,
        paragraphIndex: currentChunkIndex,
        wordIndexInParagraph: i,
        start: w.start,
        end: w.end,
      }));
    }

    if (currentChunkIndex > 0 && alignedChunks[currentChunkIndex - 1]?.words.length) {
      return alignedChunks[currentChunkIndex - 1].words;
    }

    return [];
  }, [isDirectMode, activeAligned, alignedChunks, transcripts, currentChunkIndex]);

  // ── Group words by paragraph and deduplicate overlapping paragraphs ────────
  const paragraphGroups = useMemo<Map<number, BookWord[]>>(() => {
    const rawMap = new Map<number, BookWord[]>();
    for (const w of displayWords) {
      const list = rawMap.get(w.paragraphIndex) ?? [];
      list.push(w);
      rawMap.set(w.paragraphIndex, list);
    }

    const cleanMap = new Map<number, BookWord[]>();
    let prevTokens: string[] = [];

    for (const [paraIdx, words] of rawMap.entries()) {
      if (!words || words.length === 0) continue;
      const currentTokens = words.map((w) => w.normalized || w.text.toLowerCase());

      if (prevTokens.length > 0) {
        const tokenSet = new Set(prevTokens);
        let matchCount = 0;
        for (const tok of currentTokens) {
          if (tokenSet.has(tok)) matchCount++;
        }
        const overlap = matchCount / Math.max(1, Math.min(prevTokens.length, currentTokens.length));
        if (overlap > 0.65 && currentTokens.length >= 8) {
          continue;
        }
      }

      cleanMap.set(paraIdx, words);
      prevTokens = currentTokens;
    }

    return cleanMap;
  }, [displayWords]);

  // ── Renderable words (flat array) ─────────────────────────────────────────
  const renderableWords = useMemo<BookWord[]>(() => {
    const result: BookWord[] = [];
    for (const words of paragraphGroups.values()) {
      result.push(...words);
    }
    return result;
  }, [paragraphGroups]);

  // ── Paginated Book View Partitioning ──────────────────────────────────────
  const bookPages = useMemo<BookWord[][]>(() => {
    if (renderableWords.length === 0) return [];

    // Words per page (~260 words for comfortable reading)
    const WORDS_PER_PAGE = 260;
    const pages: BookWord[][] = [];
    let currentSlice: BookWord[] = [];

    for (const word of renderableWords) {
      currentSlice.push(word);
      if (currentSlice.length >= WORDS_PER_PAGE) {
        pages.push(currentSlice);
        currentSlice = [];
      }
    }
    if (currentSlice.length > 0) {
      pages.push(currentSlice);
    }

    return pages;
  }, [renderableWords]);

  const totalBookPages = Math.max(1, currentBook?.totalPages ?? bookPages.length);

  // ── Active word index calculation ─────────────────────────────────────────
  const { activeWordIndex, passedWordIndex } = useMemo(() => {
    if (renderableWords.length === 0) return { activeWordIndex: -1, passedWordIndex: -1 };

    const currentChunk = Math.floor(currentTime / AudioManager.CHUNK_DURATION);
    const effectiveTime = currentTime + 0.16 + (syncOffsetMs / 1000);

    let active = -1;
    let passed = -1;
    let bestScore = Infinity;

    for (const w of renderableWords) {
      if (w.start !== undefined && w.end !== undefined) {
        if (effectiveTime >= w.start && effectiveTime <= w.end) {
          const chunkDiff = Math.abs(w.paragraphIndex - currentChunk);
          const center = (w.start + w.end) / 2;
          const score = chunkDiff * 1000 + Math.abs(effectiveTime - center);
          if (score < bestScore) {
            bestScore = score;
            active = w.index;
          }
        }
        if (effectiveTime > w.end) {
          passed = w.index;
        }
      }
    }

    if (active === -1 && passed !== -1) {
      const lastPassedWord = renderableWords.find((w) => w.index === passed);
      if (
        lastPassedWord &&
        lastPassedWord.end !== undefined &&
        effectiveTime - lastPassedWord.end <= 0.4
      ) {
        active = passed;
      }
    }

    return { activeWordIndex: active, passedWordIndex: passed };
  }, [renderableWords, currentTime, syncOffsetMs]);

  // ── Auto-flip page in Book View when active word advances ─────────────────
  useEffect(() => {
    if (readingViewMode !== 'book' || activeWordIndex < 0 || bookPages.length === 0) return;

    const pageIdx = bookPages.findIndex((page) =>
      page.some((w) => w.index === activeWordIndex),
    );
    if (pageIdx !== -1 && pageIdx !== currentPageIndex) {
      setCurrentPageIndex(pageIdx);
    }
  }, [activeWordIndex, readingViewMode, bookPages, currentPageIndex, setCurrentPageIndex]);

  // ── Keyboard page turn listener in Book View ──────────────────────────────
  useEffect(() => {
    if (readingViewMode !== 'book') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        setCurrentPageIndex(Math.min(bookPages.length - 1, currentPageIndex + 1));
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        setCurrentPageIndex(Math.max(0, currentPageIndex - 1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [readingViewMode, bookPages.length, currentPageIndex, setCurrentPageIndex]);

  // ── Gentle auto-scroll in Scroll View ─────────────────────────────────────
  useEffect(() => {
    if (
      readingViewMode === 'scroll' &&
      activeWordIndex >= 0 &&
      activeWordIndex !== lastScrolledWordIndex.current &&
      activeWordRef.current
    ) {
      lastScrolledWordIndex.current = activeWordIndex;
      activeWordRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [activeWordIndex, readingViewMode]);

  // ── Word click handler ────────────────────────────────────────────────────
  const handleWordClick = useCallback((start: number) => {
    useAppStore.getState().setCurrentTime(start);
  }, []);

  // ── Compilation & Export Handlers ─────────────────────────────────────────
  const compiledCount = Object.keys(transcripts).length;
  const totalChunks = currentBook?.chunks ?? 1;
  const compiledPercent = Math.min(100, Math.round((compiledCount / totalChunks) * 100));
  const isDesktop = isDesktopOrLaptop();

  const handleToggleCompile = useCallback(() => {
    if (!isDesktop) return;
    if (isFullTranscribing) {
      AudioManager.stopFullTranscription();
    } else {
      AudioManager.startFullTranscription();
    }
  }, [isFullTranscribing, isDesktop]);

  const handleExportManifest = useCallback(() => {
    if (!currentBook) return;
    const manifest: SynkroManifest = {
      version: 2,
      bookId: currentBook.id,
      title: currentBook.title,
      audioFileName: currentBook.audioFileName ?? `${currentBook.title}.mp3`,
      textFileName: currentBook.textFileName ?? `${currentBook.title}.pdf`,
      duration: currentBook.duration,
      chunkDuration: AudioManager.CHUNK_DURATION,
      totalChunks: currentBook.chunks,
      syncOffsetMs,
      playbackRate,
      lastPlayedTime: currentTime,
      updatedAt: new Date().toISOString(),
      coverUrl: currentBook.coverUrl,
      isCompileFullEnabled: isFullTranscribing,
      transcripts,
    };
    downloadManifestFile(manifest);
  }, [currentBook, syncOffsetMs, playbackRate, currentTime, isFullTranscribing, transcripts]);

  // ── Jump to actions ───────────────────────────────────────────────────────
  const handleJumpToPage = useCallback(
    (pageNum: number) => {
      if (!currentBook) return;
      const p = Math.max(1, Math.min(totalBookPages, pageNum));
      const targetRatio = (p - 1) / Math.max(1, totalBookPages);
      const targetTime = targetRatio * currentBook.duration;

      useAppStore.getState().setCurrentTime(targetTime);
      setCurrentPageIndex(Math.min(bookPages.length - 1, p - 1));
      setShowJumpModal(false);
    },
    [currentBook, totalBookPages, bookPages.length, setCurrentPageIndex],
  );

  const handleJumpToSegment = useCallback(
    (segNum: number) => {
      if (!currentBook) return;
      const s = Math.max(1, Math.min(currentBook.chunks, segNum));
      const targetTime = (s - 1) * AudioManager.CHUNK_DURATION;

      useAppStore.getState().setCurrentTime(targetTime);
      setShowJumpModal(false);
    },
    [currentBook],
  );

  const handleJumpToPercent = useCallback(
    (pct: number) => {
      if (!currentBook) return;
      const targetTime = currentBook.duration * (pct / 100);
      useAppStore.getState().setCurrentTime(targetTime);
      setShowJumpModal(false);
    },
    [currentBook],
  );

  if (!currentBook) return null;

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-y-auto w-full p-4 pb-48 max-w-5xl mx-auto flex flex-col scroll-smooth"
    >
      {/* ── Modern Frosted-Glass Navbar ────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 py-3 px-4 mb-6 border border-zinc-800/80 rounded-2xl sticky top-2 bg-zinc-950/85 backdrop-blur-xl z-30 shadow-xl shadow-black/40">
        {/* Left: Library Back & Live Sync Indicator */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              Storage.clearLastActiveBookId();
              AudioManager.dispose();
              useAppStore.getState().resetBook();
            }}
            title="Back to library"
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 shadow-sm transition-all cursor-pointer text-xs font-semibold"
          >
            <Library size={15} />
            <span>Library</span>
          </button>

          {currentBook.dirHandle && (
            <span
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-950/40 border border-emerald-500/30 text-emerald-300"
              title="Folder connected — auto-saving manifest directly to disk"
            >
              <FolderCheck size={13} className="text-emerald-400" />
              <span>Live Disk Sync</span>
            </span>
          )}
        </div>

        {/* Center: View Mode Toggle & Jump To Popover Trigger */}
        <div className="flex items-center gap-2">
          {/* View Mode Toggle: Scroll vs Paginated Book */}
          <div className="flex items-center p-0.5 rounded-xl bg-zinc-900/90 border border-zinc-800">
            <button
              type="button"
              onClick={() => setReadingViewMode('scroll')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                readingViewMode === 'scroll'
                  ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Continuous Scroll View"
            >
              <Scroll size={13} />
              <span className="hidden md:inline">Scroll</span>
            </button>
            <button
              type="button"
              onClick={() => setReadingViewMode('book')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                readingViewMode === 'book'
                  ? 'bg-purple-600/30 text-purple-200 border border-purple-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="Paginated Book View"
            >
              <BookOpen size={13} />
              <span className="hidden md:inline">Book View</span>
            </button>
          </div>

          {/* Jump To Trigger */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowJumpModal((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-300 hover:text-white transition-all text-xs font-medium cursor-pointer"
              title="Jump to Page or Segment"
            >
              <Compass size={14} className="text-purple-400" />
              <span>Jump To</span>
            </button>

            {/* Jump To Modal / Popover */}
            {showJumpModal && (
              <div className="absolute top-full left-0 mt-2 w-72 p-4 bg-zinc-900/95 backdrop-blur-xl border border-zinc-700 rounded-2xl shadow-2xl z-50 text-xs flex flex-col gap-3.5">
                <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                  <span className="font-semibold text-zinc-200">Jump to Location</span>
                  <button
                    type="button"
                    onClick={() => setShowJumpModal(false)}
                    className="text-zinc-500 hover:text-zinc-300 p-1"
                  >
                    <X size={14} />
                  </button>
                </div>

                {/* Page Jump */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (jumpPageInput) handleJumpToPage(parseInt(jumpPageInput, 10));
                  }}
                  className="flex items-center gap-2"
                >
                  <span className="text-zinc-400 w-16">Page:</span>
                  <input
                    type="number"
                    min={1}
                    max={totalBookPages}
                    placeholder={`1-${totalBookPages}`}
                    value={jumpPageInput}
                    onChange={(e) => setJumpPageInput(e.target.value)}
                    className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1 text-zinc-200 text-xs focus:border-purple-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium cursor-pointer"
                  >
                    Go
                  </button>
                </form>

                {/* Segment Jump */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (jumpSegmentInput) handleJumpToSegment(parseInt(jumpSegmentInput, 10));
                  }}
                  className="flex items-center gap-2"
                >
                  <span className="text-zinc-400 w-16">Segment:</span>
                  <input
                    type="number"
                    min={1}
                    max={currentBook.chunks}
                    placeholder={`1-${currentBook.chunks}`}
                    value={jumpSegmentInput}
                    onChange={(e) => setJumpSegmentInput(e.target.value)}
                    className="flex-1 bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1 text-zinc-200 text-xs focus:border-purple-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="px-2.5 py-1 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium cursor-pointer"
                  >
                    Go
                  </button>
                </form>

                {/* Percentage Quick Shortcuts */}
                <div className="pt-2 border-t border-zinc-800">
                  <span className="text-zinc-400 block mb-1.5">Timeline Position:</span>
                  <div className="grid grid-cols-4 gap-1">
                    {[0, 25, 50, 75].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => handleJumpToPercent(pct)}
                        className="py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-center font-mono cursor-pointer"
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right: "Shader-Style" Pre-Transcription Progress Pill */}
        <div className="flex items-center gap-2">
          <div
            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-medium transition-all ${
              isFullTranscribing
                ? 'bg-purple-950/70 border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.3)] text-purple-200'
                : compiledPercent === 100
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-zinc-900/80 border-zinc-800 text-zinc-300'
            }`}
          >
            <Cpu
              size={14}
              className={
                isFullTranscribing
                  ? 'animate-spin text-purple-400'
                  : compiledPercent === 100
                  ? 'text-emerald-400'
                  : 'text-zinc-400'
              }
            />
            <span>
              <strong>{compiledPercent}%</strong> ({compiledCount}/{totalChunks})
              {isFullTranscribing && fullTranscribeETA && (
                <span className="text-purple-300/80 font-normal ml-1">· {fullTranscribeETA}</span>
              )}
            </span>

            {compiledPercent < 100 && (
              <button
                type="button"
                onClick={handleToggleCompile}
                disabled={!isDesktop}
                className={`ml-1 px-2 py-0.5 rounded text-[11px] font-semibold transition-all cursor-pointer ${
                  !isDesktop
                    ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-60'
                    : isFullTranscribing
                    ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40'
                    : 'bg-purple-600 hover:bg-purple-500 text-white shadow-sm'
                }`}
                title={
                  !isDesktop
                    ? 'Full Compilation is reserved for Desktop/Laptop GPUs to save battery'
                    : 'Pre-transcribe entire book into memory & folder manifest'
                }
              >
                {isFullTranscribing ? 'Pause' : 'Compile 100%'}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={handleExportManifest}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 hover:text-white transition-all text-xs font-medium cursor-pointer"
            title="Download synkro-manifest.json for portable transfer to Android or PC"
          >
            <Download size={14} />
            <span className="hidden md:inline">Export</span>
          </button>
        </div>
      </header>

      {/* Book Title */}
      <h1 className="text-3xl md:text-4xl font-extrabold mb-4 text-center bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-pink-400 to-purple-300 tracking-tight">
        {currentBook.title}
      </h1>

      {/* Book mismatch / live transcript mode banner */}
      {isDirectMode && (
        <div className="mb-6 p-3.5 rounded-xl bg-purple-950/40 border border-purple-500/30 text-purple-200 text-xs flex items-center justify-between gap-3 shadow-lg">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse shrink-0" />
            <span>
              <strong>Live Audio Sync Mode:</strong> Spoken narration differs from loaded book text. The narrator&apos;s audio is transcribed and synchronized in real-time.
            </span>
          </div>
        </div>
      )}

      {/* ── Reading Container: Paginated Book View vs Scroll View ───────────── */}
      {displayWords.length > 0 ? (
        readingViewMode === 'book' ? (
          /* ── Paginated Book View (Kindle/Apple Books Sheet) ──────────────── */
          <div className="flex-1 flex flex-col items-center">
            <div className="w-full max-w-3xl bg-zinc-900/70 border border-zinc-800/90 rounded-3xl p-8 md:p-14 book-paper-shadow flex flex-col min-h-[560px] relative backdrop-blur-md">
              {/* Header on page */}
              <div className="flex items-center justify-between text-[11px] text-zinc-500 uppercase tracking-widest pb-4 mb-6 border-b border-zinc-800/80">
                <span className="truncate max-w-[240px]">{currentBook.title}</span>
                <span>Segment {currentChunkIndex + 1}</span>
              </div>

              {/* Page text */}
              <div className="text-lg md:text-xl text-zinc-200 leading-relaxed font-serif flex-1 flex flex-wrap content-start gap-x-[0.32em] gap-y-1.5">
                {bookPages[currentPageIndex]?.map((w) => {
                  const isActive = w.index === activeWordIndex;
                  const isPassed = w.index <= passedWordIndex && !isActive;
                  return (
                    <WordSpan
                      key={w.index}
                      word={w}
                      isActive={isActive}
                      isPassed={isPassed}
                      onClick={handleWordClick}
                      spanRef={isActive ? activeWordRef : undefined}
                    />
                  );
                })}
              </div>

              {/* Page footer & Turn controls */}
              <div className="flex items-center justify-between pt-6 mt-8 border-t border-zinc-800/80 text-xs text-zinc-400">
                <button
                  type="button"
                  onClick={() => setCurrentPageIndex(Math.max(0, currentPageIndex - 1))}
                  disabled={currentPageIndex <= 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-800 disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer font-medium"
                >
                  <ChevronLeft size={16} />
                  <span>Prev Page</span>
                </button>

                <span className="text-zinc-500 font-serif text-sm">
                  Page {currentPageIndex + 1} of {bookPages.length}
                </span>

                <button
                  type="button"
                  onClick={() => setCurrentPageIndex(Math.min(bookPages.length - 1, currentPageIndex + 1))}
                  disabled={currentPageIndex >= bookPages.length - 1}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-800 disabled:opacity-30 disabled:pointer-events-none transition-all cursor-pointer font-medium"
                >
                  <span>Next Page</span>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ── Continuous Scroll View ──────────────────────────────────────── */
          <div className="text-lg text-zinc-300 leading-relaxed font-serif bg-zinc-900/50 p-6 md:p-12 rounded-3xl border border-zinc-800 shadow-2xl backdrop-blur-sm flex-1">
            {Array.from(paragraphGroups.entries()).map(([paraIdx, words]) => (
              <div key={paraIdx} className="mb-6">
                <ParagraphRow
                  words={words}
                  activeWordIndex={activeWordIndex}
                  passedWordIndex={passedWordIndex}
                  onWordClick={handleWordClick}
                  activeRef={activeWordRef}
                />
              </div>
            ))}
            <p className="mt-8 text-xs text-zinc-600 border-t border-zinc-800 pt-4 flex justify-between items-center">
              <span>Segment {currentChunkIndex + 1} of {currentBook.chunks}</span>
              <span className="text-zinc-500">Scroll freely through all transcribed text</span>
            </p>
          </div>
        )
      ) : (
        <LoadingOverlay message={loadingMessage} />
      )}
    </div>
  );
};
