// SOURCES: all endpoints, fields, and dossier content (Phase 0, then frozen).
// Verified constants from PLAN.md §5 — do not re-derive. Endpoints verified live 2026-07-08.

import type { SourceId, TrailSourceDef } from './types';

export const SOURCES: Record<SourceId, TrailSourceDef> = {
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    color: '#d93a52',
    kind: 'overpass',
    // Client always talks to the server proxy; upstream + mirror fallback live in server.js.
    queryUrls: ['/api/overpass'],
    nameField: 'name',
    idField: '@id',
    minZoom: 11,
    maxRecordCount: 6000,
    licenseChip: 'ODbL',
    enabledByDefault: true,
    searchable: true,
    dossier: {
      lede: "OpenStreetMap's crowdsourced path network. The most complete trail geometry in the US, including informal and social trails no agency maps.",
      scope: 'Nationwide (global). Best overall trail coverage; ~60,000 path ways in Colorado alone.',
      license: 'ODbL 1.0: attribution and share-alike obligations attach to derived trail data.',
      access: 'Overpass API, live query (proxied server-side). Daily bulk extracts via Geofabrik / planet.osm.',
      updated: 'Continuous; edits appear within minutes.',
      attributes: 'Geometry and names strong. Surface tagged on ~56% of paths; difficulty (sac_scale / mtb:scale) on only 3–4% even in Colorado.',
      strengths: [
        'Best geometry backbone; unmatched coverage of informal and social trails',
        'Live and continuously edited',
      ],
      limitations: [
        'Attribute completeness is low and uneven — do not rely on its tags',
        'Share-alike license complicates derived commercial data',
      ],
      endpointDisplay: 'overpass-api.de/api/interpreter (via /api/overpass proxy)',
      links: [
        { label: 'License & attribution', url: 'https://www.openstreetmap.org/copyright' },
        { label: 'US trails tagging', url: 'https://wiki.openstreetmap.org/wiki/United_States/Trails' },
        { label: 'Overpass API', url: 'https://wiki.openstreetmap.org/wiki/Overpass_API' },
      ],
    },
  },

  usfs: {
    id: 'usfs',
    label: 'USFS · NFS Trails',
    color: '#1f8f55',
    kind: 'arcgis',
    queryUrls: [
      'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query',
    ],
    nameField: 'trail_name',
    idField: 'objectid',
    minZoom: 9,
    maxRecordCount: 2000,
    licenseChip: 'PUB DOM',
    enabledByDefault: true,
    searchable: true,
    dossier: {
      lede: "The Forest Service's authoritative trail inventory, published from its Enterprise Data Warehouse. The attribute-richest federal source.",
      scope: 'USFS-managed lands, CONUS + Alaska. 86,073 segments, ~160,000 miles.',
      license: 'US Government work, public domain. No use restrictions; courtesy attribution to USDA Forest Service.',
      access: 'ArcGIS REST query API, GeoJSON, no key. 2,000 features per request. Bulk download as FileGDB / Shapefile.',
      updated: 'Rolling, forest by forest. National extract refreshed 2026-06-28.',
      attributes: 'Federal Trail Data Standards: trail class TC1–5, surface, typical grade, tread width, and per-use management status incl. bicycle and e-bike classes 1–3.',
      strengths: [
        'Authoritative geometry and management attributes',
        'Cleanest license of any source',
      ],
      limitations: [
        'Forest Service land only; attribute depth varies by forest',
        'No live conditions or closures in this layer',
      ],
      endpointDisplay: 'apps.fs.usda.gov/arcx/rest/…/EDW_TrailNFSPublish_01/MapServer/0',
      links: [
        { label: 'EDW datasets & downloads', url: 'https://data.fs.usda.gov/geodata/edw/datasets.php' },
        { label: 'API endpoint', url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer' },
        { label: 'USFS trails program', url: 'https://www.fs.usda.gov/managing-land/trails' },
      ],
    },
  },

  nps: {
    id: 'nps',
    label: 'NPS · Park Trails',
    color: '#7757e0',
    kind: 'arcgis',
    queryUrls: [
      'https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0/query',
    ],
    nameField: 'TRLNAME',
    idField: 'OBJECTID',
    minZoom: 9,
    maxRecordCount: 2000,
    licenseChip: 'PUB DOM',
    enabledByDefault: true,
    searchable: true,
    dossier: {
      lede: 'National Park Service public trails. Essential inside park boundaries, but the schema is thin and completeness varies park to park.',
      scope: 'National parks and NPS units. 31,358 segments; completeness varies by park.',
      license: 'US Government work, public domain. Courtesy attribution to the National Park Service.',
      access: 'ArcGIS REST query API, GeoJSON, no key. 2,000 features per request. NPS open data portal.',
      updated: 'Varies by park; no single national refresh cadence.',
      attributes: 'Name, trail status, surface, allowed uses, seasonal flag, maintainer, unit name. Closures publish via a separate NPS API, not this layer.',
      strengths: [
        'Only authoritative source inside many park boundaries',
        'Public domain license',
      ],
      limitations: [
        'Thin attribute schema',
        'Coverage and freshness vary park to park',
      ],
      endpointDisplay: 'mapservices.nps.gov/arcgis/rest/…/NPS_Public_Trails_Geographic/FeatureServer/0',
      links: [
        { label: 'NPS open data portal', url: 'https://public-nps.opendata.arcgis.com' },
        { label: 'API endpoint', url: 'https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer' },
      ],
    },
  },

  blm: {
    id: 'blm',
    label: 'BLM · GTLF Trails',
    color: '#d07e00',
    kind: 'arcgis',
    // Layers 4 (non-motorized) and 5 (non-mechanized); merged in the adapter.
    queryUrls: [
      'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/4/query',
      'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer/5/query',
    ],
    nameField: 'ROUTE_PRMRY_NM',
    idField: 'OBJECTID',
    minZoom: 9,
    maxRecordCount: 2000,
    licenseChip: 'PUB DOM',
    enabledByDefault: true,
    searchable: true,
    dossier: {
      lede: 'BLM Ground Transportation Linear Features. Strong where travel-management planning is complete (e.g. Moab), patchy elsewhere.',
      scope: 'BLM-managed lands. 2,830 non-motorized segments; strongest in planned travel-management areas.',
      license: 'US Government work, public domain. Courtesy attribution to the Bureau of Land Management.',
      access: 'ArcGIS REST query API, GeoJSON, no key. Two layers merged (non-motorized, non-mechanized). 2,000 features per request.',
      updated: 'Varies by field office; tied to travel-management plan cycles.',
      attributes: 'Planned and allowed transport modes, observed surface, OHV route designation, seasonal restriction code, admin state. No trail class or grade.',
      strengths: [
        'Matters for desert MTB where BLM is the land manager',
        'Public domain license',
      ],
      limitations: [
        'Patchy; only complete where travel planning is done',
        'No trail class, grade, or difficulty',
      ],
      endpointDisplay: 'gis.blm.gov/arcgis/rest/…/BLM_Natl_GTLF_Public_Display/MapServer/{4,5}',
      links: [
        { label: 'BLM geospatial hub', url: 'https://gbp-blm-egis.hub.arcgis.com' },
        { label: 'API endpoint', url: 'https://gis.blm.gov/arcgis/rest/services/transportation/BLM_Natl_GTLF_Public_Display/MapServer' },
      ],
    },
  },

  usgs: {
    id: 'usgs',
    label: 'USGS · Natl Digital Trails',
    color: '#2277cc',
    kind: 'arcgis',
    queryUrls: [
      'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37/query',
    ],
    nameField: 'name',
    idField: 'objectid',
    minZoom: 10,
    maxRecordCount: 2000,
    licenseChip: 'PUB DOM',
    enabledByDefault: true,
    searchable: true,
    dossier: {
      lede: 'USGS National Digital Trails: a national aggregate stitching federal, state, and local public-domain trails into one layer.',
      scope: 'National aggregate of federal + state + local public-domain trails. 591,392 segments.',
      license: 'US Government work, public domain. Courtesy attribution to USGS / The National Map.',
      access: 'ArcGIS REST query API, GeoJSON, no key. 2,000 features per request. Bulk download by state.',
      updated: 'Periodic national refresh; refreshed July 2026. Lags upstream sources.',
      attributes: 'FTDS schema plus maintainer (23 agencies), source lineage (sourceoriginator / sourcedatasetid), and per-use flags incl. e-bike.',
      strengths: [
        'Best single national layer; one schema across agencies',
        'Source-lineage fields identify the upstream agency per feature',
      ],
      limitations: [
        'Lags upstream sources; not the freshest copy',
        'Dense areas hit the 2,000-feature cap quickly',
      ],
      endpointDisplay: 'carto.nationalmap.gov/arcgis/rest/…/transportation/MapServer/37',
      links: [
        { label: 'National Digital Trails program', url: 'https://www.usgs.gov/national-digital-trails' },
        { label: 'Bulk download', url: 'https://apps.nationalmap.gov/downloader' },
        { label: 'API endpoint', url: 'https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer' },
      ],
    },
  },

  cotrex: {
    id: 'cotrex',
    label: 'COTREX (CO only)',
    color: '#0e9c97',
    kind: 'arcgis',
    queryUrls: [
      'https://services3.arcgis.com/0jWpHMuhmHsukKE3/arcgis/rest/services/CPW_Trails_08222024/FeatureServer/2/query',
    ],
    nameField: 'name',
    idField: 'FID',
    minZoom: 9,
    maxRecordCount: 2000,
    licenseChip: 'STATE',
    enabledByDefault: false,
    searchable: true,
    dossier: {
      lede: 'Colorado Trail Explorer: every trail manager in the state merged into one layer. A model for what a state aggregate can be.',
      scope: 'Colorado only. All managers merged (federal + county + city). 96,897 segments (~40,000 miles).',
      license: 'Colorado state open data. Verify redistribution terms before commercial use.',
      access: 'ArcGIS REST query API, GeoJSON, no key. 2,000 features per request. Full export available.',
      updated: 'Snapshot republishes periodically; the service URL embeds a snapshot date and changes when CPW republishes.',
      attributes: 'Per-activity designation: hike, bike, horse, ski, snowshoe, snowmobile, dogs; oneway; access; manager; length; min / max elevation; url.',
      strengths: [
        'Model state aggregate: every manager, per-activity designations',
        'Winter-activity flags (ski, snowshoe, snowmobile)',
      ],
      limitations: [
        'One state only',
        'Service URL churns on republish; may need re-resolving via geodata.colorado.gov',
      ],
      endpointDisplay: 'services3.arcgis.com/…/CPW_Trails_08222024/FeatureServer/2',
      links: [
        { label: 'COTREX app', url: 'https://trails.colorado.gov' },
        { label: 'Dataset & license', url: 'https://geodata.colorado.gov/datasets/CPW::cotrex-trails' },
        { label: 'API endpoint', url: 'https://services3.arcgis.com/0jWpHMuhmHsukKE3/arcgis/rest/services/CPW_Trails_08222024/FeatureServer' },
      ],
    },
  },

  // Added 2026-07-21 after the Adirondack benchmark showed the six federal-first
  // sources return zero features on NY state land. Second state aggregate in the
  // registry, alongside COTREX; both are scoped to one state by design.
  dec: {
    id: 'dec',
    label: 'NYS DEC (NY only)',
    color: '#b5417a',
    kind: 'arcgis',
    // Layer 1 = Hiking Trails. The service also carries DEC Road (0), XC Ski (2),
    // Horse (3), Mountain Bike (4), Snowmobile (5) and MAPPWD Route (6) as separate
    // layers; only hiking is queried so the source stays comparable to the other
    // trail networks rather than double-counting a parallel ski network.
    queryUrls: [
      'https://services6.arcgis.com/DZHaqZm9cxOD4CWM/arcgis/rest/services/DEC_Trails/FeatureServer/1/query',
    ],
    nameField: 'NAME',
    idField: 'OBJECTID',
    minZoom: 9,
    maxRecordCount: 2000,
    licenseChip: 'STATE',
    enabledByDefault: false,
    searchable: true,
    dossier: {
      lede: "New York State DEC's trail network for the Forest Preserve and state lands. The layer that makes the Adirondacks and Catskills visible at all: no federal source covers them.",
      scope: 'New York only. DEC-managed state land (Adirondack and Catskill Forest Preserve, State Forests, WMAs). Hiking trails queried as one layer; ski, horse, bike and snowmobile networks are published separately.',
      license: 'New York State open data. Verify redistribution terms before commercial use.',
      access: 'ArcGIS REST query API, GeoJSON, no key. 2,000 features per request.',
      updated: 'Periodic republish; features carry an UPDATED date field.',
      attributes: 'Per-use permission flags (FOOT, BIKE, HORSE, XC, SNOWMB, ATV, MOTORV); ACCESSIBLE; managing UNIT and FACILITY; MARKER color; MILES. No surface or difficulty field.',
      strengths: [
        'Only source covering NY state land, where the federal layers are empty',
        'Per-use permission flags and managing unit are well populated',
      ],
      limitations: [
        'One state only',
        'No surface or difficulty attributes; activity networks split across layers',
      ],
      endpointDisplay: 'services6.arcgis.com/…/DEC_Trails/FeatureServer/1',
      links: [
        { label: 'DEC lands & trails', url: 'https://dec.ny.gov/places-to-go' },
        { label: 'Dataset', url: 'https://data.gis.ny.gov/datasets/nysdec::dec-trails' },
        { label: 'API endpoint', url: 'https://services6.arcgis.com/DZHaqZm9cxOD4CWM/arcgis/rest/services/DEC_Trails/FeatureServer' },
      ],
    },
  },
};

export const SOURCE_IDS: SourceId[] = ['osm', 'usfs', 'nps', 'blm', 'usgs', 'cotrex', 'dec'];

// ---- Source matrix content (matrix.html) --------------------------------
// The 6 open rows plus the 2 restricted benchmark rows. Content matches the
// mockup's matrix table exactly (verified 2026-07-08).

export interface MatrixProductFit {
  fit?: 'a' | 'b' | 'c'; // color emphasis on the lead phrase (a=green, b=amber, c=warn)
  lead?: string;
  rest: string;
}

export interface MatrixRow {
  label: string;
  color: string;
  chipNot?: string; // "NOT LICENSABLE BY DEFAULT" / "CLOSED" for benchmark rows
  coverage: string;
  volume: string;
  attributes: string;
  conditions: string;
  conditionsDim: boolean;
  license: string;
  access: string;
  updated: string;
  productFit: MatrixProductFit;
  bench: boolean;
}

// Open, product-usable sources. Labels here follow the matrix mockup (BLM/COTREX
// abbreviated vs the sidebar); colors come from SOURCES for a single source of truth.
export const MATRIX_ROWS: MatrixRow[] = [
  {
    label: 'OpenStreetMap',
    color: SOURCES.osm.color,
    coverage: 'Nationwide, best overall trail coverage incl. informal & social trails',
    volume: '~60k path ways in CO alone',
    attributes: 'Geometry + names strong. Surface 56%, difficulty (sac_scale / mtb:scale) only 3–4% even in CO',
    conditions: 'None',
    conditionsDim: true,
    license: 'ODbL: attribution + share-alike on derived trail data',
    access: 'Overpass API live · daily bulk extracts',
    updated: 'Continuous',
    productFit: { fit: 'a', lead: 'Geometry backbone.', rest: "Don't rely on its attributes" },
    bench: false,
  },
  {
    label: 'USFS · NFS Trails',
    color: SOURCES.usfs.color,
    coverage: 'Forest Service lands, CONUS + AK (~160k mi)',
    volume: '86,073 segments',
    attributes: 'Richest official schema: trail class, surface, grade, width, per-use mgmt incl. bicycle + e-bike',
    conditions: 'None in layer',
    conditionsDim: true,
    license: 'Public domain',
    access: 'ArcGIS REST live · bulk GDB/SHP',
    updated: 'Extract 06-28',
    productFit: { fit: 'a', lead: 'Authoritative', rest: 'on NFS land; tiers vary by forest' },
    bench: false,
  },
  {
    label: 'NPS · Park Trails',
    color: SOURCES.nps.color,
    coverage: 'National parks; completeness varies park to park',
    volume: '31,358 segments',
    attributes: 'Thin: name, allowed uses, surface, maintainer',
    conditions: 'Closures via separate NPS API',
    conditionsDim: true,
    license: 'Public domain',
    access: 'ArcGIS REST live · open data portal',
    updated: 'Varies by park',
    productFit: { fit: 'b', lead: 'Needed for parks;', rest: 'attributes thin' },
    bench: false,
  },
  {
    label: 'BLM · GTLF',
    color: SOURCES.blm.color,
    coverage: 'BLM lands; strongest where travel planning is done (e.g. Moab)',
    volume: '2,830 non-motorized segments',
    attributes: 'Allowed transport modes, surface, OHV designation. No class/grade',
    conditions: 'None',
    conditionsDim: true,
    license: 'Public domain',
    access: 'ArcGIS REST live',
    updated: 'Varies by field office',
    productFit: { fit: 'c', lead: 'Patchy;', rest: 'matters for desert MTB' },
    bench: false,
  },
  {
    label: 'USGS · Natl Digital Trails',
    color: SOURCES.usgs.color,
    coverage: 'National aggregate of federal + state + local public-domain trails',
    volume: '591,392 segments',
    attributes: 'FTDS schema + maintainer (23 agencies) + source lineage + per-use flags incl. e-bike',
    conditions: 'None',
    conditionsDim: true,
    license: 'Public domain',
    access: 'ArcGIS REST live · bulk by state',
    updated: 'Refreshed Jul 2026',
    productFit: { fit: 'a', lead: 'Best single national layer;', rest: 'lags upstream' },
    bench: false,
  },
  {
    label: 'COTREX',
    color: SOURCES.cotrex.color,
    coverage: 'Colorado only: all managers merged (fed + county + city)',
    volume: '96,897 segments (~40k mi)',
    attributes: 'Per-activity designation: hike, bike, horse, ski, snowshoe, moto; oneway; elevation',
    conditions: 'Seasonal closures partial',
    conditionsDim: true,
    license: 'State open data (verify redistribution)',
    access: 'ArcGIS REST live · full export',
    updated: 'Snapshot republishes',
    productFit: { fit: 'a', lead: 'Model state aggregate;', rest: 'one state' },
    bench: false,
  },
  {
    label: 'NYS DEC',
    color: SOURCES.dec.color,
    coverage: 'New York only: DEC state land (Adirondack & Catskill Forest Preserve, State Forests, WMAs)',
    volume: '5,283 hiking segments (~4,308 mi)',
    attributes: 'Per-use flags: foot, bike, horse, ski, snowmobile, ATV; accessible; managing unit; marker color. No surface or difficulty',
    conditions: 'None',
    conditionsDim: true,
    license: 'State open data (verify redistribution)',
    access: 'ArcGIS REST live',
    updated: 'Periodic republish',
    productFit: { fit: 'b', lead: 'Only source on NY state land;', rest: 'one state, thin attributes' },
    bench: false,
  },
];

// Restricted sources: benchmark only, not in SourceId. Static.
export const BENCHMARKS: MatrixRow[] = [
  {
    label: 'Trailforks',
    color: '#888888',
    chipNot: 'NOT LICENSABLE BY DEFAULT',
    coverage: 'Global MTB, moderated crowd data',
    volume: '~361k trails',
    attributes: 'Best MTB depth: difficulty, direction, features, popularity',
    conditions: 'Live status + condition reports (the differentiator)',
    conditionsDim: false,
    license: 'API gated; share-alike, non-commercial default; bespoke deal via Outside',
    access: 'JSON API on approval',
    updated: 'Continuous',
    productFit: { rest: 'Quality bar for MTB + conditions' },
    bench: true,
  },
  {
    label: 'AllTrails',
    color: '#888888',
    chipNot: 'CLOSED',
    coverage: 'Largest consumer route catalog, US-strong',
    volume: '~450k+ curated routes',
    attributes: 'Curated routes, difficulty, reviews; geometry substrate is largely OSM',
    conditions: 'Crowd signal via recent reviews',
    conditionsDim: false,
    license: 'No API, no licensing program',
    access: 'None',
    updated: 'Continuous',
    productFit: { rest: 'Consumer UX bar; proves OSM base is viable' },
    bench: true,
  },
];
