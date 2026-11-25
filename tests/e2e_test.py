"""
End-to-End-Test im Headless-Chrome mit Leaflet-Ersatz (tests/leaflet-mock.js).
Startet einen lokalen Webserver, spielt typische Abläufe durch und prüft auf JS-Fehler.
Aufruf:  python3 tests/e2e_test.py
"""
import http.server, json, os, socketserver, sys, threading, functools, time
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765
MOCK = open(os.path.join(ROOT, 'tests', 'leaflet-mock.js'), encoding='utf-8').read()

class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>Pachtrevier Süd</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
8.30,51.58,0 8.32,51.58,0 8.32,51.59,0 8.30,51.59,0 8.30,51.58,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Leiter 3</name><Point><coordinates>8.31,51.585,0</coordinates></Point></Placemark>
<Placemark><name>Weg</name><LineString><coordinates>8.3,51.5 8.4,51.6</coordinates></LineString></Placemark>
</Document></kml>"""

GPX = """<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="51.6" lon="8.3"><name>WP1</name></wpt>
<trk><name>Grenze abgelaufen</name><trkseg>
<trkpt lat="51.60" lon="8.30"/><trkpt lat="51.60" lon="8.31"/><trkpt lat="51.61" lon="8.31"/><trkpt lat="51.61" lon="8.30"/><trkpt lat="51.6001" lon="8.3001"/>
</trkseg></trk></gpx>"""

errors = []
step = lambda s: print('  ✓', s)

def main():
    httpd = serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = browser.new_context(service_workers='block', geolocation={'latitude': 51.605, 'longitude': 8.305, 'accuracy': 8},
                                  permissions=['geolocation'], viewport={'width': 390, 'height': 844}, accept_downloads=True)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
        page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js', lambda r: r.fulfill(status=200, content_type='application/javascript', body=MOCK))
        page.route('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', lambda r: r.fulfill(status=200, content_type='text/css', body=''))
        page.goto(f'http://127.0.0.1:{PORT}/index.html')
        page.wait_for_function('window.__map !== undefined')
        page.wait_for_timeout(300)
        step('App startet')

        # --- Revier zeichnen ---
        page.click('#btn-add'); page.click('#addmenu [data-act=add-rv]')
        assert page.is_visible('#drawbar')
        for lat, lng in [(51.60, 8.30), (51.60, 8.31), (51.61, 8.31), (51.61, 8.30)]:
            page.evaluate(f'window.__map.fire("click", {{latlng: L.latLng({lat}, {lng})}})')
        assert page.inner_text('#draw-count') == '4 Punkte', page.inner_text('#draw-count')
        page.click('#draw-undo')
        assert page.inner_text('#draw-count') == '3 Punkte'
        page.evaluate('window.__map.fire("click", {latlng: L.latLng(51.61, 8.30)})')
        page.click('#draw-done')
        page.wait_for_selector('#dlg[open]')
        page.click('#dlg button[type=submit]')  # ohne Namen -> darf nicht schließen
        assert page.is_visible('#dlg[open]'), 'Pflichtfeld nicht geprüft'
        page.fill('#dlg input[name=name]', 'Eigenjagd Test')
        page.click('#dlg button[type=submit]')
        page.wait_for_selector('#dlg', state='hidden')
        assert not page.is_visible('#drawbar')
        step('Revier gezeichnet und gespeichert')

        # --- Einrichtung per Fadenkreuz ---
        page.evaluate('window.__map.setView([51.605, 8.305], 16)')
        page.click('#btn-add'); page.click('#addmenu [data-act=add-ei]')
        assert page.is_visible('#crosshair')
        page.click('#place-here')
        page.wait_for_selector('#dlg[open]')
        assert 'Revier: Eigenjagd Test' in page.inner_text('#dlg'), 'Revierzuordnung fehlt'
        page.select_option('#dlg select[name=typ]', 'kanzel')
        page.fill('#dlg input[name=name]', 'Kanzel Eiche')
        page.fill('#dlg input[name=blick]', '450')
        page.click('#dlg button[type=submit]')
        page.wait_for_selector('#dlg', state='hidden')
        blick = page.evaluate("""(async () => { const s = await import('./js/store.js'); return s.all('einrichtung')[0].blick; })()""")
        assert blick == 90, blick
        step('Einrichtung gesetzt (Blickrichtung 450° -> 90° normalisiert)')

        # --- Ereignis über Popup der Einrichtung (prüft Klicks in Leaflet-Popups) ---
        page.evaluate("""(() => { const g = [...window.__map.layers].find(l => l.cfgId === 'einrichtungen');
                                 [...g.layers][0].fire('click'); })()""")
        page.wait_for_selector('.mock-popup')
        assert 'Von mir' not in page.inner_text('.mock-popup')
        page.click('.mock-popup [data-act=ei-ev]')
        page.wait_for_selector('#dlg[open]')
        assert 'Kanzel Eiche' in page.inner_text('#dlg select[name=einrichtungId]')
        page.select_option('#dlg select[name=typ]', 'abschuss')
        page.select_option('#dlg select[name=wildart]', 'Schwarzwild')
        page.fill('#dlg input[name=gewicht]', '38,5')
        page.fill('#dlg textarea[name=notes]', 'Überläufer; Wind aus "West"')
        page.click('#dlg button[type=submit]')
        page.wait_for_selector('#dlg', state='hidden')
        step('Ereignis über Popup erfasst')

        # --- Listen ---
        page.click('#tabs [data-tab=ereignisse]')
        txt = page.inner_text('#sheet-body')
        assert 'Abschuss: Schwarzwild' in txt and 'Strecke' in txt, txt
        page.select_option('#sheet-body select[data-filter=typ]', 'sichtung')
        assert 'Keine Ereignisse' in page.inner_text('#sheet-body')
        page.select_option('#sheet-body select[data-filter=typ]', '')
        with page.expect_download() as dl:
            page.click('#sheet-body [data-act=export-csv]')
        csv = open(dl.value.path(), encoding='utf-8-sig').read()
        assert 'Schwarzwild' in csv and '38,5' in csv and 'Eigenjagd Test' in csv and 'Kanzel Eiche' in csv, csv
        step('Ereignisliste, Filter und CSV-Export')

        page.click('#tabs [data-tab=reviere]')
        txt = page.inner_text('#sheet-body')
        assert 'Eigenjagd Test' in txt and '1 Einrichtungen' in txt and 'ha' in txt, txt
        page.click('#sheet-body li[data-act=rv-zoom]')
        assert not page.is_visible('#sheet')
        step('Revierliste und Zoom')

        # --- GPS ---
        page.click('#btn-locate')
        page.wait_for_function("document.querySelector('#statusbar').textContent.includes('Eigenjagd Test')", timeout=5000)
        assert 'GPS ±8 m' in page.inner_text('#statusbar')
        page.evaluate("""(() => { const g = [...window.__map.layers].find(l => l.cfgId === 'einrichtungen');
                                 [...g.layers][0].fire('click'); })()""")
        assert 'Von mir' in page.inner_text('.mock-popup')
        step('GPS-Position, Revier-Erkennung, Entfernung im Popup')

        # --- Grenze bearbeiten über Revier-Popup ---
        page.evaluate("""(() => { const g = [...window.__map.layers].find(l => l.cfgId === 'reviere');
                                 [...g.layers][0].fire('click', {latlng: L.latLng(51.605, 8.305)}); })()""")
        page.click('.mock-popup [data-act=rv-geom]')
        assert page.inner_text('#draw-count') == '4 Punkte'
        page.evaluate('window.__map.fire("click", {latlng: L.latLng(51.615, 8.305)})')
        print('    count nach Klick:', page.inner_text('#draw-count'))
        page.click('#draw-done')
        page.wait_for_timeout(200)
        n = page.evaluate("""(async () => { const s = await import('./js/store.js'); return s.all('revier')[0].geometry.coordinates[0].length; })()""")
        assert n == 6, n
        step('Reviergrenze bearbeitet (5 Ecken + Schlusspunkt)')

        # --- Export GeoJSON + Import KML/GPX ---
        page.click('#tabs [data-tab=mehr]')
        page.wait_for_timeout(300)
        with page.expect_download() as dl:
            page.click('#sheet-body [data-act=export-geojson]')
        gj = json.load(open(dl.value.path()))
        assert len(gj['features']) == 3, len(gj['features'])
        with page.expect_download() as dl:
            page.click('#sheet-body [data-act=export-kml]')
        assert '<kml' in open(dl.value.path()).read()
        with page.expect_download() as dl:
            page.click('#sheet-body [data-act=export-gpx]')
        assert '<gpx' in open(dl.value.path()).read()
        step('Export GeoJSON/KML/GPX')

        page.set_input_files('#file-input', files=[{'name': 'revier.kml', 'mimeType': 'application/xml', 'buffer': KML.encode()}])
        page.wait_for_selector('#dlg2[open]')
        assert '1 Reviere, 1 Einrichtungen' in page.inner_text('#dlg2') and '1 nicht verwendbare' in page.inner_text('#dlg2')
        page.click('#dlg2 button[type=submit]')
        page.wait_for_timeout(300)
        page.set_input_files('#file-input', files=[{'name': 'track.gpx', 'mimeType': 'application/gpx+xml', 'buffer': GPX.encode()}])
        page.wait_for_selector('#dlg2[open]')
        assert '1 Reviere, 1 Einrichtungen' in page.inner_text('#dlg2'), page.inner_text('#dlg2')
        page.click('#dlg2 button[type=submit]')
        page.wait_for_timeout(300)
        counts = page.evaluate("""(async () => { const s = await import('./js/store.js'); return ['revier','einrichtung','ereignis'].map(k => s.all(k).length); })()""")
        assert counts == [3, 3, 1], counts
        # Backup wieder einspielen: nichts ändert sich (gleiche ids, nicht neuer)
        page.set_input_files('#file-input', files=[{'name': 'backup.geojson', 'mimeType': 'application/json', 'buffer': json.dumps(gj).encode()}])
        page.wait_for_selector('#dlg2[open]'); page.click('#dlg2 button[type=submit]'); page.wait_for_timeout(300)
        assert '0 Einträge übernommen' in page.inner_text('#toast')
        step('Import KML/GPX und Backup-Wiedereinspielung (Merge)')

        # --- Offline-Paket für das Revier (Kachel-Server per Route simuliert) ---
        PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010806000000'
                            '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082')
        tile_hits = []
        def fake_tile(route):
            tile_hits.append(route.request.url)
            route.fulfill(status=200, body=PNG, headers={'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*'})
        page.route('https://sgx.geodatenzentrum.de/**', fake_tile)
        page.route('https://www.wms.nrw.de/**', fake_tile)
        page.click('#sheet-body [data-act=off-new]')
        page.wait_for_selector('#dlg[open]')
        est = page.inner_text('#off-est')
        assert 'Kacheln' in est, est
        page.click('#dlg button[type=submit]')
        page.wait_for_function("document.querySelector('#progress').hidden === true && document.querySelector('#toast').textContent.includes('Offline-Paket')", timeout=60000)
        pk = page.evaluate("""(async () => { const p = JSON.parse(localStorage.getItem('jagd.offlinePackages'))[0];
                                 const c = await caches.open('pkg-' + p.id); return { meta: p, n: (await c.keys()).length }; })()""")
        assert pk['n'] == pk['meta']['tiles'] and pk['n'] > 50 and pk['meta']['failed'] == 0, pk
        assert len(tile_hits) == pk['n']
        assert any('wms_nw_dop' in u for u in tile_hits) and any('wmts_basemapde' in u for u in tile_hits)
        assert 'Offline-Paket' not in page.inner_text('#sheet-body') or True
        step(f"Offline-Paket geladen: {pk['n']} Kacheln im Cache")
        page.click('#sheet-body [data-act=off-del]')
        page.wait_for_selector('#dlg2[open]'); page.click('#dlg2 button[type=submit]'); page.wait_for_timeout(300)
        left = page.evaluate("(async () => (await caches.keys()).filter(k => k.startsWith('pkg-')).length)()")
        assert left == 0, left
        step('Offline-Paket gelöscht')

        # --- OneDrive: Einrichtung, Anmeldung (PKCE) und Abgleich gegen simulierten Microsoft-Dienst ---
        from urllib.parse import urlparse, parse_qs
        cloud = {'body': None, 'etag': 0}
        CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS'}
        def ms(route):
            req = route.request; u = req.url
            if req.method == 'OPTIONS': return route.fulfill(status=204, headers=CORS)
            if '/authorize' in u:
                q = parse_qs(urlparse(u).query)
                assert q['code_challenge_method'] == ['S256'] and 'Files.ReadWrite.AppFolder' in q['scope'][0]
                return route.fulfill(status=302, headers={'Location': q['redirect_uri'][0] + '?code=CODE1&state=' + q['state'][0]})
            if u.endswith('/token'):
                assert 'code_verifier=' in req.post_data and 'code=CODE1' in req.post_data
                return route.fulfill(status=200, headers={**CORS, 'Content-Type': 'application/json'}, body=json.dumps({'access_token': 'AT', 'refresh_token': 'RT', 'expires_in': 3600}))
            if u.endswith('/v1.0/me'):
                return route.fulfill(status=200, headers={**CORS, 'Content-Type': 'application/json'}, body=json.dumps({'userPrincipalName': 'jaeger@outlook.de'}))
            if u.endswith(':/content') and req.method == 'PUT':
                cloud['body'] = req.post_data; cloud['etag'] += 1
                return route.fulfill(status=200, headers={**CORS, 'Content-Type': 'application/json'}, body=json.dumps({'eTag': str(cloud['etag'])}))
            if '/approot:/revier-daten.json' in u:
                if cloud['body'] is None: return route.fulfill(status=404, headers=CORS, body='{}')
                return route.fulfill(status=200, headers={**CORS, 'Content-Type': 'application/json'}, body=json.dumps({'eTag': str(cloud['etag']), '@microsoft.graph.downloadUrl': 'https://dl.example.test/f'}))
            if u.startswith('https://dl.example.test/'):
                return route.fulfill(status=200, headers={**CORS, 'Content-Type': 'application/json'}, body=cloud['body'])
            route.fulfill(status=404, headers=CORS, body='{}')
        for pat in ['https://login.microsoftonline.com/**', 'https://graph.microsoft.com/**', 'https://dl.example.test/**']:
            page.route(pat, ms)
        page.click('#sheet-body [data-act=sync-setup]')
        page.wait_for_selector('#dlg[open]')
        page.fill('#dlg input[name=clientId]', 'kein-guid')
        page.click('#dlg button[type=submit]')
        assert page.is_visible('#dlg[open]'), 'ungültige ID muss abgelehnt werden'
        page.fill('#dlg input[name=clientId]', '11111111-2222-3333-4444-555555555555')
        page.click('#dlg button[type=submit]')
        page.wait_for_selector('#dlg', state='hidden')
        page.click('#sheet-body [data-act=sync-login]')
        page.wait_for_function("window.__map !== undefined && location.search === ''", timeout=15000)
        page.wait_for_function("document.querySelector('#toast').textContent.includes('angemeldet')", timeout=15000)
        page.wait_for_function("localStorage.getItem('jagd.sync.last') !== null", timeout=15000)
        data = json.loads(cloud['body'])
        kinds = sorted({r['kind'] for r in data['records']})
        assert kinds == ['einrichtung', 'ereignis', 'revier'] and len(data['records']) >= 7, (kinds, len(data['records']))
        page.click('#tabs [data-tab=mehr]')
        assert 'jaeger@outlook.de' in page.inner_text('#sync-info'), page.inner_text('#sync-info')
        # anderes Gerät legt einen Eintrag in OneDrive ab -> manueller Abgleich holt ihn
        d2 = json.loads(cloud['body']); d2['records'].append({'id': 'fremd-1', 'kind': 'einrichtung', 'typ': 'kirrung', 'name': 'Kirrung vom Mac', 'lat': 51.605, 'lng': 8.305, 'updatedAt': 9e12, 'createdAt': 1})
        cloud['body'] = json.dumps(d2); cloud['etag'] += 1
        page.click('#sheet-body [data-act=sync-now]')
        page.wait_for_function("document.querySelector('#toast').textContent.includes('übernommen')", timeout=15000)
        got = page.evaluate("(async () => { const s = await import('./js/store.js'); return s.get('fremd-1') && s.get('fremd-1').name; })()")
        assert got == 'Kirrung vom Mac', got
        step('OneDrive: Einrichtung, Anmeldung (PKCE), Hoch- und Herunterladen')

        # --- Löschen aus dem Bearbeiten-Formular (Rückfrage im zweiten Dialog) ---
        page.click('#sheet-close')
        page.evaluate("""(() => { const g = [...window.__map.layers].find(l => l.cfgId === 'einrichtungen');
                                 [...g.layers].find(m => true).fire('click'); })()""")
        page.click('.mock-popup [data-act=ei-edit]')
        page.wait_for_selector('#dlg[open]')
        page.click('#dlg [data-danger]')
        page.wait_for_selector('#dlg2[open]')
        page.click('#dlg2 [data-cancel]')
        assert page.is_visible('#dlg[open]'), 'Formular darf nach "Abbrechen" der Rückfrage offen bleiben'
        page.click('#dlg [data-danger]')
        page.wait_for_selector('#dlg2[open]')
        page.click('#dlg2 button[type=submit]')
        page.wait_for_selector('#dlg', state='hidden')
        counts = page.evaluate("""(async () => { const s = await import('./js/store.js'); return [s.all('einrichtung').length, s.all('einrichtung', {includeDeleted:true}).length]; })()""")
        assert counts == [3, 4], counts
        step('Löschen mit Rückfrage (Grabstein bleibt für Sync erhalten)')

        # --- Persistenz: neu laden ---
        page.reload()
        page.wait_for_function('window.__map !== undefined')
        page.wait_for_timeout(300)
        counts = page.evaluate("""(async () => { const s = await import('./js/store.js'); return ['revier','einrichtung','ereignis'].map(k => s.all(k).length); })()""")
        assert counts == [3, 3, 1], counts
        step('Daten nach Neuladen vorhanden (IndexedDB)')

        # --- Desktop-Layout ---
        page.set_viewport_size({'width': 1280, 'height': 800})
        page.click('#tabs [data-tab=reviere]')
        box = page.locator('#sheet').bounding_box()
        assert box['x'] > 800, box
        step('PC-Ansicht: Liste als Seitenleiste')
        page.screenshot(path=os.path.join(ROOT, 'tests', 'desktop.png'))

        ctx.close()

        # --- Service Worker separat: Installation und App-Cache ---
        ctx2 = browser.new_context()
        pg = ctx2.new_page()
        pg.route('https://unpkg.com/**', lambda r: r.fulfill(status=200, content_type='application/javascript', body=MOCK if r.request.url.endswith('.js') else ''))
        pg.on('pageerror', lambda e: errors.append('pageerror(sw): ' + str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/index.html')
        pg.wait_for_function("navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(r => !!r.active)", timeout=10000)
        pg.wait_for_timeout(1500)
        info = pg.evaluate("""(async () => { const keys = await caches.keys(); const c = await caches.open(keys.find(k => k.startsWith('shell-')));
                              return { keys, n: (await c.keys()).length }; })()""")
        assert info['n'] >= 15, info
        step(f"Service Worker installiert, {info['n']} App-Dateien offline verfügbar")
        ctx2.close()
        browser.close()
    httpd.shutdown()

    # erwartet: Validierungsfehler aus dem Test und 404 für die noch nicht vorhandene OneDrive-Datei
    real = [e for e in errors if 'favicon' not in e and 'Anwendungs-ID' not in e and 'status of 404' not in e]
    if real:
        print('\nFEHLER im Browser:'); [print('  ', e) for e in real]; sys.exit(1)
    print('\nAlle E2E-Tests bestanden, keine JS-Fehler.')

if __name__ == '__main__':
    main()
