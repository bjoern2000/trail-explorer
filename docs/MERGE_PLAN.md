# TrailScope — Segment Merge page

`merge.html` — an explainer for how a name search against OpenStreetMap becomes one
trail. Audience: TWC's technical PM and a research scientist, so it is precise about
mechanism and parameters without assuming anyone reads TypeScript. This document is
the source of truth for the page, as `BENCHMARK_PLAN.md` is for the benchmark.

**Format: a long vertical document, not an app.** The page scrolls top to bottom as
prose with a map figure at each step, a sticky contents rail on wide viewports, and
per-figure numbers, legend and GeoJSON disclosure. The maps stay interactive (pan,
zoom buttons) but `scrollZoom` is off so a figure never traps the page scroll. Figures
are created lazily on scroll-into-view; there are eight maps.

## 1. What the page claims, and why it is allowed to

The page does not describe an algorithm; it *runs* the one the map app ships. Every
count, length and part number on screen is computed at page load by `src/merge/pipeline.ts`
calling `src/data/merge.ts` — the same functions `search.ts`, `sidebar.ts` and
`altsources.ts` call when a user picks a search result. Counts, lengths, cluster and
chain numbers are interpolated into the prose at render time, so if the merge logic
changes the document changes with it.

A handful of numbers in the copy are hand-written because they come from one-off
diagnostics rather than the pipeline: the 600 m endpoint gap and mid-line 0 m contact
at Rocky Top, the ~2 km gap at Longs Peak, and the 0 m neighbour distances at
Van Hoevenberg. `node merge/verify.mjs` reproduces the per-stage numbers; the endpoint
distances were measured with an ad-hoc script over the same fixtures. Re-check both
after any change to the merge logic.

## 2. The pipeline, as the page presents it

| Step | Section | What runs | Illustrated with | Tunable |
|---|---|---|---|---|
| — | What OpenStreetMap stores | all five pipelines, for the summary table | all five | — |
| — | Three rules | the parameter table + the five-step outline | — | — |
| 0 | The request | the Overpass query itself | Bear Lake | — |
| 1 | What comes back | `waysToFeatures` | Bear Lake | — |
| 2 | Keep one trail | group by `normalizeTrailName`, keep one bucket | Bear Lake | exact match after lowercase + whitespace collapse |
| 3 | Split by geography | `clusterSegmentsAll` (union-find over bbox proximity) | Nature Trail (statewide) | `CLUSTER_GAP_M` = 2000 m |
| 4 | Join end to end | `chainSegmentsDetailed` (orient + join, greedy at junctions) | Bear Lake, then Van Hoevenberg | `CHAIN_TOLERANCE_M` = 35 m |
| 5 | One trail | `mergeSegmentsToFeature` → LineString / MultiLineString | Bear Lake | — |
| 6 | When it comes back in pieces | — | Rocky Top, Longs Peak, Van Hoevenberg | — |
| — | Merging fixes fragmentation, not naming | — | Longs Peak | — |
| — | Running this for real | — | — | — |

A TL;DR box sits between the header and the first section: five bullets covering the
three rules, the clean case, the three causes of multi-part output, the naming limit,
and the production caveat. It is deliberately not a `.sec`, so it stays out of the
contents rail.

The rules come before the walkthrough deliberately: a reader who stops after two
sections still has the whole merge. Each step is then illustrated by whichever example
actually exercises it, and the prose says
so when it switches: Bear Lake is clean, so step 3 borrows a statewide search (its own
clustering is a no-op) and step 4 borrows a fragmented Adirondack trail. Steps 6 and the
naming section are the payoff, where the three causes of multi-part output are separated.

Clustering in the app is anchored by the map location of the clicked search result; the
page passes no anchor, so it falls back to "keep the longest cluster". The copy says so.

## 3. Data: frozen fixtures + live re-run

`merge/fixtures/<id>.json` holds a frozen Overpass response plus the exact query text,
bbox and fetch date. The page imports them statically, so it renders identically for
every reader and needs no network to make its argument. `RUN LIVE` re-issues the *same
query string* through `/api/overpass` and re-runs the identical pipeline, then reports
the delta in way count against the snapshot. This is the one deliberate departure from
PLAN.md §1's "live data only": a stakeholder-facing explainer must not depend on
Overpass being up, and the benchmark page already set the precedent of bundling derived
data.

Unlike `benchmark/raw/`, these fixtures **are** committed. They are OpenStreetMap data
under ODbL, attributed in the page footer, not restricted third-party content.

### Adding or refreshing an example

```bash
# 1. Reconnaissance — free, count-only, shows the distinct names in the response
node merge/fixture.mjs probe rmnp "Bear Lake" "Longs Peak"

# 2. Freeze it: <id> <bboxKey> <search term> <exact trail name to merge>
node merge/fixture.mjs freeze bear-lake rmnp "Bear Lake" "Bear Lake Trail"

# 3. Check what the pipeline does to it, and get the numbers for the copy
node merge/verify.mjs bear-lake
```

Then add the import + an `EXAMPLES` entry in `src/merge/model.ts`. Named bboxes live in
`BBOXES` in `merge/fixture.mjs`; `probe` first, because a regional term can return
hundreds of ways and a statewide one can time out.

## 4. The five examples and what each is for

Chosen by probing real data, not picked in advance. Each isolates one behaviour, and
the three multi-part results have three genuinely different causes — which is the point.

1. **Bear Lake** (RMNP) — the normal case. 17 ways / 5 names in, 6 kept, 1 chain,
   1.04 km LineString. Shows the name filter doing real work: a stock trail, a road and
   two junction-named routes all contain the search term.
2. **Rocky Top** (Ha Ha Tonka SP, MO) — 5 ways, one name, 2 parts. Verified cause: a
   **T-junction**. The two chains' nearest endpoints are 600 m apart, but one chain's
   endpoint sits 0.0 m from a vertex in the *middle* of the other. Chaining joins ends
   to ends only, never an end to a mid-line vertex.
3. **Van Hoevenberg** (Adirondacks) — 35 ways in, 30 kept, 7 parts. Verified cause: the
   **greedy junction rule**, not tolerance and not the data. Every orphan stub's
   endpoints are 0.0 m from a neighbour's endpoint; they are stranded because the walk
   consumed those neighbours first. 5 of the 7 parts are ~10 m stubs. This is the one
   place the merge is genuinely lossy, and it is a fixable defect (see §6).
4. **Nature Trail** (all of Colorado) — 19 ways, exactly one name, 6 clusters from
   Pueblo to Durango. Without clustering the merge would emit a single "trail" whose
   parts are 200 km apart.
5. **Longs Peak** (RMNP) — the limit. 21 ways under 7 names; the Keyhole route's summit
   sections are individually named (The Boulderfield, The Ledges, The Trough, The
   Narrows, The Homestretch). No name-based merge can assemble the route a hiker means.
   The largest group yields 2 parts ~2 km apart, and here the gap is real. This is the
   same naming/curation gap the AllTrails benchmark measures — see `BENCHMARK_PLAN.md`.

## 4a. The "Running this for real" section

Closing section on what changes between prototype and product. Its claims are sourced,
not assumed, and two of them are point measurements that will drift:

- ODbL permits commercial use, with attribution and share-alike on derived databases
  (openstreetmap.org/copyright).
- `overpass-api.de` is operated by FOSSGIS e.V., a donation-funded German non-profit.
  Stated fair use: 10,000 queries and 1 GB per day, no SLA (OSM wiki, Overpass API).
- **There is no US public instance with global data.** `overpass.maprva.org` holds a
  Virginia extract: measured 2026-07-29, it answered a Colorado bbox query in 0.98 s
  with zero ways, while `overpass-api.de` answered the same query in 0.87 s with 17.
  `overpass.osm.ch` likewise returned zero (Swiss extract). Latency is not the issue;
  shared load is, and the German instance also returned a 504 on an earlier probe.
- Geofabrik sells hosted Overpass at €40 to €550+ per month, no stated SLA, and gives
  away the daily OSM extracts that the recommended path (own ingest) is built from.

Re-measure before quoting the timings to a client.

## 5. Implementation notes

- `src/data/merge.ts` was extracted from `loader.ts` so the merge logic has no browser
  imports and can run under plain Node (`merge/verify.mjs` relies on this). `loader.ts`
  re-exports every symbol, so existing importers are untouched.
- `clusterSegmentsAll` and `chainSegmentsDetailed` are the instrumented variants added
  for this page: they return cluster membership and chain membership/flip flags.
  `clusterSegmentsDetailed` and `chainSegments` delegate to them, so there is exactly
  one implementation of each algorithm.
- One `MergeMap` per figure, each with one GeoJSON source. Per-feature `__color` /
  `__faded` / `__dashed` properties drive data-driven paint expressions, so a figure
  needs no layer-per-stage. `scrollZoom: false` is set at construction.
- `RUN LIVE` is per example: it replaces that example's input elements, invalidates its
  memoised pipeline result, and re-renders only the figures that use it.
- Legend rows are hover/focus targets. Every drawn feature carries a `__key` naming its
  group (name, cluster, chain) and each legend row carries the same key;
  `MergeMap.setHighlight(key)` emphasises that group and mutes the rest via
  `setPaintProperty`, so hovering costs no data re-upload.
- The page formats its own lengths (`fmtLen`): the shared `fmtDistance` renders a 10 m
  stub as "0.0 km", and sub-kilometre lengths are exactly what the fragmentation case
  is about.
- Buttons use `.doc-btn`, not `.btn`: `tokens.css` already owns a shared `.btn`
  (`flex: 1`) for the map app's inspector actions, which stretched these to full width.
- Stage 4 uses a line palette with no green or red, because that stage draws green
  start / red finish markers and a green line beside a green dot reads as one thing.
- Wide views (span > 0.6°) add locator dots per segment or cluster: a 1 km trail is
  sub-pixel on a statewide map, so the Colorado example would otherwise render empty.
- Orientation is shown with start/finish markers, not arrow glyphs: symbol layers need
  an external glyph host and the app is deliberately keyless.
- Steps 1–3 frame all features including the dropped/discarded ones (they are
  comparisons); steps 4–5 frame only what was kept (they are results).
- The contents rail is scroll-spied with an IntersectionObserver and hidden below
  1400 px, where there is no room for it beside a 1080 px document column.

## 6. Open item this page surfaced

The Van Hoevenberg case is a real defect, not just a teaching example: a topologically
continuous 11.3 km trail is emitted as 7 parts, 5 of them ~10 m stubs, purely because
of the order the greedy walk consumes segments at junctions. Geometry and total length
are correct, so nothing downstream is *wrong*, but `__parts` is not a trustworthy signal
of trail continuity, and per-part start/finish markers will draw spurious pairs.

A fix would make chaining junction-aware: build an endpoint graph first, then walk
longest-path-first from degree-1 nodes rather than consuming greedily in sort order.
Not done here — this page's job was to make the behaviour visible and measured first.
A second, smaller artifact: joining across the 35 m tolerance inserts up to 35 m of
synthetic geometry per join, which is why merged length can exceed the summed input
length slightly (11.35 km vs 11.29 km on Van Hoevenberg's 30 segments).
