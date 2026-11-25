// Minimaler Leaflet-Ersatz NUR für automatische Tests ohne Internet.
// Bildet die Teile der Leaflet-API nach, die die App nutzt, und rendert Popups ins DOM.
(function () {
  class Evented {
    constructor() { this._ev = {}; }
    on(types, fn) { types.split(' ').forEach(t => (this._ev[t] = this._ev[t] || []).push(fn)); return this; }
    off(types, fn) { types.split(' ').forEach(t => { this._ev[t] = (this._ev[t] || []).filter(f => f !== fn); }); return this; }
    fire(t, data = {}) { (this._ev[t] || []).slice().forEach(f => f({ type: t, target: this, ...data })); return this; }
  }
  const latLng = (a, b) => {
    if (a && typeof a === 'object' && 'lat' in a) return mk(a.lat, a.lng);
    if (Array.isArray(a)) return mk(a[0], a[1]);
    return mk(a, b);
  };
  function mk(lat, lng) { return { lat, lng, equals(o) { return o && o.lat === lat && o.lng === lng; } }; }
  function flat(x) {
    if (Array.isArray(x) && typeof x[0] === 'number') return [latLng(x)];
    if (x && typeof x === 'object' && 'lat' in x) return [latLng(x)];
    return Array.isArray(x) ? x.flatMap(flat) : [];
  }
  class Bounds {
    constructor(pts = []) { this.pts = []; pts.forEach(p => this.extend(p)); }
    extend(p) { if (p instanceof Bounds) this.pts.push(...p.pts); else if (Array.isArray(p) && Array.isArray(p[0])) p.forEach(q => this.extend(q)); else this.pts.push(latLng(p)); return this; }
    isValid() { return this.pts.length > 0; }
  }
  class Layer extends Evented {
    constructor(opts = {}) { super(); this.options = opts; this._map = null; }
    addTo(m) { m.addLayer(this); return this; }
    remove() { if (this._map) this._map.removeLayer(this); return this; }
    bindTooltip() { return this; }
  }
  class Group extends Layer {
    constructor() { super(); this.layers = new Set(); }
    addLayer(l) { this.layers.add(l); l._group = this; return this; }
    clearLayers() { this.layers.clear(); return this; }
  }
  class Marker extends Layer {
    constructor(ll, opts = {}) { super(opts); this._ll = latLng(ll); }
    getLatLng() { return this._ll; }
    setLatLng(ll) { this._ll = latLng(ll); return this; }
    getElement() {
      if (!this._el) { this._el = document.createElement('div'); this._el.innerHTML = (this.options.icon && this.options.icon.html) || ''; }
      return this._el;
    }
  }
  class Path extends Layer {
    constructor(ll, opts) { super(opts); this._ll = ll; }
    setLatLngs(ll) { this._ll = ll; return this; }
    getBounds() { return new Bounds(flat(this._ll)); }
    setLatLng() { return this; }
    setRadius() { return this; }
  }
  class Popup extends Layer {
    setLatLng(ll) { this._latlng = latLng(ll); return this; }
    setContent(html) { this._html = html; return this; }
    getElement() { return this._el; }
    openOn(map) {
      map.closePopup();
      const el = document.createElement('div');
      el.className = 'leaflet-popup mock-popup';
      el.innerHTML = this._html;
      el.addEventListener('click', e => e.stopPropagation()); // wie Leaflet
      map.getContainer().appendChild(el);
      this._el = el;
      map._popup = this;
      map.fire('popupopen', { popup: this });
      return this;
    }
  }
  class Handler { constructor() { this._on = true; } enabled() { return this._on; } enable() { this._on = true; } disable() { this._on = false; } }
  class Map extends Evented {
    constructor(id, opts) {
      super();
      this._c = document.getElementById(id);
      this._center = latLng(opts.center); this._zoom = opts.zoom;
      this.layers = new Set();
      this.doubleClickZoom = new Handler();
      this.attributionControl = { setPrefix() {} };
      window.__map = this;
    }
    getContainer() { return this._c; }
    addLayer(l) { this.layers.add(l); l._map = this; return this; }
    removeLayer(l) { this.layers.delete(l); l._map = null; return this; }
    hasLayer(l) { return this.layers.has(l); }
    getCenter() { return this._center; }
    getBounds() { const c = this._center, d = 0.01; return { getSouth: () => c.lat - d, getNorth: () => c.lat + d, getWest: () => c.lng - d, getEast: () => c.lng + d }; }
    getZoom() { return this._zoom; }
    setView(ll, z) { this._center = latLng(ll); if (z !== undefined) this._zoom = z; this.fire('moveend'); return this; }
    panTo(ll) { return this.setView(ll); }
    fitBounds() { this.fire('moveend'); return this; }
    closePopup() { if (this._popup && this._popup._el) this._popup._el.remove(); this._popup = null; return this; }
  }
  const ctl = () => ({ addTo() { return this; } });
  const L = {
    map: (id, o) => new Map(id, o),
    tileLayer: (url, o) => Object.assign(new Layer(o), { url }),
    latLng, latLngBounds: p => new Bounds(p || []),
    featureGroup: () => new Group(), layerGroup: () => new Group(),
    polygon: (ll, o) => new Path(ll, o), polyline: (ll, o) => new Path(ll, o), circle: (ll, o) => new Path(ll, o),
    marker: (ll, o) => new Marker(ll, o),
    divIcon: o => o,
    popup: o => new Popup(o),
    control: { zoom: ctl, scale: ctl, layers: ctl },
    DomEvent: { stop() {} }
  };
  L.tileLayer.wms = (url, o) => Object.assign(new Layer(o), { url });
  L.TileLayer = { extend(proto) { return function (url, o) { const l = new Layer(o); Object.assign(l, proto); l.url = url; return l; }; } };
  window.L = L;
})();
