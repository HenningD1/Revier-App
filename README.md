# Revier – eigene Jagd-App

Web-App (PWA) für iPhone, Mac und Windows aus **einer** Codebasis, nur für den Eigengebrauch.
Sie läuft im Browser und lässt sich wie eine App auf den Home-Bildschirm bzw. ins Dock legen.

Adresse: **https://henningd1.github.io/Revier-App/**

## Funktionen

| Bereich | Funktionen |
|---|---|
| Karten | Topo Deutschland (basemap.de, BKG), OpenStreetMap, OpenTopoMap (Höhenlinien), Luftbild NRW (DOP 20 cm), Flurstücke NRW (ALKIS, ab Zoom 16) |
| Reviere | Grenze per Antippen zeichnen oder mit „GPS-Punkt“ ablaufen, Eckpunkte verschieben, einfügen und löschen, Fläche in ha |
| Einrichtungen | Hochsitz, Kanzel, Drückjagdbock, Bodensitz, Kirrung, Salzlecke, Suhle, Fütterung, Wildacker, Wildkamera, Falle, Parkplatz – jeweils mit eigenem Symbol, optional mit Blickrichtung (auch per Kompass); Route dorthin |
| Ereignisse | Sichtung, Abschuss, Fehlschuss/Nachsuche, Fallwild, Wildunfall, Wildschaden, Fährte. Mit Wildart (Tiersymbol), Anzahl, Geschlecht, Altersklasse, Gewicht, Zeit und Einrichtung |
| Auswertung | Liste nach Jagdjahr (1.4.–31.3.), Revier, Ereignis und Wildart; Streckenübersicht; CSV-Export für Excel |
| GPS & Kompass | Position mit Genauigkeitskreis, „Im Revier: …“, Entfernung und Richtung zu jedem Punkt; Kompass als halbrunde Gradskala am unteren Rand |
| Abgleich | **iCloud per Datei** (ohne Anmeldung, empfohlen für iPhone + Mac) oder optional automatisch über OneDrive |
| Offline (Stufe 3) | Offline-Pakete je Revier, Kartenausschnitt oder als NRW-Übersicht; dazu Zwischenspeicher für angesehene Kacheln |
| Austausch | Backup als GeoJSON, Export KML/GPX, Import GeoJSON/KML/GPX (abgelaufene GPX-Tracks werden zu Revieren) |

**Bedienung:** Langes Drücken auf die Karte (PC: Rechtsklick) öffnet ein Schnellmenü an dieser Stelle.
GPS-Knopf: 1× an und folgen → 2× wieder zentrieren → 3× aus. Antippen der Statuszeile zeigt Koordinaten und Genauigkeit.

## Installation auf den Geräten

**iPhone:** Adresse in Safari öffnen → Teilen → **„Zum Home-Bildschirm“**. Danach die App **nur noch über das Home-Symbol** öffnen
(eigener, dauerhafter Speicher; was in Safari selbst eingetragen wurde, sieht die App nicht).
**Mac:** Safari → Ablage → **„Zum Dock hinzufügen“**. **Windows:** Edge/Chrome → „App installieren“ in der Adressleiste.

**Updates:** Änderungen ins Repo pushen und in `sw.js` die Zeile `const VERSION = '…'` hochzählen. Die App meldet dann „Neue Version verfügbar → Neu laden“.

## GPS zeigt falschen Standort (iPhone)

Die App nimmt, was iOS liefert. Ist bei den Ortungsdiensten für **Safari-Websites** (gilt auch für Home-Bildschirm-Apps)
**„Genauer Standort“** ausgeschaltet, gibt iOS nur einen ungefähren Ort weiter (Abweichung oft mehrere Kilometer).
Prüfen: *Einstellungen → Datenschutz & Sicherheit → Ortungsdienste → Safari-Websites* → „Beim Verwenden der App“ und „Genauer Standort“ einschalten, dann in der App GPS aus- und wieder einschalten.
Die App erkennt solche groben Positionen (> 500 m Ungenauigkeit): Statuszeile „⚠ ungenau“, grauer Punkt, Hinweis.
Außerdem nimmt sie keine zwischengespeicherten Altpositionen an und verwirft kurzzeitig viel schlechtere Fixes (z. B. GPS-Abriss im Wald).

## Abgleich iPhone ↔ Mac über iCloud (ohne Anmeldung)

Beide Geräte nutzen dieselbe Datei **`Revier-Daten.json`** in iCloud Drive. Eine Web-App kann iCloud nicht selbst ansprechen
(dafür bräuchte es Apples Entwicklerprogramm), über die Dateiauswahl und das Teilen-Menü geht es aber mit zwei Tipps.

1. **Einmalig:** Mehr → **Nur speichern (erste Datei anlegen)** → iPhone: „In Dateien sichern“ → iCloud Drive → z. B. Ordner „Revier“.
2. **Abgleichen (auf jedem Gerät):** Mehr → **Mit iCloud-Datei abgleichen** → `Revier-Daten.json` wählen.
   Die App übernimmt, was das andere Gerät neu eingetragen oder gelöscht hat. Gibt es hier Neueres, bietet sie direkt das
   **Zurückspeichern** an → an dieselbe Stelle speichern und „Ersetzen“ wählen.
3. **Mac:** Safari → Einstellungen → Allgemein → „Speicherort für Downloads“ auf **„Jedes Mal fragen“** stellen, dann kann man die
   Datei beim Speichern direkt in iCloud Drive ersetzen (sonst landet sie im Download-Ordner).

Je Eintrag gewinnt der jüngere Stand; Löschungen werden als „Grabstein“ mitgeschrieben. Doppelte Einträge entstehen nicht.
Die Statuszeile im Bereich „Mehr“ zeigt, ob es Änderungen gibt, die noch nicht in der Datei stehen.

## Revier mit Mitpächtern teilen

Im Revier-Popup oder in der Revierliste **Teilen** wählen. Mitgeschickt werden das Revier und alles, was innerhalb der
Grenze liegt: Einrichtungen (abwählbar), Ereignisse wahlweise keine / laufendes Jagdjahr / alle, Notizen abwählbar.
Auf dem iPhone öffnet sich das Teilen-Menü (Nachrichten, WhatsApp, Mail, AirDrop …).

- **Format „Revier-App“ (.json):** Der Mitpächter öffnet https://henningd1.github.io/Revier-App/ und liest die Datei mit
  „Datei importieren“ ein. Seine übrigen Daten bleiben unberührt. Weil die Kennungen erhalten bleiben, kann man Änderungen
  hin- und herschicken: Es werden dieselben Einträge aktualisiert (der neuere Stand gewinnt), nichts wird doppelt.
  Gelöschte Einrichtungen werden mitgeteilt und verschwinden auch beim Mitpächter.
- **KML / GPX:** für Google Earth, GPS-Geräte und andere Jagd-Apps (ohne Abgleich).

## Versionen und Wiederherstellen

`Revier-Daten.json` wird bei jedem Abgleich überschrieben. Damit trotzdem nichts verloren geht, führt die App einen
**Versionsverlauf** auf jedem Gerät: Sie sichert den kompletten Stand automatisch einmal am Tag sowie vor jedem Import,
Abgleich, „Alle Daten löschen“ und jeder Wiederherstellung. Die letzten 30 Versionen bleiben erhalten (Mehr → Versionen).

- **Wiederherstellen** setzt exakt den damaligen Stand ein. Was danach hinzugekommen ist, wird entfernt (als gelöscht markiert).
  Alle wiederhergestellten Einträge bekommen einen frischen Zeitstempel – deshalb setzt sich der alte Stand beim nächsten
  iCloud-Abgleich auch auf dem anderen Gerät durch („Zurückspeichern“ wählen).
- Vor jeder Wiederherstellung wird der aktuelle Stand als Version gesichert; sie lässt sich also rückgängig machen.
- **Datei** sichert eine Version als `Revier-Version-JJJJ-MM-TT-HHMM.json`, z. B. in iCloud Drive.
- Beim Einlesen einer Datei (Datei importieren) gibt es zwei Wege: **Zusammenführen** (je Eintrag gewinnt der neuere Stand –
  ein altes Backup dreht damit nichts zurück) oder **Genau diesen Stand wiederherstellen** (wie oben).

Der Verlauf liegt nur auf dem jeweiligen Gerät. Gegen Verlust des iPhones hilft gelegentlich eine Version als Datei in iCloud Drive.

## OneDrive einrichten (optional, automatischer Abgleich)

Die App spricht direkt mit Microsoft (Anmeldung per OAuth 2.0 mit PKCE, Zugriff über Microsoft Graph). Dafür braucht sie eine
eigene, kostenlose **App-Registrierung**. Sie erhält nur die Berechtigung `Files.ReadWrite.AppFolder`, sieht also ausschließlich
den Ordner `OneDrive/Apps/<App-Name>/` und sonst nichts von deinem OneDrive.

1. **Verzeichnis (Tenant) besorgen.** Microsoft lässt neue App-Registrierungen nur noch innerhalb eines Microsoft-Entra-Verzeichnisses zu,
   nicht mehr direkt unter einem privaten Microsoft-Konto. Wege: kostenloses Azure-Konto anlegen (portal.azure.com, mit dem privaten
   Microsoft-Konto; dabei wird ein „Standardverzeichnis“ erzeugt – App-Registrierungen kosten nichts) oder das Microsoft-365-Entwicklerprogramm.
2. **portal.azure.com → Microsoft Entra ID → App-Registrierungen → Neue Registrierung**
   - Name: `Revier-App`
   - Unterstützte Kontotypen: **„Nur persönliche Microsoft-Konten“** (oder „… beliebiges Organisationsverzeichnis und persönliche Microsoft-Konten“)
   - Umleitungs-URI: Plattform **„Single-Page-Webanwendung (SPA)“**, Adresse `https://henningd1.github.io/Revier-App/` (genau so, mit Schrägstrich am Ende)
3. **„Anwendungs-ID (Client)“** kopieren.
4. Unter **API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Delegierte Berechtigungen**: `Files.ReadWrite.AppFolder`
   und `offline_access` hinzufügen (`User.Read` ist schon da).
5. In der App: **Mehr → OneDrive-Abgleich → Einrichtung** → ID eintragen → **Bei OneDrive anmelden**.
   Auf jedem Gerät einmal nötig – oder die ID in `js/config.js` (`ONEDRIVE_CLIENT_ID`) eintragen, dann gilt sie überall. Die ID ist kein Geheimnis.

**Wie der Abgleich arbeitet:** beim Öffnen der App, 15 s nach jeder Änderung, bei wiederkehrendem Netz und per Knopf.
Datei holen → je Eintrag gewinnt der jüngere Stand (auch Löschungen werden als „Grabstein“ übertragen) → Gesamtstand zurückschreiben.
Geschrieben wird mit `If-Match: eTag`: Hat ein anderes Gerät die Datei inzwischen geändert, beginnt der Abgleich automatisch von vorn.
**Hinweis:** Microsoft gibt Web-Apps eine Anmeldung, die höchstens 24 Stunden erneuert werden kann. Danach einmal auf „Bei OneDrive anmelden“ tippen
(meist ohne erneute Passworteingabe). Ohne Netz arbeitet die App normal weiter und gleicht später ab.


## Offline-Karten (Stufe 3)

Mehr → **Neues Offline-Paket laden** (oder im Revier-Popup „Offline speichern“). Gebiet wählen:

- **Revier** (+300 m Rand): Topokarte Zoom 10–17, Luftbild NRW Zoom 13–19 (volle 20-cm-Auflösung), Flurstücke Zoom 16–18
- **Aktueller Kartenausschnitt**: dieselben Ebenen für das, was gerade zu sehen ist
- **Übersicht NRW**: Topokarte bis Zoom 12 – zum Zurechtfinden ohne Netz

Vor dem Laden zeigt die App Kachelzahl und geschätzte Größe (ein Revier von ca. 500 ha: etwa 1.000–2.000 Kacheln, 50–120 MB).
Jedes Paket liegt in einem eigenen Speicherbereich und kann einzeln gelöscht werden. Der Service Worker sucht jede Kachel zuerst in
den Paketen – ohne Netz erscheint die Karte also automatisch.
**Warum nur diese Ebenen?** basemap.de (CC BY 4.0) und die NRW-Geobasisdaten (Datenlizenz Deutschland Zero) erlauben das Speichern.
Die OpenStreetMap- und OpenTopoMap-Server verbieten Massen-Downloads; davon bleiben nur angesehene Kacheln im Zwischenspeicher.

## Aufbau (für eigene Änderungen)

```
index.html            Oberfläche (Karte, Knöpfe, Leisten, Dialoge)
css/app.css           Gestaltung, Handy zuerst, ab 900 px Breite Seitenleiste
js/config.js          ALLE Einstellungen: Kartendienste, Offline-Zoomstufen, Typen, Wildarten, Farben, OneDrive-ID
js/app.js             Ablaufsteuerung: Karte, Popups, Formulare, Listen, Import/Export, Offline, Sync
js/store.js           Datenhaltung in IndexedDB + Merge-Logik (jüngster Stand gewinnt, Grabsteine)
js/geo.js             Fläche, Punkt-in-Polygon, Entfernung, Richtung, Jagdjahr
js/tiles.js           Kachel-Mathematik (Web-Mercator) und Kachel-URLs – für Karte UND Offline-Pakete
js/offline.js         Offline-Pakete planen, laden, löschen
js/sync.js            OneDrive: Anmeldung (OAuth PKCE), Lesen/Schreiben über Graph, Abgleich
js/io.js              GeoJSON / KML / GPX / CSV
js/icons.js           Symbole: Einrichtungen (eigene Piktogramme), Tiere (aus „Jagdsignale üben“)
js/compass.js         Kompass-Gradskala
js/draw.js            Polygon-Editor für Reviergrenzen
js/gps.js             GPS (watchPosition, Plausibilitätsprüfung) und Kompass (DeviceOrientation)
js/ui.js              Dialoge, Toasts, Teilen/Download
sw.js                 Service Worker: Offline-Start, Kachel-Zwischenspeicher, Offline-Pakete
tests/                Unit-Tests (Node) und Browser-Tests (Playwright)
```

**Datenmodell:** Jeder Eintrag hat `id` (UUID), `kind` (`revier` | `einrichtung` | `ereignis`), `createdAt`, `updatedAt`, `device`.
Reviere speichern `geometry` als GeoJSON-Polygon, Punkte `lat`/`lng`. Gelöscht wird per Grabstein (`deleted: true`).
Die Revierzuordnung eines Punktes wird jedes Mal berechnet (Punkt-in-Polygon), nicht gespeichert.

**Warum eigene Kachel-URLs?** Der Cache findet Kacheln nur über die exakte URL. Deshalb erzeugt eine einzige Funktion
(`tileUrl` in `js/tiles.js`) die URLs für die Kartenanzeige und für den Paket-Download.

## Grenzen

- Kein GPS im Hintergrund (Web-Apps erhalten die Position nur, solange sie geöffnet sind).
- Kompass zeigt magnetisch Nord (in NRW ca. 3° Abweichung); bei Fehlanzeige das iPhone in einer Acht bewegen.
- Mehrteilige Reviere (MultiPolygon aus Importen) werden angezeigt, aber noch nicht in der Grenze bearbeitet.
- Luftbild und Flurstücke derzeit nur NRW; andere Länder lassen sich in `js/config.js` ergänzen (eigene WMS-Dienste der Länder).

## Lizenzen der Kartendaten

basemap.de: © GeoBasis-DE / BKG, CC BY 4.0 · OpenStreetMap: © OpenStreetMap-Mitwirkende, ODbL · OpenTopoMap: CC-BY-SA ·
Luftbild und Flurstücke NRW: Geobasis NRW, Datenlizenz Deutschland – Zero 2.0 · Tiersymbole: aus „Jagdsignale üben“.

## Tests

```
node tests/unit.test.mjs          # Geometrie, Merge, Import/Export, Kachel-Mathematik
node tests/sync.test.mjs          # OneDrive-Abgleich mit simuliertem OneDrive (zwei Geräte, Konflikte, PKCE)
python3 tests/e2e_test.py         # kompletter Ablauf im Headless-Chrome (Leaflet-Ersatz, simulierte Kachel- und Microsoft-Server)
```
