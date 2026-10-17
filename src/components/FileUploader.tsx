/**
 * FileUploader.tsx
 *
 * Entry screen: pick audio + text files, then launch the synchronised reader.
 */

import React, { useState, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import { FileAudio, FileText, BookOpen } from 'lucide-react';
import { AudioManager } from '../lib/audioManager';

export const FileUploader: React.FC = () => {
  const { loadingMessage } = useAppStore();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [textFile, setTextFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleProcess = useCallback(async () => {
    if (!audioFile || !textFile) return;
    setError(null);
    setLoading(true);
    try {
      await AudioManager.loadBook(audioFile, textFile);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [audioFile, textFile]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-screen bg-zinc-950 p-4">
      <div className="max-w-md w-full p-8 rounded-3xl bg-zinc-900 border border-zinc-800 shadow-2xl relative overflow-hidden group">
        {/* Gradient glow */}
        <div className="absolute inset-0 bg-gradient-to-br from-purple-500/10 to-pink-500/10 opacity-50 group-hover:opacity-80 transition-opacity duration-500 pointer-events-none" />

        {/* Logo / Title */}
        <div className="flex flex-col items-center mb-8 relative z-10">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center mb-4 shadow-lg shadow-purple-900/50">
            <BookOpen size={32} className="text-white" />
          </div>
          <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-500">
            SynKro
          </h1>
          <p className="text-zinc-500 text-sm mt-1 text-center">
            Audiobook ↔ Text · Word-level sync · 100% offline AI
          </p>
        </div>

        <div className="space-y-4 relative z-10">
          {/* Audio file picker */}
          <label className="flex items-center gap-4 p-4 rounded-xl border-2 border-dashed border-zinc-700 hover:border-purple-500 bg-zinc-950/50 cursor-pointer transition-all duration-200 hover:shadow-[0_0_15px_rgba(168,85,247,0.25)]">
            <div className="p-3 bg-zinc-800 rounded-lg text-purple-400 shrink-0">
              <FileAudio size={24} />
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="font-semibold text-zinc-200">Audiobook</p>
              <p className="text-sm text-zinc-500 truncate">
                {audioFile ? audioFile.name : 'Upload MP3 / M4A / OGG'}
              </p>
            </div>
            {audioFile && (
              <span className="text-xs text-green-400 shrink-0">✓</span>
            )}
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
            />
          </label>

          {/* Text file picker */}
          <label className="flex items-center gap-4 p-4 rounded-xl border-2 border-dashed border-zinc-700 hover:border-pink-500 bg-zinc-950/50 cursor-pointer transition-all duration-200 hover:shadow-[0_0_15px_rgba(236,72,153,0.25)]">
            <div className="p-3 bg-zinc-800 rounded-lg text-pink-400 shrink-0">
              <FileText size={24} />
            </div>
            <div className="flex-1 overflow-hidden">
              <p className="font-semibold text-zinc-200">Book Text</p>
              <p className="text-sm text-zinc-500 truncate">
                {textFile ? textFile.name : 'Upload TXT / PDF / EPUB'}
              </p>
            </div>
            {textFile && (
              <span className="text-xs text-green-400 shrink-0">✓</span>
            )}
            <input
              type="file"
              accept=".txt,.epub,.pdf"
              className="hidden"
              onChange={(e) => setTextFile(e.target.files?.[0] ?? null)}
            />
          </label>

          {/* Error */}
          {error && (
            <p className="text-red-400 text-sm text-center bg-red-900/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          {/* Submit */}
          <button
            onClick={handleProcess}
            disabled={!audioFile || !textFile || loading}
            className="w-full py-4 px-6 mt-2 rounded-xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white shadow-lg shadow-purple-900/30 transition-all duration-200 active:scale-[0.98] relative overflow-hidden"
          >
            {loading ? (
              <div className="flex flex-col items-center gap-1">
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  <span>Preparing book…</span>
                </div>
                {loadingMessage && (
                  <span className="text-[10px] font-normal text-purple-200/70 animate-pulse tracking-widest uppercase">
                    {loadingMessage}
                  </span>
                )}
              </div>
            ) : (
              'Start Synchronised Reading'
            )}
          </button>
        </div>

        {/* Footer hint */}
        <p className="text-center text-zinc-600 text-xs mt-6 relative z-10">
          All processing happens on your device. Nothing is uploaded.
        </p>
      </div>
    </div>
  );
};
