// ═══════════════════════════════════════════════════════════════════════
// P6logic-app  —  client-side application
// ═══════════════════════════════════════════════════════════════════════

// ── category colour palette ─────────────────────────────────────────────
const CAT_PALETTE = [
  '#e94560','#3498db','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a',
  '#ff5722','#607d8b','#cddc39','#ff9800','#673ab7',
];

// ── build lookup maps from payload ──────────────────────────────────────
const taskById   = {};   // id -> task object
const taskByCode = {};   // code -> task object
PAYLOAD.tasks.forEach(t => { taskById[t.id] = t; taskByCode[t.code] = t; });

// ── precompute per-edge link float (calendar-day approximation) ────────────
// Link float = date gap between predecessor early_end and successor early_start
// (adjusted for relationship type and lag). Zero means this tie is driving.
// Values reflect calendar days, not working days — driving ties on adjacent
// working days will show ~1–3d due to overnight/weekend gaps.
function _dateDays(iso) {
  if (!iso) return null;
  return Date.parse(iso) / 86400000;
}

const edgeLinkFloat = {};  // "srcId|tgtId" -> calendar-day link float (integer) or null
PAYLOAD.edges.forEach(e => {
  const src = taskById[e.src_id], tgt = taskById[e.tgt_id];
  if (!src || !tgt) { edgeLinkFloat[`${e.src_id}|${e.tgt_id}`] = null; return; }
  const lag = e.lag_days || 0;
  const pt  = (e.pred_type || 'PR_FS').toUpperCase();
  let lf = null;
  if (pt.includes('SS')) {
    const s1 = _dateDays(src.early_start), s2 = _dateDays(tgt.early_start);
    if (s1 != null && s2 != null) lf = s2 - s1 - lag;
  } else if (pt.includes('FF')) {
    const f1 = _dateDays(src.early_end), f2 = _dateDays(tgt.early_end);
    if (f1 != null && f2 != null) lf = f2 - f1 - lag;
  } else if (pt.includes('SF')) {
    const s1 = _dateDays(src.early_start), f2 = _dateDays(tgt.early_end);
    if (s1 != null && f2 != null) lf = f2 - s1 - lag;
  } else {  // FS (default)
    const f1 = _dateDays(src.early_end), s2 = _dateDays(tgt.early_start);
    if (f1 != null && s2 != null) lf = s2 - f1 - lag;
  }
  edgeLinkFloat[`${e.src_id}|${e.tgt_id}`] = lf != null ? Math.round(lf) : null;
});
const maxLinkFloat = Math.max(0, ...Object.values(edgeLinkFloat).filter(v => v != null));

// Min link float along all hops of a key-activity connection path.
// A connection may pass through intermediate activities; the tightest hop
// determines whether this chain can allow the target to pull left.
function connLinkFloat(conn) {
  const path = [conn.src, ...(conn.intermediate || []), conn.tgt];
  let min = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const lf = edgeLinkFloat[`${path[i]}|${path[i + 1]}`];
    if (lf == null) return null;   // any missing hop → unknown
    if (lf < min) min = lf;
  }
  return min === Infinity ? null : min;
}

// Assign category colours (seeded from PAYLOAD; extended by user import/editor)
const catColorMap = {};
PAYLOAD.categories.forEach((cat, i) => {
  catColorMap[cat] = CAT_PALETTE[i % CAT_PALETTE.length];
});

// User-assigned categories (from import column C or editor); overrides XER category
let categoryOverrideMap = {};   // task id -> category string

function ensureCatColor(cat) {
  if (!cat || catColorMap[cat]) return;
  catColorMap[cat] = CAT_PALETTE[Object.keys(catColorMap).length % CAT_PALETTE.length];
}

function nodeColor(task) {
  const cat = categoryOverrideMap[task.id] || task.category;
  if (cat && catColorMap[cat]) return catColorMap[cat];
  return '#4a7fa5';
}

// ── build edge lookup for Cytoscape ─────────────────────────────────────
// adjacency: id -> Set of successor ids (fast neighbour lookup)
const succMap = {};   // id -> [tgt_id, ...]
const predMap = {};   // id -> [src_id, ...]
PAYLOAD.edges.forEach(e => {
  (succMap[e.src_id] = succMap[e.src_id] || []).push(e.tgt_id);
  (predMap[e.tgt_id] = predMap[e.tgt_id] || []).push(e.src_id);
});

// ── key activities set (drives logic diagram) ────────────────────────────
let keySet = new Set();   // set of task ids

// ── shorthand names (from second column of imported spreadsheet) ──────────
let shorthandMap = {};    // task id -> shorthand string
let labelMode = 'short';  // 'id' | 'short' | 'name'

function getLabelForTask(task) {
  if (labelMode === 'name')  return task.name;
  if (labelMode === 'short') return shorthandMap[task.id] || task.code;
  return task.code;   // 'id' (default)
}

// ════════════════════════════════════════════════════════════════════════
// 1.  CYTOSCAPE NETWORK EXPLORER
// ════════════════════════════════════════════════════════════════════════

const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: [],   // populated dynamically by focusExplorer()
  style: [
    {
      selector: 'node',
      style: {
        'background-color': ele => nodeColor(ele.data('task')),
        'label': 'data(label)',
        'color': '#222',
        'font-size': '9px',
        'width': 28,
        'height': 28,
        'text-valign': 'center',
        'text-halign': 'center',
        'border-width': 0,
        'min-zoomed-font-size': 6,
        'text-outline-width': 2,
        'text-outline-color': '#fff',
      }
    },
    // The focused activity — bold ring
    {
      selector: 'node.explorer-focus',
      style: {
        'background-color': '#e94560',
        'border-width': 0,
        'color': '#fff',
        'text-outline-color': '#c0293f',
        'width': 34,
        'height': 34,
      }
    },
    // Activities that are key activities — subtle ring
    {
      selector: 'node.selected-key',
      style: {
        'border-width': 2,
        'border-color': '#e94560',
        'border-opacity': 0.5,
      }
    },
    {
      selector: 'node.faded',
      style: { 'opacity': 0.2 }
    },
    {
      selector: 'edge',
      style: {
        'width': 1.5,
        'line-color': '#aaaaaa',
        'target-arrow-color': '#aaaaaa',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'opacity': 0.8,
        'arrow-scale': 0.8,
      }
    },
    {
      selector: 'edge.pred-edge',
      style: { 'line-color': '#9b59b6', 'target-arrow-color': '#9b59b6', 'width': 2 }
    },
    {
      selector: 'edge.succ-edge',
      style: { 'line-color': '#3498db', 'target-arrow-color': '#3498db', 'width': 2 }
    },
    {
      selector: 'node.pred-node',
      style: { 'color': '#9b59b6' }
    },
    {
      selector: 'node.succ-node',
      style: { 'color': '#3498db' }
    },
  ],
  layout: { name: 'preset' },
  wheelSensitivity: 0.3,
  minZoom: 0.05,
  maxZoom: 8,
});

// ── focus explorer on a given activity ──────────────────────────────────
let explorerFocusId = null;
const explorerEmpty = document.getElementById('explorer-empty');

function clearExplorer() {
  explorerFocusId = null;
  cy.elements().remove();
  explorerEmpty.style.display = '';
  document.getElementById('selected-count').textContent =
    keySet.size + ' key activit' + (keySet.size === 1 ? 'y' : 'ies') + ' selected';
}

const EXPLORER_MAX_EACH = 100;   // max nodes per direction (pred / succ)

// BFS outward from startId following neighborFn, assigning tier numbers.
// sign = -1 for predecessors (tiers go negative), +1 for successors.
// Returns { id: tier } for all discovered nodes (excluding startId).
function _explorerBFS(startId, neighborFn, sign) {
  const tiers = {};
  const visited = new Set([startId]);
  let frontier = [startId];
  let tier = 0;
  while (frontier.length && Object.keys(tiers).length < EXPLORER_MAX_EACH) {
    tier += sign;
    const next = [];
    for (const id of frontier) {
      for (const nbr of (neighborFn(id) || [])) {
        if (!visited.has(nbr) && Object.keys(tiers).length < EXPLORER_MAX_EACH) {
          visited.add(nbr);
          tiers[nbr] = tier;
          next.push(nbr);
        }
      }
    }
    frontier = next;
  }
  return tiers;
}

function focusExplorer(taskId) {
  const task = taskById[taskId];
  if (!task) return;
  explorerFocusId = taskId;
  explorerEmpty.style.display = 'none';

  // Full transitive BFS in both directions
  const predTiers = _explorerBFS(taskId, id => predMap[id], -1);
  const succTiers = _explorerBFS(taskId, id => succMap[id], +1);

  const tierOf = { [taskId]: 0, ...predTiers, ...succTiers };
  const allIds  = new Set(Object.keys(tierOf));

  const capped = Object.keys(predTiers).length >= EXPLORER_MAX_EACH ||
                 Object.keys(succTiers).length >= EXPLORER_MAX_EACH;

  // Edges between visible nodes, excluding bypass edges that jump from the
  // predecessor region (tier < 0) directly to the successor region (tier > 0)
  // without passing through the focus node (tier 0).
  const visEdges = PAYLOAD.edges.filter(e => {
    if (!allIds.has(e.src_id) || !allIds.has(e.tgt_id)) return false;
    const srcTier = tierOf[e.src_id] ?? 0;
    const tgtTier = tierOf[e.tgt_id] ?? 0;
    return !(srcTier < 0 && tgtTier > 0);
  });

  // Rebuild graph
  cy.elements().remove();

  const nodes = [...allIds].map(id => {
    const t = taskById[id];
    return t ? { data: { id, label: getLabelForTask(t), task: t } } : null;
  }).filter(Boolean);

  cy.add([
    ...nodes,
    ...visEdges.map((e, i) => ({ data: { id: 'ce' + i, source: e.src_id, target: e.tgt_id } })),
  ]);

  // Tier-based preset layout: tier × COL_W on x-axis, spread within tier on y-axis
  const COL_W = 180, ROW_H = 52;
  const tierGroups = {};
  [...allIds].forEach(id => {
    const t = tierOf[id];
    (tierGroups[t] = tierGroups[t] || []).push(id);
  });
  Object.values(tierGroups).forEach(g =>
    g.sort((a, b) => (taskById[a]?.code || '').localeCompare(taskById[b]?.code || ''))
  );

  cy.layout({
    name: 'preset',
    positions: node => {
      const id   = node.id();
      const tier = tierOf[id] ?? 0;
      const grp  = tierGroups[tier];
      const idx  = grp.indexOf(id);
      return { x: tier * COL_W, y: (idx - (grp.length - 1) / 2) * ROW_H };
    },
  }).run();

  // Style nodes
  cy.getElementById(taskId).addClass('explorer-focus');
  Object.keys(predTiers).forEach(id => cy.getElementById(id).addClass('pred-node'));
  Object.keys(succTiers).forEach(id => cy.getElementById(id).addClass('succ-node'));

  // Style edges: source tier < 0 → pred chain (purple); source tier ≥ 0 → succ chain (blue)
  cy.edges().forEach(e => {
    const srcTier = tierOf[e.source().id()] ?? 0;
    e.addClass(srcTier < 0 ? 'pred-edge' : 'succ-edge');
  });

  // Mark current key activities
  cy.nodes().forEach(n => { if (keySet.has(n.id())) n.addClass('selected-key'); });

  // Show cap warning in footer
  document.getElementById('selected-count').textContent =
    (capped ? `⚠ capped at ${EXPLORER_MAX_EACH}/direction — ` : '') +
    keySet.size + ' key activit' + (keySet.size === 1 ? 'y' : 'ies') + ' selected';

  cy.fit(cy.elements(), 40);
}

// ── node click in explorer: navigate to that node ───────────────────────
cy.on('tap', 'node', evt => {
  focusExplorer(evt.target.id());
});

// ── node hover: tooltip ──────────────────────────────────────────────────
const tooltip = document.getElementById('cy-tooltip');

cy.on('mouseover', 'node', evt => {
  const node = evt.target;
  const task = node.data('task');
  const pos  = evt.renderedPosition;
  const rect = document.getElementById('cy').getBoundingClientRect();
  const tfStr2 = task.float_days != null ? `TF: ${Math.round(task.float_days)}d` : '';
  const ffStr2 = task.free_float_days != null ? `FF: ${Math.round(task.free_float_days)}d` : '';
  const floatStr = [tfStr2, ffStr2].filter(Boolean).join('  ');
  tooltip.innerHTML = `
    <div class="tip-code">${task.code}</div>
    <div class="tip-name">${task.name}</div>
    <div class="tip-meta">${floatStr}${task.category ? ' &nbsp;·&nbsp; ' + task.category : ''}</div>
  `;
  tooltip.style.display = 'block';
  tooltip.style.left = (rect.left + pos.x + 14) + 'px';
  tooltip.style.top  = (rect.top  + pos.y - 10) + 'px';
});

cy.on('mouseout', 'node', () => { tooltip.style.display = 'none'; });

// ── search box: find-and-focus ────────────────────────────────────────────
const searchBox      = document.getElementById('search-box');
const explorerResults = document.getElementById('explorer-results');

searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim().toLowerCase();
  explorerResults.innerHTML = '';
  if (!q) { explorerResults.style.display = 'none'; return; }

  const matches = PAYLOAD.tasks
    .filter(t => t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    .slice(0, 15);

  if (!matches.length) { explorerResults.style.display = 'none'; return; }

  matches.forEach(task => {
    const div = document.createElement('div');
    div.className = 'expl-result';
    div.innerHTML = `<span class="expl-result-code">${task.code}</span><span class="expl-result-name">${task.name}</span>`;
    div.addEventListener('mousedown', e => {
      e.preventDefault();
      searchBox.value = task.code;
      explorerResults.style.display = 'none';
      focusExplorer(task.id);
    });
    explorerResults.appendChild(div);
  });
  explorerResults.style.display = 'block';
});

searchBox.addEventListener('blur', () => {
  setTimeout(() => { explorerResults.style.display = 'none'; }, 150);
});

// ── footer buttons ────────────────────────────────────────────────────────
document.getElementById('clear-sel-btn').addEventListener('click', () => {
  keySet.clear();
  shorthandMap = {};
  categoryOverrideMap = {};
  clearExplorer();
  rebuildDiagram();
  kaRenderTable();
});

document.getElementById('add-all-btn').addEventListener('click', () => {
  cy.nodes().forEach(n => {
    keySet.add(n.id());
    n.addClass('selected-key');
  });
  updateSelectedCount();
  rebuildDiagram();
  kaRenderTable();
});

function updateSelectedCount() {
  // If explorer is showing a focused graph, let focusExplorer manage the footer text
  if (explorerFocusId) return;
  document.getElementById('selected-count').textContent =
    keySet.size + ' key activit' + (keySet.size === 1 ? 'y' : 'ies') + ' selected';
}

// ── category legend ────────────────────────────────────────────────────────
function buildCategoryLegend() {
  const legend = document.getElementById('cat-legend');
  const cats = Object.keys(catColorMap);
  if (!cats.length) { legend.style.display = 'none'; return; }
  legend.style.display = 'block';
  legend.innerHTML = cats.map(cat =>
    `<div class="leg-item">
      <div class="leg-swatch" style="background:${catColorMap[cat]}"></div>
      <span>${cat}</span>
    </div>`
  ).join('');
}
buildCategoryLegend();

// ── label mode toggle ─────────────────────────────────────────────────────
const _LABEL_MODES = ['id', 'short', 'name'];
const _LABEL_MODE_TEXT = { id: 'Labels: ID', short: 'Labels: Short', name: 'Labels: Name' };

function updateCyLabels() {
  cy.nodes().forEach(n => n.data('label', getLabelForTask(n.data('task'))));
  // Re-focus to refresh labels if explorer is showing something
  if (explorerFocusId) focusExplorer(explorerFocusId);
}

document.getElementById('label-mode-btn').addEventListener('click', function() {
  const idx = _LABEL_MODES.indexOf(labelMode);
  labelMode = _LABEL_MODES[(idx + 1) % _LABEL_MODES.length];
  this.textContent = _LABEL_MODE_TEXT[labelMode];
  this.classList.toggle('active', labelMode !== 'id');
  updateCyLabels();
  rebuildDiagram();
});

// ── import key activities ──────────────────────────────────────────────────
const importBtn    = document.getElementById('import-btn');
const importFile   = document.getElementById('import-file');
const importStatus = document.getElementById('import-status');

const importLog        = document.getElementById('import-log');
const importLogMsg     = document.getElementById('import-log-msg');
const importLogDismiss = document.getElementById('import-log-dismiss');
importLogDismiss.addEventListener('click', () => importLog.classList.remove('visible'));

function showImportLog(missing) {
  if (!missing.length) { importLog.classList.remove('visible'); return; }
  const MAX_SHOWN = 12;
  const shown = missing.slice(0, MAX_SHOWN).join(', ');
  const extra = missing.length > MAX_SHOWN ? ` … and ${missing.length - MAX_SHOWN} more` : '';
  importLogMsg.textContent = `⚠ ${missing.length} code${missing.length > 1 ? 's' : ''} not found in schedule: ${shown}${extra}`;
  importLog.classList.add('visible');
}

// Header labels to skip (same as P6logic Python side)
const _HEADER_LABELS = new Set([
  'activity id','activity_id','task_code','id','code','activity','activity code'
]);

importBtn.addEventListener('click', () => importFile.click());

importFile.addEventListener('change', () => {
  const file = importFile.files[0];
  if (!file) return;
  importStatus.textContent = 'Reading…';

  const reader = new FileReader();
  const ext = file.name.split('.').pop().toLowerCase();

  reader.onload = evt => {
    try {
      let rows = [];
      if (ext === 'csv' || ext === 'txt') {
        const text = evt.target.result;
        text.split(/\r?\n/).forEach(line => {
          if (!line.trim()) return;
          const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, '').trim());
          if (parts[0]) rows.push(parts);
        });
      } else {
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        rows = raw.map(r => [String(r[0] || '').trim(), String(r[1] || '').trim(), String(r[2] || '').trim()]);
      }
      importFile.value = '';
      const { matched, missing } = applyImportRows(rows);
      importStatus.textContent = missing.length === 0
        ? `✓ ${matched} imported`
        : `✓ ${matched} imported, ${missing.length} not found`;
      showImportLog(missing);
    } catch (err) {
      importStatus.textContent = '✗ Error reading file';
      console.error('Import error:', err);
    }
  };

  if (ext === 'csv' || ext === 'txt') {
    reader.readAsText(file, 'utf-8');
  } else {
    reader.readAsArrayBuffer(file);
  }
});

// ── panel resize ───────────────────────────────────────────────────────────
(function initResize() {
  const handle  = document.getElementById('resize-handle');
  const expPanel = document.getElementById('explorer-panel');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = expPanel.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(600, startW + (e.clientX - startX)));
    expPanel.style.width = w + 'px';
    cy.resize(); cy.fit(cy.elements(), 30);
    Plotly.relayout('plotly-div', { autosize: true });
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();


// ════════════════════════════════════════════════════════════════════════
// 2.  SHARED IMPORT LOGIC
// ════════════════════════════════════════════════════════════════════════

// Applies a parsed rows array [[code, shorthand], ...] to keySet + shorthandMap.
// Drops a header row if the first cell matches a known label.
// Returns { matched, missing }.
function applyImportRows(rows) {
  if (rows.length && _HEADER_LABELS.has(String(rows[0][0]).toLowerCase())) {
    rows = rows.slice(1);
  }
  let matched = 0;
  const missing = [];
  keySet.clear();
  shorthandMap = {};
  categoryOverrideMap = {};
  cy.nodes().removeClass('selected-key');

  rows.forEach(([code, shorthand, category]) => {
    if (!code) return;
    const task = taskByCode[code];
    if (task) {
      keySet.add(task.id);
      if (shorthand)  shorthandMap[task.id] = shorthand;
      if (category) {
        categoryOverrideMap[task.id] = category;
        ensureCatColor(category);
      }
      cy.getElementById(task.id).addClass('selected-key');
      matched++;
    } else {
      missing.push(code);
    }
  });

  buildCategoryLegend();
  updateCyLabels();
  updateSelectedCount();
  rebuildDiagram();
  kaRenderTable();
  return { matched, missing };
}


// ════════════════════════════════════════════════════════════════════════
// 3.  KEY ACTIVITIES EDITOR MODAL
// ════════════════════════════════════════════════════════════════════════

const kaOverlay  = document.getElementById('ka-overlay');
const kaRowCount = document.getElementById('ka-row-count');

function kaOpen() {
  kaRenderTable();
  kaInitColResize();
  document.getElementById('ka-search-input').value = '';
  document.getElementById('ka-search-results').style.display = 'none';
  kaOverlay.style.display = 'flex';
}

function kaClose() {
  kaOverlay.style.display = 'none';
}

function kaRenderTable() {
  const tbody = document.getElementById('ka-tbody');
  tbody.innerHTML = '';

  // Refresh category autocomplete list
  const dl = document.getElementById('ka-cat-datalist');
  dl.innerHTML = Object.keys(catColorMap)
    .map(c => `<option value="${c}"></option>`).join('');

  const sorted = [...keySet]
    .map(id => taskById[id]).filter(Boolean)
    .sort((a, b) => (a.early_start || '').localeCompare(b.early_start || '') || a.code.localeCompare(b.code));

  sorted.forEach(task => {
    const tr = document.createElement('tr');
    tr.dataset.id = task.id;

    const codeTd   = document.createElement('td');
    codeTd.className = 'ka-code-cell';
    codeTd.textContent = task.code;

    const shortTd  = document.createElement('td');
    const shortIn  = document.createElement('input');
    shortIn.type = 'text';
    shortIn.className = 'ka-short-input';
    shortIn.value = shorthandMap[task.id] || '';
    shortIn.placeholder = '—';
    shortIn.addEventListener('change', () => {
      const v = shortIn.value.trim();
      if (v) shorthandMap[task.id] = v; else delete shorthandMap[task.id];
      updateCyLabels();
      rebuildDiagram();
    });
    shortTd.appendChild(shortIn);

    const catTd  = document.createElement('td');
    const catIn  = document.createElement('input');
    catIn.type = 'text';
    catIn.className = 'ka-short-input';
    catIn.value = categoryOverrideMap[task.id] || task.category || '';
    catIn.placeholder = '—';
    catIn.setAttribute('list', 'ka-cat-datalist');
    catIn.addEventListener('change', () => {
      const v = catIn.value.trim();
      if (v) {
        categoryOverrideMap[task.id] = v;
        ensureCatColor(v);
        buildCategoryLegend();
      } else {
        delete categoryOverrideMap[task.id];
      }
      rebuildDiagram();
      if (explorerFocusId) focusExplorer(explorerFocusId);
    });
    catTd.appendChild(catIn);

    const nameTd   = document.createElement('td');
    nameTd.className = 'ka-name-cell';
    nameTd.textContent = task.name;
    nameTd.title = task.name;

    const floatTd  = document.createElement('td');
    floatTd.className = 'ka-float-cell';
    floatTd.textContent = task.float_days != null ? Math.round(task.float_days) : '—';

    const rmTd     = document.createElement('td');
    const rmBtn    = document.createElement('button');
    rmBtn.className = 'ka-remove-btn';
    rmBtn.textContent = '✕';
    rmBtn.title = 'Remove';
    rmBtn.addEventListener('click', () => {
      keySet.delete(task.id);
      delete shorthandMap[task.id];
      delete categoryOverrideMap[task.id];
      cy.getElementById(task.id).removeClass('selected-key');
      updateCyLabels();
      updateSelectedCount();
      rebuildDiagram();
      kaRenderTable();
    });
    rmTd.appendChild(rmBtn);

    tr.append(codeTd, shortTd, catTd, nameTd, floatTd, rmTd);
    tbody.appendChild(tr);
  });

  kaRowCount.textContent = sorted.length + ' activit' + (sorted.length === 1 ? 'y' : 'ies');
}

// ── search to add ─────────────────────────────────────────────────────────
const kaSearchInput   = document.getElementById('ka-search-input');
const kaSearchResults = document.getElementById('ka-search-results');

kaSearchInput.addEventListener('input', () => {
  const q = kaSearchInput.value.trim().toLowerCase();
  kaSearchResults.innerHTML = '';
  if (!q) { kaSearchResults.style.display = 'none'; return; }

  const matches = PAYLOAD.tasks
    .filter(t => !keySet.has(t.id) &&
      (t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)))
    .slice(0, 12);

  if (!matches.length) { kaSearchResults.style.display = 'none'; return; }

  matches.forEach(task => {
    const div = document.createElement('div');
    div.className = 'ka-result-item';
    div.innerHTML = `<span class="ka-result-code">${task.code}</span><span class="ka-result-name">${task.name}</span>`;
    div.addEventListener('mousedown', e => {
      e.preventDefault();   // keep focus on input
      keySet.add(task.id);
      cy.getElementById(task.id).addClass('selected-key');
      updateCyLabels();
      updateSelectedCount();
      rebuildDiagram();
      kaRenderTable();
      kaSearchInput.value = '';
      kaSearchResults.style.display = 'none';
    });
    kaSearchResults.appendChild(div);
  });
  kaSearchResults.style.display = 'block';
});

kaSearchInput.addEventListener('blur', () => {
  setTimeout(() => { kaSearchResults.style.display = 'none'; }, 150);
});

// ── modal import ──────────────────────────────────────────────────────────
const kaImportModalFile = document.getElementById('ka-import-modal-file');

document.getElementById('ka-import-modal-btn').addEventListener('click', () => kaImportModalFile.click());

kaImportModalFile.addEventListener('change', () => {
  const file = kaImportModalFile.files[0];
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  const reader = new FileReader();
  reader.onload = evt => {
    try {
      let rows = [];
      if (ext === 'csv' || ext === 'txt') {
        evt.target.result.split(/\r?\n/).forEach(line => {
          if (!line.trim()) return;
          const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, '').trim());
          if (parts[0]) rows.push(parts);
        });
      } else {
        const wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
          .map(r => [String(r[0] || '').trim(), String(r[1] || '').trim(), String(r[2] || '').trim()]);
      }
      kaImportModalFile.value = '';
      const { matched, missing } = applyImportRows(rows);
      importStatus.textContent = missing.length === 0
        ? `✓ ${matched} imported`
        : `✓ ${matched} imported, ${missing.length} not found`;
      showImportLog(missing);
    } catch (err) {
      console.error('Modal import error:', err);
    }
  };
  if (ext === 'csv' || ext === 'txt') reader.readAsText(file, 'utf-8');
  else reader.readAsArrayBuffer(file);
});

// ── modal export (reuses existing export logic) ───────────────────────────
document.getElementById('ka-export-modal-btn').addEventListener('click', () => {
  document.getElementById('export-btn').click();
});

// ── column resize ─────────────────────────────────────────────────────────
let _kaColResizeInit = false;

function kaInitColResize() {
  if (_kaColResizeInit) return;
  _kaColResizeInit = true;

  document.querySelectorAll('#ka-table thead th').forEach((th, i, all) => {
    if (i === all.length - 1) return;   // skip the remove-button column
    const handle = document.createElement('div');
    handle.className = 'ka-col-resize';
    th.appendChild(handle);

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = th.offsetWidth;
      handle.classList.add('dragging');

      function onMove(e) {
        th.style.width    = Math.max(40, startW + (e.clientX - startX)) + 'px';
        th.style.minWidth = th.style.width;
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ── open / close wiring ───────────────────────────────────────────────────
document.getElementById('ka-open-btn').addEventListener('click', kaOpen);
document.getElementById('ka-close-btn').addEventListener('click', kaClose);
document.getElementById('ka-done-btn').addEventListener('click', kaClose);

// Close on overlay click (outside the modal box)
kaOverlay.addEventListener('click', e => { if (e.target === kaOverlay) kaClose(); });

// Close on Escape
document.addEventListener('keydown', e => { if (e.key === 'Escape') kaClose(); });


// ════════════════════════════════════════════════════════════════════════
// 4.  LOGIC DIAGRAM (Plotly)
// ════════════════════════════════════════════════════════════════════════

// ── global state ────────────────────────────────────────────────────────
let currentFloatFilter = Infinity;   // max float days to show (slider value)
let floatLabelMode = 'total';        // 'total' | 'link' | 'none'
let lineWeightMode = 'float';        // 'uniform' | 'float' | 'link_float' | 'downstream'

// ── controls wiring ─────────────────────────────────────────────────────
const floatSlider = document.getElementById('float-slider');
const floatInput  = document.getElementById('float-input');

// Compute slider max from data
const maxFloat = Math.ceil(
  Math.max(0, ...PAYLOAD.tasks.map(t => t.float_days || 0))
);
const sliderMax = Math.ceil(maxFloat / 5) * 5 || 100;
floatSlider.max = sliderMax;
floatSlider.value = sliderMax;
floatInput.max = sliderMax * 2;
floatInput.value = sliderMax;
currentFloatFilter = sliderMax;

function applyFilterValue(v) {
  v = Math.max(0, Math.round(v));
  floatSlider.value = Math.min(v, sliderMax);
  floatInput.value = v;
  currentFloatFilter = v >= sliderMax ? Infinity : v;
  rebuildDiagram();
}

floatSlider.addEventListener('input', () => applyFilterValue(+floatSlider.value));
floatInput.addEventListener('change', () => applyFilterValue(+floatInput.value));

document.getElementById('float-labels-btn').addEventListener('click', function() {
  floatLabelMode = floatLabelMode === 'total' ? 'link' : floatLabelMode === 'link' ? 'none' : 'total';
  this.textContent = floatLabelMode === 'total' ? 'Float: Total' : floatLabelMode === 'link' ? 'Float: Link' : 'Float: Off';
  this.classList.toggle('active', floatLabelMode !== 'none');
  rebuildDiagram();
});

document.getElementById('lw-select').addEventListener('change', function() {
  lineWeightMode = this.value;
  rebuildDiagram();
});

document.getElementById('show-inter-btn').addEventListener('click', function() {
  // Placeholder for show-intermediate toggle (future)
  this.classList.toggle('active');
});

// ── chain analysis export ─────────────────────────────────────────────────
document.getElementById('chain-analysis-btn').addEventListener('click', () => {
  const allKeyIds = [...keySet];
  if (allKeyIds.length === 0) { alert('No key activities selected.'); return; }

  // Build connections across ALL key activities (ignore float filter)
  const allConns = findConnections(allKeyIds);

  // Adjacency lists (forward and backward)
  const fwd = {}, bwd = {};
  allKeyIds.forEach(id => { fwd[id] = []; bwd[id] = []; });
  allConns.forEach(({ src, tgt }) => { fwd[src].push(tgt); bwd[tgt].push(src); });

  // Transitive reachability via BFS
  function reachable(startId, adj) {
    const visited = new Set();
    const q = [startId];
    while (q.length) {
      const id = q.shift();
      (adj[id] || []).forEach(nb => { if (!visited.has(nb)) { visited.add(nb); q.push(nb); } });
    }
    visited.delete(startId);
    return [...visited];
  }

  // Sort helper: by float asc, then code asc
  const byFloat = (a, b) => {
    const fa = taskById[a]?.float_days ?? 999999, fb = taskById[b]?.float_days ?? 999999;
    return fa !== fb ? fa - fb : (taskById[a]?.code || '').localeCompare(taskById[b]?.code || '');
  };

  // Format one id as "CODE – Short Name"
  function fmtEntry(id) {
    const t = taskById[id];
    const code = t?.code || id;
    const short = shorthandMap[id] || t?.name || '';
    return short ? `${code} \u2013 ${short}` : code;
  }

  // Direct pred/succ sets per node (one hop in the key-activity graph)
  const directPreds = {}, directSuccs = {};
  allKeyIds.forEach(id => { directPreds[id] = new Set(); directSuccs[id] = new Set(); });
  allConns.forEach(({ src, tgt }) => { directPreds[tgt].add(src); directSuccs[src].add(tgt); });

  // Build sorted [{label, rel}] entry lists: direct first, then indirect, each group by float
  function buildEntries(id, reachableIds, directSet) {
    const direct   = reachableIds.filter(r => directSet.has(r)).sort(byFloat);
    const indirect = reachableIds.filter(r => !directSet.has(r)).sort(byFloat);
    return [
      ...direct.map(r   => ({ label: fmtEntry(r), rel: 'Direct',   id: r })),
      ...indirect.map(r => ({ label: fmtEntry(r), rel: 'Indirect', id: r })),
    ];
  }

  const sortedKeys = allKeyIds.slice().sort(byFloat);
  const header = ['Activity Code', 'Short Name', 'Total Float (days)',
                  'Predecessor Key Activity', 'Pred Relationship',
                  'Pred Early End', 'Pred Total Float (days)',
                  'Successor Key Activity',   'Succ Relationship'];
  const rows = [header];
  sortedKeys.forEach(id => {
    const t = taskById[id];
    const predEntries = buildEntries(id, reachable(id, bwd), directPreds[id]);
    const succEntries = buildEntries(id, reachable(id, fwd), directSuccs[id]);
    const numRows = Math.max(predEntries.length, succEntries.length, 1);
    for (let i = 0; i < numRows; i++) {
      const pe = predEntries[i], se = succEntries[i];
      const predVal = predEntries.length === 0 && i === 0 ? 'None' : (pe?.label || '');
      const predRel = pe?.rel || '';
      const predEnd = pe?.id ? (taskById[pe.id]?.early_end || '') : '';
      const predFloat = pe?.id && taskById[pe.id]?.float_days != null
        ? Math.round(taskById[pe.id].float_days) : '';
      const succVal = succEntries.length === 0 && i === 0 ? 'None' : (se?.label || '');
      const succRel = se?.rel || '';
      rows.push(i === 0
        ? [t?.code || id, shorthandMap[id] || t?.name || '',
           t?.float_days != null ? Math.round(t.float_days) : '',
           predVal, predRel, predEnd, predFloat, succVal, succRel]
        : ['', '', '', predVal, predRel, predEnd, predFloat, succVal, succRel]
      );
    }
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 16 }, { wch: 45 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 45 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Chain Analysis');
  XLSX.writeFile(wb, 'chain_analysis.xlsx');
});

// ── export ───────────────────────────────────────────────────────────────
document.getElementById('export-btn').addEventListener('click', () => {
  // Column order matches import: A=Activity ID, B=Shorthand, C=Category, D=Name, E=Float
  const rows = [['Activity ID', 'Shorthand Name', 'Category', 'Name', 'Float (days)']];
  keySet.forEach(id => {
    const t = taskById[id];
    if (t) rows.push([
      t.code,
      shorthandMap[id] || '',
      categoryOverrideMap[id] || t.category || '',
      t.name,
      t.float_days ?? '',
    ]);
  });

  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Key Activities');
    XLSX.writeFile(wb, 'key_activities.xlsx');
  } else {
    // Fallback: CSV
    const csv = rows.map(r => r.map(c => '"' + String(c).replace(/"/g,'""') + '"').join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'key_activities.csv';
    a.click();
  }
});


// ════════════════════════════════════════════════════════════════════════
// 3.  DIAGRAM BUILDER  (path-finding + Plotly render)
// ════════════════════════════════════════════════════════════════════════

// Simple BFS shortest-path (avoids graphology dependency for now)
function bfsPath(srcId, tgtId) {
  if (srcId === tgtId) return [srcId];
  const visited = new Set([srcId]);
  const queue = [[srcId]];
  while (queue.length) {
    const path = queue.shift();
    const node = path[path.length - 1];
    for (const next of (succMap[node] || [])) {
      if (next === tgtId) return [...path, next];
      if (!visited.has(next)) { visited.add(next); queue.push([...path, next]); }
    }
  }
  return null;
}

function hasPath(srcId, tgtId) {
  return bfsPath(srcId, tgtId) !== null;
}

// Find connections with transitive reduction
function findConnections(keyIds) {
  const keySetLocal = new Set(keyIds);
  const connections = [];
  const seen = new Set();

  for (let i = 0; i < keyIds.length; i++) {
    for (let j = i + 1; j < keyIds.length; j++) {
      const a = keyIds[i], b = keyIds[j];
      let src, tgt;
      if (hasPath(a, b))      { src = a; tgt = b; }
      else if (hasPath(b, a)) { src = b; tgt = a; }
      else continue;

      const pairKey = src + '|' + tgt;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const path = bfsPath(src, tgt);
      if (!path) continue;

      const intermediate = path.slice(1, -1);
      // Transitive reduction: skip if a key activity is on the path
      if (intermediate.some(id => keySetLocal.has(id))) continue;

      connections.push({ src, tgt, intermediate });
    }
  }
  return connections;
}

// Date utilities
function parseDate(s) {
  if (!s) return null;
  return new Date(s);
}

// Compute Plotly layout positions (x=time, y=stacked)
function computeLayout(keyIds, dateField) {
  const dates = {};
  keyIds.forEach(id => {
    const t = taskById[id];
    if (!t) return;
    const d = parseDate(t[dateField] || t.early_start);
    if (d) dates[id] = d;
  });

  if (!Object.keys(dates).length) {
    return Object.fromEntries(keyIds.map((id, i) => [id, { x: i, y: 0 }]));
  }

  const minT = Math.min(...Object.values(dates).map(d => d.getTime()));
  const maxT = Math.max(...Object.values(dates).map(d => d.getTime()));
  const span = Math.max(maxT - minT, 1);

  // x in days from start
  const xVals = {};
  keyIds.forEach(id => {
    xVals[id] = dates[id] ? (dates[id].getTime() - minT) / 86400000 : 0;
  });

  // Cluster by ~3% of span (min 7 days)
  const clusterRes = Math.max(7, span / 86400000 * 0.03);
  const sorted = [...keyIds].sort((a, b) => (xVals[a] || 0) - (xVals[b] || 0));
  const clusters = [];
  sorted.forEach(id => {
    const x = xVals[id] || 0;
    if (clusters.length && x - (xVals[clusters[clusters.length - 1][0]] || 0) <= clusterRes) {
      clusters[clusters.length - 1].push(id);
    } else {
      clusters.push([id]);
    }
  });

  const maxClSize = Math.max(...clusters.map(c => c.length), 1);
  const totalY = (maxClSize - 1) * 2.0;

  const positions = {};
  clusters.forEach(cl => {
    const n = cl.length;
    cl.sort((a, b) => (taskById[a]?.code || '').localeCompare(taskById[b]?.code || ''));
    cl.forEach((id, i) => {
      const x = (xVals[id] || 0) + i * clusterRes * 0.12;
      const y = n === 1 ? totalY / 2 : i * totalY / (n - 1);
      positions[id] = { x, y, date: dates[id] };
    });
  });
  return positions;
}

// Line width calculation
// localMaxF / localMinF: optional float range from the current diagram connections
// (when provided, normalizes within the visible range for better contrast)
function edgeWidth(conn, localMinF, localMaxF, floatOverride) {
  if (lineWeightMode === 'uniform') return 2;
  if (lineWeightMode === 'float') {
    let f;
    if (floatOverride !== undefined) {
      f = floatOverride ?? 999;
    } else {
      const srcFloat = taskById[conn.src]?.float_days;
      const tgtFloat = taskById[conn.tgt]?.float_days;
      f = Math.min(srcFloat ?? 999, tgtFloat ?? 999);
    }
    const minF = localMinF ?? 0;
    const maxF = localMaxF ?? Math.max(1, maxFloat);
    const span = Math.max(1, maxF - minF);
    // Log scale: high resolution near critical path, compressed at large floats
    const logF    = Math.log(Math.min(Math.max(f - minF, 0), span) + 1);
    const logSpan = Math.log(span + 1);
    return 1 + 4 * (1 - logF / logSpan);
  }
  if (lineWeightMode === 'link_float') {
    const lf = connLinkFloat(conn) ?? 999;
    const minF = localMinF ?? 0;
    const maxF = localMaxF ?? Math.max(1, maxLinkFloat);
    const span = Math.max(1, maxF - minF);
    const logF    = Math.log(Math.min(Math.max(lf - minF, 0), span) + 1);
    const logSpan = Math.log(span + 1);
    return 1 + 4 * (1 - logF / logSpan);
  }
  if (lineWeightMode === 'downstream') {
    const edge = PAYLOAD.edges.find(e => e.src_id === conn.src && e.tgt_id === conn.tgt);
    const ds = edge ? edge.downstream_len : 1;
    const minDs = localMinF ?? 0;
    const maxDs = localMaxF ?? Math.max(1, ...PAYLOAD.edges.map(e => e.downstream_len));
    const span = Math.max(1, maxDs - minDs);
    return 1 + 4 * (Math.min(Math.max(ds - minDs, 0), span) / span);
  }
  return 2;
}

// ── diagram render state (rebuilt each rebuildDiagram call) ─────────────
let _diag = null;
// _diag = {
//   filteredIds,     // ordered array of task ids shown
//   connections,     // array of {src, tgt}
//   positions,       // id -> {x, y, date}
//   bgLineTI,        // per-connection: trace index of background line (-1 if skipped)
//   ovLineTI,        // per-connection: trace index of overlay line (-1 if skipped)
//   nodeTraceIdx,    // trace index of the node scatter
//   baseNodeColors,  // per-node fill colors (for reset)
//   baseEdgeColors,  // per-connection base line colors (for reset)
// }

let _activeHighlightId = null;  // currently clicked node in the diagram

const _EDGE_BASE    = '#8aabcb';
const _EDGE_SUCC    = '#3498db';   // blue
const _EDGE_PRED    = '#9b59b6';   // purple
const _EDGE_FADED   = 'rgba(100,100,100,0.1)';
const _NODE_DEFAULT = '#333333';
const _NODE_HOVERED = '#e94560';   // red
const _NODE_SUCC    = '#3498db';   // blue
const _NODE_PRED    = '#9b59b6';   // purple
const _NODE_FADED   = 'rgba(180,180,180,0.35)';

// Main diagram builder
// Trace rendering order (z-order = index order in Plotly):
//   Pass 1: background line traces   — faded on click
//   Pass 2: overlay line traces      — opacity=0 at rest; shown highlighted on click, always on top of Pass 1
//   Pass 3: node trace               — always last = always on top
// Float labels are rendered as Plotly annotations (layout-level) on click,
// cleared on deselect — annotations support native bgcolor rectangle.
function rebuildDiagram() {
  const plotDiv = document.getElementById('plotly-div');

  const filteredIds = [...keySet].filter(id => {
    const t = taskById[id];
    if (!t) return false;
    if (currentFloatFilter === Infinity) return true;
    return (t.float_days ?? Infinity) <= currentFloatFilter;
  });

  _diag = null;

  if (filteredIds.length < 2) {
    Plotly.purge(plotDiv);
    Plotly.newPlot(plotDiv, [], {
      paper_bgcolor: 'white', plot_bgcolor: 'white',
      xaxis: { visible: false }, yaxis: { visible: false },
      annotations: [{
        text: filteredIds.length === 0
          ? 'Select key activities in the explorer →'
          : 'Select at least 2 key activities to show connections',
        xref: 'paper', yref: 'paper', x: 0.5, y: 0.5,
        showarrow: false, font: { color: '#aaa', size: 14 },
      }],
      margin: { l: 20, r: 20, t: 20, b: 20 },
    }, { responsive: true, displayModeBar: false });
    return;
  }

  const connections = findConnections(filteredIds);
  const positions = computeLayout(filteredIds, 'early_start');

  // Compute local float/downstream range from visible connections so width
  // normalization spans the full 1–5px range regardless of schedule extremes.
  let localMinF = 0, localMaxF = 1;
  if (lineWeightMode === 'float' && connections.length) {
    const connFloats = connections.map(conn => {
      const sf = taskById[conn.src]?.float_days ?? 0;
      const tf = taskById[conn.tgt]?.float_days ?? 0;
      return Math.min(sf, tf);
    });
    localMinF = Math.min(...connFloats);
    localMaxF = Math.max(...connFloats);
    if (localMaxF === localMinF) { localMinF = 0; }  // avoid zero span
  } else if (lineWeightMode === 'link_float' && connections.length) {
    const vals = connections.map(conn => connLinkFloat(conn) ?? 0);
    localMinF = Math.min(...vals);
    localMaxF = Math.max(...vals);
    if (localMaxF === localMinF) { localMinF = 0; }
  } else if (lineWeightMode === 'downstream' && connections.length) {
    const dsVals = connections.map(conn => {
      const edge = PAYLOAD.edges.find(e => e.src_id === conn.src && e.tgt_id === conn.tgt);
      return edge ? edge.downstream_len : 1;
    });
    localMinF = Math.min(...dsVals);
    localMaxF = Math.max(...dsVals);
    if (localMaxF === localMinF) { localMinF = 0; }
  }

  const traces = [];
  const bgLineTI = [];    // Pass 1: background edge trace index per connection
  const ovLineTI = [];    // Pass 2: overlay edge trace index per connection
  const baseEdgeColors = [];

  // ── Pass 1: background line traces (always uniform — weight applies on click) ──
  connections.forEach(conn => {
    const sPos = positions[conn.src], tPos = positions[conn.tgt];
    if (!sPos || !tPos) { bgLineTI.push(-1); baseEdgeColors.push(_EDGE_BASE); return; }
    baseEdgeColors.push(_EDGE_BASE);
    bgLineTI.push(traces.length);
    traces.push({
      type: 'scatter', mode: 'lines',
      x: [sPos.x, tPos.x, null], y: [sPos.y, tPos.y, null],
      line: { color: _EDGE_BASE, width: 1 },
      hoverinfo: 'none', showlegend: false,
    });
  });

  // ── Pass 2: overlay line traces (opacity=0, shown with variable width on click) ──
  connections.forEach(conn => {
    const sPos = positions[conn.src], tPos = positions[conn.tgt];
    if (!sPos || !tPos) { ovLineTI.push(-1); return; }
    ovLineTI.push(traces.length);
    traces.push({
      type: 'scatter', mode: 'lines',
      x: [sPos.x, tPos.x, null], y: [sPos.y, tPos.y, null],
      line: { color: _EDGE_BASE, width: 1 },
      opacity: 0, hoverinfo: 'none', showlegend: false,
    });
  });

  // Float labels are rendered as Plotly annotations (not traces) so they
  // get a proper bgcolor rectangle. Added/removed in _applyHighlight/_clearHighlight.

  // ── Pass 3: node trace (always last = always on top) ─────────────────
  const nodeTraceIdx = traces.length;
  const nodeX = [], nodeY = [], nodeText = [], baseNodeColors = [], nodeHover = [];
  filteredIds.forEach(id => {
    const pos = positions[id]; if (!pos) return;
    const t = taskById[id];
    nodeX.push(pos.x); nodeY.push(pos.y); nodeText.push(getLabelForTask(t));
    baseNodeColors.push(nodeColor(t));
    const tfStr = t.float_days != null ? `TF: ${Math.round(t.float_days)}d` : '';
    const ffStr = t.free_float_days != null ? `FF: ${Math.round(t.free_float_days)}d` : '';
    nodeHover.push(`<b>${t.code}</b><br>${t.name}<br>${[tfStr, ffStr].filter(Boolean).join('  ')}`);
  });
  const n = filteredIds.length;
  traces.push({
    type: 'scatter', mode: 'markers+text',
    x: nodeX, y: nodeY, text: nodeText, textposition: 'top center',
    textfont: { color: new Array(n).fill(_NODE_DEFAULT), size: 10 },
    marker: { color: baseNodeColors.slice(), size: 14,
              line: { color: new Array(n).fill(_NODE_DEFAULT), width: 1.5 } },
    hovertext: nodeHover, hoverinfo: 'text',
    hoverlabel: { bgcolor: '#f5f5f5', bordercolor: '#ccc', font: { color: '#222' } },
    showlegend: false, _isNodes: true,
  });

  // ── x-axis tick labels (monthly) ──────────────────────────────────────
  const allDates = Object.values(positions).map(p => p.date).filter(Boolean);
  const tickVals = [], tickText = [];
  if (allDates.length) {
    const minD = new Date(Math.min(...allDates.map(d => d.getTime())));
    const maxD = new Date(Math.max(...allDates.map(d => d.getTime())));
    const cur = new Date(minD.getFullYear(), minD.getMonth(), 1);
    const origin = new Date(minD);
    while (cur <= maxD) {
      tickVals.push((cur - origin) / 86400000);
      tickText.push(cur.toLocaleString('default', { month: 'short', year: '2-digit' }));
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  const layout = {
    paper_bgcolor: 'white', plot_bgcolor: 'white', font: { color: '#333' },
    xaxis: { tickvals: tickVals, ticktext: tickText, gridcolor: '#e8e8e8',
             zeroline: false, tickfont: { size: 9 }, color: '#666' },
    yaxis: { visible: false },
    margin: { l: 50, r: 20, t: 30, b: 40 }, hovermode: 'closest',
    dragmode: 'pan',
  };

  Plotly.react(plotDiv, traces, layout, {
    responsive: true,
    scrollZoom: true,
    displayModeBar: 'hover',
    modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toImage'],
    displaylogo: false,
  });

  _diag = { filteredIds, connections, positions, bgLineTI, ovLineTI,
            localMinF, localMaxF,
            nodeTraceIdx, baseNodeColors, baseEdgeColors };

  // ── click interactions on diagram ─────────────────────────────────────
  // Highlight fires on click (not hover) so restyle only runs on deliberate
  // interaction, not on every mouse movement.
  _activeHighlightId = null;   // clear any previous selection on rebuild
  plotDiv.removeAllListeners('plotly_click');

  function _applyHighlight(selectedId) {
    const { filteredIds: fIds, connections: conns, positions: pos,
            bgLineTI: bLTI,
            ovLineTI: oLTI,
            localMinF, localMaxF,
            nodeTraceIdx: nti, baseNodeColors: bnc } = _diag;

    const succConnSet = new Set(), predConnSet = new Set();
    conns.forEach((conn, ci) => {
      if (conn.src === selectedId) succConnSet.add(ci);
      if (conn.tgt === selectedId) predConnSet.add(ci);
    });
    const succNodeSet = new Set(), predNodeSet = new Set();
    conns.forEach((conn, ci) => {
      if (succConnSet.has(ci)) succNodeSet.add(conn.tgt);
      if (predConnSet.has(ci)) predNodeSet.add(conn.src);
    });

    // Fade background line traces
    const bgLTIs = bLTI.filter(i => i >= 0);
    if (bgLTIs.length)
      Plotly.restyle(plotDiv, { 'line.color': bgLTIs.map(() => _EDGE_FADED) }, bgLTIs);

    // Show overlay line traces for pred/succ connections
    const ovHighTIs = [], ovHighColors = [];
    conns.forEach((conn, ci) => {
      const ti = oLTI[ci]; if (ti < 0) return;
      if (succConnSet.has(ci) || predConnSet.has(ci)) {
        ovHighTIs.push(ti);
        ovHighColors.push(succConnSet.has(ci) ? _EDGE_SUCC : _EDGE_PRED);
      }
    });
    if (ovHighTIs.length) {
      // Recompute local range from just the highlighted connections so the
      // full 1–5px width range is used regardless of diagram-wide extremes.
      let hlMinF = localMinF, hlMaxF = localMaxF;
      // directional float per highlighted ti: pred arrows use src TF, succ arrows use tgt TF
      const _dirFloat = ti => {
        const ci = oLTI.indexOf(ti);
        const c = conns[ci];
        return predConnSet.has(ci)
          ? (taskById[c.src]?.float_days ?? 0)
          : (taskById[c.tgt]?.float_days ?? 0);
      };
      if (lineWeightMode === 'link_float') {
        const hVals = ovHighTIs.map(ti => connLinkFloat(conns[oLTI.indexOf(ti)]) ?? 0);
        hlMinF = Math.min(...hVals);
        hlMaxF = Math.max(...hVals);
        if (hlMaxF === hlMinF) hlMinF = 0;
      } else if (lineWeightMode === 'float') {
        const hVals = ovHighTIs.map(_dirFloat);
        hlMinF = Math.min(...hVals);
        hlMaxF = Math.max(...hVals);
        if (hlMaxF === hlMinF) hlMinF = 0;
      }
      const ovHighWidths = ovHighTIs.map((ti) => {
        const ci = oLTI.indexOf(ti);
        const dirF = lineWeightMode === 'float' ? _dirFloat(ti) : undefined;
        return edgeWidth(conns[ci], hlMinF, hlMaxF, dirF);
      });
      Plotly.restyle(plotDiv, {
        'line.color': ovHighColors,
        'line.width': ovHighWidths,
        'opacity': ovHighTIs.map(() => 1),
      }, ovHighTIs);
    }

    // Float labels as Plotly annotations (proper bgcolor rectangle support)
    if (floatLabelMode !== 'none') {
      const annotations = [];
      conns.forEach((conn, ci) => {
        if (!succConnSet.has(ci) && !predConnSet.has(ci)) return;
        const sPos = pos[conn.src], tPos = pos[conn.tgt];
        if (!sPos || !tPos) return;
        const mx = (sPos.x + tPos.x) / 2, my = (sPos.y + tPos.y) / 2;
        let lbl;
        if (floatLabelMode === 'link') {
          const lf = connLinkFloat(conn);
          lbl = lf != null ? Math.round(lf) + 'd' : '?';
        } else {
          // Predecessor arrows: show the predecessor's TF (which upstream path is driving?)
          // Successor arrows: show the successor's TF (which downstream path is at risk?)
          const f = predConnSet.has(ci)
            ? taskById[conn.src]?.float_days
            : taskById[conn.tgt]?.float_days;
          lbl = f != null ? Math.round(f) + 'd' : '?';
        }
        const color = succConnSet.has(ci) ? _EDGE_SUCC : _EDGE_PRED;
        annotations.push({
          x: mx, y: my, xref: 'x', yref: 'y',
          text: lbl, showarrow: false,
          font: { color, size: 10 },
          bgcolor: 'rgba(255,255,255,0.9)',
          borderpad: 3,
        });
      });

      // Selected node: show its total float below the circle
      const selPos = pos[selectedId];
      const selTask = taskById[selectedId];
      if (selPos && selTask?.float_days != null) {
        annotations.push({
          x: selPos.x, y: selPos.y, xref: 'x', yref: 'y',
          text: `TF: ${Math.round(selTask.float_days)}d`,
          showarrow: false,
          yshift: -18,
          font: { color: _NODE_HOVERED, size: 10 },
          bgcolor: 'rgba(255,255,255,0.9)',
          borderpad: 2,
        });
      }

      Plotly.relayout(plotDiv, { annotations });
    }

    // Restyle node trace
    const newTxtC = [], newTxtW = [], newOutC = [], newMrkC = [];
    fIds.forEach((id, i) => {
      if (id === selectedId) {
        newTxtC.push(_NODE_HOVERED); newTxtW.push(700);
        newOutC.push(_NODE_HOVERED); newMrkC.push(bnc[i]);
      } else if (succNodeSet.has(id)) {
        newTxtC.push(_NODE_SUCC); newTxtW.push(400);
        newOutC.push(_NODE_SUCC); newMrkC.push(bnc[i]);
      } else if (predNodeSet.has(id)) {
        newTxtC.push(_NODE_PRED); newTxtW.push(400);
        newOutC.push(_NODE_PRED); newMrkC.push(bnc[i]);
      } else {
        newTxtC.push(_NODE_FADED); newTxtW.push(400);
        newOutC.push(_NODE_FADED); newMrkC.push(_NODE_FADED);
      }
    });
    Plotly.restyle(plotDiv, {
      'textfont.color': [newTxtC], 'textfont.weight': [newTxtW],
      'marker.color': [newMrkC], 'marker.line.color': [newOutC],
    }, [nti]);

    // Sync explorer
    focusExplorer(selectedId);
    document.getElementById('svg-btn').disabled = false;
  }

  function _clearHighlight() {
    const { filteredIds: fIds, connections: conns,
            bgLineTI: bLTI,
            ovLineTI: oLTI,
            nodeTraceIdx: nti, baseNodeColors: bnc, baseEdgeColors: bec } = _diag;

    const bgRestoreTIs = [], bgRestoreColors = [];
    conns.forEach((conn, ci) => {
      if (bLTI[ci] >= 0) { bgRestoreTIs.push(bLTI[ci]); bgRestoreColors.push(bec[ci]); }
    });
    if (bgRestoreTIs.length)
      Plotly.restyle(plotDiv, { 'line.color': bgRestoreColors }, bgRestoreTIs);

    const allOvLTIs = oLTI.filter(i => i >= 0);
    if (allOvLTIs.length)
      Plotly.restyle(plotDiv, { 'opacity': allOvLTIs.map(() => 0) }, allOvLTIs);

    if (floatLabelMode !== 'none') {
      Plotly.relayout(plotDiv, { annotations: [] });
    }

    Plotly.restyle(plotDiv, {
      'textfont.color': [fIds.map(() => _NODE_DEFAULT)],
      'textfont.weight': [fIds.map(() => 400)],
      'marker.color': [bnc.slice()],
      'marker.line.color': [fIds.map(() => _NODE_DEFAULT)],
    }, [nti]);

    clearExplorer();
    document.getElementById('svg-btn').disabled = true;
  }

  plotDiv.on('plotly_click', evt => {
    if (!_diag) return;
    const pt = evt.points && evt.points[0];
    if (!pt || !pt.data._isNodes) return;
    const clickedId = _diag.filteredIds[pt.pointIndex];
    if (!clickedId) return;

    if (clickedId === _activeHighlightId) {
      _activeHighlightId = null;
      _clearHighlight();
    } else {
      _activeHighlightId = clickedId;
      _applyHighlight(clickedId);
    }
  });
}

// ── SVG focus export ─────────────────────────────────────────────────────

function _svgWrapText(text, maxWidth, fontSize) {
  const avgCharW = fontSize * 0.58;
  const maxChars = Math.floor(maxWidth / avgCharW);
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? cur + ' ' + w : w;
    if (candidate.length <= maxChars) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      cur = w.length > maxChars ? w.slice(0, maxChars - 1) + '\u2026' : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);  // cap at 4 lines
}

function _svgComputeColumns(nodeIds, edges) {
  const out = {}, inDeg = {};
  nodeIds.forEach(id => { out[id] = []; inDeg[id] = 0; });
  edges.forEach(({ src, tgt }) => {
    if (out[src] !== undefined && inDeg[tgt] !== undefined) {
      out[src].push(tgt);
      inDeg[tgt]++;
    }
  });
  const col = {};
  nodeIds.forEach(id => col[id] = 0);
  const q = nodeIds.filter(id => inDeg[id] === 0).slice();
  while (q.length) {
    const id = q.shift();
    out[id].forEach(tgt => {
      col[tgt] = Math.max(col[tgt] ?? 0, (col[id] ?? 0) + 1);
      if (--inDeg[tgt] === 0) q.push(tgt);
    });
  }
  return col;
}

function generateFocusSVG(selectedId) {
  if (!_diag || !selectedId) return;
  const { connections: conns } = _diag;

  // Build pred/succ sets same as _applyHighlight
  const succConnSet = new Set(), predConnSet = new Set();
  conns.forEach((conn, ci) => {
    if (conn.src === selectedId) succConnSet.add(ci);
    if (conn.tgt === selectedId) predConnSet.add(ci);
  });
  const succNodeSet = new Set(), predNodeSet = new Set();
  conns.forEach((conn, ci) => {
    if (succConnSet.has(ci)) succNodeSet.add(conn.tgt);
    if (predConnSet.has(ci)) predNodeSet.add(conn.src);
  });

  const nodeSet = new Set([...predNodeSet, selectedId, ...succNodeSet]);
  const nodeIds = [...nodeSet];

  // Deduplicated direct edges between visible nodes
  const edgeSeen = new Set();
  const visEdges = [];
  conns.forEach(c => {
    const key = c.src + '|' + c.tgt;
    if (nodeSet.has(c.src) && nodeSet.has(c.tgt) && !edgeSeen.has(key)) {
      edgeSeen.add(key);
      visEdges.push({ src: c.src, tgt: c.tgt });
    }
  });

  // Column layout via longest path
  const colMap = _svgComputeColumns(nodeIds, visEdges);

  // Group nodes by column, sort rows by code
  const colGroups = {};
  nodeIds.forEach(id => {
    const c = colMap[id] ?? 0;
    (colGroups[c] = colGroups[c] || []).push(id);
  });
  Object.values(colGroups).forEach(ids =>
    ids.sort((a, b) => (taskById[a]?.code || '').localeCompare(taskById[b]?.code || ''))
  );

  // Node sizing constants
  const NODE_W = 130, PAD_X = 8, PAD_TOP = 7, PAD_BOT = 7, LINE_H = 13;
  const CODE_FS = 11, NAME_FS = 10, COL_GAP = 72, ROW_GAP = 22, MARGIN = 40;

  // Pre-compute label text and node height for each node
  const nodeInfo = {};
  nodeIds.forEach(id => {
    const t = taskById[id];
    const code = t?.code || id;
    const label = shorthandMap[id] || t?.name || '';
    const nameLines = label ? _svgWrapText(label, NODE_W - PAD_X * 2, NAME_FS) : [];
    const h = PAD_TOP + LINE_H + (nameLines.length ? 3 + nameLines.length * LINE_H : 0) + PAD_BOT;
    nodeInfo[id] = { code, nameLines, h };
  });

  // Column x positions
  const colKeys = Object.keys(colGroups).map(Number).sort((a, b) => a - b);
  const colX = {};
  colKeys.forEach((c, i) => { colX[c] = MARGIN + i * (NODE_W + COL_GAP); });

  // Total canvas size
  const maxColH = Math.max(...colKeys.map(c => {
    const ids = colGroups[c];
    return ids.reduce((s, id) => s + nodeInfo[id].h, 0) + Math.max(0, ids.length - 1) * ROW_GAP;
  }));
  const totalH = maxColH + MARGIN * 2;
  const totalW = colKeys.length * (NODE_W + COL_GAP) - COL_GAP + MARGIN * 2;

  // Row y positions (center each column's group vertically)
  const pos = {};
  colKeys.forEach(c => {
    const ids = colGroups[c];
    const groupH = ids.reduce((s, id) => s + nodeInfo[id].h, 0) + Math.max(0, ids.length - 1) * ROW_GAP;
    let y = (totalH - groupH) / 2;
    ids.forEach(id => { pos[id] = { x: colX[c], y }; y += nodeInfo[id].h + ROW_GAP; });
  });

  // Build SVG string
  const esc = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" `;
  svg += `font-family="'Segoe UI',Arial,sans-serif">\n`;
  svg += `<rect width="${totalW}" height="${totalH}" fill="white"/>\n`;
  svg += `<defs><marker id="ah" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">`;
  svg += `<polygon points="0 0,10 3.5,0 7" fill="#666"/></marker></defs>\n`;

  // Edges
  svg += `<g id="edges">\n`;
  visEdges.forEach(({ src, tgt }) => {
    const sp = pos[src], tp = pos[tgt];
    if (!sp || !tp) return;
    const x1 = sp.x + NODE_W, y1 = sp.y + nodeInfo[src].h / 2;
    const x2 = tp.x,          y2 = tp.y + nodeInfo[tgt].h / 2;
    const cpx = Math.max(28, (x2 - x1) * 0.4);
    svg += `  <path d="M ${x1} ${y1} C ${x1+cpx} ${y1},${x2-cpx} ${y2},${x2} ${y2}" `;
    svg += `fill="none" stroke="#666" stroke-width="1.5" marker-end="url(#ah)"/>\n`;
  });
  svg += `</g>\n`;

  // Nodes
  svg += `<g id="nodes">\n`;
  nodeIds.forEach(id => {
    const p = pos[id]; if (!p) return;
    const { code, nameLines, h } = nodeInfo[id];
    const isSel = id === selectedId;
    const fill   = isSel ? '#d4d4d4' : '#f5f5f5';
    const stroke = isSel ? '#333'    : '#888';
    const sw     = isSel ? 2         : 1.5;
    svg += `  <g transform="translate(${p.x},${p.y})">\n`;
    svg += `    <rect width="${NODE_W}" height="${h}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>\n`;
    svg += `    <text x="${NODE_W/2}" y="${PAD_TOP + CODE_FS}" text-anchor="middle" `;
    svg += `font-size="${CODE_FS}" font-weight="700" fill="#222">${esc(code)}</text>\n`;
    nameLines.forEach((line, i) => {
      const ty = PAD_TOP + CODE_FS + 3 + (i + 1) * LINE_H;
      svg += `    <text x="${NODE_W/2}" y="${ty}" text-anchor="middle" font-size="${NAME_FS}" fill="#444">${esc(line)}</text>\n`;
    });
    svg += `  </g>\n`;
  });
  svg += `</g>\n</svg>`;

  const blob = new Blob([svg], { type: 'image/svg+xml' });
  window.open(URL.createObjectURL(blob), '_blank');
}

// Button wiring (element added in HTML)
document.getElementById('svg-btn').addEventListener('click', () => {
  if (_activeHighlightId) generateFocusSVG(_activeHighlightId);
});

// Initial empty diagram
rebuildDiagram();
