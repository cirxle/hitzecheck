// Minimaler Proxy für Swisstopo/BFE Geodienste.
// Zweck: Server-zu-Server-Aufrufe unterliegen keiner Browser-CORS-Policy.
// Der Browser spricht nur noch mit diesem lokalen Server, dieser Server
// spricht mit api3.geo.admin.ch (Node hat keine CORS-Einschränkung).

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

const GEO_BASE = "https://api3.geo.admin.ch/rest/services";

// ---------------------------------------------------------------------
// Generische Identify-Funktion mit automatischem Durchprobieren mehrerer
// bekannter Topic-Pfade (offizielle Doku und Community-Beispiele
// widersprechen sich hier je nach API-Version).
// ---------------------------------------------------------------------
async function identifyLayer(layerName, x, y, tolerance = 20, returnGeometry = false) {
  const xi = parseFloat(x);
  const yi = parseFloat(y);
  const buffer = 100;
  const mapExtent = [xi - buffer, yi - buffer, xi + buffer, yi + buffer].join(",");
  const commonParams =
    `geometryType=esriGeometryPoint&geometryFormat=geojson&returnGeometry=${returnGeometry}` +
    `&layers=all:${layerName}` +
    `&geometry=${xi},${yi}` +
    `&mapExtent=${mapExtent}` +
    `&imageDisplay=800,600,96` +
    `&tolerance=${tolerance}&order=distance&lang=de&sr=2056&limit=10`;

  const candidates = [
    { name: "topic=all",     url: `${GEO_BASE}/all/MapServer/identify?${commonParams}` },
    { name: "topic=api",     url: `${GEO_BASE}/api/MapServer/identify?${commonParams}` },
    { name: "topic=energie", url: `${GEO_BASE}/energie/MapServer/identify?${commonParams}` },
    { name: "topic=ech",     url: `${GEO_BASE}/ech/MapServer/identify?${commonParams}` },
  ];

  const attempts = [];
  for (const c of candidates) {
    try {
      const upstream = await fetch(c.url);
      const bodyText = await upstream.text();
      attempts.push({ variant: c.name, status: upstream.status, ok: upstream.ok, body: bodyText.slice(0, 300) });
      if (upstream.ok) {
        let data;
        try { data = JSON.parse(bodyText); } catch { data = null; }
        if (data && data.results && data.results.length > 0) {
          return { ok: true, variant_used: c.name, data, attempts };
        }
      }
    } catch (err) {
      attempts.push({ variant: c.name, error: String(err) });
    }
  }
  return { ok: false, attempts };
}

function sendIdentifyResult(res, result, layerLabel) {
  if (result.ok) {
    return res.json({ variant_used: result.variant_used, ...result.data });
  }
  console.error(`[${layerLabel}] Alle Varianten fehlgeschlagen:`, JSON.stringify(result.attempts, null, 2));
  res.status(400).json({
    error: `Keine der bekannten Swisstopo-Endpunkt-Varianten hat gültige Daten für '${layerLabel}' geliefert.`,
    attempts: result.attempts,
  });
}

// ---------------------------------------------------------------------
// Exakte Feld-Suche (find) statt unscharfer Volltextsuche (SearchServer).
// contains=false erzwingt exakte Übereinstimmung auf dem angegebenen Feld.
// ---------------------------------------------------------------------
async function findByField(layerName, searchField, searchText) {
  const commonParams = `layer=${layerName}&searchField=${searchField}&searchText=${encodeURIComponent(searchText)}&contains=false`;
  const candidates = [
    { name: "topic=api",     url: `${GEO_BASE}/api/MapServer/find?${commonParams}` },
    { name: "topic=all",     url: `${GEO_BASE}/all/MapServer/find?${commonParams}` },
    { name: "topic=ech",     url: `${GEO_BASE}/ech/MapServer/find?${commonParams}` },
  ];
  const attempts = [];
  for (const c of candidates) {
    try {
      const upstream = await fetch(c.url);
      const bodyText = await upstream.text();
      attempts.push({ variant: c.name, status: upstream.status, ok: upstream.ok, body: bodyText.slice(0, 300) });
      if (upstream.ok) {
        let data;
        try { data = JSON.parse(bodyText); } catch { data = null; }
        if (data && data.results && data.results.length > 0) {
          return { ok: true, variant_used: c.name, data, attempts };
        }
      }
    } catch (err) {
      attempts.push({ variant: c.name, error: String(err) });
    }
  }
  return { ok: false, attempts };
}

// ---------------------------------------------------------------------
// GET /api/search?text=Bahnhofstrasse+1+Zuerich
// Geokodiert eine Adresse zu Koordinaten (LV95 / EPSG:2056)
// ---------------------------------------------------------------------
app.get("/api/search", async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).json({ error: "Parameter 'text' fehlt" });
  try {
    const url = `${GEO_BASE}/ech/SearchServer?searchText=${encodeURIComponent(text)}&type=locations&sr=2056&limit=5`;
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Swisstopo SearchServer: HTTP ${upstream.status}` });
    }
    res.json(await upstream.json());
  } catch (err) {
    res.status(502).json({ error: "Upstream-Fehler bei SearchServer", detail: String(err) });
  }
});

// ---------------------------------------------------------------------
// GET /api/roof?x=&y=  — Dachflächen (Solarkataster Dach)
// ---------------------------------------------------------------------
app.get("/api/roof", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).json({ error: "Parameter 'x' und 'y' erforderlich (EPSG:2056)" });
  const result = await identifyLayer("ch.bfe.solarenergie-eignung-daecher", x, y, 20);
  sendIdentifyResult(res, result, "Dach");
});

// ---------------------------------------------------------------------
// GET /api/facade?x=&y=  — Fassadenflächen (Solarkataster Fassade)
// ---------------------------------------------------------------------
app.get("/api/facade", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).json({ error: "Parameter 'x' und 'y' erforderlich (EPSG:2056)" });
  const result = await identifyLayer("ch.bfe.solarenergie-eignung-fassaden", x, y, 20);
  sendIdentifyResult(res, result, "Fassade");
});

// ---------------------------------------------------------------------
// GET /api/vegetation?x=&y=  — Vegetationshöhe an Position + kleiner Umgebung
// Raster-Layer, daher: mehrere Punkte im Umkreis abfragen als Näherung.
// ---------------------------------------------------------------------
app.get("/api/vegetation", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).json({ error: "Parameter 'x' und 'y' erforderlich (EPSG:2056)" });
  const xi = parseFloat(x);
  const yi = parseFloat(y);
  const offsets = [[0,0], [15,0], [-15,0], [0,15], [0,-15]]; // Zentrum + 15m in 4 Richtungen
  const samples = [];
  for (const [dx, dy] of offsets) {
    const result = await identifyLayer("ch.bafu.landesforstinventar-vegetationshoehenmodell", xi + dx, yi + dy, 5);
    if (result.ok && result.data.results && result.data.results.length > 0) {
      const props = result.data.results[0].properties || result.data.results[0].attributes || {};
      samples.push({ offset: [dx, dy], ...props });
    } else {
      samples.push({ offset: [dx, dy], no_data: true });
    }
  }
  res.json({ samples, note: "Rasterbasierte Näherung: Zentrum des Gebäudepunkts plus 4 Punkte im 15m-Umkreis." });
});

// ---------------------------------------------------------------------
// GET /api/building?egid=1234567  — Gebäude- und Wohnungsregister (GWR)
// Nutzt exakte Feldsuche (find, contains=false) statt unscharfer Volltextsuche,
// plus serverseitige Nachfilterung als zusätzliche Absicherung.
// ---------------------------------------------------------------------
app.get("/api/building", async (req, res) => {
  const egid = req.query.egid;
  if (!egid) return res.status(400).json({ error: "Parameter 'egid' erforderlich" });

  const result = await findByField("ch.bfs.gebaeude_wohnungs_register", "egid", egid);
  if (!result.ok) {
    console.error("[building] Alle Varianten fehlgeschlagen:", JSON.stringify(result.attempts, null, 2));
    return res.status(400).json({ error: "GWR-Abfrage fehlgeschlagen.", attempts: result.attempts });
  }

  var allResults = result.data.results;
  // Nachfilterung: nur Treffer behalten, deren egid-Feld exakt übereinstimmt.
  // Normalisierung (trim + String) gegen Typ-/Whitespace-Abweichungen.
  var wanted = String(egid).trim();
  var exact = allResults.filter(function(r){
    var attrs = r.attrs || r.properties || {};
    var candidates = [attrs.egid, attrs.EGID, attrs.gwr_egid, r.featureId, r.id];
    return candidates.some(function(c){ return c !== undefined && c !== null && String(c).trim() === wanted; });
  });

  if (exact.length === 0 && allResults.length > 0) {
    console.log('[building] Kein exakter Feld-Treffer für EGID', wanted, '— gefundene Kandidaten-Werte:',
      JSON.stringify(allResults.map(function(r){
        var a = r.attrs || r.properties || {};
        return { egid: a.egid, EGID: a.EGID, gwr_egid: a.gwr_egid, featureId: r.featureId, id: r.id };
      })));
  }

  // Die Upstream-Abfrage nutzte bereits searchField=egid&contains=false (exakte Feldsuche).
  // Bei genau einem Rohtreffer ist unsere zusätzliche Verifikation daher nur eine Doppelsicherung —
  // schlägt sie fehl (z.B. weil wir den echten Feldnamen nicht kennen), vertrauen wir trotzdem der
  // Upstream-Filterung, statt fälschlich einen einzelnen, wahrscheinlich korrekten Treffer zu verwerfen.
  // Erst bei MEHREREN Rohtreffern ist strenge Nachfilterung nötig, um Verwechslungen zu vermeiden.
  var finalResults;
  var note;
  if (exact.length > 0) {
    finalResults = exact;
  } else if (allResults.length === 1) {
    finalResults = allResults;
  } else if (allResults.length > 1) {
    finalResults = [];
    note = "Mehrere Rohtreffer (" + allResults.length + "), keiner davon eindeutig als exakte EGID-Übereinstimmung erkennbar — sicherheitshalber verworfen.";
  } else {
    finalResults = [];
  }

  res.json({
    variant_used: result.variant_used,
    results: finalResults,
    filtered: true,
    raw_result_count: allResults.length,
    exact_match_count: exact.length,
    note: note
  });
});

// ---------------------------------------------------------------------
// GET /api/parcel?x=&y=  — Grundstücksgrenze (amtliche Vermessung) als Geometrie
// returnGeometry=true, damit wir selbst nur die Umrisslinie zeichnen können
// (der volle AV-WMS enthält auch flächige Bodenbedeckung etc., die wir nicht wollen).
// ---------------------------------------------------------------------
app.get("/api/parcel", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).json({ error: "Parameter 'x' und 'y' erforderlich (EPSG:2056)" });
  const result = await identifyLayer("ch.swisstopo-vd.amtliche-vermessung", x, y, 10, true);
  sendIdentifyResult(res, result, "Grundstuecksgrenze");
});

// ---------------------------------------------------------------------
// GET /api/boden-av?x=&y=  — EXPLORATIV: Fragt denselben AV-Layer ab wie
// /api/parcel, gibt aber ALLE zurückgelieferten Objekte (nicht nur das erste)
// zurück, um zu prüfen, ob die AV-Bodenbedeckungs-Ebene am selben Punkt
// mitgeliefert wird (Gebäude, befestigte Fläche, humusierte Fläche etc.)
// ---------------------------------------------------------------------
app.get("/api/boden-av", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).json({ error: "Parameter 'x' und 'y' erforderlich (EPSG:2056)" });
  const result = await identifyLayer("ch.swisstopo-vd.amtliche-vermessung", x, y, 10, false);
  sendIdentifyResult(res, result, "AV Bodenbedeckung (alle Objekte)");
});

// ---------------------------------------------------------------------
// Hilfsfunktion: fragt einen einzelnen Punkt am LCSF-Layer ab (geodienste.ch)
// und parst die 'Art'-Klassifikation aus der Klartext-Antwort.
// ---------------------------------------------------------------------
async function queryLcsfPoint(xi, yi) {
  const buffer = 5;
  const bbox = [xi - buffer, yi - buffer, xi + buffer, yi + buffer].join(",");
  const width = 101, height = 101;
  const i = Math.floor(width / 2), j = Math.floor(height / 2);
  const url = "https://wfs.geodienste.ch/av_0/deu?" +
    "SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo" +
    "&LAYERS=LCSF&QUERY_LAYERS=LCSF" +
    "&CRS=EPSG:2056&BBOX=" + bbox +
    "&WIDTH=" + width + "&HEIGHT=" + height +
    "&I=" + i + "&J=" + j +
    "&INFO_FORMAT=text/plain&FEATURE_COUNT=5";
  try {
    const upstream = await fetch(url);
    const bodyText = await upstream.text();
    if (!upstream.ok) return { x: xi, y: yi, error: `HTTP ${upstream.status}` };
    const artMatch = bodyText.match(/Art\s*=\s*'([^']*)'/);
    return { x: xi, y: yi, art: artMatch ? artMatch[1] : null, raw: bodyText };
  } catch (err) {
    return { x: xi, y: yi, error: String(err) };
  }
}

// ---------------------------------------------------------------------
// GET /api/boden?x=&y=  — Bodenbedeckung via geodienste.ch (nationaler,
// harmonisierter WMS "AV: Standard", Layer LCSF = "Bodenbedeckung schwarzweiss").
// Deckt alle Kantone einheitlich ab, ist queryable (GetFeatureInfo).
// ---------------------------------------------------------------------
app.get("/api/boden", async (req, res) => {
  const { x, y } = req.query;
  if (!x || !y) return res.status(400).json({ error: "Parameter 'x' und 'y' erforderlich (EPSG:2056)" });
  const xi = parseFloat(x);
  const yi = parseFloat(y);
  const buffer = 5;
  const bbox = [xi - buffer, yi - buffer, xi + buffer, yi + buffer].join(",");
  const width = 101, height = 101;
  const i = Math.floor(width / 2), j = Math.floor(height / 2);
  const url = "https://wfs.geodienste.ch/av_0/deu?" +
    "SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo" +
    "&LAYERS=LCSF&QUERY_LAYERS=LCSF" +
    "&CRS=EPSG:2056&BBOX=" + bbox +
    "&WIDTH=" + width + "&HEIGHT=" + height +
    "&I=" + i + "&J=" + j +
    "&INFO_FORMAT=text/plain&FEATURE_COUNT=5";
  try {
    const upstream = await fetch(url);
    const bodyText = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `geodienste.ch WMS: HTTP ${upstream.status}`, body: bodyText.slice(0, 500) });
    }
    res.json({ raw_response: bodyText, query_url: url });
  } catch (err) {
    res.status(502).json({ error: "Upstream-Fehler bei geodienste.ch", detail: String(err) });
  }
});

// ---------------------------------------------------------------------
// GET /api/boden-grid?minx=&miny=&maxx=&maxy=&n=  — Rastert ein Bounding-Box
// mit n×n Punkten und fragt für jeden die Bodenbedeckung ab. Dient als
// Grundlage für einen Versiegelungsgrad + Kartendarstellung. n max. 8 (=64
// Anfragen) aus Rücksicht auf den Upstream-Server.
// ---------------------------------------------------------------------
app.get("/api/boden-grid", async (req, res) => {
  const { minx, miny, maxx, maxy } = req.query;
  if (!minx || !miny || !maxx || !maxy) {
    return res.status(400).json({ error: "Parameter 'minx', 'miny', 'maxx', 'maxy' erforderlich (EPSG:2056)" });
  }
  const n = Math.min(20, Math.max(2, parseInt(req.query.n, 10) || 6));
  const x0 = parseFloat(minx), x1 = parseFloat(maxx);
  const y0 = parseFloat(miny), y1 = parseFloat(maxy);

  const points = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const px = x0 + (x1 - x0) * (col + 0.5) / n;
      const py = y0 + (y1 - y0) * (row + 0.5) / n;
      points.push([px, py]);
    }
  }

  // In Batches abarbeiten statt alle gleichzeitig — schont den Upstream-Server
  // bei hoher Rasterauflösung (z.B. n=20 → 400 Punkte).
  const batchSize = 25;
  const results = [];
  for (let i = 0; i < points.length; i += batchSize) {
    const batch = points.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(([px, py]) => queryLcsfPoint(px, py)));
    results.push(...batchResults);
  }
  res.json({ n, point_count: results.length, points: results });
});

// ---------------------------------------------------------------------
// GET /api/boden-image?minx=&miny=&maxx=&maxy=&size=  — Lädt die farbige
// Bodenbedeckungs-Karte (Layer LCSFC, "AV: Standard farbig") als Bild und
// reicht es 1:1 durch (gleicher Ursprung wie unser Server → kein CORS-Problem
// beim Pixel-Auslesen im Browser via Canvas).
// ---------------------------------------------------------------------
app.get("/api/boden-image", async (req, res) => {
  const { minx, miny, maxx, maxy } = req.query;
  if (!minx || !miny || !maxx || !maxy) {
    return res.status(400).json({ error: "Parameter 'minx', 'miny', 'maxx', 'maxy' erforderlich (EPSG:2056)" });
  }
  const size = Math.min(800, Math.max(100, parseInt(req.query.size, 10) || 400));
  const bbox = [minx, miny, maxx, maxy].join(",");
  const url = "https://wfs.geodienste.ch/avc_0/deu?" +
    "SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap" +
    "&LAYERS=LCSFC&STYLES=" +
    "&CRS=EPSG:2056&BBOX=" + bbox +
    "&WIDTH=" + size + "&HEIGHT=" + size +
    "&FORMAT=image/png&TRANSPARENT=false";
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `geodienste.ch WMS GetMap: HTTP ${upstream.status}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set("Content-Type", upstream.headers.get("content-type") || "image/png");
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: "Upstream-Fehler bei geodienste.ch (Bild)", detail: String(err) });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Geo-Proxy läuft auf http://localhost:${PORT}`);
  console.log(`Test:  http://localhost:${PORT}/api/search?text=Bahnhofstrasse+1+Zuerich`);
});
