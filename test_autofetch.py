import unittest

from autofetch import _select_products, _valid_download_url


def product(tile, west, south, east, north, date="2024-01-01", url=None):
    return {
        "title": "USGS Lidar Point Cloud OR_TEST " + tile,
        "publicationDate": date,
        "sizeInBytes": 100,
        "boundingBox": {"minX": west, "minY": south, "maxX": east, "maxY": north},
        "downloadURL": url or "https://rockyweb.usgs.gov/vdelivery/test-%s.laz" % tile,
    }


class AutoFetchTests(unittest.TestCase):
    def test_selects_latest_complete_survey_tiles(self):
        items = [
            product("001", 0, 0, 1, 1, "2020-01-01"),
            product("001", 0, 0, 0.5, 1),
            product("002", 0.5, 0, 1, 1),
        ]
        selected = _select_products(items, (0, 0, 1, 1))
        self.assertEqual([item["title"].split()[-1] for item in selected], ["001", "002"])

    def test_rejects_untrusted_download_url(self):
        self.assertFalse(_valid_download_url("https://example.com/tile.laz"))
        self.assertTrue(_valid_download_url("https://rockyweb.usgs.gov/vdelivery/tile.laz"))


if __name__ == "__main__":
    unittest.main()
