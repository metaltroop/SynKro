/**
 * storage.ts
 * Zero-dependency typed IndexedDB wrapper for SynKro.
 *
 * Stores:
 *   - "transcripts" : ChunkTranscript keyed by `${bookId}::${chunkIndex}`
 *
 * Usage:
 *   await Storage.getTranscript(bookId, chunkIndex)
 *   await Storage.putTranscript(bookId, chunkIndex, transcript)
 *   await Storage.evictChunks(bookId, keepIndices)
 */

import type { ChunkTranscript, StorageMode, BookMetadata } from '../types';

const DB_NAME = 'synkro_v3';
const DB_VERSION = 2;
const STORE_TRANSCRIPTS = 'transcripts';
const STORE_BOOKS_META = 'books_meta';

// ─── Internal DB lifecycle ────────────────────────────────────────────────────

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);

  // Proactively delete old corrupted databases from earlier runs
  try {
    indexedDB.deleteDatabase('synkro_v1');
    indexedDB.deleteDatabase('synkro_v2');
  } catch {
    // Ignore in environments without indexedDB delete support
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TRANSCRIPTS)) {
        db.createObjectStore(STORE_TRANSCRIPTS); // key = `${bookId}::${chunkIndex}`
      }
      if (!db.objectStoreNames.contains(STORE_BOOKS_META)) {
        db.createObjectStore(STORE_BOOKS_META, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function txn(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(storeName, mode).objectStore(storeName);
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

function transcriptKey(bookId: string, chunkIndex: number): string {
  return `${bookId}::${chunkIndex}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const Storage = {
  /** Retrieve a stored transcript, or null if not cached. */
  async getTranscript(
    bookId: string,
    chunkIndex: number,
  ): Promise<ChunkTranscript | null> {
    try {
      const db = await openDB();
      const result = await promisifyRequest<ChunkTranscript | undefined>(
        txn(db, STORE_TRANSCRIPTS, 'readonly').get(transcriptKey(bookId, chunkIndex)),
      );
      return result ?? null;
    } catch {
      return null;
    }
  },

  /** Persist a transcript. */
  async putTranscript(
    bookId: string,
    chunkIndex: number,
    transcript: ChunkTranscript,
  ): Promise<void> {
    try {
      const db = await openDB();
      await promisifyRequest(
        txn(db, STORE_TRANSCRIPTS, 'readwrite').put(
          transcript,
          transcriptKey(bookId, chunkIndex),
        ),
      );
    } catch (err) {
      console.warn('[Storage] putTranscript failed:', err);
    }
  },

  /**
   * Evict all chunks for a book EXCEPT those whose indices are in `keepIndices`.
   * Used by SMART and LITE_MODE strategies.
   */
  async evictChunks(bookId: string, keepIndices: Set<number>): Promise<void> {
    try {
      const db = await openDB();
      const store = db
        .transaction(STORE_TRANSCRIPTS, 'readwrite')
        .objectStore(STORE_TRANSCRIPTS);

      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          const key = cursor.key as string;
          if (key.startsWith(`${bookId}::`)) {
            const idx = parseInt(key.split('::')[1], 10);
            if (!keepIndices.has(idx)) cursor.delete();
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[Storage] evictChunks failed:', err);
    }
  },

  /**
   * Delete all transcripts for a book (called when loading a new book).
   */
  async clearBook(bookId: string): Promise<void> {
    try {
      const db = await openDB();
      const store = db
        .transaction(STORE_TRANSCRIPTS, 'readwrite')
        .objectStore(STORE_TRANSCRIPTS);

      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          if ((cursor.key as string).startsWith(`${bookId}::`)) cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[Storage] clearBook failed:', err);
    }
  },

  /**
   * Compute which chunks to keep in memory/storage based on StorageMode.
   */
  keepWindowIndices(
    currentChunk: number,
    totalChunks: number,
    mode: StorageMode,
  ): Set<number> {
    const keep = new Set<number>();
    if (mode === 'KEEP_ALL') {
      for (let i = 0; i < totalChunks; i++) keep.add(i);
    } else if (mode === 'SMART') {
      // Keep a sliding window of 5 chunks (prev 2 + current + next 2)
      for (let i = Math.max(0, currentChunk - 2); i <= Math.min(totalChunks - 1, currentChunk + 2); i++) {
        keep.add(i);
      }
    } else {
      // LITE_MODE: only prev + current + next
      for (let i = Math.max(0, currentChunk - 1); i <= Math.min(totalChunks - 1, currentChunk + 1); i++) {
        keep.add(i);
      }
    }
    return keep;
  },

  // ─── v2 Book Metadata & Resume Hub ─────────────────────────────────────────

  async saveBookMeta(meta: BookMetadata): Promise<void> {
    try {
      const db = await openDB();
      await promisifyRequest(
        txn(db, STORE_BOOKS_META, 'readwrite').put(meta),
      );
    } catch (err) {
      console.warn('[Storage] saveBookMeta failed:', err);
    }
  },

  async getBookMeta(id: string): Promise<BookMetadata | null> {
    try {
      const db = await openDB();
      const res = await promisifyRequest<BookMetadata | undefined>(
        txn(db, STORE_BOOKS_META, 'readonly').get(id),
      );
      return res ?? null;
    } catch {
      return null;
    }
  },

  async getAllBooksMeta(): Promise<BookMetadata[]> {
    try {
      const db = await openDB();
      const res = await promisifyRequest<BookMetadata[]>(
        txn(db, STORE_BOOKS_META, 'readonly').getAll(),
      );
      return res || [];
    } catch {
      return [];
    }
  },

  async deleteBookMeta(id: string): Promise<void> {
    try {
      const db = await openDB();
      await promisifyRequest(
        txn(db, STORE_BOOKS_META, 'readwrite').delete(id),
      );
    } catch (err) {
      console.warn('[Storage] deleteBookMeta failed:', err);
    }
  },

  // ─── Root Library Folder Storage ──────────────────────────────────────────

  async saveRootFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    try {
      const db = await openDB();
      await promisifyRequest(
        txn(db, STORE_BOOKS_META, 'readwrite').put({
          id: '__synkro_root_library__',
          title: 'SynKro Root Library',
          duration: 0,
          totalChunks: 0,
          compiledChunks: 0,
          lastPlayedTime: 0,
          updatedAt: new Date().toISOString(),
          dirHandle: handle,
        } as BookMetadata),
      );
    } catch (err) {
      console.warn('[Storage] saveRootFolderHandle failed:', err);
    }
  },

  async getRootFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
    try {
      const db = await openDB();
      const res = await promisifyRequest<BookMetadata | undefined>(
        txn(db, STORE_BOOKS_META, 'readonly').get('__synkro_root_library__'),
      );
      return res?.dirHandle ?? null;
    } catch {
      return null;
    }
  },

  async clearRootFolderHandle(): Promise<void> {
    try {
      const db = await openDB();
      await promisifyRequest(
        txn(db, STORE_BOOKS_META, 'readwrite').delete('__synkro_root_library__'),
      );
    } catch (err) {
      console.warn('[Storage] clearRootFolderHandle failed:', err);
    }
  },

  // ─── Last Active Book Session ─────────────────────────────────────────────

  getLastActiveBookId(): string | null {
    try {
      return localStorage.getItem('synkro_last_active_book');
    } catch {
      return null;
    }
  },

  setLastActiveBookId(bookId: string): void {
    try {
      localStorage.setItem('synkro_last_active_book', bookId);
    } catch (err) {
      console.warn('[Storage] setLastActiveBookId failed:', err);
    }
  },

  clearLastActiveBookId(): void {
    try {
      localStorage.removeItem('synkro_last_active_book');
    } catch {
      // ignore
    }
  },

  /** Retrieve all cached transcripts for a book (used when generating portable synkro-manifest.json). */
  async getAllTranscripts(bookId: string): Promise<Record<number, ChunkTranscript>> {
    const result: Record<number, ChunkTranscript> = {};
    try {
      const db = await openDB();
      const store = db.transaction(STORE_TRANSCRIPTS, 'readonly').objectStore(STORE_TRANSCRIPTS);
      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          const key = cursor.key as string;
          if (key.startsWith(`${bookId}::`)) {
            const idx = parseInt(key.split('::')[1], 10);
            result[idx] = cursor.value as ChunkTranscript;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    } catch (err) {
      console.warn('[Storage] getAllTranscripts failed:', err);
    }
    return result;
  },

  /** Bulk persist transcripts (used when importing an existing SynKro folder). */
  async putAllTranscripts(
    bookId: string,
    transcripts: Record<number, ChunkTranscript>,
  ): Promise<void> {
    try {
      const db = await openDB();
      const tx = db.transaction(STORE_TRANSCRIPTS, 'readwrite');
      const store = tx.objectStore(STORE_TRANSCRIPTS);
      for (const [idxStr, tr] of Object.entries(transcripts)) {
        store.put(tr, transcriptKey(bookId, parseInt(idxStr, 10)));
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[Storage] putAllTranscripts failed:', err);
    }
  },
};
