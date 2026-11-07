// Shared contracts (Phase 0, then frozen). Workstreams A/B/C/D all code against this.

export type SourceId = 'osm' | 'usfs' | 'nps' | 'blm' | 'usgs' | 'cotrex' | 'dec';

export type Units = 'imperial' | 'metric';

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
  units: Units;               // 'imperial' | 'metric'; persisted to localStorage
}
