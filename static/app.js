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

// Assign category colours
const catColorMap = {};
PAYLOAD.categories.forEach((cat, i) => {
  catColorMap[cat] = CAT_PALETTE[i % CAT_PALETTE.length];
});
function nodeColor(task) {
  if (task.category && catColorMap[task.category]) return catColorMap[task.category];
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

// ════════════════════════════════════════════════════════════════════════
// 1.  CYTOSCAPE NETWORK EXPLORER
// ════════════════════════════════════════════════════════════════════════

const cyNodes = PAYLOAD.tasks.map(t => ({
  data: { id: t.id, label: t.code, task: t },
}));
const cyEdges = PAYLOAD.edges.map((e, i) => ({
  data: {
    id: 'e' + i,
    source: e.src_id,
    target: e.tgt_id,
    edgeData: e,
  },
}));

const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: { nodes: cyNodes, edges: cyEdges },
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
    {
      selector: 'node.selected-key',
      style: {
        'border-width': 3,
        'border-color': '#e94560',
        'background-color': '#e94560',
      }
    },
    {
      selector: 'node.highlighted',
      style: {
        'border-width': 2,
        'border-color': '#f39c12',
        'z-index': 10,
      }
    },
    {
      selector: 'node.faded',
      style: { 'opacity': 0.15 }
    },
    {
      selector: 'edge',
      style: {
        'width': 1,
        'line-color': '#aaaaaa',
        'target-arrow-color': '#aaaaaa',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'opacity': 0.7,
        'arrow-scale': 0.8,
      }
    },
    {
      selector: 'edge.highlighted-succ',
      style: { 'line-color': '#3498db', 'target-arrow-color': '#3498db', 'opacity': 1, 'width': 2 }
    },
    {
      selector: 'edge.highlighted-pred',
      style: { 'line-color': '#9b59b6', 'target-arrow-color': '#9b59b6', 'opacity': 1, 'width': 2 }
    },
    {
      selector: 'edge.faded',
      style: { 'opacity': 0.05 }
    },
    {
      selector: 'node.hidden, edge.hidden',
      style: { 'display': 'none' }
    },
  ],
  layout: { name: 'preset' },   // positions set via dagre later
  wheelSensitivity: 0.3,
  minZoom: 0.05,
  maxZoom: 4,
});

// Apply dagre layout after mount
setTimeout(() => {
  cy.layout({
    name: 'breadthfirst',
    directed: true,
    spacingFactor: 1.2,
    animate: false,
  }).run();
  cy.fit(cy.elements(), 30);
}, 50);

// ── node click: toggle key activity ─────────────────────────────────────
cy.on('tap', 'node', evt => {
  const node = evt.target;
  const id = node.id();
  if (keySet.has(id)) {
    keySet.delete(id);
    node.removeClass('selected-key');
  } else {
    keySet.add(id);
    node.addClass('selected-key');
  }
  updateSelectedCount();
  rebuildDiagram();
});

// ── node hover: highlight neighbours ────────────────────────────────────
const tooltip = document.getElementById('cy-tooltip');

cy.on('mouseover', 'node', evt => {
  const node = evt.target;
  const task = node.data('task');

  // highlight neighbours
  cy.elements().addClass('faded').removeClass('highlighted highlighted-succ highlighted-pred');
  node.removeClass('faded').addClass('highlighted');
  node.outgoers('edge').removeClass('faded').addClass('highlighted-succ');
  node.incomers('edge').removeClass('faded').addClass('highlighted-pred');
  node.neighborhood('node').removeClass('faded').addClass('highlighted');

  // tooltip
  const pos = evt.renderedPosition;
  const container = document.getElementById('cy').getBoundingClientRect();
  const floatStr = task.float_days != null ? `Float: ${Math.round(task.float_days)}d` : '';
  tooltip.innerHTML = `
    <div class="tip-code">${task.code}</div>
    <div class="tip-name">${task.name}</div>
    <div class="tip-meta">${floatStr}${task.category ? ' &nbsp;·&nbsp; ' + task.category : ''}</div>
  `;
  tooltip.style.display = 'block';
  tooltip.style.left = (container.left + pos.x + 14) + 'px';
  tooltip.style.top  = (container.top  + pos.y - 10) + 'px';
});

cy.on('mouseout', 'node', () => {
  cy.elements().removeClass('faded highlighted highlighted-succ highlighted-pred');
  tooltip.style.display = 'none';
});

// ── search box ────────────────────────────────────────────────────────────
const searchBox   = document.getElementById('search-box');
const searchCount = document.getElementById('search-count');

searchBox.addEventListener('input', () => {
  const q = searchBox.value.trim().toLowerCase();
  if (!q) {
    cy.elements().removeClass('hidden');
    searchCount.textContent = '';
    return;
  }
  let shown = 0;
  cy.nodes().forEach(n => {
    const t = n.data('task');
    const match = t.code.toLowerCase().includes(q) || t.name.toLowerCase().includes(q);
    if (match) { n.removeClass('hidden'); shown++; }
    else        { n.addClass('hidden'); }
  });
  // Hide edges that connect to hidden nodes
  cy.edges().forEach(e => {
    const hidden = e.source().hasClass('hidden') || e.target().hasClass('hidden');
    if (hidden) e.addClass('hidden'); else e.removeClass('hidden');
  });
  searchCount.textContent = shown + ' shown';
});

// ── footer buttons ────────────────────────────────────────────────────────
document.getElementById('clear-sel-btn').addEventListener('click', () => {
  keySet.clear();
  cy.nodes().removeClass('selected-key');
  updateSelectedCount();
  rebuildDiagram();
});

document.getElementById('add-all-btn').addEventListener('click', () => {
  cy.nodes(':visible').forEach(n => {
    keySet.add(n.id());
    n.addClass('selected-key');
  });
  updateSelectedCount();
  rebuildDiagram();
});

function updateSelectedCount() {
  document.getElementById('selected-count').textContent =
    keySet.size + ' key activit' + (keySet.size === 1 ? 'y' : 'ies') + ' selected';
}

// ── category legend ────────────────────────────────────────────────────────
function buildCategoryLegend() {
  const legend = document.getElementById('cat-legend');
  if (PAYLOAD.categories.length === 0) return;
  legend.style.display = 'block';
  legend.innerHTML = PAYLOAD.categories.map(cat =>
    `<div class="leg-item">
      <div class="leg-swatch" style="background:${catColorMap[cat]}"></div>
      <span>${cat}</span>
    </div>`
  ).join('');
}
buildCategoryLegend();

// ── import key activities ──────────────────────────────────────────────────
const importBtn    = document.getElementById('import-btn');
const importFile   = document.getElementById('import-file');
const importStatus = document.getElementById('import-status');

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
      let rows = [];   // [ [code, shorthand?], ... ]

      if (ext === 'csv' || ext === 'txt') {
        // Parse CSV manually
        const text = evt.target.result;
        text.split(/\r?\n/).forEach(line => {
          if (!line.trim()) return;
          // Handle quoted fields minimally
          const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, '').trim());
          if (parts[0]) rows.push(parts);
        });
      } else {
        // Excel: use SheetJS
        const data = new Uint8Array(evt.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        rows = raw.map(r => [String(r[0] || '').trim(), String(r[1] || '').trim()]);
      }

      // Drop header row if first cell matches known labels
      if (rows.length && _HEADER_LABELS.has(rows[0][0].toLowerCase())) {
        rows = rows.slice(1);
      }

      // Match codes against schedule data
      let matched = 0, missing = [];
      // Clear existing selection first
      keySet.clear();
      cy.nodes().removeClass('selected-key');

      rows.forEach(([code]) => {
        if (!code) return;
        const task = taskByCode[code];
        if (task) {
          keySet.add(task.id);
          cy.getElementById(task.id).addClass('selected-key');
          matched++;
        } else {
          missing.push(code);
        }
      });

      // Reset the file input so the same file can be re-imported if needed
      importFile.value = '';

      updateSelectedCount();
      rebuildDiagram();

      if (missing.length === 0) {
        importStatus.textContent = `✓ ${matched} imported`;
      } else {
        importStatus.textContent = `✓ ${matched} imported, ${missing.length} not found`;
        console.warn('Import: codes not found in schedule:', missing);
      }
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
// 2.  LOGIC DIAGRAM (Plotly)
// ════════════════════════════════════════════════════════════════════════

// ── global state ────────────────────────────────────────────────────────
let currentFloatFilter = Infinity;   // max float days to show (slider value)
let showFloatLabels = false;
let lineWeightMode = 'uniform';      // 'uniform' | 'float' | 'downstream'

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
  showFloatLabels = !showFloatLabels;
  this.classList.toggle('active', showFloatLabels);
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

// ── export ───────────────────────────────────────────────────────────────
document.getElementById('export-btn').addEventListener('click', () => {
  const rows = [['Activity ID', 'Name', 'Float (days)', 'Category']];
  keySet.forEach(id => {
    const t = taskById[id];
    if (t) rows.push([t.code, t.name, t.float_days ?? '', t.category || '']);
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
function edgeWidth(conn) {
  if (lineWeightMode === 'uniform') return 2;
  if (lineWeightMode === 'float') {
    const srcFloat = taskById[conn.src]?.float_days;
    const tgtFloat = taskById[conn.tgt]?.float_days;
    const f = Math.min(srcFloat ?? 999, tgtFloat ?? 999);
    const maxF = Math.max(1, maxFloat);
    // Lower float → thicker line (range 1–5)
    return 1 + 4 * (1 - Math.min(f, maxF) / maxF);
  }
  if (lineWeightMode === 'downstream') {
    // Find the downstream_len for this edge pair from payload
    const edge = PAYLOAD.edges.find(e => e.src_id === conn.src && e.tgt_id === conn.tgt);
    const ds = edge ? edge.downstream_len : 1;
    const maxDs = Math.max(1, ...PAYLOAD.edges.map(e => e.downstream_len));
    return 1 + 4 * (ds / maxDs);
  }
  return 2;
}

// ── diagram render state (rebuilt each rebuildDiagram call) ─────────────
let _diag = null;
// _diag = {
//   filteredIds,          // ordered array of task ids shown
//   connections,          // array of {src, tgt}
//   connLineTraceIdxs,    // per-connection: trace index of its line (-1 if skipped)
//   connLabelTraceIdxs,   // per-connection: trace index of its float label (-1 if none)
//   nodeTraceIdx,         // trace index of the node scatter
//   baseNodeColors,       // per-node fill colors (for reset)
//   baseEdgeColors,       // per-connection base line colors (for reset)
// }

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
//   Pass 1: background line traces        — faded on hover
//   Pass 2: background label traces       — faded on hover
//   Pass 3: overlay line traces (opacity=0 at rest)  — shown highlighted on hover, always on top of Pass 1
//   Pass 4: overlay label traces (opacity=0 at rest) — shown highlighted on hover, always on top of Pass 2
//   Pass 5: node trace                    — always last = always on top
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

  const traces = [];
  const bgLineTI = [];    // Pass 1: background edge trace index per connection
  const bgLabelTI = [];   // Pass 2: background label trace index (-1 if none); halo = bgLabelTI-1
  const ovLineTI = [];    // Pass 3: overlay edge trace index per connection
  const ovLabelTI = [];   // Pass 4: overlay label trace index (-1 if none); halo = ovLabelTI-1
  const baseEdgeColors = [];

  // Helper: label text for a connection
  function connLabel(conn) {
    const f = taskById[conn.src]?.float_days;
    return f != null ? Math.round(f) + 'd' : '?';
  }

  // ── Pass 1: background line traces ────────────────────────────────────
  connections.forEach(conn => {
    const sPos = positions[conn.src], tPos = positions[conn.tgt];
    if (!sPos || !tPos) { bgLineTI.push(-1); baseEdgeColors.push(_EDGE_BASE); return; }
    const width = edgeWidth(conn);
    baseEdgeColors.push(_EDGE_BASE);
    bgLineTI.push(traces.length);
    traces.push({
      type: 'scatter', mode: 'lines',
      x: [sPos.x, tPos.x, null], y: [sPos.y, tPos.y, null],
      line: { color: _EDGE_BASE, width },
      hoverinfo: 'none', showlegend: false,
    });
  });

  // ── Pass 2: background label traces (halo + colored) ──────────────────
  if (showFloatLabels) {
    connections.forEach(conn => {
      const sPos = positions[conn.src], tPos = positions[conn.tgt];
      if (!sPos || !tPos) { bgLabelTI.push(-1); return; }
      const mx = (sPos.x + tPos.x) / 2, my = (sPos.y + tPos.y) / 2;
      const lbl = connLabel(conn);
      traces.push({ type: 'scatter', mode: 'text', x: [mx], y: [my], text: [lbl],
        textfont: { color: 'white', size: 12 }, hoverinfo: 'none', showlegend: false });
      bgLabelTI.push(traces.length);
      traces.push({ type: 'scatter', mode: 'text', x: [mx], y: [my], text: [lbl],
        textfont: { color: [_EDGE_BASE], size: 10 }, hoverinfo: 'none', showlegend: false });
    });
  } else {
    connections.forEach(() => bgLabelTI.push(-1));
  }

  // ── Pass 3: overlay line traces (opacity=0, rendered above Pass 1) ────
  connections.forEach(conn => {
    const sPos = positions[conn.src], tPos = positions[conn.tgt];
    if (!sPos || !tPos) { ovLineTI.push(-1); return; }
    ovLineTI.push(traces.length);
    traces.push({
      type: 'scatter', mode: 'lines',
      x: [sPos.x, tPos.x, null], y: [sPos.y, tPos.y, null],
      line: { color: _EDGE_BASE, width: edgeWidth(conn) },
      opacity: 0, hoverinfo: 'none', showlegend: false,
    });
  });

  // ── Pass 4: overlay label traces (opacity=0, rendered above Pass 2) ───
  if (showFloatLabels) {
    connections.forEach(conn => {
      const sPos = positions[conn.src], tPos = positions[conn.tgt];
      if (!sPos || !tPos) { ovLabelTI.push(-1); return; }
      const mx = (sPos.x + tPos.x) / 2, my = (sPos.y + tPos.y) / 2;
      const lbl = connLabel(conn);
      traces.push({ type: 'scatter', mode: 'text', x: [mx], y: [my], text: [lbl],
        textfont: { color: 'white', size: 12 }, opacity: 0, hoverinfo: 'none', showlegend: false });
      ovLabelTI.push(traces.length);
      traces.push({ type: 'scatter', mode: 'text', x: [mx], y: [my], text: [lbl],
        textfont: { color: [_EDGE_BASE], size: 10 }, opacity: 0, hoverinfo: 'none', showlegend: false });
    });
  } else {
    connections.forEach(() => ovLabelTI.push(-1));
  }

  // ── Pass 5: node trace (always last = always on top) ──────────────────
  const nodeTraceIdx = traces.length;
  const nodeX = [], nodeY = [], nodeText = [], baseNodeColors = [], nodeHover = [];
  filteredIds.forEach(id => {
    const pos = positions[id]; if (!pos) return;
    const t = taskById[id];
    nodeX.push(pos.x); nodeY.push(pos.y); nodeText.push(t.code);
    baseNodeColors.push(nodeColor(t));
    const floatStr = t.float_days != null ? `Float: ${Math.round(t.float_days)}d` : '';
    nodeHover.push(`<b>${t.code}</b><br>${t.name}<br>${floatStr}`);
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
  };

  Plotly.react(plotDiv, traces, layout, { responsive: true, displayModeBar: false });

  _diag = { filteredIds, connections, bgLineTI, bgLabelTI, ovLineTI, ovLabelTI,
            nodeTraceIdx, baseNodeColors, baseEdgeColors };

  // ── hover interactions on diagram ─────────────────────────────────────
  plotDiv.removeAllListeners('plotly_hover');
  plotDiv.removeAllListeners('plotly_unhover');

  plotDiv.on('plotly_hover', evt => {
    if (!_diag) return;
    const pt = evt.points[0];
    if (!pt.data._isNodes) return;
    const hoveredId = _diag.filteredIds[pt.pointIndex];
    if (!hoveredId) return;

    const { filteredIds: fIds, connections: conns,
            bgLineTI: bLTI, bgLabelTI: bLblTI,
            ovLineTI: oLTI, ovLabelTI: oLblTI,
            nodeTraceIdx: nti, baseNodeColors: bnc } = _diag;

    const succConnSet = new Set(), predConnSet = new Set();
    conns.forEach((conn, ci) => {
      if (conn.src === hoveredId) succConnSet.add(ci);
      if (conn.tgt === hoveredId) predConnSet.add(ci);
    });
    const succNodeSet = new Set(), predNodeSet = new Set();
    conns.forEach((conn, ci) => {
      if (succConnSet.has(ci)) succNodeSet.add(conn.tgt);
      if (predConnSet.has(ci)) predNodeSet.add(conn.src);
    });

    // Fade all background line traces
    const bgLTIs = bLTI.filter(i => i >= 0);
    if (bgLTIs.length)
      Plotly.restyle(plotDiv, { 'line.color': bgLTIs.map(() => _EDGE_FADED) }, bgLTIs);

    // Fade all background label traces
    if (showFloatLabels) {
      const bgLblTIs = bLblTI.filter(i => i >= 0);
      if (bgLblTIs.length)
        Plotly.restyle(plotDiv, { 'textfont.color': bgLblTIs.map(() => ['rgba(0,0,0,0)']) }, bgLblTIs);
    }

    // Show overlay line traces for highlighted connections
    const ovHighTIs = [], ovHighColors = [];
    conns.forEach((conn, ci) => {
      const ti = oLTI[ci]; if (ti < 0) return;
      if (succConnSet.has(ci) || predConnSet.has(ci)) {
        ovHighTIs.push(ti);
        ovHighColors.push(succConnSet.has(ci) ? _EDGE_SUCC : _EDGE_PRED);
      }
    });
    if (ovHighTIs.length)
      Plotly.restyle(plotDiv, { 'line.color': ovHighColors, 'opacity': ovHighTIs.map(() => 1) }, ovHighTIs);

    // Show overlay label traces for highlighted connections
    if (showFloatLabels) {
      const ovLblTIs = [], ovLblColors = [], ovHaloTIs = [];
      conns.forEach((conn, ci) => {
        const ti = oLblTI[ci]; if (ti < 0) return;
        if (succConnSet.has(ci) || predConnSet.has(ci)) {
          ovLblTIs.push(ti);
          ovLblColors.push([succConnSet.has(ci) ? _EDGE_SUCC : _EDGE_PRED]);
          ovHaloTIs.push(ti - 1);
        }
      });
      if (ovLblTIs.length) {
        Plotly.restyle(plotDiv, { 'textfont.color': ovLblColors, 'opacity': ovLblTIs.map(() => 1) }, ovLblTIs);
        Plotly.restyle(plotDiv, { 'opacity': ovHaloTIs.map(() => 1) }, ovHaloTIs);
      }
    }

    // Restyle node trace
    const newTxtC = [], newOutC = [], newMrkC = [];
    fIds.forEach((id, i) => {
      if (id === hoveredId) {
        newTxtC.push(_NODE_HOVERED); newOutC.push(_NODE_HOVERED); newMrkC.push(bnc[i]);
      } else if (succNodeSet.has(id)) {
        newTxtC.push(_NODE_SUCC); newOutC.push(_NODE_SUCC); newMrkC.push(bnc[i]);
      } else if (predNodeSet.has(id)) {
        newTxtC.push(_NODE_PRED); newOutC.push(_NODE_PRED); newMrkC.push(bnc[i]);
      } else {
        newTxtC.push(_NODE_FADED); newOutC.push(_NODE_FADED); newMrkC.push(_NODE_FADED);
      }
    });
    Plotly.restyle(plotDiv, {
      'textfont.color': [newTxtC], 'marker.color': [newMrkC], 'marker.line.color': [newOutC],
    }, [nti]);

    // Sync Cytoscape
    cy.elements().removeClass('highlighted highlighted-succ highlighted-pred faded');
    const cyNode = cy.getElementById(hoveredId);
    if (cyNode.length) {
      cy.elements().addClass('faded');
      cyNode.removeClass('faded').addClass('highlighted');
      cyNode.outgoers('edge').removeClass('faded').addClass('highlighted-succ');
      cyNode.incomers('edge').removeClass('faded').addClass('highlighted-pred');
      cyNode.neighborhood('node').removeClass('faded').addClass('highlighted');
    }
  });

  plotDiv.on('plotly_unhover', () => {
    if (!_diag) return;
    const { filteredIds: fIds, connections: conns,
            bgLineTI: bLTI, bgLabelTI: bLblTI,
            ovLineTI: oLTI, ovLabelTI: oLblTI,
            nodeTraceIdx: nti, baseNodeColors: bnc, baseEdgeColors: bec } = _diag;

    // Restore background line traces
    const bgRestoreTIs = [], bgRestoreColors = [];
    conns.forEach((conn, ci) => {
      if (bLTI[ci] >= 0) { bgRestoreTIs.push(bLTI[ci]); bgRestoreColors.push(bec[ci]); }
    });
    if (bgRestoreTIs.length)
      Plotly.restyle(plotDiv, { 'line.color': bgRestoreColors }, bgRestoreTIs);

    // Restore background label traces
    if (showFloatLabels) {
      const bgLblTIs = [], bgLblColors = [];
      conns.forEach((conn, ci) => {
        if (bLblTI[ci] >= 0) { bgLblTIs.push(bLblTI[ci]); bgLblColors.push([_EDGE_BASE]); }
      });
      if (bgLblTIs.length)
        Plotly.restyle(plotDiv, { 'textfont.color': bgLblColors }, bgLblTIs);
    }

    // Hide all overlay line traces
    const allOvLTIs = oLTI.filter(i => i >= 0);
    if (allOvLTIs.length)
      Plotly.restyle(plotDiv, { 'opacity': allOvLTIs.map(() => 0) }, allOvLTIs);

    // Hide all overlay label traces and their halos
    if (showFloatLabels) {
      const allOvLblTIs = [], allOvHaloTIs = [];
      conns.forEach((conn, ci) => {
        if (oLblTI[ci] >= 0) { allOvLblTIs.push(oLblTI[ci]); allOvHaloTIs.push(oLblTI[ci] - 1); }
      });
      if (allOvLblTIs.length)
        Plotly.restyle(plotDiv, { 'opacity': allOvLblTIs.map(() => 0) }, allOvLblTIs);
      if (allOvHaloTIs.length)
        Plotly.restyle(plotDiv, { 'opacity': allOvHaloTIs.map(() => 0) }, allOvHaloTIs);
    }

    // Restore node trace
    Plotly.restyle(plotDiv, {
      'textfont.color': [fIds.map(() => _NODE_DEFAULT)],
      'marker.color': [bnc.slice()],
      'marker.line.color': [fIds.map(() => _NODE_DEFAULT)],
    }, [nti]);

    cy.elements().removeClass('highlighted highlighted-succ highlighted-pred faded');
  });
}

// Initial empty diagram
rebuildDiagram();
