"""Conservative 2.5D cell traversal. All internal distances/elevations are meters."""
import base64
import io
import json
import math
from dataclasses import dataclass

import numpy as np
from PIL import Image
from pyproj import Transformer, Geod

EARTH_RADIUS = 6371008.8
MAX_VIEWSHED_SIDE = 100
GEOD = Geod(ellps='WGS84')


@dataclass
class Scene:
    ground: np.ndarray
    buildings: np.ndarray
    trees: np.ndarray
    unknown: np.ndarray
    rgb: np.ndarray
    meta: dict
    uncertain: np.ndarray = None

    def __post_init__(self):
        self.to_xy = Transformer.from_crs('EPSG:4326', self.meta['crs'], always_xy=True)
        self.to_ll = Transformer.from_crs(self.meta['crs'], 'EPSG:4326', always_xy=True)
        self.res = float(self.meta['resolution_m'])
        self.h, self.w = self.ground.shape
        if self.uncertain is None: self.uncertain=np.zeros(self.ground.shape,dtype=bool)

    @classmethod
    def load(cls, path):
        with np.load(path, allow_pickle=False) as d:
            return cls(*(d[k].copy() for k in ('ground', 'buildings', 'trees', 'unknown', 'rgb')), json.loads(str(d['meta'])),d['uncertain'].copy() if 'uncertain' in d else None)

    def xy(self, latlon):
        if not isinstance(latlon, (list, tuple)) or len(latlon) != 2:
            raise ValueError('Coordinates must be [latitude, longitude].')
        lat, lon = map(float, latlon)
        if not math.isfinite(lat+lon) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ValueError('Invalid latitude or longitude.')
        return self.to_xy.transform(lon, lat)

    def cell(self, x, y):
        rf = (self.meta['ymax'] - y) / self.res
        cf = (x - self.meta['xmin']) / self.res
        eps = 1e-6
        if -eps <= rf < 0:
            r = 0
        elif self.h <= rf <= self.h + eps:
            r = self.h - 1
        else:
            r = math.floor(rf)

        if -eps <= cf < 0:
            c = 0
        elif self.w <= cf <= self.w + eps:
            c = self.w - 1
        else:
            c = math.floor(cf)
        return r, c

    def ground_at(self, x, y):
        r, c = self.cell(x, y)
        if not (0 <= r < self.h and 0 <= c < self.w) or not np.isfinite(self.ground[r, c]):
            raise ValueError('Endpoint is outside measured terrain coverage. Move it inside the data footprint.')
        return float(self.ground[r, c])


def number(params, key, default, low, high):
    raw = params.get(key)
    if raw is None or (isinstance(raw, str) and raw.strip() == ''):
        raw = default
    value = float(raw)
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{key} must be between {low} and {high}.')
    return value


def settings(p):
    mode = p.get('mode', 'radio')
    if mode not in ('radio', 'optical'):
        raise ValueError('Mode must be radio or optical.')
    mount_a = p.get('mount_type_a') or 'agl'
    if mount_a not in ('agl', 'rooftop'):
        raise ValueError('mount_type_a must be agl or rooftop.')
    mount_b = p.get('mount_type_b') or 'agl'
    if mount_b not in ('agl', 'rooftop'):
        raise ValueError('mount_type_b must be agl or rooftop.')
    target_agl_raw = p.get('target_agl')
    if target_agl_raw is not None and str(target_agl_raw).strip() != '':
        target_h = number(p, 'target_agl', 10, 0.01, 100000)
    elif 'height_b' in p and p['height_b'] is not None and str(p['height_b']).strip() != '':
        target_h = number(p, 'height_b', 10, 0.01, 100000)
    else:
        target_h = 10.0
    target_surface = p.get('target_surface') if p else None
    if target_surface is not None and target_surface not in ('surface', 'ground'):
        target_surface = None
    cfg = dict(
        height_a=number(p, 'height_a', 10, 0.01, 100000),
        height_b=target_h,
        target_agl=target_h,
        mount_type_a=mount_a,
        mount_type_b=mount_b,
        target_surface=target_surface,
        auto_rooftop_a=bool(p.get('auto_rooftop_a', True)) if p else True,
        frequency_mhz=915 if mode == 'optical' else number(p, 'frequency_mhz', 915, 0.1, 1000000),
        k_factor=1.0 if mode == 'optical' else number(p, 'k_factor', 4/3, 0.1, 10),
        foliage_db_m=0 if mode == 'optical' else number(p, 'foliage_db_m', 0.2, 0, 100),
        mode=mode
    )
    if mode == 'radio':
        cfg.update(
            tx_power_dbm=number(p, 'tx_power_dbm', 20.0, -10, 45),
            antenna_gain_a_dbi=number(p, 'antenna_gain_a_dbi', 23.0, 0, 50),
            antenna_gain_b_dbi=number(p, 'antenna_gain_b_dbi', 23.0, 0, 50),
            cable_loss_a_db=number(p, 'cable_loss_a_db', 1.0, 0, 20),
            cable_loss_b_db=number(p, 'cable_loss_b_db', 1.0, 0, 20),
            channel_width_mhz=number(p, 'channel_width_mhz', 20.0, 0.1, 320),
            noise_figure_db=number(p, 'noise_figure_db', 5.0, 0, 30),
            required_snr_db=number(p, 'required_snr_db', 15.0, 0, 60),
            rx_sensitivity_dbm=number(p, 'rx_sensitivity_dbm', -82.0, -130, -30) if ('rx_sensitivity_dbm' in p and p['rx_sensitivity_dbm'] is not None and str(p['rx_sensitivity_dbm']).strip() != '') else None,
        )
    return cfg


def intervals(scene, a, b):
    """Visit every positive-length crossed raster cell; no fixed-distance sampling."""
    x0,y0 = a; x1,y1 = b
    breaks = [0.,1.]
    for start,end,origin in ((x0,x1,scene.meta['xmin']), (y0,y1,scene.meta['ymax'])):
        if abs(end-start) < 1e-10:
            continue
        lo,hi = sorted(((start-origin)/scene.res,(end-origin)/scene.res))
        edges = origin + np.arange(math.floor(lo)+1,math.ceil(hi))*scene.res
        for b_val in ((edges-start)/(end-start)).tolist():
            if 1e-9 < b_val < 1.0 - 1e-9:
                breaks.append(b_val)
    t = np.unique(breaks)
    mid = (t[:-1]+t[1:])/2
    cols = np.floor((x0+(x1-x0)*mid-scene.meta['xmin'])/scene.res).astype(int)
    rows = np.floor((scene.meta['ymax']-y0-(y1-y0)*mid)/scene.res).astype(int)
    return t[:-1],t[1:],rows,cols


def trace(scene, a, b, opts, detailed=True):
    d = math.dist(a, b)
    if d < 0.01:
        raise ValueError('Choose two distinct endpoints (at least 1 cm apart).')
    g_a = scene.ground_at(*a)
    r_a, c_a = scene.cell(*a)
    b_a = scene.buildings[r_a, c_a] if (0 <= r_a < scene.h and 0 <= c_a < scene.w) else np.nan
    if opts.get('mount_type_a') == 'rooftop' and np.isfinite(b_a) and b_a > g_a:
        base_a = float(b_a)
        struct_a = float(b_a - g_a)
        eff_mount_a = 'rooftop'
    else:
        base_a = g_a
        struct_a = 0.0
        eff_mount_a = 'agl'
    z0 = base_a + opts['height_a']

    g_b = scene.ground_at(*b)
    r_b, c_b = scene.cell(*b)
    b_b = scene.buildings[r_b, c_b] if (0 <= r_b < scene.h and 0 <= c_b < scene.w) else np.nan
    use_rooftop_b = (opts.get('mount_type_b') == 'rooftop') or (opts.get('target_surface') == 'surface' and np.isfinite(b_b) and b_b > g_b)
    if use_rooftop_b and np.isfinite(b_b) and b_b > g_b:
        base_b = float(b_b)
        struct_b = float(b_b - g_b)
        eff_mount_b = 'rooftop'
    else:
        base_b = g_b
        struct_b = 0.0
        eff_mount_b = 'agl'
    z1 = base_b + opts['height_b']

    lo, hi, rows, cols = intervals(scene, a, b)
    inside = (rows >= 0) & (rows < scene.h) & (cols >= 0) & (cols < scene.w)
    rr = np.clip(rows, 0, scene.h - 1); cc = np.clip(cols, 0, scene.w - 1)
    g = scene.ground[rr, cc].astype(float); buildings = scene.buildings[rr, cc].astype(float)
    trees = scene.trees[rr, cc].astype(float); unknown = scene.unknown[rr, cc].astype(float)
    valid = inside & np.isfinite(g)
    curvature = d * d / (2 * EARTH_RADIUS * opts['k_factor'])
    # Ray relative to the curved local surface is a convex quadratic.
    def ray(t): return z0 + (z1 - z0) * t - curvature * t * (1 - t)
    vertex = np.clip((curvature - (z1 - z0)) / (2 * curvature), lo, hi) if curvature > 1e-12 else lo
    minimum = np.minimum(np.minimum(ray(lo), ray(hi)), ray(vertex))
    hard = np.fmax(g, buildings)
    # The antenna starts above its own roof, so the ordinary roof-height check
    # lets it leave naturally while still keeping the building volume solid.
    clearances = minimum - hard
    blocked = bool(np.any(valid & (clearances <= 0)))
    if opts.get('target_surface') == 'ground' and np.isfinite(b_b):
        blocked = True
    unknown_hit = bool(np.any(~valid) or np.any(valid & scene.uncertain[rr, cc]) or np.any(valid & np.isfinite(unknown) & (minimum <= unknown)))
    if not detailed and blocked:
        return dict(status='blocked', direct_status='blocked', foliage_m=0.0)
    # Integrate exact path length inside each ground-to-canopy envelope.
    foliage_fraction = np.zeros(len(lo))
    for i in np.flatnonzero(valid & np.isfinite(trees) & (minimum < trees)):
        cuts = [float(lo[i]), float(hi[i])]
        # Both ground and canopy roots bound the modeled vegetation volume.
        for surface in (g[i], trees[i]):
            if curvature > 1e-12:
                disc = (z1 - z0 - curvature) ** 2 - 4 * curvature * (z0 - surface)
                if disc >= 0:
                    cuts.extend(r for r in ((-(z1 - z0 - curvature) - math.sqrt(disc)) / (2 * curvature), (-(z1 - z0 - curvature) + math.sqrt(disc)) / (2 * curvature)) if lo[i] < r < hi[i])
            elif z1 != z0:
                r = (surface - z0) / (z1 - z0)
                if lo[i] < r < hi[i]: cuts.append(r)
        cuts = sorted(cuts)
        foliage_fraction[i] = sum(v - u for u, v in zip(cuts[:-1], cuts[1:]) if g[i] <= ray((u + v) / 2) <= trees[i])
    foliage_m = float(foliage_fraction.sum() * math.hypot(d, z1 - z0))
    if opts['mode'] == 'optical' and foliage_m > 0:
        blocked = True
    direct_status = 'blocked' if blocked else 'unknown' if unknown_hit else 'foliage' if foliage_m > 0 else 'clear'
    # Fresnel clearance samples at cell edges/midpoints; separate from direct LOS.
    sample = np.stack((lo, (lo + hi) / 2, hi), axis=1)
    wave = 299.792458 / opts['frequency_mhz']
    fresnel = np.sqrt(np.maximum(0, wave * d * sample * (1 - sample)))
    fclear = ray(sample) - hard[:, None] - 0.6 * fresnel
    fresnel_intrusion = opts['mode'] == 'radio' and bool(np.any(valid[:, None] & (fclear < 0)))
    if opts['mode'] == 'radio':
        unknown_hit = unknown_hit or bool(np.any(np.isfinite(unknown)[:, None] & (ray(sample) - 0.6 * fresnel <= unknown[:, None])))
    status = 'blocked' if blocked else 'unknown' if unknown_hit else 'fresnel' if fresnel_intrusion else 'foliage' if foliage_m > 0 else 'clear'

    if not detailed:
        return dict(status=status, direct_status=direct_status, foliage_m=foliage_m)

    # Field Alignment (compass bearing and tilt angle)
    lon_a, lat_a = scene.to_ll.transform(*a)
    lon_b, lat_b = scene.to_ll.transform(*b)
    az_ab, az_ba, _ = GEOD.inv(lon_a, lat_a, lon_b, lat_b)
    az_ab = float((az_ab + 360.0) % 360.0)
    az_ba = float((az_ba + 360.0) % 360.0)
    curv_drop = (d * d) / (2.0 * EARTH_RADIUS * opts['k_factor'])
    tilt_ab = float(math.degrees(math.atan2((z1 - z0) - curv_drop, d)))
    tilt_ba = float(math.degrees(math.atan2((z0 - z1) - curv_drop, d)))
    d_3d = float(math.hypot(d, z1 - z0))

    # Critical Obstacle & Clearance Recommendations
    crit_obs = None
    if valid.any():
        valid_idx = np.flatnonzero(valid)
        i_crit = int(valid_idx[np.argmin(clearances[valid])])
        t_crit = float((lo[i_crit] + hi[i_crit]) / 2.0)
        dist_crit = float(t_crit * d)
        min_clr = float(clearances[i_crit])
        ray_at_crit = float(ray(t_crit))
        # Check if optical mode is clear of hard obstacles (terrain/buildings) but blocked by trees
        tree_blocked_optical = (opts['mode'] == 'optical' and foliage_m > 0 and not np.any(valid & (clearances <= 0)))
        if tree_blocked_optical:
            # Locate the cell where ray penetrates deepest into tree canopy
            canopy_penetration = np.where(valid & np.isfinite(trees) & (foliage_fraction > 0), trees - ray((lo + hi) / 2.0), -np.inf)
            i_crit = int(np.argmax(canopy_penetration))
            t_crit = float((lo[i_crit] + hi[i_crit]) / 2.0)
            dist_crit = float(t_crit * d)
            ray_at_crit = float(ray(t_crit))
            obs_type = 'tree'
            obs_elev = float(trees[i_crit])
            min_clr = float(ray_at_crit - obs_elev)
        else:
            i_crit = int(valid_idx[np.argmin(clearances[valid])])
            t_crit = float((lo[i_crit] + hi[i_crit]) / 2.0)
            dist_crit = float(t_crit * d)
            min_clr = float(clearances[i_crit])
            ray_at_crit = float(ray(t_crit))
            hard_at_crit = float(hard[i_crit])
            # Physical obstruction priority:
            # 1. Ray at or below ground is ALWAYS terrain (even if trees grow on the ridge)
            if ray_at_crit <= g[i_crit]:
                obs_type = 'terrain'
                obs_elev = float(g[i_crit])
            # 2. Ray above ground and <= building roof is building
            elif np.isfinite(buildings[i_crit]) and buildings[i_crit] > g[i_crit] and ray_at_crit <= buildings[i_crit]:
                obs_type = 'building'
                obs_elev = float(buildings[i_crit])
            # 3. Ray above ground and <= tree canopy is tree
            elif np.isfinite(trees[i_crit]) and trees[i_crit] > g[i_crit] and ray_at_crit <= trees[i_crit]:
                obs_type = 'tree'
                obs_elev = float(trees[i_crit])
            # 4. Unknown return elevated above hard surface
            elif np.isfinite(unknown[i_crit]) and ray_at_crit <= unknown[i_crit] and unknown[i_crit] > hard_at_crit + 0.5:
                obs_type = 'unknown'
                obs_elev = float(unknown[i_crit])
            # 5. Clearance <= 0 fallback
            elif clearances[i_crit] <= 0:
                obs_type = 'building' if (np.isfinite(buildings[i_crit]) and buildings[i_crit] > g[i_crit]) else 'terrain'
                obs_elev = hard_at_crit
            # 6. Clear ray: report the closest obstacle (building if present, else terrain)
            else:
                if np.isfinite(buildings[i_crit]) and buildings[i_crit] > g[i_crit]:
                    obs_type = 'building'
                    obs_elev = float(buildings[i_crit])
                else:
                    obs_type = 'terrain'
                    obs_elev = float(g[i_crit])
        deficit = max(0.0, -min_clr)
        req_both_dir = float(deficit)
        req_a_dir = float(deficit / max(0.01, (1.0 - t_crit)))
        req_b_dir = float(deficit / max(0.01, t_crit))
        fres_at_crit = float(math.sqrt(max(0.0, wave * d * t_crit * (1.0 - t_crit)))) if opts['mode'] == 'radio' else 0.0
        fclear_crit = float(ray_at_crit - hard[i_crit] - 0.6 * fres_at_crit) if opts['mode'] == 'radio' else min_clr
        fres_deficit = float(max(0.0, -np.min(fclear[valid]))) if (valid.any() and opts['mode'] == 'radio' and not unknown_hit) else 0.0
        crit_obs = dict(
            distance_m=dist_crit,
            fraction=t_crit,
            obstacle_type=obs_type,
            obstacle_elevation_m=obs_elev,
            ray_elevation_m=ray_at_crit,
            clearance_m=min_clr,
            fresnel_clearance_m=fclear_crit if opts['mode'] == 'radio' else None,
            required_clearance_height_both_m=req_both_dir,
            required_clearance_height_a_m=req_a_dir,
            required_clearance_height_b_m=req_b_dir,
            required_fresnel_height_both_m=fres_deficit,
        )

    notes = []
    if unknown_hit: notes.append('The path contains missing terrain or an unclassified obstruction; clear visibility cannot be established there.')
    if foliage_m > 0: notes.append('Trees are modeled as solid ground-to-canopy envelopes. Foliage loss is a user-selected dB/m scenario, not a calibrated propagation prediction.')
    if fresnel_intrusion:
        notes.append('The sampled 60% first Fresnel zone intersects terrain/buildings, even if the direct ray is clear.')
    if d > 50000: notes.append('Long path: local projection and effective-Earth approximations need independent validation.')

    link_budget = None
    viability = None
    if opts['mode'] == 'radio':
        fspl = 20.0 * math.log10(4.0 * math.pi * d_3d / wave)
        # Foliage loss is user scenario (dB/m). Highly variable with species/season;
        # ITU-R P.833 shows frequency & depth dependence. Keep linear for
        # backward-compat but cap saturation: dense canopy beyond ~25 dB
        # sees diffraction around canopy, not linear increase through foliage.
        raw_foliage = foliage_m * opts['foliage_db_m']
        foliage_loss = raw_foliage if raw_foliage <= 25 else 25 + 3 * math.log10(1 + (raw_foliage - 25))
        foliage_loss = min(foliage_loss, 35.0)
        # Light atmospheric absorption (~0.006 dB/km at sub-6 GHz, handled by margin)
        atmos_db = min(2.0, d / 1000.0 * 0.006)
        total_loss = fspl + foliage_loss + atmos_db
        tx_eirp = opts['tx_power_dbm'] - opts['cable_loss_a_db'] + opts['antenna_gain_a_dbi']
        rx_power = tx_eirp - total_loss - opts['cable_loss_b_db'] + opts['antenna_gain_b_dbi']
        bw_hz = opts['channel_width_mhz'] * 1e6
        noise_floor = -174.0 + 10.0 * math.log10(bw_hz) + opts['noise_figure_db']
        sensitivity = opts['rx_sensitivity_dbm'] if opts.get('rx_sensitivity_dbm') is not None else (noise_floor + opts['required_snr_db'])
        link_margin = rx_power - sensitivity
        snr = rx_power - noise_floor

        if blocked:
            viability = 'blocked'
        elif unknown_hit:
            viability = 'unknown'
        elif link_margin >= 10.0:
            if fresnel_intrusion or foliage_m > 0:
                viability = 'marginal'
            else:
                viability = 'viable'
        elif link_margin >= 0.0:
            viability = 'marginal'
        else:
            viability = 'deficit'

        if viability == 'deficit':
            notes.append(f"Link budget deficit: Received signal level ({rx_power:.1f} dBm) is {abs(link_margin):.1f} dB below receiver threshold ({sensitivity:.1f} dBm). Link cannot close.")
        elif viability == 'marginal':
            notes.append(f"Marginal link: Fade margin ({link_margin:.1f} dB) provides limited buffer (<10 dB) against weather, multipath, or foliage attenuation.")

        link_budget = dict(
            tx_power_dbm=opts['tx_power_dbm'],
            antenna_gain_a_dbi=opts['antenna_gain_a_dbi'],
            antenna_gain_b_dbi=opts['antenna_gain_b_dbi'],
            cable_loss_a_db=opts['cable_loss_a_db'],
            cable_loss_b_db=opts['cable_loss_b_db'],
            channel_width_mhz=opts['channel_width_mhz'],
            eirp_dbm=tx_eirp,
            free_space_loss_db=fspl,
            foliage_loss_db=foliage_loss,
            foliage_raw_loss_db=raw_foliage,
            atmospheric_loss_db=atmos_db,
            total_path_loss_db=total_loss,
            rx_power_dbm=rx_power,
            thermal_noise_dbm=noise_floor,
            rx_sensitivity_dbm=sensitivity,
            link_margin_db=link_margin,
            snr_db=snr,
            viability=viability,
        )

    result = dict(
        a=a,
        b=b,
        status=status,
        direct_status=direct_status,
        viability=viability,
        distance_m=d,
        distance_3d_m=d_3d,
        foliage_m=foliage_m,
        foliage_loss_db=link_budget['foliage_loss_db'] if link_budget else None,
        free_space_loss_db=link_budget['free_space_loss_db'] if link_budget else None,
        min_clearance_m=float(np.min(clearances[valid])) if valid.any() else None,
        min_fresnel_clearance_m=float(np.min(fclear[valid])) if valid.any() and opts['mode'] == 'radio' and not unknown_hit else None,
        link_budget=link_budget,
        alignment=dict(
            azimuth_a_to_b=az_ab,
            azimuth_b_to_a=az_ba,
            tilt_a_to_b=tilt_ab,
            tilt_b_to_a=tilt_ba,
        ),
        mounts=dict(
            a=dict(mount_type=eff_mount_a, ground_elevation_m=g_a, base_elevation_m=base_a, structure_height_m=struct_a, mast_height_m=opts['height_a'], total_elevation_m=z0),
            b=dict(mount_type=eff_mount_b, ground_elevation_m=g_b, base_elevation_m=base_b, structure_height_m=struct_b, mast_height_m=opts['height_b'], total_elevation_m=z1),
        ),
        critical_obstacle=crit_obs,
        notes=notes
    )

    # Compute contiguous path segments for map and chart visualization
    # Priority: hard block (building/terrain) > unknown > fresnel > foliage > clear
    # This prevents thin structural_unknown (wires/bridges) from shadowing real blocks
    segments = []
    if len(lo) > 0:
        current_seg = None
        for i in range(len(lo)):
            if not valid[i]:
                c_status = 'unknown'
                c_obs = 'unknown'
                c_clr = 0.0
            elif clearances[i] <= 0:
                c_status = 'blocked'
                if minimum[i] <= g[i]:
                    c_obs = 'terrain'
                elif np.isfinite(buildings[i]) and buildings[i] > g[i] and minimum[i] <= buildings[i]:
                    c_obs = 'building'
                else:
                    c_obs = 'terrain'
                c_clr = float(clearances[i])
            elif np.isfinite(unknown[i]) and minimum[i] <= unknown[i]:
                c_status = 'unknown'
                c_obs = 'unknown'
                c_clr = 0.0
            elif opts['mode'] == 'radio' and np.any(fclear[i] < 0):
                c_status = 'fresnel'
                c_obs = 'building' if (np.isfinite(buildings[i]) and buildings[i] > g[i]) else 'terrain'
                c_clr = float(np.min(fclear[i]))
            elif foliage_fraction[i] > 0:
                c_status = 'foliage'
                c_obs = 'tree'
                c_clr = float(clearances[i])
            else:
                c_status = 'clear'
                c_obs = 'none'
                c_clr = float(clearances[i])

            t_start = float(lo[i])
            t_end = float(hi[i])

            if current_seg is None:
                current_seg = {
                    'start_frac': t_start,
                    'end_frac': t_end,
                    'status': c_status,
                    'obstacle_type': c_obs,
                    'min_clearance_m': c_clr
                }
            elif current_seg['status'] == c_status and (c_obs == current_seg['obstacle_type'] or c_status in ('clear', 'foliage')):
                current_seg['end_frac'] = t_end
                current_seg['min_clearance_m'] = min(current_seg['min_clearance_m'], c_clr)
            else:
                segments.append(current_seg)
                current_seg = {
                    'start_frac': t_start,
                    'end_frac': t_end,
                    'status': c_status,
                    'obstacle_type': c_obs,
                    'min_clearance_m': c_clr
                }
        if current_seg is not None:
            segments.append(current_seg)

        for s in segments:
            t_s = s['start_frac']
            t_e = s['end_frac']
            s['start_m'] = round(t_s * d, 1)
            s['end_m'] = round(t_e * d, 1)
            xs, ys = a[0] + t_s * (b[0] - a[0]), a[1] + t_s * (b[1] - a[1])
            xe, ye = a[0] + t_e * (b[0] - a[0]), a[1] + t_e * (b[1] - a[1])
            lon_s, lat_s = scene.to_ll.transform(float(xs), float(ys))
            lon_e, lat_e = scene.to_ll.transform(float(xe), float(ye))
            s['start_ll'] = [round(float(lat_s), 7), round(float(lon_s), 7)]
            s['end_ll'] = [round(float(lat_e), 7), round(float(lon_e), 7)]
            s['start_frac'] = round(t_s, 4)
            s['end_frac'] = round(t_e, 4)
            s['min_clearance_m'] = round(s['min_clearance_m'], 2)

    result['segments'] = segments

    if detailed:
        # Two samples per cell preserve steps and thin obstacles in the profile.
        profile = []
        for i in range(len(lo)):
            for t in (lo[i], hi[i]):
                bulge = curvature * t * (1 - t)
                def elev(v): return float(v + bulge) if valid[i] and np.isfinite(v) else None
                profile.append(dict(distance_m=float(t * d), ground_m=elev(g[i]), building_m=elev(buildings[i]), tree_m=elev(trees[i]), ray_m=float(z0 + (z1 - z0) * t), fresnel_m=float(math.sqrt(max(0, wave * d * t * (1 - t)))) if opts['mode'] == 'radio' else 0, unknown=not bool(valid[i]) or bool(scene.uncertain[rr[i], cc[i]]) or bool(np.isfinite(unknown[i]) and minimum[i] <= unknown[i])))
        result['profile'] = profile
    return result


def analyze(scene, p):
    a=scene.xy(p.get('a')); b=scene.xy(p.get('b'))
    result=trace(scene,a,b,settings(p))
    result.update(a=p['a'],b=p['b'],parameters=settings(p),dataset=dict(name=scene.meta['name'],source=scene.meta['source'],resolution_m=scene.res))
    result['notes'] += scene.meta.get('analysis_notes', [])
    return result


def png_url(image):
    b=io.BytesIO(); Image.fromarray(image).save(b,format='PNG')
    return 'data:image/png;base64,'+base64.b64encode(b.getvalue()).decode()


def viewshed(scene,p):
    if scene is None:
        raise ValueError('No terrain dataset loaded. Fetch an area or wait for startup to complete.')
    if not p or not p.get('a'):
        raise ValueError('Site A coordinates [latitude, longitude] are required for viewshed.')
    # Target height above ground level: default to target_agl (2m) if neither target_agl nor height_b is passed
    if 'target_agl' not in p and 'height_b' not in p:
        p = dict(p, target_agl=2.0)
    if 'target_surface' not in p:
        p = dict(p, target_surface='ground')
    a=scene.xy(p.get('a'))
    try:
        scene.ground_at(*a)
    except ValueError:
        if scene.meta.get('is_corridor'):
            raise ValueError('Site A is outside the loaded corridor coverage. Move Site A inside the corridor or fetch a full 360° area around Site A.')
        raise ValueError('Site A is outside measured terrain coverage. Move Site A inside the loaded data footprint or fetch new terrain for this location.')
    # If Site A is placed on a building and mount_type_a was not explicitly provided, default to rooftop
    r_a, c_a = scene.cell(*a)
    b_a = scene.buildings[r_a, c_a] if (0 <= r_a < scene.h and 0 <= c_a < scene.w) else np.nan
    g_a = scene.ground[r_a, c_a] if (0 <= r_a < scene.h and 0 <= c_a < scene.w) else np.nan
    if 'auto_rooftop_a' in p:
        auto_rooftop = bool(p['auto_rooftop_a'])
    else:
        auto_rooftop = ('mount_type_a' not in p or p['mount_type_a'] is None)
    if auto_rooftop and np.isfinite(b_a) and np.isfinite(g_a) and b_a > g_a:
        p = dict(p, mount_type_a='rooftop')
    opts=settings(p)
    radius=number(p,'radius_m',500,1,500000)
    step=number(p,'step_m',max(20.0, scene.res),scene.res,10000)
    n=math.ceil(2*radius/step)
    if n*n>MAX_VIEWSHED_SIDE**2:
        raise ValueError(f'This viewshed would evaluate {n*n:,} locations. Increase step_m to at least {math.ceil(2*radius/MAX_VIEWSHED_SIDE)} m or reduce radius. There is no fixed distance cap within 500 km.')
    # Geographic output grid aligns precisely with a Leaflet image overlay. Uses local transverse-Mercator projection;
    # accuracy decreases with distance – results beyond ~50 km need independent validation.
    corners=[scene.to_ll.transform(a[0]+dx*radius,a[1]+dy*radius) for dx in (-1,1) for dy in (-1,1)]
    west=min(v[0] for v in corners); east=max(v[0] for v in corners)
    south=min(v[1] for v in corners); north=max(v[1] for v in corners)
    lon=west+(np.arange(n)+.5)/n*(east-west)
    lat=north-(np.arange(n)+.5)/n*(north-south)
    xx,yy=scene.to_xy.transform(*np.meshgrid(lon,lat))
    simple = bool(p.get('simple', True))
    include_foliage = bool(p.get('include_foliage', True))
    visible_color = [235, 55, 65, 215]  # Red for visible coverage
    foliage_color = visible_color if include_foliage else [0, 0, 0, 0]
    if simple:
        colors = {
            'clear': visible_color,
            'foliage': foliage_color,
            'fresnel': visible_color,
            'blocked': [0, 0, 0, 0],
            'unknown': [130, 135, 145, 90],
        }
    else:
        colors = {
            'clear': visible_color,
            'foliage': [241, 183, 74, 215] if include_foliage else [0, 0, 0, 0],
            'fresnel': [172, 129, 245, 215],
            'blocked': [0, 0, 0, 0],
            'unknown': [130, 135, 145, 90],
        }
    if isinstance(p.get('colors'), dict):
        colors.update(p['colors'])
    image = np.zeros((n, n, 4), dtype=np.uint8)
    counts = {'clear': 0, 'foliage': 0, 'blocked': 0, 'unknown': 0, 'fresnel': 0}
    for row in range(n):
        for col in range(n):
            b=(float(xx[row,col]),float(yy[row,col]))
            distance=math.dist(a,b)
            if distance>radius: continue
            r_t, c_t = scene.cell(*b)
            on_coverage = 0 <= r_t < scene.h and 0 <= c_t < scene.w and np.isfinite(scene.ground[r_t, c_t])
            on_bldg = on_coverage and np.isfinite(scene.buildings[r_t, c_t])
            if distance < 0.01:
                state = 'blocked' if (opts.get('target_surface') == 'ground' and on_bldg) else 'clear'
            elif not on_coverage:
                state='unknown'
            elif opts.get('target_surface') == 'ground' and on_bldg:
                state='blocked'
            else:
                try:
                    state=trace(scene,a,b,opts,False)['status']
                except ValueError as e:
                    msg=str(e)
                    if 'outside measured terrain coverage' in msg or 'outside' in msg.lower():
                        state='unknown'
                    else:
                        raise
            counts[state]+=1; image[row,col]=colors[state]
    target_desc = 'local ground (terrain)' if opts.get('target_surface') == 'ground' else 'local ground/surface'
    base_note=f'Each colored pixel is a sampled target at approximately {2*radius/n:.1f} m spacing (red = visible line of sight, uncolored = obstructed). Receiver height is {opts["height_b"]:.1f} m above {target_desc}.'
    extra=[]
    is_corridor=bool(scene.meta.get('is_corridor'))
    if is_corridor:
        extra.append('Dataset is a narrow corridor: targets outside the corridor appear gray (unknown). For omnidirectional viewshed, fetch a full 360° area or a wider corridor (increase corridor_buffer_m).')
    else:
        # Generic data-bounds check: if many samples are unknown, explain narrows/bounds
        total=sum(counts.values())
        if total>0 and counts['unknown']/total>0.5:
            extra.append('Many sampled targets are outside available data coverage. The requested radius may extend beyond the loaded terrain bounds or a narrow corridor – reduce radius, increase step_m, or fetch a larger/wider area.')
    # Projection accuracy note – local metric projection and effective-Earth curvature are approximations
    if radius>50000:
        extra.append('Long-range viewshed (>50 km): local projection and effective-Earth curvature are approximations and need independent validation.')
    elif radius>10000:
        extra.append('Viewshed uses local transverse-Mercator projection; accuracy gradually decreases with distance – validate results beyond ~10 km.')
    notes=[base_note]+extra+scene.meta.get('analysis_notes',[])
    return dict(bounds=[[south,west],[north,east]],image=png_url(image),counts=counts,notes=notes)


def map_image(scene, classes=False):
    (south,west),(north,east)=scene.meta['bounds']
    h,w=scene.h,scene.w
    max_dim = max(h, w)
    if max_dim > 2048:
        scale = int(math.ceil(max_dim / 2048))
        h, w = max(1, h // scale), max(1, w // scale)
    lon=west+(np.arange(w)+.5)/w*(east-west)
    lat=north-(np.arange(h)+.5)/h*(north-south)
    x,y=scene.to_xy.transform(*np.meshgrid(lon,lat))
    c=np.floor((x-scene.meta['xmin'])/scene.res).astype(int)
    r=np.floor((scene.meta['ymax']-y)/scene.res).astype(int)
    inside=(r>=0)&(r<scene.h)&(c>=0)&(c<scene.w)
    r=np.clip(r,0,scene.h-1); c=np.clip(c,0,scene.w-1)
    out=np.zeros((h,w,4),dtype=np.uint8)
    if classes:
        out[np.isfinite(scene.trees[r,c])]=[66,212,135,160]
        out[np.isfinite(scene.buildings[r,c])]=[85,145,215,180]
        out[np.isfinite(scene.unknown[r,c])]=[163,169,181,160]
        out[~np.isfinite(scene.ground[r,c]) | scene.uncertain[r,c]]=[120,130,147,160]
    else:
        out[:,:,:3]=scene.rgb[r,c]; out[:,:,3]=255
    out[~inside]=0
    b=io.BytesIO(); Image.fromarray(out).save(b,format='PNG'); return b.getvalue()


def scene_manifest(scene):
    """Return a compact JSON-safe scene for the browser engine."""
    def grid(values):
        values = np.asarray(values)
        if values.dtype == np.bool_:
            return values.tolist()
        rounded = np.round(values.astype(float), 3)
        result = rounded.astype(object)
        result[~np.isfinite(rounded)] = None
        return result.tolist()

    return {
        'meta': scene.meta,
        'ground': grid(scene.ground),
        'buildings': grid(scene.buildings),
        'trees': grid(scene.trees),
        'unknown': grid(scene.unknown),
        'uncertain': grid(scene.uncertain),
    }
