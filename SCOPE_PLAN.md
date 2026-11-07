# TrailScope — Trail Scope (product prototype)

`scope.html` — an interactive product prototype embedded in an explainer document.
Audience: TWC product leadership (Stacy, Brian, Jess, Liz) plus Brennan and Megan.
This document is the source of truth for the page, as `BENCHMARK_PLAN.md` is for the
benchmark and `MERGE_PLAN.md` for the segment merge.

**This is an internal UX prototype, not production design.** It exists to get a handle
on the discovery flow and hand a working reference to a designer. Visual polish beyond
the existing TrailScope token set is out of scope.

## 1. What the page argues

The other four pages ask whether open trail data is good enough to build on. This one
asks what the product feels like and where it beats AllTrails. One sentence:

> Trail discovery where conditions are a first-class ranking and filter dimension,
> not a detail-page afterthought.

The two reference products bracket the gap. AllTrails discovery answers *which trail
should I do*, ranked by popularity, weather-blind. SnowCast answers *what are the
conditions at this mountain*, condition-first but resort-only, point-based, winter-only.
Neither ranks discovery by conditions.

Everything on the page serves that sentence. Screens that do not are AllTrails cosplay
and get cut.

### The card problem, and why it is the opening

The benchmark established what open data does and does not carry. Against the AllTrails
card:

| AllTrails card element | Open data |
|---|---|
| Hero photo | no |
| Star rating, review count | no |
| Curated difficulty | no, but derivable |
| Length | yes |
| Estimated time | derivable |
| Elevation gain | yes |
| Route type | partially derivable |
| Curated route name | partially; this is the 65 to 84 percent gap the benchmark measured |

Two of AllTrails' trust signals are missing: the photo and the stars. The prototype
replaces them with two things AllTrails structurally cannot put on a card.

1. **The terrain itself.** The elevation profile is the card's hero, not a detail-page
   chart. A profile sparkline reads at a glance and is honest about what the trail is.
2. **The conditions grade.** Where AllTrails prints a permanent 4.6 stars, we print
   "Good until 13:00", a fact about today. Static social proof versus live
   route-specific truth, visible in one card.

## 2. Scope

**Phase 1, this build: discovery only.** Five states. Since feedback round 1 (§10) the
app boots on the results list and the page narrative opens there too; search is a later
chapter, not the front door.

1. Results list: search field, filter chips, day bar, count, sort, condition-carrying
   cards. The default state.
2. Results map: same result set, trails tinted by condition, bottom sheet.
3. Trail peek: verdict-first. Name and measures, then the conditions verdict in plain
   language (the grade word never appears without its explanation beside it), then the
   best-window timeline, elevation profile, driving factors, and a Details affordance
   that is a deliberate stub.
4. Search entry (empty): assumed location, recent searches, place shortcuts.
5. Search results: Places and Trails, two sections, typed icons, results filtering live
   while typing.

**Phase 2, later: the trail journey.** Full detail page, on-route weather timeline
(distance on x, time on y), saved trails, navigation, winter mode. The page reserves a
closing section for it and builds none of it.

### Cut, with reasons

- **Land manager as a filter.** With three seeded regions it carries no signal (RMNP is
  all NPS, the other two all state), and the place shortcuts already do that job.
- **Out-and-back as a route type.** Not derivable from a single OSM geometry; AllTrails
  knows it because users record it. We detect loop versus point-to-point only, and the
  prose says why. This is a finding, not an omission.
- **Popularity sort.** No crowd signal exists in open data. See §6.
- **Winter activities.** Snowboarding and downhill skiing are two of the five priority
  activities, but the science response defers winter snow state as an open research
  problem. Discovery covers the three summer ones and shows the winter pair as
  explicitly out of scope rather than pretending.

## 3. Page format

**Sticky phone left, prose right.** The phone is a single continuous interactive app in
an iPhone-proportioned frame (390 × 844 logical, matching the 19.5:9 reference
screenshots). It pins on wide viewports while the prose column scrolls.

Scroll-linked but non-destructive: each prose section declares the app state it
illustrates, and scrolling into that section drives the phone there **only if the reader
has not taken control**. Once anyone taps inside the phone, auto-advance stops and each
section shows an explicit "Show me" chip instead. A reader can always leave the script.

Below 1000 px the phone drops inline above the prose and scroll-linking is off.

**Doc chrome controls**, outside the phone, in a sticky rail under it:

- **Scenario switcher**: bluebird / afternoon storms / post-rain / heat. Swaps the
  meteorology only; the terrain math is unchanged. This is the most persuasive control
  on the page, because it makes the list visibly rerank.
- **Units**: metric / imperial, reusing the app-wide `trailscope-units` localStorage key
  so the setting follows the reader across all five pages. Default stays metric, as the
  rest of TrailScope already is.
- **Region**: Rocky Mountain NP / Adirondack High Peaks / Lake of the Ozarks.

**Fidelity marker**: removed 2026-08-05 (§12). It was a persistent "prototype ·
simulated conditions" chip in the rail, and this section called it non-negotiable because
the page will be screenshotted into a deck. The chip is gone at Björn's call; the claim it
carried now lives only in the prose column's In-short box and in the scrubber's
HOURLY/OUTLOOK labels. The residual risk is unchanged and worth restating rather than
quietly dropping: a reader who crops the phone out of context has no disclaimer attached
to the screenshot.

## 4. Data

### Trails: frozen, three regions

The benchmark three, so the whole app stays coherent: `rmnp` (federal, best case),
`adk` (state land, stress case), `ozarks` (non-destination, control). RMNP is the hero:
above treeline, afternoon convection, the strongest weather story, and already the map
app's default center at `[-105.646, 40.313]`.

`scope/derive.mjs` (standalone Node, no deps, mirroring `benchmark/derive.mjs` and
`merge/fixture.mjs`) does the whole pipeline once and commits the result:

1. Overpass: every **named** `highway ~ path|footway|track` way in the region bbox.
2. Group by `normalizeTrailName`, cluster, chain, merge — the shipped `src/data/merge.ts`
   functions, the same ones the map app's search uses. One trail per name-cluster.
3. Sample elevation from terrarium z13 tiles, decoded in Node with `node:zlib` (no deps).
   Must reproduce `src/data/elevation.ts` numerically so the prototype and the map app
   never disagree about the same trail. Verification anchor: Longs Peak summit
   (−105.6151, 40.2549) decodes to 4346 m.
4. Derive route type, difficulty, estimated time, grade, surface, activities.
5. Write `scope/derived/<region>.json`, which the page imports statically.

Deterministic, instant, offline-safe, and it cannot flake in front of an exec. Cost,
stated plainly on the page: search and shortcuts only cover these three areas.

`scope/derived/` **is committed** (OSM/ODbL, attributed), unlike the gitignored
`benchmark/raw/`.

### Weather: simulated now, Super Resolution later

The prototype fakes meteorology and **computes everything else for real**. That split is
deliberate: it is exactly the seam the Super Resolution API will later replace.

```
WeatherProvider  (interface)
  ├── SimulatedProvider   ← this build: scenarios × elevation × terrain
  └── SuperResProvider    ← later: TWC Super Resolution, same interface
```

The grader never talks to a scenario. It asks the provider for hourly samples at
specific points on the route at their real elevations, then combines them with terrain
facts from our own derived data. Swapping the provider changes the weather and nothing
else. `src/scope/weather/provider.ts` holds the interface and a `TODO(superres)` block
naming exactly what a real implementation must supply.

A scenario defines regional weather over 72 hours at a reference elevation, plus lapse
rate and a diurnal convection profile. Per-point sampling then applies real elevation,
so a ridge point genuinely runs colder, windier and stormier than a valley point in the
same scenario. Within-region variation is driven by terrain, not by hand-authoring per
trail.

### Horizon: the +36 hour constraint is a designed state

Super Resolution is +36 hours, hourly, four runs a day, HRRR domain, CONUS-only. The day
scrubber is built around that:

- **Inside +36 h**: route-specific hourly grade, with an hour in the headline.
- **Past +36 h**: drops to a coarse "Outlook", no terrain grade, no hourly claim, and the
  card visibly says so.

The provider declares `horizonHours`, and the UI reads it rather than hard-coding 36. A
real provider with a longer horizon changes the UI for free.

**Degrading means less certainty, not less content.** The first cut of the outlook state
returned `mixed` with no best window for everything past the horizon, which no condition
filter could satisfy, so scrubbing to Monday with a chip active emptied the list. That
reads as a broken app, not as an honest limit, and it hides the finding rather than
carrying it. Past the horizon the grade is therefore still a real `prime` / `mixed` / `poor`
level, computed from four wide regional terms (convection, rain, temperature, gusts)
averaged across the route's sample points, with no terrain term, no hour, no window, and a
score quantised per level so it cannot pretend to rank. The two sentences the copy has to
carry:

> Inside the horizon I can tell you about **this route at this hour**.
> Past it I can only tell you about **this area on this day**.

Both are useful. Only the first is route-specific. The condition filters follow the same
rule: each one degrades to the coarsest honest form of its own question rather than failing
shut, and `conditionFilterDegraded()` tells the UI which chips are answering a coarser
question than their label promises. `below-treeline` and `shaded` are terrain facts and are
never degraded, which is worth showing: on an outlook day they are the only two chips still
answering exactly what they say.

This is the most useful thing on the page for TWC: the weekend-planning use case is not
served by terrain-aware forecast at MVP, and the UI has to be built to say so.

## 5. The conditions grade

No 0-to-100 score. False precision, and it violates the house convention. Three levels
plus a reason, always. The top level is labelled **Good** since feedback round 2 ("Prime"
kept drawing "what does that mean?"); the internal `GradeLevel` id stays `prime`:

```
Good    dry, clear until 15:00
Mixed   wet underfoot from Tuesday rain
Poor    above treeline after 12:00, 70% storms
```

**Inputs, weather side** (from the provider): precip in the window, antecedent precip
over the prior 72 h, hourly thunderstorm probability, temperature and wind at route
elevation, daylight remaining.

**Inputs, terrain side** (from our derived data, real): max elevation versus regional
treeline for exposure weighting, steepness and profile shape, OSM surface tag as a
drainage proxy, and route length as how much of the storm window the route occupies.

Sampling is at five points spaced along the route at their actual elevations. One point
at the trailhead would be the SnowCast model and would miss the entire argument.

**Colour collision, resolved.** AllTrails uses a green/amber/red dot for *difficulty*,
and that metaphor is learned. Using the same traffic light for *conditions* would put two
different meanings on one card. Difficulty keeps the learned dot; conditions gets a
distinct form — a tinted pill with a weather glyph and a time, in a different position.
Different shape, different place, no ambiguity.

**On the map** this is the strongest single image on the page: the map app colours trails
by *source*, this one colours them by *condition*. Same geometry, different question. A
ridge route going amber past noon while the valley loop stays green is route-specific
weather in one frame.

## 6. Search, filters, sort

### Search

One free-form field resolving to two kinds of thing, as AllTrails does:

- **Places**: national park, national forest, state, town, peak. Backed by
  `src/data/places.ts`, which already carries the 50 state bboxes, 329 NPS unit names and
  112 USFS forest names. Selecting a place jumps there and shows its trails.
- **Trails**: name match within the loaded region.

Place is the search, not a filter. Making park and forest into chips forces a nonsense
interaction (pick state, then park inside it, then forest which is not inside the park).
Shortcuts on the empty state do the same job in one tap.

### Filters

Three groups, in this chip order.

**Conditions** — leads the row, deliberately. It is the clearest signal that this is not
AllTrails, and it is cheap to reverse if it tests badly.
Good conditions · Dry underfoot · Storm-free window · Below treeline · Shaded

No chip names a day. Every one of them is evaluated against the day selected in the day
bar directly below the row, which is where the date dimension lives. The labels used to
say "Good today" and "Good tomorrow" while the bar said something else, which is two
answers to one question; the mechanics were always day-relative, only the copy was not.
The "Good tomorrow" chip (the day after the selected one) is gone with them.

**Effort**
Difficulty (computed) · Length · Elevation gain · Max elevation · Estimated time

**Character**
Activity (hike / trail run / MTB) · Route type · Surface

Standard discovery behaviour throughout: chips show active state and value, a count of
active filters, per-group clear, global clear, and the result count updates live.

Difficulty is the NPS/Shenandoah numeric rating, `sqrt(gain_ft × 2 × length_mi)`, binned
easy (<50) / moderate (50–150) / hard (>150). Transparent, reproducible from open data,
defensible in front of the science team, and labelled **computed** on the page so nobody
mistakes it for a crowd rating.

### Sort, and the popularity gap

Default is **Best conditions**: conditions grade first, then a prominence proxy, then
distance from the assumed location. It reorders, but it never reorders *silently* — the
list header names the ordering and every card carries the pill that explains its position.

Neither conditions sort names a day, for the same reason no chip does. The day is the day
bar's answer, and the list header restates it: **87 trails · Best for Tomorrow**, or
**Conditions only, for Tomorrow** for the grade-only variant. Non-conditions sorts keep
the plain "sorted by Closest" form. Past the horizon the conditions sorts fall back to
Closest and the header says why, as before.

Alternatives offered: Conditions only · Closest · Shortest · Longest · Least gain ·
Most gain · Easiest · Hardest.

There is no honest popularity sort, and that is worth saying out loud rather than
papering over. AllTrails defaults to relevance and offers Most popular; both are crowd
signals open data does not have. The prominence proxy (named, has a trailhead node
nearby, part of a route relation, length) is a weak substitute and the prose says so.

**The finding**: the open-data stack can rank by conditions from day one and cannot rank
by popularity at all. That has real product consequence.

## 7. Repo layout

```
scope.html                    ← page shell
SCOPE_PLAN.md                 ← this file
scope/
  derive.mjs                  ← standalone Node: fetch → merge → elevation → derive
  terrarium.mjs               ← zero-dep PNG decode + terrarium tile sampling (Node)
  routetype.mjs               ← topological loop detection + offline repair (no network)
  grade-check.mjs             ← headless scenario/grade check
  derived/<region>.json       ← committed output, imported statically by the page
src/scope/
  types.ts                    ← frozen contracts (this file's authority in code)
  model.ts                    ← region registry, derived-data loading, unit formatting
  doc.ts                      ← page entry: prose sections, sticky phone, chrome controls
  scope.css                   ← document layout
  weather/
    provider.ts               ← WeatherProvider interface + the Super Resolution seam
    simulated.ts              ← scenario-driven implementation
    scenarios.ts              ← the four scenarios
    grade.ts                  ← conditions grading (weather × terrain)
  phone/
    phone.css                 ← device frame + app styles
    app.ts                    ← mountPhone(): state machine, screen routing
    search.ts                 ← entry + results
    list.ts                   ← cards, sort, count
    filters.ts                ← chip row + sheets
    pmap.ts                   ← in-phone MapLibre + condition tinting
    peek.ts                   ← trail peek sheet
```

Adding the page: one `PAGES` entry in `src/ui/nav.ts`, one vite input, one html file.

## 8. What building it turned up

Four things that were not visible before the pipeline ran, all of them now stated on the
page rather than patched over.

- **OSM way direction is arbitrary, and it mis-measures flagship trails.** Walking a
  trail as stored and summing the climb gave North Inlet 3 m of gain over 18 km, binning
  it easy. 42 percent of RMNP, 42 percent of ADK and 55 percent of Ozarks trails were
  stored against the hiking direction. Trails are now oriented low-end-first before
  measuring, which also makes `start` the real trailhead. The assumption fails for canyon
  descents and the page says so.
- **The highway filter does not identify trails.** 49 percent of Ozarks named
  path/footway/track features are subdivision streets, against 1 percent in ADK and 0 in
  RMNP. Flagged, not dropped. A national build needs a classifier.
- **The loop share is small, and the earlier number was noise.** A first/last coordinate
  test cannot survive the greedy chaining walk emitting parts out of order. `routetype.mjs`
  replaces it with an order-independent topological test: count endpoints with no
  neighbour within 100 m, zero open ends means closed. That plus the 200 m display floor
  drops the measured share from 15 to 18 percent to 3 to 8 percent. The removed entries
  were sub-200 m closed spurs (privy paths, campsite access, bridges), never loop hikes.
  These regions really are overwhelmingly out-and-back to lakes and summits.
- **The differentiation is terrain-dependent.** In the Ozarks the storm scenario grades
  almost everything prime. Where there is no terrain, terrain-aware weather has little to
  say. Expected, but worth seeing in the product.

## 9. Verification

- `node scope/derive.mjs verify` re-runs elevation decode against the Longs Peak anchor
  and prints per-region counts, so a change to the pipeline shows up as a number.
- Every count quoted in the prose is interpolated from the derived data at render time,
  as the merge page does. No hand-typed totals.
- House conventions apply to all copy: no decimal places on percentages, first person
  singular, no em dashes, findings separated from hypotheses.

## 10. Feedback round 1 (2026-08-04)

Stakeholder feedback on the first review, and what it changed.

- **The frame rule.** Everything inside the phone frame reads as a real product;
  commentary about data provenance, the benchmark, or the prototype's own construction
  lives in the prose column or dies. This swept the search empty state, the place index
  note, the sort sheet descriptions, the disconnected-parts note on the profile, and the
  filter sheet asides. It also supersedes the earlier rule that seeded card ratings carry
  a per-item `sample` tag: the card rating is now untagged and the prose column's Sample
  data caveat carries the claim instead. The per-item `sample` and `yours` tags on seeded
  photos and comments in the peek are kept, since an empty photo tile with no tag would
  claim content that does not exist.
- **List first.** The narrative opened on search; the thesis lives on the list. Section
  order rebuilt around the results list as both the opening argument and the app's boot
  state. Search moved late. Prose cut roughly 40 percent per surviving section, and the
  "Drive the phone" tagline is gone.
- **Search accepts typing now.** The persistent input node lost focus on every re-render
  because the refocus was gated on a flag only the fake-field tap set. Focus and caret
  are now captured before render and restored after, and the flag is set on any focus.
- **Day bar titled and dated.** "Today / Tomorrow / Mon" with hourly/outlook sub-labels
  read as cryptic. The row now carries a "Conditions for" overline and a real calendar
  date per day, anchored to the reader's actual today (weekday labels re-anchored in the
  provider so names and dates cannot disagree). The +36 h wall stays.
- **Verdict-first peek.** "Prime" appeared with no definition, and storm probability led
  the timeline. The peek now leads with the grade plus a generated plain-language
  sentence (level meaning plus the grade's own headline, one judgement at two lengths),
  the timeline is titled by the best window, and storms are one driving factor among
  several.
- **Drag-to-scroll** on the chip row, shortcuts, and day bar. One trap worth keeping:
  `setPointerCapture` on pointerdown retargets compatibility mouse events and kills
  every plain click in the row, so capture only starts once the pointer passes the 5 px
  slop threshold.

## 11. Feedback round 2 (2026-08-04, same day)

Live review against the running prototype, item by item.

- **One date dimension.** The day bar could say Tomorrow while a chip said "Good today"
  and the sort said "Best today". The mechanics were already day-relative; only the
  labels hard-coded the day. Labels are now day-free ("Good conditions", sorts "Best
  conditions" and "Conditions only", each defined as "on the day you picked") and the
  results header restates the binding: "87 trails · Best for Tomorrow". The
  "good-tomorrow" chip (good on the day after the selected one) is removed entirely; the
  day bar owns the date.
- **The map was blank.** MapLibre stamps `maplibregl-map` (position: relative) onto its
  container, and whichever stylesheet loads last wins, so sizing `.map-canvas` by
  `inset` alone collapsed it to 0 height and the canvas sat at the 300 px HTML default.
  Explicit 100 percent dimensions hold under either position value. Load-order
  dependent, so it could come and go between builds.
- **Verdict de-duped, accent dropped.** The pill says PRIME; the sentence no longer
  repeats the level word, it starts at the meaning clause. The colored left edge on the
  verdict card is gone; the pill carries the level alone.
- **Seven-day per-trail outlook, synced.** A week row in the peek shows this trail's
  grade dot per day; tapping a day selects it app-wide (verdict, strip, and the list
  behind all follow). SCRUB_DAYS is 7, the day bar widened with it, days past +36 h stay
  visibly outlook-coarse. The simulated series was extended by appending days, never
  reshuffling, so days 0 to 4 grade exactly as before.
- **Hour cells explain themselves.** Native title attrs replaced with a real tooltip:
  hour, storm percent, temperature, and the reason for the cell's colour, derived from
  the same thresholds the shading uses so the sentence cannot drift from the tint.
- **Search field reads as empty when empty.** The idle field printed the region name,
  which read as entered text and as a scope that could not be cleared. It now shows a
  placeholder ("Search trails and places"); an explicitly chosen place still shows by
  name, because that is user input, not a default.

## 12. Feedback round 3 (2026-08-05)

Two changes from a live review, plus one consequence.

- **More air around the phone.** The frame sat 24 px from the controls rail and 34 px from
  the prose, which read as three columns jammed together rather than one instrument beside
  a document. Now 46 px and 58 px, stepping down at the 1439 px and 1279 px breakpoints so
  the phone does not get squeezed before the layout stacks. The ≤1099 px stacked layout is
  unchanged.
- **Fidelity chip removed.** See §3. The element, its CSS, and the two comments that
  referenced it are gone.
- **Consequence, recorded not resolved.** The chip was the only marker of simulated
  weather attached to the phone itself. Everything that explains the simulation now sits in
  the prose column, which does not travel with a cropped screenshot. If this matters when
  the deck is built, the cheapest replacement is a line of mono text under the controls
  rather than a pill on the frame, since the objection to the pill was visual weight.

## 13. Trail mode (2026-08-06)

Phase 2 started as a concept jam rather than as a build. See `TRAIL_PLAN.md`; the page is
`concepts.html`, deliberately not in `PAGES`. The two findings from it that bear on this
page rather than on that one:

- **The horizon constrains trail mode far more tightly than it constrains discovery.** A
  journey occupies hours and has to fit inside +36 h in full, so trail mode is a
  today-and-tomorrow screen where the day bar here offers seven. Any link from a peek into
  trail mode has to survive the reader arriving on an outlook day.
- **The condition thresholds and the four band colours are now duplicated.** `peek.ts`'s
  `stripCellClass` and `phone.css` `.st-cell.lv-*` are the originals; `src/trail/` carries
  a copy because both originals are private to this app. Unify when trail mode graduates,
  before the tint starts disagreeing with the tooltip that explains it.

## 14. Route type on the card, and traversal in the peek (2026-08-10)

Three changes and three things deliberately parked.

### Shipped

- **A loop glyph on the card, loops only.** A reload-style circular arrow, which is the
  form that reads at 13 px. Not rendered for point-to-point: 4 of 87 RMNP display-set
  trails are loops, so a second glyph would sit on 95 percent of cards for a fact the whole
  build already treats as the default. The peek names the type in words, so absence cannot
  be misread as "unknown". The same glyph appears in the peek subhead, but there it sits
  *beside* the word rather than replacing it, because the row has room and the word is
  already doing the work. The two call sites differ on purpose.
- **The card's duration is labelled.** `estMinutes` is Naismith on one-way length and gain,
  and on the 83 of 87 point-to-point trails it silently read as the whole outing. Now
  qualified. Loops keep no qualifier, because a circuit is the whole walk.
- **A traversal control in the peek**, conditional on route type: One way / Incl. return
  (default) for a line, Clockwise / Counterclockwise for a loop. The peek is the only place
  that can ask, since a scrolling list cannot, and open data cannot derive it
  (§2). State is per-trail; the card list keeps showing the default basis. The displayed
  duration follows the selection, computed with the per-segment pace model rather than by
  doubling, because Naismith charges for ascent that a return leg does not have.

### Parked, with reasons

- ~~The best window is still sized to a one-way figure.~~ **Decided 2026-08-10: everything
  follows the selection.** See below.
- **Trails named "…Loop" whose geometry does not close.** 6 of 10 in the Adirondacks and 4
  of 5 in the Ozarks, mostly single-part, so not a fragmentation artefact: those geometries
  genuinely do not close. `scope/derive.mjs` already says the loop share is a floor, and the
  consequence is that a card can print a one-way qualifier on a trail whose name says Loop.
  The likely cause is the composite-route gap the benchmark measures from the other side: a
  loop is usually completed by several named ways, so any one named way is only an arc of
  it. Parked at Björn's call 2026-08-10. Options when it comes back: stop asserting where
  name and geometry disagree, or use the name as a corroborating signal and cost that
  honestly.
- **Two pieces of debt from the peek control.** It imports `src/trail/pace.ts`, so the
  discovery app now depends on the concepts page's module, which is the wrong direction:
  the pace model should move to a shared home when trail mode graduates. And the two
  surfaces disagree on wording, since `src/trail/journey.ts` says "Out and back" and
  "Anticlockwise" where the peek says "Incl. return" and "Counterclockwise". The peek's
  US spelling is correct for a CONUS-only product; trail mode should follow it, not the
  reverse.

### Everything follows the traversal selection (decided 2026-08-10)

Björn's call, and it is the correct one: the labelling fix above was papering over a real
defect rather than fixing it. Four things now recompute when the reader changes traversal in
the peek.

1. **The conditions grade and its verdict sentence.** `terrainFacts.durationH` stops being
   `estMinutes / 60` and becomes the real modelled duration for the chosen traversal.
2. **The best window**, which is the time-slot recommendation. Its search is
   `needed = min(durationH, availableH)`, so once the duration is right the window is sized
   to the actual outing. **This is the defect the whole thread was circling**: a window could
   be offered that closed before the walker was back.
3. **The driving factors**, since `durationH` also feeds the heat factor's long-climb wording
   and the daylight shortfall term.
4. **The peek's elevation profile**, which now runs out and back for a return trip and
   mirrors for a counterclockwise loop. The card sparkline deliberately does not follow: it
   is a fingerprint of the trail in a scrolling list, not a picture of an outing, and the
   list has no selection to reflect.

**The basis rule**, because it decides whether the list moves: the results list grades every
trail at its **default** traversal, never at whatever a reader last picked in some peek. A
per-trail choice must not re-rank the list behind it. The peek grades at its own selection.

**The list does move, though, and that is accepted rather than incidental.** With
`Incl. return` as the default, `durationH` rises for the 83 of 87 point-to-point trails, so
grades shift and the default sort shifts with them. The mechanism is worth stating because it
is the product point: a longer outing occupies more of the day, so more of the day's hazard
counts against it and fewer trails can dodge the afternoon. That is a *truer* list than the
one this page showed before, but it is a different list, and anyone who has seen an earlier
screenshot should be told why the ordering changed.

**The regression to watch** is `scope/grade-check.mjs` claim (c): no day of the scrubber may
come back empty, with every condition filter passing something somewhere. The original bug
there (past the horizon everything graded mixed with no best window, so one condition chip
silently emptied the list) is exactly the class of failure a `durationH` change can
reintroduce, so that check gates this work.

## 15. The verdict's third mixed case, and the map moved to lead the sheet (2026-08-11)

Two changes, the first a correctness fix, the second a placement override.

- **`mixedMeaning` had two shapes and needed three.** §14's `durationH` change made "no
  window long enough for the route" common rather than rare, and that clause could co-occur
  with the "worth doing if you time it right" gloss, which promises the reader a fix that
  the very next clause says does not exist (Fern Lake Trail, afternoon storms: "worth doing
  if you time it right... no window long enough for the route"). The gloss now checks
  `grade.bestWindow` as well as time-boundedness: time-bound with a window still fixes the
  contradiction, else the honest third gloss is "not enough day to fit this route". Verified
  by enumerating every trail in all three regions across the storms scenario (2,989
  trail/day sentences): 22 trails hit the new third case, and no sentence anywhere pairs a
  timing promise ("time it right" or "go before") with a no-window clause. `prime` and
  `poor` were checked the same way and cannot pick up either clause, by construction (the
  clause list that can add them only runs when `grade.level !== 'prime'`, and neither
  `ROUTE_MEANING.poor` nor the outlook glosses promise timing). This is copy logic only:
  grade levels, scores, thresholds and the sort are unchanged.
- **The map now leads the sheet.** Björn's call: "the title, then the map, then the stats
  for it." `peekMapBlock` moves from between the profile and the driving factors to directly
  after the header, before the measures row. This overrides the placement argued for in §11
  and in the long comment the map's old call site carried (a map above the verdict would
  "undo the verdict-first order this sheet is built around") — that reasoning was sound and
  Björn overruled it anyway, wanting a visual anchor as the first thing the reader sees. The
  verdict-first order is otherwise unchanged: it now governs everything from the measures
  row down, with the map as a stated exception at the very top rather than an abandonment of
  the rule. One side effect: the profile and the map, previously back to back as two views of
  one geometry, are no longer adjacent. Both stay (neither substitutes for the other), and
  the profile's own comment now says so. The map's lifecycle (`teardownPeekMap`, the
  region-bbox-first construction, `fitBBoxWhenSettled`'s idle gate) is unchanged and was
  re-verified after the move: six peeks opened and closed in a row with no leaked MapLibre
  instance and no console error, and the map still frames the trail correctly constructing
  higher in a scrolling sheet than before.
