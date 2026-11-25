// Geometrie-Hilfen. Alle Koordinaten im GeoJSON-Format: [lng, lat] in Grad (WGS84).
// Keine Browser-APIs -> in Node testbar.

const R = 6378137; // Erdradius (WGS84-Äquator) in m, wie in Leaflet/Web-Mercator
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

/**
 * Fläche eines Rings in m² auf der Kugel.
 * Formel nach Chamberlain & Duquette (2007), dieselbe wie in Leaflet.draw / OpenLayers:
 *   A = |Σ (λ2 - λ1) · (2 + sin φ1 + sin φ2)| · R² / 2
 * Für Revierflächen (wenige km²) ist der Fehler gegenüber dem Ellipsoid < 0,5 %.
 */
export function ringArea(ring) {
  let sum = 0;
  const n = ring.length;
  if (n < 3) return 0;
  for (let i = 0; i < n; i++) {
    const [lng1, lat1] = ring[i];
    const [lng2, lat2] = ring[(i + 1) % n];
    sum += toRad(lng2 - lng1) * (2 + Math.sin(toRad(lat1)) + Math.sin(toRad(lat2)));
  }
  return Math.abs(sum * R * R / 2);
}

/** Fläche eines Polygon/MultiPolygon in m² (Löcher werden abgezogen) */
export function geometryArea(geom) {
  if (!geom) return 0;
  const polyArea = rings => rings.reduce((a, ring, i) => a + (i === 0 ? 1 : -1) * ringArea(ring), 0);
  if (geom.type === 'Polygon') return polyArea(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.reduce((a, p) => a + polyArea(p), 0);
  return 0;
}

/** Strahlverfahren (ray casting): liegt Punkt [lng,lat] im Ring? */
export function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInGeometry(pt, geom) {
  if (!geom) return false;
  const inPoly = rings => pointInRing(pt, rings[0]) && !rings.slice(1).some(h => pointInRing(pt, h));
  if (geom.type === 'Polygon') return inPoly(geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(inPoly);
  return false;
}

/** Großkreis-Entfernung (Haversine) in m zwischen {lat,lng}-Objekten */
export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Anfangskurs von a nach b in Grad (0 = Nord, im Uhrzeigersinn) */
export function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassName(deg) {
  return DIRS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

export function formatDistance(m) {
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' km';
}

export function formatArea(m2) {
  const ha = m2 / 10000;
  return ha.toLocaleString('de-DE', { maximumFractionDigits: ha < 10 ? 2 : 1 }) + ' ha';
}

/** Schließt einen Ring (erster Punkt = letzter Punkt), wie GeoJSON es verlangt */
export function closeRing(ring) {
  if (!ring.length) return ring;
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return (a[0] === b[0] && a[1] === b[1]) ? ring : [...ring, [a[0], a[1]]];
}

/** Ring ohne doppelten Schlusspunkt (für die Bearbeitung) */
export function openRing(ring) {
  if (ring.length > 1) {
    const [a, b] = [ring[0], ring[ring.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring;
}

/** Findet das Revier, in dem ein Punkt liegt (erstes Treffer-Revier) */
export function findRevier(pt, reviere) {
  for (const r of reviere) {
    if (pointInGeometry(pt, r.geometry)) return r;
  }
  return null;
}

/** Hilfsfunktion: Jagdjahr (1. April bis 31. März) zu einem Datum, z. B. "2026/27" */
export function jagdjahr(date) {
  const d = new Date(date);
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; // Monat 3 = April
  return `${y}/${String((y + 1) % 100).padStart(2, '0')}`;
}

export function jagdjahrRange(label) {
  const y = parseInt(label.slice(0, 4), 10);
  return { from: new Date(y, 3, 1, 0, 0, 0).getTime(), to: new Date(y + 1, 3, 1, 0, 0, 0).getTime() };
}
