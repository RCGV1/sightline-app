# Sightline deployment

## Static release (recommended cheapest launch)

The static release downloads global terrain and available building/canopy data directly into the visitor's browser, then runs A-to-B and viewshed analysis locally. It has no Python process, database, account, secret API key, or writable shared state. It is suitable for Cloudflare Pages, GitHub Pages at a custom root domain, Netlify, S3, or any ordinary static host.

Build from this directory:

```sh
.venv/bin/python build_static.py
```

The deployable directory is `dist/`. To include final canonical/Open Graph URLs:

```sh
.venv/bin/python build_static.py --base-url https://YOUR_DOMAIN
```

Preview it locally:

```sh
cd dist
python3 -m http.server 8080
```

Open `http://127.0.0.1:8080`. Upload the contents of `dist/` as the site's publish directory. For Cloudflare Pages, use `python build_static.py` as the build command and `dist` as the output directory. The `_headers` file supplies basic security and caching headers on hosts that support that format.

The included Bay Area scene makes the first load immediately useful. Outside that scene, **Run** fetches AWS Terrarium elevation, OpenFreeMap/OpenMapTiles building footprints and heights, and Meta/WRI CHMv2 canopy COGs from Source Cooperative. Named-place search uses Nominatim only when the visitor submits a search; coordinate entry, map placement, path/viewshed analysis, JSON export, and KML path export all work statically.

Global browser coverage is limited to Web Mercator latitudes (approximately 85.05°S–85.05°N). Area requests accept radii up to 250 km and automatically coarsen their grid to stay within browser memory limits. Very large requests may omit detailed building or canopy enrichment and say so in the result notes. Internet access and availability of the public upstream datasets are required for new locations. The Python edition remains preferable for USGS/LiDAR survey-grade local detail and LAS/LAZ import.

Choose a different starter scene with `--scene data/example.npz`. Keep it small enough for initial download time. The default `data/bay-area.npz` is a 3 m, 400 m-radius Bay Area scene.

## Full server edition

The full edition can download and enrich new US terrain. `Dockerfile`, `fly.toml`, and `render.yaml` remain available for a scale-to-zero Python deployment.

```sh
fly apps create sightline
fly deploy
fly certs create YOUR_DOMAIN
fly secrets set PUBLISHED=1 ALLOWED_HOSTS=YOUR_DOMAIN
```

Production disables `/api/fetch`, `/api/import`, and `/api/reset` because they replace process-global scene state. This makes the bundled-scene public server safe for multiple viewers. Set `ALLOW_DATA_MUTATIONS=1` only for a trusted single-user deployment. A public arbitrary-area service needs per-user scene isolation, quotas, persistent object storage, and abuse controls before enabling mutations.

The health check is `/api/health`; it remains available to loopback platform checks even when `ALLOWED_HOSTS` contains only the public domain.

## Release checklist

```sh
.venv/bin/python -m unittest -v
node --test test_static_engine.mjs test_global_data.mjs
node --check static/app.js
node --check static/engine.js
node --check static/global-data.js
.venv/bin/python build_static.py --base-url https://YOUR_DOMAIN
```

Serve `dist/` and verify Site A/B analysis plus a viewshed at a location outside the starter scene, JSON export, and KML export. Test once at a phone-size viewport. Preserve `LICENSE`, `THIRD_PARTY_NOTICES.md`, the in-app data attribution, and Leaflet's bundled license when publishing source.
