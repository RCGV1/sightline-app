"""Unit tests for DEM terrain fetching pipeline."""

import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from demfetch import _bbox, _hillshade, _utm_crs, fetch_dem
from engine import Scene, analyze


class DemFetchTests(unittest.TestCase):
    def test_bbox_and_projection(self):
        west, south, east, north = _bbox([37.3382, -121.8863], 500)
        self.assertLess(west, -121.8863)
        self.assertGreater(east, -121.8863)
        self.assertLess(south, 37.3382)
        self.assertGreater(north, 37.3382)

        crs = _utm_crs(37.3382, -121.8863)
        self.assertEqual(crs.to_epsg(), 32610)

    def test_hillshade(self):
        ground = np.ones((50, 50), dtype=np.float32) * 100.0
        shaded = _hillshade(ground, 3.0)
        self.assertEqual(shaded.shape, (50, 50, 3))
        self.assertEqual(shaded.dtype, np.uint8)
        self.assertTrue(np.all(shaded >= 0))
        self.assertTrue(np.all(shaded <= 255))

    def test_fetch_dem_produces_loadable_scene(self):
        # Create a tiny 30-meter radius DEM scene
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "test_dem.npz"
            meta = fetch_dem([37.7524, -122.4475], 60, 6.0, output_path)
            self.assertTrue(output_path.exists())
            self.assertTrue(meta.get("is_dem"))
            self.assertEqual(meta.get("resolution_m"), 6.0)

            scene = Scene.load(output_path)
            self.assertGreater(scene.ground.shape[0], 0)
            self.assertGreater(scene.ground.shape[1], 0)
            self.assertTrue(np.all(np.isfinite(scene.ground)))

            # Run a path analysis on the generated scene
            res = analyze(scene, {
                "a": scene.meta["default_a"],
                "b": scene.meta["default_b"],
                "height_a": 3.0,
                "height_b": 3.0,
                "mode": "optical"
            })
            self.assertIn("status", res)
            self.assertGreater(res["distance_m"], 0)


if __name__ == "__main__":
    unittest.main()
