'use strict';

// ---------------------------------------------------------------- helpers
const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const clone = (o) => JSON.parse(JSON.stringify(o));
const BRANCH_COLORS = ['#e5484d', '#f08c00', '#2f9e44', '#1c7ed6', '#9c36b5', '#0c8599', '#d6336c', '#5c7cfa'];
const FILL_COLORS = ['#ffffff', '#ffe3e3', '#ffe8cc', '#fff3bf', '#d3f9d8', '#c5f6fa', '#d0ebff', '#e5dbff', '#fcc2d7',
  '#dee2e6', '#ffa8a8', '#ffd43b', '#69db7c', '#74c0fc', '#b197fc', '#495057'];
const ICONS = ['⭐', '✅', '❗', '❓', '💡', '🔥', '📌', '⚠️', '❤️', '👍', '👎', '🚩', '📅', '⏰', '💰', '🎯', '🔒', '🚀'];
const HGAP = 56, VGAP = 12;

async function api(method, url, body) {
  const res = await fetch(url, {
    method, keepalive: method === 'PUT',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function contrastText(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#1f2430' : '#ffffff';
}

// ---------------------------------------------------------------- state
let doc = null;                 // { id, title, root }
let index = new Map();          // id -> { n, parent, depth, side }
let pos = new Map();            // id -> { x, y, w, h, dir }
let sel = new Set();
let primary = null;
let undoStack = [], redoStack = [];
let view = { x: 0, y: 0, s: 1 };
let editing = null;             // { id, isNew, original }
let forceOpen = new Set();
let matches = new Set();
let saveTimer = null, saving = Promise.resolve();
let internalClip = null;

const isCollapsed = (n) => n.collapsed && !forceOpen.has(n.id);
const visibleKids = (n) => (isCollapsed(n) ? [] : n.children);

function reindex() {
  index = new Map();
  (function walk(n, parent, depth, side) {
    index.set(n.id, { n, parent, depth, side });
    n.children.forEach((c, i) => walk(c, n, depth + 1, parent ? side : c.side || 'r'));
  })(doc.root, null, 0, null);
  // make sure root children have an explicit side
  doc.root.children.forEach((c) => { if (c.side !== 'l' && c.side !== 'r') c.side = 'r'; });
}

function normalize(n) {
  n.id = n.id || uid();
  n.text = typeof n.text === 'string' ? n.text : '';
  n.children = (n.children || []).map(normalize);
  return n;
}

function freshIds(n) {
  n.id = uid();
  n.children.forEach(freshIds);
  return n;
}

// ---------------------------------------------------------------- persistence
function setStatus(s) { $('#status').textContent = s; }

function scheduleSave() {
  setStatus('Unsaved…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!doc) return saving;
  const payload = { title: doc.title, root: doc.root };
  const id = doc.id;
  setStatus('Saving…');
  saving = api('PUT', `/api/maps/${id}`, payload)
    .then(() => { if (!saveTimer) setStatus('Saved'); })
    .catch((e) => { setStatus('Save failed!'); toast('Save failed: ' + e.message); });
  return saving;
}

window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); });

// ---------------------------------------------------------------- undo / redo
function snapshot() { return JSON.stringify({ title: doc.title, root: doc.root, sel: [...sel], primary }); }

function mutate(fn, { merge = false } = {}) {
  if (!merge) { undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift(); redoStack = []; }
  fn();
  afterChange();
}

function restore(snap) {
  const s = JSON.parse(snap);
  doc.title = s.title; doc.root = s.root;
  reindex();
  sel = new Set(s.sel.filter((id) => index.has(id)));
  primary = index.has(s.primary) ? s.primary : doc.root.id;
  if (!sel.size) sel.add(primary);
  $('#title').value = doc.title;
  afterChange();
}

function undo() {
  if (editing) return;
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  if (editing || !redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function afterChange() {
  reindex();
  build();
  scheduleSave();
}

// ---------------------------------------------------------------- rendering & layout
function branchColors() {
  const map = new Map();
  doc.root.children.forEach((c, i) => {
    const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
    (function walk(n) { map.set(n.id, color); n.children.forEach(walk); })(c);
  });
  return map;
}

function build() {
  const layer = $('#nodes');
  layer.textContent = '';
  const colors = branchColors();
  const searching = $('#search').value.trim() !== '';
  (function walk(n) {
    const info = index.get(n.id);
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = n.id;
    if (!info.parent) el.classList.add('root');
    else el.style.setProperty('--branch', colors.get(n.id));
    if (n.children.length) el.classList.add('has-kids');
    if (isCollapsed(n)) el.classList.add('collapsed');
    if (n.bold) el.classList.add('bold');
    if (n.italic) el.classList.add('italic');
    if (sel.has(n.id)) el.classList.add('selected');
    if (matches.has(n.id)) el.classList.add('match');
    else if (searching) el.classList.add('dim');
    if (n.color && info.parent) { el.style.background = n.color; el.style.color = contrastText(n.color); }
    if (n.color && !info.parent) { el.style.background = n.color; el.style.borderColor = n.color; el.style.color = contrastText(n.color); }
    if (n.note) el.title = n.note.length > 300 ? n.note.slice(0, 300) + '…' : n.note;

    if (n.icon) { const i = document.createElement('span'); i.className = 'icon'; i.textContent = n.icon; el.append(i); }
    const t = document.createElement('span');
    t.className = 'text'; t.textContent = n.text;
    el.append(t);
    if (n.note) { const b = document.createElement('span'); b.className = 'badge'; b.dataset.act = 'note'; b.textContent = '📝'; el.append(b); }
    if (n.link) {
      const a = document.createElement('a');
      a.className = 'badge'; a.dataset.act = 'link'; a.textContent = '🔗'; a.href = n.link;
      a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = n.link;
      el.append(a);
    }
    if (n.children.length) {
      const f = document.createElement('span');
      f.className = 'fold'; f.dataset.act = 'fold';
      f.textContent = isCollapsed(n) ? String(countDesc(n)) : '−';
      el.append(f);
    }
    layer.append(el);
    visibleKids(n).forEach(walk);
  })(doc.root);
  place();
  updateToolbar();
}

function countDesc(n) { return n.children.reduce((a, c) => a + 1 + countDesc(c), 0); }

function nodeEl(id) { return $('#nodes').querySelector(`[data-id="${id}"]`); }

function place() {
  const size = new Map();
  for (const el of $('#nodes').children) size.set(el.dataset.id, { w: el.offsetWidth, h: el.offsetHeight });
  const subH = new Map();
  (function measure(n) {
    const kids = visibleKids(n);
    kids.forEach(measure);
    const kh = kids.reduce((a, c) => a + subH.get(c.id), 0) + Math.max(0, kids.length - 1) * VGAP;
    subH.set(n.id, Math.max(size.get(n.id).h, kh));
  })(doc.root);

  pos = new Map();
  const edges = [];
  const stackKids = (kids, parentId, x, dir, top) => {
    // x is the parent's anchor edge; children start HGAP away from it
    let y = top;
    for (const c of kids) {
      const s = size.get(c.id), h = subH.get(c.id);
      const left = dir > 0 ? x + HGAP : x - HGAP - s.w;
      layoutNode(c, left, y, dir, parentId);
      y += h + VGAP;
    }
  };
  const layoutNode = (n, left, top, dir, parentId) => {
    const s = size.get(n.id), h = subH.get(n.id);
    const cy = top + h / 2;
    pos.set(n.id, { x: left, y: cy - s.h / 2, w: s.w, h: s.h, dir });
    if (parentId) edges.push([parentId, n.id, dir]);
    const kids = visibleKids(n);
    if (kids.length) {
      const total = kids.reduce((a, c) => a + subH.get(c.id), 0) + (kids.length - 1) * VGAP;
      stackKids(kids, n.id, dir > 0 ? left + s.w : left, dir, cy - total / 2);
    }
  };

  const rs = size.get(doc.root.id);
  pos.set(doc.root.id, { x: -rs.w / 2, y: -rs.h / 2, w: rs.w, h: rs.h, dir: 0 });
  for (const [side, dir] of [['r', 1], ['l', -1]]) {
    const kids = visibleKids(doc.root).filter((c) => c.side === side);
    if (!kids.length) continue;
    const total = kids.reduce((a, c) => a + subH.get(c.id), 0) + (kids.length - 1) * VGAP;
    stackKids(kids, doc.root.id, dir > 0 ? rs.w / 2 : -rs.w / 2, dir, -total / 2);
  }

  for (const el of $('#nodes').children) {
    const p = pos.get(el.dataset.id);
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.classList.toggle('dir-l', p.dir < 0);
    el.classList.toggle('dir-r', p.dir >= 0);
  }
  drawEdges(edges);
}

function drawEdges(edges) {
  const svg = $('#edges');
  svg.textContent = '';
  const colors = branchColors();
  for (const [from, to, dir] of edges) {
    const a = pos.get(from), b = pos.get(to);
    const x1 = dir > 0 ? a.x + a.w : a.x, y1 = a.y + a.h / 2;
    const x2 = dir > 0 ? b.x : b.x + b.w, y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
    path.setAttribute('stroke', colors.get(to) || '#888');
    path.setAttribute('stroke-width', String(Math.max(1.5, 3.5 - index.get(to).depth * 0.5)));
    svg.append(path);
  }
}

function applyView() {
  $('#canvas').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
}

function viewportSize() {
  const r = $('#viewport').getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function fit() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pos.values()) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
  }
  const { w, h } = viewportSize();
  const pad = 60;
  view.s = Math.max(0.2, Math.min(1.2, Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0))));
  view.x = w / 2 - ((x0 + x1) / 2) * view.s;
  view.y = h / 2 - ((y0 + y1) / 2) * view.s;
  applyView();
}

function zoomAt(factor, cx, cy) {
  const s = Math.min(3, Math.max(0.15, view.s * factor));
  const k = s / view.s;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.s = s;
  applyView();
}

function ensureVisible(id) {
  const p = pos.get(id);
  if (!p) return;
  const { w, h } = viewportSize();
  const m = 50;
  const l = p.x * view.s + view.x, r = (p.x + p.w) * view.s + view.x;
  const t = p.y * view.s + view.y, b = (p.y + p.h) * view.s + view.y;
  if (l < m) view.x += m - l; else if (r > w - m) view.x -= r - (w - m);
  if (t < m) view.y += m - t; else if (b > h - m) view.y -= b - (h - m);
  applyView();
}

function updateToolbar() {
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
  const n = index.get(primary)?.n;
  $('#btnBold').style.background = n?.bold ? 'var(--hover)' : '';
  $('#btnItalic').style.background = n?.italic ? 'var(--hover)' : '';
}

function refreshSelection() {
  for (const el of $('#nodes').children) el.classList.toggle('selected', sel.has(el.dataset.id));
  updateToolbar();
}

// ---------------------------------------------------------------- selection helpers
function select(id, { add = false, toggle = false } = {}) {
  if (toggle) {
    if (sel.has(id) && sel.size > 1) sel.delete(id); else sel.add(id);
  } else if (add) sel.add(id);
  else sel = new Set([id]);
  primary = sel.has(id) ? id : [...sel][0];
  refreshSelection();
  ensureVisible(id);
}

// top-level selected nodes (ignores root and nodes whose ancestor is also selected)
function selectedRoots() {
  return [...sel].filter((id) => {
    if (id === doc.root.id) return false;
    for (let p = index.get(id).parent; p; p = index.get(p.id).parent) if (sel.has(p.id)) return false;
    return true;
  });
}

function siblingsOf(id) {
  const info = index.get(id);
  return info.parent ? info.parent.children : [doc.root];
}

// ---------------------------------------------------------------- editing operations
function pickSide() {
  const r = doc.root.children.filter((c) => c.side === 'r').length;
  return r > doc.root.children.length - r ? 'l' : 'r';
}

function addChild(parentId = primary) {
  const parent = index.get(parentId).n;
  const node = { id: uid(), text: '', children: [] };
  mutate(() => {
    parent.collapsed = false;
    if (parent === doc.root) node.side = pickSide();
    parent.children.push(node);
    sel = new Set([node.id]); primary = node.id;
  });
  startEdit(node.id, true);
}

function addSibling(id = primary) {
  const info = index.get(id);
  if (!info.parent) return addChild(id);
  const node = { id: uid(), text: '', children: [] };
  mutate(() => {
    if (info.parent === doc.root) node.side = info.n.side;
    const i = info.parent.children.indexOf(info.n);
    info.parent.children.splice(i + 1, 0, node);
    sel = new Set([node.id]); primary = node.id;
  });
  startEdit(node.id, true);
}

function deleteSelected() {
  const ids = selectedRoots();
  if (!ids.length) return;
  const first = index.get(ids[0]);
  const sibs = first.parent.children;
  const i = sibs.indexOf(first.n);
  mutate(() => {
    for (const id of ids) {
      const info = index.get(id);
      info.parent.children.splice(info.parent.children.indexOf(info.n), 1);
    }
    const remaining = sibs.filter((c) => !ids.includes(c.id));
    const next = remaining[Math.min(i, remaining.length - 1)] || first.parent;
    sel = new Set([next.id]); primary = next.id;
  });
}

function moveSibling(dir) {
  const id = primary;
  const info = index.get(id);
  if (!info.parent) return;
  const sibs = info.parent.children;
  let i = sibs.indexOf(info.n);
  let j = i + dir;
  while (j >= 0 && j < sibs.length && info.parent === doc.root && sibs[j].side !== info.n.side) j += dir;
  if (j < 0 || j >= sibs.length) return;
  mutate(() => { sibs.splice(i, 1); sibs.splice(j, 0, info.n); });
}

function setProp(key, value) {
  const ids = [...sel];
  mutate(() => ids.forEach((id) => {
    const n = index.get(id).n;
    if (value === null || value === false || value === '') delete n[key]; else n[key] = value;
  }));
}

function toggleCollapse(id, collapse) {
  const n = index.get(id).n;
  if (!n.children.length) return;
  const want = collapse === undefined ? !isCollapsed(n) : collapse;
  mutate(() => {
    forceOpen.delete(n.id);
    if (want) n.collapsed = true; else delete n.collapsed;
  });
}

function setAllCollapsed(collapse) {
  mutate(() => {
    forceOpen.clear();
    (function walk(n, top) {
      if (n.children.length && !top) { if (collapse) n.collapsed = true; else delete n.collapsed; }
      n.children.forEach((c) => walk(c, false));
    })(doc.root, true);
    if (!collapse) delete doc.root.collapsed;
    if (collapse) doc.root.children.forEach((c) => { if (c.children.length) c.collapsed = true; });
  });
  fit();
}

// moves one node without touching undo state; returns false if the move is invalid
function applyMove(id, targetId, mode, dropSide) {
  reindex();
  const src = index.get(id), tgt = index.get(targetId);
  if (!src || !tgt || !src.parent || isInSubtree(id, targetId)) return false;
  src.parent.children.splice(src.parent.children.indexOf(src.n), 1);
  let newParent, at;
  if (mode === 'child' || !tgt.parent) {
    newParent = tgt.n; at = newParent.children.length; delete newParent.collapsed;
  } else {
    newParent = tgt.parent;
    at = newParent.children.indexOf(tgt.n) + (mode === 'after' ? 1 : 0);
  }
  newParent.children.splice(at, 0, src.n);
  if (newParent === doc.root) src.n.side = mode === 'child' ? dropSide || pickSide() : tgt.n.side || 'r';
  else delete src.n.side;
  return true;
}

function moveNodes(ids, targetId, mode, dropSide) {
  mutate(() => {
    const moved = ids.filter((id) => applyMove(id, targetId, mode, dropSide));
    if (moved.length) { sel = new Set(moved); primary = moved[0]; }
  });
}

// ---------------------------------------------------------------- inline text editing
function startEdit(id, isNew = false) {
  const info = index.get(id);
  if (!info) return;
  if (editing) stopEdit(true);
  const el = nodeEl(id);
  if (!el) return;
  const t = el.querySelector('.text');
  editing = { id, isNew, original: info.n.text };
  t.contentEditable = 'plaintext-only';
  if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
  t.style.cursor = 'text'; t.style.userSelect = 'text';
  t.focus();
  const range = document.createRange();
  range.selectNodeContents(t);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  ensureVisible(id);
}

function stopEdit(commit) {
  if (!editing) return;
  const { id, isNew, original } = editing;
  editing = null;
  const el = nodeEl(id);
  const t = el && el.querySelector('.text');
  const text = t ? t.innerText.replace(/\n+$/, '') : original;
  getSelection().removeAllRanges();
  const n = index.get(id)?.n;
  if (!n) return;
  if (!commit) {
    if (isNew) undo(); else build();
  } else if (isNew && text.trim() === '') {
    undo();
  } else if (text !== original) {
    mutate(() => { n.text = text; }, { merge: isNew });
  } else {
    build();
  }
  $('#viewport').focus();
}

document.addEventListener('input', (e) => {
  if (editing && e.target.classList.contains('text')) place();
});

// ---------------------------------------------------------------- navigation
function navigate(key) {
  const info = index.get(primary);
  const p = pos.get(primary);
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const dirWanted = key === 'ArrowRight' ? 1 : -1;
    if (!info.parent) {
      const kid = visibleKids(info.n).find((c) => (c.side === 'r' ? 1 : -1) === dirWanted);
      return kid && select(kid.id);
    }
    if (p.dir === dirWanted) { // away from root
      if (!info.n.children.length) return;
      if (isCollapsed(info.n)) toggleCollapse(info.n.id, false);
      return select(info.n.children[0].id);
    }
    return select(info.parent.id);
  }
  // up / down: nearest visible node in the same column (same depth and side)
  const dy = key === 'ArrowDown' ? 1 : -1;
  let best = null, bestD = Infinity;
  for (const [id, q] of pos) {
    if (id === primary || q.dir !== p.dir || index.get(id).depth !== info.depth) continue;
    const d = (q.y - p.y) * dy;
    if (d > 0 && d < bestD) { best = id; bestD = d; }
  }
  if (best) select(best);
}

// ---------------------------------------------------------------- search
function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  matches = new Set(); forceOpen = new Set();
  if (q) {
    (function walk(n, ancestors) {
      if ((n.text + ' ' + (n.note || '')).toLowerCase().includes(q)) {
        matches.add(n.id);
        ancestors.forEach((a) => forceOpen.add(a.id));
      }
      n.children.forEach((c) => walk(c, [...ancestors, n]));
    })(doc.root, []);
  }
  build();
}

function searchStep(dir) {
  const list = [...matches];
  if (!list.length) return;
  const i = list.indexOf(primary);
  select(list[(i + dir + list.length) % list.length]);
}

// ---------------------------------------------------------------- popovers & dialogs
function showPopover(anchor, build) {
  const pop = $('#popover');
  if (!pop.hidden && pop.dataset.anchor === anchor.id) return hidePopover();
  pop.textContent = '';
  build(pop);
  pop.dataset.anchor = anchor.id;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.top = r.bottom + 6 + 'px';
  pop.style.left = Math.min(r.left, window.innerWidth - pop.offsetWidth - 8) + 'px';
}

function hidePopover() { $('#popover').hidden = true; $('#popover').dataset.anchor = ''; }

function swatchGrid(pop, items, render, onPick) {
  const grid = document.createElement('div');
  grid.className = 'grid';
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'sw'; render(b, it);
    b.onclick = () => { hidePopover(); onPick(it); };
    grid.append(b);
  });
  pop.append(grid);
  const clear = document.createElement('button');
  clear.className = 'menu-item'; clear.textContent = '✕ Clear';
  clear.onclick = () => { hidePopover(); onPick(null); };
  pop.append(clear);
}

function editNote() {
  const n = index.get(primary).n;
  const dlg = $('#noteDialog');
  $('#noteText').value = n.note || '';
  dlg.returnValue = '';
  dlg.onclose = () => {
    if (dlg.returnValue === 'ok') setProp('note', $('#noteText').value.trim() || null);
    else if (dlg.returnValue === 'clear') setProp('note', null);
  };
  dlg.showModal();
  $('#noteText').focus();
}

function editLink() {
  const n = index.get(primary).n;
  const url = prompt('Link URL (leave empty to remove):', n.link || 'https://');
  if (url === null) return;
  const v = url.trim();
  if (v && !/^(https?:|mailto:)/i.test(v)) return toast('Only http(s) and mailto links are supported');
  setProp('link', v && v !== 'https://' ? v : null);
}

// ---------------------------------------------------------------- import / export
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileBase = () => (doc.title || 'mindmap').replace(/[^\w\- ]+/g, '').trim() || 'mindmap';
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim();

function toMarkdown(root) {
  const out = [];
  const label = (n) => (n.link ? `[${oneLine(n.text)}](${n.link})` : oneLine(n.text));
  const walk = (n, depth) => {
    const pad = '  '.repeat(depth);
    out.push(`${pad}- ${label(n)}`);
    if (n.note) n.note.split('\n').forEach((l) => out.push(`${pad}  > ${l}`));
    n.children.forEach((c) => walk(c, depth + 1));
  };
  out.push(`# ${oneLine(root.text)}`, '');
  if (root.note) out.push(...root.note.split('\n').map((l) => `> ${l}`), '');
  root.children.forEach((c) => walk(c, 0));
  return out.join('\n') + '\n';
}

function toOutline(nodes) {
  const out = [];
  const walk = (n, d) => { out.push('  '.repeat(d) + '- ' + oneLine(n.text)); n.children.forEach((c) => walk(c, d + 1)); };
  nodes.forEach((n) => walk(n, 0));
  return out.join('\n');
}

function parseOutline(text, title) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const items = [];
  let rootTitle = null;
  for (const raw of lines) {
    const h = /^#\s+(.*)$/.exec(raw);
    if (h && rootTitle === null && !items.length) { rootTitle = h[1].trim(); continue; }
    const m = /^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/.exec(raw.replace(/\t/g, '    '));
    let t = m[2].trim();
    const q = /^>\s?(.*)$/.exec(t);
    if (q && items.length) { const last = items[items.length - 1]; last.note = (last.note ? last.note + '\n' : '') + q[1]; continue; }
    const link = /^\[(.*)\]\((https?:[^)]+)\)$/.exec(t);
    items.push({ indent: m[1].length, text: link ? link[1] : t, link: link ? link[2] : undefined, note: undefined });
  }
  const mk = (it) => normalize({ text: it.text, link: it.link, note: it.note, children: [] });
  let top = [];
  const stack = [];
  for (const it of items) {
    const node = mk(it);
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node); else top.push(node);
    stack.push({ indent: it.indent, node });
  }
  let root;
  if (rootTitle === null && top.length === 1) root = top[0];
  else root = normalize({ text: rootTitle || title, children: top });
  return root;
}

function toFreeMind(root) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xa;');
  const walk = (n, top) => {
    let a = `ID="ID_${n.id}" TEXT="${esc(n.text)}"`;
    if (n.collapsed) a += ' FOLDED="true"';
    if (top) a += ` POSITION="${n.side === 'l' ? 'left' : 'right'}"`;
    if (n.color) a += ` BACKGROUND_COLOR="${n.color}"`;
    if (n.link) a += ` LINK="${esc(n.link)}"`;
    let inner = '';
    if (n.note) inner += `<richcontent TYPE="NOTE"><html><head/><body><p>${esc(n.note).replace(/&#xa;/g, '<br/>')}</p></body></html></richcontent>`;
    inner += n.children.map((c) => walk(c, n === root)).join('');
    return `<node ${a}>${inner}</node>`;
  };
  return `<map version="1.0.1">${walk(root, false)}</map>\n`;
}

function fromFreeMind(xml) {
  const d = new DOMParser().parseFromString(xml, 'text/xml');
  if (d.querySelector('parsererror')) throw new Error('Invalid .mm file');
  const el = d.querySelector('map > node');
  if (!el) throw new Error('No nodes found');
  const conv = (e, top) => {
    const n = { text: e.getAttribute('TEXT') || '', children: [] };
    if (e.getAttribute('FOLDED') === 'true') n.collapsed = true;
    const bg = e.getAttribute('BACKGROUND_COLOR'); if (bg) n.color = bg;
    const link = e.getAttribute('LINK'); if (link && /^(https?:|mailto:)/i.test(link)) n.link = link;
    if (top) n.side = e.getAttribute('POSITION') === 'left' ? 'l' : 'r';
    for (const c of e.children) {
      if (c.tagName === 'node') n.children.push(conv(c, false));
      else if (c.tagName === 'richcontent' && c.getAttribute('TYPE') === 'NOTE') n.note = c.textContent.trim();
    }
    return n;
  };
  const root = conv(el, false);
  root.children = [...el.children].filter((c) => c.tagName === 'node').map((c) => conv(c, true));
  return normalize(root);
}

function toMindMup(root, title) {
  const attrOf = (n) => {
    const attr = {};
    if (n.color) attr.style = { background: n.color };
    if (n.note) attr.note = { index: 1, text: n.note };
    if (n.collapsed) attr.collapsed = true;
    if (n.link) attr.attachment = { contentType: 'text/html', content: `<a href="${n.link}">${n.link}</a>` };
    return Object.keys(attr).length ? attr : undefined;
  };
  const conv = (n, rootLevel, counter) => {
    const idea = { id: counter.n++, title: n.text };
    const attr = attrOf(n); if (attr) idea.attr = attr;
    if (n.children.length) {
      idea.ideas = {};
      if (rootLevel) {
        let r = 0, l = 0;
        n.children.forEach((c) => { const rank = c.side === 'l' ? -(++l) : ++r; idea.ideas[rank] = conv(c, false, counter); });
      } else n.children.forEach((c, i) => { idea.ideas[i + 1] = conv(c, false, counter); });
    }
    return idea;
  };
  return { id: 'root', formatVersion: 3, title, ideas: { 1: conv(root, true, { n: 1 }) } };
}

function fromMindMup(data) {
  const first = Object.values(data.ideas || {})[0];
  if (!first) throw new Error('Empty MindMup file');
  const conv = (idea, rootLevel) => {
    const n = { text: String(idea.title ?? ''), children: [] };
    const a = idea.attr || {};
    if (a.style && a.style.background && /^#[0-9a-f]{6}$/i.test(a.style.background)) n.color = a.style.background;
    if (a.note && a.note.text) n.note = String(a.note.text);
    if (a.collapsed) n.collapsed = true;
    const kids = Object.entries(idea.ideas || {}).sort((x, y) => Math.abs(+x[0]) - Math.abs(+y[0]));
    for (const [rank, k] of kids) {
      const c = conv(k, false);
      if (rootLevel) c.side = +rank < 0 ? 'l' : 'r';
      n.children.push(c);
    }
    return n;
  };
  return normalize(conv(first, true));
}

async function importText(name, text) {
  const lower = name.toLowerCase();
  const title = name.replace(/\.[^.]+$/, '') || 'Imported map';
  let root;
  if (lower.endsWith('.mm')) root = fromFreeMind(text);
  else if (lower.endsWith('.json') || lower.endsWith('.mup')) {
    const data = JSON.parse(text);
    if (data.formatVersion && data.ideas) root = fromMindMup(data);
    else if (data.root) root = normalize(data.root);
    else throw new Error('Unrecognised JSON format');
  } else root = parseOutline(text, title);
  const map = await api('POST', '/api/maps', { title: root.text || title, root });
  await openMap(map.id);
  toast('Imported ' + name);
}

function nodeSvgData() {
  // Build an SVG snapshot from the live DOM so exports look like the screen.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pos.values()) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h);
  }
  const pad = 40, W = x1 - x0 + pad * 2, H = y1 - y0 + pad * 2;
  const ctx = document.createElement('canvas').getContext('2d');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const bg = getComputedStyle(document.body).backgroundColor;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="${bg}"/><g transform="translate(${pad - x0} ${pad - y0})">`;
  svg += $('#edges').innerHTML;
  for (const el of $('#nodes').children) {
    const p = pos.get(el.dataset.id), cs = getComputedStyle(el);
    const t = el.querySelector('.text'), tcs = getComputedStyle(t);
    svg += `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="${parseFloat(cs.borderTopLeftRadius)}" ` +
      `fill="${cs.backgroundColor}" stroke="${cs.borderTopColor}" stroke-width="2"/>`;
    ctx.font = `${tcs.fontStyle} ${tcs.fontWeight} ${tcs.fontSize} ${tcs.fontFamily}`;
    const maxW = t.offsetWidth + 1;
    const lines = [];
    for (const para of (index.get(el.dataset.id).n.text || '').split('\n')) {
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        if (line && ctx.measureText(line + word).width > maxW && word.trim()) { lines.push(line.trimEnd()); line = word; }
        else line += word;
      }
      lines.push(line);
    }
    const lh = parseFloat(tcs.lineHeight) || parseFloat(tcs.fontSize) * 1.4;
    const tr = t.getBoundingClientRect(), er = el.getBoundingClientRect();
    const tx = p.x + (tr.left - er.left) / view.s;
    const ty = p.y + (tr.top - er.top) / view.s + (t.offsetHeight - lines.length * lh) / 2;
    lines.forEach((l, i) => {
      svg += `<text x="${tx}" y="${ty + lh * (i + 0.5)}" dominant-baseline="central" fill="${tcs.color}" ` +
        `font-family="${esc(tcs.fontFamily).replace(/"/g, "'")}" font-size="${tcs.fontSize}" font-weight="${tcs.fontWeight}" ` +
        `font-style="${tcs.fontStyle}">${esc(l)}</text>`;
    });
    const n = index.get(el.dataset.id).n;
    if (n.icon) svg += `<text x="${p.x + 6}" y="${p.y + p.h / 2}" dominant-baseline="central" font-size="16">${n.icon}</text>`;
  }
  svg += '</g></svg>';
  return { svg, W, H };
}

function exportPng() {
  const { svg, W, H } = nodeSvgData();
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = W * 2; c.height = H * 2;
    const ctx = c.getContext('2d');
    ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
    c.toBlob((b) => download(fileBase() + '.png', b), 'image/png');
  };
  img.onerror = () => toast('PNG export failed');
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

function exportMenu() {
  showPopover($('#btnExport'), (pop) => {
    const items = [
      ['Native JSON (.json)', () => download(fileBase() + '.json', JSON.stringify({ format: 'my-mind-map', version: 1, title: doc.title, root: doc.root }, null, 2), 'application/json')],
      ['MindMup (.mup)', () => download(fileBase() + '.mup', JSON.stringify(toMindMup(doc.root, doc.title), null, 2), 'application/json')],
      ['FreeMind (.mm)', () => download(fileBase() + '.mm', toFreeMind(doc.root), 'text/xml')],
      ['Markdown outline (.md)', () => download(fileBase() + '.md', toMarkdown(doc.root), 'text/markdown')],
      ['SVG image (.svg)', () => download(fileBase() + '.svg', nodeSvgData().svg, 'image/svg+xml')],
      ['PNG image (.png)', exportPng],
    ];
    for (const [label, fn] of items) {
      const b = document.createElement('button');
      b.className = 'menu-item'; b.textContent = label;
      b.onclick = () => { hidePopover(); fn(); };
      pop.append(b);
    }
  });
}

// ---------------------------------------------------------------- maps list
async function refreshMapList() {
  const maps = await api('GET', '/api/maps');
  const ul = $('#mapList');
  ul.textContent = '';
  for (const m of maps) {
    const li = document.createElement('li');
    if (doc && m.id === doc.id) li.classList.add('active');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.title;
    const small = document.createElement('small');
    small.textContent = `${m.node_count} nodes · ${new Date(m.updated_at + 'Z').toLocaleString()}`;
    name.append(small);
    const dup = document.createElement('button'); dup.textContent = '⧉'; dup.title = 'Duplicate';
    const del = document.createElement('button'); del.textContent = '🗑'; del.title = 'Delete';
    li.append(name, dup, del);
    li.onclick = () => { openMap(m.id); $('#drawer').hidden = true; };
    dup.onclick = async (e) => { e.stopPropagation(); const c = await api('POST', `/api/maps/${m.id}/duplicate`); await openMap(c.id); };
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${m.title}"? This cannot be undone.`)) return;
      await api('DELETE', `/api/maps/${m.id}`);
      if (doc && doc.id === m.id) await openFirstOrNew(); else refreshMapList();
    };
    ul.append(li);
  }
}

async function openMap(id) {
  if (doc && saveTimer) await flushSave();
  const m = await api('GET', `/api/maps/${id}`);
  doc = { id: m.id, title: m.title, root: normalize(m.root) };
  undoStack = []; redoStack = []; matches = new Set(); forceOpen = new Set();
  $('#search').value = '';
  $('#title').value = doc.title;
  document.title = doc.title + ' – My Mind Map';
  reindex();
  sel = new Set([doc.root.id]); primary = doc.root.id;
  build();
  fit();
  setStatus('Loaded');
  history.replaceState(null, '', '#' + doc.id);
  try { localStorage.setItem('lastMap', doc.id); } catch (e) { /* ignore */ }
  refreshMapList();
}

async function newMap() {
  const title = prompt('Name of the new map:', 'Untitled map');
  if (title === null) return;
  const m = await api('POST', '/api/maps', { title: title.trim() || 'Untitled map' });
  await openMap(m.id);
  $('#drawer').hidden = true;
  startEdit(doc.root.id);
}

async function openFirstOrNew() {
  const maps = await api('GET', '/api/maps');
  if (maps.length) return openMap(maps[0].id);
  const m = await api('POST', '/api/maps', { title: 'My first mind map' });
  return openMap(m.id);
}

// ---------------------------------------------------------------- pointer interactions
const viewportEl = $('#viewport');
viewportEl.tabIndex = 0;
viewportEl.style.outline = 'none';
let drag = null;

viewportEl.addEventListener('pointerdown', (e) => {
  hidePopover();
  if (e.button !== 0) return;
  const act = e.target.closest('[data-act]');
  const nodeNode = e.target.closest('.node');
  if (editing) {
    if (nodeNode && nodeNode.dataset.id === editing.id) return; // clicking inside the editor
    stopEdit(true);
  }
  if (act && act.dataset.act === 'link') return;
  if (act && act.dataset.act === 'fold') { toggleCollapse(nodeNode.dataset.id); e.preventDefault(); return; }
  if (act && act.dataset.act === 'note') { select(nodeNode.dataset.id); editNote(); return; }
  if (nodeNode) {
    const id = nodeNode.dataset.id;
    if (e.shiftKey || e.ctrlKey || e.metaKey) select(id, { toggle: true });
    else if (!sel.has(id) || sel.size === 1) select(id);
    else { primary = id; refreshSelection(); }
    drag = { kind: 'node', id, sx: e.clientX, sy: e.clientY, active: false, pointer: e.pointerId };
  } else {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    viewportEl.classList.add('panning');
  }
  viewportEl.setPointerCapture(e.pointerId);
  viewportEl.focus({ preventScroll: true });
});

function dropTarget(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
  if (!el) return null;
  const id = el.dataset.id;
  const r = el.getBoundingClientRect();
  const rel = (e.clientY - r.top) / r.height;
  const isRoot = id === doc.root.id;
  const mode = isRoot ? 'child' : rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'child';
  return { id, mode, el, side: e.clientX < r.left + r.width / 2 ? 'l' : 'r' };
}

viewportEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.kind === 'pan') {
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
    view.x = drag.vx + e.clientX - drag.sx; view.y = drag.vy + e.clientY - drag.sy;
    applyView();
    return;
  }
  if (!drag.active && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 6 && drag.id !== doc.root.id) {
    drag.active = true;
    selectedRoots().forEach((id) => nodeEl(id)?.classList.add('dragging'));
  }
  if (drag.active) {
    $('#nodes').querySelectorAll('.drop-child,.drop-before,.drop-after').forEach((el) =>
      el.classList.remove('drop-child', 'drop-before', 'drop-after'));
    const t = dropTarget(e);
    drag.target = t && !selectedRoots().some((id) => isInSubtree(id, t.id)) ? t : null;
    if (drag.target) drag.target.el.classList.add('drop-' + drag.target.mode);
  }
});

function isInSubtree(rootId, id) {
  for (let i = index.get(id); i; i = i.parent && index.get(i.parent.id)) if (i.n.id === rootId) return true;
  return false;
}

viewportEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  viewportEl.classList.remove('panning');
  if (d.kind === 'pan' && !d.moved) { sel = new Set([primary]); refreshSelection(); }
  if (d.kind === 'node') {
    if (d.active && d.target) moveNodes(selectedRoots(), d.target.id, d.target.mode, d.target.side);

    else build();
  }
});

viewportEl.addEventListener('dblclick', (e) => {
  const el = e.target.closest('.node');
  if (el && !e.target.closest('[data-act]')) startEdit(el.dataset.id);
  else if (!el) { /* double-click on background: fit */ fit(); }
});

viewportEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = viewportEl.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
  else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}, { passive: false });

// ---------------------------------------------------------------- clipboard
document.addEventListener('copy', (e) => clipboard(e, false));
document.addEventListener('cut', (e) => clipboard(e, true));
function clipboard(e, cut) {
  if (editing || e.target.closest('input,textarea')) return;
  const ids = selectedRoots();
  if (!ids.length) return;
  const nodes = ids.map((id) => clone(index.get(id).n));
  internalClip = { text: toOutline(nodes), nodes };
  e.clipboardData.setData('text/plain', internalClip.text);
  e.preventDefault();
  if (cut) deleteSelected();
  toast(cut ? 'Cut' : 'Copied');
}

document.addEventListener('paste', (e) => {
  if (editing || e.target.closest('input,textarea')) return;
  const text = e.clipboardData.getData('text/plain');
  let nodes;
  if (internalClip && text === internalClip.text) nodes = clone(internalClip.nodes).map(freshIds);
  else if (text.trim()) {
    const parsed = parseOutline(text, '');
    nodes = parsed.text === '' ? parsed.children : [parsed];
  }
  if (!nodes || !nodes.length) return;
  e.preventDefault();
  const parent = index.get(primary).n;
  mutate(() => {
    parent.collapsed = false; delete parent.collapsed;
    nodes.forEach((n) => { if (parent === doc.root) n.side = pickSide(); else delete n.side; parent.children.push(n); });
    sel = new Set(nodes.map((n) => n.id)); primary = nodes[0].id;
  });
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (editing) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const id = editing.id; stopEdit(true); addSibling(id); }
    else if (e.key === 'Tab') { e.preventDefault(); const id = editing.id; stopEdit(true); addChild(id); }
    else if (e.key === 'Escape') { e.preventDefault(); stopEdit(false); }
    return;
  }
  const tag = e.target.tagName;
  if (e.target.id === 'search') {
    if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { $('#search').value = ''; runSearch(); $('#viewport').focus(); }
    return;
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA' || $('dialog[open]')) return;
  if (!doc) return;

  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); setProp('bold', !index.get(primary).n.bold); return; }
  if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); setProp('italic', !index.get(primary).n.italic); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); editLink(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); editNote(); return; }
  if (mod && e.key === '0') { e.preventDefault(); fit(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBtn(1.2); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomBtn(1 / 1.2); return; }
  if (mod && e.key === 'ArrowUp') { e.preventDefault(); moveSibling(-1); return; }
  if (mod && e.key === 'ArrowDown') { e.preventDefault(); moveSibling(1); return; }
  if (mod) return;

  switch (e.key) {
    case 'Tab': case 'Insert': e.preventDefault(); addChild(); break;
    case 'Enter': e.preventDefault(); addSibling(); break;
    case 'F2': e.preventDefault(); startEdit(primary); break;
    case ' ': e.preventDefault(); toggleCollapse(primary); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelected(); break;
    case 'Escape': sel = new Set([primary]); refreshSelection(); hidePopover(); break;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      e.preventDefault(); navigate(e.key); break;
    default:
      // typing a printable character starts editing, replacing the text (like MindMup)
      if (e.key.length === 1 && !e.altKey) { startEdit(primary); }
  }
});

// ---------------------------------------------------------------- toolbar wiring
function zoomBtn(f) { const { w, h } = viewportSize(); zoomAt(f, w / 2, h / 2); }

$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnChild').onclick = () => addChild();
$('#btnSibling').onclick = () => addSibling();
$('#btnDelete').onclick = deleteSelected;
$('#btnNote').onclick = editNote;
$('#btnLink').onclick = editLink;
$('#btnBold').onclick = () => setProp('bold', !index.get(primary).n.bold);
$('#btnItalic').onclick = () => setProp('italic', !index.get(primary).n.italic);
$('#btnCollapseAll').onclick = () => setAllCollapsed(true);
$('#btnExpandAll').onclick = () => setAllCollapsed(false);
$('#btnZoomIn').onclick = () => zoomBtn(1.2);
$('#btnZoomOut').onclick = () => zoomBtn(1 / 1.2);
$('#btnFit').onclick = fit;
$('#btnExport').onclick = exportMenu;
$('#btnImport').onclick = () => $('#fileInput').click();
$('#btnHelp').onclick = () => $('#helpDialog').showModal();
$('#btnMaps').onclick = () => { $('#drawer').hidden = !$('#drawer').hidden; if (!$('#drawer').hidden) refreshMapList(); };
$('#btnNewMap').onclick = newMap;
$('#btnColor').onclick = (e) => showPopover(e.currentTarget, (pop) =>
  swatchGrid(pop, FILL_COLORS, (b, c) => { b.style.background = c; }, (c) => setProp('color', c)));
$('#btnIcon').onclick = (e) => showPopover(e.currentTarget, (pop) =>
  swatchGrid(pop, ICONS, (b, i) => { b.textContent = i; }, (i) => setProp('icon', i)));
$('#btnTheme').onclick = () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) { /* ignore */ }
};
$('#search').addEventListener('input', runSearch);
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { await importText(f.name, await f.text()); } catch (err) { toast('Import failed: ' + err.message); }
});
$('#title').addEventListener('input', (e) => {
  if (!doc) return;
  doc.title = e.target.value;
  document.title = doc.title + ' – My Mind Map';
  scheduleSave();
});
$('#title').addEventListener('change', () => { if (doc && !doc.title.trim()) { doc.title = 'Untitled map'; $('#title').value = doc.title; scheduleSave(); } refreshMapList(); });
$('#title').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#viewport').focus(); });

// allow dropping import files onto the page
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  try { await importText(f.name, await f.text()); } catch (err) { toast('Import failed: ' + err.message); }
});

window.addEventListener('resize', () => { document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px'); });

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const saved = localStorage.getItem('theme');
    document.documentElement.dataset.theme = saved || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch (e) { /* ignore */ }
  document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px');
  try {
    const wanted = location.hash.slice(1) || localStorage.getItem('lastMap');
    if (wanted) { try { await openMap(wanted); return; } catch (e) { /* fall through */ } }
    await openFirstOrNew();
  } catch (e) {
    setStatus('Server error'); toast('Could not load maps: ' + e.message);
  }
})();
