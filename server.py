#!/usr/bin/env python3
"""Local mind map server. Serves the web UI in ./static and stores maps in DuckDB."""
import argparse
import json
import mimetypes
import re
import threading
import time
import traceback
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import duckdb

STATIC_DIR = Path(__file__).parent / "static"
MAX_BODY = 64 * 1024 * 1024

SCHEMA = """
CREATE TABLE IF NOT EXISTS maps (
    id         VARCHAR PRIMARY KEY,
    title      VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
    map_id    VARCHAR NOT NULL,
    id        VARCHAR NOT NULL,
    parent_id VARCHAR,
    pos       INTEGER NOT NULL,
    text      VARCHAR NOT NULL DEFAULT '',
    color     VARCHAR,
    collapsed BOOLEAN NOT NULL DEFAULT FALSE,
    bold      BOOLEAN NOT NULL DEFAULT FALSE,
    italic    BOOLEAN NOT NULL DEFAULT FALSE,
    note      VARCHAR,
    link      VARCHAR,
    icon      VARCHAR,
    side      VARCHAR,
    PRIMARY KEY (map_id, id)
);
CREATE INDEX IF NOT EXISTS nodes_map_idx ON nodes (map_id);
"""


NODE_PROPS = ("text", "color", "collapsed", "bold", "italic", "note", "link", "icon", "side")


class NotFound(Exception):
    pass


class BadRequest(Exception):
    pass


def _s(value, default=None):
    return value if isinstance(value, str) else default


def flatten(map_id, root):
    """Turn a nested node tree into rows for the nodes table."""
    rows, seen = [], set()
    stack = [(root, None, 0)]
    while stack:
        node, parent_id, pos = stack.pop()
        if not isinstance(node, dict):
            raise BadRequest("node must be an object")
        nid = _s(node.get("id"))
        if not nid or nid in seen:
            raise BadRequest("node ids must be unique non-empty strings")
        seen.add(nid)
        side = node.get("side") if node.get("side") in ("l", "r") else None
        rows.append((
            map_id, nid, parent_id, pos, _s(node.get("text"), ""), _s(node.get("color")),
            bool(node.get("collapsed")), bool(node.get("bold")), bool(node.get("italic")),
            _s(node.get("note")), _s(node.get("link")), _s(node.get("icon")), side,
        ))
        for i, child in enumerate(node.get("children") or []):
            stack.append((child, nid, i))
    return rows


class Store:
    def __init__(self, path):
        self.con = duckdb.connect(path)
        self.lock = threading.Lock()
        self.con.execute(SCHEMA)

    def list_maps(self):
        with self.lock:
            rows = self.con.execute(
                "SELECT m.id, m.title, m.updated_at, "
                "(SELECT count(*) FROM nodes n WHERE n.map_id = m.id) "
                "FROM maps m ORDER BY m.updated_at DESC"
            ).fetchall()
        return [{"id": r[0], "title": r[1], "updated_at": r[2].isoformat(), "node_count": r[3]} for r in rows]

    def get_map(self, map_id):
        with self.lock:
            m = self.con.execute("SELECT id, title, updated_at FROM maps WHERE id = ?", [map_id]).fetchone()
            if not m:
                raise NotFound(map_id)
            rows = self.con.execute(
                f"SELECT id, parent_id, {', '.join(NODE_PROPS)} "
                "FROM nodes WHERE map_id = ? ORDER BY pos", [map_id]
            ).fetchall()
        by_id, links, root = {}, [], None
        for nid, parent, *props in rows:
            node = {"id": nid, "children": []}
            node.update({k: v for k, v in zip(NODE_PROPS, props) if v or k == "text"})
            by_id[nid] = node
            if parent is None:
                root = node
            else:
                links.append((parent, node))
        for parent, node in links:  # rows are ordered by pos, so sibling order is preserved
            by_id[parent]["children"].append(node)
        if root is None:
            root = {"id": uuid.uuid4().hex[:12], "text": m[1], "children": []}
        return {"id": m[0], "title": m[1], "updated_at": m[2].isoformat(), "root": root}

    def create_map(self, title, root=None):
        map_id = uuid.uuid4().hex[:12]
        title = (title or "Untitled map").strip() or "Untitled map"
        root = root or {"id": uuid.uuid4().hex[:12], "text": title, "children": []}
        rows = flatten(map_id, root)
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        with self.lock:
            self._write(map_id, rows, "INSERT INTO maps VALUES (?, ?, ?, ?)", [map_id, title, now, now])
        return self.get_map(map_id)

    def save_map(self, map_id, title, root):
        rows = flatten(map_id, root)
        with self.lock:
            if not self.con.execute("SELECT 1 FROM maps WHERE id = ?", [map_id]).fetchone():
                raise NotFound(map_id)
            now = time.strftime("%Y-%m-%d %H:%M:%S")
            self._write(map_id, rows, "UPDATE maps SET title = ?, updated_at = ? WHERE id = ?",
                        [(title or "Untitled map"), now, map_id], replace=True)
        return {"id": map_id, "updated_at": now}

    @contextmanager
    def _tx(self):
        self.con.execute("BEGIN")
        try:
            yield self.con
            self.con.execute("COMMIT")
        except Exception:
            self.con.execute("ROLLBACK")
            raise

    def _write(self, map_id, rows, map_sql, map_args, replace=False):
        with self._tx() as con:
            if replace:
                con.execute("DELETE FROM nodes WHERE map_id = ?", [map_id])
            con.execute(map_sql, map_args)
            if rows:
                con.executemany("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)

    def delete_map(self, map_id):
        with self.lock, self._tx() as con:
            con.execute("DELETE FROM nodes WHERE map_id = ?", [map_id])
            con.execute("DELETE FROM maps WHERE id = ?", [map_id])

    def duplicate_map(self, map_id):
        src = self.get_map(map_id)

        def fresh(node):
            copy = dict(node, id=uuid.uuid4().hex[:12])
            copy["children"] = [fresh(c) for c in node["children"]]
            return copy

        return self.create_map(src["title"] + " (copy)", fresh(src["root"]))


MAP_RE = re.compile(r"^/api/maps/([A-Za-z0-9_-]+)(/duplicate)?$")


class Handler(BaseHTTPRequestHandler):
    store = None
    server_version = "MindMap/1.0"

    def log_message(self, fmt, *args):
        pass

    def _host_ok(self):
        # blocks DNS-rebinding: only answer requests addressed to a loopback name
        return urlparse("//" + self.headers.get("Host", "")).hostname in ("127.0.0.1", "localhost", "::1", self.server.bind_host)

    def end_headers(self):
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        super().end_headers()

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        if "application/json" not in self.headers.get("Content-Type", ""):
            raise BadRequest("Content-Type must be application/json")
        length = max(0, int(self.headers.get("Content-Length") or 0))
        if length > MAX_BODY:
            raise BadRequest("body too large")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise BadRequest("invalid JSON")
        if not isinstance(data, dict):
            raise BadRequest("expected a JSON object")
        return data

    def _api(self, method):
        path = urlparse(self.path).path
        try:
            if path == "/api/maps":
                if method == "GET":
                    return self._json(200, self.store.list_maps())
                if method == "POST":
                    data = self._body()
                    return self._json(201, self.store.create_map(_s(data.get("title")), data.get("root")))
            m = MAP_RE.match(path)
            if m:
                map_id, dup = m.groups()
                if dup and method == "POST":
                    return self._json(201, self.store.duplicate_map(map_id))
                if not dup and method == "GET":
                    return self._json(200, self.store.get_map(map_id))
                if not dup and method == "PUT":
                    data = self._body()
                    if not isinstance(data.get("root"), dict):
                        raise BadRequest("root is required")
                    return self._json(200, self.store.save_map(map_id, _s(data.get("title"), ""), data["root"]))
                if not dup and method == "DELETE":
                    self.store.delete_map(map_id)
                    return self._json(200, {"ok": True})
            self._json(404, {"error": "not found"})
        except NotFound:
            self._json(404, {"error": "map not found"})
        except BadRequest as e:
            self._json(400, {"error": str(e)})
        except Exception:  # keep the server alive on unexpected errors
            traceback.print_exc()
            self._json(500, {"error": "internal error"})

    def _static(self):
        rel = unquote(urlparse(self.path).path).lstrip("/") or "index.html"
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR.resolve() not in target.parents or not target.is_file():
            return self._json(404, {"error": "not found"})
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self._host_ok():
            return self._json(403, {"error": "forbidden host"})
        self._api("GET") if self.path.startswith("/api/") else self._static()

    def do_POST(self):
        if not self._host_ok():
            return self._json(403, {"error": "forbidden host"})
        self._api(self.command)

    do_PUT = do_DELETE = do_POST


def main():
    parser = argparse.ArgumentParser(description="Local mind map tool backed by DuckDB")
    parser.add_argument("--db", default="mindmaps.duckdb", help="DuckDB file (default: mindmaps.duckdb)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    Handler.store = Store(args.db)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: no authentication; anyone who can reach this address can read and edit your maps.")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.bind_host = args.host
    print(f"Mind map running at http://{args.host}:{args.port}  (database: {args.db})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
