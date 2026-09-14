# Sightline

Local point-to-point visibility and sampled viewshed analysis using automatically fetched terrain/surface measurements, building footprints, and satellite-derived tree heights. Radio mode treats building/terrain intersections as blocked and tree intersections as attenuating. Optical mode treats tree intersections as blocked too.

## Start

Double-click **Start.command**, keep its terminal open, and open **http://127.0.0.1:18765**. The prepared Python environment is included on this machine. If it needs recreating, the launcher installs requirements into `.venv`; Use Python 3.12 to recreate the prepared environment. Nothing is uploaded to an analysis service.

## Normal workflow

1. **Search or navigate**: Use the omni-search bar at the top to enter coordinates in any format (decimal `37.7749, -122.4194`, DMS `37°46'29.6"N 122°25'09.8"W`, Google Maps / OSM URLs, or place names/addresses) to instantly navigate there.
2. Enter coordinates under **Load an area**, pan the satellite map and choose **Use map center**, or click **Fit to Sites A & B** to automatically encompass your placed sites. Dragging endpoints preserves them across new area loads.
3. Choose the download radius and raster resolution, then **Fetch area data**. The app employs a three-tier automatic acquisition pipeline:
   - **Tier 1 (Streaming LiDAR)**: Streams official USGS 3DEP EPT point clouds with adaptive multi-resolution depth sampling, supporting large spans across South Bay, East Bay, and regional links without hitting node budget ceilings.
   - **Tier 2 (Survey Tiles)**: Downloads original USGS LPC survey tiles as a secondary source.
   - **Tier 3 (Universal DEM & Overlays)**: In regions without LiDAR coverage (or for broad regional screening), the app automatically constructs ground terrain from USGS 3DEP / AWS Terrarium digital elevation models and fuses them with OpenStreetMap building footprints and Meta/WRI 1m satellite tree canopy.
   The on-screen progress reports discovery, download, and processing; successful data remains cached locally.
4. Place A and B, or enter their coordinates. Select mount type (**Ground AGL** or **Rooftop**). When Rooftop is selected, the mast height is automatically added on top of the mapped building roof elevation.
5. In Radio mode, choose a hardware preset (**5.8 GHz Dish**, **5.2 GHz Panel**, **2.4 GHz Long-Range**, **6 GHz Wi-Fi 6E/7**, or **915 MHz ISM**) or customize transmit power, antenna gains, cable losses, channel bandwidth, and receiver sensitivity.
6. **Run path** displays the simplified obstruction status banner, 4 essential metrics, and interactive elevation profile. If blocked or constrained by Fresnel encroachment, a one-click **Auto-raise masts** button sets the required mast elevation and re-evaluates the link. Hover or drag along the elevation profile to scrub: a synchronized glowing dot traces the path on the map while a floating HUD displays exact ground, building, tree, ray, and clearance elevations at each point. Detailed RF link budget and field alignment tables are tucked into an expandable drawer. **Viewshed** evaluates sampled coverage across the area.
7. **Export KML** downloads a Google Earth overlay including 3D coordinates, field alignment, and link budget metrics. **Export JSON** retains complete numerical profile data and parameter provenance.

The satellite layer is Esri World Imagery, displayed for visual reference. The local color view is a raster of colorized LiDAR returns. The classification overlay includes both source classifications and inferred vegetation/building labels; gray indicates missing terrain or other object classes.

## How it works

LAS ground class 2 is rasterized; class 6 supplies building roof elevations; vegetation classes 3, 4, and 5 supply canopy elevations. Each cell stores maximum elevations. Ground underneath objects is filled from the nearest ground cell within 30 m, only where retained returns exist. Unobserved cells remain unknown. Noise and withheld returns are excluded. Native horizontal coordinates are reprojected to metric UTM; vertical units are explicitly checked and converted. Vertical datums are retained, not silently geoid-corrected.

For automatic area loads, OSM footprints identify buildings even when the survey did not classify roofs. Each mapped footprint receives the maximum elevated LiDAR surface return within it. This can overestimate a roof because of trees or rooftop equipment; a mapped structure without usable height is marked unknown. Meta/WRI CHMv2 supplies canopy heights estimated from high-resolution satellite images. Inside predicted tree areas (canopy >=2 m), unclassified surface returns are treated as vegetation and can raise the estimated canopy top. Known non-vegetation source classes remain unknown obstructions. These inferred labels can be wrong, and datasets can represent different years. Source URLs and methods are retained in the scene metadata. This is a model assembled from evidence, not a fresh survey of every tree.

The direct ray traverses every raster cell with a positive-length intersection. It includes effective-Earth curvature (`d1*d2/(2*k*R)`), and checks the minimum ray clearance inside each crossed cell. Radio mode separately reports sampled **60% first Fresnel-zone clearance** against terrain/buildings. Radio paths with inadequate sampled Fresnel clearance appear purple, **Fresnel constrained**, while direct LOS is reported separately. Unclassified objects within that zone produce **unknown**. Green never means a radio connection is guaranteed.

Vegetation is a conservative ground-to-canopy envelope, not an individual-branch mesh. The model integrates path length inside that envelope and multiplies it by the chosen **dB/m** coefficient. The default scenario values are illustrative scenario values, not a measured value for your location or an ITU prediction.

### Advanced Wi-Fi PTP & Radio Deployment Planning

Sightline includes a defensible, engineering-grade radio link budget model:
- **Free-Space Path Loss (FSPL)**: Modeled from 3D slant range and exact RF carrier frequency.
- **Transmitter EIRP**: Computed from transmit power, transmitter cable losses, and antenna gain ($P_{tx} - L_{c1} + G_a$).
- **Received Signal Level (RSL)**: Derived from EIRP, total path loss (FSPL + integrated foliage loss), receiver cable losses, and receiver antenna gain ($EIRP - L_{path} - L_{c2} + G_b$).
- **Thermal Noise Floor**: Calculated from channel bandwidth and receiver noise figure ($-174\text{ dBm/Hz} + 10\log_{10}(B) + NF$).
- **Link / Fade Margin**: Evaluated as $RSL - S_{rx}$, with clear status flags:
  - **Viable Link**: Clear line-of-sight and robust fade margin ($\ge 10\text{ dB}$).
  - **Marginal**: Fade margin between $0$ and $10\text{ dB}$, or positive margin degraded by foliage / Fresnel constriction.
  - **Link Deficit**: Received signal level below receiver threshold ($RSL < S_{rx}$).
  - **Obstructed**: Direct ray physically blocked by terrain or building structures.
- **Field Alignment**: Provides forward/reverse geodetic azimuths (True North compass heading) and vertical tilt angles accounting for Earth curvature.
- **Pinch Obstruction Analysis**: Identifies the single worst obstruction along the path and calculates the required mast height increase at Site A, Site B, or both to achieve line-of-sight and clear the 60% Fresnel zone.
- **Rooftop Mounting**: Supports specifying antennas mounted on rooftops; the model identifies if the coordinate falls on a building footprint and adds mast height to the measured rooftop elevation.

Modeling limits: Complex diffraction over multiple knife edges, multipath fading, rain attenuation, and atmospheric absorption are not fabricated.

Viewshed pixels represent individual target samples. Intermediate locations inside each pixel are not checked. Targets outside the available dataset are gray. There is no Google Earth-style 10 km analysis cutoff; local memory, available coverage, and the requested sample count limit each job. Increase sample spacing for a larger radius. The streaming provider also scales its point sampling with the requested raster resolution; sampled maxima can miss small obstacles. Use fine resolution for a local tree/building decision and coarse resolution for regional screening. A 12 km-wide, 50 m-resolution San Francisco scene was fetched in the live test. The local projection/effective-Earth model warrants independent validation for long paths.

## Data quality and coverage

A satellite photo cannot by itself establish an accurate tree or roof height. This app automatically combines public surface measurements with satellite-based canopy estimates and mapped building footprints. Some USGS surveys classify only ground and unclassified returns: missing building/tree labels are reported, not inferred as absent objects. Remaining unmapped objects or missing height coverage stay unknown. Switching the reference basemap does not change the analysis. Survey dates can be older than the displayed imagery.

Automatic downloads have explicit tile-count and byte limits to avoid an unexpected huge download. A resource-limit error asks for a smaller area; it does not substitute terrain-only analysis. Downloaded survey tiles and footprint responses are cached in `data/cache`; streaming point nodes are in `data/ept-cache`. The active scene survives a restart. Satellite canopy is read by spatial windows; the scene stores its resulting heights. Optional local LAS/LAZ imports remain available under Advanced. For files without complete CRS/vertical-unit metadata, use the CLI:

```sh
.venv/bin/python lidar.py input.laz data/custom.npz --resolution 3 --crs-override EPSG:32610 --vertical-unit m
.venv/bin/python server.py --scene data/custom.npz --port 8766
```

Only pass CRS and units verified from the survey metadata. KML absolute heights use the input vertical datum; Google Earth’s ground surface/datum may differ. The KML export is a result overlay, not an export of Google’s 3D scene. During verification, Google Earth Pro accepted the Open-file action but its UI inspection then timed out, so visual placement in that app was not confirmed. KML structure and coordinates were checked independently.

## Sources

- [Meta/WRI CHMv2 satellite canopy heights](https://registry.opendata.aws/dataforgood-fb-forestsv2/): CC BY 4.0, modeled canopy meters above ground.
- [OpenStreetMap attribution and ODbL](https://www.openstreetmap.org/copyright); [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL).
- [USGS streaming point-cloud archive](https://registry.opendata.aws/usgs-lidar/): US Government public domain.
- [USGS LiDAR overview](https://www.usgs.gov/faqs/what-lidar-data-and-where-can-i-download-it)
- [USGS TNM access API](https://tnmaccess.nationalmap.gov/api/v1/)
- [USGS point-cloud classifications](https://www.usgs.gov/centers/community-for-data-integration-cdi/science/3deppcc-automated-dl-based-point-cloud)
- [Autzen sample and class definitions](https://github.com/PDAL/data/tree/main/autzen): Watershed Sciences, PDAL, Hobu; CC BY 4.0. Derived raster bundled with this app. 2010 LiDAR, 2009 NAIP colors, classification edits by Max Sampson in 2021. [Licensing announcement](https://lists.osgeo.org/pipermail/pdal/2021-August/002439.html).
- [Google Earth Viewshed documentation](https://support.google.com/earth/answer/3064261?hl=en)
- [Google Photorealistic 3D Tiles](https://developers.google.com/maps/documentation/tile/overview): a separate API, not a height-export facility in Google Earth Pro.
- [ITU-R P.833 vegetation attenuation](https://www.itu.int/rec/R-REC-P.833/en): background for more detailed, site-specific radio models. This app does not implement that recommendation.

## Deploy

The cheapest release is a global static site. It includes a small Bay Area starter scene, then downloads terrain, mapped buildings, and satellite canopy directly into each visitor's browser for new locations:

```sh
.venv/bin/python build_static.py --base-url https://YOUR_DOMAIN
```

Upload `dist/` to Cloudflare Pages, Netlify, GitHub Pages at a root/custom domain, S3, or another static host. Path analysis, viewshed, named-place search, and global data acquisition run in the browser without shared server state. Browser acquisition uses AWS Terrain Tiles, OpenFreeMap/OpenMapTiles buildings, and Meta/WRI CHMv2 canopy through Source Cooperative. LAS/LAZ import remains part of the local Python edition. See `DEPLOY.md` for source limits and both modes.

The static release caches downloaded responses plus decoded terrain and building tiles, so repeated or slightly shifted requests reuse prior work. Terrain, buildings, and canopy are fetched in parallel where their dependencies allow. Disabling **Include foliage** skips canopy downloads; enabling it later automatically refreshes the active coverage. Viewshed loads defer the hidden terrain/object overlay images until path mode needs them.

## Verify

```sh
.venv/bin/python -m unittest -v
node --test test_static_engine.mjs test_global_data.mjs
node --check static/app.js
node --check static/engine.js
node --check static/global-data.js
.venv/bin/python build_static.py
```

`verification-auto-fetch.json` records a successful end-to-end automatic fetch with all three sources. `verification-real-data.json` records measured-sample paths producing clear, foliage, blocked, unknown, and link budget viability outcomes in the Bay Area. Numerical tests cover RF link budget calculations, rooftop mounting, field alignment azimuth/tilt, critical obstacle mast recommendations, single-cell obstacles, partial foliage penetration, reverse paths, missing data, Fresnel intrusion, and a 19.9 km curvature case. Tests establish implementation behavior, not survey accuracy or guaranteed radio service.
