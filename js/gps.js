// GPS-Position und Kompass über Browser-Schnittstellen.
//
// GPS:     navigator.geolocation.watchPosition – liefert Position + Genauigkeit,
//          solange die App im Vordergrund ist (kein Hintergrund-Tracking im Browser).
// Kompass: DeviceOrientation-Ereignis. iOS liefert direkt "webkitCompassHeading"
//          (0° = magnetisch Nord, im Uhrzeigersinn) und verlangt vorher eine
//          Erlaubnis, die nur nach einem Tipp des Nutzers abgefragt werden darf.
//          Android/Chrome liefert "deviceorientationabsolute" mit alpha (gegen den
//          Uhrzeigersinn), daher heading = 360 - alpha.
//          Missweisung in Deutschland ca. +3° – für die Jagdpraxis vernachlässigbar.

export class Positioning {
  constructor({ onPosition, onError, onHeading } = {}) {
    this.onPosition = onPosition || (() => {});
    this.onError = onError || (() => {});
    this.onHeading = onHeading || (() => {});
    this.watchId = null;
    this.last = null;           // letzte Position {lat, lng, accuracy, heading, speed, time}
    this.heading = null;        // geglättete Kompassrichtung in Grad
    this._vec = null;           // geglätteter Richtungsvektor (für Mittelung über 0°/360°)
    this._orientHandler = this._handleOrientation.bind(this);
    this._orientEvent = null;
  }

  get gpsActive() { return this.watchId !== null; }
  get compassActive() { return this._orientEvent !== null; }

  startGPS() {
    if (!('geolocation' in navigator)) {
      this.onError(new Error('Dieses Gerät/dieser Browser bietet kein GPS an.'));
      return false;
    }
    if (this.watchId !== null) return true;
    this.watchId = navigator.geolocation.watchPosition(
      pos => {
        const c = pos.coords;
        this.last = {
          lat: c.latitude, lng: c.longitude, accuracy: c.accuracy,
          altitude: c.altitude, heading: c.heading, speed: c.speed, time: pos.timestamp
        };
        this.onPosition(this.last);
      },
      err => {
        const msg = {
          1: 'Standortzugriff verweigert. Bitte in den Einstellungen erlauben (iPhone: Einstellungen → Datenschutz → Ortungsdienste → Safari-Websites).',
          2: 'Position nicht verfügbar (kein GPS-Empfang?).',
          3: 'Zeitüberschreitung bei der Positionsbestimmung.'
        }[err.code] || err.message;
        this.onError(new Error(msg));
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
    );
    return true;
  }

  stopGPS() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  }

  /** Muss direkt aus einem Klick/Tipp heraus aufgerufen werden (iOS-Vorgabe). */
  async startCompass() {
    if (this._orientEvent) return true;
    if (typeof DeviceOrientationEvent === 'undefined') {
      this.onError(new Error('Kein Kompass verfügbar.'));
      return false;
    }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const state = await DeviceOrientationEvent.requestPermission();
        if (state !== 'granted') {
          this.onError(new Error('Zugriff auf den Kompass wurde nicht erlaubt.'));
          return false;
        }
      } catch (e) {
        this.onError(new Error('Kompass-Erlaubnis konnte nicht angefragt werden: ' + e.message));
        return false;
      }
    }
    this._orientEvent = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(this._orientEvent, this._orientHandler, true);
    return true;
  }

  stopCompass() {
    if (this._orientEvent) window.removeEventListener(this._orientEvent, this._orientHandler, true);
    this._orientEvent = null;
    this.heading = null;
    this._vec = null;
    this.onHeading(null);
  }

  _handleOrientation(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading;                       // iOS
    } else if (e.alpha !== null && e.alpha !== undefined && (e.absolute || this._orientEvent === 'deviceorientationabsolute')) {
      h = 360 - e.alpha;                                // Android/Chrome
    }
    if (h === null) return;
    // Bildschirm gedreht (Querformat)? Dann zeigt "oben" nicht mehr zur Geräteoberkante.
    const screenAngle = (screen.orientation && typeof screen.orientation.angle === 'number')
      ? screen.orientation.angle : (window.orientation || 0);
    h = (h + screenAngle + 360) % 360;

    // Glättung als Vektor, damit der Sprung 359° -> 1° nicht zu einem Mittelwert von 180° führt
    const rad = h * Math.PI / 180;
    const v = [Math.sin(rad), Math.cos(rad)];
    const k = 0.25;
    this._vec = this._vec ? [this._vec[0] * (1 - k) + v[0] * k, this._vec[1] * (1 - k) + v[1] * k] : v;
    this.heading = (Math.atan2(this._vec[0], this._vec[1]) * 180 / Math.PI + 360) % 360;
    this.onHeading(this.heading);
  }
}
