import json
import tempfile
import unittest
from pathlib import Path

import laspy
import numpy as np
from pyproj import CRS

from lidar import import_lidar


class ImportLidarTests(unittest.TestCase):
    def test_writes_north_up_metric_rasters_and_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "sample.las"
            output = Path(temp) / "sample.npz"
            header = laspy.LasHeader(point_format=3, version="1.2")
            header.add_crs(CRS.from_epsg(32610))
            points = laspy.ScaleAwarePointRecord.zeros(5, header=header)
            points.x = [500001, 500004, 500001, 500004, 500007]
            points.y = [5100004, 5100004, 5100001, 5100001, 5100001]
            points.z = [100, 101, 120, 130, 140]
            points.classification = [2, 2, 6, 5, 15]
            points.red = [65535, 0, 0, 0, 65535]
            points.green = [0, 65535, 0, 65535, 0]
            points.blue = [0, 0, 65535, 0, 65535]
            las = laspy.LasData(header)
            las.points = points
            las.write(source)

            result = import_lidar(source, output, resolution=3.0, name="Sample", source="unit", vertical_unit="m")
            raster = np.load(output)
            meta = json.loads(str(raster["meta"]))

            self.assertEqual(raster["ground"].shape, (2, 3))
            self.assertEqual(raster["ground"].dtype, np.float32)
            self.assertAlmostEqual(raster["ground"][0, 0], 100.0)
            self.assertAlmostEqual(raster["ground"][0, 1], 101.0)
            self.assertAlmostEqual(raster["buildings"][1, 0], 120.0)
            self.assertAlmostEqual(raster["trees"][1, 1], 130.0)
            self.assertAlmostEqual(raster["unknown"][1, 2], 140.0)
            self.assertEqual(raster["rgb"][0, 0].tolist(), [255, 0, 0])
            self.assertEqual(meta["name"], "Sample")
            self.assertEqual(meta["source"], "unit")
            self.assertEqual(meta["resolution_m"], 3.0)
            self.assertEqual(meta["crs"], "EPSG:32610")
            self.assertNotEqual(meta["default_a"], meta["default_b"])
            self.assertEqual(result["name"], "Sample")

    def test_rejects_nonmetric_z_without_explicit_unit(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "feet.las"
            header = laspy.LasHeader(point_format=3, version="1.2")
            header.add_crs(CRS.from_epsg(2227))
            las = laspy.LasData(header)
            las.x, las.y, las.z = [6300000], [2200000], [100]
            las.classification = [2]
            las.write(source)

            with self.assertRaisesRegex(ValueError, "vertical_unit"):
                import_lidar(source, Path(temp) / "out.npz")

            import_lidar(source, Path(temp) / "out.npz", vertical_unit="us-ft")
            self.assertAlmostEqual(np.load(Path(temp) / "out.npz")["ground"][0, 0], 30.48, places=2)

    def test_requires_explicit_vertical_units_when_crs_has_no_vertical_axis(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "utm.las"
            header = laspy.LasHeader(point_format=3, version="1.2")
            header.add_crs(CRS.from_epsg(32610))
            las = laspy.LasData(header)
            las.x, las.y, las.z = [500000], [5100000], [100]
            las.classification = [2]
            las.write(source)

            with self.assertRaisesRegex(ValueError, "vertical_unit"):
                import_lidar(source, Path(temp) / "out.npz")

    def test_ignores_withheld_and_noise_returns(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / "noise.las"
            output = Path(temp) / "out.npz"
            header = laspy.LasHeader(point_format=3, version="1.4")
            header.add_crs(CRS.from_epsg(32610))
            las = laspy.LasData(header)
            las.x, las.y, las.z = [500000, 500003, 500006], [5100000] * 3, [100, 200, 300]
            las.classification = [2, 7, 18]
            las.withheld = [False, True, False]
            las.write(source)

            import_lidar(source, output, vertical_unit="m")
            raster = np.load(output)
            self.assertTrue(np.isnan(raster["unknown"]).all())
            self.assertEqual(np.isfinite(raster["ground"]).sum(), 1)


if __name__ == "__main__":
    unittest.main()
