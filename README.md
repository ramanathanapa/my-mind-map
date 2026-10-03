# My Mind Map

A local, MindMup-style mind map editor. A tiny Python server serves the web UI and stores every map in a
[DuckDB](https://duckdb.org) file (`mindmaps.duckdb` by default).

## Run

```bash
pip install -r requirements.txt
python3 server.py                 # http://127.0.0.1:8765
python3 server.py --db my.duckdb --port 9000
```

Changes auto-save (debounced) to DuckDB. Tables: `maps` (id, title, timestamps) and `nodes`
(one row per node: parent, position, text, color, collapsed, bold/italic, note, link, icon, side),
so you can also query your maps directly, e.g. `SELECT * FROM nodes WHERE note IS NOT NULL`.

## Features

- Add child / sibling, inline edit, delete, collapse/expand, left/right balanced layout around the root
- Keyboard-driven: Tab, Enter, F2, Space, arrows, Ctrl+Up/Down to reorder (press **?** in the app for all shortcuts)
- Drag & drop to re-parent or re-order, multi-select, copy / cut / paste branches (or paste a text outline)
- Colors, icons, bold/italic, notes, links, search, zoom/pan/fit, dark mode, undo/redo
- Multiple maps with open / duplicate / delete
- Import: native JSON, MindMup `.mup`, FreeMind `.mm`, Markdown/indented text outlines (also drag a file onto the page)
- Export: native JSON, `.mup`, `.mm`, Markdown, SVG, PNG

## Tests

```bash
python3 -m unittest discover -s tests      # storage tests (+ browser tests if playwright is installed)
pip install playwright                     # optional, for tests/test_e2e.py
CHROMIUM_PATH=/path/to/chromium python3 -m unittest tests.test_e2e   # if Chromium isn't auto-found
```

`tests/test_store.py` covers DuckDB persistence; `tests/test_e2e.py` starts the server on a free port with a
temporary database and drives the real UI (create/undo/redo/reload, import, search).

Manual smoke test: run the server, press **?** in the app, then try Tab/Enter/Space, drag a node onto another,
Ctrl+Z, Export > PNG, restart the server and confirm the map is still there.
