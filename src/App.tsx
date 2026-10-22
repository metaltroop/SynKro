import { useEffect, useState } from 'react';
import { useAppStore } from './store/useAppStore';
import { FileUploader } from './components/FileUploader';
import { AudioPlayer } from './components/AudioPlayer';
import { TextViewer } from './components/TextViewer';
import { Storage } from './lib/storage';
import { AudioManager } from './lib/audioManager';
import {
  loadBookFromDirectoryHandle,
  queryPermissionOnly,
  sanitizeFolderName,
} from './lib/folderManager';

function App() {
  const { currentBook } = useAppStore();
  const [isAutoResuming, setIsAutoResuming] = useState(false);

  // Auto-pickup last active book on startup if folder permission is already active
  useEffect(() => {
    let cancelled = false;

    async function attemptAutoResume() {
      const lastId = Storage.getLastActiveBookId();
      if (!lastId || useAppStore.getState().currentBook) return;

      try {
        const meta = await Storage.getBookMeta(lastId);
        if (!meta || cancelled) return;

        let handle = meta.dirHandle;
        if (!handle) {
          const rootHandle = await Storage.getRootFolderHandle();
          if (rootHandle) {
            const subName = `${sanitizeFolderName(meta.title)}_SynKro`;
            try {
              handle = await rootHandle.getDirectoryHandle(subName, { create: false });
            } catch {
              handle = rootHandle;
            }
          }
        }

        if (handle) {
          const hasPerm = await queryPermissionOnly(handle);
          if (hasPerm && !cancelled) {
            setIsAutoResuming(true);
            const res = await loadBookFromDirectoryHandle(handle, false);
            if (res && !cancelled) {
              await AudioManager.loadBook(res.audioFile, res.textFile, res.manifest, res.handle);
              const state = useAppStore.getState();
              if (state.currentBook) {
                state.currentBook.dirHandle = res.handle;
              }
            }
          }
        }
      } catch (err) {
        console.warn('[App] Auto-resume error:', err);
      } finally {
        if (!cancelled) setIsAutoResuming(false);
      }
    }

    void attemptAutoResume();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="h-screen max-h-screen overflow-hidden bg-zinc-950 text-slate-200 font-sans selection:bg-purple-500/30 flex flex-col">
      {isAutoResuming ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-zinc-950 gap-3">
          <div className="w-10 h-10 border-4 border-zinc-800 border-t-purple-500 rounded-full animate-spin" />
          <p className="text-sm font-medium text-zinc-300">Resuming your reading session…</p>
        </div>
      ) : !currentBook ? (
        <FileUploader />
      ) : (
        <>
          <TextViewer />
          <AudioPlayer />
        </>
      )}
    </div>
  );
}

export default App;
