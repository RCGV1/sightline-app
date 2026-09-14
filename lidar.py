"""Import classified LAS/LAZ point clouds into sightline raster layers."""

import argparse
import json
import math
from pathlib import Path

import laspy
import numpy as np
from pyproj import CRS, Transformer
from scipy.spatial import cKDTree


MAX_CELLS = 8_000_000
GROUND_CLASS = 2
BUILDING_CLASS = 6
TREE_CLASSES = {3, 4, 5}
MAX_GROUND_DISTANCE_M = 30.0


def _vertical_scale(crs, requested):
    axes = crs.axis_info if crs else ()
    vertical = next((axis for axis in axes if axis.direction in {"up", "down"}), None)
    if vertical and vertical.direction == "down":
        raise ValueError("LiDAR vertical axis points down; supply data with upward elevations")
    if requested:
        unit = requested.strip().lower().replace("_", " ").replace("-", " ")
        if unit in {"m", "meter", "meters", "metre", "metres"}:
            return 1.0
        if unit in {"ft", "foot", "feet", "us ft", "us survey foot", "survey foot"}:
            return 1200.0 / 3937.0 if "us" in unit or "survey" in unit else 0.3048
        raise ValueError("vertical_unit must be one of m, ft, or us-ft")
    unit = (vertical.unit_name if vertical else "").lower()
    if "metre" in unit or "meter" in unit:
        return 1.0
    if "foot" in unit or "feet" in unit:
        return 1200.0 / 3937.0 if "us" in unit or "survey" in unit else 0.3048
    raise ValueError("LiDAR vertical units are ambiguous; pass vertical_unit='m', 'ft', or 'us-ft'")


def _input_crs(header, override):
    value = override or header.parse_crs()
    if not value:
        raise ValueError("LAS/LAZ has no CRS; pass crs_override (for example EPSG:32610)")
    try:
        return CRS.from_user_input(value)
    except Exception as exc:
        raise ValueError("Unable to parse LiDAR CRS; pass a valid crs_override") from exc


def _utm_crs(crs, bounds):
    to_geo = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
    lon, lat = to_geo.transform((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2)
    if not (math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("LiDAR CRS cannot be transformed to latitude/longitude")
    zone = min(60, max(1, int((lon + 180) // 6) + 1))
    return CRS.from_epsg((32600 if lat >= 0 else 32700) + zone), lat, lon


def _rgb(values):
    values = np.asarray(values)
    if values.size and np.nanmax(values) > 255:
        values = values / 256.0
    return np.clip(values, 0, 255).astype(np.uint8)


def _default_points(ground, xmin, ymax, resolution, to_geo):
    rows, cols = np.nonzero(np.isfinite(ground))
    if not rows.size:
        raise ValueError("No usable class-2 ground returns remain after filtering withheld/noise points")
    xy = np.column_stack((xmin + (cols + 0.5) * resolution, ymax - (rows + 0.5) * resolution))
    center = xy.mean(axis=0)
    a_index = np.argmin(np.sum((xy - center) ** 2, axis=1))
    distances = np.sqrt(np.sum((xy - xy[a_index]) ** 2, axis=1))
    candidates = np.where((distances >= 100) & (distances <= 400))[0]
    if candidates.size:
        b_index = candidates[np.argmin(abs(distances[candidates] - 250))]
    elif len(xy) > 1:
        b_index = np.argmax(distances)
    else:
        b_index = a_index
    lons, lats = to_geo.transform([xy[a_index, 0], xy[b_index, 0]], [xy[a_index, 1], xy[b_index, 1]])
    return [lats[0], lons[0]], [lats[1], lons[1]]


def import_lidar(path, output_path, resolution=3.0, name=None, source=None,
                 crs_override=None, vertical_unit=None):
    """Convert a classified LAS/LAZ file to a compressed sightline NPZ raster."""
    path, output_path = Path(path), Path(output_path)
    resolution = float(resolution)
    if not math.isfinite(resolution) or resolution <= 0:
        raise ValueError("resolution must be a positive number of meters")
    with laspy.open(path) as reader:
        header = reader.header
        input_crs = _input_crs(header, crs_override)
        z_scale = _vertical_scale(input_crs, vertical_unit)
        bounds = header.mins[0], header.mins[1], header.maxs[0], header.maxs[1]
        utm, center_lat, center_lon = _utm_crs(input_crs, bounds)
        project = Transformer.from_crs(input_crs, utm, always_xy=True)
        corners_x, corners_y = project.transform(
            [bounds[0], bounds[0], bounds[2], bounds[2]], [bounds[1], bounds[3], bounds[1], bounds[3]])
        xmin, xmax, ymin, ymax = min(corners_x), max(corners_x), min(corners_y), max(corners_y)
        width = int(math.floor((xmax - xmin) / resolution)) + 1
        height = int(math.floor((ymax - ymin) / resolution)) + 1
        if width * height > MAX_CELLS:
            # Auto-adapt resolution for large LAS extents instead of erroring
            min_res = math.ceil(math.sqrt((xmax - xmin) * (ymax - ymin) / MAX_CELLS) * 10) / 10
            if min_res > resolution:
                resolution = min_res
                width = int(math.floor((xmax - xmin) / resolution)) + 1
                height = int(math.floor((ymax - ymin) / resolution)) + 1
            while width * height > MAX_CELLS:
                resolution = round(resolution + 0.1, 1)
                width = int(math.floor((xmax - xmin) / resolution)) + 1
                height = int(math.floor((ymax - ymin) / resolution)) + 1
        shape = (height, width)
        ground = np.full(shape, -np.inf, dtype=np.float32)
        buildings = np.full(shape, -np.inf, dtype=np.float32)
        trees = np.full(shape, -np.inf, dtype=np.float32)
        unknown = np.full(shape, -np.inf, dtype=np.float32)
        structural_unknown = np.full(shape, -np.inf, dtype=np.float32)
        top_z = np.full(shape, -np.inf, dtype=np.float32)
        rgb = np.zeros((height, width, 3), dtype=np.uint8)
        returned = np.zeros(shape, dtype=bool)
        class_counts = {}
        ignored_returns = 0

        for points in reader.chunk_iterator(1_000_000):
            px, py = np.asarray(points.x), np.asarray(points.y)
            if px.size == 1:
                tx, ty = project.transform(float(px[0]), float(py[0]))
                x, y = np.array([tx]), np.array([ty])
            else:
                x, y = project.transform(px, py)
            z = np.asarray(points.z, dtype=np.float32) * z_scale
            col = np.floor((x - xmin) / resolution).astype(np.int64)
            row = np.floor((ymax - y) / resolution).astype(np.int64)
            cls_all = np.asarray(points.classification)
            withheld = np.asarray(points.withheld, dtype=bool) if hasattr(points, "withheld") else np.zeros(len(points), dtype=bool)
            ignored = withheld | np.isin(cls_all, (7, 18))
            ignored_returns += int(np.count_nonzero(ignored))
            valid = (row >= 0) & (row < height) & (col >= 0) & (col < width) & np.isfinite(z) & ~ignored
            if not np.any(valid):
                continue
            row, col, z = row[valid], col[valid], z[valid]
            cls = cls_all[valid]
            for value, count in zip(*np.unique(cls, return_counts=True)):
                class_counts[str(int(value))] = class_counts.get(str(int(value)), 0) + int(count)
            flat = row * width + col
            returned.ravel()[flat] = True
            for mask, layer in ((cls == GROUND_CLASS, ground), (cls == BUILDING_CLASS, buildings),
                                (np.isin(cls, tuple(TREE_CLASSES)), trees),
                                ((cls != GROUND_CLASS) & (cls != BUILDING_CLASS) & ~np.isin(cls, tuple(TREE_CLASSES)), unknown),
                                (~np.isin(cls, (0,1,2,3,4,5,6)), structural_unknown)):
                if np.any(mask):
                    np.maximum.at(layer.ravel(), flat[mask], z[mask])
            order = np.lexsort((z, flat))
            selected = order[np.r_[np.diff(flat[order]) != 0, True]]
            better = z[selected] >= top_z[row[selected], col[selected]]
            selected = selected[better]
            if selected.size:
                top_z[row[selected], col[selected]] = z[selected]
                if hasattr(points, "red"):
                    rgb[row[selected], col[selected], 0] = _rgb(points.red[valid][selected])
                    rgb[row[selected], col[selected], 1] = _rgb(points.green[valid][selected])
                    rgb[row[selected], col[selected], 2] = _rgb(points.blue[valid][selected])

    observed_ground = np.isfinite(ground)
    if np.any(observed_ground):
        rows, cols = np.nonzero(observed_ground)
        ground_xy = np.column_stack((xmin + (cols + 0.5) * resolution, ymax - (rows + 0.5) * resolution))
        query_rows, query_cols = np.nonzero(returned & ~observed_ground)
        if query_rows.size:
            query_xy = np.column_stack((xmin + (query_cols + 0.5) * resolution,
                                        ymax - (query_rows + 0.5) * resolution))
            distance, nearest = cKDTree(ground_xy).query(query_xy, distance_upper_bound=MAX_GROUND_DISTANCE_M)
            usable = np.isfinite(distance)
            ground[query_rows[usable], query_cols[usable]] = ground[rows[nearest[usable]], cols[nearest[usable]]]

    for layer in (ground, buildings, trees, unknown, structural_unknown):
        layer[~np.isfinite(layer)] = np.nan
    to_geo = Transformer.from_crs(utm, "EPSG:4326", always_xy=True)
    grid_ymin = ymax - height * resolution
    corner_lons, corner_lats = to_geo.transform(
        [xmin, xmin, xmin + width * resolution, xmin + width * resolution],
        [grid_ymin, ymax, grid_ymin, ymax])
    west, east, south, north = min(corner_lons), max(corner_lons), min(corner_lats), max(corner_lats)
    default_a, default_b = _default_points(ground, xmin, ymax, resolution, to_geo)
    notes = ["RGB is colorized LiDAR return data, not aerial imagery."]
    if not np.any(np.isfinite(buildings)):
        notes.append("No class-6 building returns were present; this does not establish a clear area.")
    if not np.any(np.isfinite(trees)):
        notes.append("No vegetation class 3/4/5 returns were present; this does not establish a clear area.")
    analysis_notes = [
        "Ground is interpolated only into cells with retained returns and a nearest class-2 cell within 30 m.",
        "Cells without retained returns remain data gaps (ground is NaN).",
        "Withheld returns and ASPRS noise classes 7 and 18 are ignored.",
    ] + notes[1:]
    metadata = {"name": name or path.stem, "source": source or str(path), "resolution_m": resolution,
                "xmin": xmin, "ymax": ymax, "crs": utm.to_string(), "bounds": [[south, west], [north, east]],
                "center": [center_lat, center_lon], "notes": notes,
                "analysis_notes": analysis_notes, "class_counts": class_counts,
                "ignored_returns": ignored_returns,
                "ground_coverage": {"cells": int(np.count_nonzero(np.isfinite(ground))), "total_cells": int(ground.size),
                                    "fraction": float(np.count_nonzero(np.isfinite(ground)) / ground.size)},
                "default_a": default_a, "default_b": default_b}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output_path, ground=ground, buildings=buildings, trees=trees, unknown=unknown,
                        rgb=rgb, structural_unknown=structural_unknown, meta=json.dumps(metadata, separators=(",", ":")))
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Import classified LAS/LAZ data into a sightline NPZ raster")
    parser.add_argument("input")
    parser.add_argument("output")
    parser.add_argument("--resolution", type=float, default=3.0)
    parser.add_argument("--name")
    parser.add_argument("--source")
    parser.add_argument("--crs-override")
    parser.add_argument("--vertical-unit")
    args = parser.parse_args()
    print(json.dumps(import_lidar(args.input, args.output, args.resolution, args.name, args.source,
                                  args.crs_override, args.vertical_unit), indent=2))


if __name__ == "__main__":
    main()
