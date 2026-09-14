import numpy as np
from affine import Affine
from rasterio.io import MemoryFile

from canopy import _quadkeys_for_bounds, _read_tile


def test_quadkey_selection_is_stable_for_small_area():
    keys = _quadkeys_for_bounds([[44.05, -123.09], [44.06, -123.08]])
    assert keys == ["0212320201"]


def test_max_downsampling_and_nodata_preserve_valid_zero():
    source = np.array([[1, 2, 0, -9999], [3, 9, 4, 5],
                       [-9999, -9999, 6, 7], [-9999, -9999, 8, 10]], dtype=np.float32)
    profile = {"driver": "GTiff", "height": 4, "width": 4, "count": 1,
               "dtype": "float32", "crs": "EPSG:3857",
               "transform": Affine(1, 0, 0, 0, -1, 4), "nodata": -9999}
    destination = np.full((2, 2), np.nan, dtype=np.float32)
    with MemoryFile() as memory:
        with memory.open(**profile) as writer:
            writer.write(source, 1)
        with memory.open() as dataset:
            _read_tile(dataset, destination, Affine(2, 0, 0, 0, -2, 4), "EPSG:3857")
    np.testing.assert_allclose(destination, [[9, 5], [np.nan, 10]], equal_nan=True)


# Expose these numerical checks through the project's standard unittest runner.
import unittest
class CanopyTests(unittest.TestCase):
    def test_quadkeys(self): test_quadkey_selection_is_stable_for_small_area()
    def test_resampling(self): test_max_downsampling_and_nodata_preserve_valid_zero()
