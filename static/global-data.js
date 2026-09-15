/** Browser-only global terrain, building, and canopy acquisition for Sightline. */

export const MAX_MERCATOR_LAT = 85.05112878;
export const MAX_SCENE_CELLS = 750_000;
const MAX_TERRAIN_TILES = 48;
const MAX_BUILDING_TILES = 64;
const TERRAIN_ROOT = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const OPENFREE_TILEJSON = 'https://tiles.openfreemap.org/planet';
const OSM_MAP_API = 'https://api.openstreetmap.org/api/0.6/map';
const CHM_ROOT = 'https://data.source.coop/tge-labs/meta-chm-v2/chm';
const MVT_MODULE = 'https://cdn.jsdelivr.net/npm/@mapbox/vector-tile@2.0.4/+esm';
const PBF_MODULE = 'https://cdn.jsdelivr.net/npm/pbf@4.0.1/+esm';
const GEOTIFF_MODULE = 'https://cdn.jsdelivr.net/npm/geotiff@3.0.5/+esm';
const DEG_LAT_M = 111_320;
export const FETCH_CACHE_LIMIT = 128;
const TERRAIN_PIXEL_CACHE_LIMIT = 64;
const BUILDING_FEATURE_CACHE_LIMIT = 72;
const CANOPY_IMAGE_CACHE_LIMIT = 12;
const MAX_OSM_MAP_FALLBACK_AREA_M2 = 25_000_000;

const memory = new Map();
const terrainPixels = new Map();
const buildingFeatures = new Map();
const canopyImages = new Map();
const finite = Number.isFinite;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const rows = (flat, height, width) => Array.from(
  { length: height },
  (_, row) => flat.subarray(row * width, (row + 1) * width),
);

export function normalizeLon(lon) {
  const value = Number(lon);
  if (!finite(value)) return NaN;
  return ((value + 180) % 360 + 360) % 360 - 180;
}

export function unwrapLon(lon, reference) {
  let value = normalizeLon(lon);
  while (value - reference > 180) value -= 360;
  while (value - reference < -180) value += 360;
  return value;
}

export function decodeTerrariumPixel(red, green, blue) {
  return Number(red) * 256 + Number(green) + Number(blue) / 256 - 32768;
}

function parseBuildingLength(value) {
  if (finite(Number(value)) && Number(value) > 0) return Number(value);
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?)$/i);
  return match ? Number(match[1]) : null;
}

export function parseBuildingHeight(properties = {}) {
  const direct = parseBuildingLength(properties.render_height ?? properties.height);
  if (finite(direct) && direct > 0) return direct;
  const levels = Number(properties['building:levels'] ?? properties.levels);
  return finite(levels) && levels > 0 ? levels * 3.5 : null;
}

export function isRenderableBuilding(properties = {}) {
  const hidden = properties.hide_3d;
  return !(hidden === true || hidden === 1 || String(hidden).toLowerCase() === 'true');
}

export function parseOsmMapBuildings(document) {
  if (document?.documentElement?.nodeName !== 'osm') throw new Error('OpenStreetMap returned an invalid building response.');
  const nodes = new Map([...document.getElementsByTagName('node')].map(node => [
    node.getAttribute('id'), [Number(node.getAttribute('lon')), Number(node.getAttribute('lat'))],
  ]));
  return [...document.getElementsByTagName('way')].flatMap(way => {
    const tags = Object.fromEntries([...way.getElementsByTagName('tag')].map(tag => [tag.getAttribute('k'), tag.getAttribute('v')]));
    if ((!tags.building && !tags['building:part']) || tags.building === 'no' || !isRenderableBuilding(tags)) return [];
    const refs = [...way.getElementsByTagName('nd')].map(node => node.getAttribute('ref'));
    const ring = refs.map(ref => nodes.get(ref));
    if (ring.length < 4 || refs[0] !== refs.at(-1) || ring.some(point => !point || !finite(point[0]) || !finite(point[1]))) return [];
    return [{ polygons: [[ring]], height: parseBuildingHeight(tags) }];
  });
}

function validatePoint(point, label) {
  if (!Array.isArray(point) || point.length !== 2) throw new Error(`${label} must be [latitude, longitude].`);
  const lat = Number(point[0]);
  const lon = Number(point[1]);
  if (!finite(lat) || !finite(lon) || lat < -MAX_MERCATOR_LAT || lat > MAX_MERCATOR_LAT || lon < -180 || lon > 180) {
    throw new Error(`${label} must be within Web Mercator coverage (latitude ±${MAX_MERCATOR_LAT.toFixed(5)}°, longitude ±180°).`);
  }
  return [lat, lon];
}

function dimensionsForBounds(bounds, requestedResolution) {
  const centerLat = (bounds.south + bounds.north) / 2;
  const lonM = DEG_LAT_M * Math.max(0.01, Math.cos(centerLat * Math.PI / 180));
  const widthM = Math.max(1, (bounds.east - bounds.west) * lonM);
  const heightM = Math.max(1, (bounds.north - bounds.south) * DEG_LAT_M);
  let resolution = Math.max(2, Number(requestedResolution) || 8);
  if ((Math.ceil(widthM / resolution) * Math.ceil(heightM / resolution)) > MAX_SCENE_CELLS) {
    resolution = Math.ceil(Math.sqrt(widthM * heightM / MAX_SCENE_CELLS) * 10) / 10;
  }
  let width = Math.max(2, Math.ceil(widthM / resolution));
  let height = Math.max(2, Math.ceil(heightM / resolution));
  while (width * height > MAX_SCENE_CELLS) {
    resolution = Math.ceil((resolution + 0.1) * 10) / 10;
    width = Math.max(2, Math.ceil(widthM / resolution));
    height = Math.max(2, Math.ceil(heightM / resolution));
  }
  return { centerLat, lonM, widthM, heightM, resolution, width, height };
}

export function planRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('A terrain request is required.');
  let bounds;
  let center;
  let defaultA;
  let defaultB;
  let corridorBuffer = null;
  const corridor = request.mode === 'corridor' || (request.a && request.b);
  if (corridor) {
    const a = validatePoint(request.a, 'Site A');
    const b = validatePoint(request.b, 'Site B');
    const bLon = unwrapLon(b[1], a[1]);
    corridorBuffer = clamp(Number(request.corridor_buffer_m) || 80, 30, 20_000);
    const midLat = (a[0] + b[0]) / 2;
    const latPad = corridorBuffer / DEG_LAT_M;
    const lonPad = corridorBuffer / (DEG_LAT_M * Math.max(0.01, Math.cos(midLat * Math.PI / 180)));
    bounds = {
      south: Math.min(a[0], b[0]) - latPad,
      west: Math.min(a[1], bLon) - lonPad,
      north: Math.max(a[0], b[0]) + latPad,
      east: Math.max(a[1], bLon) + lonPad,
    };
    center = [(a[0] + b[0]) / 2, (a[1] + bLon) / 2];
    defaultA = a;
    defaultB = [b[0], bLon];
  } else {
    center = validatePoint(request.center, 'Center');
    const radius = Number(request.radius_m);
    if (!finite(radius) || radius < 30 || radius > 250_000) throw new Error('Radius must be between 30 m and 250 km.');
    const latPad = radius / DEG_LAT_M;
    const lonPad = radius / (DEG_LAT_M * Math.max(0.01, Math.cos(center[0] * Math.PI / 180)));
    bounds = { south: center[0] - latPad, west: center[1] - lonPad, north: center[0] + latPad, east: center[1] + lonPad };
    defaultA = center;
    defaultB = [center[0] + latPad * 0.35, center[1] + lonPad * 0.35];
  }
  if (bounds.south < -MAX_MERCATOR_LAT || bounds.north > MAX_MERCATOR_LAT) {
    throw new Error(`Requested coverage extends beyond Web Mercator latitude ±${MAX_MERCATOR_LAT.toFixed(5)}°.`);
  }
  const dims = dimensionsForBounds(bounds, request.resolution_m);
  return { ...dims, bounds, center, defaultA, defaultB, corridor, corridorBuffer };
}

function lonToTile(lon, zoom) { return (lon + 180) / 360 * (2 ** zoom); }
function latToTile(lat, zoom) {
  const radians = clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * (2 ** zoom);
}

export function tileRange(bounds, zoom) {
  return {
    minX: Math.floor(lonToTile(bounds.west, zoom)),
    maxX: Math.floor(lonToTile(bounds.east - 1e-12, zoom)),
    minY: Math.floor(latToTile(bounds.north, zoom)),
    maxY: Math.floor(latToTile(bounds.south, zoom)),
    zoom,
  };
}

function tileCount(range) { return Math.max(0, range.maxX - range.minX + 1) * Math.max(0, range.maxY - range.minY + 1); }
function wrappedX(x, zoom) { const size = 2 ** zoom; return ((x % size) + size) % size; }

export function clearResponseCache() {
  memory.clear();
  terrainPixels.clear();
  buildingFeatures.clear();
  canopyImages.clear();
}

function cachedArtifact(cache, key, limit, loader) {
  let value = cache.get(key);
  if (value) {
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  value = Promise.resolve().then(loader);
  value = value.catch(error => {
    if (cache.get(key) === value) cache.delete(key);
    throw error;
  });
  cache.set(key, value);
  while (cache.size > limit) cache.delete(cache.keys().next().value);
  return value;
}

export async function cachedFetch(url, options = {}, fetchImpl = fetch) {
  const range = options.headers?.Range || '';
  const key = `${url}|${range}`;
  let response = memory.get(key);
  if (response) {
    memory.delete(key);
    memory.set(key, response);
  } else {
    response = Promise.resolve().then(() => fetchImpl(url, options)).then(result => {
      if (!result.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${result.status}.`);
      return result;
    });
    response = response.catch(error => {
      if (memory.get(key) === response) memory.delete(key);
      throw error;
    });
    memory.set(key, response);
    while (memory.size > FETCH_CACHE_LIMIT) memory.delete(memory.keys().next().value);
  }
  return (await response).clone();
}

async function imagePixels(response) {
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  if (bitmap.close) bitmap.close();
  return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
}

async function fetchTerrain(plan, fetchImpl, progress) {
  let zoom = plan.resolution <= 4.5 ? 15 : plan.resolution <= 9 ? 14 : plan.resolution <= 18 ? 13 : 12;
  let range = tileRange(plan.bounds, zoom);
  while (tileCount(range) > MAX_TERRAIN_TILES && zoom > 7) range = tileRange(plan.bounds, --zoom);
  if (tileCount(range) > MAX_TERRAIN_TILES) throw new Error('This area needs too many terrain tiles. Reduce its radius.');
  progress(`Downloading ${tileCount(range)} global elevation tile${tileCount(range) === 1 ? '' : 's'}…`);
  const tiles = new Map();
  const jobs = [];
  for (let y = range.minY; y <= range.maxY; y++) for (let x = range.minX; x <= range.maxX; x++) {
    const url = `${TERRAIN_ROOT}/${zoom}/${wrappedX(x, zoom)}/${y}.png`;
    jobs.push(cachedArtifact(
      terrainPixels,
      url,
      TERRAIN_PIXEL_CACHE_LIMIT,
      () => cachedFetch(url, {}, fetchImpl).then(imagePixels),
    ).then(pixels => tiles.set(`${x}/${y}`, pixels)));
  }
  await Promise.all(jobs);
  const ground = new Float32Array(plan.width * plan.height);
  ground.fill(NaN);
  const pixel = (globalX, globalY) => {
    const tx = Math.floor(globalX / 256), ty = Math.floor(globalY / 256);
    const tile = tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;
    const px = ((Math.floor(globalX) % 256) + 256) % 256;
    const py = ((Math.floor(globalY) % 256) + 256) % 256;
    const index = (py * tile.width + px) * 4;
    return tile.data[index + 3] === 0 ? NaN : decodeTerrariumPixel(tile.data[index], tile.data[index + 1], tile.data[index + 2]);
  };
  for (let row = 0; row < plan.height; row++) {
    const lat = plan.bounds.north - (row + 0.5) / plan.height * (plan.bounds.north - plan.bounds.south);
    const gy = latToTile(lat, zoom) * 256;
    for (let col = 0; col < plan.width; col++) {
      const lon = plan.bounds.west + (col + 0.5) / plan.width * (plan.bounds.east - plan.bounds.west);
      const gx = lonToTile(lon, zoom) * 256;
      const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
      const values = [pixel(x0, y0), pixel(x0 + 1, y0), pixel(x0, y0 + 1), pixel(x0 + 1, y0 + 1)];
      if (values.every(finite)) ground[row * plan.width + col] = (1 - fy) * ((1 - fx) * values[0] + fx * values[1]) + fy * ((1 - fx) * values[2] + fx * values[3]);
    }
  }
  return { ground, zoom, urls: jobs.length };
}

function gridPoint(plan, lon, lat) {
  const unwrapped = unwrapLon(lon, plan.bounds.west);
  return [
    (unwrapped - plan.bounds.west) / (plan.bounds.east - plan.bounds.west) * plan.width,
    (plan.bounds.north - lat) / (plan.bounds.north - plan.bounds.south) * plan.height,
  ];
}

export function gridCellSpan(left, right, width) {
  if (!finite(left) || !finite(right) || !Number.isInteger(width) || width < 1) return null;
  if (right < 0.5 || left > width - 0.5) return null;
  const start = clamp(Math.ceil(left - 0.5), 0, width - 1);
  const end = clamp(Math.floor(right - 0.5), 0, width - 1);
  return start <= end ? [start, end] : null;
}

function fillPolygon(plan, rings, height, ground, buildings, uncertain) {
  const converted = rings.map(ring => ring.map(point => gridPoint(plan, point[0], point[1]))).filter(ring => ring.length >= 3);
  if (!converted.length) return;
  const minRow = clamp(Math.floor(Math.min(...converted.flat().map(p => p[1]))), 0, plan.height - 1);
  const maxRow = clamp(Math.ceil(Math.max(...converted.flat().map(p => p[1]))), 0, plan.height - 1);
  for (let row = minRow; row <= maxRow; row++) {
    const y = row + 0.5;
    const crossings = [];
    for (const ring of converted) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      if ((a[1] > y) !== (b[1] > y)) crossings.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const span = gridCellSpan(crossings[i], crossings[i + 1], plan.width);
      if (!span) continue;
      const [start, end] = span;
      for (let col = start; col <= end; col++) {
        const index = row * plan.width + col;
        if (finite(height) && finite(ground[index])) buildings[index] = Math.max(finite(buildings[index]) ? buildings[index] : -Infinity, ground[index] + height);
        else uncertain[index] = 1;
      }
    }
  }
}

async function fetchBuildings(plan, fetchImpl, progress, deps = null, osmMapParser = null) {
  const buildings = new Float32Array(plan.width * plan.height); buildings.fill(NaN);
  const uncertain = new Uint8Array(plan.width * plan.height);
  const fallback = async primary => {
    if (primary.heightedFeatures) return primary;
    const osm = await fetchOsmMapBuildings(plan, fetchImpl, osmMapParser);
    if (osm.status !== 'available') {
      uncertain.fill(1);
      return { ...primary, status: `${primary.status}; OpenStreetMap API fallback ${osm.status}` };
    }
    for (const feature of osm.features) {
      for (const polygon of feature.polygons) fillPolygon(plan, polygon, feature.height, plan.ground, buildings, uncertain);
    }
    return {
      ...primary,
      features: primary.features + osm.features.length,
      heightedFeatures: osm.features.filter(feature => finite(feature.height)).length,
      status: 'available: OpenStreetMap API fallback',
    };
  };
  let zoom = 14;
  let range = tileRange(plan.bounds, zoom);
  while (tileCount(range) > MAX_BUILDING_TILES && zoom > 13) range = tileRange(plan.bounds, --zoom);
  if (tileCount(range) > MAX_BUILDING_TILES) {
    uncertain.fill(1);
    return { buildings, uncertain, status: 'skipped: requested area is too large for detailed buildings', features: 0 };
  }
  progress(`Downloading ${tileCount(range)} global building tile${tileCount(range) === 1 ? '' : 's'}…`);
  try {
    const tileJson = await (await cachedFetch(OPENFREE_TILEJSON, {}, fetchImpl)).json();
    const template = tileJson.tiles?.[0];
    if (!template) throw new Error('OpenFreeMap did not provide a vector tile template.');
    const modules = deps || await Promise.all([import(MVT_MODULE), import(PBF_MODULE)]);
    const VectorTile = modules[0].VectorTile;
    const Pbf = modules[1].default;
    let features = 0, heightedFeatures = 0;
    const jobs = [];
    for (let y = range.minY; y <= range.maxY; y++) for (let x = range.minX; x <= range.maxX; x++) {
      const wx = wrappedX(x, zoom);
      const url = template.replace('{z}', zoom).replace('{x}', wx).replace('{y}', y);
      jobs.push(cachedArtifact(buildingFeatures, url, BUILDING_FEATURE_CACHE_LIMIT, async () => {
        const buffer = await (await cachedFetch(url, {}, fetchImpl)).arrayBuffer();
        if (!buffer.byteLength) return;
        const layer = new VectorTile(new Pbf(new Uint8Array(buffer))).layers.building;
        if (!layer) return [];
        const decoded = [];
        for (let i = 0; i < layer.length; i++) {
          const feature = layer.feature(i);
          if (!isRenderableBuilding(feature.properties)) continue;
          const geometry = feature.toGeoJSON(wx, y, zoom).geometry;
          const height = parseBuildingHeight(feature.properties);
          const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
          decoded.push({ polygons, height });
        }
        return decoded;
      }).then(decoded => {
          for (const feature of decoded || []) {
            for (const polygon of feature.polygons) fillPolygon(plan, polygon, feature.height, plan.ground, buildings, uncertain);
            features++;
            if (finite(feature.height)) heightedFeatures++;
          }
      }));
    }
    await Promise.all(jobs);
    return fallback({ buildings, uncertain, status: 'available', features, heightedFeatures });
  } catch (error) {
    return fallback({ buildings, uncertain, status: `unavailable: ${error.message}`, features: 0, heightedFeatures: 0 });
  }
}

function osmMapUrl(bounds) {
  const bbox = [bounds.west, bounds.south, bounds.east, bounds.north].map(value => Number(value).toFixed(6)).join(',');
  return `${OSM_MAP_API}?bbox=${bbox}`;
}

async function fetchOsmMapBuildings(plan, fetchImpl, parser = null) {
  const width = plan.bounds.east - plan.bounds.west;
  const height = plan.bounds.north - plan.bounds.south;
  if (plan.widthM * plan.heightM > MAX_OSM_MAP_FALLBACK_AREA_M2 || width > 0.25 || height > 0.25 || width * height > 0.01 || plan.bounds.west < -180 || plan.bounds.east > 180) {
    return { status: 'skipped: requested area is too large for fallback footprints', features: [] };
  }
  try {
    const xml = await (await cachedFetch(osmMapUrl(plan.bounds), {}, fetchImpl)).text();
    const document = parser ? parser(xml) : new DOMParser().parseFromString(xml, 'application/xml');
    if (document.querySelector?.('parsererror')) throw new Error('OpenStreetMap returned invalid XML.');
    return { status: 'available', features: parseOsmMapBuildings(document) };
  } catch (error) {
    return { status: `unavailable: ${error.message}`, features: [] };
  }
}

function lonLatToMercator(lon, lat) {
  const x = normalizeLon(lon) * 20037508.342789244 / 180;
  const y = Math.log(Math.tan((90 + clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)) * Math.PI / 360)) / (Math.PI / 180) * 20037508.342789244 / 180;
  return [x, y];
}

function quadkey(x, y, zoom = 10) {
  let key = '';
  for (let bit = zoom - 1; bit >= 0; bit--) key += String((x & (1 << bit) ? 1 : 0) + (y & (1 << bit) ? 2 : 0));
  return key;
}

function tileLatitude(y, zoom) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (2 ** zoom)))) * 180 / Math.PI;
}

function mercatorY(lat) {
  return lonLatToMercator(0, lat)[1];
}

function wrappedTileBounds(tx, ty, zoom, referenceLon) {
  const size = 2 ** zoom;
  const x = wrappedX(tx, zoom);
  const west = unwrapLon(x / size * 360 - 180, referenceLon);
  return {
    west,
    east: west + 360 / size,
    north: tileLatitude(ty, zoom),
    south: tileLatitude(ty + 1, zoom),
  };
}

export function canopyTileWindow(plan, tx, ty, zoom, imageBounds, imageWidth, imageHeight) {
  const tile = wrappedTileBounds(tx, ty, zoom, plan.bounds.west);
  const bounds = {
    west: Math.max(plan.bounds.west, tile.west),
    east: Math.min(plan.bounds.east, tile.east),
    south: Math.max(plan.bounds.south, tile.south),
    north: Math.min(plan.bounds.north, tile.north),
  };
  if (bounds.west >= bounds.east || bounds.south >= bounds.north) return null;
  const [left, bottom, right, top] = imageBounds;
  const xAt = lon => left + (lon - tile.west) / (tile.east - tile.west) * (right - left);
  const yAt = lat => (top - mercatorY(lat)) / (top - bottom) * imageHeight;
  const ix0 = clamp(Math.floor((xAt(bounds.west) - left) / (right - left) * imageWidth), 0, imageWidth);
  const ix1 = clamp(Math.ceil((xAt(bounds.east) - left) / (right - left) * imageWidth), 0, imageWidth);
  const iy0 = clamp(Math.floor(yAt(bounds.north)), 0, imageHeight);
  const iy1 = clamp(Math.ceil(yAt(bounds.south)), 0, imageHeight);
  if (ix1 <= ix0 || iy1 <= iy0) return null;
  return { bounds, tile, window: [ix0, iy0, ix1, iy1] };
}

export async function fetchCanopy(plan, fetchImpl, progress, geotiffModule = null) {
  const trees = new Float32Array(plan.width * plan.height); trees.fill(NaN);
  const uncertain = new Uint8Array(plan.width * plan.height); uncertain.fill(1);
  const range = tileRange(plan.bounds, 10);
  if (tileCount(range) > 12) return { trees, uncertain, status: 'skipped: requested area is too large for detailed canopy', tiles: 0, coveredCells: 0 };
  progress(`Checking satellite canopy height for ${tileCount(range)} tile${tileCount(range) === 1 ? '' : 's'}…`);
  try {
    const GeoTIFF = geotiffModule || await import(GEOTIFF_MODULE);
    let loaded = 0, coveredCells = 0;
    for (let ty = range.minY; ty <= range.maxY; ty++) for (let tx = range.minX; tx <= range.maxX; tx++) {
      const url = `${CHM_ROOT}/${quadkey(wrappedX(tx, 10), ty)}.tif`;
      let image;
      try {
        if (geotiffModule) {
          const tiff = await GeoTIFF.fromUrl(url, { cache: true });
          image = await tiff.getImage();
        } else {
          image = await cachedArtifact(canopyImages, url, CANOPY_IMAGE_CACHE_LIMIT, async () => {
            const tiff = await GeoTIFF.fromUrl(url, { cache: true });
            return tiff.getImage();
          });
        }
      } catch (error) {
        if (/404|not found/i.test(String(error))) continue;
        throw error;
      }
      const imageBounds = image.getBoundingBox();
      const [left, bottom, right, top] = imageBounds;
      const imageWidth = image.getWidth(), imageHeight = image.getHeight();
      const rawNoData = image.getGDALNoData?.();
      const noData = rawNoData === null || rawNoData === undefined ? NaN : Number(rawNoData);
      const coverage = canopyTileWindow(plan, tx, ty, 10, imageBounds, imageWidth, imageHeight);
      if (!coverage) continue;
      const [ix0, iy0, ix1, iy1] = coverage.window;
      const outWidth = Math.max(1, Math.min(plan.width, Math.ceil((ix1 - ix0) * 1.19 / plan.resolution)));
      const outHeight = Math.max(1, Math.min(plan.height, Math.ceil((iy1 - iy0) * 1.19 / plan.resolution)));
      const raster = await image.readRasters({ window: [ix0, iy0, ix1, iy1], width: outWidth, height: outHeight, interleave: true, resampleMethod: 'bilinear' });
      const colStart = clamp(Math.floor((coverage.bounds.west - plan.bounds.west) / (plan.bounds.east - plan.bounds.west) * plan.width), 0, plan.width - 1);
      const colEnd = clamp(Math.ceil((coverage.bounds.east - plan.bounds.west) / (plan.bounds.east - plan.bounds.west) * plan.width), 0, plan.width);
      const rowStart = clamp(Math.floor((plan.bounds.north - coverage.bounds.north) / (plan.bounds.north - plan.bounds.south) * plan.height), 0, plan.height - 1);
      const rowEnd = clamp(Math.ceil((plan.bounds.north - coverage.bounds.south) / (plan.bounds.north - plan.bounds.south) * plan.height), 0, plan.height);
      for (let row = rowStart; row < rowEnd; row++) for (let col = colStart; col < colEnd; col++) {
        const index = row * plan.width + col;
        const lon = plan.bounds.west + (col + 0.5) / plan.width * (plan.bounds.east - plan.bounds.west);
        const lat = plan.bounds.north - (row + 0.5) / plan.height * (plan.bounds.north - plan.bounds.south);
        const unwrappedLon = unwrapLon(lon, plan.bounds.west);
        if (unwrappedLon < coverage.bounds.west || unwrappedLon > coverage.bounds.east || lat < coverage.bounds.south || lat > coverage.bounds.north) continue;
        const mx = left + (unwrappedLon - coverage.tile.west) / (coverage.tile.east - coverage.tile.west) * (right - left);
        const my = mercatorY(lat);
        const sx = clamp(Math.floor(((mx - left) / (right - left) * imageWidth - ix0) / (ix1 - ix0) * outWidth), 0, outWidth - 1);
        const sy = clamp(Math.floor(((top - my) / (top - bottom) * imageHeight - iy0) / (iy1 - iy0) * outHeight), 0, outHeight - 1);
        const canopy = Number(raster[sy * outWidth + sx]);
        if (!finite(canopy) || canopy < 0 || canopy === noData) continue;
        if (uncertain[index]) coveredCells++;
        uncertain[index] = 0;
        if (canopy >= 2 && finite(plan.ground[index])) trees[index] = plan.ground[index] + canopy;
      }
      loaded++;
    }
    return { trees, uncertain, status: loaded ? 'available' : 'no mapped canopy tile', tiles: loaded, coveredCells };
  } catch (error) {
    return { trees, uncertain, status: `unavailable: ${error.message}`, tiles: 0, coveredCells: 0 };
  }
}

function renderImages(plan, ground, buildings, trees, uncertain) {
  const makeCanvas = () => typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(plan.width, plan.height) : Object.assign(document.createElement('canvas'), { width: plan.width, height: plan.height });
  const terrainCanvas = makeCanvas(), classesCanvas = makeCanvas();
  const terrainContext = terrainCanvas.getContext('2d'), classesContext = classesCanvas.getContext('2d');
  const terrainImage = terrainContext.createImageData(plan.width, plan.height);
  const classImage = classesContext.createImageData(plan.width, plan.height);
  let min = Infinity, max = -Infinity;
  for (const value of ground) if (finite(value)) { min = Math.min(min, value); max = Math.max(max, value); }
  const span = Math.max(1, max - min);
  for (let index = 0; index < ground.length; index++) {
    const p = index * 4;
    if (finite(ground[index])) {
      const shade = Math.round(40 + 180 * (ground[index] - min) / span);
      terrainImage.data.set([shade, shade, shade, 205], p);
    }
    if (finite(buildings[index])) classImage.data.set([60, 150, 235, 180], p);
    else if (finite(trees[index])) classImage.data.set([55, 180, 95, 165], p);
    else if (uncertain[index]) classImage.data.set([135, 140, 150, 85], p);
  }
  terrainContext.putImageData(terrainImage, 0, 0); classesContext.putImageData(classImage, 0, 0);
  const url = canvas => canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/png' }).then(blob => URL.createObjectURL(blob)) : Promise.resolve(canvas.toDataURL('image/png'));
  return Promise.all([url(terrainCanvas), url(classesCanvas)]).then(([terrainUrl, classesUrl]) => ({ terrainUrl, classesUrl }));
}

export function renderSceneImages(scene) {
  const height = scene?.ground?.length || 0;
  const width = height ? scene.ground[0].length : 0;
  if (!width || !height) throw new Error('A populated scene is required to render overlays.');
  const flatten = (grid, Type) => {
    const output = new Type(width * height);
    for (let row = 0; row < height; row++) output.set(grid[row], row * width);
    return output;
  };
  const ground = flatten(scene.ground, Float32Array);
  const buildings = flatten(scene.buildings, Float32Array);
  const trees = flatten(scene.trees, Float32Array);
  const uncertain = flatten(scene.uncertain, Uint8Array);
  const canopyUncertain = flatten(scene.canopy_uncertain, Uint8Array);
  for (let index = 0; index < uncertain.length; index++) {
    if (canopyUncertain[index]) uncertain[index] = 1;
  }
  return renderImages({ width, height }, ground, buildings, trees, uncertain);
}

export async function acquireScene(request, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const progress = options.onProgress || (() => {});
  const plan = planRequest(request);
  progress(`Preparing ${plan.width.toLocaleString()}×${plan.height.toLocaleString()} browser terrain grid at ${plan.resolution.toFixed(1)} m…`);
  const terrain = await fetchTerrain(plan, fetchImpl, progress);
  plan.ground = terrain.ground;
  const includeFoliage = options.includeFoliage !== false;
  const buildingPromise = fetchBuildings(plan, fetchImpl, progress, options.vectorTileModules, options.osmMapParser);
  const canopyPromise = includeFoliage
    ? fetchCanopy(plan, fetchImpl, progress, options.geotiffModule)
    : Promise.resolve({
        trees: new Float32Array(plan.width * plan.height).fill(NaN),
        uncertain: new Uint8Array(plan.width * plan.height).fill(1),
        status: 'not loaded: foliage disabled',
        tiles: 0,
        coveredCells: 0,
      });
  const [buildings, canopy] = await Promise.all([buildingPromise, canopyPromise]);
  plan.buildings = buildings.buildings;
  for (let index = 0; index < canopy.uncertain.length; index++) {
    if (finite(buildings.buildings[index])) {
      canopy.trees[index] = NaN;
      canopy.uncertain[index] = 0;
    }
  }
  const unknown = new Float32Array(plan.width * plan.height); unknown.fill(NaN);
  for (let index = 0; index < terrain.ground.length; index++) if (!finite(terrain.ground[index])) buildings.uncertain[index] = 1;
  const sourceNotes = [
    `Buildings: ${buildings.status}.`,
    `Satellite canopy: ${canopy.status}.`,
    'Global browser data is suitable for screening; local LiDAR is more precise where available.',
  ];
  const meta = {
    name: 'Browser-fetched global terrain, buildings & canopy',
    source: 'AWS Terrain Tiles; OpenFreeMap/OpenMapTiles/OSM with OSM API building-footprint fallback; Meta/WRI CHMv2 via Source Cooperative',
    resolution_m: plan.resolution,
    xmin: 0,
    ymax: plan.height * plan.resolution,
    crs: 'LOCAL_EQUIRECTANGULAR',
    bounds: [[plan.bounds.south, plan.bounds.west], [plan.bounds.north, plan.bounds.east]],
    center: plan.center,
    default_a: plan.defaultA,
    default_b: plan.defaultB,
    is_corridor: plan.corridor,
    corridor_buffer_m: plan.corridorBuffer,
    requested_center: plan.center,
    requested_radius_m: request.radius_m || null,
    fetch_provider: 'browser-global',
    is_dem: true,
    notes: sourceNotes,
    analysis_notes: sourceNotes,
    source_status: { terrain: 'available', buildings: buildings.status, canopy: canopy.status },
    feature_counts: { buildings: buildings.features, canopy_tiles: canopy.tiles, canopy_covered_cells: canopy.coveredCells },
    canopy_loaded: includeFoliage,
    longitude_wrap: plan.bounds.east > 180 || plan.bounds.west < -180,
  };
  const scene = {
    ground: rows(terrain.ground, plan.height, plan.width),
    buildings: rows(buildings.buildings, plan.height, plan.width),
    trees: rows(canopy.trees, plan.height, plan.width),
    unknown: rows(unknown, plan.height, plan.width),
    uncertain: rows(buildings.uncertain, plan.height, plan.width),
    canopy_uncertain: rows(canopy.uncertain, plan.height, plan.width),
    meta,
  };
  let images = { terrainUrl: null, classesUrl: null };
  if (options.renderOverlays !== false) {
    progress('Rendering browser terrain overlays…');
    const displayUncertain = new Uint8Array(buildings.uncertain);
    for (let index = 0; index < displayUncertain.length; index++) if (canopy.uncertain[index]) displayUncertain[index] = 1;
    images = await renderImages(plan, terrain.ground, buildings.buildings, canopy.trees, displayUncertain);
  }
  return { scene, meta, ...images };
}
