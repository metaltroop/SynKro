/**
 * folderManager.ts
 *
 * True Local Device Folder Creation & Import System (v2).
 * Enables running SynKro completely offline on local folders:
 *  • Select or create destination folders on device (e.g. D:\Audiobooks\Dune_SynKro\)
 *  • Open existing SynKro folders with pre-compiled manifests
 *  • Live auto-save synkro-manifest.json directly to disk
 *  • Universal fallback for browsers without File System Access API (webkitdirectory / manifest download)
 */

import type { SynkroManifest, BookMetadata } from '../types';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

export const isFileSystemAccessSupported =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

/** Checks if the current client is a desktop or laptop (not mobile/tablet phone) */
export function isDesktopOrLaptop(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  return !isMobile;
}

/** Generates a high-quality base64 thumbnail of Page 1 from a PDF file */
export async function generatePdfCover(file: File): Promise<string | null> {
  try {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      return null;
    }
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    if (pdf.numPages === 0) return null;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 0.6 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (err) {
    console.warn('[folderManager] generatePdfCover error:', err);
    return null;
  }
}

/** Audio extensions supported for local playback */
const AUDIO_EXTS = ['.mp3', '.m4b', '.wav', '.aac', '.ogg', '.flac', '.m4a'];

/** Text/eBook extensions supported for extraction */
const TEXT_EXTS = ['.pdf', '.txt', '.epub'];

function isAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some((ext) => lower.endsWith(ext));
}

function isTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  return TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

export function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*]+/g, '_').trim();
}

/**
 * Canonical deterministic book ID formula matching WebMediaEngine.
 * Formatted as `${audio.name}_${audio.size}_${text.name}_${text.size}` sanitized.
 */
export function makeBookId(
  audio: { name: string; size: number },
  text: { name: string; size: number },
): string {
  return `${audio.name}_${audio.size}_${text.name}_${text.size}`.replace(
    /[^a-zA-Z0-9_]/g,
    '_',
  );
}

// ─── Native File System Access API ───────────────────────────────────────────

/**
 * Prompt the user to pick or create a folder on disk.
 * Can optionally create a dedicated `<bookTitle>_SynKro` subfolder inside the selected directory.
 */
export async function selectOrCreateFolder(
  bookTitle?: string,
): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported) return null;

  try {
    const parentHandle = await window.showDirectoryPicker({
      mode: 'readwrite',
    });

    if (bookTitle) {
      const folderName = `${sanitizeFolderName(bookTitle)}_SynKro`;
      try {
        const subHandle = await parentHandle.getDirectoryHandle(folderName, {
          create: true,
        });
        return subHandle;
      } catch {
        // If creating subfolder is not permitted, return the selected parent
        return parentHandle;
      }
    }
    return parentHandle;
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') return null;
    console.warn('[folderManager] showDirectoryPicker cancelled or failed:', err);
    return null;
  }
}

/**
 * Safe read-only permission check without user gesture/prompt.
 */
export async function queryPermissionOnly(
  handle: FileSystemDirectoryHandle,
  mode: FileSystemPermissionMode = 'readwrite',
): Promise<boolean> {
  try {
    return (await handle.queryPermission({ mode })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Verify and request readwrite permission for a stored directory handle.
 */
export async function verifyPermission(
  handle: FileSystemDirectoryHandle,
  mode: FileSystemPermissionMode = 'readwrite',
  allowPrompt = true,
): Promise<boolean> {
  try {
    const opts = { mode };
    // Check existing permission
    if ((await handle.queryPermission(opts)) === 'granted') {
      return true;
    }
    if (!allowPrompt) return false;
    // Request permission from user (requires user gesture)
    try {
      if ((await handle.requestPermission(opts)) === 'granted') {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  } catch (err) {
    console.warn('[folderManager] verifyPermission error:', err);
    return false;
  }
}

/**
 * Write `synkro-manifest.json` directly into the given folder handle.
 */
export async function saveManifestToFolder(
  handle: FileSystemDirectoryHandle,
  manifest: SynkroManifest,
): Promise<void> {
  try {
    const fileHandle = await handle.getFileHandle('synkro-manifest.json', { create: true });
    const writable = await fileHandle.createWritable();
    const jsonStr = JSON.stringify(manifest, null, 2);
    await writable.write(jsonStr);
    await writable.close();
  } catch (err) {
    console.warn('[folderManager] saveManifestToFolder error:', err);
  }
}

/**
 * Read and parse `synkro-manifest.json` from a directory handle.
 */
export async function readManifestFromFolder(
  handle: FileSystemDirectoryHandle,
): Promise<SynkroManifest | null> {
  try {
    const fileHandle = await handle.getFileHandle('synkro-manifest.json', { create: false });
    const file = await fileHandle.getFile();
    const text = await file.text();
    const parsed = JSON.parse(text) as SynkroManifest;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Copy an external File into the user's directory handle.
 */
export async function copyFileToFolder(
  handle: FileSystemDirectoryHandle,
  file: File,
  targetName?: string,
): Promise<void> {
  try {
    const name = targetName ?? file.name;
    const fileHandle = await handle.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(await file.arrayBuffer());
    await writable.close();
  } catch (err) {
    console.warn('[folderManager] copyFileToFolder error:', err);
  }
}

/**
 * Inspect a directory handle and extract audio, text, and manifest files.
 */
export async function loadBookFromDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  allowPrompt = true,
): Promise<{
  audioFile: File;
  textFile: File;
  manifest: SynkroManifest | null;
  handle: FileSystemDirectoryHandle;
} | null> {
  const hasPerm = await verifyPermission(handle, 'readwrite', allowPrompt);
  if (!hasPerm) return null;

  let audioFile: File | null = null;
  let textFile: File | null = null;
  let manifest: SynkroManifest | null = null;

  // First try reading manifest
  manifest = await readManifestFromFolder(handle);

  // Iterate over files in the directory
  // Note: values() on directory handle is an async iterator
  for await (const entry of handle.values()) {
    if (entry.kind === 'file') {
      const fHandle = entry as FileSystemFileHandle;
      if (entry.name === 'synkro-manifest.json') {
        if (!manifest) {
          const file = await fHandle.getFile();
          manifest = JSON.parse(await file.text()) as SynkroManifest;
        }
      } else if (!audioFile && isAudioFile(entry.name)) {
        // If manifest specifies an audio file name, match it if possible
        if (!manifest?.audioFileName || entry.name === manifest.audioFileName) {
          audioFile = await fHandle.getFile();
        }
      } else if (!textFile && isTextFile(entry.name)) {
        if (!manifest?.textFileName || entry.name === manifest.textFileName) {
          textFile = await fHandle.getFile();
        }
      }
    }
  }

  // Fallback scan if specific named file wasn't picked up
  if (!audioFile) {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && isAudioFile(entry.name)) {
        audioFile = await (entry as FileSystemFileHandle).getFile();
        break;
      }
    }
  }

  if (!textFile) {
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && isTextFile(entry.name)) {
        textFile = await (entry as FileSystemFileHandle).getFile();
        break;
      }
    }
  }

  if (!audioFile || !textFile) {
    return null;
  }

  return { audioFile, textFile, manifest, handle };
}

// ─── Universal WebkitDirectory Fallback ───────────────────────────────────────

/**
 * Extract audio, text, and manifest from a multiple/webkitdirectory FileList.
 */
export async function loadBookFromFiles(
  files: FileList | File[],
): Promise<{
  audioFile: File;
  textFile: File;
  manifest: SynkroManifest | null;
} | null> {
  const fileArray = Array.from(files);

  let audioFile: File | null = null;
  let textFile: File | null = null;
  let manifest: SynkroManifest | null = null;

  // Search for manifest
  const manifestFile = fileArray.find(
    (f) => f.name.toLowerCase() === 'synkro-manifest.json',
  );
  if (manifestFile) {
    try {
      manifest = JSON.parse(await manifestFile.text()) as SynkroManifest;
    } catch {
      // ignore JSON parse error
    }
  }

  // Search for audio file
  if (manifest?.audioFileName) {
    audioFile = fileArray.find((f) => f.name === manifest!.audioFileName) ?? null;
  }
  if (!audioFile) {
    audioFile = fileArray.find((f) => isAudioFile(f.name)) ?? null;
  }

  // Search for text file
  if (manifest?.textFileName) {
    textFile = fileArray.find((f) => f.name === manifest!.textFileName) ?? null;
  }
  if (!textFile) {
    textFile = fileArray.find((f) => isTextFile(f.name)) ?? null;
  }

  if (!audioFile || !textFile) return null;

  return { audioFile, textFile, manifest };
}

/**
 * Scans a chosen root library directory handle for all books (subfolders or root book).
 * Returns array of discovered BookMetadata.
 */
export async function scanLibraryDirectory(
  rootHandle: FileSystemDirectoryHandle,
  allowPrompt = false,
): Promise<BookMetadata[]> {
  const hasPerm = await verifyPermission(rootHandle, 'readwrite', allowPrompt);
  if (!hasPerm) return [];

  const books: BookMetadata[] = [];

  // Check if root itself is a book
  try {
    const rootBook = await loadBookFromDirectoryHandle(rootHandle, false);
    if (rootBook) {
      let cover = rootBook.manifest?.coverUrl;
      if (!cover && (rootBook.textFile.type === 'application/pdf' || rootBook.textFile.name.endsWith('.pdf'))) {
        cover = (await generatePdfCover(rootBook.textFile)) || undefined;
      }
      books.push({
        id: rootBook.manifest?.bookId || makeBookId(rootBook.audioFile, rootBook.textFile),
        title: rootBook.manifest?.title || rootBook.audioFile.name.replace(/\.[^.]+$/, ''),
        duration: rootBook.manifest?.duration || 0,
        totalChunks: rootBook.manifest?.totalChunks || 0,
        compiledChunks: rootBook.manifest ? Object.keys(rootBook.manifest.transcripts || {}).length : 0,
        lastPlayedTime: rootBook.manifest?.lastPlayedTime || 0,
        updatedAt: rootBook.manifest?.updatedAt || new Date().toISOString(),
        audioFileName: rootBook.manifest?.audioFileName || rootBook.audioFile.name,
        textFileName: rootBook.manifest?.textFileName || rootBook.textFile.name,
        syncOffsetMs: rootBook.manifest?.syncOffsetMs || 0,
        playbackRate: rootBook.manifest?.playbackRate || 1.0,
        dirHandle: rootHandle,
        coverUrl: cover,
        isCompileFullEnabled: rootBook.manifest?.isCompileFullEnabled,
      });
    }
  } catch {
    // root is not a single book, proceed to scan subdirectories
  }

  // Scan subdirectories
  for await (const entry of rootHandle.values()) {
    if (entry.kind === 'directory') {
      const subHandle = entry as FileSystemDirectoryHandle;
      try {
        const subBook = await loadBookFromDirectoryHandle(subHandle, false);
        if (subBook) {
          let cover = subBook.manifest?.coverUrl;
          if (!cover && (subBook.textFile.type === 'application/pdf' || subBook.textFile.name.endsWith('.pdf'))) {
            cover = (await generatePdfCover(subBook.textFile)) || undefined;
            if (cover && subBook.manifest) {
              subBook.manifest.coverUrl = cover;
              void saveManifestToFolder(subHandle, subBook.manifest);
            }
          }

          books.push({
            id: subBook.manifest?.bookId || makeBookId(subBook.audioFile, subBook.textFile),
            title: subBook.manifest?.title || subHandle.name.replace(/_SynKro$/i, '').replace(/_/g, ' '),
            duration: subBook.manifest?.duration || 0,
            totalChunks: subBook.manifest?.totalChunks || 0,
            compiledChunks: subBook.manifest ? Object.keys(subBook.manifest.transcripts || {}).length : 0,
            lastPlayedTime: subBook.manifest?.lastPlayedTime || 0,
            updatedAt: subBook.manifest?.updatedAt || new Date().toISOString(),
            audioFileName: subBook.manifest?.audioFileName || subBook.audioFile.name,
            textFileName: subBook.manifest?.textFileName || subBook.textFile.name,
            syncOffsetMs: subBook.manifest?.syncOffsetMs || 0,
            playbackRate: subBook.manifest?.playbackRate || 1.0,
            dirHandle: subHandle,
            coverUrl: cover,
            isCompileFullEnabled: subBook.manifest?.isCompileFullEnabled,
          });
        }
      } catch (err) {
        console.warn(`[folderManager] Error inspecting subfolder ${entry.name}:`, err);
      }
    }
  }

  return books;
}

export interface ScannedFolderBook {
  title: string;
  audioFile: File;
  textFile: File;
  manifest: SynkroManifest | null;
  coverUrl?: string;
}

/**
 * Scans a FileList from multiple/webkitdirectory selection and groups books by subfolder.
 */
export async function scanFilesForBooks(
  files: FileList | File[],
): Promise<ScannedFolderBook[]> {
  const fileArray = Array.from(files);
  const groups = new Map<string, File[]>();

  for (const file of fileArray) {
    // webkitRelativePath contains e.g. "Ready_Player_Two_SynKro/audio.mp3"
    const rel = (file as unknown as { webkitRelativePath?: string }).webkitRelativePath || '';
    const folder = rel.includes('/') ? rel.split('/')[0] : 'root';
    const list = groups.get(folder) || [];
    list.push(file);
    groups.set(folder, list);
  }

  const results: ScannedFolderBook[] = [];

  for (const [folderName, groupFiles] of groups.entries()) {
    const parsed = await loadBookFromFiles(groupFiles);
    if (parsed) {
      let cover = parsed.manifest?.coverUrl;
      if (!cover && (parsed.textFile.type === 'application/pdf' || parsed.textFile.name.endsWith('.pdf'))) {
        cover = (await generatePdfCover(parsed.textFile)) || undefined;
      }
      results.push({
        title:
          parsed.manifest?.title ||
          (folderName !== 'root'
            ? folderName.replace(/_SynKro$/i, '').replace(/_/g, ' ')
            : parsed.audioFile.name.replace(/\.[^.]+$/, '')),
        audioFile: parsed.audioFile,
        textFile: parsed.textFile,
        manifest: parsed.manifest,
        coverUrl: cover,
      });
    }
  }

  return results;
}

// ─── Portable Manifest Download Fallback ─────────────────────────────────────

/**
 * Triggers a browser download of `synkro-manifest.json` for manual portable backup.
 */
export function downloadManifestFile(manifest: SynkroManifest): void {
  const blob = new Blob([JSON.stringify(manifest, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'synkro-manifest.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Debounced Auto-Saver ───────────────────────────────────────────────────

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced manifest auto-save (executes 3 seconds after last trigger).
 */
export function scheduleManifestAutoSave(
  handle: FileSystemDirectoryHandle | undefined,
  manifestGetter: () => SynkroManifest,
): void {
  if (!handle) return;
  if (_saveTimer) clearTimeout(_saveTimer);

  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const manifest = manifestGetter();
    void saveManifestToFolder(handle, manifest);
  }, 3000);
}
