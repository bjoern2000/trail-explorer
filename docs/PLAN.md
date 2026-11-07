# TrailScope — Implementation Plan

Prototype web app to evaluate open US trail data sources (hiking + MTB) for the TWC
all-season mountain intelligence product. Renders trails from six live sources on a 3D
terrain map, with per-source drill-downs, cross-source trail inspection, search, and a
source comparison matrix. Audience: Björn's evaluation work plus stakeholder review
(Stacy, Brian, Jess). This document is the single source of truth for implementation;
sub-agents should follow it exactly and flag (not silently resolve) contradictions.

The approved visual design is `design/mockup.html` (open it in a browser). Match its
look. It contains the design tokens, both views (map + matrix), the source dossier, and
the trail inspector. Where this document and the mockup disagree on *behavior*, this
document wins; on *visuals*, the mockup wins.

## 1. Locked decisions

- **Live data only.** No downloads, no PMTiles, no database. Every trail feature is
  fetched at runtime from the source's public API. (Rationale: evaluating the sources'
  real API behavior is part of the eval.)
- **No auth.** The app is public once deployed.
- **Hosting: Railway.** Node service serving the built static app + one proxy route.
- **Stack:** Vite + TypeScript (strict), no UI framework, `maplibre-gl` 5.x pinned,
  Express 4 server. No React, no Next.js, no Cesium, no Mapbox.
- **Zero API keys.** All map/terrain/data endpoints below are keyless.
- **Multi-page** (Vite multi-page build). Started as two pages, `index.html` (map app)
  and `matrix.html` (source matrix); now four, adding `benchmark.html` (AllTrails
  benchmark, see BENCHMARK_PLAN.md) and `merge.html` (segment merge explainer, see
  MERGE_PLAN.md). Sections are listed once in `src/ui/nav.ts` and rendered as a shared
  top bar on every page; the mockup's inline MAP / SOURCE MATRIX links are superseded by
  it. Adding a page = one `PAGES` entry + one vite input + one html file.
- **UI change vs. mockup:** in a source row, only the checkbox toggles the layer.
  The row itself is NOT a toggle. The "i" affordance is an explicit button (label it
  `INFO`, link-styled or small bordered button) that opens the source dossier. Clicking
  the source name also opens the dossier (name is link-styled on hover).

## 2. Repo layout

```
Prototypes/trail-explorer/
  docs/                      ← plans, API documentation, and reference screenshots
    PLAN.md                  ← this file
    BENCHMARK_PLAN.md        ← source of truth for the AllTrails benchmark page
    DATAMODEL_PLAN.md        ← data model plan
    MERGE_PLAN.md            ← source of truth for the segment merge page
    SCOPE_PLAN.md            ← discovery prototype plan
    TRAIL_PLAN.md            ← trail prototype plan
    references/              ← SSDS API guide and reference screenshots
  design/mockup.html         ← approved static design (reference only, not shipped)
  package.json
  tsconfig.json
  vite.config.ts             ← MPA: index/matrix/benchmark/merge; dev proxy /api → :8081
  index.html                 ← map app shell
  matrix.html                ← source matrix page shell
  benchmark.html             ← AllTrails-vs-open-data benchmark shell
  merge.html                 ← segment merge explainer shell
  benchmark/                 ← benchmark pipeline: derive.mjs, raw/ (gitignored), derived/
  merge/                     ← fixture.mjs (snapshot), verify.mjs (headless run), fixtures/
  server.js                  ← Express: static dist/ + /api/overpass proxy (plain JS, no build)
  src/
    types.ts                 ← shared contracts (Phase 0, then frozen)
    store.ts                 ← tiny typed pub/sub state (Phase 0, then frozen)
    registry.ts              ← SOURCES: all endpoints/fields/dossier content (Phase 0)
    tokens.css               ← design tokens extracted from mockup
    map/
      map.ts                 ← MapLibre bootstrap: basemaps, terrain, sky, hillshade
      layers.ts              ← per-source GeoJSON sources/layers, selection layer, click/hover
      camera.ts              ← flyToTrail choreography
    data/
      arcgis.ts              ← ArcGIS query adapter
      overpass.ts            ← Overpass adapter + OSM→GeoJSON conversion
      loader.ts              ← viewport orchestration: debounce, abort, cache, cap detection
      merge.ts               ← name grouping, spatial clustering, chaining, segment merge
                               (no browser imports: also runs under plain Node)
      elevation.ts           ← terrarium tile sampler → elevation profile
    search/
      search.ts              ← cross-source name search (Nominatim + ArcGIS LIKE)
    ui/
      nav.ts                 ← PAGES list + shared top-bar nav, mounted by every page
      sidebar.ts             ← brand, tabs, search box/results, source rack, map controls
      dossier.ts             ← source drill-down card
      inspector.ts           ← selected-trail card + attribute table + profile + actions
      statusbar.ts           ← coords/zoom/pitch + per-source counts
      dom.ts                 ← h() helper, escapeHtml, formatters
    matrix/
      matrix.ts              ← renders matrix.html table from registry + benchmark rows
    benchmark/               ← benchmark page (see BENCHMARK_PLAN.md)
    merge/                   ← segment merge page: model, pipeline, mmap (see MERGE_PLAN.md)
    main.ts                  ← index.html entry: wire store ↔ map ↔ ui
  public/
    favicon.svg
```

## 3. Design system

Extract from `design/mockup.html` into `src/tokens.css`. Key tokens:

- Chrome: `--ink #0e1b16`, `--panel #13251d`, `--panel-2 #182e24`, `--line #23402f`,
  `--line-soft #1b3325`, `--text #e6f0e4`, `--muted #8ca795`, `--faint #5d7a68`,
  accent `--accent #ffb454`.
- Source colors: OSM `#d93a52`, USFS `#1f8f55`, NPS `#7757e0`, BLM `#d07e00`,
  USGS `#2277cc`, COTREX `#0e9c97`.
- Fonts, self-hosted via npm (no CDN): `@fontsource/barlow-condensed` (500/600/700)
  for display/headers, `@fontsource/barlow` (400/500) for body,
  `@fontsource/ibm-plex-mono` (400/600) for data readouts. The mockup used system
  stand-ins; the app uses these real faces.
- Single dark theme (map chrome). No light theme needed.
- License chips: PUB DOM (green outline), ODbL (amber outline), STATE (blue outline)
  as in mockup.

## 4. Shared contracts (Phase 0 — write first, then freeze)

`src/types.ts` (exact shape; workstreams code against this):

```ts
export type SourceId = 'osm' | 'usfs' | 'nps' | 'blm' | 'usgs' | 'cotrex';

export interface TrailSourceDef {
  id: SourceId;
  label: string;              // "USFS · NFS Trails"
  color: string;
  kind: 'arcgis' | 'overpass';
  queryUrls: string[];        // ArcGIS: 1+ layer /query URLs (BLM has 2). Overpass: interpreter URLs in fallback order.
  nameField: string;          // primary name attribute (OSM: 'name' tag)
  idField: string;            // 'objectid' | 'OBJECTID' | 'FID' | '@id'
  minZoom: number;            // below this, don't fetch; show "zoom to load"
  maxRecordCount: number;     // 2000 for all ArcGIS
  licenseChip: 'PUB DOM' | 'ODbL' | 'STATE';
  enabledByDefault: boolean;
  searchable: boolean;
  dossier: {
    lede: string;
    scope: string; license: string; access: string; updated: string; attributes: string;
    strengths: string[]; limitations: string[];
    endpointDisplay: string;  // truncated endpoint for display
    links: { label: string; url: string }[];
  };
}

export interface SourceViewportState {
  status: 'idle' | 'loading' | 'ready' | 'error' | 'below-zoom' | 'disabled';
  featureCount: number;
  capped: boolean;            // hit maxRecordCount / exceededTransferLimit
  elapsedMs: number | null;
  error?: string;
}

export interface SelectedTrail {
  sourceId: SourceId;
  feature: GeoJSON.Feature;   // full feature from cache (not tile-clipped)
  name: string;
}

export interface AppState {
  enabled: Record<SourceId, boolean>;
  viewport: Record<SourceId, SourceViewportState>;
  selected: SelectedTrail | null;
  dossierOpen: SourceId | null;
  basemap: 'usgs-topo' | 'usgs-imagery' | 'opentopo';
  terrain3d: boolean;         // default true
  exaggeration: number;       // default 1.4
  hillshade: boolean;         // default true
}
```

`src/store.ts`: `createStore(initial)` with `get()`, `set(partial)`, and
`subscribe(keys, fn)`. ~40 lines, no dependency.

Feature identity: every feature gets `properties.__fid = sourceId + ':' + <idField value>`
and `properties.__source = sourceId` injected at fetch time. UI and layers use only
`__fid`/`__source` for lookups.

## 5. Source registry (verified constants — do not re-derive)

All endpoints verified live 2026-07-08 with browser-style CORS (no key, no proxy needed).
All ArcGIS layers: polyline, `maxRecordCount` 2000, `f=geojson` supported.

### ArcGIS query pattern (shared adapter)

`GET {layerUrl}/query` with:
`f=geojson`, `where=1=1`, `geometry={xmin},{ymin},{xmax},{ymax}`,
`geometryType=esriGeometryEnvelope`, `inSR=4326`, `outSR=4326`,
`spatialRel=esriSpatialRelIntersects`, `outFields=*`, `resultRecordCount=2000`.
Cap detection: `json.exceededTransferLimit === true` OR `features.length >= 2000`.
Name search: same URL with `where=UPPER({nameField}) LIKE UPPER('%{term}%')` (escape
single quotes by doubling), `resultRecordCount=15`, no geometry filter.

### Sources

| id | queryUrls | nameField | idField | minZoom |
|---|---|---|---|---|
| `usfs` | `https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query` | `trail_name` | `objectid` | 9 |
| `nps` | `https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0/query` | `TRLNAME` | `OBJECTID` | 9 |
| `blm` | layers 4 and 5 of `https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/{4,5}/query` (merge; tag `properties.__sublayer = 'non-motorized' \| 'non-mechanized'`) | `ROUTE_PRMRY_NM` | `OBJECTID` (prefix __fid with sublayer index to avoid collisions) | 9 |
| `usgs` | `https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query` | `name` | `objectid` | 10 |
| `cotrex` | `https://services3.arcgis.com/0jWpHMuhmHsukKE3/arcgis/rest/services/CPW_Trails_08222024/FeatureServer/2/query` | `name` | `FID` | 9 |
| `osm` | `/api/overpass` (server proxies to `https://overpass-api.de/api/interpreter`) | `name` tag | `@id` (`way/123`) | 11 |

Notes baked into dossier content:
- COTREX service name embeds a snapshot date and churns when CPW republishes; if it 404s,
  resolve the current URL via https://geodata.colorado.gov/datasets/CPW::cotrex-trails.
- USGS layer 37 is the National Digital Trails aggregate; lineage fields
  `sourceoriginator` / `sourcedatasetid` say which agency a feature came from.
- Key attribute fields per source (verified): USFS `trail_class, trail_surface,
  typical_trail_grade, typical_tread_width, gis_miles, attributesubset,
  hiker_pedestrian_managed…, bicycle_managed…, e_bike_class1_managed…`;
  NPS `TRLSTATUS, TRLSURFACE, TRLCLASS, TRLUSE, SEASONAL, MAINTAINER, UNITNAME`;
  BLM `PLAN_MODE_TRNSPRT, PLAN_ALLOW_MODE_TRNSPRT, OBSRVE_SRFCE_TYPE,
  PLAN_OHV_ROUTE_DSGNTN, PLAN_SEASON_RSTRCT_CODE, GIS_MILES, ADMIN_ST`;
  USGS `trailtype, trailsurface, hikerpedestrian, bicycle, ebike, packsaddle,
  primarytrailmaintainer, nationaltraildesignation, lengthmiles, seasonopen,
  sourceoriginator`;
  COTREX `type, surface, oneway, access, hiking, bike, horse, ski, snowshoe,
  snowmobile, dogs, manager, length_mi_, min_elevat, max_elevat, url`.

### Overpass query (viewport fetch)

```
[out:json][timeout:30];
way["highway"~"^(path|footway|track)$"]({s},{w},{n},{e});
out geom qt 6000;
```

Convert in `overpass.ts`: each element with `type:'way'` and `geometry` →
`Feature<LineString>` with `coordinates = geometry.map(p => [p.lon, p.lat])` and
`properties = { ...tags, '@id': 'way/' + id }`. Style hook: `informal=yes` OR
`access` in `('no','private','discouraged')` renders **dashed** (`line-dasharray [2.2, 1.8]`).

### Search endpoints

- OSM nationwide: `https://nominatim.openstreetmap.org/search?q={term}&format=jsonv2&limit=8&countrycodes=us&polygon_geojson=1` (GET, browser-direct; CORS `*`). Filter results to
  `class` in `('highway','route','leisure','natural')`; use `geojson` member for geometry
  when LineString/MultiLineString; else just flyTo the bbox. Manual search on Enter only
  (Nominatim forbids autocomplete). One request per Enter press.
- ArcGIS sources: LIKE query as above, `returnGeometry=true`. Run only against enabled +
  searchable sources, in parallel; group results by source in the dropdown as mocked.

### Basemaps & terrain (keyless)

- `usgs-topo` (default): raster `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}`, maxzoom 16, attribution "USGS The National Map".
- `usgs-imagery`: same host, `USGSImageryTopo/MapServer/tile/{z}/{y}/{x}`.
- `opentopo`: `https://{a|b|c}.tile.opentopomap.org/{z}/{x}/{y}.png`, maxzoom 17,
  attribution "© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)".
  Implement all three as always-present raster sources; switching toggles layer
  visibility (never `setStyle`, so overlays survive).
- Terrain + hillshade: TWO `raster-dem` sources (MapLibre requires separate instances)
  both from AWS Terrarium `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`,
  `encoding:'terrarium'`, tileSize 256, maxzoom 15. `map.setTerrain({source, exaggeration})`
  when 3D on; hillshade layer (subtle, `hillshade-exaggeration ~0.35`) toggleable.
- Sky: `map.setSky` with soft horizon blend as supported in MapLibre 5.
- Initial camera: Rocky Mountain NP / Bear Lake area `[-105.646, 40.313]`, zoom 12,
  pitch 0 (2D on load; user enables 3D or Fly To does it).

## 6. Behavior specs

### Viewport loading (`loader.ts`)
On `moveend` (+ initial load) with 400 ms debounce: for each enabled source with
`zoom >= minZoom`, fire the adapter with an `AbortController` (abort any in-flight
request for that source first). Update `viewport[sourceId]` through the store:
loading → ready/error with `featureCount`, `elapsedMs`, `capped`. Below `minZoom`,
set `below-zoom` and clear the layer. Cache: keep only the latest FeatureCollection
per source in memory (`Map<SourceId, FeatureCollection>`) — it backs click lookup and
the inspector; no persistence.

### Map layers (`layers.ts`)
Per source: one GeoJSON source + one line layer (`line-color` = source color,
`line-width` interpolate z10:1.2 → z15:3), plus the OSM dashed variant via a second
layer filtered on informal/access. Selection: separate `selected` GeoJSON source with
white halo underlay + colored core line (mockup shows the treatment) + start/end
circle layers. Hover: `line-width` bump via feature-state on `mousemove`, pointer cursor.
Click: `queryRenderedFeatures` on all trail layers → top feature → look up full feature
in cache by `__fid` → `store.set({selected})`.

### Inspector (`inspector.ts`)
As mocked: source badge + license inline, name (fallback `(unnamed)` + id), meta row
(length in mi — compute haversine from geometry; elevation min/max once profile loads),
elevation profile SVG, attribute table listing **populated** fields first with
"N of M populated" header and a "show empty" toggle, "same corridor in" is OUT OF SCOPE
for v1 (cut it; it needs conflation), license note block from registry, actions:
**FLY TO 3D** (camera.ts), **RAW JSON** (opens `<dialog>` with pretty-printed feature),
**GPX** (client-side GPX 1.1 blob download of the LineString, named after the trail).

### Fly to 3D (`camera.ts`)
`fitBounds` of the feature with 80 px padding → on `moveend`, `easeTo` pitch 60,
bearing aligned to the trail's overall start→end azimuth, 1.8 s duration. Enables
terrain if it was off (and reflects that in the store/controls).

### Elevation profile (`elevation.ts`)
Resample the LineString to 120 evenly spaced points (haversine cumulative distance).
For each point compute the z13 terrarium tile + pixel, fetch tiles once
(`Map<tileKey, ImageData>` cache, decode via OffscreenCanvas or hidden canvas),
elevation = `(R*256 + G + B/256) - 32768` meters. Render the mockup's SVG treatment
(area fill + line + endpoint dot) plus computed total gain (sum of positive smoothed
deltas), min/max elevation in feet. Runs async after selection; show a subtle
"sampling terrain…" placeholder.

### Search (`search.ts` + sidebar)
Enter-triggered. Fan out to Nominatim + enabled ArcGIS sources in parallel with 8 s
timeout each; render grouped results with source swatch + subtitle (as mocked; show
miles when a length field exists). Result click: inject feature into the selection
(and its source's cache), flyTo bounds, open inspector. Handle zero results and
per-source search errors inline ("USGS search failed") without blocking other groups.

### Dossier (`dossier.ts`)
Opens from the INFO button / source name; card anchored top-left over the map as
mocked; only one open at a time; ESC or ✕ closes. Content entirely from
`registry.ts` dossier fields, including a live line: current viewport feature count +
capped state. Include `links` as real `<a target="_blank">`.

### Status bar
Coords (4 decimals, N/W formatting as mocked), zoom (1 decimal), pitch. Per-source
chips: swatch + formatted count, `▲` suffix when capped, hidden when source disabled.

### Matrix page (`matrix.html` + `matrix/matrix.ts`)
Standalone page, same tokens, table exactly as in the mockup (already content-complete):
6 open sources from registry + a `BENCHMARKS` const (Trailforks, AllTrails rows —
static, not in `SourceId`). Band rows "Open · usable in product" / "Restricted ·
benchmark only". Sticky header, `overflow-x: auto` wrapper. Header links back to the
map page. Footer line: "Endpoints and counts verified 2026-07-08."

### Server (`server.js`)
Express: `express.static('dist')`, and `POST /api/overpass` accepting
`{ query: string }` (or raw `data=` form), forwarding to overpass-api.de, on
non-200/timeout (25 s) retrying the next configured upstream, returning upstream JSON with correct
status. In-memory cache: `Map<queryHash, {ts, body}>`, TTL 10 min, max 50 entries
(evict oldest). `app.listen(process.env.PORT || 8081)`. In dev, `vite.config.ts`
proxies `/api` → `http://localhost:8081` (run `node server.js` alongside `vite`;
add npm script `dev:all` using two processes or document running both).

## 7. Execution plan for sub-agents

Model: Opus for all workstreams. Contracts land first; parallel agents own disjoint
files and must not edit files outside their workstream.

- **Phase 0 (one agent, blocking):** scaffold — package.json (pin `maplibre-gl` to the
  newest 5.x version at least 7 days old: `~/.npmrc` enforces `min-release-age=7`),
  tsconfig, vite.config (MPA + proxy), tokens.css, `types.ts`, `store.ts`,
  `registry.ts` fully populated (dossier copy can start from the mockup + §5 notes),
  `ui/dom.ts`, empty module stubs with typed exports so everything compiles,
  `index.html`/`matrix.html` shells with the sidebar/table skeletons, `server.js`.
  Deliverable: `npm run build` passes; `npm run dev` shows the shell.
- **Phase 1 (four parallel agents):**
  - **A — Map core:** `map/map.ts`, `map/camera.ts` (basemaps, terrain, sky,
    hillshade, controls wiring).
  - **B — Data:** `data/arcgis.ts`, `data/overpass.ts`, `data/loader.ts` (+ the
    Overpass proxy behavior in `server.js`).
  - **C — UI:** `ui/sidebar.ts`, `ui/dossier.ts`, `ui/statusbar.ts`,
    `matrix/matrix.ts`.
  - **D — Selection:** `map/layers.ts`, `ui/inspector.ts`, `data/elevation.ts`,
    `search/search.ts`.
  Where two workstreams meet (e.g. D's layers need A's map instance), the contract is
  the store + an exported `getMap(): maplibregl.Map` from `map/map.ts` (Phase 0 stub).
- **Phase 2 (one agent):** integration + QA against §8, fixing cross-module seams.

## 8. Verification checklist (Phase 2 gate)

1. `npm run build` clean; `node server.js` serves both pages from `dist/`.
2. Load map → USGS Topo renders, five default sources load over RMNP, status bar
   counts match sidebar counts.
3. Toggle each source on/off; disabled sources clear from map and status bar.
4. Zoom to z8 → "zoom to load" states appear, no requests fired (check Network tab).
5. Pan in Moab, UT → BLM features appear; pan in Yosemite → NPS features appear.
6. USGS shows `▲ capped` in dense areas (e.g. Denver front country at z10).
7. OSM informal/access-restricted trails render dashed (RMNP has examples).
8. Click a USFS trail → inspector: correct name, populated-field count, license block;
   RAW JSON dialog; GPX downloads and opens in a GPX viewer with correct geometry.
9. Elevation profile appears within ~2 s, gain/min/max plausible for a known trail.
10. FLY TO 3D: smooth fit → tilt; terrain visibly 3D; trail line drapes on terrain.
11. Search "bear lake" → grouped results incl. USFS + OSM; result click selects + flies.
12. Search with OSM disabled → no Nominatim request.
13. Dossier opens from INFO button and source name; ESC closes; content matches registry.
14. Matrix page renders all 8 rows; horizontal scroll works at narrow widths; link back.
15. Kill Overpass upstream (block host in devtools) → proxy falls back / error state
    shows in the OSM row without breaking other sources.
16. No API keys anywhere in the bundle; no requests to Mapbox/MapTiler/Cesium.

## 9. Deployment (Railway)

Nixpacks auto-detect: build `npm ci && npm run build`, start `node server.js`, respect
`PORT`. No env vars, no volumes, no database. Custom domain optional later.
