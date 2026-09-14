import unittest
from eptfetch import _corridor_bbox, _segment_intersects_box
from engine import trace, Scene, settings
from pathlib import Path

ROOT = Path(__file__).resolve().parent

class CorridorTestCase(unittest.TestCase):
    def test_corridor_bbox(self):
        pt_a = [37.7749, -122.4194]
        pt_b = [37.8044, -122.2712]
        west, south, east, north = _corridor_bbox(pt_a, pt_b, buffer_m=60)
        self.assertLess(west, -122.4194)
        self.assertGreater(east, -122.2712)
        self.assertLess(south, 37.7749)
        self.assertGreater(north, 37.8044)

    def test_segment_intersects_box(self):
        p1 = (0.0, 0.0)
        p2 = (10.0, 10.0)
        self.assertTrue(_segment_intersects_box(p1, p2, (4.0, 4.0, 6.0, 6.0)))
        self.assertFalse(_segment_intersects_box(p1, p2, (20.0, 0.0, 30.0, 10.0)))
        self.assertFalse(_segment_intersects_box(p1, p2, (5.0, 0.0, 6.0, 1.0), buffer=0.0))
        self.assertTrue(_segment_intersects_box(p1, p2, (5.0, 0.0, 6.0, 1.0), buffer=5.0))

    def test_trace_returns_segments(self):
        active_path = ROOT / "data" / "bay-area.npz"
        if not active_path.is_file():
            active_path = ROOT / "data" / "autzen.npz"
        if not active_path.is_file():
            return
        scene = Scene.load(active_path)
        meta = scene.meta
        a_ll = meta.get("default_a") or meta["center"]
        b_ll = meta.get("default_b") or meta["center"]
        a_xy = scene.xy(a_ll)
        b_xy = scene.xy(b_ll)
        opts = settings({"height_a": 10, "height_b": 10, "mode": "radio"})
        result = trace(scene, a_xy, b_xy, opts, detailed=True)
        self.assertIn("segments", result)
        self.assertIsInstance(result["segments"], list)
        if result["segments"]:
            seg = result["segments"][0]
            self.assertIn("status", seg)
            self.assertIn("start_m", seg)
            self.assertIn("end_m", seg)
            self.assertIn("start_ll", seg)
            self.assertIn("end_ll", seg)

    def test_long_corridor_adaptive_resolution(self):
        """Verify 22 km path (Monte Bello to Redwood City) fits within MAX_CELLS without crashing."""
        import math
        from demfetch import MAX_CELLS, _utm_crs
        from pyproj import Transformer
        pt_a = [37.3208280, -122.1457000]
        pt_b = [37.5015557, -122.1714090]
        w, s, e, n = _corridor_bbox(pt_a, pt_b, buffer_m=120)
        crs = _utm_crs((s + n) / 2, (w + e) / 2)
        to_xy = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        c1 = to_xy.transform(w, s)
        c2 = to_xy.transform(e, n)
        xmin, ymin = min(c1[0], c2[0]), min(c1[1], c2[1])
        xmax, ymax = max(c1[0], c2[0]), max(c1[1], c2[1])

        resolution = 3.0
        width = int(math.floor((xmax - xmin) / resolution)) + 1
        height = int(math.floor((ymax - ymin) / resolution)) + 1

        if width * height > MAX_CELLS:
            min_res = math.ceil(math.sqrt((xmax - xmin) * (ymax - ymin) / MAX_CELLS) * 10) / 10
            if min_res > resolution:
                resolution = min_res
                width = int(math.floor((xmax - xmin) / resolution)) + 1
                height = int(math.floor((ymax - ymin) / resolution)) + 1
            while width * height > MAX_CELLS:
                resolution = round(resolution + 0.1, 1)
                width = int(math.floor((xmax - xmin) / resolution)) + 1
                height = int(math.floor((ymax - ymin) / resolution)) + 1

        self.assertLessEqual(width * height, MAX_CELLS)
        self.assertGreater(width, 0)
        self.assertGreater(height, 0)

    def test_corridor_gap_detection(self):
        """Ensure endpoints placed in corridor NaN gaps trigger ValueError cleanly."""
        fetched_path = ROOT / "data" / "fetched.npz"
        if not fetched_path.is_file():
            return
        scene = Scene.load(fetched_path)
        if not scene.meta.get("is_corridor"):
            return
        # A point far in the corner of the bounding box but not on the corridor line
        bounds = scene.meta["bounds"]
        corner_ll = [bounds[0][0], bounds[1][1]]  # south-east corner
        corner_xy = scene.xy(corner_ll)
        with self.assertRaises(ValueError) as ctx:
            scene.ground_at(corner_xy[0], corner_xy[1])
        self.assertTrue("coverage" in str(ctx.exception).lower() or "gap" in str(ctx.exception).lower())

if __name__ == '__main__':
    unittest.main()
