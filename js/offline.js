// Offline-Pakete: Kacheln eines Gebiets vorab in einen eigenen Cache laden.
//
// Ablauf: planPackage() zählt die Kacheln -> Nutzer bestätigt -> download() holt sie mit
// wenigen parallelen Anfragen und legt sie im Cache "pkg-<id>" ab. Der Service Worker
// sucht beim Anzeigen jede Kachel zuerst in ALLEN Caches (caches.match) – dadurch erscheinen
// Paket-Kacheln automatisch, auch ohne Netz.
// Je Paket ein eigener Cache: Löschen eines Pakets = einen Cache löschen.

import { planPackage } from './tiles.js';
import { uuid } from './store.js';

const KEY = 'jagd.offlinePackages';

export function listPackages() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (_) { return []; }
}

function savePackages(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (_) { /* ignore */ }
}

/** Grobe Größenschätzung je Kachel (Erfahrungswerte) in Byte */
export function estimateBytes(cfg) {
  if (cfg.id === 'dop_nrw') return 70000;     // JPEG 512 px Luftbild
  if (cfg.type === 'wms') return 9000;        // PNG 512 px, meist transparent (Flurstücke)
  return 18000;                                // PNG 256 px Topokarte
}

export function estimate(bounds, layers) {
  const plan = planPackage(bounds, layers);
  let bytes = 0;
  for (const l of layers) bytes += (plan.perLayer[l.cfg.id] || 0) * estimateBytes(l.cfg);
  return { tiles: plan.total, bytes, perLayer: plan.perLayer, plan };
}

/**
 * Lädt ein Paket.
 * @param {object} opt  { name, bounds, layers:[{cfg,minZoom,maxZoom}], onProgress(done,total,failed), signal }
 * @returns Paket-Metadaten
 */
export async function download({ name, bounds, layers, onProgress = () => {}, signal }) {
  const { plan } = estimate(bounds, layers);
  const id = uuid();
  const cache = await caches.open('pkg-' + id);
  const meta = {
    id, name, bounds, date: Date.now(), tiles: 0, failed: 0, bytes: 0, opaque: 0,
    layers: layers.map(l => ({ id: l.cfg.id, name: l.cfg.name, minZoom: l.minZoom, maxZoom: l.maxZoom }))
  };
  const it = plan.urls();
  const total = plan.total;
  let done = 0;

  async function fetchOne(url) {
    try {
      let res;
      try {
        res = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // Server ohne CORS-Freigabe: als "undurchsichtige" Antwort speichern (Bild wird trotzdem angezeigt)
        res = await fetch(url, { mode: 'no-cors', credentials: 'omit', signal });
        meta.opaque++;
      }
      if (res.type !== 'opaque' && !res.ok) throw new Error('HTTP ' + res.status);
      if (res.type !== 'opaque') {
        const blob = await res.clone().blob();
        meta.bytes += blob.size;
      }
      await cache.put(url, res);
      meta.tiles++;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      meta.failed++;
    }
    done++;
    onProgress(done, total, meta.failed);
  }

  // 4 parallele "Arbeiter" – schonend für die öffentlichen Dienste
  const worker = async () => {
    for (let n = it.next(); !n.done; n = it.next()) {
      if (signal && signal.aborted) return;
      await fetchOne(n.value);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } catch (e) {
    if (!(signal && signal.aborted)) throw e;
  }
  if (signal && signal.aborted) {
    await caches.delete('pkg-' + id);
    throw new Error('Download abgebrochen');
  }
  const list = listPackages();
  list.push(meta);
  savePackages(list);
  return meta;
}

export async function deletePackage(id) {
  await caches.delete('pkg-' + id);
  savePackages(listPackages().filter(p => p.id !== id));
}
