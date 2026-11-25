// Einfacher Polygon-Editor für Reviergrenzen (bewusst selbst geschrieben statt Plugin,
// damit die Logik nachvollziehbar und auf dem iPhone gut bedienbar bleibt).
//
// Bedienung:
//  * Neu zeichnen: auf die Karte tippen = Eckpunkt hinzufügen (oder "GPS-Punkt").
//  * Eckpunkt verschieben: ziehen.
//  * Eckpunkt auswählen: antippen -> "Punkt löschen" in der Werkzeugleiste.
//  * Zwischenpunkt einfügen: kleinen Halbkreis-Punkt in der Mitte einer Kante antippen.
//
// Intern: this.points = Array von L.LatLng (offener Ring, ohne Schlusspunkt).

/* global L */

export class PolygonEditor {
  constructor(map, { onChange } = {}) {
    this.map = map;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.points = [];
    this.selected = -1;
    this.color = '#e53935';
    this.group = L.layerGroup();
    this._onMapClick = this._onMapClick.bind(this);
    this._vertexIcon = sel => L.divIcon({ className: 'vx' + (sel ? ' vx-sel' : ''), iconSize: [28, 28] });
    this._midIcon = L.divIcon({ className: 'vx-mid', iconSize: [22, 22] });
  }

  /** @param ring optional: vorhandener Ring als [[lng,lat],...] */
  start(ring = null, color = '#e53935') {
    this.stop();
    this.active = true;
    this.color = color;
    this.points = (ring || []).map(([lng, lat]) => L.latLng(lat, lng));
    // offenen Ring sicherstellen
    if (this.points.length > 1 && this.points[0].equals(this.points[this.points.length - 1])) this.points.pop();
    this.selected = -1;
    this.group.addTo(this.map);
    this.map.on('click', this._onMapClick);
    this._dblWasEnabled = this.map.doubleClickZoom.enabled();
    this.map.doubleClickZoom.disable();
    this.map.getContainer().classList.add('drawing');
    this._render();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.map.off('click', this._onMapClick);
    if (this._dblWasEnabled) this.map.doubleClickZoom.enable();
    this.map.getContainer().classList.remove('drawing');
    this.group.clearLayers();
    this.group.remove();
  }

  addVertex(latlng) {
    if (!this.active) return;
    this.points.push(L.latLng(latlng.lat, latlng.lng));
    this.selected = -1;
    this._render();
  }

  undo() {
    if (!this.points.length) return;
    this.points.pop();
    this.selected = -1;
    this._render();
  }

  deleteSelected() {
    if (this.selected < 0) return false;
    this.points.splice(this.selected, 1);
    this.selected = -1;
    this._render();
    return true;
  }

  get count() { return this.points.length; }

  /** Ergebnis als geschlossener GeoJSON-Ring [[lng,lat],...] oder null (< 3 Punkte) */
  result() {
    if (this.points.length < 3) return null;
    const ring = this.points.map(p => [round7(p.lng), round7(p.lat)]);
    ring.push([...ring[0]]);
    return ring;
  }

  _onMapClick(e) {
    this.addVertex(e.latlng);
  }

  _render() {
    this.group.clearLayers();
    const style = { color: this.color, weight: 3, fillOpacity: 0.15, interactive: false, dashArray: '6 4' };
    if (this.points.length >= 3) {
      this._shape = L.polygon(this.points, style).addTo(this.group);
    } else if (this.points.length === 2) {
      this._shape = L.polyline(this.points, style).addTo(this.group);
    } else {
      this._shape = null;
    }

    // Zwischenpunkte (zum Einfügen)
    this._mids = [];
    const n = this.points.length;
    const edges = n >= 3 ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const a = this.points[i], b = this.points[(i + 1) % n];
      const m = L.marker(midpoint(a, b), { icon: this._midIcon, zIndexOffset: 500 }).addTo(this.group);
      m.on('click', ev => {
        L.DomEvent.stop(ev);
        this.points.splice(i + 1, 0, m.getLatLng());
        this.selected = i + 1;
        this._render();
      });
      this._mids.push(m);
    }

    // Eckpunkte (verschiebbar, antippen = auswählen)
    this.points.forEach((p, i) => {
      const v = L.marker(p, { icon: this._vertexIcon(i === this.selected), draggable: true, zIndexOffset: 1000 }).addTo(this.group);
      v.on('drag', () => {
        this.points[i] = v.getLatLng();
        if (this._shape) this._shape.setLatLngs(this.points);
        this._updateMids();
      });
      v.on('dragend', () => { this._lastDrag = Date.now(); this._render(); });
      v.on('click', ev => {
        L.DomEvent.stop(ev);
        if (this._lastDrag && Date.now() - this._lastDrag < 400) return; // Klick nach Ziehen ignorieren
        this.selected = (this.selected === i) ? -1 : i;
        this._render();
      });
    });
    this.onChange({ count: this.points.length, selected: this.selected });
  }

  _updateMids() {
    const n = this.points.length;
    this._mids.forEach((m, i) => m.setLatLng(midpoint(this.points[i], this.points[(i + 1) % n])));
  }
}

function midpoint(a, b) {
  return L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
}

function round7(x) {
  return Math.round(x * 1e7) / 1e7;
}
