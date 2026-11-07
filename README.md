# Trail Explorer

Trail Explorer (TrailScope in the codebase) is a prototype for exploring US trail data and evaluating weather-aware outdoor planning. It combines a 3D terrain map, comparisons of open trail data sources, and product concepts for trail discovery and conditions along a route.

Built with TypeScript, Vite, MapLibre GL, and an Express API proxy.

## Run locally

Requires Node.js 20.12 or later and npm.

```sh
git clone https://github.com/bjoern2000/trail-explorer.git
cd trail-explorer
npm ci
```

Start the API server:

```sh
npm run dev:server
```

In a second terminal, start the frontend:

```sh
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The frontend proxies `/api` requests to the Express server on port `8081`. Open `/scope.html` to go directly to the Trail Explorer discovery prototype.

## Explore the prototype

| Page | Purpose |
| --- | --- |
| `index.html` | Open US trail data sources on a 3D terrain map |
| `matrix.html` | Source coverage, licensing, and available attributes |
| `benchmark.html` | AllTrails versus open-data coverage |
| `merge.html` | How trail segments are merged into routes |
| `data-model.html` | Trail entities, attributes, and provenance |
| `scope.html` | Trail discovery with conditions, ranking, and filters |
| `weather-on-route.html` | Conditions along a route at estimated arrival times |
| `digest.html` | Regional conditions across a week |
| `briefing.html` | Sample regional briefing |

The product concepts use simulated weather; the briefing includes authored sample content. Trail geometry and terrain attributes use committed derived datasets, while the exploration map fetches live data from public APIs. External map and data services require an internet connection.

## Optional Super Resolution API exploration

The separate `superres.html` page connects to the TWC SSDS API through the server. To configure it locally:

```sh
cp .env.example .env
```

Set `SSDS_API_KEY` in `.env` and restart the API server. Keep credentials server-side; `.env` is ignored by Git. See the [SSDS API guide](docs/references/SSDS_API_GUIDE.md) for configuration details.

To include this page and its navigation tab:

```sh
BUILD_SUPERRES=1 npm run dev
# Or include it in the production build:
BUILD_SUPERRES=1 npm run build
```

The production build excludes the page by default. The server's SSDS proxy routes are unauthenticated, so restrict access before deploying a server with an SSDS key.

## Build and serve

```sh
npm run build
npm start
```

The build runs TypeScript checks and writes the frontend to `dist/`. Express serves the built app and API routes at [http://localhost:8081](http://localhost:8081). Set `PORT` to change the server port. `npm run preview` previews only the frontend build; API requests still need an appropriate server setup.

## Repository layout

- `src/` — application code and styles.
- `server.js` — API proxy, caching, and static file server.
- `benchmark/`, `merge/`, `scope/`, `trail/` — data pipelines, fixtures, derived datasets, and verification scripts.
- `data-model.jsonc` — shared data model rendered by the data model page.
- `docs/` — plans, API documentation, and reference screenshots.

## Documentation

- [Implementation plan](docs/PLAN.md)
- [Benchmark plan](docs/BENCHMARK_PLAN.md)
- [Segment merge plan](docs/MERGE_PLAN.md)
- [Data model plan](docs/DATAMODEL_PLAN.md)
- [Discovery prototype plan](docs/SCOPE_PLAN.md)
- [Trail and weather-on-route plan](docs/TRAIL_PLAN.md)
- [SSDS API guide](docs/references/SSDS_API_GUIDE.md)
