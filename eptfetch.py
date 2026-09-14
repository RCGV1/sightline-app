"""Fetch a small crop from the official USGS 3DEP EPT point-cloud archive."""

import hashlib
import json
import math
import tempfile
import threading
from pathlib import Path
from urllib.parse import urljoin, urlparse

import laspy
import numpy as np
import requests
from pyproj import CRS, Geod, Transformer

from lidar import import_lidar


CATALOG = "https://usgs-lidar-stac.s3-us-west-2.amazonaws.com/ept/"
ITEM_COLLECTION = urljoin(CATALOG, "item_collection.json")
CACHE_DIR = Path(__file__).resolve().parent / "data" / "ept-cache"
MAX_NODES = 250
MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024
GEOD = Geod(ellps="WGS84")
_cache_lock = threading.Lock()


def _progress(callback, message):
    if callback:
        callback(message)


def _official(url):
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    if parsed.hostname == "usgs-lidar-stac.s3-us-west-2.amazonaws.com":
        return parsed.path.startswith("/ept/")
    return parsed.hostname == "s3-us-west-2.amazonaws.com" and parsed.path.startswith("/usgs-lidar-public/")


def _get(url, *, stream=False, timeout=60):
    if not _official(url):
        raise ValueError("EPT catalogue returned a non-official URL")
    response = requests.get(url, stream=stream, timeout=(10, timeout),
                            headers={"User-Agent": "sightline-ept/1.0"})
    response.raise_for_status()
    return response


def _cached_json(url):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    with _cache_lock:
        if target.exists() and target.stat().st_size:
            return json.loads(target.read_text())
        payload = _get(url).content
        temporary = target.with_suffix(".tmp")
        temporary.write_bytes(payload)
        temporary.replace(target)
    return json.loads(payload)


def _bbox(center, radius_m):
    if not isinstance(center, (list, tuple)) or len(center) != 2:
        raise ValueError("center must be [latitude, longitude]")
    lat, lon = map(float, center)
    radius_m = float(radius_m)
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 < lat < 90 and
            -180 <= lon <= 180 and math.isfinite(radius_m) and 0 < radius_m <= 250_000):
        raise ValueError("center must be valid and radius_m must be between 0 and 250000")
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


def _segment_intersects_box(p1, p2, box, buffer=0.0):
    """Test if line segment p1-p2 intersects an axis-aligned box expanded by buffer."""
    x1, y1 = p1
    x2, y2 = p2
    x0, y0, x1_b, y1_b = box[0] - buffer, box[1] - buffer, box[2] + buffer, box[3] + buffer
    if (x1 < x0 and x2 < x0) or (x1 > x1_b and x2 > x1_b):
        return False
    if (y1 < y0 and y2 < y0) or (y1 > y1_b and y2 > y1_b):
        return False
    if (x0 <= x1 <= x1_b and y0 <= y1 <= y1_b) or (x0 <= x2 <= x1_b and y0 <= y2 <= y1_b):
        return True
    dx = x2 - x1
    dy = y2 - y1
    if dx != 0:
        for bx in (x0, x1_b):
            t = (bx - x1) / dx
            if 0.0 <= t <= 1.0:
                y = y1 + t * dy
                if y0 <= y <= y1_b:
                    return True
    if dy != 0:
        for by in (y0, y1_b):
            t = (by - y1) / dy
            if 0.0 <= t <= 1.0:
                x = x1 + t * dx
                if x0 <= x <= x1_b:
                    return True
    return False


def _intersects(a, b):
    return a[0] <= b[2] and a[2] >= b[0] and a[1] <= b[3] and a[3] >= b[1]


def _matching_items(collection, bbox):
    matches = []
    for item in collection.get("features", []):
        box = item.get("bbox") or []
        asset = item.get("assets", {}).get("ept.json", {})
        if len(box) >= 4 and asset.get("href") and _intersects(box[:4], bbox):
            props = item.get("properties", {})
            date = props.get("datetime") or props.get("end_datetime") or props.get("start_datetime") or ""
            area = max(0.0, (box[2] - box[0]) * (box[3] - box[1]))
            matches.append((-area, date, item))
    if not matches:
        raise ValueError("USGS EPT has no measured LiDAR project intersecting this area")
    return [value[2] for value in sorted(matches, key=lambda value: (value[0], value[1], value[2].get("id", "")), reverse=True)]


def _select_item(collection, bbox):
    return _matching_items(collection, bbox)[0]


def _node_bounds(root_bounds, key):
    depth, x, y, z = map(int, key.split("-"))
    xmin, ymin, zmin, xmax, ymax, zmax = map(float, root_bounds)
    divisor = 2 ** depth
    dx, dy, dz = (xmax - xmin) / divisor, (ymax - ymin) / divisor, (zmax - zmin) / divisor
    return xmin + x * dx, ymin + y * dy, zmin + z * dz, xmin + (x + 1) * dx, ymin + (y + 1) * dy, zmin + (z + 1) * dz


def _sampling_depth(metadata, resolution):
    span = int(metadata.get("span", 0))
    width = float(metadata["bounds"][3]) - float(metadata["bounds"][0])
    if span <= 0 or not math.isfinite(width) or width <= 0:
        raise ValueError("EPT metadata has invalid bounds or span")
    root_spacing = width / span
    depth = max(0, int(math.ceil(math.log2(root_spacing / (float(resolution) / 2.0)))))
    return depth, root_spacing / (2 ** depth)


def _nodes(base, metadata, crop_native, max_depth=None, limit=MAX_NODES, corridor_seg_native=None, corridor_buffer_native=0.0):
    pending = ["0-0-0-0"]
    selected = {}
    while pending:
        hierarchy_key = pending.pop()
        hierarchy = _cached_json(urljoin(base, "ept-hierarchy/%s.json" % hierarchy_key))
        for key, count in hierarchy.items():
            depth = int(key.split("-", 1)[0])
            if max_depth is not None and depth > max_depth:
                continue
            bounds = _node_bounds(metadata["bounds"], key)
            node_box = (bounds[0], bounds[1], bounds[3], bounds[4])
            if not _intersects(node_box, crop_native):
                continue
            if corridor_seg_native is not None and not _segment_intersects_box(corridor_seg_native[0], corridor_seg_native[1], node_box, buffer=corridor_buffer_native):
                continue
            if int(count) == -1:
                if key not in pending:
                    pending.append(key)
            elif int(count) > 0:
                selected[key] = int(count)
                if limit is not None and len(selected) > limit:
                    return None
    return sorted(selected.items())


def _download_node(url, byte_state):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = CACHE_DIR / (hashlib.sha256(url.encode()).hexdigest() + ".laz")
    with _cache_lock:
        if target.exists() and target.stat().st_size:
            size = target.stat().st_size
            byte_state[0] += size
            if byte_state[0] > MAX_DOWNLOAD_BYTES:
                raise ValueError("EPT nodes exceed the 300 MB resource limit; reduce radius")
            return target
        response = _get(url, stream=True, timeout=120)
        declared = int(response.headers.get("Content-Length") or 0)
        if byte_state[0] + declared > MAX_DOWNLOAD_BYTES:
            response.close()
            raise ValueError("EPT nodes exceed the 300 MB resource limit; reduce radius")
        temporary = target.with_suffix(".part")
        written = 0
        with temporary.open("wb") as output:
            for block in response.iter_content(1024 * 1024):
                if not block:
                    continue
                written += len(block)
                if byte_state[0] + written > MAX_DOWNLOAD_BYTES:
                    response.close()
                    temporary.unlink(missing_ok=True)
                    raise ValueError("EPT nodes exceed the 300 MB resource limit; reduce radius")
                output.write(block)
        temporary.replace(target)
        byte_state[0] += written
    return target


def _utm(center):
    lat, lon = map(float, center)
    zone = min(60, max(1, int((lon + 180) // 6) + 1))
    return CRS.from_epsg((32600 if lat >= 0 else 32700) + zone)


def _source_crs(ept):
    srs = ept.get("srs") or {}
    value = srs.get("wkt") or ("EPSG:%s" % srs["horizontal"] if srs.get("horizontal") else None)
    if not value:
        raise ValueError("EPT metadata does not declare a coordinate reference system")
    return CRS.from_user_input(value)


def _vertical_scale_reference(ept, source_crs):
    srs = ept.get("srs") or {}
    vertical = srs.get("vertical")
    if vertical:
        vertical_crs = CRS.from_user_input("EPSG:%s" % vertical)
        axis = next((axis for axis in vertical_crs.axis_info if axis.direction in {"up", "down"}), None)
        if not axis or not axis.unit_conversion_factor:
            raise ValueError("EPT vertical CRS does not declare usable elevation units")
        if axis.direction == "down":
            raise ValueError("EPT vertical CRS has a downward axis")
        return float(axis.unit_conversion_factor), "EPSG:%s (%s)" % (vertical, axis.unit_name)
    horizontal = str(srs.get("horizontal") or source_crs.to_epsg() or "")
    if horizontal == "3857":
        return 1.0, "not encoded in EPT srs; official USGS EPSG:3857 EPT normalized meter Z assumed"
    raise ValueError("EPT vertical units are undeclared outside the official normalized EPSG:3857 archive")


def _combine(paths, ept, center, bbox, output, corridor_seg_target=None, corridor_buffer_target=60.0):
    source_crs = _source_crs(ept)
    z_scale, vertical_reference = _vertical_scale_reference(ept, source_crs)
    target_crs = _utm(center)
    to_source = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True)
    west, south, east, north = bbox
    sx, sy = to_source.transform([west, west, east, east], [south, north, south, north])
    native_crop = min(sx), min(sy), max(sx), max(sy)
    to_target = Transformer.from_crs(source_crs, target_crs, always_xy=True)
    tx, ty = Transformer.from_crs("EPSG:4326", target_crs, always_xy=True).transform(
        [west, west, east, east], [south, north, south, north])
    xmin, ymin, xmax, ymax = min(tx), min(ty), max(tx), max(ty)
    header = laspy.LasHeader(point_format=7, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001])
    header.offsets = np.array([xmin, ymin, 0.0])
    header.add_crs(target_crs)
    count = 0
    with laspy.open(output, mode="w", header=header) as writer:
        for path in paths:
            with laspy.open(path) as reader:
                for points in reader.chunk_iterator(500_000):
                    source_x, source_y = np.asarray(points.x), np.asarray(points.y)
                    keep = ((source_x >= native_crop[0]) & (source_x <= native_crop[2]) &
                            (source_y >= native_crop[1]) & (source_y <= native_crop[3]))
                    if not np.any(keep):
                        continue
                    x, y = to_target.transform(source_x[keep], source_y[keep])
                    inside = (x >= xmin) & (x <= xmax) & (y >= ymin) & (y <= ymax)
                    if corridor_seg_target is not None and np.any(inside):
                        p1, p2 = corridor_seg_target
                        dx, dy = p2[0] - p1[0], p2[1] - p1[1]
                        seg_sq = dx * dx + dy * dy
                        if seg_sq > 0:
                            inside_idx = np.flatnonzero(inside)
                            xi, yi = x[inside_idx], y[inside_idx]
                            t_proj = np.clip(((xi - p1[0]) * dx + (yi - p1[1]) * dy) / seg_sq, 0.0, 1.0)
                            px = p1[0] + t_proj * dx
                            py = p1[1] + t_proj * dy
                            dist_sq = (xi - px) ** 2 + (yi - py) ** 2
                            outside = dist_sq > (corridor_buffer_target ** 2)
                            inside[inside_idx[outside]] = False
                    if not np.any(inside):
                        continue
                    indices = np.flatnonzero(keep)[inside]
                    record = laspy.ScaleAwarePointRecord.zeros(len(indices), header=header)
                    record.x, record.y = x[inside], y[inside]
                    record.z = np.asarray(points.z)[indices] * z_scale
                    record.classification = np.asarray(points.classification)[indices]
                    for name in ("red", "green", "blue", "withheld"):
                        if hasattr(points, name):
                            setattr(record, name, np.asarray(getattr(points, name))[indices])
                    writer.write_points(record)
                    count += len(record)
    if not count:
        raise ValueError("Selected EPT nodes contained no points within the requested area")
    return count, target_crs, native_crop, vertical_reference


def _augment(path, values):
    with np.load(path) as archive:
        arrays = {key: archive[key] for key in archive.files if key != "meta"}
        metadata = json.loads(str(archive["meta"]))
    values = dict(values)
    appended_notes = values.pop("analysis_notes_append", [])
    metadata.update(values)
    if appended_notes:
        metadata["analysis_notes"] = metadata.get("analysis_notes", []) + list(appended_notes)
    np.savez_compressed(path, **arrays, meta=json.dumps(metadata, separators=(",", ":")))
    return metadata


def fetch_ept(center, radius_m, resolution, output_path, progress=None, corridor=None):
    """Discover, spatially stream, crop, and rasterize official USGS EPT data (corridor or circular area)."""
    corridor_seg_native = None
    corridor_buffer_native = 60.0
    corridor_seg_target = None
    corridor_buffer_target = 60.0
    if corridor:
        pt_a, pt_b, buffer_m = corridor
        buffer_m = max(30.0, float(buffer_m))
        bbox = _corridor_bbox(pt_a, pt_b, buffer_m)
        center = [(float(pt_a[0]) + float(pt_b[0])) / 2.0, (float(pt_a[1]) + float(pt_b[1])) / 2.0]
        corridor_buffer_native = buffer_m
        corridor_buffer_target = buffer_m
    else:
        bbox = _bbox(center, radius_m)
    resolution = float(resolution)
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError("resolution must be a positive number of meters")
    _progress(progress, "Searching the official USGS EPT catalogue")
    items = _matching_items(_cached_json(ITEM_COLLECTION), bbox)
    byte_state = [0]
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sightline-ept-") as temporary:
        for attempt, item in enumerate(items, 1):
            if corridor:
                i_box = item.get("bbox") or []
                if len(i_box) >= 4:
                    i_w, i_s, i_e, i_n = i_box[:4]
                    a_lat, a_lon = float(corridor[0][0]), float(corridor[0][1])
                    b_lat, b_lon = float(corridor[1][0]), float(corridor[1][1])
                    covers_a = (i_s <= a_lat <= i_n) and (i_w <= a_lon <= i_e)
                    covers_b = (i_s <= b_lat <= i_n) and (i_w <= b_lon <= i_e)
                    if not (covers_a and covers_b):
                        continue
            ept_url = item["assets"]["ept.json"]["href"]
            if not _official(ept_url):
                continue
            ept = _cached_json(ept_url)
            base = ept_url.rsplit("/", 1)[0] + "/"
            source_crs = _source_crs(ept)
            west, south, east, north = bbox
            to_source = Transformer.from_crs("EPSG:4326", source_crs, always_xy=True)
            x, y = to_source.transform(
                [west, west, east, east], [south, north, south, north])
            req_depth, _ = _sampling_depth(ept, resolution)
            crop_native = (min(x), min(y), max(x), max(y))

            if corridor:
                (sx_a, sx_b), (sy_a, sy_b) = to_source.transform([corridor[0][1], corridor[1][1]], [corridor[0][0], corridor[1][0]])
                corridor_seg_native = ((sx_a, sy_a), (sx_b, sy_b))
                target_crs = _utm(center)
                to_target = Transformer.from_crs("EPSG:4326", target_crs, always_xy=True)
                (tx_a, tx_b), (ty_a, ty_b) = to_target.transform([corridor[0][1], corridor[1][1]], [corridor[0][0], corridor[1][0]])
                corridor_seg_target = ((tx_a, ty_a), (tx_b, ty_b))

            depth = req_depth
            nodes = None
            while depth >= 3:
                cand = _nodes(base, ept, crop_native, max_depth=depth, limit=MAX_NODES,
                              corridor_seg_native=corridor_seg_native, corridor_buffer_native=corridor_buffer_native)
                if cand is not None and len(cand) > 0:
                    nodes = cand
                    break
                depth -= 1
            if not nodes:
                cand = _nodes(base, ept, crop_native, max_depth=min(depth, 4), limit=None,
                              corridor_seg_native=corridor_seg_native, corridor_buffer_native=corridor_buffer_native)
                if cand and len(cand) <= MAX_NODES * 2:
                    nodes = cand
                else:
                    raise ValueError("EPT crop intersects more than %d nodes; reduce radius or corridor length" % MAX_NODES)

            if corridor:
                # Verify that selected nodes actually span both Site A and Site B before downloading point files
                buf = max(30.0, float(corridor_buffer_native))
                node_boxes = [_node_bounds(ept["bounds"], k) for k, _ in nodes]
                covers_a = any(b[0] - buf <= sx_a <= b[3] + buf and b[1] - buf <= sy_a <= b[4] + buf for b in node_boxes)
                covers_b = any(b[0] - buf <= sx_b <= b[3] + buf and b[1] - buf <= sy_b <= b[4] + buf for b in node_boxes)
                if not (covers_a and covers_b):
                    if attempt == len(items):
                        raise ValueError("No single USGS EPT project has point returns spanning the full corridor from Site A to Site B")
                    continue
            span = int(ept.get("span", 128))
            width = float(ept["bounds"][3]) - float(ept["bounds"][0])
            source_sampling_m = width / (span * (2 ** depth)) if span > 0 else resolution
            sampling_depth = depth
            _progress(progress, "Downloading %d intersecting EPT nodes from %s" % (len(nodes), item.get("id", "project")))
            paths = [_download_node(urljoin(base, "ept-data/%s.laz" % key), byte_state) for key, _ in nodes]
            combined = Path(temporary) / ("crop-%d.las" % attempt)
            try:
                count, target_crs, _, vertical_reference = _combine(
                    paths, ept, center, bbox, combined,
                    corridor_seg_target=corridor_seg_target, corridor_buffer_target=corridor_buffer_target)
                break
            except ValueError as exc:
                if "contained no points" not in str(exc) or attempt == len(items):
                    raise
                _progress(progress, "Trying another overlapping EPT project")
        else:
            raise ValueError("USGS EPT has no point coverage at this location")
        _progress(progress, "Rasterizing measured EPT points")
        import_lidar(combined, output_path, resolution=resolution, name="USGS measured LiDAR (EPT)",
                     source="USGS 3DEP EPT project %s" % item.get("id", "unknown"), vertical_unit="m")
    srs = ept.get("srs") or {}
    sampling_note = ("EPT points were resolution-sampled through octree depth %d (theoretical source spacing %.2f m). "
                     "Raster maxima use only those sampled measured returns; small buildings, trees, and other obstacles may be missed."
                     % (sampling_depth, source_sampling_m))
    meta_dict = {
        "fetch_provider": "USGS 3DEP EPT", "fetch_project": item.get("id"), "fetch_ept_url": ept_url,
        "requested_center": list(map(float, center)), "requested_radius_m": float(radius_m if radius_m else 300),
        "cropped_point_count": count, "downloaded_node_count": len(nodes),
        "downloaded_bytes": byte_state[0], "crs": target_crs.to_string(),
        "ept_srs": srs, "vertical_reference": vertical_reference,
        "source_sampling_m": source_sampling_m, "source_sampling_depth": sampling_depth,
        "analysis_notes_append": [sampling_note],
    }
    if corridor:
        meta_dict["default_a"] = list(map(float, corridor[0]))
        meta_dict["default_b"] = list(map(float, corridor[1]))
        meta_dict["is_corridor"] = True
        meta_dict["corridor_buffer_m"] = float(corridor[2])
    metadata = _augment(output_path, meta_dict)
    if corridor:
        b_south, b_west = metadata['bounds'][0]
        b_north, b_east = metadata['bounds'][1]
        a_lat, a_lon = float(corridor[0][0]), float(corridor[0][1])
        b_lat, b_lon = float(corridor[1][0]), float(corridor[1][1])
        covers_a = (b_south <= a_lat <= b_north) and (b_west <= a_lon <= b_east)
        covers_b = (b_south <= b_lat <= b_north) and (b_west <= b_lon <= b_east)
        if not (covers_a and covers_b):
            raise ValueError("Selected EPT project %s does not cover the full corridor (clipped at survey boundary: %.4f to %.4f)" % (item.get("id"), b_south, b_north))
    _progress(progress, "EPT LiDAR import complete")
    return metadata
