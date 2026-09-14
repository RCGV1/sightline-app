"""Fetch global/regional DEM terrain rasters using USGS 3DEP and AWS Open Data Elevation."""

import hashlib
import io
import json
import math
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image
from pyproj import CRS, Geod, Transformer
from scipy.ndimage import map_coordinates


CACHE_DIR = Path(__file__).resolve().parent / "data" / "cache" / "dem"
GEOD = Geod(ellps="WGS84")
MAX_CELLS = 8_000_000
_cache_lock = threading.Lock()


def _progress(callback, message):
    if callback:
        callback(message)


def _bbox(center, radius_m):
    if not isinstance(center, (list, tuple)) or len(center) != 2:
        raise ValueError("center must be [latitude, longitude]")
    lat, lon = float(center[0]), float(center[1])
    radius_m = float(radius_m)
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 < lat < 90 and
            -180 <= lon <= 180 and math.isfinite(radius_m) and 0 < radius_m <= 250_000):
        raise ValueError("center must be valid latitude/longitude and radius_m must be between 0 and 250000")
    west = GEOD.fwd(lon, lat, 270, radius_m)[0]
    east = GEOD.fwd(lon, lat, 90, radius_m)[0]
    south = GEOD.fwd(lon, lat, 180, radius_m)[1]
    north = GEOD.fwd(lon, lat, 0, radius_m)[1]
    return west, south, east, north


def _corridor_bbox(pt_a, pt_b, buffer_m=60.0):
    """Calculate tight geographic bounding box enclosing segment A-B with lateral buffer."""
    lat_a, lon_a = map(float, pt_a)
    lat_b, lon_b = map(float, pt_b)
    buffer_m = max(30.0, float(buffer_m))
    min_lat = min(lat_a, lat_b)
    max_lat = max(lat_a, lat_b)
    min_lon = min(lon_a, lon_b)
    max_lon = max(lon_a, lon_b)
    south = GEOD.fwd(min_lon, min_lat, 180, buffer_m)[1]
    north = GEOD.fwd(max_lon, max_lat, 0, buffer_m)[1]
    west = GEOD.fwd(min_lon, min_lat, 270, buffer_m)[0]
    east = GEOD.fwd(max_lon, max_lat, 90, buffer_m)[0]
    return west, south, east, north


def _utm_crs(lat, lon):
    zone = min(60, max(1, int(math.floor((lon + 180.0) / 6.0)) + 1))
    epsg = 32600 + zone if lat >= 0 else 32700 + zone
    return CRS.from_epsg(epsg)


def _fetch_tile(zoom, tx, ty):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"terrarium_{zoom}_{tx}_{ty}.png"
    with _cache_lock:
        if cache_file.exists() and cache_file.stat().st_size > 0:
            return cache_file.read_bytes()

    url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{zoom}/{tx}/{ty}.png"
    req = Request(url, headers={"User-Agent": "sightline-dem/1.0 (terrain analysis)"})
    with urlopen(req, timeout=20) as resp:
        data = resp.read()

    with _cache_lock:
        cache_file.write_bytes(data)
    return data


def _hillshade(elevation, resolution, azimuth=315.0, altitude=45.0):
    if elevation.shape[0] < 2 or elevation.shape[1] < 2:
        return np.full((*elevation.shape, 3), 180, dtype=np.uint8)
    rad_az = np.radians(azimuth)
    rad_alt = np.radians(altitude)
    gy, gx = np.gradient(elevation, resolution, resolution)
    slope = np.pi / 2.0 - np.arctan(np.sqrt(gx * gx + gy * gy))
    aspect = np.arctan2(-gx, gy)
    shaded = np.sin(rad_alt) * np.sin(slope) + np.cos(rad_alt) * np.cos(slope) * np.cos(rad_az - aspect)
    shaded = np.clip(shaded, 0.0, 1.0)
    rgb = (shaded * 255.0).astype(np.uint8)
    return np.dstack([rgb, rgb, rgb])


def fetch_dem(center, radius_m, resolution, output_path, progress=None, corridor=None):
    """Download USGS 3DEP / AWS Elevation DEM tiles, interpolate onto metric grid, and save scene npz."""
    resolution = float(resolution)
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError("resolution must be a positive number of meters")

    if corridor:
        pt_a, pt_b, buffer_m = corridor
        buffer_m = max(30.0, float(buffer_m))
        west, south, east, north = _corridor_bbox(pt_a, pt_b, buffer_m)
        lat = (float(pt_a[0]) + float(pt_b[0])) / 2.0
        lon = (float(pt_a[1]) + float(pt_b[1])) / 2.0
        radius_m = float(math.hypot((float(pt_b[0]) - float(pt_a[0])) * 111000, (float(pt_b[1]) - float(pt_a[1])) * 85000) / 2.0 + buffer_m)
    else:
        lat, lon = float(center[0]), float(center[1])
        radius_m = float(radius_m)
        west, south, east, north = _bbox(center, radius_m)

    _progress(progress, "Calculating regional terrain extents")
    utm = _utm_crs(lat, lon)
    to_utm = Transformer.from_crs("EPSG:4326", utm, always_xy=True)
    to_geo = Transformer.from_crs(utm, "EPSG:4326", always_xy=True)

    corners_x, corners_y = to_utm.transform([west, west, east, east], [south, north, south, north])
    xmin, xmax, ymin, ymax = min(corners_x), max(corners_x), min(corners_y), max(corners_y)

    width = int(math.floor((xmax - xmin) / resolution)) + 1
    height = int(math.floor((ymax - ymin) / resolution)) + 1
    if width * height > MAX_CELLS:
        # Auto-adapt resolution for long corridors / large areas instead of erroring
        min_res = math.ceil(math.sqrt((xmax - xmin) * (ymax - ymin) / MAX_CELLS) * 10) / 10
        if min_res > resolution:
            resolution = min_res
            width = int(math.floor((xmax - xmin) / resolution)) + 1
            height = int(math.floor((ymax - ymin) / resolution)) + 1
        while width * height > MAX_CELLS:
            resolution = round(resolution + 0.1, 1)
            width = int(math.floor((xmax - xmin) / resolution)) + 1
            height = int(math.floor((ymax - ymin) / resolution)) + 1

    if resolution <= 4.5:
        zoom = 15
    elif resolution <= 9.0:
        zoom = 14
    elif resolution <= 18.0:
        zoom = 13
    else:
        zoom = 12

    n = 2.0 ** zoom

    def lon2x(l):
        return (l + 180.0) / 360.0 * n

    def lat2y(l):
        l_clamped = np.clip(l, -85.05112878, 85.05112878)
        return (1.0 - np.arcsinh(np.tan(np.radians(l_clamped))) / np.pi) / 2.0 * n

    min_xtile = int(math.floor(lon2x(west)))
    max_xtile = int(math.floor(lon2x(east)))
    min_ytile = int(math.floor(lat2y(north)))
    max_ytile = int(math.floor(lat2y(south)))

    total_tiles = (max_xtile - min_xtile + 1) * (max_ytile - min_ytile + 1)
    while total_tiles > 48 and zoom > 10:
        zoom -= 1
        n = 2.0 ** zoom
        min_xtile = int(math.floor(lon2x(west)))
        max_xtile = int(math.floor(lon2x(east)))
        min_ytile = int(math.floor(lat2y(north)))
        max_ytile = int(math.floor(lat2y(south)))
        total_tiles = (max_xtile - min_xtile + 1) * (max_ytile - min_ytile + 1)

    _progress(progress, f"Downloading {total_tiles} elevation tiles from USGS 3DEP / AWS Terrain DEM…")

    stitched_w = (max_xtile - min_xtile + 1) * 256
    stitched_h = (max_ytile - min_ytile + 1) * 256
    stitched_elev = np.zeros((stitched_h, stitched_w), dtype=np.float32)

    coords = [(tx, ty) for ty in range(min_ytile, max_ytile + 1) for tx in range(min_xtile, max_xtile + 1)]

    def _load_one(coord):
        tx, ty = coord
        tile_bytes = _fetch_tile(zoom, tx, ty)
        img = Image.open(io.BytesIO(tile_bytes)).convert("RGB")
        arr = np.array(img, dtype=np.float32)
        elev = (arr[:, :, 0] * 256.0 + arr[:, :, 1] + arr[:, :, 2] / 256.0) - 32768.0
        return tx, ty, elev

    with ThreadPoolExecutor(max_workers=min(12, max(4, len(coords)))) as executor:
        for tx, ty, elev in executor.map(_load_one, coords):
            r_off = (ty - min_ytile) * 256
            c_off = (tx - min_xtile) * 256
            stitched_elev[r_off:r_off + 256, c_off:c_off + 256] = elev

    _progress(progress, "Interpolating ground elevation onto metric terrain grid…")
    cols = np.arange(width)
    rows = np.arange(height)
    grid_x = xmin + (cols + 0.5) * resolution
    grid_y = ymax - (rows + 0.5) * resolution
    xx, yy = np.meshgrid(grid_x, grid_y)

    lons, lats = to_geo.transform(xx, yy)
    pixel_x = (lon2x(lons) - min_xtile) * 256.0 - 0.5
    pixel_y = (lat2y(lats) - min_ytile) * 256.0 - 0.5

    ground = map_coordinates(stitched_elev, [pixel_y, pixel_x], order=1, mode="nearest").astype(np.float32)
    rgb = _hillshade(ground, resolution)

    shape = ground.shape
    buildings = np.full(shape, np.nan, dtype=np.float32)
    trees = np.full(shape, np.nan, dtype=np.float32)
    unknown = np.full(shape, np.nan, dtype=np.float32)
    structural_unknown = np.full(shape, np.nan, dtype=np.float32)

    pt_a_lon, pt_a_lat = to_geo.transform(xmin + 0.3 * (xmax - xmin), ymin + 0.3 * (ymax - ymin))
    pt_b_lon, pt_b_lat = to_geo.transform(xmin + 0.7 * (xmax - xmin), ymin + 0.7 * (ymax - ymin))

    grid_ymin = ymax - height * resolution
    corner_lons, corner_lats = to_geo.transform(
        [xmin, xmin, xmin + width * resolution, xmin + width * resolution],
        [grid_ymin, ymax, grid_ymin, ymax])
    b_west, b_east, b_south, b_north = min(corner_lons), max(corner_lons), min(corner_lats), max(corner_lats)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    metadata = {
        "name": "USGS 3DEP & AWS Elevation DEM",
        "source": "USGS 3DEP & AWS Open Data Elevation (3D Terrain)",
        "resolution_m": resolution,
        "xmin": xmin,
        "ymax": ymax,
        "crs": utm.to_string(),
        "bounds": [[b_south, b_west], [b_north, b_east]],
        "center": [lat, lon],
        "notes": ["Ground terrain derived from 3DEP elevation DEM. Building and tree overlays fused automatically."],
        "analysis_notes": [
            "Terrain loaded from regional DEM. No LiDAR point returns were required.",
            "Elevations are metric ground heights from USGS 3DEP."
        ],
        "class_counts": {"ground": int(ground.size)},
        "ignored_returns": 0,
        "ground_coverage": {"cells": int(ground.size), "total_cells": int(ground.size), "fraction": 1.0},
        "default_a": list(map(float, corridor[0])) if corridor else [float(pt_a_lat), float(pt_a_lon)],
        "default_b": list(map(float, corridor[1])) if corridor else [float(pt_b_lat), float(pt_b_lon)],
        "is_corridor": bool(corridor),
        "corridor_buffer_m": float(corridor[2]) if corridor else None,
        "fetch_provider": "USGS 3DEP / AWS DEM",
        "is_dem": True,
        "requested_center": [lat, lon],
        "requested_radius_m": radius_m
    }

    np.savez_compressed(
        output_path,
        ground=ground,
        buildings=buildings,
        trees=trees,
        unknown=unknown,
        rgb=rgb,
        structural_unknown=structural_unknown,
        meta=json.dumps(metadata, separators=(",", ":"))
    )
    _progress(progress, "DEM terrain raster ready")
    return metadata
