import assert from 'node:assert/strict';
import test from 'node:test';
import { Scene, analyze, viewshed } from './static/engine.js';

function scene(size = 20) {
  const grid = value => Array.from({length:size}, () => Array(size).fill(value));
  return new Scene({
    ground:grid(100), buildings:grid(null), trees:grid(null), unknown:grid(null),
    meta:{xmin:500000, ymax:4200000, resolution_m:1, crs:'EPSG:32610', bounds:[[37.94,-123],[37.95,-122.99]]}
  });
}

test('JSON null remains nodata in client traces', () => {
  const s = scene();
  s.ground[10][10] = null;
  assert.throws(() => s.groundAt(500021, 4199979), /coverage/i);
});

test('client viewshed rejects grids above the responsive limit', () => {
  const s = scene(150);
  assert.throws(() => viewshed(s, {a:[37.945,-122.995], radius_m:60, step_m:1}), /at least 2 m/);
});

test('client path engine analyzes a clear scene', () => {
  const s = scene();
  const result = analyze(s, {a:[37.945,-122.998], b:[37.945,-122.992], height_a:10, height_b:10, mode:'optical'});
  assert.equal(result.status, 'clear');
  assert.ok(result.profile.length > 2);
});

test('rooftop origin leaves its own footprint but not later buildings', () => {
  const s = scene(100);
  for (let col = 10; col < 21; col++) s.buildings[50][col] = 130;
  const params = {a:[37.945,-122.999], b:[37.945,-122.991], height_a:5, height_b:5, mount_type_a:'rooftop', mode:'optical'};
  assert.equal(analyze(s, params).status, 'clear');
  s.buildings[50][50] = 130;
  assert.equal(analyze(s, params).status, 'blocked');
});

test('rooftop origin descending ray cannot cross its own building', () => {
  const s = scene(100);
  for (let col = 10; col < 35; col++) s.buildings[50][col] = 130;
  const params = {a:[37.945,-122.999], b:[37.945,-122.991], height_a:5, height_b:.1, mount_type_a:'rooftop', mode:'optical'};
  assert.equal(analyze(s, params).status, 'blocked');
});

test('client viewshed keeps antimeridian bounds local to the origin', () => {
  const size = 100;
  const grid = value => Array.from({length:size}, () => Array(size).fill(value));
  const s = new Scene({
    ground:grid(0), buildings:grid(null), trees:grid(null), unknown:grid(null),
    meta:{xmin:0, ymax:100, resolution_m:1, crs:'EPSG:32610', bounds:[[0,179.99],[0.01,180.01]], longitude_wrap:true}
  });
  const result = viewshed(s, {a:[0.005,179.999], radius_m:10, step_m:2, mode:'optical'});
  assert.ok(result.bounds[1][1] - result.bounds[0][1] < 0.01);
  assert.ok(result.bounds[0][1] < 180 && result.bounds[1][1] > 180);
  assert.ok(result.counts.clear > 0);
});
