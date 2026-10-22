/**
 * textAligner.ts
 *
 * Tokenises book text into BookWord[] and BookParagraph[] once, then on each
 * chunk completion runs a sliding-window token-anchor alignment:
 *
 *   1. Strip punctuation & lowercase Whisper tokens → "normalised whisper words"
 *   2. Find the best-matching contiguous slice of book words using anchors
 *      (first/last known words + Levenshtein distance on the sequence).
 *   3. Assign `start` / `end` timestamps to every book word in that slice,
 *      interpolating smoothly for words Whisper skipped or merged.
 *
 * Returns an AlignedChunk ready for TextViewer.
 */

import type {
  BookWord,
  BookParagraph,
  WordTimestamp,
  AlignedChunk,
} from '../types';

// ─── Tokeniser ────────────────────────────────────────────────────────────────

/** Normalise a word for fuzzy comparison: lowercase, strip leading/trailing punct. */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
}

/**
 * Tokenise full book text into BookWords and paragraphs.
 * Splits on blank lines for paragraphs, whitespace for words.
 * Preserves original casing and punctuation in `text`.
 */
export function tokenizeBookText(fullText: string): {
  bookWords: BookWord[];
  paragraphs: BookParagraph[];
} {
  const bookWords: BookWord[] = [];
  const paragraphs: BookParagraph[] = [];

  const rawParagraphs = fullText.split(/\n{2,}/).filter((p) => p.trim());

  let globalIndex = 0;

  rawParagraphs.forEach((paraText, paraIndex) => {
    const rawWords = paraText.split(/\s+/).filter(Boolean);
    const paraWords: BookWord[] = [];

    rawWords.forEach((raw, wInPara) => {
      const bw: BookWord = {
        text: raw,
        normalized: normalizeWord(raw),
        index: globalIndex,
        paragraphIndex: paraIndex,
        wordIndexInParagraph: wInPara,
      };
      paraWords.push(bw);
      bookWords.push(bw);
      globalIndex++;
    });

    paragraphs.push({ index: paraIndex, words: paraWords });
  });

  return { bookWords, paragraphs };
}

// ─── Levenshtein ─────────────────────────────────────────────────────────────

/** Normalised Levenshtein similarity in [0, 1]. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const la = a.length;
  const lb = b.length;
  const dp: number[] = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= lb; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return 1 - dp[lb] / Math.max(la, lb);
}

// ─── Anchor search ────────────────────────────────────────────────────────────

/**
 * Find the index in `bookWords` where a Whisper sequence of length `whisperLen`
 * best aligns, centered around `searchAnchor`.
 *
 * Supports ±1500 words search window for out-of-order seeking, or up to 5000 words
 * for initial/early chunks to skip past publisher praise, copyright, and dedication pages.
 */
function findBestOffset(
  bookWords: BookWord[],
  whisperNorm: string[],
  searchAnchor: number,
  isEarlyChunk = false,
): { bestOffset: number; bestScore: number } {
  const wLen = whisperNorm.length;
  if (wLen === 0 || bookWords.length === 0) return { bestOffset: 0, bestScore: 0 };

  const searchStart = isEarlyChunk ? 0 : Math.max(0, searchAnchor - 1500);
  const maxLookahead = isEarlyChunk
    ? Math.min(5000, bookWords.length)
    : Math.min(bookWords.length, searchAnchor + 1500);
  const searchEnd = Math.max(
    searchStart,
    Math.min(bookWords.length - Math.floor(wLen * 0.5), maxLookahead),
  );

  let bestScore = -1;
  let bestOffset = searchStart;

  for (let offset = searchStart; offset <= searchEnd; offset++) {
    let score = 0;
    let counted = 0;
    const step = Math.max(1, Math.floor(wLen / 10));
    for (let wi = 0; wi < wLen; wi += step) {
      const bi = offset + wi;
      if (bi < bookWords.length) {
        score += similarity(whisperNorm[wi], bookWords[bi].normalized);
        counted++;
      }
    }
    const avg = counted > 0 ? score / counted : 0;
    if (avg > bestScore) {
      bestScore = avg;
      bestOffset = offset;
    }
  }

  return { bestOffset, bestScore };
}

// ─── Interpolation ───────────────────────────────────────────────────────────

/**
 * Given two anchor assignments (bookWords[iA].start = tA, bookWords[iB].start = tB),
 * linearly interpolate timestamps for all book words between iA and iB.
 */
function interpolateRange(
  bookWords: BookWord[],
  startIdx: number,
  endIdx: number,
  startTime: number,
  endTime: number,
) {
  const count = endIdx - startIdx + 1;
  const step = count > 1 ? (endTime - startTime) / (count - 1) : 0;
  for (let i = 0; i < count; i++) {
    const bw = bookWords[startIdx + i];
    bw.start = startTime + step * i;
    bw.end = startTime + step * (i + 1);
  }
}

// ─── Main alignment entry point ───────────────────────────────────────────────

/**
 * Chunk-aware cursor map: maps chunkIndex -> lastAssignedWordIndex in bookWords.
 * Ensures out-of-order scrubbing/seeking preserves stable alignments!
 */
const _chunkCursorMap = new Map<number, number>();

/** Reset the alignment cursor map (call when a new book is loaded). */
export function resetAlignmentCursor(): void {
  _chunkCursorMap.clear();
}

/**
 * Align a Whisper ChunkTranscript against the global bookWords array.
 *
 * If confidence is low (e.g. narrator reading audiobook credits, publisher announcements,
 * or audio preamble not found in print), returns the direct Whisper transcript words
 * so the text on screen ALWAYS matches what the user is hearing!
 */
export function alignChunk(
  bookWords: BookWord[],
  whisperWords: WordTimestamp[],
  chunkIndex: number,
  chunkStartTime: number,
  chunkEndTime: number,
  totalChunks = 1,
): AlignedChunk {
  if (whisperWords.length === 0) {
    return {
      chunkIndex,
      startTime: chunkStartTime,
      endTime: chunkEndTime,
      words: [],
    };
  }

  const whisperNorm = whisperWords.map((w) => normalizeWord(w.word));

  // Determine search anchor:
  let searchAnchor = 0;
  let isEarlyChunk = false;

  if (_chunkCursorMap.has(chunkIndex - 1)) {
    searchAnchor = _chunkCursorMap.get(chunkIndex - 1)! + 1;
  } else if (chunkIndex === 0 || chunkIndex === 1) {
    searchAnchor = 0;
    isEarlyChunk = true;
  } else {
    // Proportional estimate when user scrubbed/sought out of order
    searchAnchor = Math.floor((chunkIndex / Math.max(1, totalChunks)) * bookWords.length);
  }

  // Find best offset in bookWords for this chunk
  const { bestOffset: offset, bestScore } = findBestOffset(
    bookWords,
    whisperNorm,
    searchAnchor,
    isEarlyChunk,
  );

  // If match score is below strict threshold (audio preamble or mismatched book),
  // DO NOT force-match onto arbitrary book text! Return Whisper's direct transcript words.
  if (bestScore < 0.70 || bookWords.length === 0) {
    const directWords: BookWord[] = whisperWords.map((w, i) => ({
      text: w.word,
      normalized: normalizeWord(w.word),
      index: chunkIndex * 10000 + i,
      paragraphIndex: 0,
      wordIndexInParagraph: i,
      start: w.start,
      end: w.end,
    }));

    return {
      chunkIndex,
      startTime: chunkStartTime,
      endTime: chunkEndTime,
      words: directWords,
      isDirectTranscript: true,
    };
  }

  // Walk through Whisper tokens and assign timestamps to matching book words
  let bIdx = offset;
  let lastAssignedBIdx = -1;
  let lastAssignedTime = chunkStartTime;
  let matchedWordCount = 0;

  for (let wi = 0; wi < whisperNorm.length && bIdx < bookWords.length; wi++) {
    const wNorm = whisperNorm[wi];
    // Look ahead a few words in bookWords to handle insertions/merges
    let bestSim = 0;
    let bestBi = bIdx;
    for (let look = 0; look <= 4 && bIdx + look < bookWords.length; look++) {
      const s = similarity(wNorm, bookWords[bIdx + look].normalized);
      if (s > bestSim) {
        bestSim = s;
        bestBi = bIdx + look;
      }
    }
    if (bestSim > 0.65) {
      const bw = bookWords[bestBi];
      bw.start = whisperWords[wi].start;
      bw.end = whisperWords[wi].end;
      matchedWordCount++;

      // Interpolate gap between last assigned and this one
      if (lastAssignedBIdx >= 0 && bestBi - lastAssignedBIdx > 1) {
        interpolateRange(
          bookWords,
          lastAssignedBIdx + 1,
          bestBi - 1,
          lastAssignedTime,
          bw.start,
        );
      }
      lastAssignedBIdx = bestBi;
      lastAssignedTime = bw.end ?? chunkStartTime;
      bIdx = bestBi + 1;
    }
  }

  // Require at least 45% of words to have matched with high confidence (>0.65)
  const minRequiredMatches = Math.max(8, Math.floor(whisperNorm.length * 0.45));
  if (matchedWordCount >= minRequiredMatches && lastAssignedBIdx >= offset) {
    const chunkBookWords: BookWord[] = [];
    for (let i = offset; i <= lastAssignedBIdx; i++) {
      chunkBookWords.push(bookWords[i]);
    }
    // Remember assigned cursor for this chunk
    _chunkCursorMap.set(chunkIndex, lastAssignedBIdx);

    return {
      chunkIndex,
      startTime: chunkStartTime,
      endTime: chunkEndTime,
      words: chunkBookWords,
      isDirectTranscript: false,
    };
  }

  // If match density was too sparse (e.g. different book or preamble), return direct Whisper words
  const fallbackWords: BookWord[] = whisperWords.map((w, i) => ({
    text: w.word,
    normalized: normalizeWord(w.word),
    index: chunkIndex * 10000 + i,
    paragraphIndex: 0,
    wordIndexInParagraph: i,
    start: w.start,
    end: w.end,
  }));

  return {
    chunkIndex,
    startTime: chunkStartTime,
    endTime: chunkEndTime,
    words: fallbackWords,
    isDirectTranscript: true,
  };
}
