import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { FileAudio, FileText } from 'lucide-react';
import { AudioManager } from '../lib/audioManager';

export const FileUploader: React.FC = () => {
  const { loadingMessage } = useAppStore();
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [textFile, setTextFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  const handleProcess = async () => {
    if (!audioFile || !textFile) return;
    setLoading(true);
    await AudioManager.loadBook(audioFile, textFile);
    setLoading(false);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center min-h-screen bg-zinc-950 p-4">
      <div className="max-w-md w-full p-8 rounded-3xl bg-zinc-900 border border-zinc-800 shadow-2xl relative overflow-hidden group">
        <div className="absolute inset-0 bg-linear-to-br from-purple-500/10 to-pink-500/10 opacity-50 group-hover:opacity-100 transition-opacity" />
        
        <h2 className="text-3xl font-extrabold text-transparent bg-clip-text bg-linear-to-r from-purple-400 to-pink-500 mb-8 text-center relative z-10">
          SynKro
        </h2>
        
        <div className="space-y-6 relative z-10">
          <label className="flex items-center gap-4 p-4 rounded-xl border-2 border-dashed border-zinc-700 hover:border-purple-500 bg-zinc-950/50 cursor-pointer transition-all hover:shadow-[0_0_15px_rgba(168,85,247,0.3)]">
            <div className="p-3 bg-zinc-800 rounded-lg text-purple-400">
              <FileAudio size={24} />
            </div>
            <div className="flex-1 overflow-hidden">
               <p className="font-semibold text-zinc-200">Audiobook</p>
               <p className="text-sm text-zinc-500 truncate">{audioFile ? audioFile.name : 'Upload MP3/M4A'}</p>
            </div>
            <input 
              type="file" 
              accept="audio/*"
              className="hidden" 
              onChange={e => setAudioFile(e.target.files?.[0] || null)}
            />
          </label>

          <label className="flex items-center gap-4 p-4 rounded-xl border-2 border-dashed border-zinc-700 hover:border-pink-500 bg-zinc-950/50 cursor-pointer transition-all hover:shadow-[0_0_15px_rgba(236,72,153,0.3)]">
            <div className="p-3 bg-zinc-800 rounded-lg text-pink-400">
              <FileText size={24} />
            </div>
            <div className="flex-1 overflow-hidden">
               <p className="font-semibold text-zinc-200">Text File</p>
               <p className="text-sm text-zinc-500 truncate">{textFile ? textFile.name : 'Upload TXT/EPUB'}</p>
            </div>
            <input 
               type="file" 
               accept=".txt,.epub,.pdf"
               className="hidden" 
               onChange={e => setTextFile(e.target.files?.[0] || null)}
            />
          </label>

          <button
             onClick={handleProcess}
             disabled={!audioFile || !textFile || loading}
             className="w-full py-4 px-6 mt-4 rounded-xl font-bold bg-linear-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 text-white shadow-lg transition-all active:scale-[0.98] relative overflow-hidden"
          >
             {loading ? (
               <div className="flex flex-col items-center justify-center gap-1">
                 <div className="flex items-center gap-2">
                   <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                   <span>Processing Book...</span>
                 </div>
                 {loadingMessage && (
                   <span className="text-[10px] font-normal text-purple-200/80 animate-pulse tracking-wide uppercase">
                     {loadingMessage}
                   </span>
                 )}
               </div>
             ) : (
               'Start Synchronized Reading'
             )}
          </button>
        </div>
      </div>
    </div>
  );
};
