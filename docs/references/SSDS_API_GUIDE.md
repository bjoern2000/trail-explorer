# SSDS Tiler API — Point & Tile Data Guide

A practical guide to reading **super-resolution weather data** (and the standard
gFOD products) from the SSDS tiler at `qaapi.weather.com`. It covers the two ways
to pull values — the **point API** (`/multipoint`) and the **tile API** (`/data`) —
with copy-paste examples, the binary formats, and the real-world quirks you must
handle to get correct numbers.

Everything here is derived from working production code (the `superres-trail-hikes`,
`superres-from-zarr`, and `super-res-vs-gfod` apps). Where there's a known bug or
gotcha, it's called out explicitly.

---

## 1. The big picture: three ways to get the data

| Method | Endpoint | Returns | Use when |
|---|---|---|---|
| **Point API** | `POST …/multipoint` | Exact value at each lon/lat you ask for | You have a known set of locations (stations, a trail, summits) — tens to low-thousands of points |
| **Tile API** | `GET …/data?…z/x/y/lod` | A 256×256 raster (or point cloud) for a map tile | You're drawing a map / heatmap, or sampling many points that cluster into a few tiles |
| **Raw zarr on S3** | `s3://…/*.zarr` | The native model output, ungridded | You have AWS access and want the unstructured points with no tiler in the loop (out of scope here — see `superres-from-zarr`) |

This guide covers the first two (the HTTP tiler APIs).

**Rule of thumb:** point API for "what's the value *here* and *here*"; tile API for
"render the field over an area." Sampling N scattered points from tiles is worth it
only when they collapse into far fewer tiles than points.

---

## 2. Authentication & base URLs

All requests authenticate with an **`apiKey` query parameter**. No headers, no OAuth.

```
?apiKey=YOUR_KEY_HERE
```

There are **two distinct tilers**, with different base URLs and slightly different
rules:

| Tiler | Base URL | Backs |
|---|---|---|
| **Megapoints (adaptive)** | `https://qaapi.weather.com/v2/tiler/adaptive` | Super-resolution model (see note) |
| **Standard tiler** | `https://qaapi.weather.com/v2/tiler` | gFOD and other gridded products |

> ⚠️ **The `/multipoint` endpoint lives at `…/v2/tiler/multipoint`** — a *sibling* of
> `adaptive`, **not** under it. Don't POST to `…/adaptive/multipoint`.

> 📝 **Note on the "megapoints" / super-res model:** the `megapoints-conus` product is
> labeled as an XGB model in some places but is actually served from the **NN
> (neural-net) model** — the same model behind the `nn/*` data on S3. Point and tile
> reads of `megapoints-conus` agree with that S3 data (once you apply the rt
> correction in §7).

**Keep your key server-side.** Don't ship `apiKey` to a browser. The recommended
pattern (§9) is a thin proxy that injects the key, retries 503s, and fixes byte
order — every app referenced here does this.

---

## 3. Discovering runs and timesteps

Before you can request data you need a **reference time** (`rt`, the model run, epoch
ms) and a **valid time** (`t`, epoch ms = `rt` + lead). Two discovery endpoints:

### Megapoints: `/runs` and `/info`

```bash
# List available runs (newest LAST). Each is { "rt": <epoch ms>, "label": "YYYY-MM-DD HHZ" }.
curl "https://qaapi.weather.com/v2/tiler/adaptive/runs?apiKey=$KEY"

# Product metadata + the valid timesteps for a run (rt=0 means "latest").
curl "https://qaapi.weather.com/v2/tiler/adaptive/info?rt=0&apiKey=$KEY"
```

`/info` response shape:

```jsonc
{
  "rt": 1781143200000,                         // run reference time, epoch ms
  "products": {
    "megapoints-conus:temperature_2m": {
      "display_name": "...", "units": "...", "range": [lo, hi],
      "timesteps": [1781150400000, 1781154000000, ...]   // valid times, epoch ms
    }
  }
}
```

Pick a `t` from `timesteps`. **Remember the +2h `rt` bug in §7** — these times are
stamped ~2h late by the upstream tiler.

### gFOD (standard tiler): derive runs from `/info` — there is no `/runs`

The standard tiler **has no `/runs` endpoint** (hitting it returns an edge-level
"Access Denied"). It exposes a single reference time per product, carried inside
`/info`. Its `/info` shape is also different:

```bash
curl "https://qaapi.weather.com/v2/tiler/info?rt=0&products=53:Windspeedheightaboveground&apiKey=$KEY"
```

```jsonc
{
  "layers": {
    "53": {
      "Windspeedheightaboveground": {
        "dimensions": [
          { "rt": ["1781143200000"], "t": ["...","...", ...] }   // NOTE: strings; t is DESCENDING
        ]
      }
    }
  }
}
```

So for gFOD: read `layers[pid][variable].dimensions[0].rt[0]` for the run, and
`dimensions[0].t[]` for the timesteps (they come **descending** — sort ascending
yourself; the values are strings, parse to int).

---

## 4. Point API — `POST /multipoint`

Returns the value at each coordinate you supply, for the time(s) you supply. One
request can carry many points and many products.

### Request

```bash
curl -X POST 'https://qaapi.weather.com/v2/tiler/multipoint?products=megapoints-conus:temperature_2m,megapoints-conus:wind_speed&apiKey='$KEY \
  -H 'Content-Type: application/json' \
  -d '{
    "geometry": {
      "type": "MultiPoint",
      "coordinates": [
        [-122.3321, 47.6062],
        [-104.9903, 39.7392],
        [-84.3880, 33.7490]
      ]
    },
    "times": [
      "2026-06-11T14:00:00Z",
      "2026-06-11T14:00:00Z",
      "2026-06-11T14:00:00Z"
    ]
  }'
```

Key points:
- **`products`** is a comma-separated query param (`product:variable`), e.g.
  `megapoints-conus:temperature_2m,megapoints-conus:wind_gust`.
- **`coordinates`** are **`[lon, lat]`** (GeoJSON order — longitude first!).
- **`times`** is a parallel array, one ISO-8601 UTC time **per coordinate** (they can
  differ per point — that's how you sample a route "at the time you arrive").

### Response

```jsonc
{
  "points": [
    {
      "time": "2026-06-11T14:00:00Z",
      "data": {
        "megapoints-conus:temperature_2m": { "temperature_2m": [ 21.4 ] },
        "megapoints-conus:wind_speed":     { "wind_speed":     [ 4.7 ] }
      }
    },
    ...
  ]
}
```

Extract a value as `points[i].data["<product:var>"]["<var>"][0]`. It's an array
because a point could carry multiple times; with one time per point you take `[0]`.

A point can be `null` (or its value `null`/non-finite) when it's outside coverage —
always guard with a finite check.

### Units (megapoints / super-res, SI)

| Variable | Native unit | Convert to |
|---|---|---|
| `temperature_2m`, `dewpoint_2m` | °C | °F: `c * 9/5 + 32` |
| `wind_speed`, `wind_gust` | m/s | mph: `ms * 2.23694` |
| `u_wind_10m`, `v_wind_10m` | m/s | components; see wind-direction note below |

**Wind direction** from u/v (meteorological "from" bearing):

```
dir = (270 - atan2(v, u) * 180/π) mod 360
```

### Python example (one time for all points)

```python
import json, urllib.request

KEY = "..."
prods = "megapoints-conus:temperature_2m,megapoints-conus:wind_speed,megapoints-conus:wind_gust"
url = f"https://qaapi.weather.com/v2/tiler/multipoint?products={prods}&apiKey={KEY}"
coords = [[-105.5566, 40.2549], [-105.6150, 40.2400]]      # [lon, lat]
body = {"geometry": {"type": "MultiPoint", "coordinates": coords},
        "times": ["2026-06-11T14:00:00Z"] * len(coords)}

req = urllib.request.Request(url, data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
pts = json.load(urllib.request.urlopen(req))["points"]

def val(p, prod, var):
    d = p["data"].get(prod)
    return d.get(var, [None])[0] if d else None

for p in pts:
    c = val(p, "megapoints-conus:temperature_2m", "temperature_2m")
    w = val(p, "megapoints-conus:wind_speed", "wind_speed")
    print(round(c*9/5+32, 1), "°F", round(w*2.23694, 1), "mph")
```

> ⚠️ **gFOD and `/multipoint`:** some standard-tiler products return `null` from
> multipoint (e.g. the gust product `133:Windspeedgustsurface`). When a product
> doesn't answer on multipoint, read it from tiles instead (§5).

> ⚠️ **Concurrency:** the multipoint endpoint is happy with a few parallel requests,
> but don't hammer it. Batch many points into one request rather than firing one
> request per point.

---

## 5. Tile API — `GET /data`

Returns a **256×256 grid** for a map tile, or a compact **point cloud** (`format=sspt`).
Tiles are addressed by zoom/level + x/y in the standard Web-Mercator (XYZ) scheme.

### 5a. Request parameters

| Param | Meaning | Megapoints (adaptive) | Standard tiler (gFOD) |
|---|---|---|---|
| `products` | `product:variable` | required | required |
| `rt` | run reference time (epoch ms) | required | required |
| `t` | valid time (epoch ms) | required | required |
| `x`, `y` | tile column/row | required | required |
| `lod` | level of detail | required | required |
| `z` | zoom | **required** | ❌ **rejected — HTTP 400** |
| `format` | `sspt` for point cloud | supported | — |

> ⚠️ **The single biggest difference:** the **megapoints adaptive tiler needs `z`**,
> while the **standard (gFOD) tiler rejects `z` with a 400** — it is purely
> `lod`/`x`/`y`-addressed. Build the two URLs differently.

### 5b. Tile addressing math (lon/lat → x/y/pixel)

Standard slippy-map tiling. To find the tile and the pixel within it for a point:

```js
function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const xf = ((lon + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return {
    x: Math.floor(xf),
    y: Math.floor(yf),
    px: Math.min(255, Math.floor((xf - Math.floor(xf)) * 256)),  // pixel col in tile
    py: Math.min(255, Math.floor((yf - Math.floor(yf)) * 256)),  // pixel row in tile
  };
}
```

The value at that point is `grid[py * 256 + px]` (row-major).

### 5c. Default binary format: big-endian float32 grid

```bash
curl "https://qaapi.weather.com/v2/tiler/adaptive/data?products=megapoints-conus:temperature_2m&rt=$RT&t=$T&z=7&x=30&y=48&lod=2&apiKey=$KEY" \
  --output tile.bin
```

- The body is **exactly `256 × 256 × 4 = 262144` bytes** of `float32`. Any other size
  is an error condition.
- **Values are big-endian.** JavaScript `Float32Array` is little-endian, so you must
  **byte-swap** (or read with a `DataView` and `getFloat32(off, /*littleEndian=*/false)`).
- **HTTP 204 = empty tile** (no data, e.g. ocean / outside coverage) — handle it, it's
  not an error.

Byte-swap (in place, big-endian → little-endian) then read as Float32Array:

```js
const buf = await res.arrayBuffer();             // 262144 bytes
const u8 = new Uint8Array(buf);
for (let i = 0; i < u8.length; i += 4) {
  const b0 = u8[i], b1 = u8[i + 1];
  u8[i] = u8[i + 3]; u8[i + 1] = u8[i + 2]; u8[i + 2] = b1; u8[i + 3] = b0;
}
const grid = new Float32Array(buf);              // grid[py*256 + px]
```

(Values are in the same SI units as §4 — convert as needed.)

### 5d. Point-cloud format: `format=sspt` (megapoints only)

Add `&format=sspt`. This returns the **native model points** for the tile as a compact
binary — the origin **skips IDW rasterization**, which makes it ~100× smaller *and*
sidesteps the main 503 driver (§7). Best choice for rendering super-res honestly
(triangulate the points with a TIN) and for high-concurrency loads.

**Wire format:**

```
[0–23]  Header (24 bytes, uncompressed, little-endian)
[24–]   Body  (zstd-compressed, struct-of-arrays)

Header:
  [0–3]   magic "SSPT"        (uint32 LE = 0x54505353)
  [4–7]   n_points            uint32
  [8–11]  n_timesteps         uint32
  [12]    n_variables         uint8
  [13]    lod_level           uint8
  [14]    flags               uint8   (bit0 = is_aggregate, bit1 = has_elevation)
  [15]    reserved            uint8
  [16–23] rt                  int64   (epoch ms)

Body (after zstd decompress):
  lon[n_points]              float32
  lat[n_points]              float32
  elev[n_points]             float32   (only if has_elevation; meters)
  cell_ids[n_points]         uint64    (only if is_aggregate; H3 cells)
  per timestep:
    t_ms                     int64
    values[n_points]         float32   (× n_variables)
```

> ⚠️ **gzip wrapping:** qaapi's gzip middleware may wrap the SSPT payload in gzip.
> Check for the gzip magic (`0x1f 0x8b`) and gunzip first, *then* hand the raw
> `SSPT`-magic bytes to your zstd parser. (In Node use `zlib.gunzipSync`; in the
> browser the proxy should unwrap it before sending.)

A reference browser parser (`fzstd` for zstd) is in `super-res-vs-gfod/lib/sspt-parser.ts`.

### 5e. Sampling many points from few tiles

When you have scattered points, group them by tile, fetch each unique tile once, and
read pixels:

```js
// group points by (x,y) at the chosen zoom, fetch each tile once, read grid[py*256+px]
const tiles = new Map();
points.forEach((p, i) => {
  const { x, y, px, py } = tileOf(p.lon, p.lat, 5);
  const key = `${x},${y}`;
  (tiles.get(key) ?? tiles.set(key, { x, y, pts: [] }).get(key)).pts.push({ i, px, py });
});
for (const tile of tiles.values()) {
  const qs = new URLSearchParams({ product, rt, t, x: tile.x, y: tile.y, lod: '5' });
  const grid = await fetchGrid(`.../data?${qs}&apiKey=${KEY}`);   // byte-swapped Float32Array
  for (const { i, px, py } of tile.pts) out[i] = grid[py * 256 + px];
}
```

---

## 6. Product & variable catalog (observed)

**Megapoints / super-res** (`product:variable`, SI units):

| Product:variable | Quantity | Unit |
|---|---|---|
| `megapoints-conus:temperature_2m` | 2-m temperature | °C |
| `megapoints-conus:dewpoint_2m` | 2-m dewpoint | °C |
| `megapoints-conus:wind_speed` | 10-m wind speed | m/s |
| `megapoints-conus:wind_gust` | wind gust | m/s |
| `megapoints-conus:u_wind_10m` | 10-m U component | m/s |
| `megapoints-conus:v_wind_10m` | 10-m V component | m/s |

**gFOD (standard tiler)** — products are numeric ids `id:LongName`:

| Product:variable | Quantity | Unit | Notes |
|---|---|---|---|
| `53:Windspeedheightaboveground` | wind speed | m/s | works on tiles & multipoint |
| `133:Windspeedgustsurface` | wind gust | m/s | **multipoint returns null → use tiles** |

Always confirm the live list for a run via `/info`.

---

## 7. Quirks & gotchas (read this — these will bite you)

1. **The +2h reference-time bug (megapoints).** The adaptive tiler stamps `rt` ~2h
   **late** — it reports the data *publish* time, not the model *init* time. Runs
   surface as 08Z/14Z/20Z when the true inits are 06Z/12Z/18Z. Since valid-time =
   `rt + lead`, **every timestep is labeled 2h too late**. If you trust the labels
   blind you'll show (e.g.) the 15Z forecast as "17Z" — up to ~8–9°F off during the
   morning warm-up.
   - **Fix:** subtract 2h from `rt`/`t` for anything you *display*, and add it back
     when you *address the tiler*. Verified against the S3 NN data: a −2h shift matched
     to 0.08°F vs 6.35°F at 0h. Make it a config flag (`RT_OFFSET_HOURS`, default 2) so
     you can set it to 0 the day SSDS fixes it upstream.

2. **503 / 504 under concurrent cache-miss load.** The origin saturates beyond
   ~14 concurrent uncached tiles and returns transient **503** (Varnish "Backend fetch
   failed", often with `Retry-After: 5`) or **504**. These are recoverable.
   - **Fix:** retry 502/503/504 with backoff that **honors `Retry-After`**, cap
     concurrency (~8–10), and cache at the edge. Prefer `format=sspt` (no
     rasterization) to dodge the worst of it.

3. **Byte order.** Default tiles are **big-endian float32**; byte-swap for JS (§5c).

4. **SSPT may be gzip-wrapped.** Detect `0x1f 0x8b` and gunzip before zstd (§5d).

5. **`z` param:** required for megapoints, **rejected (400) by the standard tiler.**

6. **No `/runs` on the standard tiler;** derive the run from `/info`'s
   `dimensions[].rt`. Its `/info` timesteps are **strings, descending** — parse & sort.

7. **HTTP 204 = empty tile**, not an error. Many products return null/empty over
   ocean or outside CONUS.

8. **`[lon, lat]` order** in multipoint coordinates (GeoJSON), not `[lat, lon]`.

9. **Some gFOD products are null on multipoint** (e.g. gust) — fall back to tiles.

---

## 8. Quick decision guide

- **A handful of known locations, any product that answers on multipoint?**
  → `POST /multipoint`, batch them, one request. (§4)
- **Drawing a map / heatmap, or a product that's tile-only (gFOD gust)?**
  → `GET /data` tiles; byte-swap; sample `grid[py*256+px]`. (§5)
- **Rendering super-res faithfully or under heavy load?**
  → `GET /data&format=sspt`, triangulate the points. (§5d)
- **gFOD anything?** → standard tiler base, **no `z`**, runs from `/info`. (§3, §5a)

---

## 9. Recommended integration pattern (server-side proxy)

Don't call the tiler straight from a browser. Put a thin proxy in front of it (a Next.js
route handler, a small Flask/FastAPI service, a Vercel function). The proxy should:

1. **Inject `apiKey`** from a server-side env var (never expose the key).
2. **Apply the rt correction** — subtract the offset on the way out to the client,
   add it back on the way in to the tiler (§7.1).
3. **Retry transient 5xx** with `Retry-After`-aware backoff (§7.2).
4. **Byte-swap** big-endian tiles to little-endian for the browser (§5c); **gunzip**
   SSPT (§5d).
5. **Cache** (`Cache-Control: public, max-age=3600` for tiles; ~300s for `/info`,
   `/runs`, multipoint).
6. **Pass through 204** as 204.

Reference implementations to copy from:
- `super-res-vs-gfod/app/api/ssds/**` — full set of proxy routes for both tilers
  (`/runs`, `/info`, `/data`, `/multipoint`), retry helper (`lib/tileRetry.ts`),
  auth + rt-offset (`lib/megapoints-auth.ts`, `lib/gfod-auth.ts`), and the SSPT parser
  (`lib/sspt-parser.ts`).
- `superres-trail-hikes/api/resample.py` — a compact Python serverless example of the
  point path: `/adaptive/runs` + `/multipoint`, with the rt offset and unit conversions.

---

## 10. Minimal end-to-end checklist

- [ ] Get an `apiKey` (set as a server env var).
- [ ] Choose tiler: super-res → `…/v2/tiler/adaptive`; gFOD → `…/v2/tiler`.
- [ ] Discover `rt` + `timesteps` (megapoints `/runs`+`/info`; gFOD from `/info`).
- [ ] Apply the −2h rt correction for display; +2h when addressing megapoints.
- [ ] Point data → `POST /multipoint` with `[lon,lat]` coords + per-point `times`.
- [ ] Tile data → `GET /data` (megapoints needs `z`; gFOD must omit `z`); byte-swap.
- [ ] Convert units (°C→°F, m/s→mph); guard nulls/204s.
- [ ] Wrap it all in a proxy with key injection + 503 retry + caching.
