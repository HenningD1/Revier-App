// Import und Export: GeoJSON (Backup + Austausch), KML (Google Earth, Behörden),
// GPX (GPS-Geräte), CSV (Excel-Streckenliste).
// Reine Funktionen: Text rein -> Datensätze raus und umgekehrt.

import { EINRICHTUNG_TYPEN, EREIGNIS_TYPEN, REVIER_FARBEN } from './config.js';
import { closeRing, jagdjahr } from './geo.js';

const OWN_KINDS = ['revier', 'einrichtung', 'ereignis'];
// Importierte Reviere bekommen reihum unterschiedliche Farben
let colorIdx = 0;
const nextColor = () => REVIER_FARBEN[colorIdx++ % (REVIER_FARBEN.length - 1)]; // ohne Weiß

const typName = (list, id) => (list.find(t => t.id === id) || {}).name || id || '';

export const xmlEscape = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function recordGeometry(r) {
  if (r.kind === 'revier') return r.geometry || null;
  if (typeof r.lat === 'number' && typeof r.lng === 'number') return { type: 'Point', coordinates: [r.lng, r.lat] };
  return null;
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

export function toGeoJSON(records) {
  const features = records.filter(r => !r.deleted).map(r => {
    const { geometry, lat, lng, ...props } = r;
    return { type: 'Feature', id: r.id, geometry: recordGeometry(r), properties: props };
  });
  return {
    type: 'FeatureCollection',
    jagdApp: { schema: 1, exportedAt: new Date().toISOString() },
    features
  };
}

/** Liest eigene Backups und fremde GeoJSON-Dateien. Rückgabe: { records, skipped } */
export function fromGeoJSON(input) {
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  const features = obj.type === 'FeatureCollection' ? obj.features
    : obj.type === 'Feature' ? [obj]
    : [{ type: 'Feature', geometry: obj, properties: {} }];
  const records = [];
  let skipped = 0;
  for (const f of features) {
    const p = f.properties || {};
    const g = f.geometry;
    if (OWN_KINDS.includes(p.kind)) {
      // Eigenes Format: 1:1 wiederherstellen (inkl. id und Zeitstempel)
      const rec = { ...p };
      if (p.kind === 'revier') rec.geometry = g;
      else if (g && g.type === 'Point') { rec.lng = g.coordinates[0]; rec.lat = g.coordinates[1]; }
      records.push(rec);
      continue;
    }
    // Fremdformat: Flächen -> Reviere, Punkte -> Einrichtungen
    const name = p.name || p.Name || p.NAME || p.title || p.bezeichnung || '';
    if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon')) {
      records.push({ kind: 'revier', name: name || 'Importiertes Revier', color: nextColor(), notes: p.description || '', geometry: g });
    } else if (g && g.type === 'Point') {
      records.push({ kind: 'einrichtung', typ: 'sonstiges', name: name || 'Importierter Punkt', notes: p.description || '', lng: g.coordinates[0], lat: g.coordinates[1] });
    } else {
      skipped++;
    }
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// KML
// ---------------------------------------------------------------------------

const kmlCoords = ring => ring.map(([x, y]) => `${x.toFixed(7)},${y.toFixed(7)},0`).join(' ');
const kmlColor = hex => {
  // KML erwartet aabbggrr statt #rrggbb
  const h = (hex || '#ff0000').replace('#', '');
  return 'ff' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
};

function kmlPolygon(rings) {
  const [outer, ...holes] = rings;
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${kmlCoords(closeRing(outer))}</coordinates></LinearRing></outerBoundaryIs>` +
    holes.map(h => `<innerBoundaryIs><LinearRing><coordinates>${kmlCoords(closeRing(h))}</coordinates></LinearRing></innerBoundaryIs>`).join('') +
    '</Polygon>';
}

export function toKML(records, title = 'Jagd-App Export') {
  const live = records.filter(r => !r.deleted);
  const reviere = live.filter(r => r.kind === 'revier');
  const einr = live.filter(r => r.kind === 'einrichtung');
  const ereig = live.filter(r => r.kind === 'ereignis');

  const styles = reviere.map(r =>
    `<Style id="rv-${r.id}"><LineStyle><color>${kmlColor(r.color)}</color><width>3</width></LineStyle>` +
    `<PolyStyle><color>${'40' + kmlColor(r.color).slice(2)}</color></PolyStyle></Style>`).join('');

  const pmRevier = r => {
    const g = r.geometry;
    const geom = g.type === 'Polygon' ? kmlPolygon(g.coordinates)
      : `<MultiGeometry>${g.coordinates.map(kmlPolygon).join('')}</MultiGeometry>`;
    return `<Placemark><name>${xmlEscape(r.name)}</name><description>${xmlEscape(r.notes)}</description><styleUrl>#rv-${r.id}</styleUrl>${geom}</Placemark>`;
  };
  const pmPoint = (name, desc, r) =>
    `<Placemark><name>${xmlEscape(name)}</name><description>${xmlEscape(desc)}</description><Point><coordinates>${r.lng.toFixed(7)},${r.lat.toFixed(7)},0</coordinates></Point></Placemark>`;

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
    `<name>${xmlEscape(title)}</name>${styles}` +
    `<Folder><name>Reviere</name>${reviere.map(pmRevier).join('')}</Folder>` +
    `<Folder><name>Einrichtungen</name>${einr.map(r => pmPoint(r.name || typName(EINRICHTUNG_TYPEN, r.typ), [typName(EINRICHTUNG_TYPEN, r.typ), r.notes].filter(Boolean).join(' – '), r)).join('')}</Folder>` +
    `<Folder><name>Ereignisse</name>${ereig.map(r => pmPoint(
      `${typName(EREIGNIS_TYPEN, r.typ)} ${r.wildart || ''}`.trim(),
      [new Date(r.zeit).toLocaleString('de-DE'), r.anzahl ? r.anzahl + ' Stück' : '', r.notes].filter(Boolean).join(' – '), r)).join('')}</Folder>` +
    '</Document></kml>';
}

function parseCoordText(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).map(t => {
    const [x, y] = t.split(',').map(Number);
    return [x, y];
  }).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

const byTag = (el, tag) => Array.from(el.getElementsByTagNameNS('*', tag));
const firstText = (el, tag) => {
  const n = byTag(el, tag)[0];
  return n ? n.textContent.trim() : '';
};

export function fromKML(text, ParserImpl = globalThis.DOMParser) {
  const doc = new ParserImpl().parseFromString(text, 'application/xml');
  if (byTag(doc, 'parsererror').length) throw new Error('KML-Datei ist nicht lesbar');
  const records = [];
  let skipped = 0;
  for (const pm of byTag(doc, 'Placemark')) {
    const name = firstText(pm, 'name');
    const desc = firstText(pm, 'description');
    const polys = byTag(pm, 'Polygon').map(poly => {
      const outer = byTag(poly, 'outerBoundaryIs')[0];
      const rings = [];
      if (outer) rings.push(closeRing(parseCoordText(firstText(outer, 'coordinates'))));
      for (const inner of byTag(poly, 'innerBoundaryIs')) rings.push(closeRing(parseCoordText(firstText(inner, 'coordinates'))));
      return rings;
    }).filter(r => r.length && r[0].length >= 4);
    if (polys.length) {
      const geometry = polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
      records.push({ kind: 'revier', name: name || 'Importiertes Revier', color: nextColor(), notes: desc, geometry });
      continue;
    }
    const pt = byTag(pm, 'Point')[0];
    if (pt) {
      const c = parseCoordText(firstText(pt, 'coordinates'))[0];
      if (c) {
        records.push({ kind: 'einrichtung', typ: 'sonstiges', name: name || 'Importierter Punkt', notes: desc, lng: c[0], lat: c[1] });
        continue;
      }
    }
    skipped++;
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// GPX
// ---------------------------------------------------------------------------

export function toGPX(records) {
  const live = records.filter(r => !r.deleted);
  const wpt = live.filter(r => r.kind !== 'revier' && typeof r.lat === 'number').map(r => {
    const name = r.kind === 'einrichtung'
      ? (r.name || typName(EINRICHTUNG_TYPEN, r.typ))
      : `${typName(EREIGNIS_TYPEN, r.typ)} ${r.wildart || ''}`.trim();
    const time = r.kind === 'ereignis' && r.zeit ? `<time>${new Date(r.zeit).toISOString()}</time>` : '';
    return `<wpt lat="${r.lat.toFixed(7)}" lon="${r.lng.toFixed(7)}">${time}<name>${xmlEscape(name)}</name><desc>${xmlEscape(r.notes)}</desc></wpt>`;
  }).join('\n');
  const trk = live.filter(r => r.kind === 'revier').map(r => {
    const polys = r.geometry.type === 'Polygon' ? [r.geometry.coordinates] : r.geometry.coordinates;
    const segs = polys.map(p => `<trkseg>${closeRing(p[0]).map(([x, y]) => `<trkpt lat="${y.toFixed(7)}" lon="${x.toFixed(7)}"/>`).join('')}</trkseg>`).join('');
    return `<trk><name>${xmlEscape(r.name)}</name>${segs}</trk>`;
  }).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Jagd-App" xmlns="http://www.topografix.com/GPX/1/1">\n' + wpt + '\n' + trk + '\n</gpx>';
}

/**
 * GPX: Wegpunkte -> Einrichtungen. Geschlossene Tracks (Start ≈ Ende) -> Reviere,
 * z. B. wenn man die Reviergrenze mit einem GPS-Gerät abgelaufen ist.
 */
export function fromGPX(text, ParserImpl = globalThis.DOMParser) {
  const doc = new ParserImpl().parseFromString(text, 'application/xml');
  if (byTag(doc, 'parsererror').length) throw new Error('GPX-Datei ist nicht lesbar');
  const records = [];
  let skipped = 0;
  for (const w of byTag(doc, 'wpt')) {
    const lat = parseFloat(w.getAttribute('lat')), lng = parseFloat(w.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { skipped++; continue; }
    records.push({ kind: 'einrichtung', typ: 'sonstiges', name: firstText(w, 'name') || 'GPX-Punkt', notes: firstText(w, 'desc'), lat, lng });
  }
  for (const t of [...byTag(doc, 'trk'), ...byTag(doc, 'rte')]) {
    const pts = [...byTag(t, 'trkpt'), ...byTag(t, 'rtept')].map(p => [parseFloat(p.getAttribute('lon')), parseFloat(p.getAttribute('lat'))]);
    if (pts.length < 4) { skipped++; continue; }
    const [a, b] = [pts[0], pts[pts.length - 1]];
    // "geschlossen", wenn Start und Ende weniger als ca. 50 m auseinander liegen
    const dx = (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), dy = (a[1] - b[1]) * 110540;
    if (Math.hypot(dx, dy) > 50) { skipped++; continue; }
    records.push({ kind: 'revier', name: firstText(t, 'name') || 'GPX-Revier', color: nextColor(), notes: '', geometry: { type: 'Polygon', coordinates: [closeRing(pts)] } });
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// CSV (Streckenliste für Excel, deutsches Format: Semikolon, UTF-8 mit BOM)
// ---------------------------------------------------------------------------

export function toCSV(ereignisse, { revierName = () => '', einrichtungName = () => '' } = {}) {
  const head = ['Datum', 'Uhrzeit', 'Jagdjahr', 'Ereignis', 'Wildart', 'Anzahl', 'Geschlecht', 'Altersklasse', 'Gewicht (kg)', 'Revier', 'Einrichtung', 'Breite', 'Länge', 'Notiz'];
  const q = v => {
    const s = String(v ?? '');
    return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const num = v => (v === undefined || v === null || v === '') ? '' : String(v).replace('.', ',');
  const rows = ereignisse.filter(e => !e.deleted).sort((a, b) => a.zeit - b.zeit).map(e => {
    const d = new Date(e.zeit);
    return [
      d.toLocaleDateString('de-DE'), d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }), jagdjahr(d),
      typName(EREIGNIS_TYPEN, e.typ), e.wildart, e.anzahl, e.geschlecht, e.alter, num(e.gewicht),
      revierName(e.revierId), einrichtungName(e.einrichtungId),
      num(e.lat?.toFixed(6)), num(e.lng?.toFixed(6)), e.notes
    ].map(q).join(';');
  });
  return '﻿' + [head.join(';'), ...rows].join('\r\n');
}

/** Erkennt das Format anhand von Dateiname und Inhalt */
export function parseAny(filename, text, ParserImpl) {
  const name = (filename || '').toLowerCase();
  const t = text.trimStart();
  if (name.endsWith('.kml') || t.includes('<kml')) return fromKML(text, ParserImpl);
  if (name.endsWith('.gpx') || t.includes('<gpx')) return fromGPX(text, ParserImpl);
  if (name.endsWith('.json') || name.endsWith('.geojson') || t.startsWith('{')) return fromGeoJSON(text);
  throw new Error('Unbekanntes Dateiformat (erwartet: GeoJSON, KML oder GPX)');
}
