// Zentrale Konfiguration: Kartenquellen, Typen, Farben.
// Alles, was man später anpassen möchte, steht hier – nicht verstreut im Code.

export const APP_VERSION = '0.3.0';

// Startansicht, falls noch keine gespeicherte Ansicht existiert (ungefähr Mitte NRW)
export const DEFAULT_VIEW = { lat: 51.47, lng: 7.55, zoom: 8 };

// Grobe Grenzen von NRW (EPSG:4326) – die NRW-Dienste liefern außerhalb nur leere Kacheln
export const NRW_BOUNDS = [[50.30, 5.85], [52.55, 9.50]];

// ---------------------------------------------------------------------------
// Grundkarten (genau eine aktiv). type: 'xyz' = Kachel-URL, 'wms' = WMS-Dienst
// ---------------------------------------------------------------------------
export const BASE_LAYERS = [
  {
    id: 'basemap',
    name: 'Topo Deutschland (basemap.de)',
    type: 'xyz',
    url: 'https://sgx.geodatenzentrum.de/wmts_basemapde/tile/1.0.0/de_basemapde_web_raster_farbe/default/GLOBAL_WEBMERCATOR/{z}/{y}/{x}.png',
    maxNativeZoom: 18,
    offline: { minZoom: 10, maxZoom: 17 },   // für Offline-Pakete (Lizenz CC BY 4.0 erlaubt Speichern)
    attribution: '© <a href="https://basemap.de" target="_blank">GeoBasis-DE / BKG</a> (CC BY 4.0)'
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    type: 'xyz',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap-Mitwirkende</a>'
  },
  {
    id: 'otm',
    name: 'OpenTopoMap (Höhenlinien)',
    type: 'xyz',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxNativeZoom: 17,
    attribution: 'Kartendaten: © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap-Mitwirkende</a>, SRTM | Darstellung: © <a href="https://opentopomap.org" target="_blank">OpenTopoMap</a> (CC-BY-SA)'
  },
  {
    id: 'dop_nrw',
    name: 'Luftbild NRW (DOP 20 cm)',
    type: 'wms',
    url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
    layers: 'nw_dop_rgb',
    format: 'image/jpeg',
    transparent: false,
    tileSize: 512,
    maxNativeZoom: 20,
    offline: { minZoom: 13, maxZoom: 19 },   // z19 ≈ 0,2 m/Pixel = volle DOP-Auflösung
    bounds: NRW_BOUNDS,
    attribution: 'Luftbild: <a href="https://www.bezreg-koeln.nrw.de/geobasis-nrw" target="_blank">Geobasis NRW</a> (dl-de/zero-2-0)'
  }
];

// ---------------------------------------------------------------------------
// Fachliche Overlays aus amtlichen Diensten (mehrere gleichzeitig möglich)
// ---------------------------------------------------------------------------
export const OVERLAY_LAYERS = [
  {
    id: 'alkis_nrw',
    name: 'Flurstücke NRW (ab Zoom 16)',
    type: 'wms',
    url: 'https://www.wms.nrw.de/geobasis/wms_nw_alkis',
    layers: 'adv_alkis_flurstuecke',
    format: 'image/png',
    transparent: true,
    minZoom: 16, // Der Dienst zeichnet Flurstücke erst ab ca. 1:5.500
    tileSize: 512,
    maxNativeZoom: 20,
    offline: { minZoom: 16, maxZoom: 18 },
    bounds: NRW_BOUNDS,
    attribution: 'Flurstücke: Geobasis NRW (dl-de/zero-2-0)'
  }
];

// ---------------------------------------------------------------------------
// Einrichtungen im Revier. glyph = kurzer Text im Kartensymbol
// ---------------------------------------------------------------------------
export const EINRICHTUNG_TYPEN = [
  { id: 'hochsitz',     name: 'Hochsitz (offen)',   glyph: 'H',  color: '#7a4a1f' },
  { id: 'kanzel',       name: 'Kanzel (geschlossen)', glyph: 'K', color: '#5b3412' },
  { id: 'drueckjagdbock', name: 'Drückjagdbock',   glyph: 'D',  color: '#b0601e' },
  { id: 'bodensitz',    name: 'Bodensitz / Schirm', glyph: 'B',  color: '#8c7a3c' },
  { id: 'kirrung',      name: 'Kirrung',            glyph: 'Ki', color: '#c08a00' },
  { id: 'salzlecke',    name: 'Salzlecke',          glyph: 'S',  color: '#7f8c8d' },
  { id: 'suhle',        name: 'Suhle',              glyph: 'Su', color: '#6d4c41' },
  { id: 'fuetterung',   name: 'Fütterung',          glyph: 'F',  color: '#a0522d' },
  { id: 'wildacker',    name: 'Wildacker',          glyph: 'WA', color: '#2e7d32' },
  { id: 'wildkamera',   name: 'Wildkamera',         glyph: 'C',  color: '#37474f' },
  { id: 'falle',        name: 'Falle',              glyph: 'Fa', color: '#6a1b9a' },
  { id: 'parkplatz',    name: 'Parkplatz / Anfahrt', glyph: 'P', color: '#1565c0' },
  { id: 'sonstiges',    name: 'Sonstiges',          glyph: '•',  color: '#455a64' }
];

// ---------------------------------------------------------------------------
// Ereignisse (Sichtungen, Abschüsse, ...)
// ---------------------------------------------------------------------------
export const EREIGNIS_TYPEN = [
  { id: 'sichtung',   name: 'Sichtung',    color: '#1e88e5' },
  { id: 'abschuss',   name: 'Abschuss',    color: '#c62828' },
  { id: 'fehlschuss', name: 'Fehlschuss / Nachsuche', color: '#ef6c00' },
  { id: 'fallwild',   name: 'Fallwild',    color: '#6d4c41' },
  { id: 'wildunfall', name: 'Wildunfall',  color: '#8e24aa' },
  { id: 'wildschaden', name: 'Wildschaden', color: '#f9a825' },
  { id: 'spur',       name: 'Fährte / Spur / Losung', color: '#00897b' },
  { id: 'sonstiges',  name: 'Sonstiges',   color: '#546e7a' }
];

export const WILDARTEN = [
  'Rehwild', 'Schwarzwild', 'Rotwild', 'Damwild', 'Sikawild', 'Muffelwild', 'Gamswild',
  'Fuchs', 'Dachs', 'Waschbär', 'Marderhund', 'Steinmarder', 'Baummarder', 'Iltis',
  'Feldhase', 'Wildkaninchen', 'Fasan', 'Rebhuhn', 'Ringeltaube',
  'Wildgans', 'Stockente', 'Rabenkrähe', 'Elster', 'Nutria', 'Wolf', 'Sonstige'
];

export const GESCHLECHT = ['unbekannt', 'männlich', 'weiblich', 'gemischt'];

export const ALTERSKLASSEN = ['unbekannt', 'Jungtier / Kitz / Frischling', 'Jährling / Überläufer', 'mittelalt', 'alt'];

// Farben, die beim Anlegen eines Reviers zur Wahl stehen
export const REVIER_FARBEN = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#8e24aa', '#ffffff'];

// Offline-Paket: Puffer um ein Revier in Metern, Warnschwelle für die Kachelzahl
export const OFFLINE_BUFFER_M = 300;
export const OFFLINE_WARN_TILES = 4000;
export const OFFLINE_MAX_TILES = 25000;

// Übersichtskarte NRW für unterwegs (nur Topokarte, grob)
export const NRW_OVERVIEW = { minZoom: 6, maxZoom: 12 };

// Kachel-Cache im Service Worker (angesehene Kacheln für Offline-Nutzung)
export const TILE_CACHE_MAX_ENTRIES = 6000;
