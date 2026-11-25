// Stufe 2: Abgleich über OneDrive (Microsoft Graph), ohne Fremdbibliothek.
//
// Anmeldung: OAuth 2.0 "Authorization Code Flow mit PKCE" – der Standard für Web-Apps ohne Server.
//   1. App erzeugt ein Zufalls-Geheimnis (code_verifier) und schickt nur dessen Hash
//      (code_challenge) mit zur Microsoft-Anmeldeseite.
//   2. Nach der Anmeldung leitet Microsoft mit einem einmaligen ?code=… zurück.
//   3. Die App tauscht code + code_verifier gegen ein Zugriffstoken (1 h gültig) und ein
//      Erneuerungstoken (für Web-Apps max. 24 h gültig, danach erneut anmelden).
//
// Speicherort: der App-Ordner im eigenen OneDrive ("Apps/<App-Name>/revier-daten.json").
// Die Berechtigung Files.ReadWrite.AppFolder erlaubt NUR diesen Ordner – die App sieht
// sonst nichts von deinem OneDrive.
//
// Abgleich: Datei holen -> mit lokalen Daten zusammenführen (jüngster Stand je Eintrag gewinnt,
// siehe store.mergeRecords) -> Gesamtstand zurückschreiben. Damit zwei Geräte sich nicht
// gegenseitig überschreiben, wird mit "If-Match: <eTag>" geschrieben: hat ein anderes Gerät
// die Datei inzwischen geändert, antwortet OneDrive mit 412, und der Abgleich beginnt von vorn.

const AUTH = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.ReadWrite.AppFolder offline_access User.Read';
export const FILE_NAME = 'revier-daten.json';
const LS = 'jagd.sync.';

const lsGet = k => { try { return localStorage.getItem(LS + k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { v === null ? localStorage.removeItem(LS + k) : localStorage.setItem(LS + k, v); } catch (_) { /* ignore */ } };

export class ConflictError extends Error {}
export class AuthError extends Error {}

// --- PKCE-Hilfen ------------------------------------------------------------
function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function randomVerifier() {
  const a = new Uint8Array(48);
  crypto.getRandomValues(a);
  return b64url(a);
}
export async function challengeOf(verifier) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(hash));
}

/** Weiterleitungsadresse = Adresse der App ohne Parameter (muss exakt so registriert sein) */
export function redirectUri(loc = location) {
  return loc.origin + loc.pathname.replace(/index\.html$/, '');
}

export class OneDrive {
  constructor({ clientId, fetchImpl } = {}) {
    this.clientId = clientId || lsGet('clientId') || '';
    this.fetch = fetchImpl || ((...a) => fetch(...a));
  }

  get configured() { return !!this.clientId; }
  get signedIn() { return !!lsGet('refresh') || !!lsGet('access'); }
  get account() { return lsGet('account') || ''; }

  setClientId(id) {
    this.clientId = (id || '').trim();
    lsSet('clientId', this.clientId || null);
  }

  /** Schritt 1: zur Microsoft-Anmeldung weiterleiten */
  async login() {
    if (!this.clientId) throw new Error('Bitte zuerst die Anwendungs-ID (Client-ID) eintragen.');
    const verifier = randomVerifier();
    const st = randomVerifier().slice(0, 16);
    lsSet('verifier', verifier);
    lsSet('state', st);
    const p = new URLSearchParams({
      client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri(),
      scope: SCOPE, state: st, code_challenge: await challengeOf(verifier),
      code_challenge_method: 'S256', prompt: 'select_account'
    });
    location.assign(`${AUTH}/authorize?${p}`);
  }

  /** Schritt 2+3: beim App-Start aufrufen; verarbeitet ?code=… nach der Rückleitung */
  async handleRedirect(loc = location) {
    const q = new URLSearchParams(loc.search);
    if (!q.has('code') && !q.has('error')) return false;
    try { history.replaceState(null, '', redirectUri(loc)); } catch (_) { /* ignore */ }
    if (q.has('error')) throw new AuthError(q.get('error_description') || q.get('error'));
    if (q.get('state') !== lsGet('state')) throw new AuthError('Anmeldung ungültig (state passt nicht).');
    await this.tokenRequest({
      grant_type: 'authorization_code', code: q.get('code'),
      redirect_uri: redirectUri(loc), code_verifier: lsGet('verifier') || ''
    });
    lsSet('verifier', null); lsSet('state', null);
    try {
      const me = await this.graph('/me');
      lsSet('account', me.userPrincipalName || me.mail || me.displayName || '');
    } catch (_) { /* nicht wichtig */ }
    return true;
  }

  async tokenRequest(params) {
    const body = new URLSearchParams({ client_id: this.clientId, scope: SCOPE, ...params });
    const res = await this.fetch(`${AUTH}/token`, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(j.error_description || j.error || ('Token-Fehler ' + res.status));
    lsSet('access', j.access_token);
    lsSet('expires', String(Date.now() + (j.expires_in || 3600) * 1000 - 60000));
    if (j.refresh_token) lsSet('refresh', j.refresh_token);
    return j.access_token;
  }

  /** gültiges Zugriffstoken (erneuert bei Bedarf) */
  async token() {
    const exp = +(lsGet('expires') || 0);
    if (lsGet('access') && Date.now() < exp) return lsGet('access');
    const rt = lsGet('refresh');
    if (!rt) throw new AuthError('Nicht angemeldet');
    try {
      return await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
    } catch (e) {
      this.logout(true);
      throw new AuthError('Anmeldung abgelaufen – bitte erneut bei OneDrive anmelden.');
    }
  }

  logout(keepAccount = false) {
    ['access', 'refresh', 'expires', 'etag'].forEach(k => lsSet(k, null));
    if (!keepAccount) lsSet('account', null);
  }

  async graph(path, opt = {}) {
    const res = await this.fetch(GRAPH + path, { ...opt, headers: { Authorization: 'Bearer ' + await this.token(), ...(opt.headers || {}) } });
    if (res.status === 401) { lsSet('access', null); throw new AuthError('Zugriff verweigert (401)'); }
    if (!res.ok) { const e = new Error('Graph ' + res.status); e.status = res.status; throw e; }
    return res.status === 204 ? null : res.json();
  }

  /** Datei lesen -> { records, etag } ; fehlt sie noch -> { records: [], etag: null } */
  async pull() {
    let item;
    try {
      item = await this.graph(`/me/drive/special/approot:/${FILE_NAME}`);
    } catch (e) {
      if (e.status === 404) return { records: [], etag: null };
      throw e;
    }
    // Der Download-Link ist vorab berechtigt (kein Token nötig) und erlaubt CORS
    const res = await this.fetch(item['@microsoft.graph.downloadUrl']);
    if (!res.ok) throw new Error('Download fehlgeschlagen ' + res.status);
    const data = await res.json();
    return { records: Array.isArray(data.records) ? data.records : [], etag: item.eTag || null };
  }

  /** Datei schreiben; bei fremder Änderung seit dem Lesen -> ConflictError */
  async push(records, etag, device) {
    const body = JSON.stringify({ schema: 1, app: 'revier', savedAt: new Date().toISOString(), device, records });
    const headers = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;           // nur schreiben, wenn seit dem Lesen unverändert
    try {
      const item = await this.graph(`/me/drive/special/approot:/${FILE_NAME}:/content`, { method: 'PUT', body, headers });
      return item && item.eTag;
    } catch (e) {
      if (e.status === 412 || e.status === 409) throw new ConflictError('Datei wurde zwischenzeitlich geändert');
      throw e;
    }
  }
}

/** true, wenn der entfernte Stand bereits alles Lokale in gleicher Version enthält */
export function remoteUpToDate(remote, local) {
  if (remote.length !== local.length) return false;
  const m = new Map(remote.map(r => [r.id, r.updatedAt || 0]));
  return local.every(r => m.get(r.id) === (r.updatedAt || 0));
}

/**
 * Ein kompletter Abgleich.
 * @param api    OneDrive-Instanz (oder Testdouble mit pull/push)
 * @param store  Modul js/store.js (importRecords, snapshot, getDeviceId)
 */
export async function syncOnce(api, store) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { records, etag } = await api.pull();
    const pulled = await store.importRecords(records, { keepTimestamps: true });
    const local = store.snapshot();
    if (remoteUpToDate(records, local)) return { pulled, pushed: false };
    try {
      await api.push(local, etag, store.getDeviceId());
      return { pulled, pushed: true };
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      // anderes Gerät war schneller: neu holen, zusammenführen, nochmal schreiben
    }
  }
  throw new Error('Abgleich nach 3 Versuchen nicht möglich (Datei ändert sich ständig).');
}
