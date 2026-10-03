import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from server import BadRequest, NotFound, Store  # noqa: E402


def tree():
    return {"id": "r", "text": "Root", "children": [
        {"id": "a", "text": "A", "color": "#ff0000", "side": "r", "note": "hello",
         "children": [{"id": "a1", "text": "A1", "collapsed": True, "children": []}]},
        {"id": "b", "text": "B", "side": "l", "bold": True, "children": []},
    ]}


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.dir.name, "t.duckdb"))

    def tearDown(self):
        self.dir.cleanup()

    def test_roundtrip_and_persistence(self):
        m = self.store.create_map("T", tree())
        got = self.store.get_map(m["id"])
        self.assertEqual(got["root"]["children"][0]["note"], "hello")
        self.assertEqual([c["id"] for c in got["root"]["children"]], ["a", "b"])
        self.assertTrue(got["root"]["children"][0]["children"][0]["collapsed"])
        reopened = Store(os.path.join(self.dir.name, "t.duckdb"))
        self.assertEqual(reopened.get_map(m["id"])["title"], "T")

    def test_save_replaces_nodes(self):
        m = self.store.create_map("T", tree())
        new = {"id": "r", "text": "Root", "children": [{"id": "z", "text": "Z", "children": []}]}
        self.store.save_map(m["id"], "Renamed", new)
        got = self.store.get_map(m["id"])
        self.assertEqual(got["title"], "Renamed")
        self.assertEqual([c["id"] for c in got["root"]["children"]], ["z"])
        self.assertEqual(self.store.list_maps()[0]["node_count"], 2)

    def test_duplicate_delete_and_errors(self):
        m = self.store.create_map("T", tree())
        d = self.store.duplicate_map(m["id"])
        self.assertNotEqual(d["id"], m["id"])
        self.assertEqual(len(self.store.list_maps()), 2)
        self.store.delete_map(m["id"])
        self.assertEqual(len(self.store.list_maps()), 1)
        with self.assertRaises(NotFound):
            self.store.get_map(m["id"])
        with self.assertRaises(BadRequest):
            self.store.create_map("x", {"id": "r", "text": "", "children": [{"id": "r", "text": ""}]})


if __name__ == "__main__":
    unittest.main()
