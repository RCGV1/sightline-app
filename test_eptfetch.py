import unittest

from eptfetch import _bbox, _intersects, _node_bounds, _official, _sampling_depth, _select_item


class EptFetchTests(unittest.TestCase):
    def test_geographic_bbox_and_intersection(self):
        box = _bbox([44.05, -123.08], 100)
        self.assertLess(box[0], -123.08)
        self.assertGreater(box[2], -123.08)
        self.assertTrue(_intersects(box, (-124, 43, -122, 45)))
        self.assertFalse(_intersects(box, (-121, 43, -120, 45)))

    def test_selects_newest_intersecting_project(self):
        def item(identifier, box, date):
            return {"id": identifier, "bbox": box, "properties": {"datetime": date},
                    "assets": {"ept.json": {"href": "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/%s/ept.json" % identifier}}}
        collection = {"features": [item("old", [0, 0, 2, 2], "2020-01-01"),
                                   item("new", [0, 0, 2, 2], "2024-01-01"),
                                   item("away", [5, 5, 6, 6], "2025-01-01")]}
        self.assertEqual(_select_item(collection, (0.5, 0.5, 1, 1))["id"], "new")

    def test_octree_node_bounds(self):
        root = [0, 0, -10, 8, 8, 6]
        self.assertEqual(_node_bounds(root, "1-1-0-1"), (4, 0, -2, 8, 4, 6))

    def test_resolution_selects_sampling_depth(self):
        metadata = {"bounds": [0, 0, 0, 1024, 512, 100], "span": 128}
        self.assertEqual(_sampling_depth(metadata, 16), (0, 8))
        self.assertEqual(_sampling_depth(metadata, 4), (2, 2))
        with self.assertRaisesRegex(ValueError, "invalid bounds or span"):
            _sampling_depth({"bounds": [0, 0, 0, 1, 1, 1], "span": 0}, 1)

    def test_official_urls_are_path_restricted(self):
        self.assertTrue(_official("https://s3-us-west-2.amazonaws.com/usgs-lidar-public/a/ept.json"))
        self.assertTrue(_official("https://usgs-lidar-stac.s3-us-west-2.amazonaws.com/ept/item_collection.json"))
        self.assertFalse(_official("https://s3-us-west-2.amazonaws.com/unrelated-bucket/file.laz"))

    def test_rejects_missing_coverage(self):
        with self.assertRaisesRegex(ValueError, "no measured LiDAR"):
            _select_item({"features": []}, (0, 0, 1, 1))


if __name__ == "__main__":
    unittest.main()
