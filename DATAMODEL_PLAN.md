# Data model page plan

`data-model.html` documents the trail data model for TWC product leadership: the entities behind
Trail Explorer and Weather-on-route, how they relate to regions, land, and named features, and the
provenance of every attribute (available today from open data vs a gap the product must fill
editorially). It is a conceptual model, not a database schema: readable by Stacy, Jess, and Liz
without a data background, with a CSV export of the attribute dictionary for anyone who wants it in
a spreadsheet.

Decisions (with Björn, 2026-08-31):

- Audience is product leadership; conceptual altitude, no field-type/nullability noise.
- Target product model with per-attribute provenance, not an as-is inventory. Gaps (photos,
  reviews, popularity, editorial route curation) are first-class rows marked as gaps.
- Summer trails only. Winter (resorts, snow state) noted as an extension point, not modeled,
  consistent with the science feasibility phasing.
- Lives in TrailScope as a nav page so it sits next to the benchmark evidence and shares the
  deployed URL. CSV export instead of a Google Sheet as the primary artifact.

## 1. Conceptual model

Six entities and one attach-point layer. The structural split (Segment / Trail / Route) is the
load-bearing part: it is the same distinction the benchmark measures from the data side, so the
model explains the AllTrails gap rather than papering over it.

### Segment

The unit the sources actually publish: an OSM way, a USGS/DEC feature. Has geometry and source
tags, no product meaning on its own. Van Hoevenberg's 30 connected ways are 30 segments and one
trail. Segments carry the provenance link (`osmWayIds` today).

### Trail

The named, merged unit the product ranks and displays: what `src/data/merge.ts` produces from
same-named segments (2,000 m cluster gap, 35 m endpoint join). Carries the full derived attribute
set: length, gain/descent, elevation profile, aspect/slope, canopy, route type, computed
difficulty, permitted activities, estimated duration. One trail may still be multi-part
(`__parts`), and the plan documents why that is not a reliable continuity signal (MERGE_PLAN §6).

### Route

A curated composite: an ordered sequence of trails/segments with a destination-shaped name
("Longs Peak via the Keyhole", "Great Range Traverse"). No open source publishes these; no
name-based merge can assemble them. This is precisely AllTrails' curation layer and the largest
provenance gap in the model. Modeled as an entity so the editorial work has a defined home, with
attributes inherited by concatenation from its legs plus editorial ones (description, why-go).

### Trailhead

Access point: location, name, which trails start there. Shared by many trails (benchmark uses
trailhead proximity for matching; network-presence numbers are trailhead-anchored). Parking,
facilities, seasonal access are editorial-gap attributes.

### Named feature (destination)

Summit, lake, waterfall, pass, glacier. Trails relate to features as destinations; category tags
("waterfall hike") are trail→feature relations, not strings. Source: OSM natural/peak features
plus GNIS; relation itself is partly derivable (endpoint proximity), partly editorial.

### Place (geographic containment)

Two distinct kinds, kept separate on purpose:

- **Land management unit**: national park, national forest, state land (Forest Preserve, state
  park), BLM. Hierarchical. Determines which source is authoritative, the rules layer (permits,
  dogs, seasonal closures), and explains benchmark coverage behavior.
- **Product region**: the app-defined browsing/serving unit (rmnp, adk, ozarks today). Also the
  Super Res serving boundary in a real build (HRRR domain → CONUS). A region contains trails; a
  trail belongs to exactly one region today, which is a prototype simplification worth stating.

### Conditions attach points (not stored attributes)

Weather is never a column on Trail. It attaches per waypoint, per hour, through the
`WeatherProvider` interface, inside the +36 h horizon, and joins the trail's terrain (elevation,
aspect, canopy) at grade time. The page shows this as its own diagram section because the
geometry granularity (profile sampling) is exactly what Super Res needs to be route-specific.

## 1b. Revisions (2026-08-31, with Björn)

- **The model lives in `data-model.jsonc`** (repo root), a commented JSON file with real example
  values and a provenance tag per field. The page renders that file; they cannot drift because the
  page parses the file at build time rather than keeping its own registry.
- **Place replaces NamedFeature and LandUnit**: one entity, five kinds (state, park, town, lake,
  peak), each carrying a bbox (boundary envelope for area kinds, padded radius for point kinds).
  Search covers trail names and place names in one box; selecting a place sets the active bbox and
  all subsequent search and browse filters to trails intersecting it. Region is reframed as the
  data snapshot unit, not a browsing concept.
- **Weather and conditions removed from the model doc for now**, to be added back later. The
  provider seam still exists in code (`src/scope/weather/provider.ts`); it is just not part of
  this deliverable's scope yet, so the provenance legend is source / computed / gap.
- **The page is now an intro plus a hierarchy visualization of the jsonc**, not a prose document.
  The first prose version (eight sections, attribute tables, entity SVG, CSV export) was cut on
  feedback: too long to glance over. The download is the `.jsonc` itself.

## 2. Page structure

Follows the merge.html pattern: long vertical document, prose sections with figures, sticky
contents rail. Sections (dry descriptive titles per repo convention):

1. Purpose and reading guide
2. Entity overview (diagram: the six entities and their relations)
3. Segment, Trail, Route (the structural argument, with the Van Hoevenberg / Longs Peak examples)
4. Trail attributes (the dictionary: grouped tables, one live example column from a real RMNP
   trail, provenance column with a four-value legend: source / computed / simulated / gap)
5. Geographic context (trailheads, features, land units, regions)
6. Conditions attach points (WeatherProvider shape, horizon, why per-waypoint)
7. Known gaps and extension points (photos, reviews, popularity, routes/curation; winter)
8. CSV export of the attribute dictionary

Live example values are interpolated from `scope/derived/rmnp.json` at render time, matching how
the other prose pages compute their numbers instead of hard-coding them.

## 3. Implementation

- One PAGES entry in `src/ui/nav.ts`, one vite input, `data-model.html`, `src/datamodel/` module.
- Diagram: hand-built SVG consistent with the rest of the app (no diagram library).
- CSV export: client-side Blob download of the same attribute records that render the tables, so
  the page and the export cannot drift.
