"""Fetch Meta/WRI CHMv2 satellite-estimated canopy heights for a Sightline grid."""

import json
import math
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
import rasterio
from affine import Affine
from rasterio.warp import Resampling, reproject


DATASET = "Meta/WRI Version 2 Global Canopy Height Map (CHMv2)"
PREFIX = "https://dataforgood-fb-data.s3.us-east-1.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm"
CACHE_DIR = Path(__file__).resolve().parent / "data" / "cache" / "canopy"
ZOOM = 10


def _progress(callback, message):
    if callback:
        callback(message)


def _quadkey(x, y, zoom=ZOOM):
    return "".join(str((1 if x & (1 << bit) else 0) + (2 if y & (1 << bit) else 0))
                   for bit in range(zoom - 1, -1, -1))


def _tile_xy(lat, lon, zoom=ZOOM):
    lat = max(-85.05112878, min(85.05112878, float(lat)))
    size = 1 << zoom
    x = int((float(lon) + 180.0) / 360.0 * size)
    value = math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat)))
    y = int((1 - value / math.pi) / 2 * size)
    return max(0, min(size - 1, x)), max(0, min(size - 1, y))


def _quadkeys_for_bounds(bounds):
    (south, west), (north, east) = bounds
    x0, y0 = _tile_xy(north, west)
    x1, y1 = _tile_xy(south, east)
    return [_quadkey(x, y) for y in range(min(y0, y1), max(y0, y1) + 1)
            for x in range(min(x0, x1), max(x0, x1) + 1)]


def _available(url, timeout=20):
    try:
        request = Request(url, method="HEAD", headers={"User-Agent": "sightline-canopy/1.0"})
        with urlopen(request, timeout=timeout) as response:
            return response.status == 200
    except HTTPError as exc:
        if exc.code == 404: return False
        raise ValueError(f'Canopy availability check failed: HTTP {exc.code}') from exc
    except (URLError, TimeoutError) as exc:
        raise ValueError('Canopy availability check failed; retry when the service is reachable.') from exc


def _read_tile(dataset, destination, dst_transform, dst_crs):
    """Reproject one CHMv2 tile, preserving maxima when target pixels are larger."""
    tile = np.full(destination.shape, np.nan, dtype=np.float32)
    reproject(
        source=rasterio.band(dataset, 1), destination=tile,
        src_transform=dataset.transform, src_crs=dataset.crs,
        src_nodata=dataset.nodata, dst_transform=dst_transform, dst_crs=dst_crs,
        dst_nodata=np.nan, resampling=Resampling.max, init_dest_nodata=True,
    )
    tile[(tile < 0) | ~np.isfinite(tile)] = np.nan
    valid = np.isfinite(tile)
    replace = valid & (~np.isfinite(destination) | (tile > destination))
    destination[replace] = tile[replace]


def fetch_canopy(meta, shape, progress=None):
    """Return CHMv2 height above ground aligned to ``meta``'s north-up metric grid.

    Values are satellite/ML estimates in meters, not individual-tree LiDAR observations.
    Missing coverage remains NaN; zero is a valid estimated canopy height.
    """
    height, width = map(int, shape)
    if height <= 0 or width <= 0:
        raise ValueError("shape must contain positive height and width")
    resolution = float(meta["resolution_m"])
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError("meta resolution_m must be positive")
    transform = Affine(resolution, 0, float(meta["xmin"]), 0, -resolution, float(meta["ymax"]))
    crs = meta["crs"]
    quadkeys = _quadkeys_for_bounds(meta["bounds"])
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    manifest_path = CACHE_DIR / "chmv2_urls.json"
    try:
        manifest = json.loads(manifest_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        manifest = {}

    output = np.full((height, width), np.nan, dtype=np.float32)
    urls = []
    for index, key in enumerate(quadkeys, 1):
        url = f"{PREFIX}/{key}.tif"
        _progress(progress, f"Checking canopy tile {index} of {len(quadkeys)}")
        exists = manifest.get(key) or None
        if exists is None:
            exists = _available(url)
            manifest[key] = bool(exists)
        if not exists:
            continue
        _progress(progress, f"Reading canopy tile {index} of {len(quadkeys)}")
        try:
            with rasterio.Env(GDAL_HTTP_TIMEOUT="30", GDAL_HTTP_CONNECTTIMEOUT="15",
                              GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"):
                with rasterio.open(url) as dataset:
                    _read_tile(dataset, output, transform, crs)
            urls.append(url)
        except rasterio.errors.RasterioError as exc:
            raise ValueError(f"Unable to read CHMv2 canopy tile {key}: {exc}") from exc
    manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")))
    valid = np.isfinite(output)
    if not valid.any(): raise ValueError('No satellite canopy-height coverage was available for this area.')
    provenance = {
        "source": DATASET,
        "version": "2",
        "method": "DINOv3-based model estimate from high-resolution satellite imagery",
        "units": "meters above ground",
        "source_imagery_period": "Varies by tile; consult the source observation-date dataset",
        "license": "CC BY 4.0",
        "urls": urls,
        "successful_cells": int(valid.sum()),
        "total_cells": int(output.size),
        "max_height_m": float(np.nanmax(output)) if valid.any() else None,
        "note": "Canopy heights are satellite-derived AI estimates, not exact individual-tree measurements.",
    }
    return output, provenance
