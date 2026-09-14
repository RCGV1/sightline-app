/**
 * Sightline Engine — Browser (Static) Port
 * =========================================
 * ES module that mirrors `engine.py` math in the browser without NumPy/pyproj.
 *
 * The Python engine remains the canonical server implementation (`engine.py`).
 * Static releases bundle a generated `scene.json` and use this module to run
 * path and viewshed analysis entirely in the browser.
 *
 * Data loading:
 *   - `Scene.load('./static/scene.json')` powers the no-server release made by
 *     `build_static.py`.
 *   - `Scene.fromObjects(...)` accepts an already materialized scene.
 *   - Direct `.npz` loading is intentionally unsupported in browsers; the
 *     release builder converts NPZ rasters to JSON ahead of time.
 *   - `Scene.load()` supports two practical paths:
 *     1. `Scene.fromObjects({ ground, buildings, trees, unknown, uncertain, rgb, meta })`
 *        where each raster is a 2-D JS array `arr[row][col]` (NaN = nodata)
 *        plus `meta = { xmin, ymax, resolution_m, crs, bounds, ... }`. This is
 *        the path used by the generated JSON manifest.
 *     2. `Scene.load(url)` — fetches `url`. If the URL ends in `.json` it is
 *        treated as a JSON manifest. If it ends in `.npz` it fetches an
 *        ArrayBuffer and throws a descriptive conversion error.
 *
 * CRS / projection note:
 *   - Python uses `pyproj.Transformer` (EPSG:4326 <-> scene CRS, typically
 *     EPSG:32610/326xx UTM). The browser build does NOT bundle `proj4` by
 *     default to keep the static bundle small.
 *   - `Scene.xy()` / `Scene.toLL()` will use `window.proj4` / global `proj4`
 *     if it is loaded (e.g. `<script src="https://cdn.../proj4.js">`), else
 *     falls back to an equirectangular linear interpolation derived from
 *     `meta.bounds` <-> `meta.xmin/ymax + w*h*res`. That fallback is accurate
 *     to ~0.1% over typical <15 km scenes; for long corridors validate against
 *     the Python server.
 *   - Distance `d` inside `trace()` is Euclidean in the scene's projected
 *     metres (same as `math.dist(a, b)` in Python). Bearing/azimuth uses a
 *     spherical haversine approximation (see `geodInv`) when `proj4` is absent;
 *     the spec explicitly allows this. Wave/fresnel/foliage/link-budget
 *     formulas are kept identical to `engine.py`.
 *
 * Usage (ES module):
 *   import { Scene, trace, intervals, settings, analyze, viewshed } from './engine.js';
 *   const scene = Scene.fromObjects({ ground, buildings, trees, unknown, meta });
 *   const opts = settings({ mode:'radio', frequency_mhz:5800, height_a:10, height_b:10 });
 *   const res = trace(scene, [x0,y0], [x1,y1], opts);
 *
 *   const scene2 = await Scene.load('./static/scene.json');
 *
 * Formulas kept identical to Python:
 *   EARTH_RADIUS = 6371008.8, curvature = d*d / (2*R*k), ray(t)=z0+(z1-z0)*t - curvature*t*(1-t),
 *   wave = 299.792458/freq_MHz, fresnel=sqrt(wave*d*t*(1-t)), foliage cap 25 dB (+3*log10 tail, cap 35),
 *   atmospheric = min(2, d/1000*0.006).
 */

export const EARTH_RADIUS = 6371008.8;
export const MAX_VIEWSHED_SIDE = 100;

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function toFinite(v) {
  return isFiniteNumber(v) ? v : NaN;
}
function hypot(a, b) {
  return Math.hypot(a, b);
}
function dist2(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// ---------------------------------------------------------------------------
// Geodesy — haversine / spherical bearing fallback (GEOD replacement)
// ---------------------------------------------------------------------------
/**
 * Spherical inverse — returns [az12_deg, az21_deg, s12_m].
 * Uses mean earth radius; matches pyproj.Geod(ellps='WGS84') to <0.4% over
 * short distances, which is acceptable for the "equirectangular fallback"
 * permitted by the spec. If `proj4` is present azimuth is still derived
 * via this spherical formula (full ellipsoidal Vincenty would require a
 * dedicated geodesy lib).
 */
export function geodInv(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dLam = (lon2 - lon1) * toRad;
  // bearing 1->2
  const y1 = Math.sin(dLam) * Math.cos(phi2);
  const x1 = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  let az12 = Math.atan2(y1, x1) * toDeg;
  // bearing 2->1
  const y2 = Math.sin(-dLam) * Math.cos(phi1);
  const x2 = Math.cos(phi2) * Math.sin(phi1) - Math.sin(phi2) * Math.cos(phi1) * Math.cos(-dLam);
  let az21 = Math.atan2(y2, x2) * toDeg;
  az12 = (az12 + 360) % 360;
  az21 = (az21 + 360) % 360;
  // haversine distance (spherical)
  const dPhi = phi2 - phi1;
  const aHav = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(aHav)));
  const s12 = EARTH_RADIUS * c;
  return [az12, az21, s12];
}

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
export class Scene {
  /**
   * @param {object} obj
   * @param {number[][]} obj.ground - 2-D array [row][col] float, NaN = nodata
   * @param {number[][]} obj.buildings - 2-D, NaN = none
   * @param {number[][]} obj.trees - 2-D, NaN = none (canopy top)
   * @param {number[][]} obj.unknown - 2-D, NaN = none
   * @param {number[][]|null} obj.rgb - optional [h][w][3] uint8
   * @param {object} obj.meta - { xmin, ymax, resolution_m, crs, bounds: [[south,west],[north,east]], ... }
   * @param {boolean[][]|null} obj.uncertain - optional terrain/building uncertainty
   * @param {boolean[][]|null} obj.canopy_uncertain - optional canopy-source uncertainty
   */
  constructor({ ground, buildings, trees, unknown, rgb = null, meta, uncertain = null, canopy_uncertain = null }) {
    if (!ground || !buildings || !trees || !unknown || !meta) {
      throw new Error('Scene requires ground, buildings, trees, unknown, meta');
    }
    this.ground = ground;
    this.buildings = buildings;
    this.trees = trees;
    this.unknown = unknown;
    this.rgb = rgb;
    this.meta = meta;
    this.res = Number(meta.resolution_m);
    if (!Number.isFinite(this.res) || this.res <= 0) throw new Error('meta.resolution_m must be finite >0');
    // support both 2-D nested arrays and flat typed arrays with known dims
    this.h = ground.length;
    this.w = ground[0] ? ground[0].length : 0;
    if (uncertain) {
      this.uncertain = uncertain;
    } else {
      this.uncertain = Array.from({ length: this.h }, () => Array(this.w).fill(false));
    }
    this.canopyUncertain = canopy_uncertain || Array.from({ length: this.h }, () => Array(this.w).fill(false));
    // xmax / ymin derived for fallback projection
    this.xmax = Number(meta.xmin) + this.w * this.res;
    this.ymin = Number(meta.ymax) - this.h * this.res;
  }

  // ---- factory helpers ----------------------------------------------------
  static fromObjects(obj) {
    return new Scene(obj);
  }

  /**
   * Load a scene from a URL.
   *
   * - If the URL ends with `.json`, it is fetched as JSON with shape
   *   `{ ground, buildings, trees, unknown, uncertain?, rgb?, meta }` where
   *   each raster is a 2-D array. This is the recommended "static manifest"
   *   path: have your server expose `/data/active.json` that mirrors the
   *   `.npz` contents as JSON (or use `/api/meta` + custom raster endpoint).
   * - If the URL ends with `.npz`, the binary is fetched as ArrayBuffer and
   *   a TODO error is thrown. A complete implementation would unzip the NPZ
   *   (ZIP) and parse each `.npy` entry (see TODO below). For now callers
   *   should use the JSON manifest path or keep using the Python server.
   *
   * For backwards-compat the method also accepts a plain object (already
   * parsed JSON) and wraps it via `fromObjects`.
   *
   * In the "server still required" deployment you normally do NOT call this
   * from the browser — instead `app.js` calls `GET /api/meta` and
   * `POST /api/los`. This loader exists so a future static-only build can
   * materialise a Scene without Python.
   */
  static async load(urlOrObject) {
    if (urlOrObject && typeof urlOrObject === 'object' && !Array.isArray(urlOrObject) && !(urlOrObject instanceof ArrayBuffer)) {
      // heuristic: if it looks like a scene dict, wrap it
      if (urlOrObject.ground && urlOrObject.meta) return Scene.fromObjects(urlOrObject);
    }
    const url = String(urlOrObject);
    if (url.endsWith('.json')) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Scene.load: fetch ${url} failed (${res.status})`);
      const data = await res.json();
      // allow both { scene: {...} } and bare {...}
      const obj = data.scene || data;
      return Scene.fromObjects(obj);
    }
    if (url.endsWith('.npz')) {
      // TODO: implement NPZ (ZIP + NPY) parsing in JS.
      // NPZ is a ZIP archive containing NPY files named `ground.npy`,
      // `buildings.npy`, etc. plus `meta.npy` (JSON string). A full port
      // would:
      //   1. fetch ArrayBuffer
      //   2. unzip via `fflate` (or similar) to entries
      //   3. parse each NPY header (dtype, shape, fortran_order) then
      //      decode float32/int8 payloads into 2-D JS arrays
      //   4. JSON.parse the `meta` entry
      // This is ~150 LOC and pulls in a ZIP dependency, so it is stubbed
      // for Option B. Until then, expose a JSON endpoint on the server
      // (e.g. `/data/active.npz` -> JSON via a small Python route) or use
      // `Scene.fromObjects()` with data injected at build time.
      //
      // We still fetch the bytes so the error surfaces as a network issue
      // vs. a logic bug, then throw with actionable guidance.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Scene.load: fetch ${url} failed (${res.status})`);
      await res.arrayBuffer(); // consumed for error path clarity
      throw new Error(
        'Scene.load(.npz): binary NPZ parsing is not implemented in this static build. ' +
        'Serve a JSON manifest instead (e.g. GET /data/active.json or GET /api/meta + raster tiles) ' +
        'and call Scene.load("/data/active.json") or Scene.fromObjects({...}). ' +
        'See engine.js header comment for the Option B roadmap.'
      );
    }
    // generic fetch-JSON fallback
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Scene.load: fetch ${url} failed (${res.status})`);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await res.json();
      const obj = data.scene || data;
      if (obj.ground && obj.meta) return Scene.fromObjects(obj);
      // maybe it's the /api/meta shape — caller still needs rasters; error clearly
      throw new Error('Scene.load: URL returned JSON without raster arrays (ground/meta). Expose a full manifest or use Scene.fromObjects().');
    }
    throw new Error(`Scene.load: unsupported URL/content-type for ${url} (expected .json manifest or .npz with TODO parser)`);
  }

  // ---- coordinate helpers -------------------------------------------------
  _getProj4() {
    if (typeof globalThis !== 'undefined' && globalThis.proj4) return globalThis.proj4;
    // eslint-disable-next-line no-undef
    if (typeof proj4 !== 'undefined') return proj4;
    return null;
  }

  /**
   * Convert [lat, lon] -> [x, y] in scene CRS metres.
   * Uses proj4 if available, otherwise linear interpolation from bounds.
   */
  xy(latlon) {
    if (!Array.isArray(latlon) || latlon.length !== 2) throw new Error('Coordinates must be [latitude, longitude].');
    const lat = Number(latlon[0]);
    let lon = Number(latlon[1]);
    if (!Number.isFinite(lat + lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new Error('Invalid latitude or longitude.');
    }
    const p4 = this._getProj4();
    if (p4) {
      try {
        const crs = this.meta.crs || 'EPSG:32610';
        const [x, y] = p4('EPSG:4326', crs, [lon, lat]);
        return [x, y];
      } catch (_) {
        // fall through to linear fallback
      }
    }
    // Linear fallback: map lon/lat linearly between bounds <-> projected extent
    const b = this.meta.bounds;
    if (!b || b.length !== 2) throw new Error('Scene meta.bounds required for xy() without proj4');
    const south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
    if (this.meta.longitude_wrap) {
      while (lon < west) lon += 360;
      while (lon > east) lon -= 360;
    }
    const lonSpan = east - west;
    const latSpan = north - south;
    if (Math.abs(lonSpan) < 1e-12 || Math.abs(latSpan) < 1e-12) throw new Error('Invalid bounds for xy()');
    const x = Number(this.meta.xmin) + ((lon - west) / lonSpan) * (this.w * this.res);
    // y decreases as lat increases: ymax at north
    const y = Number(this.meta.ymax) - ((north - lat) / latSpan) * (this.h * this.res);
    return [x, y];
  }

  /** Convert [x, y] -> [lon, lat] (inverse of xy). */
  toLL(x, y) {
    const p4 = this._getProj4();
    if (p4) {
      try {
        const crs = this.meta.crs || 'EPSG:32610';
        const [lon, lat] = p4(crs, 'EPSG:4326', [x, y]);
        return [lon, lat];
      } catch (_) {}
    }
    const b = this.meta.bounds;
    if (!b || b.length !== 2) throw new Error('Scene meta.bounds required for toLL() without proj4');
    const south = b[0][0], west = b[0][1], north = b[1][0], east = b[1][1];
    const lonSpan = east - west;
    const latSpan = north - south;
    let lon = west + ((x - Number(this.meta.xmin)) / (this.w * this.res)) * lonSpan;
    if (this.meta.longitude_wrap) lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const lat = north - ((Number(this.meta.ymax) - y) / (this.h * this.res)) * latSpan;
    return [lon, lat];
  }

  /** Compat alias matching Python `to_ll.transform(x,y) -> (lon,lat)` shape. */
  to_ll_transform(x, y) {
    return this.toLL(x, y);
  }

  cell(x, y) {
    const rf = (Number(this.meta.ymax) - y) / this.res;
    const cf = (x - Number(this.meta.xmin)) / this.res;
    const eps = 1e-6;
    let r, c;
    if (-eps <= rf && rf < 0) r = 0;
    else if (this.h <= rf && rf <= this.h + eps) r = this.h - 1;
    else r = Math.floor(rf);
    if (-eps <= cf && cf < 0) c = 0;
    else if (this.w <= cf && cf <= this.w + eps) c = this.w - 1;
    else c = Math.floor(cf);
    return [r, c];
  }

  groundAt(x, y) {
    const [r, c] = this.cell(x, y);
    if (!(r >= 0 && r < this.h && c >= 0 && c < this.w)) {
      throw new Error('Endpoint is outside measured terrain coverage. Move it inside the data footprint.');
    }
    const v = this.ground[r][c];
    if (!Number.isFinite(v)) {
      throw new Error('Endpoint is outside measured terrain coverage. Move it inside the data footprint.');
    }
    return Number(v);
  }
  // alias matching Python name
  ground_at(x, y) { return this.groundAt(x, y); }
}

// ---------------------------------------------------------------------------
// settings / number validation  (mirrors engine.py)
// ---------------------------------------------------------------------------
function number(params, key, def, low, high) {
  let raw = params[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) raw = def;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < low || value > high) {
    throw new Error(`${key} must be between ${low} and ${high}.`);
  }
  return value;
}

export function settings(p = {}) {
  const mode = p.mode || 'radio';
  if (mode !== 'radio' && mode !== 'optical') throw new Error('Mode must be radio or optical.');
  const mount_a = p.mount_type_a || 'agl';
  if (mount_a !== 'agl' && mount_a !== 'rooftop') throw new Error('mount_type_a must be agl or rooftop.');
  const mount_b = p.mount_type_b || 'agl';
  if (mount_b !== 'agl' && mount_b !== 'rooftop') throw new Error('mount_type_b must be agl or rooftop.');
  let target_h = 10.0;
  if (p.target_agl !== undefined && p.target_agl !== null && String(p.target_agl).trim() !== '') {
    target_h = number(p, 'target_agl', 10, 0.01, 100000);
  } else if (p.height_b !== undefined && p.height_b !== null && String(p.height_b).trim() !== '') {
    target_h = number(p, 'height_b', 10, 0.01, 100000);
  }
  const cfg = {
    height_a: number(p, 'height_a', 10, 0.01, 100000),
    height_b: target_h,
    target_agl: target_h,
    mount_type_a: mount_a,
    mount_type_b: mount_b,
    target_surface: (p.target_surface === 'surface' || p.target_surface === 'ground') ? p.target_surface : null,
    frequency_mhz: mode === 'optical' ? 915 : number(p, 'frequency_mhz', 915, 0.1, 1000000),
    k_factor: mode === 'optical' ? 1.0 : number(p, 'k_factor', 4 / 3, 0.1, 10),
    foliage_db_m: mode === 'optical' ? 0 : number(p, 'foliage_db_m', 0.2, 0, 100),
    include_foliage: p.include_foliage !== false,
    mode,
  };
  if (mode === 'radio') {
    const hasRx = p.rx_sensitivity_dbm !== undefined && p.rx_sensitivity_dbm !== null && String(p.rx_sensitivity_dbm).trim() !== '';
    cfg.tx_power_dbm = number(p, 'tx_power_dbm', 20.0, -10, 45);
    cfg.antenna_gain_a_dbi = number(p, 'antenna_gain_a_dbi', 23.0, 0, 50);
    cfg.antenna_gain_b_dbi = number(p, 'antenna_gain_b_dbi', 23.0, 0, 50);
    cfg.cable_loss_a_db = number(p, 'cable_loss_a_db', 1.0, 0, 20);
    cfg.cable_loss_b_db = number(p, 'cable_loss_b_db', 1.0, 0, 20);
    cfg.channel_width_mhz = number(p, 'channel_width_mhz', 20.0, 0.1, 320);
    cfg.noise_figure_db = number(p, 'noise_figure_db', 5.0, 0, 30);
    cfg.required_snr_db = number(p, 'required_snr_db', 15.0, 0, 60);
    cfg.rx_sensitivity_dbm = hasRx ? number(p, 'rx_sensitivity_dbm', -82.0, -130, -30) : null;
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// intervals — conservative 2.5D cell traversal (positive-length cells only)
// ---------------------------------------------------------------------------
export function intervals(scene, a, b) {
  const x0 = a[0], y0 = a[1], x1 = b[0], y1 = b[1];
  const breaks = [0, 1];
  const pairs = [
    [x0, x1, Number(scene.meta.xmin)],
    [y0, y1, Number(scene.meta.ymax)],
  ];
  for (const [start, end, origin] of pairs) {
    if (Math.abs(end - start) < 1e-10) continue;
    const loF = (start - origin) / scene.res;
    const hiF = (end - origin) / scene.res;
    const lo = Math.min(loF, hiF);
    const hi = Math.max(loF, hiF);
    const startEdge = Math.floor(lo) + 1;
    const endEdge = Math.ceil(hi); // exclusive upper like np.arange
    for (let k = startEdge; k < endEdge; k++) {
      const edge = origin + k * scene.res;
      const bVal = (edge - start) / (end - start);
      if (bVal > 1e-9 && bVal < 1 - 1e-9) breaks.push(bVal);
    }
  }
  breaks.sort((p, q) => p - q);
  // unique with tolerance (mirrors np.unique)
  const EPS = 1e-12;
  const t = [];
  for (const v of breaks) {
    if (t.length === 0 || Math.abs(v - t[t.length - 1]) > EPS) t.push(v);
  }
  const n = t.length - 1;
  const lo = new Array(n);
  const hi = new Array(n);
  const rows = new Array(n);
  const cols = new Array(n);
  for (let i = 0; i < n; i++) {
    const t0 = t[i], t1 = t[i + 1];
    lo[i] = t0;
    hi[i] = t1;
    const mid = (t0 + t1) / 2;
    const xm = x0 + (x1 - x0) * mid;
    const ym = y0 + (y1 - y0) * mid;
    cols[i] = Math.floor((xm - Number(scene.meta.xmin)) / scene.res);
    rows[i] = Math.floor((Number(scene.meta.ymax) - ym) / scene.res);
  }
  return [lo, hi, rows, cols];
}

// ---------------------------------------------------------------------------
// trace — identical formulas to engine.py
// ---------------------------------------------------------------------------
export function trace(scene, a, b, opts, detailed = true) {
  const d = dist2(a, b);
  if (d < 0.01) throw new Error('Choose two distinct endpoints (at least 1 cm apart).');

  const g_a = scene.groundAt(a[0], a[1]);
  const [r_a, c_a] = scene.cell(a[0], a[1]);
  const b_a = (r_a >= 0 && r_a < scene.h && c_a >= 0 && c_a < scene.w) ? toFinite(scene.buildings[r_a][c_a]) : NaN;
  let base_a, struct_a, eff_mount_a;
  if (opts.mount_type_a === 'rooftop' && Number.isFinite(b_a) && b_a > g_a) {
    base_a = Number(b_a); struct_a = Number(b_a - g_a); eff_mount_a = 'rooftop';
  } else {
    base_a = g_a; struct_a = 0; eff_mount_a = 'agl';
  }
  const z0 = base_a + opts.height_a;

  const g_b = scene.groundAt(b[0], b[1]);
  const [r_b, c_b] = scene.cell(b[0], b[1]);
  const b_b = (r_b >= 0 && r_b < scene.h && c_b >= 0 && c_b < scene.w) ? toFinite(scene.buildings[r_b][c_b]) : NaN;
  const use_rooftop_b = (opts.mount_type_b === 'rooftop') || (opts.target_surface === 'surface' && Number.isFinite(b_b) && b_b > g_b);
  let base_b, struct_b, eff_mount_b;
  if (use_rooftop_b && Number.isFinite(b_b) && b_b > g_b) {
    base_b = Number(b_b); struct_b = Number(b_b - g_b); eff_mount_b = 'rooftop';
  } else {
    base_b = g_b; struct_b = 0; eff_mount_b = 'agl';
  }
  const z1 = base_b + opts.height_b;

  const [lo, hi, rows, cols] = intervals(scene, a, b);
  const n = lo.length;

  // gather per-cell values (clipped indices like Python np.clip)
  const inside = new Array(n);
  const g = new Array(n);
  const buildings = new Array(n);
  const trees = new Array(n);
  const unknown = new Array(n);
  const valid = new Array(n);
  const rr = new Array(n);
  const cc = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i], c = cols[i];
    inside[i] = r >= 0 && r < scene.h && c >= 0 && c < scene.w;
    const rCl = Math.max(0, Math.min(scene.h - 1, r));
    const cCl = Math.max(0, Math.min(scene.w - 1, c));
    rr[i] = rCl; cc[i] = cCl;
    g[i] = toFinite(scene.ground[rCl][cCl]);
    buildings[i] = toFinite(scene.buildings[rCl][cCl]);
    trees[i] = toFinite(scene.trees[rCl][cCl]);
    unknown[i] = toFinite(scene.unknown[rCl][cCl]);
    valid[i] = inside[i] && Number.isFinite(g[i]);
  }

  const curvature = (d * d) / (2 * EARTH_RADIUS * opts.k_factor);
  function ray(t) { return z0 + (z1 - z0) * t - curvature * t * (1 - t); }

  const minimum = new Array(n);
  const hard = new Array(n);
  for (let i = 0; i < n; i++) {
    const li = lo[i], hi_ = hi[i];
    let vertex;
    if (curvature) {
      const v = (curvature - (z1 - z0)) / (2 * curvature);
      vertex = Math.max(li, Math.min(hi_, v));
    } else {
      vertex = li;
    }
    minimum[i] = Math.min(ray(li), ray(hi_), ray(vertex));
    const gv = g[i], bv = buildings[i];
    // np.fmax(g, buildings) -> elementwise max ignoring NaN? In numpy, fmax returns the non-NaN when one is NaN.
    // Python hard = np.fmax(g, buildings) . For valid cells g is finite. So hard = max(g, buildings) if buildings finite else g.
    if (!Number.isFinite(gv)) hard[i] = bv;
    else if (!Number.isFinite(bv)) hard[i] = gv;
    else hard[i] = Math.max(gv, bv);
  }
  // The antenna starts above its own roof, so normal roof checks let it leave
  // naturally while preserving the source building as solid geometry.
  const clearances = minimum.map((value, i) => value - hard[i]);

  let blocked = valid.some((v, i) => v && clearances[i] <= 0);
  if (opts.target_surface === 'ground' && Number.isFinite(b_b)) {
    blocked = true;
  }

  // unknown_hit: ~valid OR uncertain[rr,cc] OR minimum <= unknown (where unknown finite)
  let unknown_hit = false;
  for (let i = 0; i < n; i++) {
    if (!valid[i]) { unknown_hit = true; break; }
    if (scene.uncertain[rr[i]][cc[i]] || (opts.include_foliage && scene.canopyUncertain[rr[i]][cc[i]])) { unknown_hit = true; break; }
    if (Number.isFinite(unknown[i]) && minimum[i] <= unknown[i]) { unknown_hit = true; break; }
  }
  if (!detailed && blocked) {
    return { status: 'blocked', direct_status: 'blocked', foliage_m: 0 };
  }

  // foliage integration — exact path length inside ground-to-canopy envelope
  const foliage_fraction = new Array(n).fill(0);
  for (let i = 0; opts.include_foliage && i < n; i++) {
    if (!(valid[i] && Number.isFinite(trees[i]) && minimum[i] < trees[i])) continue;
    const cuts = [Number(lo[i]), Number(hi[i])];
    for (const surface of [g[i], trees[i]]) {
      if (curvature > 1e-12) {
        const disc = (z1 - z0 - curvature) ** 2 - 4 * curvature * (z0 - surface);
        if (disc >= 0) {
          const sqrtD = Math.sqrt(disc);
          const r1 = (-(z1 - z0 - curvature) - sqrtD) / (2 * curvature);
          const r2 = (-(z1 - z0 - curvature) + sqrtD) / (2 * curvature);
          if (r1 > lo[i] && r1 < hi[i]) cuts.push(r1);
          if (r2 > lo[i] && r2 < hi[i]) cuts.push(r2);
        }
      } else if (z1 !== z0) {
        const r_ = (surface - z0) / (z1 - z0);
        if (r_ > lo[i] && r_ < hi[i]) cuts.push(r_);
      }
    }
    cuts.sort((p, q) => p - q);
    let sum = 0;
    for (let k = 0; k < cuts.length - 1; k++) {
      const u = cuts[k], v = cuts[k + 1];
      const mid = (u + v) / 2;
      const rv = ray(mid);
      if (g[i] <= rv && rv <= trees[i]) sum += (v - u);
    }
    foliage_fraction[i] = sum;
  }
  const foliageFracSum = foliage_fraction.reduce((s, v) => s + v, 0);
  const foliage_m = foliageFracSum * hypot(d, z1 - z0);
  let blockedFinal = blocked;
  if (opts.mode === 'optical' && foliage_m > 0) blockedFinal = true;
  const direct_status = blockedFinal ? 'blocked' : unknown_hit ? 'unknown' : foliage_m > 0 ? 'foliage' : 'clear';

  // Fresnel clearance — 3 samples per cell (lo, mid, hi)
  const wave = 299.792458 / opts.frequency_mhz;
  const fclear = []; // n x 3
  for (let i = 0; i < n; i++) {
    const samples = [lo[i], (lo[i] + hi[i]) / 2, hi[i]];
    const row = [];
    for (const s of samples) {
      const fres = Math.sqrt(Math.max(0, wave * d * s * (1 - s)));
      row.push(ray(s) - hard[i] - 0.6 * fres);
    }
    fclear.push(row);
  }
  let fresnel_intrusion = false;
  if (opts.mode === 'radio') {
    outer: for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      for (let j = 0; j < 3; j++) if (fclear[i][j] < 0) { fresnel_intrusion = true; break outer; }
    }
  }
  if (opts.mode === 'radio') {
    // unknown in 60% fresnel envelope
    outer2: for (let i = 0; i < n; i++) {
      if (!Number.isFinite(unknown[i])) continue;
      for (let j = 0; j < 3; j++) {
        const s = [lo[i], (lo[i] + hi[i]) / 2, hi[i]][j];
        const fres = Math.sqrt(Math.max(0, wave * d * s * (1 - s)));
        if (ray(s) - 0.6 * fres <= unknown[i]) { unknown_hit = true; break outer2; }
      }
    }
  }
  const status = blockedFinal ? 'blocked' : unknown_hit ? 'unknown' : fresnel_intrusion ? 'fresnel' : foliage_m > 0 ? 'foliage' : 'clear';

  if (!detailed) {
    return { status, direct_status, foliage_m };
  }

  // Alignment (azimuth / tilt)
  const [lon_a, lat_a] = scene.toLL(a[0], a[1]);
  const [lon_b, lat_b] = scene.toLL(b[0], b[1]);
  let az_ab, az_ba;
  [az_ab, az_ba] = geodInv(lon_a, lat_a, lon_b, lat_b);
  const curv_drop = (d * d) / (2 * EARTH_RADIUS * opts.k_factor);
  const tilt_ab = Math.atan2((z1 - z0) - curv_drop, d) * 180 / Math.PI;
  const tilt_ba = Math.atan2((z0 - z1) - curv_drop, d) * 180 / Math.PI;
  const d_3d = hypot(d, z1 - z0);

  // Critical obstacle
  let crit_obs = null;
  if (valid.some(Boolean)) {
    // argmin clearances among valid
    let i_crit, t_crit, dist_crit, ray_at_crit, min_clr, obs_type, obs_elev;
    const tree_blocked_optical = (opts.mode === 'optical' && foliage_m > 0 && !valid.some((v, i) => v && clearances[i] <= 0));
    if (tree_blocked_optical) {
      let maxPen = -Infinity, bestTreeIdx = -1;
      for (let i = 0; i < n; i++) {
        if (valid[i] && Number.isFinite(trees[i]) && foliage_fraction[i] > 0) {
          const tMid = (lo[i] + hi[i]) / 2;
          const pen = trees[i] - ray(tMid);
          if (pen > maxPen) { maxPen = pen; bestTreeIdx = i; }
        }
      }
      i_crit = bestTreeIdx >= 0 ? bestTreeIdx : 0;
      t_crit = (lo[i_crit] + hi[i_crit]) / 2;
      dist_crit = t_crit * d;
      ray_at_crit = ray(t_crit);
      obs_type = 'tree';
      obs_elev = Number(trees[i_crit]);
      min_clr = Number(ray_at_crit - obs_elev);
    } else {
      let bestIdx = -1, bestClr = Infinity;
      for (let i = 0; i < n; i++) if (valid[i] && clearances[i] < bestClr) { bestClr = clearances[i]; bestIdx = i; }
      i_crit = bestIdx;
      t_crit = (lo[i_crit] + hi[i_crit]) / 2;
      dist_crit = t_crit * d;
      min_clr = clearances[i_crit];
      ray_at_crit = ray(t_crit);
      const hard_at_crit = hard[i_crit];
      if (ray_at_crit <= g[i_crit]) {
        obs_type = 'terrain';
        obs_elev = Number(g[i_crit]);
      } else if (Number.isFinite(buildings[i_crit]) && buildings[i_crit] > g[i_crit] && ray_at_crit <= buildings[i_crit]) {
        obs_type = 'building';
        obs_elev = Number(buildings[i_crit]);
      } else if (Number.isFinite(trees[i_crit]) && trees[i_crit] > g[i_crit] && ray_at_crit <= trees[i_crit]) {
        obs_type = 'tree';
        obs_elev = Number(trees[i_crit]);
      } else if (Number.isFinite(unknown[i_crit]) && ray_at_crit <= unknown[i_crit] && unknown[i_crit] > hard_at_crit + 0.5) {
        obs_type = 'unknown';
        obs_elev = Number(unknown[i_crit]);
      } else if (clearances[i_crit] <= 0) {
        obs_type = (Number.isFinite(buildings[i_crit]) && buildings[i_crit] > g[i_crit]) ? 'building' : 'terrain';
        obs_elev = Number(hard_at_crit);
      } else {
        if (Number.isFinite(buildings[i_crit]) && buildings[i_crit] > g[i_crit]) {
          obs_type = 'building';
          obs_elev = Number(buildings[i_crit]);
        } else {
          obs_type = 'terrain';
          obs_elev = Number(g[i_crit]);
        }
      }
    }
    const deficit = Math.max(0, -min_clr);
    const req_both = deficit;
    const req_a = deficit / Math.max(0.01, (1 - t_crit));
    const req_b = deficit / Math.max(0.01, t_crit);
    const fres_at_crit = opts.mode === 'radio' ? Math.sqrt(Math.max(0, wave * d * t_crit * (1 - t_crit))) : 0;
    const fclear_crit = opts.mode === 'radio' ? ray_at_crit - hard[i_crit] - 0.6 * fres_at_crit : min_clr;
    // fres_deficit: max(0, -min fclear[valid])
    let fres_deficit = 0;
    if (valid.some(Boolean) && opts.mode === 'radio' && !unknown_hit) {
      let minF = Infinity;
      for (let i = 0; i < n; i++) if (valid[i]) for (const v of fclear[i]) if (v < minF) minF = v;
      fres_deficit = Math.max(0, -minF);
      if (!Number.isFinite(fres_deficit)) fres_deficit = 0;
    }
    crit_obs = {
      distance_m: Number(dist_crit),
      fraction: Number(t_crit),
      obstacle_type: obs_type,
      obstacle_elevation_m: Number(obs_elev),
      ray_elevation_m: Number(ray_at_crit),
      clearance_m: Number(min_clr),
      fresnel_clearance_m: opts.mode === 'radio' ? Number(fclear_crit) : null,
      required_clearance_height_both_m: Number(req_both),
      required_clearance_height_a_m: Number(req_a),
      required_clearance_height_b_m: Number(req_b),
      required_fresnel_height_both_m: Number(fres_deficit),
    };
  }

  const notes = [];
  if (unknown_hit) notes.push('The path contains missing terrain or an unclassified obstruction; clear visibility cannot be established there.');
  if (foliage_m > 0) notes.push('Trees are modeled as solid ground-to-canopy envelopes. Foliage loss is a user-selected dB/m scenario, not a calibrated propagation prediction.');
  if (fresnel_intrusion) notes.push('The sampled 60% first Fresnel zone intersects terrain/buildings, even if the direct ray is clear.');
  if (d > 50000) notes.push('Long path: local projection and effective-Earth approximations need independent validation.');

  let link_budget = null;
  let viability = null;
  if (opts.mode === 'radio') {
    const fspl = 20 * Math.log10(4 * Math.PI * d_3d / wave);
    const raw_foliage = foliage_m * opts.foliage_db_m;
    let foliage_loss = raw_foliage <= 25 ? raw_foliage : 25 + 3 * Math.log10(1 + (raw_foliage - 25));
    foliage_loss = Math.min(foliage_loss, 35);
    const atmos_db = Math.min(2, d / 1000 * 0.006);
    const total_loss = fspl + foliage_loss + atmos_db;
    const tx_eirp = opts.tx_power_dbm - opts.cable_loss_a_db + opts.antenna_gain_a_dbi;
    const rx_power = tx_eirp - total_loss - opts.cable_loss_b_db + opts.antenna_gain_b_dbi;
    const bw_hz = opts.channel_width_mhz * 1e6;
    const noise_floor = -174 + 10 * Math.log10(bw_hz) + opts.noise_figure_db;
    const sensitivity = opts.rx_sensitivity_dbm !== null && opts.rx_sensitivity_dbm !== undefined
      ? opts.rx_sensitivity_dbm
      : (noise_floor + opts.required_snr_db);
    const link_margin = rx_power - sensitivity;
    const snr = rx_power - noise_floor;

    if (blockedFinal) viability = 'blocked';
    else if (unknown_hit) viability = 'unknown';
    else if (link_margin >= 10) viability = (fresnel_intrusion || foliage_m > 0) ? 'marginal' : 'viable';
    else if (link_margin >= 0) viability = 'marginal';
    else viability = 'deficit';

    if (viability === 'deficit') notes.push(`Link budget deficit: Received signal level (${rx_power.toFixed(1)} dBm) is ${Math.abs(link_margin).toFixed(1)} dB below receiver threshold (${sensitivity.toFixed(1)} dBm). Link cannot close.`);
    else if (viability === 'marginal') notes.push(`Marginal link: Fade margin (${link_margin.toFixed(1)} dB) provides limited buffer (<10 dB) against weather, multipath, or foliage attenuation.`);

    link_budget = {
      tx_power_dbm: opts.tx_power_dbm,
      antenna_gain_a_dbi: opts.antenna_gain_a_dbi,
      antenna_gain_b_dbi: opts.antenna_gain_b_dbi,
      cable_loss_a_db: opts.cable_loss_a_db,
      cable_loss_b_db: opts.cable_loss_b_db,
      channel_width_mhz: opts.channel_width_mhz,
      eirp_dbm: tx_eirp,
      free_space_loss_db: fspl,
      foliage_loss_db: foliage_loss,
      foliage_raw_loss_db: raw_foliage,
      atmospheric_loss_db: atmos_db,
      total_path_loss_db: total_loss,
      rx_power_dbm: rx_power,
      thermal_noise_dbm: noise_floor,
      rx_sensitivity_dbm: sensitivity,
      link_margin_db: link_margin,
      snr_db: snr,
      viability,
    };
  }

  // min clearance helpers
  let min_clearance_m = null;
  if (valid.some(Boolean)) {
    let m = Infinity;
    for (let i = 0; i < n; i++) if (valid[i] && clearances[i] < m) m = clearances[i];
    min_clearance_m = Number.isFinite(m) ? m : null;
  }
  let min_fresnel_clearance_m = null;
  if (valid.some(Boolean) && opts.mode === 'radio' && !unknown_hit) {
    let m = Infinity;
    for (let i = 0; i < n; i++) if (valid[i]) for (const v of fclear[i]) if (v < m) m = v;
    min_fresnel_clearance_m = Number.isFinite(m) ? m : null;
  }

  const result = {
    a, b,
    status,
    direct_status,
    viability,
    distance_m: d,
    distance_3d_m: d_3d,
    foliage_m,
    foliage_loss_db: link_budget ? link_budget.foliage_loss_db : null,
    free_space_loss_db: link_budget ? link_budget.free_space_loss_db : null,
    min_clearance_m,
    min_fresnel_clearance_m,
    link_budget,
    alignment: {
      azimuth_a_to_b: az_ab,
      azimuth_b_to_a: az_ba,
      tilt_a_to_b: tilt_ab,
      tilt_b_to_a: tilt_ba,
    },
    mounts: {
      a: { mount_type: eff_mount_a, ground_elevation_m: g_a, base_elevation_m: base_a, structure_height_m: struct_a, mast_height_m: opts.height_a, total_elevation_m: z0 },
      b: { mount_type: eff_mount_b, ground_elevation_m: g_b, base_elevation_m: base_b, structure_height_m: struct_b, mast_height_m: opts.height_b, total_elevation_m: z1 },
    },
    critical_obstacle: crit_obs,
    notes,
  };

  // segments — priority: blocked > unknown > fresnel > foliage > clear
  const segments = [];
  if (n > 0) {
    let current = null;
    for (let i = 0; i < n; i++) {
      let c_status, c_obs, c_clr;
      if (!valid[i]) {
        c_status = 'unknown'; c_obs = 'unknown'; c_clr = 0;
      } else if (clearances[i] <= 0) {
        c_status = 'blocked';
        if (minimum[i] <= g[i]) {
          c_obs = 'terrain';
        } else if (Number.isFinite(buildings[i]) && buildings[i] > g[i] && minimum[i] <= buildings[i]) {
          c_obs = 'building';
        } else {
          c_obs = 'terrain';
        }
        c_clr = Number(clearances[i]);
      } else if (Number.isFinite(unknown[i]) && minimum[i] <= unknown[i]) {
        c_status = 'unknown'; c_obs = 'unknown'; c_clr = 0;
      } else if (opts.mode === 'radio' && fclear[i].some(v => v < 0)) {
        c_status = 'fresnel';
        c_obs = (Number.isFinite(buildings[i]) && buildings[i] > g[i]) ? 'building' : 'terrain';
        c_clr = Math.min(...fclear[i]);
      } else if (foliage_fraction[i] > 0) {
        c_status = 'foliage'; c_obs = 'tree'; c_clr = Number(clearances[i]);
      } else {
        c_status = 'clear'; c_obs = 'none'; c_clr = Number(clearances[i]);
      }
      const t_start = Number(lo[i]), t_end = Number(hi[i]);
      if (current === null) {
        current = { start_frac: t_start, end_frac: t_end, status: c_status, obstacle_type: c_obs, min_clearance_m: c_clr };
      } else if (current.status === c_status && (c_obs === current.obstacle_type || c_status === 'clear' || c_status === 'foliage')) {
        current.end_frac = t_end;
        current.min_clearance_m = Math.min(current.min_clearance_m, c_clr);
      } else {
        segments.push(current);
        current = { start_frac: t_start, end_frac: t_end, status: c_status, obstacle_type: c_obs, min_clearance_m: c_clr };
      }
    }
    if (current !== null) segments.push(current);

    for (const s of segments) {
      const t_s = s.start_frac, t_e = s.end_frac;
      s.start_m = Math.round(t_s * d * 10) / 10;
      s.end_m = Math.round(t_e * d * 10) / 10;
      const xs = a[0] + t_s * (b[0] - a[0]), ys = a[1] + t_s * (b[1] - a[1]);
      const xe = a[0] + t_e * (b[0] - a[0]), ye = a[1] + t_e * (b[1] - a[1]);
      const [lon_s, lat_s] = scene.toLL(xs, ys);
      const [lon_e, lat_e] = scene.toLL(xe, ye);
      s.start_ll = [Math.round(Number(lat_s) * 1e7) / 1e7, Math.round(Number(lon_s) * 1e7) / 1e7];
      s.end_ll = [Math.round(Number(lat_e) * 1e7) / 1e7, Math.round(Number(lon_e) * 1e7) / 1e7];
      s.start_frac = Math.round(t_s * 1e4) / 1e4;
      s.end_frac = Math.round(t_e * 1e4) / 1e4;
      s.min_clearance_m = Math.round(Number(s.min_clearance_m) * 100) / 100;
    }
  }
  result.segments = segments;

  if (detailed) {
    const profile = [];
    for (let i = 0; i < n; i++) {
      for (const t of [lo[i], hi[i]]) {
        const bulge = curvature * t * (1 - t);
        function elev(v) { return (valid[i] && Number.isFinite(v)) ? Number(v + bulge) : null; }
        const fres = opts.mode === 'radio' ? Math.sqrt(Math.max(0, wave * d * t * (1 - t))) : 0;
        const isUnknown = !valid[i] || Boolean(scene.uncertain[rr[i]][cc[i]]) || (opts.include_foliage && Boolean(scene.canopyUncertain[rr[i]][cc[i]])) || (Number.isFinite(unknown[i]) && minimum[i] <= unknown[i]);
        profile.push({
          distance_m: Number(t * d),
          ground_m: elev(g[i]),
          building_m: elev(buildings[i]),
          tree_m: elev(trees[i]),
          ray_m: Number(z0 + (z1 - z0) * t),
          fresnel_m: Number(fres),
          unknown: Boolean(isUnknown),
        });
      }
    }
    result.profile = profile;
  }
  return result;
}

// ---------------------------------------------------------------------------
// analyze — mirrors engine.analyze (xy conversion + settings wrapper)
// ---------------------------------------------------------------------------
export function analyze(scene, p) {
  const a = scene.xy(p.a);
  const b = scene.xy(p.b);
  const opts = settings(p);
  const result = trace(scene, a, b, opts, true);
  // mirror Python: overwrite a/b with original latlon, attach parameters/dataset
  result.a = p.a;
  result.b = p.b;
  result.parameters = opts;
  result.dataset = { name: scene.meta.name, source: scene.meta.source, resolution_m: scene.res };
  if (scene.meta.analysis_notes) result.notes = result.notes.concat(scene.meta.analysis_notes);
  return result;
}

// ---------------------------------------------------------------------------
// viewshed — mirrors engine.viewshed (360° sampling grid, red hit map / simple)
// ---------------------------------------------------------------------------
export function viewshed(scene, p) {
  if (!scene) {
    throw new Error('No terrain dataset loaded. Fetch an area or wait for startup to complete.');
  }
  const params = { ...p };
  if (params.target_agl === undefined && params.height_b === undefined) {
    params.target_agl = 2.0;
  }
  if (params.target_surface === undefined) {
    params.target_surface = 'ground';
  }
  const a = scene.xy(params.a);
  const g_a = scene.groundAt(a[0], a[1]);
  const [r_a, c_a] = scene.cell(a[0], a[1]);
  const b_a = (r_a >= 0 && r_a < scene.h && c_a >= 0 && c_a < scene.w) ? toFinite(scene.buildings[r_a][c_a]) : NaN;
  const auto_rooftop = ('auto_rooftop_a' in params) ? (params.auto_rooftop_a !== false) : (params.mount_type_a === undefined || params.mount_type_a === null);
  if (auto_rooftop && Number.isFinite(b_a) && b_a > g_a) {
    params.mount_type_a = 'rooftop';
  }
  const opts = settings(params);
  const radius = number(p, 'radius_m', 500, 1, 500000);
  const step = number(p, 'step_m', Math.max(20, scene.res), scene.res, 10000);
  const n = Math.ceil(2 * radius / step);
  if (n * n > MAX_VIEWSHED_SIDE ** 2) {
    const minStep = Math.ceil(2 * radius / MAX_VIEWSHED_SIDE);
    throw new Error(`This viewshed would evaluate ${(n * n).toLocaleString()} locations. Increase step_m to at least ${minStep} m or reduce radius. There is no fixed distance cap within 500 km.`);
  }

  const [lon_a, lat_a] = scene.toLL(a[0], a[1]);
  const unwrapLongitude = lon => lon + 360 * Math.round((lon_a - lon) / 360);
  const corners = [];
  for (const dx of [-1, 1]) {
    for (const dy of [-1, 1]) {
      corners.push(scene.toLL(a[0] + dx * radius, a[1] + dy * radius));
    }
  }
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const c of corners) {
    const lon = unwrapLongitude(c[0]), lat = c[1];
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  const lonArr = new Float64Array(n);
  for (let i = 0; i < n; i++) lonArr[i] = west + (i + 0.5) / n * (east - west);
  const latArr = new Float64Array(n);
  for (let i = 0; i < n; i++) latArr[i] = north - (i + 0.5) / n * (north - south);

  const simple = p.simple !== false;
  const include_foliage = p.include_foliage !== false;
  const visible_color = [235, 55, 65, 215]; // Red for visible coverage
  const foliage_color = include_foliage ? visible_color : [0, 0, 0, 0];
  const colors = simple ? {
    clear: visible_color,
    foliage: foliage_color,
    fresnel: visible_color,
    blocked: [0, 0, 0, 0],
      unknown: [130, 135, 145, 90],
  } : {
    clear: visible_color,
    foliage: include_foliage ? [241, 183, 74, 215] : [0, 0, 0, 0],
    fresnel: [172, 129, 245, 215],
    blocked: [0, 0, 0, 0],
      unknown: [130, 135, 145, 90],
  };
  if (p && typeof p.colors === 'object' && p.colors !== null) {
    Object.assign(colors, p.colors);
  }

  const counts = { clear: 0, foliage: 0, blocked: 0, unknown: 0, fresnel: 0 };
  const rgba = new Uint8ClampedArray(n * n * 4);

  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const lon = lonArr[col], lat = latArr[row];
      let xy = null;
      const normalizedLon = ((lon + 180) % 360 + 360) % 360 - 180;
      try { xy = scene.xy([lat, normalizedLon]); } catch (_) { xy = null; }
      if (!xy) {
        const dLat = (lat - lat_a) * 111132.954;
        const dLon = (lon - lon_a) * 111412.84 * Math.cos(lat_a * Math.PI / 180);
        if (Math.hypot(dLat, dLon) > radius) continue;
        const idx = (row * n + col) * 4;
        rgba[idx] = colors.unknown[0];
        rgba[idx + 1] = colors.unknown[1];
        rgba[idx + 2] = colors.unknown[2];
        rgba[idx + 3] = colors.unknown[3];
        counts.unknown++;
        continue;
      }
      const b = xy;
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (dist > radius) continue;

      let [r_t, c_t] = scene.cell(b[0], b[1]);
      const onCoverage = r_t >= 0 && r_t < scene.h && c_t >= 0 && c_t < scene.w && Number.isFinite(scene.ground[r_t][c_t]);
      const onBuilding = onCoverage && Number.isFinite(scene.buildings[r_t][c_t]);

      let st = 'clear';
      if (dist < 0.01) {
        st = (opts.target_surface === 'ground' && onBuilding) ? 'blocked' : 'clear';
      } else if (!onCoverage) {
        st = 'unknown';
      } else if (opts.target_surface === 'ground' && onBuilding) {
        st = 'blocked';
      } else {
        try {
          st = trace(scene, a, b, opts, false).status;
        } catch (e) {
          const msg = String(e && e.message || '');
          if (msg.toLowerCase().includes('outside')) st = 'unknown';
          else throw e;
        }
      }
      if (!(st in counts)) st = 'unknown';
      counts[st]++;
      const colr = colors[st] || colors.unknown;
      const idx = (row * n + col) * 4;
      rgba[idx] = colr[0];
      rgba[idx + 1] = colr[1];
      rgba[idx + 2] = colr[2];
      rgba[idx + 3] = colr[3];
    }
  }

  const targetDesc = opts.target_surface === 'ground' ? 'terrain/ground level' : 'rooftop/ground surface';
  const baseNote = `Each colored pixel is a sampled target at approximately ${(2 * radius / n).toFixed(1)} m spacing (red = visible line of sight, uncolored = obstructed). Target height is ${opts.height_b.toFixed(1)} m above ${targetDesc}.`;
  const extra = [];
  const isCorridor = Boolean(scene.meta && scene.meta.is_corridor);
  if (isCorridor) {
    extra.push('Dataset is a narrow corridor: targets outside the corridor appear gray (unknown). For omnidirectional viewshed, fetch a full 360° area or a wider corridor (increase corridor_buffer_m).');
  } else {
    const total = counts.clear + counts.foliage + counts.fresnel + counts.blocked + counts.unknown;
    if (total > 0 && counts.unknown / total > 0.5) {
      extra.push('Many sampled targets are outside available data coverage. The requested radius may extend beyond the loaded terrain bounds or a narrow corridor – reduce radius, increase step_m, or fetch a larger/wider area.');
    }
  }
  if (radius > 50000) {
    extra.push('Long-range viewshed (>50 km): local projection and effective-Earth curvature are approximations and need independent validation.');
  } else if (radius > 10000) {
    extra.push('Viewshed uses local transverse-Mercator projection; accuracy gradually decreases with distance – validate results beyond ~10 km.');
  }
  const notes = [baseNote, ...extra, ...(scene.meta && scene.meta.analysis_notes || [])];

  return {
    bounds: [[south, west], [north, east]],
    counts,
    notes,
    n,
    width: n,
    height: n,
    rgba
  };
}
