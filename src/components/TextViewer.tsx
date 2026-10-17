/**
 * TextViewer.tsx
 *
 * Renders real book text (AlignedChunk.words) with accurate word-by-word highlighting.
 *
 * Performance fixes:
 *  • scrollIntoView fires only when the active word index CHANGES (not every tick)
 *  • Paragraph rows are React.memo'd — only the row containing the active word re-renders
 *  • Words are grouped by paragraphIndex for natural reading flow
 */

import React, { useMemo, useRef, useEffect, useCallback, memo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { AudioManager } from '../lib/audioManager';
import { Library } from 'lucide-react';
import type { BookWord } from '../types';

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
      className={`inline transition-all duration-200 rounded px-0.5 cursor-pointer select-none ${
        isActive
          ? 'bg-purple-500/40 text-purple-100 scale-105 shadow-[0_0_8px_rgba(168,85,247,0.5)]'
          : isPassed
          ? 'text-zinc-500'
          : 'text-zinc-200 hover:bg-zinc-800/60'
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
    <div className="relative flex flex-col items-center justify-center min-h-[400px] overflow-hidden rounded-xl">
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/60 backdrop-blur-md rounded-xl border border-white/5 shadow-2xl">
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
  const { currentBook, alignedChunks, transcripts, currentTime, loadingMessage } = useAppStore();
  const activeWordRef = useRef<HTMLSpanElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledWordIndex = useRef<number>(-1);

  const currentChunkIndex = Math.floor(currentTime / AudioManager.CHUNK_DURATION);
  const activeAligned = alignedChunks[currentChunkIndex];
  const isDirectMode = Boolean(activeAligned?.isDirectTranscript);

  // ── Continuous Scrollable Word Collection ─────────────────────────────────
  // Accumulate words from all ready chunks so user can scroll through the full text
  const displayWords: BookWord[] = useMemo(() => {
    // If current chunk is direct transcript mode (preamble or mismatched book):
    // Accumulate all processed chunks into a continuous, scrollable reading flow
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

          // Deduplicate boundary words that repeat across chunk seams
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

    // Book-aligned mode:
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

    // Transition fallback
    if (currentChunkIndex > 0 && alignedChunks[currentChunkIndex - 1]?.words.length) {
      return alignedChunks[currentChunkIndex - 1].words;
    }

    return [];
  }, [isDirectMode, activeAligned, alignedChunks, transcripts, currentChunkIndex]);

  // ── Group words by paragraph and deduplicate identical/overlapping paragraphs ──
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
        // Compare overlap with previous paragraph to catch stale duplicate chunks
        const tokenSet = new Set(prevTokens);
        let matchCount = 0;
        for (const tok of currentTokens) {
          if (tokenSet.has(tok)) matchCount++;
        }
        const overlap = matchCount / Math.max(1, Math.min(prevTokens.length, currentTokens.length));
        if (overlap > 0.65 && currentTokens.length >= 8) {
          // Omit duplicate chunk paragraph!
          console.warn(`[TextViewer] Omitted duplicate paragraph ${paraIdx} (${(overlap * 100).toFixed(0)}% identical)`);
          continue;
        }
      }

      cleanMap.set(paraIdx, words);
      prevTokens = currentTokens;
    }

    return cleanMap;
  }, [displayWords]);

  // ── Renderable words (only from valid deduplicated paragraphs) ─────────────
  const renderableWords = useMemo<BookWord[]>(() => {
    const result: BookWord[] = [];
    for (const words of paragraphGroups.values()) {
      result.push(...words);
    }
    return result;
  }, [paragraphGroups]);

  // ── Find active word index without flickering or cross-paragraph juggling ──
  const { activeWordIndex, passedWordIndex } = useMemo(() => {
    if (renderableWords.length === 0) return { activeWordIndex: -1, passedWordIndex: -1 };

    const currentChunk = Math.floor(currentTime / AudioManager.CHUNK_DURATION);
    // Acoustic lead compensation: human speech perception anticipates words slightly ahead,
    // and Whisper token boundaries naturally follow ~150-180ms behind the acoustic onset of the word.
    const effectiveTime = currentTime + 0.16;

    let active = -1;
    let passed = -1;
    let bestScore = Infinity;

    for (const w of renderableWords) {
      if (w.start !== undefined && w.end !== undefined) {
        if (effectiveTime >= w.start && effectiveTime <= w.end) {
          // Strictly prioritize words from the currentChunk/paragraph to eliminate any highlight juggling
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

    // Natural inter-word pause smoothing:
    // If between words during a brief speech pause (<= 0.4s), maintain highlight on the last spoken word
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
  }, [renderableWords, currentTime]);

  // ── Gentle auto-scroll — scrolls only when active word changes ───────────
  useEffect(() => {
    if (
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
  }, [activeWordIndex]);

  // ── Word click handler ────────────────────────────────────────────────────
  const handleWordClick = useCallback((start: number) => {
    useAppStore.getState().setCurrentTime(start);
  }, []);

  if (!currentBook) return null;

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-y-auto w-full p-4 pb-48 max-w-4xl mx-auto flex flex-col scroll-smooth"
    >
      {/* Top Navigation Bar */}
      <header className="flex items-center justify-between py-3 mb-6 border-b border-zinc-800/80 sticky top-0 bg-zinc-950/90 backdrop-blur-md z-30">
        <button
          type="button"
          onClick={() => {
            AudioManager.dispose();
            useAppStore.getState().resetBook();
          }}
          title="Back to library"
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-700/60 shadow-sm transition-all cursor-pointer text-sm font-medium"
        >
          <Library size={16} />
          <span>Library</span>
        </button>

        <span className="text-xs font-medium text-zinc-400 bg-zinc-900/80 px-3 py-1 rounded-full border border-zinc-800">
          Segment {currentChunkIndex + 1} of {currentBook.chunks}
        </span>
      </header>

      {/* Title */}
      <h1 className="text-3xl font-bold mb-4 text-center bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-pink-500">
        {currentBook.title}
      </h1>

      {/* Book mismatch / live transcript mode banner */}
      {isDirectMode && (
        <div className="mb-6 p-3.5 rounded-xl bg-purple-950/40 border border-purple-500/30 text-purple-200 text-xs flex items-center justify-between gap-3 shadow-lg">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse shrink-0" />
            <span>
              <strong>Live Audio Sync Mode:</strong> Spoken narration differs from loaded book text. Wil Wheaton&apos;s audio is transcribed and synchronized in real-time.
            </span>
          </div>
        </div>
      )}

      {/* Reading container */}
      <div className="text-lg text-zinc-300 leading-relaxed font-serif bg-zinc-900/50 p-6 md:p-12 rounded-2xl border border-zinc-800 shadow-xl backdrop-blur-sm flex-1">
        {displayWords.length > 0 ? (
          <>
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
          </>
        ) : (
          <LoadingOverlay message={loadingMessage} />
        )}
      </div>
    </div>
  );
};
