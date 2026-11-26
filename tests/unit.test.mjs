// Unit-Tests für die reinen Module (ohne Browser): node tests/unit.test.mjs
import assert from 'node:assert/strict';
import { ringArea, geometryArea, pointInGeometry, distance, bearing, compassName, jagdjahr, jagdjahrRange, closeRing, openRing, formatArea } from '../js/geo.js';
import { mergeRecords, planRestore, signature, countKinds } from '../js/store.js';
import { toGeoJSON, fromGeoJSON, toKML, toGPX, toCSV } from '../js/io.js';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

// Quadrat 0,01° x 0,01° bei 51,6° N (Lippstadt): ca. 1113 m x 692 m ≈ 77 ha
const sq = [[8.30, 51.60], [8.31, 51.60], [8.31, 51.61], [8.30, 51.61], [8.30, 51.60]];

test('Fläche Quadrat bei 51,6° N plausibel', () => {
  const a = ringArea(sq);
  const expected = (0.01 * Math.PI / 180 * 6378137 * Math.cos(51.605 * Math.PI / 180)) * (0.01 * Math.PI / 180 * 6378137);
  assert.ok(Math.abs(a - expected) / expected < 0.01, `${a} vs ${expected}`);
});

test('Loch wird abgezogen', () => {
  const hole = [[8.302, 51.602], [8.304, 51.602], [8.304, 51.604], [8.302, 51.604], [8.302, 51.602]];
  const full = geometryArea({ type: 'Polygon', coordinates: [sq] });
  const withHole = geometryArea({ type: 'Polygon', coordinates: [sq, hole] });
  assert.ok(withHole < full && withHole > full * 0.9);
});

test('Punkt im Polygon / außerhalb / im Loch', () => {
  const hole = [[8.302, 51.602], [8.304, 51.602], [8.304, 51.604], [8.302, 51.604], [8.302, 51.602]];
  const g = { type: 'Polygon', coordinates: [sq, hole] };
  assert.equal(pointInGeometry([8.305, 51.605], g), true);
  assert.equal(pointInGeometry([8.32, 51.605], g), false);
  assert.equal(pointInGeometry([8.303, 51.603], g), false);
  assert.equal(pointInGeometry([8.305, 51.605], { type: 'MultiPolygon', coordinates: [[sq]] }), true);
});

test('Entfernung und Richtung', () => {
  const a = { lat: 51.6, lng: 8.3 }, b = { lat: 51.61, lng: 8.3 };
  assert.ok(Math.abs(distance(a, b) - 1113) < 5);
  assert.ok(Math.abs(bearing(a, b) - 0) < 0.01);
  assert.ok(Math.abs(bearing(a, { lat: 51.6, lng: 8.31 }) - 90) < 0.1);
  assert.equal(compassName(359), 'N');
  assert.equal(compassName(225), 'SW');
});

test('Jagdjahr', () => {
  assert.equal(jagdjahr(new Date(2026, 2, 31)), '2025/26');
  assert.equal(jagdjahr(new Date(2026, 3, 1)), '2026/27');
  const r = jagdjahrRange('2026/27');
  assert.equal(new Date(r.from).getMonth(), 3);
  assert.equal(new Date(r.to).getFullYear(), 2027);
});

test('Ring öffnen/schließen', () => {
  assert.equal(openRing(sq).length, 4);
  assert.equal(closeRing(openRing(sq)).length, 5);
  assert.equal(closeRing(sq).length, 5);
});

test('formatArea', () => {
  assert.equal(formatArea(123456), '12,3 ha');
  assert.equal(formatArea(56789), '5,68 ha');
});

test('Zusammenführen: neuer gewinnt, Grabstein setzt sich durch', () => {
  const local = new Map([
    ['a', { id: 'a', kind: 'revier', updatedAt: 100 }],
    ['b', { id: 'b', kind: 'einrichtung', updatedAt: 300 }]
  ]);
  const out = mergeRecords(local, [
    { id: 'a', kind: 'revier', updatedAt: 200, deleted: true },
    { id: 'b', kind: 'einrichtung', updatedAt: 250 },
    { id: 'c', kind: 'ereignis', updatedAt: 1 },
    { id: 'd', kind: 'quatsch', updatedAt: 999 }
  ]);
  assert.deepEqual(out.map(r => r.id), ['a', 'c']);
});

test('Wiederherstellen: Zielstand mit frischem Zeitstempel, Rest wird Grabstein', () => {
  const current = [
    { id: 'a', kind: 'revier', name: 'neu umbenannt', updatedAt: 50 },
    { id: 'b', kind: 'einrichtung', updatedAt: 40 },          // nach der Version angelegt
    { id: 'c', kind: 'ereignis', deleted: true, updatedAt: 45 } // nach der Version gelöscht
  ];
  const version = [
    { id: 'a', kind: 'revier', name: 'Original', updatedAt: 10 },
    { id: 'c', kind: 'ereignis', wildart: 'Rehwild', updatedAt: 12 }
  ];
  const w = planRestore(current, version, 100, 'dev');
  const by = Object.fromEntries(w.map(r => [r.id, r]));
  assert.equal(by.a.name, 'Original'); assert.equal(by.a.updatedAt, 100);
  assert.equal(by.c.deleted, false); assert.equal(by.c.wildart, 'Rehwild');
  assert.equal(by.b.deleted, true); assert.equal(by.b.updatedAt, 100);
  // auf einem anderen Gerät gewinnt der wiederhergestellte Stand beim Abgleich
  const other = new Map(current.map(r => [r.id, r]));
  assert.equal(mergeRecords(other, w).length, 3);
});

test('Fingerabdruck und Zählung', () => {
  const r1 = [{ id: 'x', kind: 'revier', updatedAt: 1 }, { id: 'y', kind: 'ereignis', updatedAt: 2 }];
  assert.equal(signature(r1), signature([...r1].reverse()));
  assert.notEqual(signature(r1), signature([{ ...r1[0], updatedAt: 3 }, r1[1]]));
  assert.equal(signature(r1), signature([...r1, { id: 'z', kind: 'revier', deleted: true, updatedAt: 9 }]));
  assert.deepEqual(countKinds(r1), { revier: 1, einrichtung: 0, ereignis: 1 });
});

const { iosGap } = await import('../js/ui.js');
test('iOS-Ausgleich nur beim bekannten Fehlerbild', () => {
  // Fehlerbild: Fenster um genau die Statusleiste zu kurz
  assert.equal(iosGap({ standalone: true, safeTop: 62, screenH: 874, innerH: 812 }), 62);
  // korrekt: Fenster so hoch wie der Bildschirm
  assert.equal(iosGap({ standalone: true, safeTop: 62, screenH: 874, innerH: 874 }), 0);
  // Statusleiste deckend (Inhalt beginnt darunter): kein Ausgleich, sonst rutscht die Leiste aus dem Bild
  assert.equal(iosGap({ standalone: true, safeTop: 0, screenH: 874, innerH: 812 }), 0);
  // im normalen Safari (Adressleiste) nie
  assert.equal(iosGap({ standalone: false, safeTop: 62, screenH: 874, innerH: 700 }), 0);
});

const recs = [
  { id: 'r1', kind: 'revier', name: 'Feld & Wald <Nord>', color: '#43a047', notes: '', geometry: { type: 'Polygon', coordinates: [sq] }, updatedAt: 5 },
  { id: 'e1', kind: 'einrichtung', typ: 'kanzel', name: 'Kanzel 1', lat: 51.605, lng: 8.305, blick: 90, updatedAt: 5 },
  { id: 'v1', kind: 'ereignis', typ: 'abschuss', wildart: 'Rehwild', anzahl: 1, gewicht: 14.5, zeit: new Date(2026, 4, 10, 5, 30).getTime(), lat: 51.606, lng: 8.306, einrichtungId: 'e1', notes: 'Bock; "Knopfbock"', updatedAt: 5 },
  { id: 'x', kind: 'einrichtung', deleted: true, updatedAt: 9 }
];

test('GeoJSON Rundreise (eigenes Format, ohne Grabsteine)', () => {
  const gj = toGeoJSON(recs);
  assert.equal(gj.features.length, 3);
  const back = fromGeoJSON(JSON.stringify(gj));
  assert.equal(back.records.length, 3);
  const e = back.records.find(r => r.id === 'e1');
  assert.equal(e.lat, 51.605); assert.equal(e.blick, 90);
  assert.deepEqual(back.records.find(r => r.id === 'r1').geometry, recs[0].geometry);
});

test('Fremdes GeoJSON: Fläche -> Revier, Punkt -> Einrichtung, Linie übersprungen', () => {
  const res = fromGeoJSON({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'X' }, geometry: { type: 'Polygon', coordinates: [sq] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [8, 51] } },
    { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[8, 51], [8.1, 51]] } }
  ] });
  assert.deepEqual(res.records.map(r => r.kind), ['revier', 'einrichtung']);
  assert.equal(res.skipped, 1);
});

test('KML-Export: Escaping und Farbe in aabbggrr', () => {
  const k = toKML(recs);
  assert.ok(k.includes('Feld &amp; Wald &lt;Nord&gt;'));
  assert.ok(k.includes('<color>ff47a043</color>'));
  assert.ok(k.includes('8.3050000,51.6050000,0'));
});

test('GPX-Export enthält Wegpunkte und Track', () => {
  const g = toGPX(recs);
  assert.equal((g.match(/<wpt /g) || []).length, 2);
  assert.equal((g.match(/<trkpt /g) || []).length, 5);
});

test('CSV: BOM, Semikolon, Anführungszeichen, Dezimalkomma', () => {
  const c = toCSV([recs[2]], { revierName: () => 'R', einrichtungName: id => id === 'e1' ? 'Kanzel 1' : '' });
  assert.ok(c.startsWith('﻿Datum;'));
  const row = c.split('\r\n')[1];
  assert.ok(row.includes(';Abschuss;Rehwild;1;'));
  assert.ok(row.includes(';14,5;'));
  assert.ok(row.includes('"Bock; ""Knopfbock"""'));
  assert.ok(row.includes(';2026/27;'));
});

import { lng2x, lat2y, bbox3857, tileUrl, planPackage, tileRange, geomBounds, buffer as bufferB } from '../js/tiles.js';

const proj = (lat, lng) => [lng * Math.PI / 180 * 6378137, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 6378137];

test('Kachel enthält den Punkt (256 und 512, mehrere Zoomstufen)', () => {
  for (const ts of [256, 512]) for (const z of [8, 13, 16, 19]) {
    const lat = 51.6789, lng = 8.3456, x = lng2x(lng, z, ts), y = lat2y(lat, z, ts);
    const [minx, miny, maxx, maxy] = bbox3857(z, x, y, ts), [px, py] = proj(lat, lng);
    assert.ok(px >= minx && px <= maxx && py >= miny && py <= maxy, `ts=${ts} z=${z}`);
  }
  assert.equal(lng2x(8.3, 16), Math.floor(188.3 / 360 * 65536));
});

test('Kachel-URLs: XYZ mit Subdomain wie Leaflet, WMS mit BBOX', () => {
  const otm = { type: 'xyz', url: 'https://{s}.t.de/{z}/{x}/{y}.png', subdomains: 'abc' };
  assert.equal(tileUrl(otm, 5, 2, 3), 'https://c.t.de/5/2/3.png');
  const wms = { type: 'wms', url: 'https://w.de/wms', layers: 'nw_dop_rgb', format: 'image/jpeg', transparent: false, tileSize: 512 };
  const u = tileUrl(wms, 1, 0, 0);
  assert.ok(u.includes('CRS=EPSG:3857') && u.includes('WIDTH=512') && u.includes('LAYERS=nw_dop_rgb') && u.includes('FORMAT=image%2Fjpeg'));
  assert.ok(u.endsWith('BBOX=-20037508.34,-20037508.34,20037508.34,20037508.34'), u);
});

test('Paketplan: Zählung = erzeugte URLs, Begrenzung auf NRW', () => {
  const b = bufferB(geomBounds({ type: 'Polygon', coordinates: [sq] }), 300);
  const base = { id: 'b', type: 'xyz', url: 'https://x/{z}/{x}/{y}.png' };
  const nrw = { id: 'n', type: 'wms', url: 'https://w', layers: 'l', format: 'image/png', tileSize: 512, bounds: [[50.3, 5.85], [52.55, 9.5]] };
  const plan = planPackage(b, [{ cfg: base, minZoom: 12, maxZoom: 16 }, { cfg: nrw, minZoom: 14, maxZoom: 18 }]);
  assert.equal([...plan.urls()].length, plan.total);
  assert.equal(new Set(plan.urls()).size, plan.total);
  const outside = planPackage([[48, 11], [48.1, 11.1]], [{ cfg: nrw, minZoom: 14, maxZoom: 15 }]);
  assert.equal(outside.total, 0);
  const r = tileRange(b, 16);
  assert.ok(r.x1 >= r.x0 && r.y1 >= r.y0);
});

console.log(`\n${n} Tests bestanden`);
