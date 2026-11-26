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
const DB_VERSION = 2;          // 2: zusätzlich Versionsverlauf
const STORE = 'items';
const VSTORE = 'versions';
export const MAX_VERSIONS = 30;

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

/** Kurzer Fingerabdruck eines Datenstands (gleiche Einträge in gleicher Version = gleicher Wert) */
export function signature(records) {
  const str = records.filter(r => !r.deleted).map(r => r.id + ':' + (r.updatedAt || 0)).sort().join('|');
  let h = 2166136261;                     // FNV-1a, 32 bit
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16) + '-' + str.length;
}

export function countKinds(records) {
  const c = { revier: 0, einrichtung: 0, ereignis: 0 };
  for (const r of records) if (!r.deleted && c[r.kind] !== undefined) c[r.kind]++;
  return c;
}

/**
 * Plant eine Wiederherstellung: Zielstand = lebende Einträge der Version.
 * Alle Ziel-Einträge bekommen einen frischen Zeitstempel, alles andere wird zum Grabstein.
 * So "gewinnt" der wiederhergestellte Stand auch beim nächsten Abgleich mit anderen Geräten
 * (dort ist er dann der jüngste).
 */
export function planRestore(current, target, now, device) {
  const want = new Map(target.filter(r => r && !r.deleted && KINDS.includes(r.kind)).map(r => [r.id, r]));
  const writes = [];
  for (const r of want.values()) writes.push({ ...r, updatedAt: now, device, deleted: false });
  for (const r of current) {
    if (!r.deleted && !want.has(r.id)) {
      writes.push({ id: r.id, kind: r.kind, deleted: true, createdAt: r.createdAt, updatedAt: now, device });
    }
  }
  return writes;
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
      if (!d.objectStoreNames.contains(VSTORE)) d.createObjectStore(VSTORE, { keyPath: 'id' });
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
  // Bevor fremde Daten etwas ändern: aktuellen Stand im Versionsverlauf sichern
  if (toWrite.length) await saveVersion('vor Import/Abgleich');
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
  await saveVersion('vor „Alle Daten löschen“', { force: true });   // der Verlauf bleibt erhalten
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  cache.clear();
  emit({ type: 'wipe' });
}

// ---------------------------------------------------------------------------
// Versionsverlauf: vollständige Kopien des Datenstands auf diesem Gerät
// ---------------------------------------------------------------------------

function vTx(mode) { return db.transaction(VSTORE, mode).objectStore(VSTORE); }

/** neueste zuerst */
export async function listVersions() {
  const rows = await idbRequest(vTx('readonly').getAll());
  return rows.sort((a, b) => b.time - a.time);
}

export async function getVersion(id) {
  return idbRequest(vTx('readonly').get(id));
}

/**
 * Sichert den aktuellen Stand. Unverändert seit der letzten Version -> nichts zu tun (außer force).
 * Ältere Versionen über MAX_VERSIONS hinaus werden gelöscht.
 */
export async function saveVersion(reason, { force = false } = {}) {
  const records = all(null);
  if (!records.length && !force) return null;
  const sig = signature(records);
  const list = await listVersions();
  if (!force && list[0] && list[0].sig === sig) return null;
  const now = Date.now();
  const v = { id: now, time: now, reason, sig, counts: countKinds(records), records: JSON.parse(JSON.stringify(records)) };
  await idbRequest(vTx('readwrite').put(v));
  for (const old of list.slice(MAX_VERSIONS - 1)) await idbRequest(vTx('readwrite').delete(old.id));
  return v;
}

/** Stellt exakt den Stand einer Version (oder Datei) wieder her; vorher wird der jetzige Stand gesichert. */
export async function restoreState(records) {
  await saveVersion('vor Wiederherstellung', { force: true });
  const writes = planRestore(Array.from(cache.values()), records, Date.now(), getDeviceId());
  await writeMany(writes);
  emit({ type: 'restore', count: writes.length });
  return countKinds(records);
}
