// Hauptprogramm: verbindet Karte, Datenhaltung, Formulare und Listen.
/* global L */

import * as store from './store.js';
import {
  APP_VERSION, DEFAULT_VIEW, BASE_LAYERS, OVERLAY_LAYERS, EINRICHTUNG_TYPEN, EREIGNIS_TYPEN,
  WILDARTEN, GESCHLECHT, ALTERSKLASSEN, REVIER_FARBEN, NRW_BOUNDS, NRW_OVERVIEW,
  OFFLINE_BUFFER_M, OFFLINE_WARN_TILES, OFFLINE_MAX_TILES, ONEDRIVE_CLIENT_ID
} from './config.js';
import {
  geometryArea, formatArea, findRevier, distance, bearing, compassName, formatDistance,
  jagdjahr, jagdjahrRange, openRing, pointInGeometry
} from './geo.js';
import { toGeoJSON, toKML, toGPX, toCSV, parseAny, toSyncFile, toShareFile } from './io.js';
import { PolygonEditor } from './draw.js';
import { Positioning } from './gps.js';
import { buildDial } from './compass.js';
import { einrSvg, animalSvg } from './icons.js';
import { tileUrl, geomBounds, buffer } from './tiles.js';
import * as offline from './offline.js';
import { OneDrive, syncOnce, redirectUri, AuthError, FILE_NAME } from './sync.js';
import {
  $, esc, toast, openForm, confirmDialog, sheet, deliverFile, fmtDateTime, toLocalInput, options, measureIosGap
} from './ui.js';

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------

const state = {
  mode: 'normal',            // 'normal' | 'draw' | 'place'
  drawRevierId: null,        // id des Reviers, dessen Grenze bearbeitet wird (null = neu)
  placeCb: null,             // Callback für den Platzier-Modus (Fadenkreuz)
  follow: false,             // Karte folgt der GPS-Position
  tab: 'map',
  filter: { jj: jagdjahr(Date.now()), revierId: '', typ: '', wildart: '' }
};

let map, editor, pos, dial;
const cloud = new OneDrive({ clientId: ONEDRIVE_CLIENT_ID || undefined });
const syncState = { running: false, timer: 0, last: +(localStorage.getItem('jagd.sync.last') || 0), error: '' };
const layers = { reviere: null, einr: null, ereig: null, me: null, acc: null };
const prefs = loadPrefs();

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('jagd.prefs')) || {}; } catch (_) { return {}; }
}
function savePrefs() {
  try { localStorage.setItem('jagd.prefs', JSON.stringify(prefs)); } catch (_) { /* privat-Modus */ }
}

const typEinr = id => EINRICHTUNG_TYPEN.find(t => t.id === id) || EINRICHTUNG_TYPEN[EINRICHTUNG_TYPEN.length - 1];
const typEv = id => EREIGNIS_TYPEN.find(t => t.id === id) || EREIGNIS_TYPEN[EREIGNIS_TYPEN.length - 1];
const reviere = () => store.all('revier');
// kleine runde Symbole für Listen und Popups
const miniEinr = e => `<span class="mini" style="--c:${typEinr(e.typ).color}">${einrSvg(typEinr(e.typ).id)}</span>`;
const miniEv = v => `<span class="mini" style="--c:${typEv(v.typ).color}">${animalSvg(v.wildart) || ''}</span>`;
const revierOf = p => (typeof p.lat === 'number' ? findRevier([p.lng, p.lat], reviere()) : null);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

let screenInfo = null;
function applyIosGap() {
  screenInfo = measureIosGap();
  const had = document.documentElement.classList.contains('ios-gap');
  document.documentElement.classList.toggle('ios-gap', screenInfo.gap > 0);
  if (map && had !== screenInfo.gap > 0) map.invalidateSize();   // Leistenhöhe hat sich geändert
}

// iOS-Fehler: Fenster bleibt (meist nach der Tastatur) um ~60 px zu kurz. Ein kurzes Aus- und Einblenden
// eines fensterhohen Elements mit erzwungener Neuberechnung dazwischen bringt WebKit dazu, die echte
// Höhe neu zu übernehmen. Danach wird neu gemessen; klappt es nicht, bleibt die sichere Anordnung.
function healViewport() {
  if (!measureIosGap().gap) return applyIosGap();
  const b = document.body;
  b.style.display = 'none';
  void b.offsetHeight;   // erzwungene Neuberechnung, ohne dazwischen zu zeichnen
  b.style.display = '';
  setTimeout(() => { applyIosGap(); if (map) map.invalidateSize(); }, 250);
}

async function init() {
  if (typeof L === 'undefined') {
    document.body.innerHTML = '<p style="padding:2em">Die Kartenbibliothek konnte nicht geladen werden. Beim ersten Start wird eine Internetverbindung benötigt.</p>';
    return;
  }
  await store.openStore();
  applyIosGap();
  initMap();
  ['resize', 'orientationchange'].forEach(ev => window.addEventListener(ev, () => setTimeout(applyIosGap, 300)));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(healViewport, 300); });
  // nach dem Schließen der Tastatur (Eingabefeld verlassen) den iOS-Fehler gleich wieder beheben
  document.addEventListener('focusout', e => { if (e.target.matches('input, textarea, select')) setTimeout(healViewport, 200); });
  setTimeout(healViewport, 600);
  editor = new PolygonEditor(map, { onChange: updateDrawbar });
  pos = new Positioning({ onPosition, onError: e => toast(e.message, { ms: 6000 }), onHeading });
  dial = buildDial($('#compass-dial'));
  bindUi();
  renderAll();
  store.onChange(ch => {
    renderAll();
    if (!syncState.running && ch.type !== 'wipe') scheduleSync(15000);   // eigene Änderung -> bald hochladen
    if (ch.type === 'save') ensureDailyVersion();
  });
  registerServiceWorker();
  initSync();
  ensureDailyVersion();
}

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

// Eigene Kachel-Ebene: die URL jeder Kachel kommt aus tileUrl() (js/tiles.js).
// Dieselbe Funktion erzeugt die URLs für Offline-Pakete – nur so findet der Cache sie wieder.
let UrlTileLayer = null;

function makeLayer(cfg) {
  if (!UrlTileLayer) {
    UrlTileLayer = L.TileLayer.extend({
      getTileUrl(coords) { return tileUrl(this.options.cfg, coords.z, coords.x, coords.y); }
    });
  }
  const opts = {
    cfg,
    attribution: cfg.attribution,
    maxZoom: 21,
    maxNativeZoom: cfg.maxNativeZoom || 19,
    minZoom: cfg.minZoom || 0,
    tileSize: cfg.type === 'wms' ? (cfg.tileSize || 512) : 256   // 512er-Kacheln halbieren die WMS-Anfragen
  };
  if (cfg.bounds) opts.bounds = L.latLngBounds(cfg.bounds);
  const layer = new UrlTileLayer(cfg.url, opts);
  layer.cfgId = cfg.id;
  return layer;
}

function initMap() {
  const v = prefs.view || DEFAULT_VIEW;
  map = L.map('map', { zoomControl: false, center: [v.lat, v.lng], zoom: v.zoom, maxZoom: 21 });
  L.control.zoom({ position: 'bottomleft' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank">Leaflet</a>');

  const baseMaps = {};
  let activeBase = null;
  for (const cfg of BASE_LAYERS) {
    const l = makeLayer(cfg);
    baseMaps[cfg.name] = l;
    if (cfg.id === (prefs.base || BASE_LAYERS[0].id)) activeBase = l;
  }
  (activeBase || Object.values(baseMaps)[0]).addTo(map);

  layers.reviere = L.featureGroup();
  layers.einr = L.featureGroup();
  layers.ereig = L.featureGroup();
  layers.reviere.cfgId = 'reviere';
  layers.einr.cfgId = 'einrichtungen';
  layers.ereig.cfgId = 'ereignisse';

  const overlayPrefs = prefs.overlays || {};
  const overlays = {};
  for (const cfg of OVERLAY_LAYERS) {
    const l = makeLayer(cfg);
    overlays[cfg.name] = l;
    if (overlayPrefs[cfg.id]) l.addTo(map);
  }
  overlays['Reviere'] = layers.reviere;
  overlays['Einrichtungen'] = layers.einr;
  overlays['Ereignisse (gefiltert)'] = layers.ereig;
  for (const l of [layers.reviere, layers.einr, layers.ereig]) {
    if (overlayPrefs[l.cfgId] !== false) l.addTo(map);
  }

  L.control.layers(baseMaps, overlays, { position: 'topright', collapsed: true }).addTo(map);

  map.on('baselayerchange', e => { prefs.base = e.layer.cfgId; savePrefs(); });
  map.on('overlayadd overlayremove', e => {
    prefs.overlays = prefs.overlays || {};
    prefs.overlays[e.layer.cfgId] = e.type === 'overlayadd';
    savePrefs();
    if (e.type === 'overlayadd' && e.layer.options && e.layer.options.minZoom > map.getZoom()) {
      toast(`Diese Ebene erscheint erst ab Zoomstufe ${e.layer.options.minZoom} (jetzt ${map.getZoom()}).`);
    }
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    prefs.view = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6), zoom: map.getZoom() };
    savePrefs();
  });
  // Wer die Karte selbst verschiebt, will nicht mehr automatisch zur Position springen
  map.on('dragstart', () => { if (state.follow) { state.follow = false; updateLocateButton(); } });

  // Langes Drücken (iPhone) bzw. Rechtsklick (PC): Schnellmenü an dieser Stelle
  map.on('contextmenu', e => {
    if (state.mode !== 'normal') return;
    const { lat, lng } = e.latlng;
    const r = findRevier([lng, lat], reviere());
    L.popup().setLatLng(e.latlng).setContent(`
      <div class="pop">
        <div class="pop-sub">${lat.toFixed(5)}, ${lng.toFixed(5)}${r ? ' · ' + esc(r.name) : ''}</div>
        <div class="pop-btns">
          <button class="btn sm" data-act="add-ei-at" data-lat="${lat}" data-lng="${lng}">+ Einrichtung</button>
          <button class="btn sm" data-act="add-ev-at" data-lat="${lat}" data-lng="${lng}">+ Ereignis</button>
          <button class="btn sm" data-act="add-rv">+ Revier zeichnen</button>
        </div>
      </div>`).openOn(map);
  });
}

// ---------------------------------------------------------------------------
// Darstellung der eigenen Daten
// ---------------------------------------------------------------------------

function renderAll() {
  renderReviere();
  renderEinrichtungen();
  renderEreignisse();
  updateStatus();
  if (sheet.isOpen) renderTab(state.tab);
}

function geomToLatLngs(g) {
  const ll = ring => ring.map(([x, y]) => [y, x]);
  return g.type === 'Polygon' ? g.coordinates.map(ll) : g.coordinates.map(p => p.map(ll));
}

function renderReviere() {
  layers.reviere.clearLayers();
  for (const r of reviere()) {
    if (!r.geometry) continue;
    if (state.mode === 'draw' && state.drawRevierId === r.id) continue; // wird gerade bearbeitet
    const poly = L.polygon(geomToLatLngs(r.geometry), {
      color: r.color, weight: 3, fillColor: r.color, fillOpacity: 0.08, bubblingMouseEvents: true
    });
    poly.on('click', e => {
      if (state.mode !== 'normal') return; // im Zeichenmodus erreicht der Klick die Karte
      L.popup().setLatLng(e.latlng).setContent(revierPopup(r, e.latlng)).openOn(map);
    });
    poly.bindTooltip(esc(r.name), { permanent: true, direction: 'center', className: 'rv-label' });
    poly.addTo(layers.reviere);
  }
}

function einrIcon(e) {
  const t = typEinr(e.typ);
  const dir = Number.isFinite(e.blick) ? `<i class="dir" style="transform:rotate(${e.blick}deg)"></i>` : '';
  return L.divIcon({
    className: 'pin-wrap',
    html: `${dir}<div class="pin" style="--c:${t.color}">${einrSvg(t.id)}</div>`,
    iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -14]
  });
}

function ereigIcon(ev) {
  const t = typEv(ev.typ);
  const inner = animalSvg(ev.wildart) || `<span>${esc((ev.wildart || '?').slice(0, 2))}</span>`;
  return L.divIcon({
    className: 'ev-wrap',
    html: `<div class="ev ev-${esc(ev.typ)}" style="--c:${t.color}">${inner}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -13]
  });
}

/** Marker-Klick: im Zeichenmodus wird der Punkt als Eckpunkt übernommen ("einrasten") */
function markerClick(marker, popupFn) {
  marker.on('click', () => {
    if (state.mode === 'draw') { editor.addVertex(marker.getLatLng()); return; }
    if (state.mode !== 'normal') return;
    L.popup({ offset: [0, -12] }).setLatLng(marker.getLatLng()).setContent(popupFn()).openOn(map);
  });
}

function renderEinrichtungen() {
  layers.einr.clearLayers();
  for (const e of store.all('einrichtung')) {
    const m = L.marker([e.lat, e.lng], { icon: einrIcon(e), title: e.name || typEinr(e.typ).name });
    m.recordId = e.id;
    markerClick(m, () => einrPopup(e));
    m.addTo(layers.einr);
  }
}

function renderEreignisse() {
  layers.ereig.clearLayers();
  for (const ev of filteredEreignisse()) {
    const m = L.marker([ev.lat, ev.lng], { icon: ereigIcon(ev), zIndexOffset: -100 });
    m.recordId = ev.id;
    markerClick(m, () => ereigPopup(ev));
    m.addTo(layers.ereig);
  }
}

// ---------------------------------------------------------------------------
// Popups
// ---------------------------------------------------------------------------

function distanceLine(p) {
  if (!pos || !pos.last) return '';
  const d = distance(pos.last, p);
  const b = bearing(pos.last, p);
  return `<div class="pop-sub">Von mir: ${formatDistance(d)} Richtung ${compassName(b)} (${Math.round(b)}°)</div>`;
}

function revierPopup(r, at) {
  const nE = store.all('einrichtung').filter(e => revierOf(e)?.id === r.id).length;
  const range = jagdjahrRange(jagdjahr(Date.now()));
  const nV = store.all('ereignis').filter(v => v.zeit >= range.from && v.zeit < range.to && revierOf(v)?.id === r.id).length;
  return `<div class="pop">
    <div class="pop-title"><span class="swatch" style="background:${esc(r.color)}"></span>${esc(r.name)}</div>
    <div class="pop-sub">${formatArea(geometryArea(r.geometry))} · ${nE} Einrichtungen · ${nV} Ereignisse im Jagdjahr</div>
    ${r.notes ? `<div class="pop-notes">${esc(r.notes)}</div>` : ''}
    <div class="pop-btns">
      <button class="btn sm" data-act="add-ev-at" data-lat="${at.lat}" data-lng="${at.lng}">+ Ereignis hier</button>
      <button class="btn sm" data-act="add-ei-at" data-lat="${at.lat}" data-lng="${at.lng}">+ Einrichtung hier</button>
      <button class="btn sm" data-act="rv-edit" data-id="${r.id}">Bearbeiten</button>
      <button class="btn sm" data-act="rv-share" data-id="${r.id}">Teilen</button>
      <button class="btn sm" data-act="rv-geom" data-id="${r.id}">Grenze ändern</button>
      <button class="btn sm" data-act="rv-offline" data-id="${r.id}">Offline speichern</button>
      <button class="btn sm danger" data-act="rv-del" data-id="${r.id}">Löschen</button>
    </div></div>`;
}

function einrPopup(e) {
  const t = typEinr(e.typ);
  const r = revierOf(e);
  const count = store.all('ereignis').filter(v => v.einrichtungId === e.id).length;
  return `<div class="pop">
    <div class="pop-title">${miniEinr(e)}${esc(e.name || t.name)}</div>
    <div class="pop-sub">${esc(t.name)}${r ? ' · ' + esc(r.name) : ''}${Number.isFinite(e.blick) ? ` · Blick ${compassName(e.blick)} (${e.blick}°)` : ''}</div>
    ${distanceLine(e)}
    ${count ? `<div class="pop-sub">${count} Ereignis(se) von hier erfasst</div>` : ''}
    ${e.notes ? `<div class="pop-notes">${esc(e.notes)}</div>` : ''}
    <div class="pop-btns">
      <button class="btn sm primary" data-act="ei-ev" data-id="${e.id}">+ Ereignis von hier</button>
      <button class="btn sm" data-act="ei-edit" data-id="${e.id}">Bearbeiten</button>
      <button class="btn sm" data-act="ei-move" data-id="${e.id}">Verschieben</button>
      <button class="btn sm" data-act="route" data-lat="${e.lat}" data-lng="${e.lng}">Route</button>
      <button class="btn sm danger" data-act="ei-del" data-id="${e.id}">Löschen</button>
    </div></div>`;
}

function ereigPopup(v) {
  const t = typEv(v.typ);
  const r = revierOf(v);
  const ei = v.einrichtungId ? store.get(v.einrichtungId) : null;
  const details = [
    v.anzahl > 1 ? v.anzahl + ' Stück' : '',
    v.geschlecht && v.geschlecht !== 'unbekannt' ? v.geschlecht : '',
    v.alter && v.alter !== 'unbekannt' ? v.alter : '',
    v.gewicht ? String(v.gewicht).replace('.', ',') + ' kg' : ''
  ].filter(Boolean).join(' · ');
  return `<div class="pop">
    <div class="pop-title">${miniEv(v)}${esc(t.name)}: ${esc(v.wildart || '')}</div>
    <div class="pop-sub">${fmtDateTime(v.zeit)}${r ? ' · ' + esc(r.name) : ''}</div>
    ${details ? `<div class="pop-sub">${esc(details)}</div>` : ''}
    ${ei ? `<div class="pop-sub">Von: ${esc(ei.name || typEinr(ei.typ).name)}</div>` : ''}
    ${distanceLine(v)}
    ${v.notes ? `<div class="pop-notes">${esc(v.notes)}</div>` : ''}
    <div class="pop-btns">
      <button class="btn sm" data-act="ev-edit" data-id="${v.id}">Bearbeiten</button>
      <button class="btn sm" data-act="ev-move" data-id="${v.id}">Verschieben</button>
      <button class="btn sm danger" data-act="ev-del" data-id="${v.id}">Löschen</button>
    </div></div>`;
}

// ---------------------------------------------------------------------------
// Formulare
// ---------------------------------------------------------------------------

function revierForm(r = {}, geometry = null) {
  const color = r.color || REVIER_FARBEN[reviere().length % REVIER_FARBEN.length];
  return openForm({
    title: r.id ? 'Revier bearbeiten' : 'Neues Revier',
    body: `
      <label>Name<input name="name" required value="${esc(r.name || '')}" placeholder="z. B. Eigenjagd Musterdorf"></label>
      <fieldset class="swatches"><legend>Farbe</legend>
        ${REVIER_FARBEN.map(c => `<label><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}><span style="background:${c}"></span></label>`).join('')}
      </fieldset>
      <label>Notizen<textarea name="notes" rows="3">${esc(r.notes || '')}</textarea></label>
      ${geometry || r.geometry ? `<p class="hint">Fläche: ${formatArea(geometryArea(geometry || r.geometry))}</p>` : ''}`,
    onSubmit: async d => {
      await store.save({ ...r, kind: 'revier', name: d.name.trim(), color: d.color || color, notes: d.notes, geometry: geometry || r.geometry });
      toast('Revier gespeichert');
    }
  });
}

function einrForm(e) {
  const r = revierOf(e);
  return openForm({
    title: e.id ? 'Einrichtung bearbeiten' : 'Neue Einrichtung',
    body: `
      <label>Art<select name="typ">${options(EINRICHTUNG_TYPEN, e.typ || 'hochsitz')}</select></label>
      <label>Name / Nummer<input name="name" value="${esc(e.name || '')}" placeholder="z. B. Kanzel Eichenkamp, Nr. 7"></label>
      <label>Blickrichtung in Grad (optional)
        <span class="row"><input name="blick" type="number" inputmode="numeric" min="0" max="359" value="${Number.isFinite(e.blick) ? e.blick : ''}" placeholder="0 = Nord, 90 = Ost">
        <button type="button" class="btn sm" data-fill-heading>Kompass übernehmen</button></span>
      </label>
      <label>Notizen<textarea name="notes" rows="3" placeholder="Zustand, Leiter, Schlüssel, ...">${esc(e.notes || '')}</textarea></label>
      <p class="hint">${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}${r ? ' · Revier: ' + esc(r.name) : ' · außerhalb eingezeichneter Reviere'}</p>`,
    onOpen: form => {
      form.querySelector('[data-fill-heading]').onclick = async () => {
        if (!pos.compassActive) await pos.startCompass();
        updateCompassButton();
        setTimeout(() => {
          if (pos.heading === null) { toast('Kein Kompasswert verfügbar'); return; }
          form.elements.blick.value = Math.round(pos.heading) % 360;
        }, 400);
      };
    },
    danger: e.id ? { label: 'Löschen', onClick: () => deleteRecord(e.id) } : null,
    onSubmit: async d => {
      const blick = d.blick === '' ? null : ((parseInt(d.blick, 10) % 360) + 360) % 360;
      await store.save({ ...e, kind: 'einrichtung', typ: d.typ, name: d.name.trim(), blick: Number.isFinite(blick) ? blick : null, notes: d.notes });
      toast('Einrichtung gespeichert');
    }
  });
}

function ereigForm(v) {
  // Einrichtungen in der Nähe zur Auswahl anbieten (nächste zuerst)
  const near = store.all('einrichtung')
    .map(e => ({ e, d: distance(e, v) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 20);
  const r = revierOf(v);
  return openForm({
    title: v.id ? 'Ereignis bearbeiten' : 'Neues Ereignis',
    body: `
      <div class="grid2">
        <label>Ereignis<select name="typ">${options(EREIGNIS_TYPEN, v.typ || 'sichtung')}</select></label>
        <label>Wildart<select name="wildart">${options(WILDARTEN, v.wildart || prefs.lastWildart || 'Rehwild')}</select></label>
        <label>Anzahl<input name="anzahl" type="number" inputmode="numeric" min="1" value="${v.anzahl || 1}"></label>
        <label>Gewicht kg (aufgebr.)<input name="gewicht" type="text" inputmode="decimal" value="${esc(v.gewicht ?? '')}" placeholder="optional"></label>
        <label>Geschlecht<select name="geschlecht">${options(GESCHLECHT, v.geschlecht || 'unbekannt')}</select></label>
        <label>Altersklasse<select name="alter">${options(ALTERSKLASSEN, v.alter || 'unbekannt')}</select></label>
      </div>
      <label>Datum und Uhrzeit<input name="zeit" type="datetime-local" required value="${toLocalInput(v.zeit || Date.now())}"></label>
      <label>Beobachtet von (Einrichtung)<select name="einrichtungId">
        <option value="">– keine –</option>
        ${near.map(({ e, d }) => `<option value="${e.id}"${e.id === v.einrichtungId ? ' selected' : ''}>${esc(e.name || typEinr(e.typ).name)} (${formatDistance(d)})</option>`).join('')}
      </select></label>
      <label>Notizen<textarea name="notes" rows="3" placeholder="Verhalten, Wetter, Wind, ...">${esc(v.notes || '')}</textarea></label>
      <p class="hint">${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}${r ? ' · Revier: ' + esc(r.name) : ''}</p>`,
    danger: v.id ? { label: 'Löschen', onClick: () => deleteRecord(v.id) } : null,
    onSubmit: async d => {
      const zeit = new Date(d.zeit).getTime();
      if (!Number.isFinite(zeit)) throw new Error('Ungültiges Datum');
      const gewicht = d.gewicht.trim() === '' ? null : parseFloat(d.gewicht.replace(',', '.'));
      prefs.lastWildart = d.wildart; savePrefs();
      await store.save({
        ...v, kind: 'ereignis', typ: d.typ, wildart: d.wildart,
        anzahl: Math.max(1, parseInt(d.anzahl, 10) || 1),
        gewicht: Number.isFinite(gewicht) ? gewicht : null,
        geschlecht: d.geschlecht, alter: d.alter, zeit,
        einrichtungId: d.einrichtungId || null, notes: d.notes
      });
      // Damit das neue Ereignis sichtbar ist, Filter ggf. auf dessen Jagdjahr stellen
      if (state.filter.jj !== 'alle' && state.filter.jj !== jagdjahr(zeit)) { state.filter.jj = jagdjahr(zeit); renderAll(); }
      toast('Ereignis gespeichert');
    }
  });
}

async function deleteRecord(id) {
  const r = store.get(id);
  if (!r) return false;
  const label = r.kind === 'revier' ? `Revier „${r.name}“` : r.kind === 'einrichtung' ? `Einrichtung „${r.name || typEinr(r.typ).name}“` : 'dieses Ereignis';
  if (!(await confirmDialog('Löschen?', `Soll ${label} wirklich gelöscht werden?`, 'Löschen'))) return false;
  await store.remove(id);
  map.closePopup();
  toast('Gelöscht');
  return true;
}

// ---------------------------------------------------------------------------
// Modi: Zeichnen (Reviergrenze) und Platzieren (Fadenkreuz)
// ---------------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-draw', mode === 'draw');
  document.body.classList.toggle('mode-place', mode === 'place');
  $('#drawbar').hidden = mode !== 'draw';
  $('#placebar').hidden = mode !== 'place';
  $('#crosshair').hidden = mode !== 'place';
  map.closePopup();
  if (mode !== 'normal') sheet.close();
}

function startDraw(revierId = null) {
  const r = revierId ? store.get(revierId) : null;
  state.drawRevierId = revierId;
  setMode('draw');
  renderReviere(); // bearbeitetes Revier ausblenden
  let ring = null;
  if (r) {
    if (r.geometry.type !== 'Polygon') {
      toast('Mehrteilige Reviere (MultiPolygon) können noch nicht bearbeitet werden.', { ms: 5000 });
      endDraw();
      return;
    }
    ring = openRing(r.geometry.coordinates[0]);
    map.fitBounds(L.latLngBounds(ring.map(([x, y]) => [y, x])), { padding: [40, 40] });
  }
  editor.start(ring, r ? r.color : '#e53935');
  $('#draw-hint').textContent = r
    ? 'Punkte ziehen, Mitte einer Kante antippen = neuer Punkt'
    : 'Auf die Karte tippen, um Eckpunkte zu setzen';
}

function endDraw() {
  editor.stop();
  state.drawRevierId = null;
  setMode('normal');
  renderReviere();
}

async function finishDraw() {
  const ring = editor.result();
  if (!ring) { toast('Mindestens 3 Punkte nötig'); return; }
  const id = state.drawRevierId;
  if (id) {
    const r = store.get(id);
    const holes = r.geometry.coordinates.slice(1); // vorhandene Löcher beibehalten
    endDraw();
    await store.save({ ...r, geometry: { type: 'Polygon', coordinates: [ring, ...holes] } });
    toast('Grenze gespeichert');
  } else {
    const geometry = { type: 'Polygon', coordinates: [ring] };
    const saved = await revierForm({}, geometry);
    if (saved) endDraw(); // bei "Abbrechen" bleibt man im Zeichenmodus
  }
}

function updateDrawbar({ count, selected }) {
  $('#draw-count').textContent = `${count} Punkt${count === 1 ? '' : 'e'}`;
  $('#draw-del').disabled = selected < 0;
  $('#draw-undo').disabled = count === 0;
  $('#draw-done').disabled = count < 3;
}

function startPlace(label, cb) {
  state.placeCb = cb;
  $('#place-label').textContent = label;
  $('#place-me').disabled = !(pos && pos.last);
  setMode('place');
}

function endPlace() {
  state.placeCb = null;
  setMode('normal');
}

function placeAt(latlng) {
  const cb = state.placeCb;
  endPlace();
  if (cb) cb({ lat: latlng.lat, lng: latlng.lng });
}

// ---------------------------------------------------------------------------
// GPS und Kompass
// ---------------------------------------------------------------------------

function onPosition(p) {
  const ll = [p.lat, p.lng];
  if (!layers.me) {
    layers.acc = L.circle(ll, { radius: p.accuracy, weight: 1, color: '#1976d2', fillOpacity: 0.1, interactive: false }).addTo(map);
    layers.me = L.marker(ll, {
      icon: L.divIcon({ className: 'me-wrap', html: '<div class="me"><div class="cone"></div><div class="dot"></div></div>', iconSize: [60, 60], iconAnchor: [30, 30] }),
      interactive: false, zIndexOffset: 2000, keyboard: false
    }).addTo(map);
    if (state.follow) map.setView(ll, p.accuracy > COARSE_M ? 13 : Math.max(map.getZoom(), 16));
  } else {
    layers.me.setLatLng(ll);
    layers.acc.setLatLng(ll).setRadius(p.accuracy);
    // erst grob, jetzt genau: einmal heranzoomen
    if (state.follow && state.lastAcc > COARSE_M && p.accuracy <= COARSE_M) map.setView(ll, Math.max(map.getZoom(), 16));
    else if (state.follow) map.panTo(ll, { animate: true });
  }
  state.lastAcc = p.accuracy;
  layers.me.getElement && layers.me.getElement() && layers.me.getElement().classList.toggle('coarse', p.accuracy > COARSE_M);
  // Ohne Kompass: Bewegungsrichtung aus dem GPS anzeigen (nur bei Bewegung sinnvoll)
  if (!pos.compassActive) setCone(p.speed > 0.7 && Number.isFinite(p.heading) ? p.heading : null);
  $('#place-me').disabled = false;
  updateStatus();
}

function setCone(h) {
  const el = layers.me && layers.me.getElement && layers.me.getElement();
  if (!el) return;
  const cone = el.querySelector('.cone');
  if (h === null || h === undefined) { cone.style.display = 'none'; return; }
  cone.style.display = 'block';
  cone.style.transform = `rotate(${h}deg)`;
}

function onHeading(h) {
  dial.update(h);
  setCone(h);
}

function toggleLocate() {
  if (!pos.gpsActive) {
    state.follow = true;
    pos.startGPS();
    if (pos.last) map.setView([pos.last.lat, pos.last.lng], Math.max(map.getZoom(), 16));
  } else if (!state.follow) {
    state.follow = true;
    if (pos.last) map.setView([pos.last.lat, pos.last.lng], Math.max(map.getZoom(), 16));
  } else {
    // dritter Tipp: GPS aus (spart Akku)
    pos.stopGPS();
    state.follow = false;
    if (layers.me) { layers.me.remove(); layers.acc.remove(); layers.me = layers.acc = null; }
    pos.last = null;
    state.lastAcc = null;
    coarseHintShown = false;
  }
  updateLocateButton();
  updateStatus();
}

async function toggleCompass() {
  if (pos.compassActive) pos.stopCompass();
  else await pos.startCompass();
  updateCompassButton();
}

function updateLocateButton() {
  const b = $('#btn-locate');
  b.classList.toggle('on', pos.gpsActive);
  b.classList.toggle('follow', pos.gpsActive && state.follow);
  b.title = !pos.gpsActive ? 'GPS einschalten' : state.follow ? 'GPS ausschalten' : 'Auf meine Position zentrieren';
}

function updateCompassButton() {
  $('#btn-compass').classList.toggle('on', pos.compassActive);
}

// Ab dieser Ungenauigkeit ist es keine GPS-Position mehr, sondern eine grobe Schätzung
const COARSE_M = 500;
let coarseHintShown = false;

function accText(a) {
  return a >= 1000 ? `±${(a / 1000).toFixed(1).replace('.', ',')} km` : `±${Math.round(a)} m`;
}

function coarseHint() {
  if (coarseHintShown) return;
  coarseHintShown = true;
  toast(`Sehr ungenaue Position (${accText(pos.last.accuracy)}). Auf dem iPhone: Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Safari-Websites → „Beim Verwenden“ und „Genauer Standort“ einschalten. Danach GPS-Knopf aus- und wieder einschalten.`, { ms: 15000 });
}

function updateStatus() {
  const parts = [];
  if (pos && pos.gpsActive) {
    if (pos.last) {
      const coarse = pos.last.accuracy > COARSE_M;
      parts.push(coarse ? `<b class="warn">⚠ ungenau ${accText(pos.last.accuracy)}</b>` : `GPS ${accText(pos.last.accuracy)}`);
      if (coarse) coarseHint();
      const r = revierOf(pos.last);
      parts.push(r ? `Im Revier: ${esc(r.name)}` : 'außerhalb der Reviere');
    } else {
      parts.push('GPS: suche Position …');
    }
  }
  if (!navigator.onLine) parts.push('<b>offline</b>');
  const bar = $('#statusbar');
  bar.innerHTML = parts.join(' · ');
  bar.hidden = parts.length === 0;
}

// ---------------------------------------------------------------------------
// Listen (Bottom-Sheet)
// ---------------------------------------------------------------------------

function filteredEreignisse() {
  const f = state.filter;
  const range = f.jj !== 'alle' ? jagdjahrRange(f.jj) : null;
  return store.all('ereignis').filter(e =>
    (!range || (e.zeit >= range.from && e.zeit < range.to)) &&
    (!f.typ || e.typ === f.typ) &&
    (!f.wildart || e.wildart === f.wildart) &&
    (!f.revierId || (revierOf(e)?.id || '') === f.revierId)
  ).sort((a, b) => b.zeit - a.zeit);
}

function openTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'map') { sheet.close(); return; }
  renderTab(tab);
}

function renderTab(tab) {
  if (tab === 'reviere') sheet.open('Reviere', reviereTab());
  else if (tab === 'ereignisse') sheet.open('Ereignisse', ereignisseTab());
  else if (tab === 'mehr') { sheet.open('Daten & Einstellungen', mehrTab()); fillStorageInfo(); fillVersions(); }
}

function reviereTab() {
  const list = reviere().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const einr = store.all('einrichtung');
  const items = list.map(r => {
    const nE = einr.filter(e => revierOf(e)?.id === r.id).length;
    return `<li class="card" data-act="rv-zoom" data-id="${r.id}">
      <span class="swatch" style="background:${esc(r.color)}"></span>
      <div class="card-main"><b>${esc(r.name)}</b><small>${formatArea(geometryArea(r.geometry))} · ${nE} Einrichtungen</small></div>
      <button class="btn sm" data-act="rv-share" data-id="${r.id}">Teilen</button>
      <button class="btn sm" data-act="rv-edit" data-id="${r.id}">Bearbeiten</button></li>`;
  }).join('');
  return `<div class="sheet-actions"><button class="btn primary" data-act="add-rv">+ Revier zeichnen</button>
      <button class="btn" data-act="import">Importieren (KML/GPX/GeoJSON)</button></div>
    ${list.length ? `<ul class="cards">${items}</ul>` : '<p class="empty">Noch keine Reviere. Zeichne eines ein oder importiere eine KML-/GPX-Datei.</p>'}
    ${einr.length ? `<h3>Einrichtungen (${einr.length})</h3><ul class="cards">${einr
      .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de'))
      .map(e => `<li class="card" data-act="ei-zoom" data-id="${e.id}">${miniEinr(e)}
        <div class="card-main"><b>${esc(e.name || typEinr(e.typ).name)}</b><small>${esc(typEinr(e.typ).name)}${revierOf(e) ? ' · ' + esc(revierOf(e).name) : ''}</small></div></li>`).join('')}</ul>` : ''}`;
}

function ereignisseTab() {
  const f = state.filter;
  const all = store.all('ereignis');
  const jjs = new Set(all.map(e => jagdjahr(e.zeit)));
  jjs.add(jagdjahr(Date.now()));
  const jjList = Array.from(jjs).sort().reverse();
  const list = filteredEreignisse();

  // Streckenübersicht: Abschüsse je Wildart
  const strecke = {};
  for (const e of list) if (e.typ === 'abschuss') strecke[e.wildart] = (strecke[e.wildart] || 0) + (e.anzahl || 1);
  const sicht = list.filter(e => e.typ === 'sichtung').reduce((a, e) => a + (e.anzahl || 1), 0);
  const streckeHtml = Object.keys(strecke).length
    ? `<table class="strecke"><tr><th>Strecke</th><th>Stück</th></tr>${Object.entries(strecke).sort((a, b) => b[1] - a[1]).map(([w, n]) => `<tr><td>${esc(w)}</td><td>${n}</td></tr>`).join('')}</table>`
    : '';

  return `
    <div class="filters">
      <label>Jagdjahr<select data-filter="jj"><option value="alle"${f.jj === 'alle' ? ' selected' : ''}>alle</option>${options(jjList, f.jj)}</select></label>
      <label>Revier<select data-filter="revierId"><option value="">alle</option>${options(reviere(), f.revierId)}</select></label>
      <label>Ereignis<select data-filter="typ"><option value="">alle</option>${options(EREIGNIS_TYPEN, f.typ)}</select></label>
      <label>Wildart<select data-filter="wildart"><option value="">alle</option>${options(WILDARTEN, f.wildart)}</select></label>
    </div>
    <div class="sheet-actions">
      <button class="btn primary" data-act="add-ev">+ Ereignis</button>
      <button class="btn" data-act="export-csv">Als Excel-Liste (CSV)</button>
    </div>
    <div class="legend">${EREIGNIS_TYPEN.map(t => `<span><i style="background:${t.color}"></i>${esc(t.name)}</span>`).join('')}</div>
    <p class="summary">${list.length} Einträge · ${sicht} Stück gesichtet</p>
    ${streckeHtml}
    ${list.length ? `<ul class="cards">${list.map(e => {
      const t = typEv(e.typ);
      const r = revierOf(e);
      return `<li class="card" data-act="ev-zoom" data-id="${e.id}">
        ${miniEv(e)}
        <div class="card-main"><b>${esc(t.name)}: ${esc(e.wildart || '')}${e.anzahl > 1 ? ' (' + e.anzahl + ')' : ''}</b>
        <small>${fmtDateTime(e.zeit)}${r ? ' · ' + esc(r.name) : ''}</small></div></li>`;
    }).join('')}</ul>` : '<p class="empty">Keine Ereignisse für diesen Filter.</p>'}`;
}

function mehrTab() {
  const n = k => store.all(k).length;
  return `
    ${fileSyncSection()}
    <h3>Sichern & Austauschen</h3>
    <p class="hint">${n('revier')} Reviere · ${n('einrichtung')} Einrichtungen · ${n('ereignis')} Ereignisse</p>
    <div class="sheet-actions col">
      <button class="btn" data-act="export-geojson">Komplett-Backup (GeoJSON)</button>
      <button class="btn" data-act="export-kml">Export für Google Earth (KML)</button>
      <button class="btn" data-act="export-gpx">Export für GPS-Geräte (GPX)</button>
      <button class="btn" data-act="import">Datei importieren (GeoJSON, KML, GPX)</button>
    </div>
    <h3>Versionen</h3>
    <p class="hint">Die App sichert den kompletten Stand automatisch: einmal am Tag sowie vor jedem Import, Abgleich und jeder Wiederherstellung (die letzten ${store.MAX_VERSIONS}, nur auf diesem Gerät).</p>
    <div id="versions"><p class="hint">wird geladen …</p></div>
    <div class="sheet-actions"><button class="btn" data-act="ver-save">Jetzt eine Version sichern</button></div>
    <h3>Offline-Karten</h3>
    ${offlineList()}
    <div class="sheet-actions col"><button class="btn primary" data-act="off-new">Neues Offline-Paket laden</button></div>
    <p class="hint">Gespeichert werden Topokarte (basemap.de), Luftbild NRW und Flurstücke NRW. OpenStreetMap und OpenTopoMap erlauben keine Massen-Downloads; davon bleiben nur angesehene Kacheln im Zwischenspeicher.</p>
    <h3>Speicher</h3>
    <p id="storage-info" class="hint">wird ermittelt …</p>
    <div class="sheet-actions col">
      <button class="btn" data-act="clear-tiles">Zwischengespeicherte Kartenkacheln löschen</button>
      <button class="btn danger" data-act="wipe">Alle eigenen Daten auf diesem Gerät löschen</button>
    </div>
    <details class="more"${cloud.configured ? ' open' : ''}><summary>OneDrive-Abgleich (optional, mit Microsoft-Anmeldung)</summary>${syncSection()}</details>
    <h3>Info</h3>
    <p class="hint">Revier-App <span>${APP_VERSION}</span> · nur für den Eigengebrauch.<br>
      Kartengrundlagen: © GeoBasis-DE / BKG (CC BY 4.0), © OpenStreetMap-Mitwirkende (ODbL), OpenTopoMap (CC-BY-SA), Geobasis NRW (dl-de/zero-2-0).<br>
      Tipp: Langes Drücken auf die Karte öffnet ein Schnellmenü.</p>
    <p class="hint">Anzeige: Fenster ${screenInfo ? screenInfo.innerH : '?'} px, Bildschirm ${screenInfo ? screenInfo.screenH : '?'} px, Statusleiste ${screenInfo ? screenInfo.safeTop : '?'} px, iOS-Ausgleich ${screenInfo ? screenInfo.gap : 0} px${screenInfo && screenInfo.standalone ? ' (Home-Bildschirm-App)' : ''}</p>`;
}

async function fillStorageInfo() {
  const el = $('#storage-info');
  if (!el) return;
  const parts = [];
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      parts.push(`Belegt: ${(est.usage / 1e6).toFixed(1).replace('.', ',')} MB von ca. ${(est.quota / 1e9).toFixed(1).replace('.', ',')} GB`);
    }
    if (navigator.storage && navigator.storage.persisted) {
      parts.push(await navigator.storage.persisted() ? 'Daten sind vor automatischem Löschen geschützt' : 'Daten nicht dauerhaft geschützt – App zum Home-Bildschirm hinzufügen');
    }
    const tiles = await swMessage({ type: 'tile-count' });
    if (tiles && typeof tiles.count === 'number') parts.push(`${tiles.count} Kartenkacheln offline verfügbar`);
  } catch (_) { /* nicht kritisch */ }
  el.innerHTML = parts.map(esc).join('<br>') || 'keine Angaben verfügbar';
}

// ---------------------------------------------------------------------------
// Offline-Pakete (Stufe 3)
// ---------------------------------------------------------------------------

const OFFLINE_LAYERS = [...BASE_LAYERS, ...OVERLAY_LAYERS].filter(c => c.offline);
const fmtMB = b => (b / 1e6).toLocaleString('de-DE', { maximumFractionDigits: b < 1e7 ? 1 : 0 }) + ' MB';
let offlineAbort = null;

function offlineList() {
  const list = offline.listPackages();
  if (!list.length) return '<p class="empty">Noch keine Offline-Pakete.</p>';
  return `<ul class="cards">${list.map(p => `<li class="card">
    <div class="card-main"><b>${esc(p.name)}</b>
    <small>${p.tiles} Kacheln${p.bytes ? ' · ' + fmtMB(p.bytes) : ''}${p.failed ? ` · ${p.failed} fehlgeschlagen` : ''} · ${new Date(p.date).toLocaleDateString('de-DE')}<br>${p.layers.map(l => esc(l.name.split(' (')[0])).join(', ')}</small></div>
    <button class="btn sm" data-act="off-show" data-id="${p.id}">Zeigen</button>
    <button class="btn sm danger" data-act="off-del" data-id="${p.id}">Löschen</button></li>`).join('')}</ul>`;
}

/** Gebiet und Ebenen aus dem Formular */
function offlineSelection(form) {
  const area = form.elements.area.value;
  let bounds, layers, name;
  if (area === 'nrw') {
    bounds = NRW_BOUNDS;
    layers = [{ cfg: BASE_LAYERS.find(c => c.id === 'basemap'), ...NRW_OVERVIEW }];
    name = 'Übersicht NRW';
  } else {
    if (area === 'view') {
      const b = map.getBounds();
      bounds = [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]];
      name = 'Kartenausschnitt';
    } else {
      const r = store.get(area);
      bounds = buffer(geomBounds(r.geometry), OFFLINE_BUFFER_M);
      name = r.name;
    }
    layers = OFFLINE_LAYERS.filter(c => form.elements['L_' + c.id] && form.elements['L_' + c.id].checked)
      .map(c => ({ cfg: c, minZoom: c.offline.minZoom, maxZoom: c.offline.maxZoom }));
  }
  return { bounds, layers, name };
}

function offlineForm(revierId = '') {
  const rv = reviere().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const first = revierId || (rv[0] ? rv[0].id : 'view');
  return openForm({
    title: 'Offline-Paket laden',
    submit: 'Herunterladen',
    body: `
      <label>Gebiet<select name="area">
        ${rv.map(r => `<option value="${r.id}"${r.id === first ? ' selected' : ''}>Revier: ${esc(r.name)} (+${OFFLINE_BUFFER_M} m)</option>`).join('')}
        <option value="view"${first === 'view' ? ' selected' : ''}>Aktueller Kartenausschnitt</option>
        <option value="nrw">Übersicht ganz NRW (Topokarte bis Zoom ${NRW_OVERVIEW.maxZoom})</option>
      </select></label>
      <fieldset class="checks" id="off-layers"><legend>Ebenen</legend>
        ${OFFLINE_LAYERS.map(c => `<label class="chk"><input type="checkbox" name="L_${c.id}" checked> ${esc(c.name)} <small>Zoom ${c.offline.minZoom}–${c.offline.maxZoom}</small></label>`).join('')}
      </fieldset>
      <p class="hint" id="off-est">…</p>
      <p class="hint">Tipp: im WLAN laden. Die Pakete bleiben auf diesem Gerät, bis du sie löschst.</p>`,
    onOpen: form => {
      const upd = () => {
        const sel = offlineSelection(form);
        form.querySelector('#off-layers').disabled = form.elements.area.value === 'nrw';
        const est = offline.estimate(sel.bounds, sel.layers);
        const warn = est.tiles > OFFLINE_WARN_TILES;
        form.querySelector('#off-est').innerHTML = `<b${warn ? ' class="warnc"' : ''}>${est.tiles.toLocaleString('de-DE')} Kacheln, ca. ${fmtMB(est.bytes)}</b>` +
          (est.tiles > OFFLINE_MAX_TILES ? ' – zu groß, bitte kleineres Gebiet wählen' : warn ? ' – das dauert eine Weile' : '');
      };
      form.addEventListener('change', upd);
      upd();
    },
    onSubmit: async (d, form) => {
      const sel = offlineSelection(form);
      if (!sel.layers.length) throw new Error('Bitte mindestens eine Ebene wählen');
      const est = offline.estimate(sel.bounds, sel.layers);
      if (est.tiles > OFFLINE_MAX_TILES) throw new Error('Gebiet zu groß');
      if (!est.tiles) throw new Error('Im gewählten Gebiet gibt es keine Kacheln dieser Ebenen (Luftbild/Flurstücke nur in NRW)');
      setTimeout(() => runOfflineDownload(sel), 0);
    }
  });
}

async function runOfflineDownload(sel) {
  if (offlineAbort) { toast('Es läuft schon ein Download'); return; }
  const box = $('#progress');
  box.hidden = false;
  $('#progress-label').textContent = `Lade „${sel.name}“ …`;
  offlineAbort = new AbortController();
  try {
    const meta = await offline.download({
      ...sel, signal: offlineAbort.signal,
      onProgress: (done, total, failed) => {
        $('#progress-bar').style.width = (100 * done / total).toFixed(1) + '%';
        $('#progress-count').textContent = `${done.toLocaleString('de-DE')} / ${total.toLocaleString('de-DE')}${failed ? ` · ${failed} Fehler` : ''}`;
      }
    });
    toast(`Offline-Paket „${meta.name}“ gespeichert: ${meta.tiles} Kacheln${meta.bytes ? ', ' + fmtMB(meta.bytes) : ''}${meta.failed ? `, ${meta.failed} fehlgeschlagen` : ''}`, { ms: 8000 });
  } catch (e) {
    toast(e.message, { ms: 5000 });
  } finally {
    offlineAbort = null;
    box.hidden = true;
    if (sheet.isOpen && state.tab === 'mehr') renderTab('mehr');
  }
}

// ---------------------------------------------------------------------------
// Revier teilen (Mitpächter)
// ---------------------------------------------------------------------------
// Ein Revier mit seinen Einrichtungen (und wahlweise Ereignissen) als eigene Datei.
// Zugeordnet wird geometrisch: alles, was innerhalb der Reviergrenze liegt.

function shareRecords(r, { einr, ev, notes }) {
  const inside = p => typeof p.lat === 'number' && pointInGeometry([p.lng, p.lat], r.geometry);
  const range = ev === 'jj' ? jagdjahrRange(jagdjahr(Date.now())) : null;
  let recs = [r];
  if (einr) recs = recs.concat(store.all('einrichtung').filter(inside));
  if (ev !== 'none') recs = recs.concat(store.all('ereignis').filter(e => inside(e) && (!range || (e.zeit >= range.from && e.zeit < range.to))));
  if (!notes) recs = recs.map(x => ({ ...x, notes: '' }));
  // Löschungen mitgeben (nur Kennung + Zeit), damit gelöschte Hochsitze auch beim Mitpächter verschwinden
  const tombs = store.all(null, { includeDeleted: true }).filter(x => x.deleted && x.kind !== 'revier');
  return { live: recs, all: recs.concat(tombs) };
}

const safeName = t => t.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'Revier';

function shareForm(r) {
  const nE = shareRecords(r, { einr: true, ev: 'none', notes: true }).live.length - 1;
  return openForm({
    title: `Revier „${r.name}“ teilen`,
    submit: 'Teilen',
    body: `
      <fieldset class="checks"><legend>Inhalt</legend>
        <label class="chk"><input type="checkbox" name="einr" checked> Einrichtungen im Revier (${nE})</label>
        <label class="chk"><input type="checkbox" name="notes" checked> Notizen mitschicken</label>
      </fieldset>
      <label>Ereignisse<select name="ev">
        <option value="none" selected>keine</option>
        <option value="jj">aus dem laufenden Jagdjahr ${jagdjahr(Date.now())}</option>
        <option value="all">alle</option>
      </select></label>
      <fieldset class="checks"><legend>Format</legend>
        <label class="chk"><input type="radio" name="fmt" value="json" checked> <span><b>Revier-App</b> – Mitpächter liest es mit „Datei importieren“ ein; Änderungen lassen sich hin- und herschicken</span></label>
        <label class="chk"><input type="radio" name="fmt" value="kml"> <span><b>KML</b> – für Google Earth und andere Jagd-Apps</span></label>
        <label class="chk"><input type="radio" name="fmt" value="gpx"> <span><b>GPX</b> – für GPS-Geräte</span></label>
      </fieldset>
      <p class="hint" id="share-info"></p>`,
    onOpen: form => {
      const upd = () => {
        const sel = { einr: form.elements.einr.checked, ev: form.elements.ev.value, notes: form.elements.notes.checked };
        const c = store.countKinds(shareRecords(r, sel).live);
        form.querySelector('#share-info').innerHTML = `Enthält: 1 Revier, ${c.einrichtung} Einrichtungen, ${c.ereignis} Ereignisse.` +
          (sel.notes ? '' : ' <b class="warnc">Ohne Notizen: Ändert der Mitpächter einen Eintrag und schickt ihn zurück, fehlen dort deine Notizen.</b>');
      };
      form.addEventListener('change', upd);
      upd();
    },
    // synchron, damit das Teilen-Menü (Nachrichten, WhatsApp, Mail, AirDrop …) geöffnet werden darf
    onSubmit: d => {
      const sel = { einr: d.einr === 'on', ev: d.ev, notes: d.notes === 'on' };
      const { live, all } = shareRecords(r, sel);
      const base = `Revier-${safeName(r.name)}-${today()}`;
      if (d.fmt === 'kml') deliverFile(base + '.kml', 'application/vnd.google-earth.kml+xml', toKML(live, r.name));
      else if (d.fmt === 'gpx') deliverFile(base + '.gpx', 'application/gpx+xml', toGPX(live));
      else deliverFile(base + '.json', 'application/json', toShareFile(all, { revier: r.name, revierId: r.id, from: store.getDeviceId(), createdAt: new Date().toISOString() }));
    }
  });
}

// ---------------------------------------------------------------------------
// Versionsverlauf und Wiederherstellen
// ---------------------------------------------------------------------------
// Zusammenführen (Import, Abgleich): je Eintrag gewinnt der neuere Stand – ein altes Backup kann
// so NICHTS zurückdrehen. Wiederherstellen dagegen setzt exakt den alten Stand ein und versieht
// ihn mit einem frischen Zeitstempel, damit er auch auf dem anderen Gerät gewinnt.

const DAY = 24 * 3600 * 1000;
let dailyBusy = false;
let versionCache = [];   // zuletzt angezeigte Liste (synchroner Zugriff für das Teilen-Menü)

async function ensureDailyVersion() {
  if (dailyBusy) return;
  dailyBusy = true;
  try {
    const last = (await store.listVersions())[0];
    if (!last || Date.now() - last.time > DAY) await store.saveVersion('Tagesstand');
  } catch (e) { console.warn('Version nicht gesichert', e); }
  dailyBusy = false;
}

const countText = c => `${c.revier} Reviere · ${c.einrichtung} Einrichtungen · ${c.ereignis} Ereignisse`;

async function fillVersions() {
  const el = $('#versions');
  if (!el) return;
  let list = [];
  try { list = await store.listVersions(); } catch (_) { /* ignore */ }
  versionCache = list;
  if (!list.length) { el.innerHTML = '<p class="empty">Noch keine Versionen.</p>'; return; }
  const item = v => `<li class="card ver">
      <div class="card-main"><b>${fmtDateTime(v.time)}</b> <span class="reason">${esc(v.reason)}</span><small>${countText(v.counts)}</small></div>
      <button class="btn sm" data-act="ver-export" data-id="${v.id}" title="Als Datei sichern">Datei</button>
      <button class="btn sm" data-act="ver-restore" data-id="${v.id}">Wiederherstellen</button></li>`;
  const head = list.slice(0, 3), rest = list.slice(3);
  el.innerHTML = `<ul class="cards">${head.map(item).join('')}</ul>` +
    (rest.length ? `<details class="more"><summary>Ältere Versionen (${rest.length})</summary><ul class="cards">${rest.map(item).join('')}</ul></details>` : '');
}

async function restoreRecords(records, label) {
  const c = store.countKinds(records);
  if (!(await confirmDialog('Stand wiederherstellen?',
    `Die App kehrt genau zum Stand „${label}“ zurück (${countText(c)}). Was danach hinzugekommen ist, wird entfernt. ` +
    'Der jetzige Stand wird vorher als Version gesichert – du kannst also zurück.', 'Wiederherstellen'))) return false;
  await store.restoreState(records);
  toast(`Stand „${label}“ wiederhergestellt. Beim nächsten iCloud-Abgleich „Zurückspeichern“ wählen, damit das andere Gerät ihn übernimmt.`, { ms: 9000 });
  if (sheet.isOpen && state.tab === 'mehr') renderTab('mehr');
  return true;
}

// ---------------------------------------------------------------------------
// iCloud-Abgleich per Datei (ohne Anmeldung)
// ---------------------------------------------------------------------------
// Idee: Beide Geräte lesen und schreiben dieselbe Datei "Revier-Daten.json" in iCloud Drive.
// Abgleichen = Datei öffnen -> mit den Daten hier zusammenführen (je Eintrag gewinnt der
// jüngere Stand, Löschungen inklusive) -> Gesamtstand wieder in dieselbe Datei speichern.
// Das Speichern muss ein eigener Tipp sein: Browser öffnen das Teilen-Menü nur direkt nach
// einer Nutzeraktion.

const SYNC_FILE = 'Revier-Daten.json';
let fileMode = 'import';   // was der Dateiauswahl-Dialog gerade tun soll: 'import' oder 'sync'

const lsTime = k => +(localStorage.getItem(k) || 0);
const lsSetTime = k => { try { localStorage.setItem(k, String(Date.now())); } catch (_) { /* ignore */ } };

function fileSyncSection() {
  const lastRead = lsTime('jagd.file.read'), lastSaved = lsTime('jagd.file.saved');
  const pending = lastChange() > lastSaved;
  return `
    <h3>iCloud-Abgleich</h3>
    <p class="hint">${lastRead ? 'Zuletzt abgeglichen ' + fmtDateTime(lastRead) : 'Noch nicht abgeglichen'}${pending && lastSaved ? ' · <b class="warnc">Änderungen seit dem letzten Speichern</b>' : ''}</p>
    <div class="sheet-actions col">
      <button class="btn primary" data-act="file-sync">Mit iCloud-Datei abgleichen</button>
      <button class="btn" data-act="file-save">Nur speichern${lastSaved ? '' : ' (erste Datei anlegen)'}</button>
    </div>
    <details class="howto"><summary>So geht's</summary><p class="hint">Beim ersten Mal „Nur speichern“ und im Teilen-Menü „In Dateien sichern“ → iCloud Drive → z. B. Ordner „Revier“.
      Danach auf jedem Gerät: <b>Mit iCloud-Datei abgleichen</b> → „${SYNC_FILE}“ wählen → im nächsten Schritt wieder an dieselbe Stelle speichern („Ersetzen“).
      Am Mac in Safari unter Einstellungen → Allgemein den Download-Ort auf „Jedes Mal fragen“ stellen, dann lässt sich die Datei direkt in iCloud Drive ersetzen.</p></details>`;
}

function lastChange() {
  return store.snapshot().reduce((m, r) => Math.max(m, r.updatedAt || 0), 0);
}

/** Muss direkt aus einem Tipp heraus aufgerufen werden (Teilen-Menü) */
function saveSyncFile() {
  deliverFile(SYNC_FILE, 'application/json', toSyncFile(store.snapshot(), store.getDeviceId()));
  lsSetTime('jagd.file.saved');
}

async function fileSync(file) {
  let res;
  try { res = parseAny(file.name, await file.text()); } catch (e) { toast('Datei nicht lesbar: ' + e.message, { ms: 6000 }); return; }
  const n = await store.importRecords(res.records, { keepTimestamps: true });
  lsSetTime('jagd.file.read');
  // Steht hier etwas, das in der Datei fehlt oder älter ist? Dann lohnt das Zurückspeichern.
  const inFile = new Map(res.records.map(r => [r.id, r.updatedAt || 0]));
  const newer = store.snapshot().filter(r => (inFile.get(r.id) ?? -1) < (r.updatedAt || 0)).length;
  if (!newer) {
    toast(n ? `${n} Änderung(en) aus iCloud übernommen – Datei ist auf dem neuesten Stand` : 'Alles aktuell – nichts zu tun');
    lsSetTime('jagd.file.saved');
    if (sheet.isOpen && state.tab === 'mehr') renderTab('mehr');
    return;
  }
  await openForm({
    title: 'Zurück in iCloud speichern',
    submit: 'Speichern',
    body: `<p>${n ? `${n} Änderung(en) aus der Datei übernommen. ` : ''}Auf diesem Gerät gibt es ${newer} neuere Einträge, die noch nicht in der Datei stehen.</p>
      <p class="hint">Jetzt speichern und dieselbe Datei ersetzen (iPhone: „In Dateien sichern“ → gleicher Ordner → „Ersetzen“), damit das andere Gerät sie auch bekommt.</p>`,
    onSubmit: () => { saveSyncFile(); }   // synchron: der Tipp auf „Speichern“ erlaubt das Teilen-Menü
  });
  if (sheet.isOpen && state.tab === 'mehr') renderTab('mehr');
}

// ---------------------------------------------------------------------------
// OneDrive-Abgleich (Stufe 2)
// ---------------------------------------------------------------------------

async function initSync() {
  try {
    if (await cloud.handleRedirect()) toast('Bei OneDrive angemeldet' + (cloud.account ? ': ' + cloud.account : ''));
  } catch (e) {
    syncState.error = e.message;
    toast('OneDrive-Anmeldung fehlgeschlagen: ' + e.message, { ms: 8000 });
  }
  if (cloud.signedIn) runSync();
  window.addEventListener('online', () => runSync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - syncState.last > 120000) runSync();
  });
}

function scheduleSync(ms) {
  if (!cloud.signedIn) return;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(() => runSync(), ms);
}

async function runSync({ manual = false } = {}) {
  if (!cloud.signedIn || syncState.running) return;
  if (!navigator.onLine) { if (manual) toast('Offline – Abgleich folgt automatisch, sobald wieder Netz da ist'); return; }
  syncState.running = true;
  updateSyncInfo('Abgleich läuft …');
  try {
    const r = await syncOnce(cloud, store);
    syncState.last = Date.now();
    syncState.error = '';
    try { localStorage.setItem('jagd.sync.last', String(syncState.last)); } catch (_) { /* ignore */ }
    if (manual || r.pulled) toast(r.pulled ? `OneDrive: ${r.pulled} Änderung(en) übernommen` : 'OneDrive: alles aktuell');
  } catch (e) {
    syncState.error = e.message;
    if (manual || e instanceof AuthError) toast('OneDrive: ' + e.message, { ms: 6000 });
  } finally {
    syncState.running = false;
    updateSyncInfo();
  }
}

function syncStatusText() {
  if (!cloud.configured) return 'Noch nicht eingerichtet (Anwendungs-ID fehlt).';
  if (!cloud.signedIn) return syncState.error ? 'Abgemeldet: ' + syncState.error : 'Nicht angemeldet.';
  const last = syncState.last ? 'zuletzt ' + fmtDateTime(syncState.last) : 'noch nie abgeglichen';
  return `Angemeldet${cloud.account ? ' als ' + cloud.account : ''} · ${last}` + (syncState.error ? ` · Fehler: ${syncState.error}` : '');
}

function updateSyncInfo(text) {
  const el = $('#sync-info');
  if (el) el.textContent = text || syncStatusText();
}

function syncSection() {
  return `
    <h3>OneDrive-Abgleich</h3>
    <p class="hint" id="sync-info">${esc(syncStatusText())}</p>
    <div class="sheet-actions">
      ${cloud.signedIn
        ? `<button class="btn primary" data-act="sync-now">Jetzt abgleichen</button><button class="btn" data-act="sync-logout">Abmelden</button>`
        : `<button class="btn primary" data-act="sync-login"${cloud.configured ? '' : ' disabled'}>Bei OneDrive anmelden</button>`}
      <button class="btn" data-act="sync-setup">Einrichtung</button>
    </div>
    <p class="hint">Die Daten liegen in deinem OneDrive unter „Apps/…/${FILE_NAME}“. Abgleich automatisch beim Öffnen und kurz nach jeder Änderung.</p>`;
}

function syncSetupForm() {
  return openForm({
    title: 'OneDrive einrichten',
    submit: 'Speichern',
    body: `
      <p class="hint">Einmalig nötig: eine kostenlose App-Registrierung bei Microsoft (Anleitung in der README im GitHub-Repo, Abschnitt „OneDrive einrichten“). Dort trägst du diese Weiterleitungsadresse als <b>Single-Page-Application</b> ein:</p>
      <label>Weiterleitungsadresse (Redirect-URI)<input readonly value="${esc(redirectUri())}" onclick="this.select()"></label>
      <label>Anwendungs-ID (Client-ID)<input name="clientId" value="${esc(cloud.clientId)}" placeholder="z. B. 1a2b3c4d-…" autocomplete="off" spellcheck="false"></label>
      <p class="hint">Die ID ist kein Geheimnis. Sie muss auf jedem Gerät einmal eingetragen werden (oder fest in js/config.js).</p>`,
    onSubmit: async d => {
      const id = d.clientId.trim();
      if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Das sieht nicht wie eine Anwendungs-ID aus (Format 8-4-4-4-12).');
      cloud.setClientId(id);
      renderTab('mehr');
    }
  });
}

// ---------------------------------------------------------------------------
// Import / Export
// ---------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

function exportFile(kind) {
  const recs = store.snapshot();
  if (kind === 'geojson') deliverFile(`jagd-backup-${today()}.geojson`, 'application/geo+json', JSON.stringify(toGeoJSON(recs), null, 1));
  if (kind === 'kml') deliverFile(`jagd-${today()}.kml`, 'application/vnd.google-earth.kml+xml', toKML(recs));
  if (kind === 'gpx') deliverFile(`jagd-${today()}.gpx`, 'application/gpx+xml', toGPX(recs));
  if (kind === 'csv') {
    const list = filteredEreignisse().map(e => ({ ...e, revierId: revierOf(e)?.id || null }));
    const csv = toCSV(list, {
      revierName: id => (id && store.get(id)?.name) || '',
      einrichtungName: id => { const e = id && store.get(id); return e ? (e.name || typEinr(e.typ).name) : ''; }
    });
    const jj = state.filter.jj === 'alle' ? 'alle' : state.filter.jj.replace('/', '-');
    deliverFile(`ereignisse-${jj}.csv`, 'text/csv', csv);
  }
}

async function importFile(file) {
  const text = await file.text();
  let res;
  try { res = parseAny(file.name, text); } catch (e) { toast('Import fehlgeschlagen: ' + e.message, { ms: 6000 }); return; }
  const c = k => res.records.filter(r => r.kind === k && !r.deleted).length;
  const msg = `${c('revier')} Reviere, ${c('einrichtung')} Einrichtungen, ${c('ereignis')} Ereignisse` +
    (res.skipped ? ` (${res.skipped} nicht verwendbare Objekte übersprungen)` : '');
  if (!res.records.length) { toast('Nichts Verwendbares gefunden. ' + msg, { ms: 6000 }); return; }
  // Wiederherstellen nur bei eigenen Backups – ein geteiltes Revier würde sonst alle anderen Daten entfernen
  const ownBackup = !res.share && res.records.some(r => r.id && r.updatedAt);
  const choice = await openForm({
    title: res.share ? `Geteiltes Revier „${res.share.revier}“` : 'Datei einlesen', submit: 'Übernehmen', dialog: '#dlg2',
    body: `<p>Gefunden: ${esc(msg)}.</p>
      ${res.share ? '<p class="hint">Neue Einträge werden ergänzt; bereits vorhandene nur aktualisiert, wenn sie in der Datei neuer sind. Deine übrigen Daten bleiben unberührt.</p>' : ''}
      <label class="chk"><input type="radio" name="mode" value="merge" checked> <span><b>Zusammenführen</b> – Neues ergänzen; vorhandene Einträge nur ersetzen, wenn die Datei neuer ist</span></label>
      ${ownBackup ? `<label class="chk"><input type="radio" name="mode" value="restore"> <span><b>Genau diesen Stand wiederherstellen</b> – alles andere entfernen (vorher wird gesichert)</span></label>` : ''}`,
    onSubmit: async () => true
  });
  if (!choice) return;
  if (choice.mode === 'restore') { await restoreRecords(res.records, file.name); return; }
  const n = await store.importRecords(res.records);
  toast(`${n} Einträge übernommen`);
  const rv = res.records.filter(r => r.kind === 'revier' && r.geometry);
  if (rv.length) {
    const b = L.latLngBounds([]);
    rv.forEach(r => b.extend(L.polygon(geomToLatLngs(r.geometry)).getBounds()));
    if (b.isValid()) map.fitBounds(b, { padding: [30, 30] });
  }
}

// ---------------------------------------------------------------------------
// Service Worker (Offline-Start + Kachel-Cache)
// ---------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Neue Version verfügbar', { action: { label: 'Neu laden', onClick: () => nw.postMessage({ type: 'skip-waiting' }) } });
        }
      });
    });
  }).catch(e => console.warn('Service Worker nicht registriert:', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || state.mode !== 'normal') return;
    reloading = true;
    location.reload();
  });
}

function swMessage(msg) {
  return new Promise(resolve => {
    const ctl = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!ctl) { resolve(null); return; }
    const ch = new MessageChannel();
    ch.port1.onmessage = e => resolve(e.data);
    ctl.postMessage(msg, [ch.port2]);
    setTimeout(() => resolve(null), 3000);
  });
}

// ---------------------------------------------------------------------------
// Bedienelemente
// ---------------------------------------------------------------------------

function bindUi() {
  $('#btn-locate').onclick = toggleLocate;
  $('#btn-compass').onclick = toggleCompass;
  $('#btn-add').onclick = () => { $('#addmenu').hidden = !$('#addmenu').hidden; };
  map.on('click', () => { $('#addmenu').hidden = true; });
  $('#sheet-close').onclick = () => openTab('map');
  document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => openTab(b.dataset.tab); });

  // Zeichenleiste
  $('#draw-undo').onclick = () => editor.undo();
  $('#draw-del').onclick = () => editor.deleteSelected();
  $('#draw-gps').onclick = () => {
    if (!pos.last) { toast('Noch keine GPS-Position – GPS-Knopf antippen'); if (!pos.gpsActive) toggleLocate(); return; }
    editor.addVertex(pos.last);
    toast(`GPS-Punkt gesetzt (±${Math.round(pos.last.accuracy)} m)`, { ms: 1500 });
  };
  $('#draw-done').onclick = finishDraw;
  $('#draw-cancel').onclick = endDraw;

  // Platzierleiste
  $('#place-here').onclick = () => placeAt(map.getCenter());
  $('#place-me').onclick = () => { if (pos.last) placeAt(pos.last); };
  $('#place-cancel').onclick = endPlace;

  $('#progress-cancel').onclick = () => { if (offlineAbort) offlineAbort.abort(); };

  // Datei-Import
  $('#file-input').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (fileMode === 'sync') await fileSync(f); else await importFile(f);
  };

  // Filter im Ereignis-Tab
  $('#sheet-body').addEventListener('change', e => {
    const key = e.target.dataset.filter;
    if (!key) return;
    state.filter[key] = e.target.value;
    renderEreignisse();
    renderTab('ereignisse');
  });

  // Alle Knöpfe mit data-act (in Listen, Menüs und Popups) laufen in handleAction zusammen.
  // Leaflet stoppt Klicks in Popups vor dem document, daher dort eigener Listener.
  document.addEventListener('click', onActClick);
  map.on('popupopen', e => {
    const el = e.popup.getElement();
    if (el && !el.dataset.actBound) { el.dataset.actBound = '1'; el.addEventListener('click', onActClick); }
  });

  // Antippen der Statuszeile zeigt die Rohdaten der Position (zur Fehlersuche)
  $('#statusbar').onclick = () => {
    const p = pos.last;
    if (!p) return;
    const age = Math.round((Date.now() - p.time) / 1000);
    toast(`${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} · Genauigkeit ${accText(p.accuracy)} · vor ${age} s` +
      (pos.rejected ? ` · ${pos.rejected} grobe Positionen verworfen` : ''), { ms: 8000 });
  };
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.mode === 'draw' && !$('#dlg').open) endDraw();
    if (e.key === 'Escape' && state.mode === 'place') endPlace();
  });
}

function onActClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  handleAction(b.dataset.act, b.dataset);
}

function zoomTo(rec) {
  if (window.matchMedia('(max-width: 899px)').matches) openTab('map');
  if (rec.kind === 'revier') {
    map.fitBounds(L.polygon(geomToLatLngs(rec.geometry)).getBounds(), { padding: [30, 30] });
  } else {
    map.setView([rec.lat, rec.lng], Math.max(map.getZoom(), 17));
    const html = rec.kind === 'einrichtung' ? einrPopup(rec) : ereigPopup(rec);
    setTimeout(() => L.popup({ offset: [0, -12] }).setLatLng([rec.lat, rec.lng]).setContent(html).openOn(map), 300);
  }
}

async function handleAction(act, d) {
  const rec = d.id ? store.get(d.id) : null;
  const at = d.lat ? { lat: parseFloat(d.lat), lng: parseFloat(d.lng) } : null;
  $('#addmenu').hidden = true;
  switch (act) {
    // Neu anlegen
    case 'add-rv': map.closePopup(); startDraw(null); break;
    case 'add-ei':
      startPlace('Einrichtung: Fadenkreuz auf die Stelle schieben', p => einrForm({ typ: 'hochsitz', ...p })); break;
    case 'add-ev':
      startPlace('Ereignis: Fadenkreuz auf die Stelle schieben', p => ereigForm({ ...p, zeit: Date.now() })); break;
    case 'add-ei-at': map.closePopup(); einrForm({ typ: 'hochsitz', ...at }); break;
    case 'add-ev-at': map.closePopup(); ereigForm({ ...at, zeit: Date.now() }); break;

    // Reviere
    case 'rv-edit': if (rec) { map.closePopup(); revierForm(rec); } break;
    case 'rv-geom': if (rec) startDraw(rec.id); break;
    case 'rv-del': if (rec) deleteRecord(rec.id); break;
    case 'rv-zoom': if (rec) zoomTo(rec); break;
    case 'rv-share': if (rec) { map.closePopup(); shareForm(rec); } break;
    case 'rv-offline': if (rec) { map.closePopup(); offlineForm(rec.id); } break;
    case 'off-new': offlineForm(); break;
    case 'ver-save': {
      const v = await store.saveVersion('von Hand gesichert', { force: true });
      toast(v ? 'Version gesichert' : 'Keine Daten zum Sichern');
      fillVersions();
      break;
    }
    case 'ver-restore': {
      const v = await store.getVersion(+d.id);
      if (v) await restoreRecords(v.records, fmtDateTime(v.time) + ' · ' + v.reason);
      break;
    }
    case 'ver-export': {
      const v = versionCache.find(x => x.id === +d.id);   // ohne await: sonst verweigert iOS das Teilen-Menü
      if (v) {
        const t = new Date(v.time), p = n => String(n).padStart(2, '0');
        deliverFile(`Revier-Version-${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}.json`,
          'application/json', toSyncFile(v.records, store.getDeviceId()));
      }
      break;
    }
    case 'sync-setup': syncSetupForm(); break;
    case 'sync-login':
      try { await cloud.login(); } catch (e) { toast(e.message, { ms: 6000 }); }
      break;
    case 'sync-now': runSync({ manual: true }); break;
    case 'sync-logout':
      if (await confirmDialog('Abmelden?', 'Die Daten bleiben auf diesem Gerät und in OneDrive erhalten.', 'Abmelden')) {
        cloud.logout(); renderTab('mehr');
      }
      break;
    case 'off-del': {
      const p = offline.listPackages().find(x => x.id === d.id);
      if (p && await confirmDialog('Offline-Paket löschen?', `„${p.name}“ wird von diesem Gerät entfernt.`, 'Löschen')) {
        await offline.deletePackage(p.id);
        renderTab('mehr');
      }
      break;
    }
    case 'off-show': {
      const p = offline.listPackages().find(x => x.id === d.id);
      if (p) { openTab('map'); map.fitBounds(L.latLngBounds(p.bounds)); }
      break;
    }

    // Einrichtungen
    case 'ei-edit': if (rec) { map.closePopup(); einrForm(rec); } break;
    case 'ei-del': if (rec) deleteRecord(rec.id); break;
    case 'ei-zoom': if (rec) zoomTo(rec); break;
    case 'ei-ev': if (rec) { map.closePopup(); ereigForm({ lat: rec.lat, lng: rec.lng, zeit: Date.now(), einrichtungId: rec.id }); } break;
    case 'ei-move':
      if (rec) {
        map.setView([rec.lat, rec.lng]);
        startPlace('Neue Position wählen', p => store.save({ ...rec, ...p }).then(() => toast('Verschoben')));
      }
      break;

    // Ereignisse
    case 'ev-edit': if (rec) { map.closePopup(); ereigForm(rec); } break;
    case 'ev-del': if (rec) deleteRecord(rec.id); break;
    case 'ev-zoom': if (rec) zoomTo(rec); break;
    case 'ev-move':
      if (rec) {
        map.setView([rec.lat, rec.lng]);
        startPlace('Neue Position wählen', p => store.save({ ...rec, ...p }).then(() => toast('Verschoben')));
      }
      break;

    // Sonstiges
    case 'route': window.open(`https://maps.apple.com/?daddr=${at.lat},${at.lng}&dirflg=d`, '_blank'); break;
    case 'export-geojson': exportFile('geojson'); break;
    case 'export-kml': exportFile('kml'); break;
    case 'export-gpx': exportFile('gpx'); break;
    case 'export-csv': exportFile('csv'); break;
    case 'import': fileMode = 'import'; $('#file-input').click(); break;
    case 'file-sync': fileMode = 'sync'; $('#file-input').click(); break;
    case 'file-save': saveSyncFile(); setTimeout(() => renderTab('mehr'), 500); break;
    case 'clear-tiles': {
      const r = await swMessage({ type: 'clear-tiles' });
      toast(r ? 'Kachel-Zwischenspeicher geleert' : 'Kein Service Worker aktiv');
      fillStorageInfo();
      break;
    }
    case 'wipe':
      if (await confirmDialog('Wirklich alles löschen?', 'Alle Reviere, Einrichtungen und Ereignisse auf diesem Gerät werden gelöscht. Vorher ein Backup machen!', 'Endgültig löschen')) {
        await store.wipeAll();
        toast('Alle Daten gelöscht');
      }
      break;
    default: console.warn('Unbekannte Aktion', act);
  }
}

init().catch(e => {
  console.error(e);
  toast('Startfehler: ' + e.message, { ms: 10000 });
});
