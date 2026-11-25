# Revier – eigene Jagd-App (Stufe 1)

Web-App (PWA) für iPhone, Mac und Windows aus **einer** Codebasis. Gedacht nur für den Eigengebrauch.
Sie läuft im Browser und lässt sich wie eine App auf den Home-Bildschirm bzw. ins Dock legen.

## Was Stufe 1 kann

| Bereich | Funktionen |
|---|---|
| Karten | Topo Deutschland (basemap.de, BKG), OpenStreetMap, OpenTopoMap (Höhenlinien), Luftbild NRW (DOP 20 cm), Flurstücke NRW (ALKIS, ab Zoom 16) |
| Reviere | Grenze per Antippen zeichnen oder mit „GPS-Punkt“ ablaufen, Eckpunkte verschieben, einfügen und löschen, Fläche in ha, Farbe, Notizen |
| Einrichtungen | Hochsitz, Kanzel, Drückjagdbock, Kirrung, Salzlecke, Wildkamera, Falle … mit Blickrichtung (auch per Kompass), Route dorthin (Apple Karten) |
| Ereignisse | Sichtung, Abschuss, Fehlschuss/Nachsuche, Fallwild, Wildunfall, Wildschaden, Fährte. Mit Wildart, Anzahl, Geschlecht, Altersklasse, Gewicht, Zeit und der Einrichtung, von der aus beobachtet wurde |
| Auswertung | Liste nach Jagdjahr (1.4.–31.3.), Revier, Ereignis und Wildart. Streckenübersicht, CSV-Export für Excel |
| GPS & Kompass | Eigene Position mit Genauigkeitskreis, Anzeige „Im Revier: …“, Entfernung und Richtung zu jedem Punkt, Blickrichtungs-Kegel per Kompass |
| Austausch | Backup als GeoJSON. Export als KML (Google Earth) und GPX (GPS-Geräte). Import von GeoJSON, KML und GPX (abgelaufene GPX-Tracks werden zu Revieren) |
| Offline | App startet ohne Netz. Bereits angesehene Kartenkacheln bleiben verfügbar (bis ca. 6000 Kacheln) |

**Bedienung:** Langes Drücken auf die Karte (PC: Rechtsklick) öffnet ein Schnellmenü an dieser Stelle.
Der GPS-Knopf hat drei Stufen: GPS an und folgen → wieder zentrieren → GPS aus.

## Installation über GitHub Pages (einmalig, ca. 10 Minuten)

1. Auf github.com ein neues Repository anlegen, z. B. `revier`. Es muss **öffentlich** sein, weil GitHub Pages für private Repos ein Bezahl-Konto voraussetzt.
   Im Repo liegt nur der Programmcode. Deine Reviere und Ereignisse speichert die App ausschließlich auf deinen Geräten.
2. Den Inhalt dieses Ordners hochladen (Weboberfläche: „Add file“ → „Upload files“, alle Dateien und Ordner hineinziehen). Den Ordner `tests/` braucht man nicht hochzuladen.
3. Unter **Settings → Pages → Source: „Deploy from a branch“**, Branch `main`, Ordner `/ (root)` wählen und speichern.
4. Nach 1–2 Minuten ist die App unter `https://<dein-name>.github.io/revier/` erreichbar.

**iPhone:** Die Adresse in Safari öffnen → Teilen → **„Zum Home-Bildschirm“**. Danach die App **nur noch über das Home-Symbol** öffnen.
iOS gibt der Home-Bildschirm-App einen eigenen Speicher, der nicht automatisch gelöscht wird. Was in Safari selbst eingetragen wurde, sieht die App nicht.
Beim ersten Tippen auf GPS bzw. Kompass fragt iOS nach der Erlaubnis.

**Mac:** In Safari Ablage → **„Zum Dock hinzufügen“**.
**Windows:** In Edge oder Chrome das Symbol „App installieren“ in der Adressleiste wählen.

**Updates:** Geänderte Dateien hochladen und in `sw.js` die Zeile `const VERSION = '…'` hochzählen.
Die App meldet dann „Neue Version verfügbar → Neu laden“.

## Datenaustausch zwischen iPhone und PC (bis Stufe 2)

„Mehr“ → **Komplett-Backup**. Auf dem iPhone öffnet sich das Teilen-Menü; dort „In Dateien sichern“ wählen und den OneDrive-Ordner angeben.
Auf dem anderen Gerät „Datei importieren“ wählen. Beim Import gewinnt pro Eintrag der **jüngere Stand**, es entstehen also keine Duplikate.
Genau diese Logik nutzt später auch der automatische Abgleich.

## Aufbau (für eigene Änderungen)

```
index.html            Oberfläche (Karte, Knöpfe, Leisten, Dialoge)
css/app.css           Gestaltung, Handy-first, ab 900 px Breite Seitenleiste
js/config.js          ALLE Einstellungen: Kartendienste, Einrichtungs-/Ereignistypen, Wildarten, Farben
js/app.js             Ablaufsteuerung: Karte, Popups, Formulare, Listen, Import/Export
js/store.js           Datenhaltung in IndexedDB + Merge-Logik
js/geo.js             Fläche, Punkt-in-Polygon, Entfernung, Richtung, Jagdjahr
js/io.js              GeoJSON / KML / GPX / CSV
js/draw.js            Polygon-Editor für Reviergrenzen
js/gps.js             GPS (watchPosition) und Kompass (DeviceOrientation)
js/ui.js              Dialoge, Toasts, Teilen/Download
sw.js                 Service Worker: Offline-Start + Kachel-Zwischenspeicher
tests/                Unit-Tests (Node) und Browser-Tests (Playwright)
```

**Datenmodell:** Jeder Eintrag ist ein Objekt mit `id` (UUID), `kind` (`revier` | `einrichtung` | `ereignis`), `createdAt`, `updatedAt` und `device`.
Reviere speichern `geometry` als GeoJSON-Polygon, Punkte speichern `lat`/`lng`.
Gelöscht wird per „Grabstein“ (`deleted: true`). Nur so erkennt ein zweites Gerät beim Abgleich, dass ein Eintrag gelöscht wurde und nicht bloß noch fehlt.
Die Zuordnung eines Punktes zum Revier wird **nicht gespeichert, sondern jedes Mal berechnet** (Punkt-in-Polygon). Ändert man eine Reviergrenze, stimmt die Zuordnung also automatisch.

**Eigene Wildarten oder Einrichtungstypen** ergänzt man in `js/config.js`.

## Grenzen der Stufe 1

- Offline sind nur Kartenausschnitte verfügbar, die vorher online angesehen wurden. Das gezielte Herunterladen von Regionen kommt in Stufe 3.
  Tipp bis dahin: Das Revier zu Hause im WLAN einmal in allen benötigten Zoomstufen ansehen.
- Der Kompass zeigt auf magnetisch Nord (in NRW ca. 3° Abweichung). Die Genauigkeit hängt vom Gerät ab; wenn er falsch anzeigt, das iPhone in einer Acht bewegen.
- Kein GPS im Hintergrund: Die Position wird nur aktualisiert, solange die App geöffnet ist.
- Mehrteilige Reviere (MultiPolygon, z. B. aus einem Import) werden angezeigt, lassen sich aber noch nicht in der Grenze bearbeiten.

## Nächste Stufen

- **Stufe 2 – OneDrive-Sync:** Anmeldung mit dem privaten Microsoft-Konto (MSAL.js). Die App liest und schreibt eine Datei `Apps/Revier/daten.json` über Microsoft Graph und gleicht sie mit `mergeRecords()` ab.
  Dafür ist einmalig eine kostenlose App-Registrierung im Microsoft-Entra-Portal nötig, mit der GitHub-Pages-Adresse als Redirect-URI.
- **Stufe 3 – Offline-Pakete NRW:** Grundkarte als PMTiles-Datei (selbst erzeugt aus OSM bzw. basemap.de), Luftbild und Flurstücke nur fürs eigene Revier.
  Die Pakete werden in der App heruntergeladen und im Gerätespeicher (OPFS) abgelegt.

## Lizenzen der Kartendaten

basemap.de: © GeoBasis-DE / BKG, CC BY 4.0 · OpenStreetMap: © OpenStreetMap-Mitwirkende, ODbL · OpenTopoMap: CC-BY-SA ·
Luftbild und Flurstücke NRW: Geobasis NRW, Datenlizenz Deutschland – Zero 2.0.
Die Quellenangaben stehen in der Karte unten rechts und dürfen nicht entfernt werden.
Die OSM- und OpenTopoMap-Server sind spendenfinanziert. Für den Eigengebrauch ist die Nutzung in Ordnung, für Massen-Downloads nicht.

## Tests

```
node tests/unit.test.mjs          # Geometrie, Merge, Import/Export
python3 tests/e2e_test.py         # kompletter Ablauf im Headless-Chrome (mit Leaflet-Ersatz)
```
