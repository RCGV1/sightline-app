import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FETCH_CACHE_LIMIT,
  MAX_MERCATOR_LAT,
  acquireScene,
  cachedFetch,
  canopyTileWindow,
  clearResponseCache,
  decodeTerrariumPixel,
  fetchCanopy,
  gridCellSpan,
  isRenderableBuilding,
  normalizeLon,
  parseBuildingHeight,
  planRequest,
  tileRange,
  unwrapLon,
} from './static/global-data.js';
import { Scene, analyze } from './static/engine.js';

function browserAcquisitionHarness() {
  const previousCanvas = globalThis.OffscreenCanvas;
  const previousBitmap = globalThis.createImageBitmap;
  let decodedImages = 0;
  let canopyRequests = 0;
  const fetchCalls = [];

  class Context {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }

    drawImage() {}

    getImageData() {
      const data = new Uint8ClampedArray(this.width * this.height * 4);
      for (let i = 0; i < data.length; i += 4) data[i + 3] = 255;
      return { data };
    }

    createImageData(width, height) {
      return { data: new Uint8ClampedArray(width * height * 4) };
    }

    putImageData() {}
  }

  class Canvas {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.context = new Context(width, height);
    }

    getContext() { return this.context; }
    convertToBlob() { return Promise.resolve(new Blob(['png'], { type: 'image/png' })); }
  }

  globalThis.OffscreenCanvas = Canvas;
  globalThis.createImageBitmap = async () => {
    decodedImages++;
    return { width: 256, height: 256, close() {} };
  };

  const fetchImpl = async url => {
    fetchCalls.push(String(url));
    if (String(url) === 'https://tiles.openfreemap.org/planet') {
      return new Response(JSON.stringify({ tiles: ['https://buildings.example/{z}/{x}/{y}.pbf'] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('.pbf')) return new Response(new Uint8Array());
    return new Response(new Uint8Array([137, 80, 78, 71]));
  };

  return {
    fetchImpl,
    vectorTileModules: [],
    geotiffModule: {
      fromUrl: async () => {
        canopyRequests++;
        throw new Error('canopy fetch should have been skipped');
      },
    },
    get decodedImages() { return decodedImages; },
    get canopyRequests() { return canopyRequests; },
    fetchCalls,
    restore() {
      if (previousCanvas === undefined) delete globalThis.OffscreenCanvas;
      else globalThis.OffscreenCanvas = previousCanvas;
      if (previousBitmap === undefined) delete globalThis.createImageBitmap;
      else globalThis.createImageBitmap = previousBitmap;
    },
  };
}

const tinyAreaRequest = { center: [37, -122], radius_m: 30, resolution_m: 100 };

test('Terrarium RGB decoding preserves signed and fractional elevations', () => {
  assert.equal(decodeTerrariumPixel(128, 0, 0), 0);
  assert.equal(decodeTerrariumPixel(128, 1, 0), 1);
  assert.equal(decodeTerrariumPixel(127, 255, 0), -1);
  assert.equal(decodeTerrariumPixel(128, 0, 128), 0.5);
});

test('building heights use source render height and levels fallback', () => {
  assert.equal(parseBuildingHeight({ render_height: 24 }), 24);
  assert.equal(parseBuildingHeight({ 'building:levels': 4 }), 14);
  assert.equal(parseBuildingHeight({}), null);
});

test('building import excludes vector features marked hidden from 3D', () => {
  assert.equal(isRenderableBuilding({ render_height: 444, hide_3d: true }), false);
  assert.equal(isRenderableBuilding({ render_height: 444, hide_3d: 'true' }), false);
  assert.equal(isRenderableBuilding({ render_height: 330 }), true);
});

test('corridor planning takes the short route across the antimeridian', () => {
  const plan = planRequest({ mode: 'corridor', a: [0, 179.9], b: [0, -179.9], corridor_buffer_m: 80, resolution_m: 10 });
  assert.ok(plan.bounds.east - plan.bounds.west < 1);
  assert.ok(plan.widthM > 20_000 && plan.widthM < 25_000);
  assert.equal(plan.defaultB[1] > 180, true);
  assert.equal(normalizeLon(181), -179);
  assert.equal(unwrapLon(-179.9, 179.9) > 180, true);
});

test('area planner adapts resolution to browser memory budget', () => {
  const plan = planRequest({ center: [35.3606, 138.7274], radius_m: 25_000, resolution_m: 2 });
  assert.ok(plan.width * plan.height <= 750_000);
  assert.ok(plan.resolution > 2);
});

test('planner rejects coordinates beyond source projection', () => {
  assert.throws(
    () => planRequest({ center: [MAX_MERCATOR_LAT + 0.1, 0], radius_m: 100, resolution_m: 10 }),
    /Web Mercator/,
  );
});

test('tile ranges can cross the antimeridian using unwrapped x indices', () => {
  const range = tileRange({ west: 179.8, east: 180.2, south: -0.1, north: 0.1 }, 10);
  assert.ok(range.maxX >= 1024);
  assert.ok(range.maxX - range.minX < 3);
});

test('response cache evicts old binary responses and retries failed requests', async () => {
  clearResponseCache();
  const calls = new Map();
  const fetchImpl = async url => {
    calls.set(url, (calls.get(url) || 0) + 1);
    if (url.endsWith('/failed')) throw new Error('offline');
    return new Response(url);
  };
  const urls = Array.from({ length: FETCH_CACHE_LIMIT + 1 }, (_, i) => `https://example.test/${i}`);
  for (const url of urls) assert.equal(await (await cachedFetch(url, {}, fetchImpl)).text(), url);
  await cachedFetch(urls[0], {}, fetchImpl);
  assert.equal(calls.get(urls[0]), 2);
  await assert.rejects(cachedFetch('https://example.test/failed', {}, fetchImpl), /offline/);
  await cachedFetch('https://example.test/failed', {}, async url => new Response(url));
});

test('unavailable canopy remains uncertain while zero canopy is known clear coverage', async () => {
  const plan = {
    width: 2, height: 2, resolution: 100,
    bounds: { south: 0, west: 0, north: 0.001, east: 0.001 },
    ground: new Float32Array([0, 0, 0, 0]),
    buildings: new Float32Array([NaN, NaN, NaN, NaN]),
  };
  const unavailable = await fetchCanopy(plan, fetch, () => {}, { fromUrl: async () => { throw new Error('404 not found'); } });
  assert.match(unavailable.status, /no mapped canopy tile/);
  assert.deepEqual([...unavailable.uncertain], [1, 1, 1, 1]);
  const zeroCanopy = await fetchCanopy(plan, fetch, () => {}, {
    fromUrl: async () => ({ getImage: async () => ({
      getBoundingBox: () => [-10_000, -10_000, 10_000, 10_000],
      getWidth: () => 2,
      getHeight: () => 2,
      readRasters: async ({ width, height }) => new Float32Array(width * height),
    }) }),
  });
  assert.equal(zeroCanopy.status, 'available');
  assert.deepEqual([...zeroCanopy.uncertain], [0, 0, 0, 0]);
  const scene = new Scene({
    ground: [[0, 0], [0, 0]],
    buildings: [[NaN, NaN], [NaN, NaN]],
    trees: [[NaN, NaN], [NaN, NaN]],
    unknown: [[NaN, NaN], [NaN, NaN]],
    uncertain: [[0, 0], [0, 0]],
    canopy_uncertain: [[1, 1], [1, 1]],
    meta: { xmin: 0, ymax: 2, resolution_m: 1, crs: 'LOCAL', bounds: [[0, 0], [0.001, 0.001]] },
  });
  const path = { a: [0.0005, 0.0001], b: [0.0005, 0.0009], height_a: 10, height_b: 10, mode: 'optical' };
  assert.equal(analyze(scene, path).status, 'unknown');
  assert.equal(analyze(scene, { ...path, include_foliage: false }).status, 'clear');
});

test('canopy tile windows keep dateline corridor portions in each wrapped tile', () => {
  const plan = planRequest({ mode: 'corridor', a: [0, 179.9], b: [0, -179.9], corridor_buffer_m: 80, resolution_m: 10 });
  const world = 20_037_508.342789244;
  const westTile = canopyTileWindow(plan, 1023, 512, 10, [world - world / 512, -world / 512, world, 0], 256, 256);
  const eastTile = canopyTileWindow(plan, 1024, 512, 10, [-world, -world / 512, -world + world / 512, 0], 256, 256);

  assert.ok(westTile);
  assert.ok(eastTile);
  assert.ok(westTile.bounds.west >= plan.bounds.west);
  assert.equal(westTile.bounds.east, 180);
  assert.equal(eastTile.bounds.west, 180);
  assert.ok(eastTile.bounds.east <= plan.bounds.east);
  assert.ok(eastTile.window[0] < eastTile.window[2]);
});

test('polygon scanlines only fill cells whose centers fall inside the span', () => {
  assert.equal(gridCellSpan(-20, -1, 4), null);
  assert.equal(gridCellSpan(5, 8, 4), null);
  assert.deepEqual(gridCellSpan(0.75, 2.25, 4), [1, 1]);
  assert.deepEqual(gridCellSpan(-1, 0.75, 4), [0, 0]);
});

test('scene projection wraps dateline endpoints consistently', () => {
  const grid = Array.from({ length: 2 }, () => new Float32Array([0, 0]));
  const scene = new Scene({
    ground: grid,
    buildings: grid.map(() => new Float32Array([NaN, NaN])),
    trees: grid.map(() => new Float32Array([NaN, NaN])),
    unknown: grid.map(() => new Float32Array([NaN, NaN])),
    meta: { resolution_m: 1000, xmin: 0, ymax: 2000, bounds: [[-0.1, 179.8], [0.1, 180.2]], longitude_wrap: true },
  });
  const east = scene.xy([0, -179.9]);
  assert.ok(east[0] > 1000 && east[0] < 2000);
  assert.ok(Math.abs(scene.toLL(east[0], east[1])[0] + 179.9) < 1e-6);
});

test('acquireScene skips canopy imports and requests when foliage is disabled', async () => {
  clearResponseCache();
  const harness = browserAcquisitionHarness();
  try {
    const acquired = await acquireScene(tinyAreaRequest, {
      fetch: harness.fetchImpl,
      vectorTileModules: harness.vectorTileModules,
      geotiffModule: harness.geotiffModule,
      includeFoliage: false,
    });
    assert.equal(harness.canopyRequests, 0);
    assert.ok(acquired.scene.trees.every(row => [...row].every(Number.isNaN)));
  } finally {
    harness.restore();
    clearResponseCache();
  }
});

test('repeated terrain acquisition reuses decoded tile pixels', async () => {
  clearResponseCache();
  const harness = browserAcquisitionHarness();
  try {
    const options = {
      fetch: harness.fetchImpl,
      vectorTileModules: harness.vectorTileModules,
      geotiffModule: harness.geotiffModule,
      includeFoliage: false,
    };
    await acquireScene(tinyAreaRequest, options);
    await acquireScene(tinyAreaRequest, options);
    assert.equal(harness.decodedImages, 1);
  } finally {
    harness.restore();
    clearResponseCache();
  }
});

test('viewshed acquisition can defer unused map overlay encoding', async () => {
  clearResponseCache();
  const harness = browserAcquisitionHarness();
  try {
    const acquired = await acquireScene(tinyAreaRequest, {
      fetch: harness.fetchImpl,
      vectorTileModules: harness.vectorTileModules,
      includeFoliage: false,
      renderOverlays: false,
    });
    assert.equal(acquired.terrainUrl, null);
    assert.equal(acquired.classesUrl, null);
  } finally {
    harness.restore();
    clearResponseCache();
  }
});

test('repeated acquisition reuses decoded building tiles', async () => {
  clearResponseCache();
  const harness = browserAcquisitionHarness();
  let decodedBuildings = 0;
  class FakeVectorTile {
    constructor() {
      decodedBuildings++;
      this.layers = { building: { length: 0 } };
    }
  }
  try {
    const fetchImpl = async url => {
      if (String(url) === 'https://tiles.openfreemap.org/planet') {
        return new Response(JSON.stringify({ tiles: ['https://buildings.example/{z}/{x}/{y}.pbf'] }));
      }
      if (String(url).endsWith('.pbf')) return new Response(new Uint8Array([1]));
      return harness.fetchImpl(url);
    };
    const options = {
      fetch: fetchImpl,
      vectorTileModules: [{ VectorTile: FakeVectorTile }, { default: class FakePbf {} }],
      includeFoliage: false,
      renderOverlays: false,
    };
    await acquireScene(tinyAreaRequest, options);
    const firstPass = decodedBuildings;
    await acquireScene(tinyAreaRequest, options);
    assert.ok(firstPass > 0);
    assert.equal(decodedBuildings, firstPass);
  } finally {
    harness.restore();
    clearResponseCache();
  }
});

test('parallel acquisition keeps available canopy usable before buildings finish', async () => {
  clearResponseCache();
  const harness = browserAcquisitionHarness();
  const world = 20_037_508.342789244;
  try {
    const acquired = await acquireScene(tinyAreaRequest, {
      fetch: harness.fetchImpl,
      vectorTileModules: harness.vectorTileModules,
      geotiffModule: {
        fromUrl: async () => ({ getImage: async () => ({
          getBoundingBox: () => [-world, -world, world, world],
          getWidth: () => 4096,
          getHeight: () => 4096,
          readRasters: async ({ width, height }) => new Float32Array(width * height).fill(10),
        }) }),
      },
      renderOverlays: false,
    });
    assert.equal(acquired.meta.source_status.canopy, 'available');
    assert.ok(acquired.scene.trees.some(row => [...row].some(Number.isFinite)));
  } finally {
    harness.restore();
    clearResponseCache();
  }
});
