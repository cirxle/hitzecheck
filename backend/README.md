# Hitzerisiko-Check — Geo-Proxy (Swisstopo/BFE)

Minimaler Node.js-Server, der zwischen deinem Browser-Tool und der Swisstopo-API
vermittelt. Server-zu-Server-Requests unterliegen keiner Browser-CORS-Policy —
falls der direkte Aufruf aus `../index.html` bei dir an CORS scheitert,
läuft es über diesen Proxy garantiert.

## Setup

```bash
npm install
npm start
```

Der Server läuft danach auf `http://localhost:3001`.

## Testen

```bash
curl "http://localhost:3001/health"
curl "http://localhost:3001/api/search?text=Bahnhofstrasse+1+Zuerich"
```

Wenn der zweite Befehl ein JSON mit `results` zurückgibt, funktioniert die
Anbindung an Swisstopo. Falls ein Fehler mit `HTTP 403` oder `host_not_allowed`
erscheint, prüfe deine eigene Firewall/Netzwerkkonfiguration — die öffentliche
Swisstopo-API selbst benötigt keine Anmeldung oder API-Key.

## Im Frontend nutzen

In `../index.html` die beiden `fetch`-Aufrufe in `searchAddressLive()`
umbiegen:

```js
// vorher (direkter Aufruf, evtl. CORS-Problem im Browser):
var searchUrl = 'https://api3.geo.admin.ch/rest/services/ech/SearchServer?searchText=' + ...

// nachher (über lokalen Proxy):
var searchUrl = 'http://localhost:3001/api/search?text=' + encodeURIComponent(query);
```

```js
// vorher:
var identifyUrl = 'https://api3.geo.admin.ch/rest/services/api/MapServer/identify?...' + x + ',' + y + ...

// nachher:
var identifyUrl = 'http://localhost:3001/api/roof?x=' + x + '&y=' + y;
```

Die Response-Struktur bleibt identisch (der Proxy reicht die Swisstopo-Antwort
1:1 durch), daher muss der Rest der Parsing-Logik nicht angepasst werden.

## Für den produktiven Einsatz

- Lokal: reicht dieser einfache Server für Entwicklung/Demo
- Produktiv: auf einem echten Server deployen (z.B. Render, Railway, Fly.io,
  oder gemeinsam mit deiner bestehenden Firmen-Infrastruktur), dann im
  Frontend die `localhost:3001`-URLs durch die produktive Proxy-URL ersetzen
- Rate Limiting/Caching lohnt sich bei mehr als ein paar Anfragen pro Minute,
  da die öffentliche Swisstopo-API fair genutzt werden sollte
