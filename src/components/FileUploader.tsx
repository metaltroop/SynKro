/**
 * FileUploader.tsx
 *
 * Entry Screen & Library Hub (v2):
 *  • Select or create SynKro Root Library folder on device (first load / each load)
 *  • Multi-book scanning: Lists all books found in the selected folder with PDF cover art thumbnails
 *  • No forced playback on folder open: shows list of books so the user can choose which one to open
 *  • Instant 1-click resume with pre-compiled manifests, sync offset, and lastPlayedTime
 *  • Add New Book flow: automatically creates sanitized subfolder `{Title}_SynKro` in root library folder
 *  • Universal fallback for mobile & non-Chromium browsers (webkitdirectory)
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  FileAudio,
  FileText,
  BookOpen,
  FolderOpen,
  FolderPlus,
  Play,
  Trash2,
  Clock,
  Cpu,
  FolderCheck,
  RefreshCw,
  Plus,
  ChevronDown,
  Sparkles,
  KeyRound,
} from 'lucide-react';
import { AudioManager } from '../lib/audioManager';
import { Storage } from '../lib/storage';
import {
  isFileSystemAccessSupported,
  selectOrCreateFolder,
  loadBookFromDirectoryHandle,
  scanLibraryDirectory,
  scanFilesForBooks,
  copyFileToFolder,
  saveManifestToFolder,
  generatePdfCover,
  sanitizeFolderName,
  queryPermissionOnly,
  verifyPermission,
  makeBookId,
  type ScannedFolderBook,
} from '../lib/folderManager';
import type { BookMetadata, SynkroManifest } from '../types';

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const FileUploader: React.FC = () => {
  const { loadingMessage } = useAppStore();

  // Root directory handle & session memory
  const [rootFolder, setRootFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [rootFolderNeedsReconnect, setRootFolderNeedsReconnect] = useState(false);
  const [lastActiveBook, setLastActiveBook] = useState<BookMetadata | null>(null);
  const [libraryBooks, setLibraryBooks] = useState<BookMetadata[]>([]);
  const [fallbackBooks, setFallbackBooks] = useState<ScannedFolderBook[]>([]);

  // Add new book state
  const [showAddForm, setShowAddForm] = useState(false);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [textFile, setTextFile] = useState<File | null>(null);
  const [destinationFolder, setDestinationFolder] = useState<FileSystemDirectoryHandle | null>(null);

  const [loading, setLoading] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folderInputRef = useRef<HTMLInputElement>(null);

  // ── Refresh library from IndexedDB & attached Root Folder ───────────────────
  const refreshLibrary = useCallback(async (dirHandle?: FileSystemDirectoryHandle | null) => {
    setIsScanning(true);
    try {
      // 1. Get stored metadata
      const stored = await Storage.getAllBooksMeta();
      // Exclude internal root config record
      const booksList = stored.filter((b) => b.id !== '__synkro_root_library__');

      // 2. If a root directory handle is attached, scan it for all books & subfolders
      const handle = dirHandle ?? rootFolder;
      if (handle) {
        const scanned = await scanLibraryDirectory(handle, false);
        for (const sb of scanned) {
          const existingIdx = booksList.findIndex((b) => b.id === sb.id || b.title === sb.title);
          if (existingIdx !== -1) {
            booksList[existingIdx] = { ...booksList[existingIdx], ...sb };
          } else {
            booksList.push(sb);
          }
          await Storage.saveBookMeta(sb);
        }
      }

      // Sort by most recently updated
      booksList.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      setLibraryBooks(booksList);
    } catch (err) {
      console.warn('[FileUploader] refreshLibrary error:', err);
    } finally {
      setIsScanning(false);
    }
  }, [rootFolder]);

  // Check for saved root folder handle and last active book session on mount
  useEffect(() => {
    async function initRoot() {
      const lastId = Storage.getLastActiveBookId();
      if (lastId) {
        const lastMeta = await Storage.getBookMeta(lastId);
        if (lastMeta) setLastActiveBook(lastMeta);
      }

      const savedHandle = await Storage.getRootFolderHandle();
      if (savedHandle) {
        setRootFolder(savedHandle);
        const isGranted = await queryPermissionOnly(savedHandle);
        if (isGranted) {
          setRootFolderNeedsReconnect(false);
          void refreshLibrary(savedHandle);
        } else {
          setRootFolderNeedsReconnect(true);
          // Load stored books from cache
          void refreshLibrary(null);
        }
      } else {
        void refreshLibrary(null);
      }
    }
    void initRoot();
  }, [refreshLibrary]);

  // ── Reconnect Root Folder with user click gesture ─────────────────────────
  const handleReconnectRootFolder = useCallback(async () => {
    if (!rootFolder) return;
    setError(null);
    setLoading(true);
    try {
      const granted = await verifyPermission(rootFolder, 'readwrite', true);
      if (granted) {
        setRootFolderNeedsReconnect(false);
        await refreshLibrary(rootFolder);
      } else {
        setError('Folder access was not granted.');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [rootFolder, refreshLibrary]);

  // ── Select / Create Root SynKro Library Folder ──────────────────────────────
  const handleSelectRootFolder = useCallback(async () => {
    if (!isFileSystemAccessSupported) {
      folderInputRef.current?.click();
      return;
    }

    setError(null);
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (!handle) return;

      setRootFolder(handle);
      await Storage.saveRootFolderHandle(handle);
      setLoading(true);
      await refreshLibrary(handle);
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') {
        setError(String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [refreshLibrary]);

  // ── Open Folder via Universal WebkitDirectory Fallback ─────────────────────
  const handleFolderInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      setError(null);
      setLoading(true);
      try {
        const scanned = await scanFilesForBooks(files);
        if (scanned.length === 0) {
          setError('No valid audio and text file found in the chosen folder.');
          return;
        }

        setFallbackBooks(scanned);

        // Also add to library list
        for (const fb of scanned) {
          const meta: BookMetadata = {
            id: fb.manifest?.bookId || makeBookId(fb.audioFile, fb.textFile),
            title: fb.title,
            duration: fb.manifest?.duration || 0,
            totalChunks: fb.manifest?.totalChunks || 0,
            compiledChunks: fb.manifest ? Object.keys(fb.manifest.transcripts || {}).length : 0,
            lastPlayedTime: fb.manifest?.lastPlayedTime || 0,
            updatedAt: fb.manifest?.updatedAt || new Date().toISOString(),
            audioFileName: fb.audioFile.name,
            textFileName: fb.textFile.name,
            coverUrl: fb.coverUrl,
            syncOffsetMs: fb.manifest?.syncOffsetMs || 0,
            playbackRate: fb.manifest?.playbackRate || 1.0,
            isCompileFullEnabled: fb.manifest?.isCompileFullEnabled,
          };
          await Storage.saveBookMeta(meta);
        }
        void refreshLibrary();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    },
    [refreshLibrary],
  );

  // ── Resume Book from Library ───────────────────────────────────────────────
  const handleOpenBook = useCallback(
    async (meta: BookMetadata) => {
      setError(null);
      setLoading(true);

      // Check if fallback books has it loaded in memory
      const fbMatch = fallbackBooks.find(
        (f) => f.title === meta.title || f.audioFile.name === meta.audioFileName,
      );
      if (fbMatch) {
        try {
          await AudioManager.loadBook(fbMatch.audioFile, fbMatch.textFile, fbMatch.manifest);
          return;
        } catch (err) {
          setError(String(err));
        } finally {
          setLoading(false);
        }
      }

      // Check if book has a directory handle attached
      let dirHandle = meta.dirHandle;
      if (!dirHandle && rootFolder) {
        // Try to find subfolder inside root folder matching sanitized title
        try {
          const subName = `${sanitizeFolderName(meta.title)}_SynKro`;
          dirHandle = await rootFolder.getDirectoryHandle(subName, { create: false });
        } catch {
          // not found
        }
      }

      if (dirHandle) {
        try {
          const res = await loadBookFromDirectoryHandle(dirHandle);
          if (res) {
            await AudioManager.loadBook(res.audioFile, res.textFile, res.manifest, res.handle);
            const state = useAppStore.getState();
            if (state.currentBook) {
              state.currentBook.dirHandle = res.handle;
            }
            return;
          }
        } catch (err) {
          console.warn('[FileUploader] Failed to load from directory handle:', err);
        } finally {
          setLoading(false);
        }
      }

      // If files aren't directly reachable, prompt user to pick them
      setLoading(false);
      setError(`Please select the folder or files for "${meta.title}" to open.`);
      setShowAddForm(true);
    },
    [fallbackBooks, rootFolder],
  );

  // ── Add New Book to Library Flow ───────────────────────────────────────────
  const handleAddNewBook = useCallback(async () => {
    if (!audioFile || !textFile) return;
    setError(null);
    setLoading(true);

    try {
      const bookTitle = audioFile.name.replace(/\.[^.]+$/, '');
      const bookId = makeBookId(audioFile, textFile);

      let targetHandle = destinationFolder;

      // If user has a rootFolder set and no specific destination chosen, create subfolder automatically!
      if (!targetHandle && rootFolder) {
        try {
          const subFolderName = `${sanitizeFolderName(bookTitle)}_SynKro`;
          targetHandle = await rootFolder.getDirectoryHandle(subFolderName, { create: true });
        } catch (err) {
          console.warn('[FileUploader] Could not create subfolder in root library:', err);
        }
      }

      let coverUrl: string | undefined = undefined;
      if (textFile.type === 'application/pdf' || textFile.name.endsWith('.pdf')) {
        coverUrl = (await generatePdfCover(textFile)) || undefined;
      }

      let initialManifest: SynkroManifest | null = null;

      if (targetHandle) {
        useAppStore.getState().setLoadingMessage('Setting up book folder & offline manifest…');
        void copyFileToFolder(targetHandle, textFile);

        initialManifest = {
          version: 2,
          bookId,
          title: bookTitle,
          audioFileName: audioFile.name,
          textFileName: textFile.name,
          duration: 0,
          chunkDuration: AudioManager.CHUNK_DURATION,
          totalChunks: 0,
          syncOffsetMs: 0,
          playbackRate: 1.0,
          lastPlayedTime: 0,
          updatedAt: new Date().toISOString(),
          coverUrl,
          transcripts: {},
        };
        await saveManifestToFolder(targetHandle, initialManifest);
      }

      await AudioManager.loadBook(audioFile, textFile, initialManifest, targetHandle);

      const state = useAppStore.getState();
      if (state.currentBook) {
        if (targetHandle) state.currentBook.dirHandle = targetHandle;
        if (coverUrl) state.currentBook.coverUrl = coverUrl;
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [audioFile, textFile, destinationFolder, rootFolder]);

  // ── Delete Book from Library ───────────────────────────────────────────────
  const handleDeleteBook = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await Storage.deleteBookMeta(id);
      void refreshLibrary();
    },
    [refreshLibrary],
  );

  return (
    <div className="flex-1 flex flex-col items-center justify-start min-h-screen bg-zinc-950 p-4 py-8 overflow-y-auto">
      {/* Hidden webkitdirectory input fallback */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is standard in all modern browsers
        webkitdirectory=""
        multiple
        className="hidden"
        onChange={handleFolderInputChange}
      />

      <div className="max-w-4xl w-full flex flex-col gap-6">
        {/* ── Brand Header ─────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center text-center pt-2 pb-2">
          <div className="w-16 h-16 rounded-3xl bg-gradient-to-tr from-purple-600 via-pink-600 to-purple-400 flex items-center justify-center mb-3 shadow-xl shadow-purple-900/40 border border-white/10">
            <BookOpen size={30} className="text-white" />
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-pink-400 to-purple-200 tracking-tight">
            SynKro Library
          </h1>
          <p className="text-zinc-400 text-xs md:text-sm mt-1 max-w-md">
            Portable audiobook & text synchronization · 100% offline device storage
          </p>
        </div>

        {/* ── Root Library Folder Selector / Status Banner ──────────────────── */}
        <div className="p-5 rounded-3xl bg-zinc-900/80 border border-zinc-800 shadow-2xl backdrop-blur-md relative overflow-hidden group">
          <div className="absolute inset-0 bg-gradient-to-r from-purple-500/10 via-transparent to-pink-500/10 opacity-50 pointer-events-none" />

          <div className="flex flex-wrap items-center justify-between gap-4 relative z-10">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-12 h-12 rounded-2xl bg-zinc-800/90 border border-zinc-700/60 flex items-center justify-center shrink-0 text-purple-400 shadow-inner">
                {rootFolder ? <FolderCheck size={24} className="text-emerald-400" /> : <FolderOpen size={24} />}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-zinc-100">
                    {rootFolder ? rootFolder.name : 'Select SynKro Library Folder'}
                  </p>
                  {rootFolder && (
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
                        rootFolderNeedsReconnect
                          ? 'bg-amber-950/60 border-amber-500/40 text-amber-300'
                          : 'bg-emerald-950/60 border-emerald-500/40 text-emerald-300'
                      }`}
                    >
                      {rootFolderNeedsReconnect ? 'Permission Needed' : 'Active'}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 truncate mt-0.5">
                  {rootFolder
                    ? rootFolderNeedsReconnect
                      ? 'Access expired after browser restart. Click Reconnect to unlock without browsing again.'
                      : 'All books, manifests, and PDF covers are auto-saved in this device folder'
                    : 'Choose or create a folder on disk to store and organize your books'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {rootFolder && rootFolderNeedsReconnect ? (
                <button
                  type="button"
                  onClick={handleReconnectRootFolder}
                  className="py-2.5 px-4 rounded-xl text-xs font-semibold bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white shadow-lg shadow-amber-950/40 flex items-center gap-2 transition-all cursor-pointer active:scale-95 animate-pulse"
                >
                  <KeyRound size={15} />
                  <span>Reconnect Folder</span>
                </button>
              ) : null}

              <button
                type="button"
                onClick={handleSelectRootFolder}
                className="py-2.5 px-4 rounded-xl text-xs font-semibold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-lg shadow-purple-900/30 flex items-center gap-2 transition-all cursor-pointer active:scale-95"
              >
                <FolderPlus size={16} />
                <span>{rootFolder ? 'Change Folder' : 'Select / Create Folder'}</span>
              </button>

              {rootFolder && !rootFolderNeedsReconnect && (
                <button
                  type="button"
                  onClick={() => refreshLibrary()}
                  disabled={isScanning}
                  className="p-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/60 text-zinc-300 hover:text-white transition-all cursor-pointer"
                  title="Rescan folder for books"
                >
                  <RefreshCw size={16} className={isScanning ? 'animate-spin text-purple-400' : ''} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Last Active Session Hero Banner ───────────────────────────────── */}
        {lastActiveBook && (
          <div className="p-4 md:p-5 rounded-3xl bg-gradient-to-r from-purple-950/70 via-zinc-900/80 to-pink-950/60 border border-purple-500/40 shadow-2xl flex flex-wrap items-center justify-between gap-4 backdrop-blur-md relative overflow-hidden group">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-16 h-22 rounded-xl overflow-hidden shrink-0 border border-purple-500/40 bg-zinc-950 shadow-md flex items-center justify-center">
                {lastActiveBook.coverUrl ? (
                  <img
                    src={lastActiveBook.coverUrl}
                    alt={lastActiveBook.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <BookOpen size={24} className="text-purple-400" />
                )}
              </div>
              <div className="min-w-0">
                <span className="text-[10px] font-bold uppercase tracking-wider text-purple-400 flex items-center gap-1">
                  <Sparkles size={11} />
                  <span>Pick up where you left off</span>
                </span>
                <h3 className="text-base font-extrabold text-zinc-100 truncate group-hover:text-purple-300 transition-colors mt-0.5">
                  {lastActiveBook.title}
                </h3>
                <div className="text-xs text-zinc-400 flex items-center gap-2 mt-1">
                  <span className="flex items-center gap-1 font-mono text-zinc-300">
                    <Clock size={12} className="text-zinc-500" />
                    {formatDuration(lastActiveBook.lastPlayedTime)} / {formatDuration(lastActiveBook.duration)}
                  </span>
                  <span>·</span>
                  <span className="text-purple-300 font-semibold flex items-center gap-1">
                    <Cpu size={12} />
                    {Math.min(
                      100,
                      Math.round((lastActiveBook.compiledChunks / Math.max(1, lastActiveBook.totalChunks)) * 100),
                    )}% compiled
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => handleOpenBook(lastActiveBook)}
              className="py-3 px-5 rounded-2xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-xl shadow-purple-900/40 flex items-center gap-2.5 transition-all cursor-pointer active:scale-95 text-xs"
            >
              <Play size={16} fill="currentColor" className="ml-0.5" />
              <span>Resume Reading</span>
            </button>
          </div>
        )}

        {/* ── Error Notification ────────────────────────────────────────────── */}
        {error && (
          <div className="p-3.5 rounded-2xl bg-red-950/40 border border-red-500/40 text-red-200 text-xs flex items-center justify-between gap-3 shadow-lg">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-200 font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* ── Library Books Grid ────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-400 flex items-center gap-2">
              <span>Your Books</span>
              <span className="text-xs text-zinc-500 font-mono">({libraryBooks.length})</span>
            </h2>

            <button
              type="button"
              onClick={() => setShowAddForm((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-800/90 hover:bg-zinc-800 border border-zinc-700/60 text-zinc-200 hover:text-white text-xs font-medium transition-all cursor-pointer"
            >
              <Plus size={14} className="text-purple-400" />
              <span>Add New Book</span>
              <ChevronDown
                size={14}
                className={`transition-transform duration-200 ${showAddForm ? 'rotate-180' : ''}`}
              />
            </button>
          </div>

          {/* Add New Book Form (Collapsible) */}
          {showAddForm && (
            <div className="p-6 rounded-3xl bg-zinc-900/90 border border-zinc-800 shadow-2xl flex flex-col gap-4 animate-in fade-in duration-200">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-purple-300 flex items-center gap-2">
                <Sparkles size={14} />
                <span>Import New Audiobook & Text</span>
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {/* Audio file picker */}
                <label className="flex items-center gap-3.5 p-3.5 rounded-2xl border border-zinc-700 hover:border-purple-500 bg-zinc-950/50 cursor-pointer transition-all">
                  <div className="p-2.5 bg-zinc-800 rounded-xl text-purple-400 shrink-0">
                    <FileAudio size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-zinc-200 text-xs">Audio File</p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {audioFile ? audioFile.name : 'Pick MP3 / M4B / WAV / AAC'}
                    </p>
                  </div>
                  {audioFile && <span className="text-xs text-green-400 font-bold shrink-0">✓</span>}
                  <input
                    type="file"
                    accept="audio/*,.mp3,.m4b,.wav,.aac,.ogg,.flac"
                    className="hidden"
                    onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                  />
                </label>

                {/* Text file picker */}
                <label className="flex items-center gap-3.5 p-3.5 rounded-2xl border border-zinc-700 hover:border-pink-500 bg-zinc-950/50 cursor-pointer transition-all">
                  <div className="p-2.5 bg-zinc-800 rounded-xl text-pink-400 shrink-0">
                    <FileText size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-zinc-200 text-xs">Book Text / PDF</p>
                    <p className="text-[11px] text-zinc-500 truncate">
                      {textFile ? textFile.name : 'Pick PDF (Cover extracted) / TXT'}
                    </p>
                  </div>
                  {textFile && <span className="text-xs text-green-400 font-bold shrink-0">✓</span>}
                  <input
                    type="file"
                    accept=".txt,.epub,.pdf"
                    className="hidden"
                    onChange={(e) => setTextFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>

              {/* Destination folder */}
              {isFileSystemAccessSupported && !rootFolder && (
                <button
                  type="button"
                  onClick={async () => {
                    const handle = await selectOrCreateFolder();
                    if (handle) setDestinationFolder(handle);
                  }}
                  className="py-2.5 px-3.5 rounded-xl border border-zinc-800 hover:border-zinc-700 bg-zinc-950/40 text-xs text-zinc-400 flex items-center justify-between cursor-pointer"
                >
                  <div className="flex items-center gap-2 truncate">
                    <FolderPlus size={16} className="text-zinc-500 shrink-0" />
                    <span className="truncate">
                      {destinationFolder ? `Destination: ${destinationFolder.name}` : 'Select Folder to Save Book'}
                    </span>
                  </div>
                  <span className="text-[10px] text-zinc-500">Optional</span>
                </button>
              )}

              {/* Start reading button */}
              <button
                type="button"
                onClick={handleAddNewBook}
                disabled={!audioFile || !textFile || loading}
                className="w-full py-3.5 px-5 rounded-2xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-600 text-white shadow-xl shadow-purple-900/30 transition-all cursor-pointer"
              >
                {loading ? (
                  <div className="flex flex-col items-center gap-1">
                    <div className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      <span className="text-xs">Preparing book…</span>
                    </div>
                    {loadingMessage && (
                      <span className="text-[10px] text-purple-200/70 uppercase tracking-widest animate-pulse">
                        {loadingMessage}
                      </span>
                    )}
                  </div>
                ) : (
                  'Start Reading'
                )}
              </button>
            </div>
          )}

          {/* Book Cards Grid */}
          {libraryBooks.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {libraryBooks.map((b) => {
                const percent = Math.min(
                  100,
                  Math.round((b.compiledChunks / Math.max(1, b.totalChunks)) * 100),
                );

                return (
                  <div
                    key={b.id}
                    onClick={() => handleOpenBook(b)}
                    className="p-4 rounded-3xl bg-zinc-900/80 hover:bg-zinc-850 border border-zinc-800/90 hover:border-purple-500/50 shadow-xl transition-all duration-200 cursor-pointer group flex gap-3.5 relative overflow-hidden"
                  >
                    {/* Ambient subtle glow on hover */}
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-600/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

                    {/* Book Cover Thumbnail (PDF Page 1 or Stylized Spine) */}
                    <div className="w-20 h-28 rounded-2xl overflow-hidden shrink-0 border border-zinc-700/60 shadow-lg relative bg-zinc-950 flex items-center justify-center">
                      {b.coverUrl ? (
                        <img
                          src={b.coverUrl}
                          alt={b.title}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-purple-950 via-zinc-900 to-pink-950 p-2 flex flex-col items-center justify-center text-center">
                          <BookOpen size={22} className="text-purple-400 mb-1 opacity-80" />
                          <span className="text-[9px] font-bold text-zinc-300 line-clamp-3 leading-tight">
                            {b.title}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Book Information */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                      <div>
                        <h3 className="text-sm font-bold text-zinc-100 truncate group-hover:text-purple-300 transition-colors">
                          {b.title}
                        </h3>
                        <p className="text-[11px] text-zinc-500 truncate mt-0.5">
                          {b.audioFileName || 'Audiobook'}
                        </p>
                      </div>

                      <div className="space-y-1.5 mt-2">
                        {/* Time progress */}
                        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400 font-mono">
                          <Clock size={12} className="text-zinc-500" />
                          <span>
                            {formatDuration(b.lastPlayedTime)} / {formatDuration(b.duration)}
                          </span>
                        </div>

                        {/* Compilation Status Pill */}
                        <div className="flex items-center justify-between text-[11px]">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ${
                              percent === 100
                                ? 'bg-emerald-950/60 border border-emerald-500/40 text-emerald-300'
                                : 'bg-purple-950/60 border border-purple-500/30 text-purple-300'
                            }`}
                          >
                            <Cpu size={11} />
                            <span>{percent}% compiled</span>
                          </span>

                          <button
                            type="button"
                            onClick={(e) => handleDeleteBook(b.id, e)}
                            className="p-1 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-red-950/30 transition-all cursor-pointer opacity-0 group-hover:opacity-100"
                            title="Remove from library"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Play hover button */}
                    <div className="absolute right-3 top-3 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-8 h-8 rounded-xl bg-purple-600 text-white flex items-center justify-center shadow-lg shadow-purple-900/60">
                        <Play size={14} fill="currentColor" className="ml-0.5" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-12 rounded-3xl bg-zinc-900/40 border border-dashed border-zinc-800 flex flex-col items-center justify-center text-center">
              <BookOpen size={36} className="text-zinc-600 mb-3" />
              <p className="text-sm font-semibold text-zinc-300">No books found in this library</p>
              <p className="text-xs text-zinc-500 max-w-sm mt-1">
                Click &quot;Add New Book&quot; above to import your first audiobook and text, or select a folder containing SynKro book subfolders.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
