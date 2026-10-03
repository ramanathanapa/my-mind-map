"""Browser end-to-end tests. Needs: pip install playwright (and a Chromium; set CHROMIUM_PATH if not auto-found)."""
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    sync_playwright = None

ROOT = os.path.join(os.path.dirname(__file__), "..")


@unittest.skipIf(sync_playwright is None, "playwright not installed")
class E2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        s = socket.socket(); s.bind(("127.0.0.1", 0)); cls.port = s.getsockname()[1]; s.close()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--port", str(cls.port),
                                     "--db", os.path.join(cls.tmp.name, "e2e.duckdb")], stdout=subprocess.DEVNULL)
        for _ in range(50):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.port}/api/maps"); break
            except OSError:
                time.sleep(0.1)
        cls.pw = sync_playwright().start()
        exe = os.environ.get("CHROMIUM_PATH") or ("/opt/pw-browsers/chromium" if os.path.exists("/opt/pw-browsers/chromium") else None)
        cls.browser = cls.pw.chromium.launch(executable_path=exe, args=["--no-sandbox"])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.proc.terminate(); cls.tmp.cleanup()

    def setUp(self):
        self.page = self.browser.new_page(viewport={"width": 1400, "height": 800})
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)))
        self.page.goto(f"http://127.0.0.1:{self.port}/")
        self.page.wait_for_selector(".node.root")

    def tearDown(self):
        self.assertEqual(self.errors, [])
        self.page.close()

    def texts(self):
        return self.page.locator(".node .text").all_inner_texts()

    def test_build_tree_undo_and_persist(self):
        pg = self.page
        pg.keyboard.press("Enter"); pg.keyboard.type("Alpha")
        pg.keyboard.press("Tab"); pg.keyboard.type("Child")
        pg.keyboard.press("Enter"); pg.keyboard.press("Escape")  # Enter adds a sibling; Esc discards the empty one
        self.assertIn("Alpha", self.texts()); self.assertEqual(len(self.texts()), 3)
        pg.keyboard.press("Control+z")
        self.assertEqual(len(self.texts()), 2)
        pg.keyboard.press("Control+Shift+z")
        self.assertEqual(len(self.texts()), 3)
        pg.wait_for_function("document.querySelector('#status').textContent === 'Saved'")
        pg.reload(); pg.wait_for_selector(".node.root")
        self.assertIn("Alpha", self.texts())

    def test_import_outline_and_search(self):
        path = os.path.join(self.tmp.name, "o.md")
        open(path, "w").write("# Plan\n- A\n  - A1\n- B\n")
        self.page.set_input_files("#fileInput", path)
        self.page.wait_for_function("document.querySelectorAll('.node').length === 4")
        self.page.fill("#search", "a1")
        self.assertEqual(self.page.locator(".node.match").count(), 1)


if __name__ == "__main__":
    unittest.main()
