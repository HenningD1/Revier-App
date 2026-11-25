// Tests für den OneDrive-Abgleich mit simuliertem OneDrive (ohne Netz): node tests/sync.test.mjs
import assert from 'node:assert/strict';
const mem = {};
globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };

const { challengeOf, syncOnce, OneDrive, ConflictError, remoteUpToDate } = await import('../js/sync.js');
const { mergeRecords } = await import('../js/store.js');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await test('PKCE: Testvektor aus RFC 7636', async () => {
  assert.equal(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

// Simuliertes Gerät: Speicher mit derselben Merge-Logik wie store.js
function device(name) {
  const m = new Map();
  return {
    m,
    getDeviceId: () => name,
    snapshot: () => [...m.values()],
    async importRecords(recs) { const w = mergeRecords(m, recs); w.forEach(r => m.set(r.id, r)); return w.length; },
    put(r) { m.set(r.id, { ...r, kind: r.kind || 'einrichtung', updatedAt: r.updatedAt }); }
  };
}
// Simuliertes OneDrive mit eTag-Prüfung
function cloud() {
  const c = { records: null, etag: 0, pushes: 0,
    async pull() { return { records: c.records ? JSON.parse(JSON.stringify(c.records)) : [], etag: c.records ? String(c.etag) : null }; },
    async push(recs, etag) {
      if (c.records && etag !== String(c.etag)) throw new ConflictError('412');
      c.records = JSON.parse(JSON.stringify(recs)); c.etag++; c.pushes++; return String(c.etag);
    } };
  return c;
}

await test('Zwei Geräte: Einträge beider Seiten landen überall, neuere Änderung gewinnt', async () => {
  const cl = cloud(), A = device('A'), B = device('B');
  A.put({ id: '1', name: 'Kanzel', updatedAt: 10 });
  B.put({ id: '2', name: 'Kirrung', updatedAt: 11 });
  await syncOnce(cl, A); await syncOnce(cl, B); await syncOnce(cl, A);
  assert.deepEqual([...A.m.keys()].sort(), ['1', '2']);
  assert.deepEqual([...B.m.keys()].sort(), ['1', '2']);
  B.put({ id: '1', name: 'Kanzel Eiche', updatedAt: 20 });       // B ändert
  A.put({ id: '1', kind: 'einrichtung', deleted: true, updatedAt: 15 }); // A löscht früher
  await syncOnce(cl, A); await syncOnce(cl, B); await syncOnce(cl, A);
  assert.equal(A.m.get('1').name, 'Kanzel Eiche');
  assert.equal(A.m.get('1').deleted, undefined);
});

await test('Löschung (Grabstein) wird übertragen', async () => {
  const cl = cloud(), A = device('A'), B = device('B');
  A.put({ id: 'x', name: 'Falle', updatedAt: 1 });
  await syncOnce(cl, A); await syncOnce(cl, B);
  B.put({ id: 'x', kind: 'einrichtung', deleted: true, updatedAt: 5 });
  await syncOnce(cl, B); await syncOnce(cl, A);
  assert.equal(A.m.get('x').deleted, true);
});

await test('Konflikt (412): neu holen, zusammenführen, erneut schreiben', async () => {
  const cl = cloud(), A = device('A');
  cl.records = [{ id: 'r', kind: 'revier', updatedAt: 1 }]; cl.etag = 1;
  A.put({ id: 'a', updatedAt: 2 });
  let first = true;
  const racy = { pull: cl.pull, async push(recs, etag) {
    if (first) { first = false; cl.records.push({ id: 'b', kind: 'einrichtung', updatedAt: 3 }); cl.etag++; }
    return cl.push(recs, etag); } };
  await syncOnce(racy, A);
  assert.deepEqual(cl.records.map(r => r.id).sort(), ['a', 'b', 'r']);
  assert.deepEqual([...A.m.keys()].sort(), ['a', 'b', 'r']);
});

await test('Nichts geändert -> kein erneutes Hochladen', async () => {
  const cl = cloud(), A = device('A');
  A.put({ id: '1', updatedAt: 1 });
  await syncOnce(cl, A);
  const p = cl.pushes;
  const r = await syncOnce(cl, A);
  assert.equal(r.pushed, false); assert.equal(cl.pushes, p);
  assert.equal(remoteUpToDate([{ id: '1', updatedAt: 1 }], [{ id: '1', updatedAt: 2 }]), false);
});

await test('Graph-Aufrufe: Token-Erneuerung, App-Ordner, If-Match', async () => {
  mem['jagd.sync.refresh'] = 'RT'; delete mem['jagd.sync.access'];
  const calls = [];
  const fake = async (url, opt = {}) => {
    calls.push([url, opt]);
    const J = (o, st = 200) => ({ ok: st < 300, status: st, json: async () => o });
    if (url.endsWith('/token')) return J({ access_token: 'AT', expires_in: 3600, refresh_token: 'RT2' });
    if (url.includes('/approot:/revier-daten.json:/content')) return J({ eTag: 'E2' });
    if (url.includes('/approot:/revier-daten.json')) return J({ eTag: 'E1', '@microsoft.graph.downloadUrl': 'https://dl/x' });
    if (url === 'https://dl/x') return J({ records: [{ id: 'q', kind: 'revier', updatedAt: 1 }] });
    return J({}, 404);
  };
  const od = new OneDrive({ clientId: '11111111-2222-3333-4444-555555555555', fetchImpl: fake });
  const p = await od.pull();
  assert.equal(p.etag, 'E1'); assert.equal(p.records[0].id, 'q');
  assert.equal(mem['jagd.sync.refresh'], 'RT2');
  const tokenBody = calls[0][1].body.toString();
  assert.ok(tokenBody.includes('grant_type=refresh_token') && tokenBody.includes('Files.ReadWrite.AppFolder'));
  const e = await od.push([{ id: 'q' }], 'E1', 'dev');
  assert.equal(e, 'E2');
  const put = calls.find(c => c[1].method === 'PUT');
  assert.equal(put[1].headers['If-Match'], 'E1');
  assert.equal(put[1].headers.Authorization, 'Bearer AT');
});

console.log(`\n${n} Sync-Tests bestanden`);
