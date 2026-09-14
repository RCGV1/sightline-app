"""Fetch official USGS LiDAR tiles for a requested location and build a raster."""

import hashlib
import fcntl
import json
import math
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

import laspy
import numpy as np
from pyproj import CRS, Geod, Transformer

from lidar import _vertical_scale, import_lidar


TNM_PRODUCTS_URL = "https://tnmaccess.nationalmap.gov/api/v1/products"
MAX_TILES = 8
MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024
CACHE_DIR = Path(__file__).resolve().parent / "data" / "cache"
GEOD = Geod(ellps="WGS84")


def _progress(progress, message):
    if progress:
        progress(message)


def _valid_download_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host.endswith(".usgs.gov") or host == "prd-tnm.s3.amazonaws.com")


def _request_bbox(center, radius_m):
    if len(center) != 2:
        raise ValueError("center must be [latitude, longitude]")
    lat, lon, radius_m = float(center[0]), float(center[1]), float(radius_m)
    if not (-90 < lat < 90 and -180 <= lon <= 180 and math.isfinite(radius_m) and 0 < radius_m <= 250_000):
        raise ValueError("center must be valid latitude/longitude and radius_m must be between 0 and 250000")
    west = GEOD.fwd(lon, lat, 270, radius_m)[0]
    east = GEOD.fwd(lon, lat, 90, radius_m)[0]
    south = GEOD.fwd(lon, lat, 180, radius_m)[1]
    north = GEOD.fwd(lon, lat, 0, radius_m)[1]
    return west, south, east, north


def _query_catalog(bbox):
    params = {"datasets": "Lidar Point Cloud (LPC)", "bbox": ",".join(map(str, bbox)), "max": 500}
    request = Request(TNM_PRODUCTS_URL + "?" + urlencode(params), headers={"User-Agent": "sightline-lidar/1.0"})
    with urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if not isinstance(payload.get("items"), list):
        raise ValueError("USGS TNM returned an unexpected catalogue response")
    items = payload.get("items", [])
    if not items:
        raise ValueError("USGS returned no matching survey tiles for this area")
    return items


def _tile_bbox(item):
    box = item.get("boundingBox") or {}
    try:
        return tuple(float(box[key]) for key in ("minX", "minY", "maxX", "maxY"))
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("USGS catalogue item is missing a usable geographic bounding box") from exc


def _survey_key(item):
    return re.sub(r"\s+[^\s]+$", "", str(item.get("title", ""))).strip()


def _covers(items, bbox):
    west, south, east, north = bbox
    boxes = [_tile_bbox(item) for item in items]
    x_edges = sorted({west, east} | {max(west, min(east, x)) for box in boxes for x in (box[0], box[2])})
    for left, right in zip(x_edges, x_edges[1:]):
        midpoint = (left + right) / 2
        intervals = sorted((max(south, b), min(north, d)) for a, b, c, d in boxes if a <= midpoint <= c and d >= south and b <= north)
        covered = south
        for low, high in intervals:
            if low > covered:
                return False
            covered = max(covered, high)
        if covered < north:
            return False
    return True


def _survey_date(item):
    match = re.search(r"(?:^|[_ -])(19\d{2}|20\d{2})(?:$|[_ -])", str(item.get("title", "")))
    return match.group(1) if match else ""


def _select_products(items, bbox):
    usable = [item for item in items if _valid_download_url(item.get("downloadURL") or item.get("downloadLazURL") or "")]
    groups = {}
    for item in usable:
        groups.setdefault(_survey_key(item), []).append(item)
    candidates = []
    for key, group in groups.items():
        latest_by_title = {}
        for item in group:
            title = item.get("title", "")
            if item.get("publicationDate", "") >= latest_by_title.get(title, {}).get("publicationDate", ""):
                latest_by_title[title] = item
        tiles = list(latest_by_title.values())
        if _covers(tiles, bbox):
            candidates.append((max(item.get("publicationDate", "") for item in tiles), key, tiles))
    if not candidates:
        raise ValueError("USGS TNM has no complete official LiDAR tile coverage for this requested area")
    _, _, selected = max(candidates, key=lambda item: (max(_survey_date(tile) for tile in item[2]), item[0], item[1]))
    if len(selected) > MAX_TILES:
        raise ValueError("USGS coverage needs %d tiles; reduce radius (limit is %d tiles)" % (len(selected), MAX_TILES))
    total = sum(int(item.get("sizeInBytes") or 0) for item in selected)
    if total > MAX_DOWNLOAD_BYTES:
        raise ValueError("USGS tiles total %.0f MB; reduce radius (limit is 600 MB)" % (total / 1024 / 1024))
    return selected


def _download(item, progress):
    url = item.get('downloadURL') or item.get('downloadLazURL')
    if not _valid_download_url(url): raise ValueError('Non-official download URL.')
    CACHE_DIR.mkdir(parents=True,exist_ok=True)
    lock_path=CACHE_DIR/(hashlib.sha256(url.encode()).hexdigest()+'.lock')
    with lock_path.open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return _download_unlocked(item,progress)


def _download_unlocked(item, progress):
    url = item.get("downloadURL") or item.get("downloadLazURL")
    if not _valid_download_url(url):
        raise ValueError("USGS catalogue returned a non-official download URL")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    suffix = Path(urlparse(url).path).suffix or ".laz"
    target = CACHE_DIR / (hashlib.sha256(url.encode()).hexdigest() + suffix)
    if target.exists() and target.stat().st_size:
        _progress(progress, "Using cached USGS tile " + item.get("title", target.name))
        return target
    _progress(progress, "Downloading USGS tile " + item.get("title", target.name))
    partial = target.with_suffix(target.suffix + ".part")
    existing = partial.stat().st_size if partial.exists() else 0
    headers = {"User-Agent": "sightline-lidar/1.0"}
    if existing:
        headers["Range"] = "bytes=%d-" % existing
    request = Request(url, headers=headers)
    with urlopen(request, timeout=120) as response:
        append = existing and response.status == 206
        if not append:
            existing = 0
        with partial.open("ab" if append else "wb") as output:
            expected = int(response.headers.get("Content-Length") or 0)
            if expected + existing > MAX_DOWNLOAD_BYTES:
                raise ValueError("USGS tile exceeds the 600 MB download limit")
            downloaded = existing
            reported = downloaded // (5 * 1024 * 1024)
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                downloaded += len(block)
                if downloaded > MAX_DOWNLOAD_BYTES:
                    raise ValueError("USGS tile exceeds the 600 MB download limit")
                output.write(block)
                bucket = downloaded // (5 * 1024 * 1024)
                if bucket > reported:
                    _progress(progress, "%s: %.1f / %s MB" % (item.get("title", target.name), downloaded / 1024 / 1024,
                              "%.1f" % ((expected + existing) / 1024 / 1024) if expected else "?"))
                    reported = bucket
    partial.replace(target)
    return target


def _utm_for_center(center):
    lat, lon = center
    zone = min(60, max(1, int((lon + 180) // 6) + 1))
    return CRS.from_epsg((32600 if lat >= 0 else 32700) + zone)


def _read_json(url):
    with urlopen(Request(url, headers={"User-Agent": "sightline-lidar/1.0"}), timeout=30) as response:
        return json.load(response)


def _recover_tile_metadata(item):
    """Recover a CRS and Z units from official ScienceBase/TNM metadata, never coordinates."""
    meta_url = item.get("metaUrl", "")
    if urlparse(meta_url).hostname not in {"www.sciencebase.gov", "sciencebase.gov"}:
        raise ValueError("USGS tile has no official ScienceBase metadata URL for CRS recovery")
    catalog = _read_json(meta_url + ("&" if "?" in meta_url else "?") + "format=json")
    links = catalog.get("webLinks", [])
    metadata_urls = [link.get("uri") for link in links if "metadata" in link.get("title", "").lower() and link.get("uri", "").endswith(".xml")]
    xml_text = ""
    if metadata_urls:
        with urlopen(metadata_urls[0], timeout=30) as response:
            xml_text = response.read().decode("utf-8", errors="replace")
    vendor = item.get("vendorMetaUrl", "")
    prefix = parse_qs(urlparse(vendor).query).get("prefix", [""])[0].rstrip("/")
    if not prefix or urlparse(vendor).hostname != "prd-tnm.s3.amazonaws.com":
        raise ValueError("USGS tile metadata does not expose an authoritative companion metadata directory")
    listing = _read_json  # retain a named JSON reader; S3 listing itself is XML.
    del listing
    with urlopen("https://prd-tnm.s3.amazonaws.com/?" + urlencode({"list-type": "2", "prefix": prefix}), timeout=30) as response:
        keys = [node.text for node in ET.fromstring(response.read()).iter() if node.tag.endswith("Key") and node.text]
    prj_keys = [key for key in keys if key.lower().endswith(".prj")]
    if not prj_keys:
        raise ValueError("Official USGS metadata has no projection WKT companion file")
    with urlopen("https://prd-tnm.s3.amazonaws.com/" + prj_keys[0], timeout=30) as response:
        crs = CRS.from_wkt(response.read().decode("utf-8", errors="replace"))
    project_xml = next((key for key in keys if key.lower().endswith("/metadata.xml")), None)
    project_text = ""
    if project_xml:
        with urlopen("https://prd-tnm.s3.amazonaws.com/" + project_xml, timeout=30) as response:
            project_text = response.read().decode("utf-8", errors="replace")
    evidence = xml_text + "\n" + project_text
    unit_match = re.search(r"elevation units? (?:are |is )?in (US survey |international )?(feet|foot|meters?|metres?)", evidence, re.I)
    if not unit_match:
        raise ValueError("Official USGS metadata does not state vertical elevation units")
    unit = (unit_match.group(1) or "") + unit_match.group(2)
    scale = 1200.0 / 3937.0 if "survey" in unit.lower() else (0.3048 if "foot" in unit.lower() or "feet" in unit.lower() else 1.0)
    datum_match = re.search(r"\b(NAVD\s*88|NGVD\s*29|[A-Za-z -]+ellipsoid(?:al)? height)\b", evidence, re.I)
    datum = datum_match.group(1).upper().replace(" ", "") if datum_match else "not-stated:" + prefix
    return crs, scale, datum, {"metadata_url": metadata_urls[0] if metadata_urls else None, "projection_wkt": prj_keys[0], "vertical_unit": unit, "vertical_datum": datum}


def _combine_tiles(paths, items, center, bbox, output, progress):
    utm = _utm_for_center(center)
    to_utm = Transformer.from_crs("EPSG:4326", utm, always_xy=True)
    west, south, east, north = bbox
    crop_x, crop_y = to_utm.transform([west, west, east, east], [south, north, south, north])
    xmin, xmax, ymin, ymax = min(crop_x), max(crop_x), min(crop_y), max(crop_y)
    header = laspy.LasHeader(point_format=7, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001])
    header.offsets = np.array([xmin, ymin, 0.0])
    header.add_crs(utm)
    count = 0
    vertical_reference = None
    with laspy.open(output, mode="w", header=header) as writer:
        for path, item in zip(paths, items):
            _progress(progress, "Cropping " + path.name)
            with laspy.open(path) as reader:
                source_crs = reader.header.parse_crs()
                metadata = None
                if source_crs:
                    z_scale = _vertical_scale(source_crs, None)
                    vertical = next((part for part in source_crs.sub_crs_list if part.is_vertical), None)
                    reference = vertical.datum.name if vertical and vertical.datum else None
                else:
                    source_crs, z_scale, reference, metadata = _recover_tile_metadata(item)
                if not reference:
                    raise ValueError("USGS tile %s has no authoritative vertical datum" % path.name)
                if vertical_reference is None:
                    vertical_reference = reference
                elif reference != vertical_reference:
                    raise ValueError("USGS tiles use different vertical references; select a smaller area or separate surveys")
                project = Transformer.from_crs(source_crs, utm, always_xy=True)
                for points in reader.chunk_iterator(1_000_000):
                    x, y = project.transform(np.asarray(points.x), np.asarray(points.y))
                    keep = (x >= xmin) & (x <= xmax) & (y >= ymin) & (y <= ymax)
                    if not np.any(keep):
                        continue
                    record = laspy.ScaleAwarePointRecord.zeros(int(np.count_nonzero(keep)), header=header)
                    record.x, record.y = x[keep], y[keep]
                    record.z = np.asarray(points.z)[keep] * z_scale
                    record.classification = np.asarray(points.classification)[keep]
                    if hasattr(points, "red"):
                        record.red, record.green, record.blue = points.red[keep], points.green[keep], points.blue[keep]
                    if hasattr(points, "withheld"):
                        record.withheld = points.withheld[keep]
                    writer.write_points(record)
                    count += len(record)
    if not count:
        raise ValueError("USGS tiles contained no points within the requested area")
    return count, utm


def _augment_metadata(output_path, extra):
    with np.load(output_path) as archive:
        arrays = {key: archive[key] for key in archive.files if key != "meta"}
        metadata = json.loads(str(archive["meta"]))
    metadata.update(extra)
    np.savez_compressed(output_path, **arrays, meta=json.dumps(metadata, separators=(",", ":")))
    return metadata


def discover_and_fetch(center, radius_m, resolution, output_path, progress=None):
    """Discover official USGS coverage, download/crop tiles, and import a sightline NPZ."""
    bbox = _request_bbox(center, radius_m)
    _progress(progress, "Searching official USGS LiDAR catalogue")
    selected = _select_products(_query_catalog(bbox), bbox)
    _progress(progress, "Selected %d USGS tile(s)" % len(selected))
    paths = [_download(item, progress) for item in selected]
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sightline-lidar-") as temporary:
        combined = Path(temporary) / "cropped_utm.las"
        point_count, utm = _combine_tiles(paths, selected, center, bbox, combined, progress)
        source = "; ".join("%s (%s)" % (item.get("title", "USGS LiDAR"), item.get("publicationDate", "date unknown")) for item in selected)
        _progress(progress, "Rasterizing measured LiDAR")
        import_lidar(combined, output_path, resolution=resolution, name="USGS measured LiDAR", source=source,
                     vertical_unit="m")
    metadata = _augment_metadata(output_path, {"fetch_sources": [{key: item.get(key) for key in ("title", "publicationDate", "downloadURL", "downloadLazURL", "metaUrl")} for item in selected],
                                               "requested_center": [float(center[0]), float(center[1])], "requested_radius_m": float(radius_m),
                                               "cropped_point_count": point_count, "crs": utm.to_string(),
                                               "selection_note": "Selected complete USGS TNM coverage by survey year in title when available; otherwise catalogue publication date."})
    _progress(progress, "LiDAR import complete")
    return metadata
