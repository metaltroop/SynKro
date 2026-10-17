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

import type { ChunkTranscript, StorageMode } from '../types';

const DB_NAME = 'synkro_v3';
const DB_VERSION = 1;
const STORE_TRANSCRIPTS = 'transcripts';

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
};
