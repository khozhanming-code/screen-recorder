// IndexedDB persistence. Metadata and video blobs live in separate stores so that listing the
// library never loads every video into memory.

const DB_NAME = 'framecap';
const DB_VERSION = 1;
let dbPromise = null;

function toError(err) {
  const name = err && err.name;
  if (name === 'QuotaExceededError') {
    const e = new Error('The browser has no storage space left for this recording. Delete old recordings or download this one instead.');
    e.code = 'quota';
    return e;
  }
  if (name === 'InvalidStateError' || name === 'SecurityError') {
    return new Error('Browser storage is unavailable (private browsing or blocked site data). You can still download recordings.');
  }
  return new Error(`Storage error: ${(err && (err.message || err.name)) || 'unknown'}`);
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not supported in this browser.')); return; }
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(toError(err)); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(toError(req.error));
    req.onblocked = () => reject(new Error('Storage is blocked by another open tab. Close other FrameCap tabs and retry.'));
  }).catch((err) => { dbPromise = null; throw err; });
  return dbPromise;
}

/** Runs fn(tx) inside a transaction; resolves with the `.result` of the request fn returns. */
async function transact(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode); } catch (err) { reject(toError(err)); return; }
    let request = null;
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(toError(tx.error));
    tx.onabort = () => reject(toError(tx.error));
    try { request = fn(tx); } catch (err) { reject(toError(err)); try { tx.abort(); } catch { /* ignore */ } }
  });
}

export async function saveRecording({ title, createdAt, duration, size, mimeType, width, height, thumb, blob }) {
  return transact(['recordings', 'blobs'], 'readwrite', (tx) => {
    const metaReq = tx.objectStore('recordings').add({ title, createdAt, duration, size, mimeType, width, height, thumb: thumb || null });
    metaReq.onsuccess = () => tx.objectStore('blobs').put(blob, metaReq.result);
    return metaReq;
  });
}

export async function getAllRecordings() {
  const all = await transact('recordings', 'readonly', (tx) => tx.objectStore('recordings').getAll());
  return (all || []).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getBlob(id) {
  const blob = await transact('blobs', 'readonly', (tx) => tx.objectStore('blobs').get(id));
  if (!blob) throw new Error('This recording is missing from storage.');
  return blob;
}

export async function renameRecording(id, title) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    const store = tx.objectStore('recordings');
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      if (!getReq.result) { reject(new Error('Recording not found.')); return; }
      store.put({ ...getReq.result, title });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(toError(tx.error));
  });
}

export async function deleteRecording(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['recordings', 'blobs'], 'readwrite');
    tx.objectStore('recordings').delete(id);
    tx.objectStore('blobs').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(toError(tx.error));
  });
}

export async function countRecordings() {
  return transact('recordings', 'readonly', (tx) => tx.objectStore('recordings').count());
}

export async function estimateStorage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
