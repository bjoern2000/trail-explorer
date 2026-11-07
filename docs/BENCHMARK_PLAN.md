# TrailScope — AllTrails Benchmark Plan

Add a measured comparison of open trail data sources against AllTrails for selected
regions, using the Apify actor `parseforge/alltrails-scraper` (MMQdritoUWpzUVbah).
Extends the existing MEASURED band on the matrix page. Planning doc; no code yet.

## 1. What the benchmark answers

The matrix page today measures the six open sources against each other with one
identical method (metrics.ts, 6 fixed bbox regions). AllTrails sits in a static
"restricted, benchmark only" card with qualitative copy. This benchmark makes that
row quantitative:

1. **Inventory coverage.** Of the routes real users actually hike (AllTrails
   inventory, weighted by review count), what share is represented in each open
   source and in any open source?
2. **Attribute gap.** Which decision-relevant attributes does AllTrails have that
   open data lacks (difficulty, ratings, reviews, photos, monthly popularity,
   closures/alerts, accessibility flags), and vice versa (surface, tread width,
   trail class, manager, allowed uses)?

Feeds the TWC narrative: can a product be built on open trail data, and what layer
of value would need to come from elsewhere.

## 2. Scraper validation (done 2026-07-10)

One test run against the RMNP benchmark bbox (`searchType: "coordinates"`,
maxItems 10, run `apo1LoCWETCMVlzwp`, ~$0.15):

**Works:**
- Custom bbox mode maps 1:1 onto the existing `REGIONS` bboxes in metrics.ts.
  Field naming is odd: `customTopLat`=N, `customTopLng`=W, `customBottomLat`=S,
  `customBottomLng`=E.
- Output is rich: 85 fields per trail incl. name, trailhead lat/lng, length,
  elevation gain, difficulty, route type, avgRating, numReviews, numPhotos,
  numRecordings, visitorUsage, popularityByMonth (12 buckets), features[],
  activities[], isClosed, alerts, ADA/kid/dog flags, trailUrl.
- Data spot-checked as accurate (Bear Lake area routes, plausible lengths/gains).

**Limitations found:**
- **No geometry.** One trailhead point per route, no polyline. Matching to open
  sources must be name-based + trailhead proximity, not geometric conflation.
- **Exhaustiveness: verified OK (2026-07-10).** With maxItems 300 the RMNP bbox
  returns 141 routes (127 in-bbox; the scraper spills slightly past the bounds).
  Cross-check by 2x2 quadrant tiling: the union (135 ids) is a strict subset of
  the single full-bbox run. One run per region with a generous maxItems is
  exhaustive; no tiling needed. Quirks: very low maxItems (10) truncated oddly
  (5 results), and run metadata can report a stale 0 itemCount right after the
  run — download the dataset before trusting counts.
- Routes vs segments: AllTrails records are curated *routes* (loops/out-and-backs
  composed of many trail segments); open sources are *segment networks*. Raw
  counts are not comparable. Frame everything as route coverage, never count
  parity.

**Cost:** $0.005/run + ~$0.0147/result (Bronze tier). 6 regions x 100–500 routes
≈ $10–45 for a full one-time snapshot. Negligible.

## 3. Architecture: offline snapshot, static derived data

No runtime scraping. The deployed app stays keyless and only ships derived
aggregates.

```
Prototypes/trail-explorer/
  benchmark/
    raw/<regionId>.json        ← actor dataset dumps, one per region (NOT bundled)
    derive.mjs                 ← node script: raw + open-source fetches → derived
  src/benchmark/alltrails.json ← derived aggregates, committed, imported by matrix
```

Pipeline:

1. **Snapshot.** Run the actor once per region with the exact metrics.ts bboxes,
   maxItems 500. Save dataset JSON to `benchmark/raw/`. Record run IDs + date.
2. **Open-source pull.** `derive.mjs` fetches the same bboxes from the six sources
   using the same query patterns as the app (ArcGIS envelope query, Overpass), or
   reads the server's disk cache. Same data, same method as the MEASURED band.
3. **Match.** For each AllTrails route:
   - Tokenize the route name into constituent trail names. AllTrails names are
     compound ("Nymph, Dream, Emerald, and Haiyaha Lakes via Nymph Lake Trail"):
     split on commas, "and", "via", "to"; also keep the full name as one token.
   - Normalize with the existing `normalizeTrailName` (loader.ts).
   - A route **matches a source** if ≥1 token matches a normalized trail name in
     that source within ~5 km of the route's trailhead point (reuse the
     altsources.ts proximity approach). Record matched/unmatched per source.
   - Store per-route: name, point, lengthMeters, difficulty, numReviews, and the
     per-source match booleans. Nothing else ships (no descriptions, no photo
     URLs).
4. **Derive metrics** per region + pooled:
   - Coverage % per source and any-source; also weighted by numReviews and a
     top-25-most-reviewed cut (headline number).
   - Attribute gap table: population % of comparable fields (difficulty, surface,
     length, gain, usage, closure info) AllTrails vs each open source, plus the
     AllTrails-only community layer (ratings/reviews/photos/popularity) called out
     as structurally absent from open data.
   - Length sanity check on matched routes (median ratio, flags bad matching).
5. **UI.** New band on `matrix.html`: `VS ALLTRAILS · snapshot <date>, 6 regions,
   route-level name+proximity matching`. Coverage table (regions x sources),
   attribute gap table, and a short methodology note including the routes≠segments
   caveat and match-rule description. Data via static import; the band renders
   instantly, no fetches.
6. **Optional (cut first):** map overlay of AllTrails trailhead points colored
   matched/unmatched — useful for eyeballing match quality during development,
   maybe not shipped.

## 4. Positioning and data handling

- AllTrails ToS prohibits scraping. This is an internal competitive benchmark for
  an evaluation prototype: keep raw dumps out of the shipped bundle and out of
  git if the repo ever goes public; publish only aggregates + per-route match
  flags. Never reproduce descriptions, photos, or review text. Link out to
  alltrails.com for anything route-specific.
- Matrix framing stays "Restricted · benchmark only", now with a snapshot date.
- All six existing regions are US, which is consistent with the CONUS-only MVP
  constraint from the science feasibility response.

## 5. Phases

- **Phase 0 — exhaustiveness check. DONE 2026-07-10** (see §2): single bbox run
  is exhaustive, tiling adds nothing.
- **Phase 1 — snapshot regions.** DONE for RMNP (`benchmark/raw/rmnp.json`,
  run w1CCmQzhgDN5KEPU1, 141 routes) and the Adirondack High Peaks
  (`benchmark/raw/adk.json`, run mkSoGRivuRF1jZsHy, 168 routes, ~$2.47).
  The ADK bbox `[-74.02, 44.05, -73.78, 44.26]` is new, not one of the 6 MEASURED
  regions: it was chosen deliberately as a state-land stress case (see §7).
  Cheap pre-step worth repeating: probe a candidate bbox with count-only queries
  (ArcGIS `returnCountOnly`, Overpass `out count`) before paying for a scrape. It
  costs nothing, confirms which sources actually hold data there, and verifies cap
  headroom.
- **Phase 2 — derive.mjs. DONE 2026-07-10** (`benchmark/derive.mjs`, standalone
  node, no deps; run `node benchmark/derive.mjs <region>`). Match audit done for
  RMNP: 10 weakest matches all true positives; unmatched high-review routes are
  genuine naming-scheme gaps (consumer destination-named routes vs agency
  junction-named segments), verified against NPS TRLNAME values. Coverage % is
  therefore a LOWER BOUND on physical coverage; a trailhead network-presence
  proxy metric reports the upper-bound side.
- **Phase 3+4 — benchmark page. DONE 2026-07-10**, delivered as a full third MPA
  page (`benchmark.html`) instead of a matrix band: MAP view (bbox, outcome-colored
  trailhead dots, live segment-geometry highlighting via matched featureIds) and a
  text-first TABLE view (sortable, expandable per-route accordion listing the
  matched open-source segments per source), plus headline stats and methodology
  note. Fuzzy tier 2 (2a/2b/2c) and denominator exclusions (roads, private) landed
  in derive.mjs; RMNP headline: 80% exact / 86% incl. fuzzy any-source coverage
  over 123 eligible routes, 100% network presence. A high-effort code review ran
  over the whole feature; all 10 verified findings fixed.
- **Phase 5 — second region. DONE 2026-07-21** (Adirondack High Peaks). No code
  changes were needed beyond one JSON import and one `REGIONS` entry in
  `src/benchmark/model.ts`; the page's region `<select>` picked it up. This
  confirms the region-parameterized design holds.
- **Phase 6 — third region. DONE 2026-07-21** (Lake of the Ozarks MO), a
  non-destination control case. Also produced two method constraints, see §7.2.
- **Remaining regions**: on hold pending TWC client review.

## 6. Open decisions

1. **Regions:** RMNP (federal best case) and the Adirondacks (state stress case)
   now bracket the range, which is more informative than 6 similar federal
   regions would have been. Remaining MEASURED regions are optional.
2. **Snapshot cadence:** one-time (recommended for a prototype) vs re-runnable
   script with date-stamped snapshots.
3. **Whether the quant deck / findings docs cite these numbers** — if yes, the
   Phase 2 match-quality audit needs to be documented alongside.
4. **NYS DEC as a seventh source.** RESOLVED 2026-07-21: added, and it recovers
   no coverage because USGS already ingests it (see §7.1). Kept in the registry
   as evidence. The remaining open version of this question is whether USGS
   subsumes state sources in states other than NY.

## 7. Region findings

### RMNP (2026-07-10) — federal best case

80% exact / 86% incl. fuzzy any-source coverage over 123 eligible routes, 100%
trailhead network presence. NPS, USGS, COTREX, and OSM all hold data.

### Adirondack High Peaks (2026-07-21) — state-land stress case

Chosen to break a specific assumption: RMNP has one strong federal land manager
with well-curated data, which is the friendliest possible case. The Adirondack
Forest Preserve is NYS DEC land with no federal manager at all.

Count-only probe, before any scraping:

| source | RMNP (control) | ADK High Peaks |
| ------ | -------------- | -------------- |
| usfs   | 0              | 0              |
| nps    | 253            | 0              |
| blm    | 0              | 0              |
| usgs   | 274            | 250            |
| cotrex | 143            | 0 (CO-only)    |
| osm    | 855 ways       | 1,009 ways     |

Derived result over 111 in-bbox routes: **65% any-source coverage**, and the
fuzzy tier adds nothing (2 fuzzy matches, both on already-matched routes, vs 8
at RMNP). So the exact/fuzzy spread that softened the RMNP headline does not
exist here.

Three things this establishes:

1. **Four of six sources return literally zero.** On first read this looked like
   a structural federal-vs-state gap. It is not: see §7.1, where adding the state
   source directly disproved that reading. USFS, NPS, BLM and COTREX are
   land-manager sources correctly silent on land they do not manage, and the
   national aggregate (USGS) covers the Forest Preserve fine.
2. **Unweighted coverage falls 15 points, but review-weighted coverage rises**,
   to 86% (88% of the top-25 most-reviewed) vs 79%/80% at RMNP. OSM and USGS
   cover the named network people actually walk. What they miss is the long tail
   of AllTrails' composite peak-bagging routes ("Great Range Traverse", "Marcy,
   Gray, Skylight, Haystack, Sawteeth, Gothics, and Wolfjaws Loop") plus
   destination-named routes like "Mount Marcy" whose underlying segments carry
   junction names. Same lower-bound caveat as RMNP, more pronounced here because
   High Peaks culture is route-oriented rather than trail-oriented.
3. **Network presence is still 100%.** Every trailhead sits within 100 m of a
   mapped segment. OSM mapper density is in fact *higher* here than at RMNP
   (1,009 vs 855 ways), so this is not an under-mapped region. The gap is naming
   and curation, not missing geometry.

### 7.1 NYS DEC added as a seventh source (2026-07-21). Recovers nothing.

The obvious follow-up was to add the NYS DEC layer and measure how much one
state integration recovers between the 65% floor and the 100% network-presence
ceiling, as a proxy for what national coverage costs. Done, and the answer
inverts the question.

Source: `DEC_Trails/FeatureServer` layer 1 (Hiking Trails), 5,283 statewide
hiking segments (~4,308 mi), 251 in the ADK bbox. Only the hiking layer is
queried; the service publishes ski / horse / bike / snowmobile as parallel
layers, and pulling those would double-count a separate network.

**Result: any-source coverage stays at exactly 65%.** DEC and USGS match an
identical **62 of 62** routes: zero DEC-only, zero USGS-only. Their matched
name sets differ only in casing artifacts ("W.A. White Trail" vs "W.a. White
Trail") and they share source-data typos ("Casade Mountain Trail"). This is one
dataset appearing twice: **USGS National Digital Trails already ingests the DEC
network.**

The same redundancy is visible at RMNP, where USGS and NPS both match 87 routes.

Three consequences:

- **USGS is a genuine national aggregate, not a federal-land source.** The
  earlier "federal-land stack" reading in §7 was wrong. Coverage does not
  degrade on state land.
- **National build does not mean ~50 state integrations.** USGS + OSM is the
  backbone. Direct state sources buy attribute richness (DEC per-use flags and
  marker colors, COTREX per-activity designations), not coverage.
- **The 65% ADK gap has the same cause as the RMNP gap:** AllTrails' route
  naming and curation layer. It is not a land-ownership artifact.

Caveat: verified in one state. USGS aggregation completeness plausibly varies by
state, so treat "USGS subsumes the state source" as demonstrated for NY, not
proven nationally. Cheapest way to test another: run the count-only probe plus a
DEC-style direct source in a second state and compare matched sets, no scrape
needed.

DEC is kept in the registry despite adding no coverage: it is the evidence for
the redundancy finding, and it exercises the matrix page's second state-scoped
source alongside COTREX.

### Lake of the Ozarks, MO (2026-07-21) — non-destination control case

Both earlier regions are destinations people travel to. This one tests whether
the numbers hold where a weather product's users actually live: Lake of the
Ozarks and Ha Ha Tonka State Parks, Missouri DNR land, lakes and woods, no
federal manager, no national destination status.

Result over 32 eligible routes (15,854 reviews): **81% exact / 84% incl. fuzzy,
97% review-weighted, 24 of the top 25 most-reviewed, 91% network presence within
100 m (100% within 1 km).** Only USGS (127 features) and OSM (846) hold data.

This is *better* than the Adirondacks (65%) and on par with RMNP (80/86%), which
kills the intuitive hypothesis that coverage tracks remoteness or prestige. The
mechanism is naming: state-park trails carry canonical single names ("Rocky Top
Trail", "Devil's Kitchen Trail") that map 1:1 onto mapped segments, whereas
Adirondack routes are composite peak-bagging constructions. Across all three
regions the variable is AllTrails' curation layer, not geometry or ownership.

Denominator is 32, materially smaller than 123 and 111, so treat as directional.

### 7.2 Two constraints found while selecting this region

**1. The OSM record cap bounds where this method works.** Candidate bboxes were
screened with the free count-only probe first. Three were rejected for exceeding
the 6,000 OSM cap: Dayton OH (9,248), central MO farmland (7,072), east-central
IN (5,684, uncomfortably close). The overflow is town sidewalks and footways,
not trails. A capped fetch truncates silently and would have produced a
confidently wrong OSM number. Destination regions never hit this because they
have no sidewalks. Fixing it means excluding `footway=sidewalk` from the Overpass
query, which would break comparability with the existing regions, so it is left
alone and documented instead. **Always probe before scraping.**

**2. AllTrails inventory is destination-shaped, which bounds the denominator.**
Route counts: 123 (RMNP), 111 (ADK), 32 (Ozarks), 9 (Cullman County AL), 9
(Northwoods WI). In genuinely trail-poor rural areas there is almost nothing to
benchmark against. Cullman was scraped and derived before being set aside:
6 eligible routes, 1 matched by any source, 50% network presence within 100 m,
and only 6 of 178 OSM ways carrying a name. `benchmark/derived/cullman.json` is
kept as evidence but deliberately left out of `REGIONS`, because n=6 cannot
carry percentages (each route would be 17 points) and the page renders
percentages. Read it as directional only: in trail-poor areas *both* AllTrails
and open data are thin, and AllTrails' consumer advantage is thin with them.
