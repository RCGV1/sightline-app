# Sightline agent guide

## Purpose

Sightline is a terrain-aware point-to-point radio/optical line-of-sight and viewshed tool. It combines measured elevation with mapped buildings and satellite-derived canopy. Buildings are hard obstructions. Trees block optical paths and add configurable attenuation to radio paths. Missing data must remain `unknown`; never present it as clear.

The app has two release modes:

- `dist/`: the no-server global release. It ships a starter scene and fetches new terrain/building/canopy data in each browser.
- `server.py`: the full local/server edition, which can discover and enrich new US terrain data. In production, shared data-changing endpoints are disabled unless `ALLOW_DATA_MUTATIONS=1` is deliberately set.

## Repository map

- `static/index.html`: application shell and controls.
- `static/app.js`: Leaflet UI state, endpoint placement, API/static fallback, rendering, exports, search, and fetch jobs.
- `static/engine.js`: browser port of the analysis math for static releases.
- `static/global-data.js`: keyless browser acquisition from AWS Terrain Tiles, OpenFreeMap buildings, and Source Cooperative CHMv2 canopy.
- `static/style.css`: responsive desktop/mobile presentation.
- `engine.py`: canonical numerical LOS, Fresnel, foliage, link-budget, viewshed, image, and scene-manifest logic.
- `server.py`: HTTP/API boundary, active-scene state, fetch jobs, security headers, and production capability controls.
- `eptfetch.py`, `autofetch.py`, `demfetch.py`: USGS point-cloud/tile/DEM acquisition fallbacks.
- `lidar.py`: classified LAS/LAZ rasterization and unit/CRS validation.
- `buildings.py`, `canopy.py`, `enrich.py`: OSM footprint, Meta/WRI canopy, and measured-height fusion.
- `build_static.py`: creates the deployable global static `dist/` directory with a selected `.npz` starter scene.
- `data/bay-area.npz`: small default Bay Area starter scene.
- `test_*.py`, `test_static_engine.mjs`, `test_global_data.mjs`: numerical, acquisition, HTTP, release-build, and browser-engine checks.
- `DEPLOY.md`: static and full-server release instructions.

## Invariants

- Coordinates crossing the API/UI are `[latitude, longitude]`; projected engine coordinates are `(x, y)` meters.
- Antenna/mast heights are above local ground or roof according to mount type.
- Corridor coverage is distance to the original A-B segment plus its buffer, not distance to the original endpoints.
- A viewshed may run on partial coverage; targets outside the raster are gray `unknown` pixels.
- Static analysis uses the browser engine only. The server edition keeps Python as the authoritative engine.
- Browser global data must degrade explicitly: missing terrain is unknown, unmeasured buildings are uncertain, and unavailable object sources are disclosed in analysis notes.
- Building uncertainty always affects analysis. Canopy uncertainty affects analysis only while **Include foliage** is enabled, so terrain-only comparisons remain possible.
- Global request geometry must use the short antimeridian path and respect the Web Mercator latitude boundary.
- Keep Python and JavaScript engine formulas/statuses aligned when changing either implementation.
- Browser viewshed is synchronous and capped at 100×100 requested samples to keep the page responsive.
- Static acquisition caches source-stage decoded terrain/building artifacts. Keep failed-promise eviction and bounded LRU behavior when changing those caches.
- A foliage-disabled acquisition intentionally omits canopy. Re-enabling foliage must refresh coverage before analysis.
- Viewshed acquisition may defer terrain/class overlay rendering; switching back to path mode must materialize those overlays on demand.
- Satellite tiles are visual context and are not analysis height data.
- Do not enable public shared-scene mutations without session isolation, storage quotas, and abuse controls.

## Verification

From this directory:

```sh
.venv/bin/python -m unittest -v
node --test test_static_engine.mjs test_global_data.mjs
node --check static/app.js
node --check static/engine.js
node --check static/global-data.js
.venv/bin/python build_static.py
```

Then serve `dist/` with a plain static file server and test A-B movement, path analysis, viewshed, JSON export, and KML export. Also run `server.py` and verify the same core flow against the Python engine.

## Release notes

Do not commit `.venv`, caches, user imports, or fetched working scenes. Preserve attribution in the UI and `THIRD_PARTY_NOTICES.md`. Keep public browser sources keyless and version-pin CDN decoding libraries.
