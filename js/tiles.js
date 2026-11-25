// Kachel-Mathematik (Web-Mercator, EPSG:3857) und Kachel-URLs.
//
// Wichtig für Offline-Pakete: Die Karte und der Vorab-Download müssen für dieselbe Kachel
// EXAKT dieselbe URL erzeugen, denn der Zwischenspeicher (Cache) findet Kacheln über die URL.
// Deshalb berechnet diese eine Funktion tileUrl() die URLs für beide Seiten.
// Keine Browser-APIs -> in Node testbar.

const R = 6378137;
const HALF = Math.PI * R;                      // halbe Weltbreite in Metern (20037508,34 m)

/** Anzahl Kacheln je Achse bei Zoom z und Kachelgröße tileSize (256 oder 512) */
export const tilesPerAxis = (z, tileSize = 256) => Math.pow(2, z) * 256 / tileSize;

export function lng2x(lng, z, tileSize = 256) {
  return Math.floor((lng + 180) / 360 * tilesPerAxis(z, tileSize));
}

export function lat2y(lat, z, tileSize = 256) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * tilesPerAxis(z, tileSize));
}

/** Kachelbereich, der ein Rechteck [[süd, west], [nord, ost]] abdeckt */
export function tileRange(bounds, z, tileSize = 256) {
  const [[s, w], [n, e]] = bounds;
  const max = tilesPerAxis(z, tileSize) - 1;
  const cl = v => Math.max(0, Math.min(max, v));
  return { x0: cl(lng2x(w, z, tileSize)), x1: cl(lng2x(e, z, tileSize)), y0: cl(lat2y(n, z, tileSize)), y1: cl(lat2y(s, z, tileSize)) };
}

export function countTiles(bounds, z, tileSize = 256) {
  const r = tileRange(bounds, z, tileSize);
  return (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
}

/** Begrenzungsrechteck einer Kachel in Metern (EPSG:3857) */
export function bbox3857(z, x, y, tileSize = 256) {
  const size = 2 * HALF / tilesPerAxis(z, tileSize);
  const minx = -HALF + x * size, maxy = HALF - y * size;
  return [minx, maxy - size, minx + size, maxy];
}

/** Schnittmenge zweier Rechtecke [[s,w],[n,e]] oder null */
export function intersect(a, b) {
  const s = Math.max(a[0][0], b[0][0]), w = Math.max(a[0][1], b[0][1]);
  const n = Math.min(a[1][0], b[1][0]), e = Math.min(a[1][1], b[1][1]);
  return (s < n && w < e) ? [[s, w], [n, e]] : null;
}

/** Rechteck um einen Puffer in Metern erweitern */
export function buffer(bounds, meters) {
  const [[s, w], [n, e]] = bounds;
  const dLat = meters / 111320, dLng = meters / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return [[s - dLat, w - dLng], [n + dLat, e + dLng]];
}

/** Begrenzungsrechteck einer GeoJSON-Geometrie (Polygon/MultiPolygon) */
export function geomBounds(g) {
  let s = 90, w = 180, n = -90, e = -180;
  const walk = c => {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); }
    else c.forEach(walk);
  };
  walk(g.coordinates);
  return [[s, w], [n, e]];
}

/** URL einer Kachel für eine Kartenquelle aus config.js */
export function tileUrl(cfg, z, x, y) {
  if (cfg.type === 'wms') {
    const ts = cfg.tileSize || 512;
    const b = bbox3857(z, x, y, ts).map(v => v.toFixed(2)).join(',');
    return `${cfg.url}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(cfg.layers)}&STYLES=` +
      `&FORMAT=${encodeURIComponent(cfg.format)}&TRANSPARENT=${cfg.transparent ? 'TRUE' : 'FALSE'}` +
      `&CRS=EPSG:3857&WIDTH=${ts}&HEIGHT=${ts}&BBOX=${b}`;
  }
  const subs = cfg.subdomains || 'abc';
  const s = subs[Math.abs(x + y) % subs.length];   // gleiche Auswahl wie Leaflet
  return cfg.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/**
 * Plan eines Offline-Pakets: alle Kacheln je Ebene und Zoomstufe.
 * @param bounds   Gebiet [[s,w],[n,e]]
 * @param layers   [{cfg, minZoom, maxZoom}]
 * @returns {{total:number, perLayer:object, *urls(): Generator<string>}}
 */
export function planPackage(bounds, layers) {
  const parts = [];
  for (const { cfg, minZoom, maxZoom } of layers) {
    const area = cfg.bounds ? intersect(bounds, cfg.bounds) : bounds;
    if (!area) continue;
    const ts = cfg.type === 'wms' ? (cfg.tileSize || 512) : 256;
    for (let z = minZoom; z <= maxZoom; z++) parts.push({ cfg, z, ts, area, n: countTiles(area, z, ts) });
  }
  const perLayer = {};
  for (const p of parts) perLayer[p.cfg.id] = (perLayer[p.cfg.id] || 0) + p.n;
  return {
    total: parts.reduce((a, p) => a + p.n, 0),
    perLayer,
    *urls() {
      for (const p of parts) {
        const r = tileRange(p.area, p.z, p.ts);
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield tileUrl(p.cfg, p.z, x, y);
      }
    }
  };
}
