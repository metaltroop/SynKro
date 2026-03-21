import React, { useRef, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { AudioManager } from '../lib/audioManager';
import { Play, Pause, Rewind, FastForward } from 'lucide-react';

export const AudioPlayer: React.FC = () => {
  const { currentBook, isPlaying, isChunkBuffering, currentTime, setIsPlaying, setCurrentTime } = useAppStore();
  const audioRef = useRef<HTMLAudioElement>(null);
  const isSeekingRef = useRef<boolean>(false);

  useEffect(() => {
    AudioManager.initialize();
  }, []);

  useEffect(() => {
    if (audioRef.current && currentBook) {
      if (isPlaying && !isChunkBuffering) {
        audioRef.current.play();
      } else {
        audioRef.current.pause();
      }
    }
  }, [isPlaying, isChunkBuffering, currentBook]);

  // Handle external seek requests (e.g. clicking text or progress bar jump)
  useEffect(() => {
    if (audioRef.current) {
      const diff = Math.abs(audioRef.current.currentTime - currentTime);
      // Only force the audio element to jump if it drifted highly (user clicked a specific word)
      if (diff > 0.5) {
        isSeekingRef.current = true;
        audioRef.current.currentTime = currentTime;
      }
    }
  }, [currentTime]);

  const handleTimeUpdate = () => {
    if (audioRef.current && !isSeekingRef.current) {
      const time = audioRef.current.currentTime;
      setCurrentTime(time);
      AudioManager.onTimeUpdate(time);
    }
  };

  const handleSeeked = () => {
    isSeekingRef.current = false;
  };

  const togglePlay = () => setIsPlaying(!isPlaying);

  const skip = (amount: number) => {
    setCurrentTime(Math.max(0, currentTime + amount));
  };

  if (!currentBook) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-zinc-900 border-t border-zinc-800 p-4">
      <div className="max-w-4xl mx-auto flex flex-col gap-2">
        <audio
          ref={audioRef}
          src={currentBook.audioUrl as string}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleSeeked}
          onEnded={() => setIsPlaying(false)}
          className="hidden"
        />

        <div className="flex justify-between items-center text-xs text-zinc-400">
          <span>{formatTime(currentTime)}</span>
          <div className="w-full mx-4 h-1 bg-zinc-800 rounded relative cursor-pointer" onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            setCurrentTime(pos * currentBook.duration);
          }}>
            <div className="absolute top-0 left-0 h-1 bg-purple-500 rounded" style={{ width: `${(currentTime / currentBook.duration) * 100}%` }} />
          </div>
          <span>{formatTime(currentBook.duration)}</span>
        </div>

        <div className="flex justify-center items-center gap-6">
          <button onClick={() => skip(-15)} className="text-zinc-400 hover:text-white transition-colors">
            <Rewind size={20} />
          </button>

          <button onClick={togglePlay} className="w-12 h-12 flex items-center justify-center bg-purple-600 hover:bg-purple-500 rounded-full text-white shadow-lg shadow-purple-900/50 transition-all active:scale-95 relative">
            {isChunkBuffering ? (
              <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : isPlaying ? (
              <Pause size={24} fill="currentColor" />
            ) : (
              <Play size={24} fill="currentColor" className="ml-1" />
            )}
          </button>

          <button onClick={() => skip(15)} className="text-zinc-400 hover:text-white transition-colors">
            <FastForward size={20} />
          </button>
        </div>
      </div>
    </div>
  );
};

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
