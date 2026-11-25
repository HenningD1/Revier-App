// Hauptprogramm: verbindet Karte, Datenhaltung, Formulare und Listen.
/* global L */

import * as store from './store.js';
import {
  APP_VERSION, DEFAULT_VIEW, BASE_LAYERS, OVERLAY_LAYERS, EINRICHTUNG_TYPEN, EREIGNIS_TYPEN,
  WILDARTEN, GESCHLECHT, ALTERSKLASSEN, REVIER_FARBEN
} from './config.js';
import {
  geometryArea, formatArea, findRevier, distance, bearing, compassName, formatDistance,
  jagdjahr, jagdjahrRange, openRing
} from './geo.js';
import { toGeoJSON, toKML, toGPX, toCSV, parseAny } from './io.js';
import { PolygonEditor } from './draw.js';
import { Positioning } from './gps.js';
import { buildDial } from './compass.js';
import { einrSvg, animalSvg } from './icons.js';
import {
  $, esc, toast, openForm, confirmDialog, sheet, deliverFile, fmtDateTime, toLocalInput, options
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

async function init() {
  if (typeof L === 'undefined') {
    document.body.innerHTML = '<p style="padding:2em">Die Kartenbibliothek konnte nicht geladen werden. Beim ersten Start wird eine Internetverbindung benötigt.</p>';
    return;
  }
  await store.openStore();
  initMap();
  editor = new PolygonEditor(map, { onChange: updateDrawbar });
  pos = new Positioning({ onPosition, onError: e => toast(e.message, { ms: 6000 }), onHeading });
  dial = buildDial($('#compass-dial'));
  bindUi();
  renderAll();
  store.onChange(() => renderAll());
  registerServiceWorker();
}

// ---------------------------------------------------------------------------
// Karte
// ---------------------------------------------------------------------------

function makeLayer(cfg) {
  const common = {
    attribution: cfg.attribution,
    maxZoom: 21,
    maxNativeZoom: cfg.maxNativeZoom || 19,
    minZoom: cfg.minZoom || 0
  };
  if (cfg.bounds) common.bounds = L.latLngBounds(cfg.bounds);
  let layer;
  if (cfg.type === 'wms') {
    // 512er-Kacheln halbieren die Zahl der WMS-Anfragen gegenüber 256er-Kacheln
    layer = L.tileLayer.wms(cfg.url, {
      ...common, layers: cfg.layers, format: cfg.format, transparent: !!cfg.transparent,
      version: '1.3.0', tileSize: 512
    });
  } else {
    layer = L.tileLayer(cfg.url, { ...common, subdomains: cfg.subdomains || 'abc' });
  }
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
      <button class="btn sm" data-act="rv-geom" data-id="${r.id}">Grenze ändern</button>
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
  else if (tab === 'mehr') { sheet.open('Daten & Einstellungen', mehrTab()); fillStorageInfo(); }
}

function reviereTab() {
  const list = reviere().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const einr = store.all('einrichtung');
  const items = list.map(r => {
    const nE = einr.filter(e => revierOf(e)?.id === r.id).length;
    return `<li class="card" data-act="rv-zoom" data-id="${r.id}">
      <span class="swatch" style="background:${esc(r.color)}"></span>
      <div class="card-main"><b>${esc(r.name)}</b><small>${formatArea(geometryArea(r.geometry))} · ${nE} Einrichtungen</small></div>
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
    <h3>Sichern & Austauschen</h3>
    <p class="hint">${n('revier')} Reviere · ${n('einrichtung')} Einrichtungen · ${n('ereignis')} Ereignisse</p>
    <div class="sheet-actions col">
      <button class="btn primary" data-act="export-geojson">Komplett-Backup (GeoJSON)</button>
      <button class="btn" data-act="export-kml">Export für Google Earth (KML)</button>
      <button class="btn" data-act="export-gpx">Export für GPS-Geräte (GPX)</button>
      <button class="btn" data-act="import">Datei importieren (GeoJSON, KML, GPX)</button>
    </div>
    <p class="hint">Auf dem iPhone öffnet sich das Teilen-Menü – dort „In Dateien sichern“ und den OneDrive-Ordner wählen. Der automatische OneDrive-Abgleich folgt in Stufe 2.</p>
    <h3>Speicher</h3>
    <p id="storage-info" class="hint">wird ermittelt …</p>
    <div class="sheet-actions col">
      <button class="btn" data-act="clear-tiles">Zwischengespeicherte Kartenkacheln löschen</button>
      <button class="btn danger" data-act="wipe">Alle eigenen Daten auf diesem Gerät löschen</button>
    </div>
    <h3>Info</h3>
    <p class="hint">Revier-App <span>${APP_VERSION}</span> · nur für den Eigengebrauch.<br>
      Kartengrundlagen: © GeoBasis-DE / BKG (CC BY 4.0), © OpenStreetMap-Mitwirkende (ODbL), OpenTopoMap (CC-BY-SA), Geobasis NRW (dl-de/zero-2-0).<br>
      Tipp: Langes Drücken auf die Karte öffnet ein Schnellmenü.</p>`;
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
  const c = k => res.records.filter(r => r.kind === k).length;
  const msg = `${c('revier')} Reviere, ${c('einrichtung')} Einrichtungen, ${c('ereignis')} Ereignisse` +
    (res.skipped ? ` (${res.skipped} nicht verwendbare Objekte übersprungen)` : '');
  if (!res.records.length) { toast('Nichts Verwendbares gefunden. ' + msg, { ms: 6000 }); return; }
  if (!(await confirmDialog('Importieren?', `Gefunden: ${msg}. Vorhandene Einträge mit gleicher Kennung werden nur ersetzt, wenn die Datei neuer ist.`, 'Importieren'))) return;
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

  // Datei-Import
  $('#file-input').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importFile(f);
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
    case 'import': $('#file-input').click(); break;
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
