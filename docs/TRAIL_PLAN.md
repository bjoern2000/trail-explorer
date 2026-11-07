# TrailScope — Weather-on-route

`weather-on-route.html` — the on-route conditions screen. Promoted into the
main nav 2026-08-10 and restructured to lead with the map view; the other two concepts are
kept as alternatives considered. Audience: TWC product leadership, same
as Trail Scope, but this is a working document for one decision rather than a section of
the deck. `SCOPE_PLAN.md` is the source of truth for the discovery prototype;
this file is the source of truth for trail mode.

**Status: map-led page in the main nav, with one live control.** The concepts are static renderings; the
traversal control (§10) is wired for real, because a toggle that did not move the numbers
would not demonstrate the answer it exists to give. Everything else is inert. When a concept
wins, this file becomes its implementation plan and the concepts page either goes away or
shrinks to the rejected alternative.

## 1. What trail mode is, and why it is not a section of the discovery page

Trail Scope answers *which trail should I do*. Trail mode answers *how does the day play
out on the one I picked*. `SCOPE_PLAN.md` §2 already reserved it as Phase 2, "the trail
journey", and named the axis: distance on x, time on y.

The one-sentence version:

> The discovery peek already has a time axis and the card already has a distance axis.
> On a walk those are the same axis, and the only thing that can join them is pace.

That is the whole content of the page. Everything else follows from it.

### Decisions taken 2026-08-06, with Björn

Four forks, resolved before anything was drawn.

- **One screen, two anchors.** Not a planning screen and a separate live screen. The
  chart is the same artifact both ways: unstarted it is anchored to a chosen departure
  time, started it is anchored to now, the walked portion hatches, and what is left
  re-reads against the clock. Cheapest thing that still demos the on-trail moment.
- ~~Concepts page now, home decided later.~~ **Resolved 2026-08-10: it is its own section.**
  The page is now a sixth `PAGES` entry labelled **Weather-on-route**, and the
  discovery page's tab was renamed from **Trail Scope** to **Trail Explorer** at the same
  time, which removes the collision between the page name and the app's own wordmark. The
  files were renamed to match: `weather-on-route.html`, `src/trail/route.ts`,
  `src/trail/route.css`.
- **Terrain-aware pace.** Tobler's hiking function per profile segment, scaled by one
  pace factor, rather than a flat km/h. Reasoning in §3.
- **Pure mapping, no risk language.** The screen states conditions at each point at the
  hour you arrive and marks factual events. It does **not** recommend a departure time,
  a turnaround time, or name a hazard. This was the most consequential of the four and it
  is a hard constraint in the code, not a copy preference.

Added 2026-08-06, after the first two statics:

- **Ground and air are separate lines on every label** (Concept C). Not one blended
  "conditions" verdict. Two reasons: they answer different questions a walker actually asks
  ("what will it be doing" versus "what will I be walking on"), and they come from two
  different TWC science deliverables at two different levels of readiness, so blending them
  would hide which half is real today.

The last one deserves its cost stated plainly, because it is a real trade. The sharpest
possible version of this screen computes the intercept of your pace curve with the
convection window and says "leave by 06:00". That is the single thing no competitor can
compute and it would be the strongest argument the prototype could make. It is also
advice about personal safety generated from simulated weather by a prototype, in a
programme where verification ownership sits with the science team rather than with
Product. Declining to give it is defensible; the page loses some punch and keeps its
footing. Revisit only with the science team in the room.

## 2. Format

A long vertical document, in the shape of `merge.html` rather than `scope.html`: prose
top to bottom with phone frames inline and an annotation list beside each. Nothing is
sticky, because the point is to compare the frames against each other rather than be
driven through one.

Sections, after the map-led restructure: header · the map (primary) · limits ·
the two alternatives · footer. The standalone pace, dock and started-state sections were
cut; their reasoning survives in §3, §6 and §1 respectively, which is now the only place it
lives. The started state was cut as code too, so reinstating it means rewriting it.

Frames are 366 × 792, the same 390 × 844 proportion as the discovery prototype at a size
that lets a frame and its annotations sit side by side. The device frame CSS is a smaller
**copy** of `src/scope/scope.css`, not an import, because that file also carries the
discovery page's sticky grid. On graduation the copy dies.

Annotations are numbered circles rendered inside the relevant block, keyed to an ordered
list beside the frame. Positioned in the flow rather than by coordinate, so they cannot
drift out of register when content reflows.

**The vertical budget is 732 px** and it is worth writing down, because both concepts were
built to it and both were wrong about it on the first pass. 792 frame, less 8 px padding
each side, less a 26 px status strip and an 18 px home strip. Concept A's first cut filled
487 of it and read half empty; the chart, which is the entire concept, had been sized like
a sparkline. Concept B's rows have to fit 732 less 188 px of chrome, and the row count is
derived from that budget and the number of marker bands rather than tuned by hand, because
a count tuned to one journey clips silently the moment the trail or the marker set changes.

## 3. Pace, the load-bearing model

Distance and time are only commensurable through pace, so this is the model that has to
be right. Four candidates, one chosen:

| model | why not / why |
|---|---|
| Flat km/h | Wrong by enough to change the answer. See the measurement below. |
| Naismith (1892) | A whole-route rule, so it gives a finish time and no intermediate times. Trail mode needs to know when you cross treeline. |
| Tobler (1993) | **Chosen.** Continuous speed as a function of slope, so every profile segment gets a speed and every point gets an arrival time. Handles descent honestly, which matters because half of an out-and-back is downhill. |
| Municipal/DIN grade tables | Step functions. Same intermediate-time property as Tobler with worse behaviour at the boundaries and no published single form to cite. |

Tobler is scaled by **one** pace factor, never per segment, so the shape of the curve
stays Tobler's and only the magnitude is ours. Factors are calibrated on flat ground,
the one number a reader can check against their own experience: slow 3.2, steady 4.0,
fast 4.7 km/h. Speed is floored at 0.6 km/h so a geometry spike cannot turn one 140 m leg
into an hour.

The counter-intuitive term is deliberate and worth not "fixing": Tobler peaks on a
slight **downgrade**, around -5%, not on the flat. That is why the return leg of an
out-and-back beats level ground, and why a naive "descent is 1.5 times faster" fudge does
not reproduce the numbers.

**The flat assumption is not a rounding error.** Flattop Mountain Trail climbs 790 m in
6.5 km. At a flat 4.0 km/h the walk out takes 1 h 37 m. Graded segment by segment it takes
2 h 30 m. Fifty-three minutes moves the high point clean across the convection window, so
a flat model does not produce a slightly wrong chart, it produces a chart of a different
day.

Pace is a **product** control, not a demo lever, for the same reason: it is a fact about
the user. Presented as slow / steady / fast, because nobody knows their own km/h.

## 4. The journey model

`src/trail/journey.ts`. One `Journey` object, three renderings. Built separately from all
of them so that if the chart, the table and the map disagreed about when you reach treeline
it would be impossible rather than merely unlikely.

Three things it does not invent:

1. **Elevation** is `trail.profile`, the same 48 samples the card sparkline and the
   grader already use. No re-sampling, so trail mode and discovery cannot disagree about
   the same trail.
2. **Weather** comes from the `WeatherProvider`, at points on the route at their real
   elevations, exactly as `gradeTrail` asks for it. Trail mode asks for 12 points rather
   than the grader's 5, because it has a distance axis to fill; 12 on this trail is a
   point every 540 m, below the 3 km Super Resolution grid, so the limit on resolution is
   the forecast rather than our sampling. Same interface, so `SuperResProvider` needs no
   change here.
3. **Condition levels** reuse the storm thresholds the peek's hour strip already switches
   on (0.12 / 0.30 / 0.55) and the four colours it already paints. Currently duplicated,
   because `peek.ts`'s copy is module-private and `phone.css` belongs to the discovery
   app. **Unify on graduation**: two copies of a threshold is exactly how a tint starts
   disagreeing with its own tooltip.

Markers are the vocabulary the data can actually support: depart, above treeline, high
point, turn around, below treeline, back at trailhead, last light. Each is a place, a
time, and at most a measure. Nothing interprets.

Verification is `node trail/journey-check.mjs`, which imports the shipped modules and
prints the pace table, the journey, the markers, the table rows, the horizon sweep and
the pace spread. A chart that looks plausible is exactly what a wrong pace model
produces, so the numbers get checked as numbers.

## 5. The two concepts

**A, the route is the canvas.** The elevation profile becomes the chart. Distance walked
runs left to right, the silhouette is tinted by the conditions at the hour you reach each
point, and the axis underneath is labelled in **clock time**, not kilometres. Uneven tick
spacing is information: crowded ticks are steep ground. Treeline is a dashed rule, drawn
as a terrain fact so it cannot read as a weather band. Four flags carry the events.

The argument for it: this is the graphic AllTrails structurally cannot draw, for the same
reason its card cannot carry a conditions pill. It also reads at a glance and it has
shape, which is the thing a table can never have.

**B, the journey is a table.** The same journey printed. Time, distance, elevation,
temperature, gust, storm probability per row, rows thinned to an even distance rhythm with
every marker keeping its own banded row. Colour is a backing tint behind the numbers
rather than instead of them, so a reader who cannot see it loses nothing, which is not
true of A.

The argument for it: it cannot be misread. Marine forecasts, avalanche bulletins and
NOTAMs are all tables, and the people who plan seriously around weather are fluent in
them. It also survives a phone at arm's length in bad light better than a gradient does.

**C, the route on the terrain.** The journey draped over a pitched 3D terrain map, tinted
by the same four bands, with markers whose labels carry **two** lines: air (temperature,
gust, storm probability at that point at the hour you arrive) and ground (underfoot state).

Three things make it a genuine third concept rather than a reskin of A.

1. **It restores place and gives up the whole day.** A is legible about time and mute about
   geography: it cannot tell you which side of a ridge you are on. The map inverts that
   exactly. You cannot see the whole day at once and the labels compete for room.
2. **The two label lines are a picture of TWC's two science deliverables.** Air is
   Deliverable 1, terrain-aware weather, which maps onto the Super Resolution system
   already in development. Ground is the warm-season trail wetness half of Deliverable 2,
   which the science response says has a working prototype. There is deliberately no third
   line, because winter snow state is the deferred half and an open research problem at
   high level of effort. The label shows the shape of the roadmap rather than claiming it.
3. **The machinery already exists.** `src/scope/phone/pmap.ts` is already a pitched terrain
   map inside a phone frame, with hillshade and a documented fallback that drops pitch to
   zero permanently if the DEM is unreachable. Concept C reuses it for the *journey* where
   the discovery page uses it for the *result set*, so the argument is consistent across
   the prototype rather than newly asserted here.

Ground reuses the grade's existing wetness model rather than inventing one: `holdsWater`
from `terrainFacts` (OSM surface as a drainage proxy times steepness times profile shape),
and the same half-life decay on antecedent water, evaluated per waypoint and per hour
instead of once per route and window.

None of the three is a straw man. That is the point of building them from one journey.

## 6. The dock

The discovery page's rule is that everything inside the frame is product and everything
outside is commentary. Trail mode strains it, because its two most important inputs are
genuinely the user's own decisions rather than demo levers.

| control | lives | why |
|---|---|---|
| Departure time | in the phone | The user's decision, and the input the whole screen is a function of. |
| Pace | in the phone | A fact about them, not about the weather. |
| Out and back vs one way | in the phone | Not derivable from open data (`SCOPE_PLAN.md` §2), so the user has to say. Being asked is honest; guessing is not. |
| Start / pause | in the phone | The only control that changes what the screen *is* rather than what it says. |
| Scenario | doc chrome | A prototype lever. Same rule as the discovery page. |
| Trail | doc chrome | On the discovery page the product chooses the trail; here it is the page's subject. |
| Region, units | doc chrome | Unchanged, including the shared `trailscope-units` key. |

**The consequence to design around.** On the discovery page the scenario switcher is the
most persuasive control, because it reranks a list. Here it is weaker: one journey
re-tints rather than reorders. The persuasive control in trail mode is the **departure
time**, and it sits inside the frame where the reader has to touch the phone to find it.
Whichever concept wins, the page has to walk the reader to that control early, or the
strongest thing on the screen goes undiscovered.

## 7. What building the statics turned up

Five things, all of them consequences for a real build rather than page copy.

- **The +36 h horizon bites much harder here than on the discovery list.** A journey
  occupies hours, so it has to fit inside the horizon *in full*, not merely start inside
  it. Measured on this trail: a 13:00 departure tomorrow ends 33 h out and is
  route-specific; a 06:00 departure the day after tomorrow ends 50 h out and is past the
  wall before the first step. **Trail mode is a today-and-tomorrow screen where discovery
  is a seven-day one**, and the wall has to be drawn on the departure picker rather than
  on a day bar. This is the sharpest new constraint the exercise produced.
- **Departure hour dominates the forecast the walk meets, on a short trail.** Same trail,
  same day, same scenario, steady pace, varying only the departure:

  | depart | finish | storm peak | bands reached |
  |---|---|---|---|
  | 09:00 | 13:21 | 35% | no amber, no red |
  | 10:00 | 14:21 | 50% | amber, no red |
  | 11:00 | 15:21 | 68% | all four |
  | 12:00 | 16:21 | 88% | all four |

  A 6.5 km trail is short enough that *when you start* moves the answer further than the
  forecast does. The product consequence: the departure control is not a convenience, it
  is the primary input, and a screen that defaults it silently is hiding the variable that
  matters most. The page defaults to 11:00 for exactly this reason: it is the earliest
  realistic departure that crosses all four condition bands, so the concepts are judged on
  a journey that exercises them. A 09:00 default would have produced a chart with no amber
  and no red and flattered both designs.
- **Seams choose your hero trail if you let them.** The obvious pick by relief, East
  Longs Peak Trail, is `parts: 2` with `seamIndices: [47]` and a 648 m step between its
  last two profile samples: not a descent, a different piece of trail 600 m lower. Timed
  naively that leg reads as a fast downhill and the chart shows a cliff. Seam legs are
  excluded from the walk (no distance, no time, no marker) and the count is reported
  rather than hidden. Any build has to do this deliberately, and `MERGE_PLAN.md` §6 warns
  that `__parts` is not even a reliable continuity signal, so the check cannot be "is
  parts > 1".
- **The marker vocabulary is thinner than the design wants.** Junctions, water crossings
  and surface changes are all things a hiker would want marked and none are available:
  the derived data carries one surface value per trail and no junction nodes at all.
  Aspect and shade are the one wanted marker that open data *could* support, from slope
  azimuth plus sun position, and they are not in the derived output today. Everything else
  needs OSM node data the pipeline currently discards.
- **Two bugs in the statics, both found by checking rather than by looking.** Worth
  recording because of *how* each surfaced. The seam test was written against the wrong
  index (`seamIndices` holds the index that *begins* a new part, so the gap is between
  `i-1` and `i`, and the test read the lower one). It survived review because the page's
  own hero trail has no seams, so the code path was never exercised: the check passed
  vacuously and only showed up when `journey-check` was pointed at the two-part trail,
  where it printed two markers at the same time and place. Separately, the table's marker
  band could print one marker twice on adjacent rows, because each row was matched against
  a distance tolerance independently rather than each marker claiming one nearest row. That
  one is worse than cosmetic: Concept B's stated advantage is that it cannot be misread.
- **The profile chart exaggerates the vertical about 16 times, and has to say so.** 340
  units of width carry 13 km while 378 units of height carry 900 m. That is inside the
  convention for profile charts, which commonly run 10 to 20 times, and the taller chart is
  the right call for a page whose thesis is that the route is the canvas. But readers judge
  steepness from these charts, and a page this careful about not overclaiming elsewhere
  cannot let a graphic overclaim silently. The factor is computed from the chart constants
  and the journey extents and printed under Concept A.
- **The ground number moves and the ground word does not, and the reason is not the one I
  predicted.** This is the sharpest finding Concept C produced, and it took two causes apart
  that are easy to conflate. Measured on the page's journey (Flattop, storms, 11:00, steady,
  `holdsWater` 0.414): `groundWetMm` runs 26.1 to 41.7, a 60 percent swing, and reads
  **damp underfoot at every one of the 95 waypoints**. It would need 24 percent more water
  to tip to "wet" and roughly as much less to fall to "a few damp sections", so the journey
  sits mid-band throughout.

  I predicted the ground line would barely vary because `holdsWater` is route-level. That
  was wrong about the number. Position genuinely does move it: holding position fixed at the
  trailhead, elapsed time alone accounts for about 11 mm across the 4 h 21 m walk, and the
  summit reads about 5 mm above what that time trend predicts there. The page computes that
  split live against a linear time-only counterfactual, which is why it lands near but not
  on my first hand estimate of 7 mm: the rain field is not linear in time. The computed
  figure is the one to quote. So there are two separate limits, and only one is the data gap:

  1. **Structural.** `holdsWater` is route-level, because OSM carries one `surface` value
     for a whole trail. Two genuinely different surfaces on one trail are therefore
     indistinguishable, whatever the forecast does. This needs **per-segment surface data**
     and no amount of R&D substitutes for it.
  2. **Empirical, and possibly just this trail.** The plain-language bands inherited from
     `grade.ts` are wide enough that a 60 percent swing does not cross one. That is a
     presentation choice, not a data limit, and it is cheap to revisit.

  The consequence for a build estimate is unchanged and worth stating carefully: the science
  team has a working warm-season wetness prototype, so the forecast half is not the blocker.
  But a *route-specific* ground claim needs a trail-data investment as well as an R&D one,
  and on the evidence here a finer band scheme too. The page states the constant word rather
  than faking variation to make the concept look better.
- **Concept C is the only part of trail mode that cannot be frozen.** A and B render from
  committed derived data and work offline. C needs live DEM and basemap tiles. The rest of
  the prototype was built deterministic precisely so it cannot flake in front of an exec
  (`SCOPE_PLAN.md` §4), and C gives that up in exchange for terrain. The DEM-unreachable
  fallback has to be genuinely wired, not assumed.
- **The Ozarks case does not crash, it just says nothing.** Checked headlessly rather than
  rendered, since the page is pinned to RMNP: a journey over a 77 m-relief Ozarks trail with
  `treelineM` at the no-treeline sentinel produces finite, sane values throughout, zero
  exposed minutes, and no treeline markers. The chart's vertical exaggeration comes out at
  21x there against 16x at Flattop, which is the tell: the flatter the ground, the harder the
  chart has to stretch to show anything, and past about 20x a profile chart is drawing noise.
- **Where there is no terrain there is no concept.** The Ozarks finding from
  `SCOPE_PLAN.md` §8 applies with full force: a journey chart over 60 m of relief with no
  treeline is a flat band of one colour. Both concepts should be looked at in the Ozarks
  before either is chosen, and neither will look good. That is a fact about the product's
  addressable geography, not about the drawing.

## 8. Open, and what I would decide next

- ~~Which concept.~~ **Decided 2026-08-10 by Björn: C leads.** The page is restructured
  map-first and A and B are demoted to alternatives considered, kept working rather than
  deleted.

  For the record, my read had been the opposite ordering: A as the screen, C as its map tab,
  B behind a density toggle, on the grounds that C is the most impressive in a demo and the
  least legible in use. That was a recommendation, not a finding, and it is overridden. Two
  consequences of C leading are worth carrying forward rather than rediscovering:

  1. **The page now depends on the network.** A and B render from committed derived data and
     work offline; C needs live DEM and basemap tiles. The rest of the prototype was built
     deterministic specifically so it cannot flake in front of an exec (`SCOPE_PLAN.md` §4).
     The DEM-unreachable fallback is therefore no longer a nicety, it is the page's
     resilience story, and it has to keep being tested rather than assumed.
  2. **C is the weakest of the three in the Ozarks**, where there is no treeline and 60 m of
     relief. A map-led page is a mountain-led page. That is fine for the RMNP demo and worth
     saying out loud before anyone shows it against a flat region.
- ~~**The return leg is assumed.**~~ **Resolved 2026-08-10: ask, do not assume.** See §10.
- **Winter is untouched.** Ski touring is where on-route conditions matter most and where
  the science response defers snow state as an open research problem. Same treatment as
  the discovery page: out of scope and visibly so, rather than faked.
- **Aggregates on the started state.** Exposed time *remaining* is a different number from
  exposed time *total*, and the static does not yet make that distinction. Small, real,
  and a correctness bug the moment the screen is interactive.
- **Re-forecast cadence has to be visible.** Super Resolution runs four times a day, so a
  started journey is re-forecast on a cadence rather than continuously. The started state
  carries a recalculation stamp for exactly this reason; a screen without one implies a
  live feed that does not exist.

## 9. Repo layout

```
weather-on-route.html         ← page shell (a PAGES entry: "Weather-on-route")
TRAIL_PLAN.md                 ← this file
trail/
  journey-check.mjs           ← headless check: pace table, journey, markers, horizon sweep
src/trail/
  pace.ts                     ← Tobler + pace factors, and why not the alternatives
  journey.ts                  ← the Journey model: waypoints, markers, aggregates
  route.ts                    ← page entry: the map, the alternatives, prose
  route.css                   ← document layout + the smaller device frame copy
```

Conventions are `SCOPE_PLAN.md`'s: no decimal places on percentages, first person
singular, no em dashes, findings separated from hypotheses, and every number on the page
interpolated from the derived data at render time rather than typed.

## 10. Traversal: how the trail is walked (2026-08-10)

The question §8 held open, answered. Trail mode **asks** rather than assumes, through one
small control inside the phone frame, with out-and-back as the default because 92 to 97
percent of these trails are walked that way.

### It is not one axis, and calling it "one way versus loop" hides that

Loop is a property of the **geometry**, not a choice: you cannot elect to loop a linear
trail. So the control is conditional on `routeType`, and only its linear branch is a
question about the walk at all:

| route type | the choice | why |
|---|---|---|
| `point-to-point` | Out and back (default) · One way | A fact about how the walker uses a line, which open data cannot know. `SCOPE_PLAN.md` §2 cut out-and-back as a *derived* type for exactly this reason; it never settled what the time estimate should therefore assume, which is the gap this closes. |
| `loop` | Clockwise · Anticlockwise | The circuit is fixed, so the only free variable is which way round. |

The route type itself stays a **displayed fact**, beside length and gain, which is how
AllTrails presents it too.

This is the only interactive control on an otherwise static page, and deliberately so: a
toggle that did not move the numbers would not demonstrate the answer it exists to give.

### Direction genuinely matters on a loop, and cannot be shown on this data

Reversing a loop is not a null operation, for a reason worth stating because it looks like
one. Total ascent equals total descent on a circuit, so a symmetric model would return the
same time either way. Tobler is **not** symmetric: it peaks at about -5%, so flipping every
segment's sign changes the total. More importantly it moves **when you are at the high
point**, which is the entire question under afternoon convection: the same circuit climbed
first or climbed last puts the summit in a different hour.

But no seeded loop can demonstrate any of that. Measured across all three regions:

| region | largest loop | gain |
|---|---|---|
| RMNP | Bear Lake Trail, 1.04 km | 25 m |
| Adirondacks | Loop Trail, 2.91 km | 78 m |
| Ozarks | Honey Run Trail South Loop, 4.30 km | 38 m |

All below treeline, all short enough that no convection window is in play. The loop branch
is therefore correct code with nothing to prove it on, and the page says so rather than
picking a lake circuit and implying direction matters there.

**That absence is itself a finding, and it is the benchmark's gap from a third angle.**
AllTrails can offer an 8.2 km park loop because a **user recorded a composite route**. Open
data holds the constituent named segments and no loop entity, and `MERGE_PLAN.md` already
establishes that composite route names cannot be assembled by any name-based merge. The
loops that do exist in open data for these regions are lake circuits and field loops, not
circuits over terrain. So the honest reading is not "these regions have few loops", it is
**open data has few loops because a loop is usually a curated route rather than a mapped
object**, and route curation is precisely what the benchmark measured AllTrails owning.

### Consequence for the discovery page, not yet applied

The discovery card cannot ask, because it is a list. So where trail mode asks, the card has
to **label**: `estMinutes` is Naismith on one-way length and gain, and it silently reads as
the whole outing on the 83 of 87 RMNP display-set trails that are point-to-point. Worse,
`terrainFacts.durationH` carries that same one-way figure into `bestWindow`, whose search
sizes the window with `needed = min(durationH, availableH)`, so a window can be offered that
closes before the walker is back.

Two fixes, of different sizes:

1. **Label it.** "2 h 37 m one way" on the card. No model change, removes the misread.
2. **Size the window to the outing.** The correctness fix, and it cannot be done by doubling:
   Naismith charges 10 minutes per 100 m of *ascent* and the return leg has none, so
   doubling Flattop gives 5 h 14 m against a properly modelled 4 h 21 m. It needs the
   per-segment pace model, which means the discovery page borrowing `src/trail/pace.ts`.

### Measured, once the control was wired

Flattop, storms, 11:00 tomorrow, steady pace:

| | total | finish | walked | above treeline | storm peak | waypoints per band |
|---|---|---|---|---|---|---|
| Out and back | 4 h 21 m | 15:21 | 13.0 km | 1 h 52 m | 68% | 10 / 18 / 40 / 27 |
| One way | 2 h 30 m | 13:30 | 6.5 km | 1 h 03 m | 68% | 10 / 18 / 19 / 1 |

The band counts are the interesting column. The peak is identical, because the peak is a
property of the day and the place, not of how far you walk. But the top band drops from 27
waypoints to 1: **on this trail the storm exposure is almost entirely on the return leg.**
That is a product point the discovery card cannot make at all, since its one-way estimate
stops before the part that matters.

**My horizon prediction was half wrong, and the correction is more useful.** I expected a
one-way journey, being about half as long, to let more departures fit inside +36 h. On
Flattop it changes nothing: every day-1 departure fits either way, because at 4 h 21 m the
binding constraint is the day boundary, not the journey length. It only bites on a long
trail. North Inlet Trail (9 h 56 m out and back, 5 h 37 m one way):

| depart | out and back | one way |
|---|---|---|
| 06:00 tomorrow | ends 31.9 h, route-specific | ends 27.6 h, route-specific |
| 13:00 tomorrow | ends 38.9 h, **past the horizon** | ends 34.6 h, route-specific |

So traversal moves the horizon only when the walk is long enough to straddle it. The honest
statement is not "one way extends the horizon", it is **the horizon is a day-level
constraint for short trails and a journey-length one for long ones**, and a departure picker
has to compute the wall per trail and per traversal rather than drawing it once.

Incidentally North Inlet out and back is 9 h 56 m, not twice the 5 h 37 m one-way figure,
which is the Naismith-doubling error from §10 showing up in the correct model.

**Loop direction: non-zero and meaningless, exactly as predicted.** Sprague Lake Trail
(1.28 km, 12 m gain), the largest RMNP loop, comes out at 18.87 minutes clockwise against
19.05 anticlockwise. The difference is real, which confirms Tobler's asymmetry about zero is
doing what §10 says it does rather than cancelling. It is also 11 seconds, and the high
point falls at 11:10 either way, so nothing about the walk changes. The control is correct
and this data cannot exercise it.

### One bug class that only exists now the page has a live control

Two distance qualifiers did not follow the toggle: with One way selected the chart axis
still read "round trip" and the header still read "each way", both describing a walk the
reader had just said they were not doing. Found by clicking it in a browser, not by reading
the code.

Worth recording as a category rather than an incident. A static page cannot have copy that
goes stale against state, because it has no state. Wiring one control created the first
opportunity for it, and there will be more as others get wired: any string that describes
the shape of the walk rather than a measured value is a candidate. The fix keeps two
separate helpers, `lengthQualifier` for the trail and `walkQualifier` for the journey,
because they qualify different quantities and collapsing them would put "round trip" beside
a one-way number.

## 11. Renumbering, and a camera bug worth remembering (2026-08-10)

### The map is now Concept A

When the page was restructured map-first, the frame labels kept their original letters, so
the primary screen read "Concept C" while sitting at the top of the page. Björn's call:
renumber by page order. The mapping, recorded because every earlier entry in this file and
in the conversation history uses the old letters:

| concept | was | is now |
|---|---|---|
| route on a pitched 3D map, the primary screen | C | **A** |
| conditions along the elevation profile | A | **B** |
| tabular readout | B | **C** |

Sections above this one still say C for the map, A for the profile and B for the table.
Read them with this table in hand rather than rewriting them: the argument each one makes
is unchanged, and rewriting history here would make the findings harder to trust, not
easier.

`src/trail/mapconcept.ts` keeps its name. It is the map concept whatever letter it carries.

### `fitBounds` is wrong on a pitched terrain map, and it bit twice

The default map view showed a region-scale terrain shot with the trail off the top right
edge and the expanded marker card clipped. Cause: `mapconcept.ts` constructed `PhoneMap` on
the trail's own bbox and called `fitBBox` on it immediately inside `whenReady`. **MapLibre's
`fitBounds` does not account for terrain elevation**, so with `PITCH` at 52 and
`EXAGGERATION` at 1.4 a tight single-trail fit on the first frame lands somewhere else
entirely.

The same defect had already been found and fixed once, in the peek's map, where it presented
differently: there it rendered a genuinely blank canvas rather than the wrong place. The fix
in both cases is to construct on the region's bbox, as the results map does, then gate the
tight `fitBBox` on the map's first `idle`, raced against a timeout so a DEM failure cannot
hang the load.

Two things worth carrying forward:

1. **The symptom does not identify the cause.** Blank canvas and wrong-place framing are the
   same bug. Anyone debugging a third instance should suspect the camera before the data.
2. **There are now at least two call sites needing this behaviour**, so it belongs in
   `pmap.ts` rather than in each caller. A third copy would be a pattern nobody remembers.

## 12. The marker redesign, and the fix that over-corrected (2026-08-11)

### The complaint, in two parts

Björn's read of the redesigned marker, after §11's polish pass shipped: the markers no
longer mark the trail, and they say too little. Both are real, and the second explains the
first — §11's own fix pushed a marker's TIME LABEL clear of the route line, to stop a large
detail card from covering the trail it described. That was the right call for the bug it
fixed. But it kept pushing until the marker itself no longer sat where it named, which is a
different failure the label-clearance search was never asked to solve, and Björn noticed the
same thing independently.

**The distinction that was missed, stated once so it does not get missed again:** a big card
covering the route was the bug. A compact marker sitting on its own point is not the same
bug, and never was. A marker's whole job is to say "this spot, at this time"; it has to sit
AT that spot.

### The new marker: a place, a time, a measure

Three pieces, stacked in the order Björn asked for: arrival time, a weather glyph, temperature
below it. The badge sits centred on its own point — anchored via the SAME `anchor: 'center'`
Concept A always used, now trusted rather than fought, because the badge's content is fixed
for the life of a render (only a selection ring toggles) and can no longer drag its own
anchor sideways the way a conditionally-shown label once did.

**The weather glyph reuses the storm bands, not a new cut.** `journey.ts`'s existing
`levelForThunder` thresholds (thunderProb 0.12 / 0.30 / 0.55) decide the top of the scale:
level 3 → `bolt`, level 2 → `suncloud`. Below that, `cloudPct` and `precipMm` decide sun vs.
cloud, since thunderProb alone has nothing left to say at Calm/Slight. Full account and the
precedence table: `src/trail/markerui.ts`'s `weatherIcon`.

**The gap.** `src/scope/phone/ui.ts`'s shared `ICONS` map, read-only from `src/trail/**`, has
`sun`, `suncloud` and `bolt` in this family but no plain overcast `cloud` and no
`cloud-rain`. A Risk-band hour and a merely-cloudy Calm hour share `suncloud`; a wet-but-not-
stormy hour is not visually distinct from a merely-cloudy one. Both are the nearest present
glyph, recorded here rather than patched by adding to a file this redesign was told to leave
alone.

### What got removed, not just simplified

`mapconcept.ts`'s Fix 3 — an eight-direction, four-radius search that walked a marker's time
label away from the route line, re-run on every map `render` — is gone outright, along with
its whole support cast (`positionLineClearLabel`, `OFFSET_DIRS`, `LABEL_OFFSET_RADII_PX`,
`trailGeometryLngLats`, `sampleLineScreen`, `localScreenTangent`, `screenPoints`,
`repositionSelectedLabel`, and the `render` listener that drove it). It existed to solve a
problem — the label painting over the line — that the redesign's own brief says is no longer
a problem. `markerui.ts`'s `declutterMarkerLabels` (Fix 1's runtime label-hider) is gone with
it: it only ever worked because the time text was optional content on top of an icon that was
never hidden, and every marker's content is fixed now, so there is no sub-part left that can
be hidden without losing the fact the marker exists to state. `edgeAwareAnchor` goes too —
nothing grows sideways to dodge anything any more. `MarkerController` loses `runDeclutter`
along with it.

### Marker-to-marker overlap is now the merge radius's job, and it had to move

Removing the runtime declutter pass means overlap prevention has to happen earlier, by
grouping — the tool §10 elsewhere already trusts for "these are one place." `MERGE_RADIUS_M`
(the map) moved from 150 m, tuned against an 18 px icon-only pin, to 650 m, measured against
the new badge on Flattop:

| pair | ground distance | old radius (150 m) | new radius (650 m) |
|---|---|---|---|
| treeline crossings (up/down) | ~70 m | merges | merges |
| high point / turnaround | ~560 m | does not merge → **overlapped on screen** at the new badge size | merges |

560 m is "several hundred metres," which the OLD radius's own comment named as exactly what
it must never merge — a genuinely different place, at the OLD pin's scale. At THIS trail's
fitted map zoom the two project to 31 px apart on screen, and the new badge (single-line,
38 px wide) cannot fit two of itself into that gap without touching. The badge size changed
what "one place on this screen" means, not the map's own honesty about geography, so the
radius follows the badge rather than staying pinned to a number tuned for a pin this marker
no longer is. Verified, not assumed: 0 overlapping marker pairs on Flattop in both traversal
states measured (out-and-back, one way), by real `getBoundingClientRect()` pairs, not by eye.

Concept B's own chart-row radius (`chartMergeRadiusM`, `route.ts`) is untouched: that row
stays glyph-only (below), so its footprint did not grow and its existing pixel budget still
holds.

### Anchor accuracy, measured

Each badge's centre projects to within 0.01 px of the trail's own rendered line geometry —
effectively exact, because the anchor `lngLat` is a point sampled directly off
`routeSamplePoints`, the same resampling the profile and the rendered line both already use.
The redesign changed what sits AROUND that point, never the point itself.

### Concept B stays glyph-only, on purpose, not as an oversight

Concept B's marker row is inset in the chart's own 26 px `CH_TOP` margin, and its x axis
already IS time. A three-row card does not fit that row's own height budget, and a restated
time on every glyph would repeat what the axis beneath it already says. So Concept B keeps
exactly the density it had — a bare glyph, nothing else, even selected — and picks up only
the VOCABULARY change: the glyph is now the hour's weather, matching Concept A, rather than
the marker's kind. Same reasoning as `markerui.ts`'s own header always made for sharing one
marker language across both frames: two frames drawing the same data at different densities
is fine; two different marker languages is the thing that was never fine.

## 13. Separating the anchor from the card, and the constant that had to move a third time (2026-08-17)

### The complaint, and why the two obvious fixes had both already failed

Björn, on §12's marker: *"how can we make it so the markers don't overlay the route so
much?"* Three badges, each carrying a time, a weather glyph and a temperature, on a 350 px
wide map, blanketed most of the visible trail.

The measurement, taken before changing anything, because "so much" deserved a number.
Screenshot the map host twice at one camera — once with every marker hidden, once with them
shown — and count the route line's own rendered pixels in each. The line is drawn at
`line-opacity: 1` in a flat hex, so a tight colour distance finds it, and marker furniture is
DOM over the canvas, so whatever it covers simply stops being counted.

**69% of the rendered route line's pixels were covered by marker furniture.** Stable across
colour-distance cuts from 30 to 60 (0.694 / 0.694 / 0.691); past 60 the mask starts catching
shadowed terrain of a similar hue, which is why 60 is the cut used throughout.

The badges measured 78 x 51 px, not the 38 px §12 recorded. §12's figure was for a
single-line badge; a *merged* group prints two clock times ("11:00 · 15:21"), and on Flattop
two of the three groups are merged.

What made this hard is that both obvious fixes were already in the history of this file:

| attempt | what it did | line overlap | did the marker mark its place |
|---|---|---|---|
| §11 | eight-direction, four-radius clearance search pushed the label off the line | zero | **no** — Björn noticed unprompted |
| §12 | anchored the whole badge back on its own point | **69%** | yes |

Neither could win, and the reason is worth stating as a general one: **the anchor and the
card were the same object.** A card has to sit where the point is, and a point cannot be
anywhere but on the line. No amount of tuning a single object escapes that.

### The fix: two objects, and only one card open

- A **dot** stays exactly on the point. It is a 26 px level-coloured disc carrying the hour's
  weather glyph — which is precisely the element Concept B's chart row already drew, so the
  two frames' markers are now literally the same element rather than two densities of one.
- The **selected marker only** also gets a **card** (time above, temperature below), offset
  perpendicular to the trail's local screen tangent, with a **short leader** back to the dot.
- Everything else the badge used to say is already in the **dock**, which was always
  pre-populated on load. That is what made the split affordable rather than lossy.

Mechanically, the marker element handed to MapLibre is now a wrapper whose card and leader are
absolutely positioned, so the wrapper's own box is exactly the dot's box and `anchor: 'center'`
still centres the **dot** on the lngLat however far the card is offset. The card is not in the
layout that decides the anchor. That is the whole trick.

**The offset direction is read off the line, not picked from a compass.** §11 searched eight
fixed screen directions, several of which run *along* a diagonal trail and cannot get clear of
it at any radius — part of why it needed such large radii and ended up so far from its point.
This projects the trail's real, full-resolution geometry to screen (`map.project` accounts for
terrain, so this is where the line is actually *painted* on a pitched exaggerated map), takes
the local tangent, and offsets perpendicular to it: the shortest way off the trail. Which of
the two sides is decided by counting line vertices in each candidate box, so a switchback on
the far side cannot be walked into. Six candidates total — two sides x three gaps of 11, 18 and
25 px — with the shortest gap that is clear winning.

### Measured

| | §12 badge | §13 dot + one card |
|---|---|---|
| route line pixels covered | **69%** | **35%** |
| furniture drawn on the line | 3 badges, 78 x 51 px | 4 dots, 30 x 30 px |
| open card ∩ route line | n/a (card *was* the anchor) | **0 px, all 8 marker/traversal combinations** |
| dot anchor → nearest rendered line pixel | 0.71 / 0.71 / 1.58 px | 0.71 / 0.71 / 1.58 / 0.71 px |
| dot-to-dot box overlaps | 0 | 0 |
| visible leader length | n/a | 11 px, every case (shortest candidate always won) |

The anchor distances are **identical before and after**, which is the point: the dot inherits
the badge's own lngLat, a `routeSamplePoints` sample interpolated along the drawn geometry, so
it lies on the line by construction at any zoom. (§12's "0.01 px" was measured against
projected geometry; 0.71 px is the same fact measured against a screenshot's pixel grid, where
half a pixel is the floor.)

### `MERGE_RADIUS_M` moves a third time, and this time a marker comes back

150 m (18 px pin) → 650 m (§12's badge) → **300 m**. The question §12 closed is reopened by a
smaller anchor: does Flattop's high point / turnaround pair — 560 m apart on the ground, real
distinct places — separate again?

**Yes.** Measured at the real fitted camera, that pair projects **31.1 px** apart (§12
estimated ~31), and the dot's whole box is 30 px. 30 fits inside 31.1, so the two dots do not
overlap, do not share hit area, and read as the two places they are. A marker recovered.

The radius is then derived from the pair it must still **merge** — the two treeline crossings,
~70 m apart — rather than from the pair it must not, which is why it lands at 300 and not just
above 560.

**The honest caveat.** At this camera the screen scale is ~18 m/px, so a 30 px box collides at
~540 m of ground separation and the pair sits at 560 m. Four percent of margin. Landing the
constant at 300 does not widen that — nothing can, it is a fact about this trail at this zoom —
but it keeps the constant anchored to a gap with room around it. A trail whose fit lands
slightly tighter would put the same two markers under 30 px. No metre-valued constant can see
that coming, and the map cannot borrow Concept B's fix for the identical problem
(`chartMergeRadiusM`, a pixel budget converted per journey) because the chart's x-scale is
fixed while the map's zoom belongs to the reader. If this ever needs to be robust rather than
measured, the answer is a screen-space regroup on camera change, not a better constant.

**One tension this creates, recorded rather than papered over.** The map now shows the high
point and the turnaround as two markers while Concept B's chart still merges them, so the two
docks read "HIGH POINT" and "HIGH POINT / TURN AROUND" for what a reader may take to be the
same thing. This is `markerui.ts`'s header's own argument working as designed — the chart
compresses 13 km into 320 px, where 600 m of travel really is 15 px — but before this change
both frames merged, so it was not visible. Worth a look if the frames are ever shown side by
side rather than one after the other.

### Weather glyphs 1.5x, in all three concepts

Björn: *"the weather icons need to be 1.5x bigger (in all concepts)."* Sizes now live in one
place, `markerui.ts`'s `GLYPH_PX`, because three call sites at four sizes is how a shared
vocabulary stops being one.

| call site | was | is | note |
|---|---|---|---|
| marker dot, both concepts | 15 (map) / 13 (chart) | **20** | two sizes collapse into one — the map's extra rows left the badge |
| dock strip, both concepts | 14 | **21** | dock height unchanged at 98.2 px: 21 fits the existing 1.7 line-height |
| Concept C, header + rows | 10 | **15** | one number for both, so the table has one scale |

Only the weather family. `src/scope/**`'s copies (the discovery app's strip, cards and peek)
are deliberately untouched: read-only from here, and the two pages are not read side by side.

**The one place this fought the occlusion work, and how it resolved.** A 20 px glyph needs a
26 px disc, which sets a 30 px box — and 30 px is exactly the number the 31.1 px marker pair
had to fit inside. Bigger glyphs and separable markers were one constraint away from being
mutually exclusive. They are not, but the margin is 1.1 px, and it is the same 4% margin the
merge radius section records from the other end.

**Concept B's row had to grow, which is the one place shared code forced a change there.** The
dot's box went 24 → 30 px against a row that reserved 22. It grows *upward*, taking 4 px from
`.ph-block`'s own 13 px top padding via a negative `top`, rather than downward into the plot (a
glyph over the profile curve is the same bug this whole section exists to fix) or by raising
`CH_TOP` (which would shrink the plot and change `chartExaggeration`, a number printed on the
page, to buy room for an icon). Measured: the row's buttons end 26 px below the chart's top
edge, against a `CH_TOP` at 24.5 CSS px, so they reach 1.5 px into a top margin where nothing
is drawn.

**Two chart constants had gone stale and are now derived.** `layoutMarkerX`'s 30 px minimum
gap was written when the box was 24 px and documented as carrying 2 px of headroom over the tap
target; at a 30 px box it silently became a gap of exactly one box width with none. Its edge
clamps (3% / 97%) were half-a-box figures for a 24 px box. Both, and
`CHART_MERGE_GAP_PX`, now read `markerui.ts`'s `DOT_BOX_PX`. That is a CSS number duplicated
into TypeScript, which is a drift risk taken deliberately: the alternative is three
hand-derived literals that go stale together and silently, which is what just happened.

### Concept C gets a weather glyph per row

Björn: *"Tabular readout also needs weather icons."* Every data row now carries the hour's sky
in a seventh **SKY** column, from the same `weatherGlyph` precedence the markers and the dock
use — one mapping, not a second.

- **It costs no rows.** `.ph-trow`'s height is a fixed 30 px, so a 15 px glyph changes nothing
  `fitRowCount` reads. **15 data rows and 4 marker bands before and after**, `.ph-tbody`
  overflow 0.
- **Trailing, not leading.** The glyph is *derived* from the three numbers to its left
  (`weatherGlyph` reads storm probability, then precipitation, then cloud), so trailing reads
  as their summary; leading would put a conclusion before its own evidence and displace the
  clock time a reader scans the table down by.
- **The header glyphs stay.** They were offered as the thing to drop if the row glyph cost a
  row. It did not, and the two do different jobs: the header names what a column *measures*,
  the row says what that hour is *like*. The seventh track was paid for by tightening
  TIME/KM/ELEV against their own widest content — all seven header cells measured at **0 px of
  overflow**, which is the specific Fix 2 bug this row has already had once.
- **The row glyph carries a real accessible name**, one word (`SKY_WORD`), not `aria-hidden`.
  The test is whether it says anything the row's numbers do not, and it does: the row prints
  temperature, gust and storm probability, none of which separates a wet hour from a merely
  cloudy one. The header glyphs stay `aria-hidden`, because their columns are named in text
  beside them.

### Verified in a browser, not by reading the code

- **Traversal round-trip**, the §10 bug class: select the turnaround (which exists only on an
  out-and-back), toggle to One way, and `resolveSelection` falls back to the high point with
  the dock, the `aria-pressed` marker and the open card all agreeing. Toggle back, still
  agreeing. Invariants checked as a set — exactly one open card, exactly one pressed marker,
  the same marker for both, no unselected marker showing a card, the dock's title matching the
  pressed marker, and the card's own text matching the numbers in its `aria-label` — so a
  rebuild cannot pass by producing a different but equally broken shape.
- **DEM unreachable**: 43 Terrarium requests blocked, the map draws flat, and the route line
  (1,058 of its own pixels, more than the 711 with terrain, because a flat map hides no part of
  the trail behind a ridge), the four dots, the open card and a populated dock all render.
- **Keyboard**: a dot is reached in 10 Tab presses, is a real `<button>` with `tabIndex` 0, and
  under genuine keyboard focus reports `:focus-visible` with a 2 px accent outline at 2 px
  offset on a 30 x 30 box. Enter selects, and the dock follows.

### Still weak

- **The 1.1 px of slack** on the separated marker pair, and the 4% margin behind it. Both
  above.
- **`DOCK_HEIGHT_PX` is 78 against a dock that measures 98.2 px** and whose own comment claims
  "around 65". Pre-existing, unchanged by the glyph scale-up (98.2 px both before and after),
  and left alone on purpose: it is the bottom clearance `fitBBoxWhenSettled` uses, so correcting
  it moves the camera, which would invalidate every measurement in this section including the
  31.1 px that decided the merge radius. Worth fixing on its own, with a re-measure after.
- **The layout pass runs on camera change and on `idle`**, not on every `render` — a camera
  signature cannot see a DEM tile landing and changing what `map.project` answers, which is why
  `idle` also fires one unconditionally. If a future terrain source updates without ever going
  idle, the open card's chosen side could be one DEM generation stale. It would be wrong by a
  few pixels of tangent, not by a side.

## 14. The second anchor, rebuilt, and the cached run it is met through (2026-08-26)

Björn: *"for offline that's mostly relevant for weather on route. I think we need to make a
state for these mockups where the user is in the middle of their route and is checking the
forecast but we need to say that the forecast is based on offline data."*

Two things came back in one change, because they are one situation. §1's **one screen, two
anchors** was cut as code when the page went map-first (§10 records it), so the walking anchor
is written again rather than un-commented. It is written back joined to the cached forecast:
most US trails have no signal, so three quarters of the way up one is exactly when the run in
your pocket stopped being current, and a walking state that pretended otherwise would be the
less honest of the two.

The model is `src/trail/onroute.ts`, built from a `Journey` the way the `Journey` is built from
a trail: one object, three renderings, so the map, the profile chart and the table cannot
disagree about where now is.

### There is no offline banner, and that was the design decision

That the radio is off is a status LED. It changes nothing anybody decides, and a banner would
have been the whole feature. What changes a decision is two computable things, and the page
draws both:

1. **When the run was fetched and how old it is.** Modelled exactly the way
   `scope/phone/grading.ts` already models it and read from there rather than invented twice:
   the FETCH moves back, the clock never moves forward, so every marker hour and every clock
   label stays where it was and only `horizonHours - age` changes.
2. **Whether the run still reaches the finish.** Nobody had drawn this. The discovery page puts
   the same wall on a day bar, between two days, where it reads as a fact about the week. Here
   it lands inside a single afternoon, between two hours of one walk, which is what turns
   "am I offline" into **"does my forecast still cover my finish"**.

### The one line most at risk of becoming a warning

A stale forecast above treeline with convection building is the single situation on this page
that tempts a hazard sentence. §1's rule holds; the copy states two clock times and stops:

> **Hourly to 14:48, then area outlook to 15:21.**

and, when the run does reach:

> Hourly to 14:48, past the 13:30 finish.

No imperative, no adjective, no consequence named. "Hourly" and "outlook" are the two words the
discovery day bar already prints under every day button, so a reader who has met the wall there
meets one vocabulary rather than two. Checked in the browser as a set: the rendered page
contains none of danger, hazard, unsafe, warning, caution, turn back, risk, or an exclamation
mark, in any state.

### Where the controls went, under §6

| control | lives | why |
|---|---|---|
| Planning / Walking | in the phone, top right of the header | §6's own table already says so: "the only control that changes what the screen IS rather than what it says." Whether you have set off is a fact about the reader, like departure, pace and traversal. |
| Connection (cache age) | doc chrome | A walker does not DECIDE to be offline and cannot decide how old their cache is. It is a fact about a device and a valley, in the way the scenario is a fact about a day. `scope/doc.ts` reached the same conclusion for the discovery page. |

The anchor toggle is in the HEADER rather than the control bar, and that is a measurement. The
bar's three pills come to 290 px of a 320 px content row with 12 px of gaps already spent, and
`.ph-bar` is `overflow: hidden`, so a fourth pill would not wrap, it would silently vanish.
Shortening `Depart 11:00` to make room was rejected for a stronger reason than space: §6 calls
the departure pill the most persuasive control on the page. What sits in the phone is the
INDICATOR — a `wifi-off` chip, imported from the discovery app's own `ICONS` rather than added
to — which is what a product would show. What sits outside is the switch, which no product has.

### The arithmetic finding, which is the useful one for TWC

**On a day walk, a +36 h cached run outlives the walk unless it is more than 31 hours old.**
Flattop out and back is 4 h 21 m, so with the walker 1 h 48 m in there are 2 h 33 m left
against a reach of `36 - age`: the run has to be older than 33 h before the wall can land
inside the walk at all, and older than 36 h before it lands behind the walker. That is not a
narrow demo window chosen for effect, it is the whole space the case exists in.

Two consequences worth carrying:

- The state is real, and it is a **multi-day** state rather than a day-hike one. A run fetched
  before you left home, or before a drive out with no service, is 24 to 36 hours old by the
  time you are walking. That is the case the wall is for.
- It also means **planning offline is the harsher state, not the gentler one**. At the same 34 h
  age, a walk departing 11:00 tomorrow is past the reach before its first step, and the page
  says so and degrades the whole screen rather than drawing a wall at the trailhead:
  *"Hourly runs out before you leave. Outlook throughout."*

The two offline ages are derived, not typed: one is the walk's own elapsed time rounded up (the
last fetch before the trailhead), the other is the whole-hour age whose reach lands on the last
named marker before the finish. Both are computed once, at boot, from the walking anchor's own
journey, and never recomputed — how old a device's cache is has nothing to do with how the
reader walks the trail.

### Freezing the age is what produces the sharpest demonstration on the page

Because the age is frozen and the traversal is live, **the same 34 h run does not reach the
out-and-back's 15:21 finish and does reach the one-way's 13:30 one.** The page's own live
control flips the answer with nothing about the device having changed. The screen goes from
"then area outlook to 15:21" to "past the 13:30 finish", the chart's wall disappears, the
table's outlook band disappears, and the finish marker gets its storm band back.

### The map cannot hatch a walked portion, and that is a fact about out-and-back

§1 says the walked portion hatches. **Only the profile chart can do it.** Its x axis is travel
distance, so the outbound and return legs occupy different halves of it and "behind you" is
unambiguous. On the map the ground behind the walker at 12:48 is the identical geometry they
will walk again at 14:19, so a muted "already walked" casing would be muting trail still to
cover. The map says it with a position mark and with muted markers behind that position, which
is the most the geometry honestly supports.

The same collapse shows up in the markers. On the map, geographic clustering merges depart with
the finish and the two treeline crossings with each other (`MERGE_RADIUS_M`), and a group is
only "behind you" when its LATEST marker is and only "outlook" when its EARLIEST marker is — so
on an out-and-back **no map marker changes state at all**, while the chart, which clusters by
travel distance, shows a faded depart and a calendar-glyph finish. Both are right. It is
`markerui.ts`'s own header argument (the two frames are different spaces) reaching a place it
had not reached before, and it is worth knowing before anyone reads the two frames side by side.

### What degrading past the wall actually does

`SCOPE_PLAN.md` §4's rule applied here rather than reinvented: less certainty, not less content.
Past the reach nothing empties and nothing shows a dash.

- The chart's condition bands drop to `--lv-out`, a cool neutral deliberately off the four-step
  warm ramp, because "we cannot say" is not a low storm probability.
- Marker dots take the same neutral and the calendar `outlook` glyph; their `aria-label` reads
  "Outlook" in place of a band word.
- The dock keeps its three figures and its shape — `DOCK_HEIGHT_PX` is still 78 against a 98.2 px
  strip (§13) and must not move — but the figures become the STRETCH's rather than the hour's,
  and the title carries the word.
- The table prints the **same three figures on every row past the wall**. A reader watching the
  numbers stop changing row to row is reading the granularity of the claim directly off the
  table, which is more than a footnote could say.

### Measured

| | planning | walking | walking + 34 h |
|---|---|---|---|
| Concept A blocks | 59 / 44 / — / 555 / 45 / 29 | 59 / 44 / 50 / 505 / 45 / 29 | 59 / 44 / 67 / 488 / 45 / 29 |
| Concept B total of 732 | 699 | 711 | **728** |
| Concept C body overflow | 0 | 0 | 0 |
| phone head height | 59 | 59 | 59 |

Concept B was the only frame that had to be paid for: it carries 33 px of slack and the strip is
67. So when the strip renders its facts row goes from four figures in two rows to two in one,
which is a 38 px saving against a 67 px cost. Which two survive is not arbitrary — temp and gust
are already printed by the dock one strip below; treeline time and storm peak are only ever
stated as aggregates. And once there is a now, they become the REMAINING aggregates with keys
that say "ahead", which closes §8's open item ("exposed time remaining is a different number
from exposed time total"). **4 px of slack** is the tightest the frame has ever run.

Concepts A and C needed no layout argument: the map is `flex: 1 1 auto`, and the table derives
its own row count, so `fitRowCount` simply gives up rows for the strip and the two synthetic
bands. It has to be TOLD the strip's height (`C_STRIP_PX`, measured at its tallest), because a
row budget that cannot see a block inserted above it clips silently, which is §2's own finding.

### Three small things found by rendering rather than by reading

- **The position mark used to be an arrow.** Lucide's `navigate`, the mark the discovery app's
  tab bar uses for the on-route half of the product. On the map it pointed north-east while the
  walker was heading west, because a fixed glyph on a pitched map has no idea which way anyone
  is going. An arrow stating a heading nothing knows is the same class of overclaim the Limits
  section exists to avoid, so it is a plain location puck: a dark disc with a light core,
  inverted against every marker's light disc with dark ink.
- **`journeyDuration` now prints "42 min" below an hour**, not "42 m". Above an hour the "h"
  disambiguates and "4 h 21 m" cannot be anything else. On its own, in an app whose every other
  bare unit is metres, the one-way traversal produced "Treeline ahead 42 m" directly under
  "Above treeline 3450 m". Nothing that existed before changed: the page never printed a
  sub-hour duration, because the shortest thing it measured was a 2 h 30 m walk.
- **The chart's rule labels sit inside the plot, not above it.** At `CH_TOP - 1` they share the
  row `.cx-bflags` occupies, and the OUTLOOK wall lands within a few pixels of the finish
  marker, so the label was drawn across a 30 px disc. `CH_TOP + 10` is still clear of the
  curve, which `chartElevRange`'s 60 m of headroom keeps ~40 px down.

### The walking anchor's own constants, and why they are those

`ONROUTE_ELAPSED_H` is 1.8, which puts the walker 4.6 km up a 6.5 km climb at 3,555 m, above
treeline, with the high point, the turnaround and the whole convective afternoon ahead.
Measured against candidates rather than picked: 1.4 h lands 296 m from the treeline crossing
(~16 px at this camera's ~18 m/px, a collision with the position mark's own 30 px box), 1.5 h
lands 42 m from it, and 1.8 h lands 704 m past it. The upper bound is the traversal control:
one way is a 2 h 30 m walk, so anything past that would put the walker beyond their own finish
the moment the page's live control was touched — §10's bug class reintroduced by a constant.

The walking journey departs TODAY where the planning one departs tomorrow, which is the only
thing that genuinely differs between the two: you cannot be partway along tomorrow's walk. The
scenario is analytic over absolute hours, so the convection lands in the same place on both
days and the storm peak moves by two points rather than by a band.

### Still weak

- **Concept B at 4 px.** The frame is one line of copy away from clipping its own tab bar. The
  next thing added to it has to take something out.
- **`C_STRIP_PX` is a CSS number typed into TypeScript**, the same drift risk `DOT_BOX_PX`
  records and taken for the same reason. It is measured at the strip's tallest state, so it
  over-reserves about one table row in the two-line states.
- **No map marker changes state on an out-and-back**, above. Correct, and invisible unless you
  toggle to One way.
- **The fetch clock reads 02:48** on the 34 h option, which is where the arithmetic puts it:
  the reach has to land inside the next three hours, so the run has to be 33 to 36 hours old,
  and 34 hours before 12:48 is the middle of the night. Plausible for a drive out to an alpine
  start, and unavoidable at this horizon and this walk length.
- **Pace is still inert**, so the one input that would move the remaining time as much as the
  departure does cannot be touched. Same standing it had before this change.
