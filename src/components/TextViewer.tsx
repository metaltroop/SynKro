import React, { useMemo, useRef, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';

export const TextViewer: React.FC = () => {
  const { currentBook, transcripts, currentTime, loadingMessage } = useAppStore();
  const activeWordRef = useRef<HTMLSpanElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentChunkIndex = Math.floor(currentTime / 60);
  const currentTranscript = transcripts[currentChunkIndex];
  
  // Memoize words for potential manual alignment fallback
  useMemo(() => {
    if (!currentBook) return [];
    return currentBook.text.split(/\s+/).filter(Boolean);
  }, [currentBook]);

  useEffect(() => {
    if (activeWordRef.current) {
      activeWordRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest'
      });
    }
  }, [currentTime]);

  // If no book, nothing to show
  if (!currentBook) return null;

  return (
    <div className="flex-1 overflow-y-auto w-full p-4 pb-32 max-w-4xl mx-auto" ref={containerRef}>
      <h1 className="text-3xl font-bold mb-8 text-center bg-clip-text text-transparent bg-linear-to-r from-purple-400 to-pink-600">
        {currentBook.title || "Unknown Book"}
      </h1>
      
      <div className="text-lg text-zinc-300 leading-relaxed font-serif bg-zinc-900/50 p-6 md:p-12 rounded-2xl border border-zinc-800 shadow-xl backdrop-blur-sm">
        {currentTranscript ? (
            <div className="flex flex-wrap gap-x-2 gap-y-1">
              {currentTranscript.words.map((w, idx) => {
                const isActive = currentTime >= w.start && currentTime <= w.end;
                const isPassed = currentTime > w.end;
                
                return (
                  <span
                    key={idx}
                    ref={isActive ? activeWordRef : null}
                    className={`transition-all duration-300 rounded px-1 cursor-pointer ${
                      isActive ? 'bg-purple-500/40 text-purple-100 scale-110 shadow-[0_0_10px_rgba(168,85,247,0.4)]' : 
                      isPassed ? 'text-zinc-500' : 'text-zinc-200 hover:bg-zinc-800'
                    }`}
                    onClick={() => useAppStore.getState().setCurrentTime(w.start)}
                  >
                    {w.word}
                  </span>
                );
              })}
            </div>
        ) : (
            <div className="flex flex-col items-center justify-center p-12 text-zinc-500 min-h-[400px]">
              <div className="h-10 w-10 border-4 border-zinc-700 border-t-purple-500 rounded-full animate-spin mb-6" />
              <p className="text-white font-medium text-lg text-center">{loadingMessage || 'Initializing AI Engine...'}</p>
              <p className="text-sm mt-2 opacity-50 max-w-xs text-center">
                This process runs entirely on your browser. Please stay on this tab while the first segment is alignment.
              </p>
            </div>
        )}

        <div className="mt-8 text-zinc-600 border-t border-zinc-800 pt-8 opacity-50 text-sm">
          <p>
            Note: This view follows {currentChunkIndex + 1} of {currentBook.chunks} audio segments.
          </p>
          <div className="mt-4 max-h-48 overflow-y-auto p-4 bg-black/20 rounded-lg italic">
             {currentBook.text}
          </div>
        </div>
      </div>
    </div>
  );
};
