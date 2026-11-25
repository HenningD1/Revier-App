// Datenhaltung: IndexedDB auf dem Gerät.
//
// Grundidee (wichtig für den späteren OneDrive-Sync in Stufe 2):
//  * Jeder Datensatz hat eine weltweit eindeutige id (UUID), ein updatedAt (ms seit 1970)
//    und das Gerät, das ihn zuletzt geändert hat.
//  * Gelöscht wird nicht physisch, sondern per "Grabstein" (deleted: true). Nur so kann ein
//    anderes Gerät beim Abgleich erkennen, dass etwas gelöscht und nicht bloß noch nie
//    gesehen wurde.
//  * Zusammenführen zweier Datenstände = pro id gewinnt der jüngere updatedAt
//    ("last write wins"). Das ist für einen einzelnen Nutzer mit zwei Geräten ausreichend.

const DB_NAME = 'jagd-app';
const DB_VERSION = 1;
const STORE = 'items';

export const KINDS = ['revier', 'einrichtung', 'ereignis'];

let db = null;
const cache = new Map();          // id -> Datensatz (inkl. Grabsteine), für schnelles Lesen
const listeners = new Set();

// ---------------------------------------------------------------------------
// Reine Hilfsfunktionen (ohne Browser-APIs, daher in Node testbar)
// ---------------------------------------------------------------------------

export function uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback für ältere Browser
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Führt eingehende Datensätze mit dem lokalen Bestand zusammen.
 * @param {Map<string,object>} local  vorhandene Datensätze
 * @param {object[]} incoming          neue/fremde Datensätze
 * @returns {object[]} Datensätze, die lokal geschrieben werden müssen
 */
export function mergeRecords(local, incoming) {
  const toWrite = [];
  for (const rec of incoming) {
    if (!rec || !rec.id || !KINDS.includes(rec.kind)) continue;
    const mine = local.get(rec.id);
    if (!mine || (rec.updatedAt || 0) > (mine.updatedAt || 0)) {
      toWrite.push(rec);
    }
  }
  return toWrite;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        const os = d.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('kind', 'kind');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function writeMany(records) {
  if (!records.length) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const r of records) os.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  for (const r of records) cache.set(r.id, r);
}

export async function openStore() {
  db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const rows = await idbRequest(tx.objectStore(STORE).getAll());
  cache.clear();
  for (const r of rows) cache.set(r.id, r);
  // Den Browser bitten, unsere Daten nicht bei Speicherknappheit zu löschen
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch (_) { /* nicht kritisch */ }
  return cache.size;
}

export function getDeviceId() {
  let id = null;
  try { id = localStorage.getItem('jagd.deviceId'); } catch (_) { /* ignore */ }
  if (!id) {
    id = uuid();
    try { localStorage.setItem('jagd.deviceId', id); } catch (_) { /* ignore */ }
  }
  return id;
}

function emit(change) {
  for (const fn of listeners) {
    try { fn(change); } catch (e) { console.error(e); }
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Alle (nicht gelöschten) Datensätze einer Art */
export function all(kind, { includeDeleted = false } = {}) {
  const out = [];
  for (const r of cache.values()) {
    if (kind && r.kind !== kind) continue;
    if (!includeDeleted && r.deleted) continue;
    out.push(r);
  }
  return out;
}

export function get(id) {
  const r = cache.get(id);
  return r && !r.deleted ? r : null;
}

/** Legt an oder aktualisiert. Gibt den gespeicherten Datensatz zurück. */
export async function save(item) {
  if (!KINDS.includes(item.kind)) throw new Error('Unbekannte Art: ' + item.kind);
  const now = Date.now();
  const rec = {
    ...item,
    id: item.id || uuid(),
    createdAt: item.createdAt || now,
    updatedAt: now,
    device: getDeviceId(),
    deleted: false
  };
  await writeMany([rec]);
  emit({ type: 'save', record: rec });
  return rec;
}

/** Löscht per Grabstein (siehe Erklärung oben) */
export async function remove(id) {
  const r = cache.get(id);
  if (!r) return;
  const tomb = { id: r.id, kind: r.kind, deleted: true, createdAt: r.createdAt, updatedAt: Date.now(), device: getDeviceId() };
  await writeMany([tomb]);
  emit({ type: 'remove', record: tomb });
}

/**
 * Übernimmt fremde Datensätze (Import, später Sync).
 * Datensätze ohne id bekommen eine neue; Zeitstempel werden auf "jetzt" gesetzt,
 * damit ein Import nicht von älteren Ständen überstimmt wird.
 */
export async function importRecords(records, { keepTimestamps = true } = {}) {
  const now = Date.now();
  const prepared = records.map(r => {
    const rec = { ...r };
    if (!rec.id) rec.id = uuid();
    if (!rec.createdAt) rec.createdAt = now;
    if (!keepTimestamps || !rec.updatedAt) rec.updatedAt = now;
    if (!rec.device) rec.device = getDeviceId();
    rec.deleted = !!rec.deleted;
    return rec;
  });
  const toWrite = mergeRecords(cache, prepared);
  await writeMany(toWrite);
  emit({ type: 'import', count: toWrite.length });
  return toWrite.length;
}

/** Komplettes Abbild inkl. Grabsteinen (Grundlage für Backup und Sync) */
export function snapshot() {
  return Array.from(cache.values());
}

/** Löscht wirklich alles (nur über Einstellungen erreichbar) */
export async function wipeAll() {
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  cache.clear();
  emit({ type: 'wipe' });
}
