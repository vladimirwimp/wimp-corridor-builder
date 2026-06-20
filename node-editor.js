/* ===== Constants ===== */

const WORLD_MIN = [-10, -10];
const WORLD_MAX = [10, 10];
const WORLD_CENTER = [0, 0];

const TYPE_COLORS = {
  junction:   '#6b7280',
  stop:       '#94a3b8',
  unit:       '#3b82f6',
  amenity:    '#06b6d4',
  elevator:   '#22c55e',
  stairs:     '#f97316',
  escalator:  '#84cc16',
  door:       '#eab308',
  entrance:   '#a855f7',
  checkpoint: '#ec4899',
};

const TYPE_RADIUS = {
  junction:   10,
  stop:       5,
  unit:       8,
  amenity:    8,
  elevator:   8,
  stairs:     8,
  escalator:  8,
  door:       6,
  entrance:   8,
  checkpoint: 6,
};

const TYPE_PROPS = {
  junction:   { connections: true },
  stop:       { connections: true },
  unit:       { name: true, connections: true },
  amenity:    { name: true, category: true, connections: true },
  elevator:   { connections: true, shaft: true },
  stairs:     { connections: true, shaft: true },
  escalator:  { connections: true, shaft: true },
  door:       { connections: true },
  entrance:   { connections: true, name: true },
  checkpoint: { connections: true, name: true },
};

const TYPE_ID_PREFIX = {
  junction:   'N-Ju-',
  stop:       'S-',
  unit:       'U-',
  amenity:    'A-',
  elevator:   'N-Ev-',
  stairs:     'N-St-',
  escalator:  'N-Es-',
  door:       'N-Do-',
  entrance:   'N-Ent-',
  checkpoint: 'N-Ch-',
};

const HALLWAY_DEFAULTS = {
  'hallway-v': { width: 0.5, height: 3 },
  'hallway-h': { width: 3, height: 0.5 },
};

const CROSS_FLOOR_TYPES = new Set(['elevator', 'stairs', 'escalator']);
const NEEDS_STOP = new Set(['unit', 'amenity', 'elevator', 'stairs', 'escalator']);

const NODE_TYPE_ORDER = ['junction', 'stop', 'unit', 'amenity', 'elevator', 'stairs', 'escalator', 'door', 'entrance', 'checkpoint'];

const MODE_HINTS = {
  add:     'Click the map to place a node of the selected type.',
  add_stop: 'Click a junction line (wires to both ends), a single junction node (wires to one), or the map for a freestanding stop.',
  connect: 'Click a connectable node, then click another to toggle their connection.',
  select:  'Click a node on the map or in the list to select and edit it.',
};

function getModeHint() {
  if (mode === 'add' && document.getElementById('nodeType')?.value === 'stop') return MODE_HINTS.add_stop;
  return MODE_HINTS[mode] || '';
}

/* ===== State ===== */

let floors = [{ number: 1, name: 'Ground Floor', nodes: [], hallways: [] }];
let activeFloorIndex = 0;
let selectedNodeId = null;
let mode = 'add';
let connectFromId = null;
let movingNodeId = null;
let pendingStopForNodeId = null;
let lastClickWasLine = false;
let hoveredLineNodeIds = [];

let pendingShape = null;
let movingHallwayId = null;
let selectedHallwayId = null;
let hallwayCounter = 0;

const usedIds = new Set();
const typeCounters = {};

/* ===== Accessors ===== */

function activeFloor() { return floors[activeFloorIndex]; }

function getFloorNode(id) {
  return activeFloor().nodes.find(n => n.id === id) || null;
}

function activeFloorHallways() {
  const f = activeFloor();
  if (!f.hallways) f.hallways = [];
  return f.hallways;
}

function getHallway(id) {
  return activeFloorHallways().find(h => h.id === id) || null;
}

function generateHallwayId(type) {
  const prefix = type === 'hallway-v' ? 'HV-' : 'HH-';
  do { hallwayCounter++; } while (usedIds.has(`${prefix}${hallwayCounter}`));
  return `${prefix}${hallwayCounter}`;
}

function hallwayPolygon(h) {
  const [cx, cy] = h.coordinates;
  const hw = h.width / 2, hh = h.height / 2;
  return [[cx - hw, cy + hh], [cx + hw, cy + hh], [cx + hw, cy - hh], [cx - hw, cy - hh], [cx - hw, cy + hh]];
}

function hallwayToFeature(h) {
  return {
    type: 'Feature',
    id: h.id,
    geometry: { type: 'Polygon', coordinates: [hallwayPolygon(h)] },
    properties: { id: h.id, label: h.label || '' },
  };
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function round4(v) { return parseFloat(v.toFixed(4)); }

function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return [ax, ay];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return [round4(ax + t * dx), round4(ay + t * dy)];
}

/* ===== ID generation ===== */

function generateId(type) {
  const floorNum = activeFloor().number;
  let candidate;
  do {
    typeCounters[type] = (typeCounters[type] || 0) + 1;
    const n = typeCounters[type];
    const prefix = TYPE_ID_PREFIX[type];
    candidate = CROSS_FLOOR_TYPES.has(type)
      ? `${prefix}${n}-f${floorNum}`
      : `${prefix}${n}`;
  } while (usedIds.has(candidate));
  return candidate;
}

function generateStopId(leafId) {
  const base = `S-${leafId}`;
  if (!usedIds.has(base)) return base;
  let n = 2;
  while (usedIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/* ===== Map setup ===== */

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f8f8f8' } }]
  },
  center: WORLD_CENTER,
  zoom: 0,
  renderWorldCopies: false,
  pitchWithRotate: false,
  dragRotate: false,
  attributionControl: false,
});

map.on('load', () => {
  map.fitBounds([WORLD_MIN, WORLD_MAX], { padding: 20, linear: true, maxZoom: 6 });
  map.setMaxBounds([
    [WORLD_MIN[0] - 0.5, WORLD_MIN[1] - 0.5],
    [WORLD_MAX[0] + 0.5, WORLD_MAX[1] + 0.5],
  ]);

  // Grid
  const gridFC = { type: 'FeatureCollection', features: [] };
  for (let x = WORLD_MIN[0]; x <= WORLD_MAX[0]; x++) {
    gridFC.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[x, WORLD_MIN[1]], [x, WORLD_MAX[1]]] } });
  }
  for (let y = WORLD_MIN[1]; y <= WORLD_MAX[1]; y++) {
    gridFC.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[WORLD_MIN[0], y], [WORLD_MAX[0], y]] } });
  }
  map.addSource('grid', { type: 'geojson', data: gridFC });
  map.addLayer({ id: 'grid-lines', type: 'line', source: 'grid', paint: { 'line-color': '#e0e0e0', 'line-width': 1 } });

  // Hallways (rendered below connection lines and nodes)
  map.addSource('hallways', { type: 'geojson', data: emptyFC(), promoteId: 'id' });
  map.addLayer({
    id: 'hallways-fill',
    type: 'fill',
    source: 'hallways',
    paint: {
      'fill-color': '#818cf8',
      'fill-opacity': ['case', ['boolean', ['feature-state', 'selected'], false], 0.35, 0.15],
    },
  });
  map.addLayer({
    id: 'hallways-stroke',
    type: 'line',
    source: 'hallways',
    paint: {
      'line-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#4f46e5', '#818cf8'],
      'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 2, 1.5],
    },
  });
  map.addLayer({
    id: 'hallways-label',
    type: 'symbol',
    source: 'hallways',
    filter: ['!=', ['get', 'label'], ''],
    layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-anchor': 'center' },
    paint: { 'text-color': '#4f46e5', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
  });

  // Connection lines
  map.addSource('connections', { type: 'geojson', data: emptyFC() });
  map.addLayer({
    id: 'connection-lines',
    type: 'line',
    source: 'connections',
    paint: { 'line-color': '#9ca3af', 'line-width': 1.5, 'line-dasharray': [3, 2] },
  });

  // Wider invisible layer on the same source for easier click/hover targeting
  map.addLayer({
    id: 'connection-lines-hit',
    type: 'line',
    source: 'connections',
    paint: { 'line-width': 10, 'line-opacity': 0 },
  });

  // Nodes
  map.addSource('nodes', { type: 'geojson', data: emptyFC(), promoteId: 'id' });

  // Selection ring
  map.addLayer({
    id: 'nodes-ring',
    type: 'circle',
    source: 'nodes',
    layout: { 'circle-sort-key': ['get', 'sortKey'] },
    paint: {
      'circle-radius': ['+', ['coalesce', ['get', 'radius'], 7], 5],
      'circle-color': [
        'case',
        ['boolean', ['feature-state', 'connectFrom'], false], '#fbbf24',
        ['boolean', ['feature-state', 'lineHover'], false],   '#22c55e',
        ['boolean', ['feature-state', 'connHighlight'], false], '#60a5fa',
        '#2563eb',
      ],
      'circle-opacity': [
        'case',
        ['boolean', ['feature-state', 'selected'], false],      0.45,
        ['boolean', ['feature-state', 'connectFrom'], false],   0.45,
        ['boolean', ['feature-state', 'lineHover'], false],     0.55,
        ['boolean', ['feature-state', 'connHighlight'], false], 0.35,
        0,
      ],
    },
  });

  // Node circles
  map.addLayer({
    id: 'nodes-circle',
    type: 'circle',
    source: 'nodes',
    layout: { 'circle-sort-key': ['get', 'sortKey'] },
    paint: {
      'circle-radius': ['coalesce', ['get', 'radius'], 7],
      'circle-color': ['coalesce', ['get', 'color'], '#111'],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#fff',
    },
  });

  // Labels (name or id; suppressed for junction and stop)
  map.addLayer({
    id: 'nodes-label',
    type: 'symbol',
    source: 'nodes',
    filter: ['!=', ['get', 'label'], ''],
    layout: {
      'symbol-sort-key': ['get', 'sortKey'],
      'text-field': ['get', 'label'],
      'text-size': 11,
      'text-offset': [0, 1.6],
      'text-anchor': 'top',
    },
    paint: {
      'text-color': '#111',
      'text-halo-color': '#fff',
      'text-halo-width': 1.5,
    },
  });

  map.on('click', 'hallways-fill', onClickHallway);
  map.on('mousemove', 'hallways-fill', () => { if (!pendingShape && !movingHallwayId && !movingNodeId && !pendingStopForNodeId) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'hallways-fill', () => { if (!pendingShape && !movingHallwayId && !movingNodeId && !pendingStopForNodeId) map.getCanvas().style.cursor = ''; });

  map.on('click', 'nodes-circle', onClickNode);
  map.on('click', 'connection-lines-hit', onClickConnectionLine);
  map.on('click', onClickMap);
  map.on('mousemove', 'connection-lines-hit', onHoverConnectionLine);
  map.on('mouseleave', 'connection-lines-hit', onLeaveConnectionLine);
  map.on('mousemove', 'nodes-circle', () => { if (!movingNodeId && !pendingStopForNodeId) map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'nodes-circle', () => { if (!movingNodeId && !pendingStopForNodeId) map.getCanvas().style.cursor = ''; else if (pendingStopForNodeId) map.getCanvas().style.cursor = 'crosshair'; });

  refreshMap();
  renderFloorTabs();
  renderFloorEdit();
  renderNodeList();
  renderPropsPanel();
  setMode('add');
});

function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

/* ===== Map refresh ===== */

function refreshMap() {
  if (!map.getSource('nodes')) return;

  const floor = activeFloor();
  const nodeMap = new Map(floor.nodes.map(n => [n.id, n]));

  const nodeFeatures = floor.nodes.map(n => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: n.coordinates },
    properties: {
      id: n.id,
      color: TYPE_COLORS[n.type] || '#111',
      radius: TYPE_RADIUS[n.type] || 7,
      label: n.name || (['junction', 'stop'].includes(n.type) ? '' : n.id),
      sortKey: n.type === 'junction' ? 0 : 1,
    },
  }));

  const lineFeatures = [];
  const seen = new Set();
  for (const node of floor.nodes) {
    if (!node.connections) continue;
    for (const cid of node.connections) {
      const key = [node.id, cid].sort().join('||');
      if (seen.has(key)) continue;
      seen.add(key);
      const other = nodeMap.get(cid);
      if (!other) continue;
      // Hide stop-to-junction lines — stop position near the corridor is self-documenting.
      // Only draw stop-to-leaf stubs (stop↔unit/amenity/elevator/stairs/escalator).
      const oneIsStop = node.type === 'stop' || other.type === 'stop';
      const otherIsLeaf = NEEDS_STOP.has(node.type) || NEEDS_STOP.has(other.type);
      if (oneIsStop && !otherIsLeaf) continue;
      lineFeatures.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [node.coordinates, other.coordinates] },
        properties: { fromId: node.id, toId: other.id },
      });
    }
  }

  map.getSource('nodes').setData({ type: 'FeatureCollection', features: nodeFeatures });
  map.getSource('connections').setData({ type: 'FeatureCollection', features: lineFeatures });

  updateFeatureStates();
  refreshHallways();
  renderNodeList();
  updateNodeCount();
}

function updateFeatureStates() {
  if (!map.getSource('nodes')) return;
  const selectedNode = selectedNodeId ? getFloorNode(selectedNodeId) : null;
  const connectedIds = new Set(selectedNode?.connections || []);
  for (const node of activeFloor().nodes) {
    map.setFeatureState({ source: 'nodes', id: node.id }, {
      selected:      node.id === selectedNodeId,
      connectFrom:   node.id === connectFromId,
      connHighlight: connectedIds.has(node.id),
    });
  }
}

function refreshHallways() {
  if (!map.getSource('hallways')) return;
  const features = activeFloorHallways().map(hallwayToFeature);
  map.getSource('hallways').setData({ type: 'FeatureCollection', features });
  updateHallwayStates();
}

function updateHallwayStates() {
  if (!map.getSource('hallways')) return;
  for (const h of activeFloorHallways()) {
    map.setFeatureState({ source: 'hallways', id: h.id }, { selected: h.id === selectedHallwayId });
  }
}

/* ===== Click handlers ===== */

let lastClickWasNode = false;

function onClickHallway(e) {
  if (pendingShape || movingHallwayId || movingNodeId || pendingStopForNodeId) return;
  lastClickWasNode = true;
  const id = e.features[0]?.properties?.id;
  if (!id) return;
  selectedHallwayId = id;
  selectedNodeId = null;
  updateFeatureStates();
  updateHallwayStates();
  renderPropsPanel();
  renderNodeList();
}

function onClickNode(e) {
  lastClickWasNode = true;
  const id = e.features[0]?.properties?.id;
  if (!id) return;

  if (pendingStopForNodeId) {
    const clicked = getFloorNode(id);
    if (clicked?.type === 'stop') {
      linkStopToLeaf(id, pendingStopForNodeId);
    } else if (clicked && TYPE_PROPS[clicked.type]?.connections && !NEEDS_STOP.has(clicked.type)) {
      placeStopOnJunction(clicked.coordinates[0], clicked.coordinates[1], id, pendingStopForNodeId);
    } else {
      cancelStopPlacement();
      showToast('Stop node creation cancelled.');
      handleNodeInteraction(id);
    }
    return;
  }

  if (mode === 'add' && document.getElementById('nodeType')?.value === 'stop') {
    const clicked = getFloorNode(id);
    if (clicked && TYPE_PROPS[clicked.type]?.connections && !NEEDS_STOP.has(clicked.type)) {
      placeStandaloneStopOnJunction(id);
      return;
    }
  }

  handleNodeInteraction(id);
}

function isStopEligibleLine(fromId, toId) {
  const a = getFloorNode(fromId), b = getFloorNode(toId);
  return a && b
    && TYPE_PROPS[a.type]?.connections && !NEEDS_STOP.has(a.type)
    && TYPE_PROPS[b.type]?.connections && !NEEDS_STOP.has(b.type);
}

function clearLineHover() {
  for (const id of hoveredLineNodeIds) {
    if (map.getSource('nodes')) {
      map.setFeatureState({ source: 'nodes', id }, { lineHover: false });
    }
  }
  hoveredLineNodeIds = [];
}

function onHoverConnectionLine(e) {
  const isStopMode = pendingStopForNodeId
    || (mode === 'add' && document.getElementById('nodeType')?.value === 'stop');
  if (!isStopMode) { clearLineHover(); return; }

  const fromId = e.features[0]?.properties?.fromId;
  const toId   = e.features[0]?.properties?.toId;
  if (!isStopEligibleLine(fromId, toId)) { clearLineHover(); return; }

  // Only update if the hovered line changed
  const newKey = [fromId, toId].sort().join('||');
  const curKey = [...hoveredLineNodeIds].sort().join('||');
  if (newKey === curKey) return;

  clearLineHover();
  hoveredLineNodeIds = [fromId, toId];
  for (const id of hoveredLineNodeIds) {
    map.setFeatureState({ source: 'nodes', id }, { lineHover: true });
  }
}

function onLeaveConnectionLine() {
  clearLineHover();
}

function onClickConnectionLine(e) {
  lastClickWasLine = true;

  const fromId   = e.features[0]?.properties?.fromId;
  const toId     = e.features[0]?.properties?.toId;
  if (!fromId || !toId) return;

  const eligible = isStopEligibleLine(fromId, toId);
  const rx = round4(clamp(e.lngLat.lng, WORLD_MIN[0], WORLD_MAX[0]));
  const ry = round4(clamp(e.lngLat.lat, WORLD_MIN[1], WORLD_MAX[1]));

  if (pendingStopForNodeId) {
    if (eligible) placeStopOnLine(rx, ry, pendingStopForNodeId, fromId, toId);
    else          placeStopNode(rx, ry, pendingStopForNodeId);
    return;
  }

  if (mode === 'add' && document.getElementById('nodeType')?.value === 'stop' && eligible) {
    placeStandaloneStopOnLine(rx, ry, fromId, toId);
  }
}

function placeStandaloneStopOnLine(x, y, fromId, toId) {
  const floor  = activeFloor();
  const stopId = generateId('stop');
  const fn = getFloorNode(fromId), tn = getFloorNode(toId);
  if (fn && tn) [x, y] = closestPointOnSegment(x, y, ...fn.coordinates, ...tn.coordinates);
  const stopNode = { id: stopId, type: 'stop', coordinates: [x, y], connections: [fromId, toId] };
  floor.nodes.push(stopNode);
  usedIds.add(stopId);

  const fromNode = getFloorNode(fromId);
  const toNode   = getFloorNode(toId);
  if (fromNode?.connections && !fromNode.connections.includes(stopId)) fromNode.connections.push(stopId);
  if (toNode?.connections   && !toNode.connections.includes(stopId))   toNode.connections.push(stopId);

  selectedNodeId = stopId;
  refreshMap();
  renderPropsPanel();
  showToast('Stop node placed. Connect units or amenities to it in Connect mode.');
}

function placeStopOnLine(x, y, leafId, fromId, toId) {
  const floor  = activeFloor();
  const stopId = generateStopId(leafId);
  const fn = getFloorNode(fromId), tn = getFloorNode(toId);
  if (fn && tn) [x, y] = closestPointOnSegment(x, y, ...fn.coordinates, ...tn.coordinates);
  const stopNode = { id: stopId, type: 'stop', coordinates: [x, y], connections: [leafId, fromId, toId] };
  floor.nodes.push(stopNode);
  usedIds.add(stopId);

  const leaf = getFloorNode(leafId);
  if (leaf?.connections) leaf.connections.push(stopId);

  const fromNode = getFloorNode(fromId);
  const toNode   = getFloorNode(toId);
  if (fromNode?.connections && !fromNode.connections.includes(stopId)) fromNode.connections.push(stopId);
  if (toNode?.connections   && !toNode.connections.includes(stopId))   toNode.connections.push(stopId);

  cancelStopPlacement();
  selectedNodeId = stopId;
  refreshMap();
  renderPropsPanel();
  showToast('Stop node placed and wired to both junctions.');
}

function placeStopOnJunction(x, y, junctionId, leafId) {
  const floor = activeFloor();
  const stopId = generateStopId(leafId);
  const stopNode = { id: stopId, type: 'stop', coordinates: [x, y], connections: [leafId, junctionId] };
  floor.nodes.push(stopNode);
  usedIds.add(stopId);

  const leaf = getFloorNode(leafId);
  if (leaf?.connections) leaf.connections.push(stopId);
  const jn = getFloorNode(junctionId);
  if (jn?.connections && !jn.connections.includes(stopId)) jn.connections.push(stopId);

  cancelStopPlacement();
  selectedNodeId = stopId;
  refreshMap();
  renderPropsPanel();
  showToast('Stop placed and wired to one junction. Move it if needed.');
}

function placeStandaloneStopOnJunction(junctionId) {
  const floor = activeFloor();
  const stopId = generateId('stop');
  const jn = getFloorNode(junctionId);
  const [x, y] = jn.coordinates;
  const stopNode = { id: stopId, type: 'stop', coordinates: [x, y], connections: [junctionId] };
  floor.nodes.push(stopNode);
  usedIds.add(stopId);

  if (jn?.connections && !jn.connections.includes(stopId)) jn.connections.push(stopId);

  selectedNodeId = stopId;
  refreshMap();
  renderPropsPanel();
  showToast('Stop placed at junction. Connect units or amenities to it in Connect mode.');
}

function onClickMap(e) {
  if (lastClickWasNode) { lastClickWasNode = false; return; }
  if (lastClickWasLine) { lastClickWasLine = false; return; }

  const x = round4(clamp(e.lngLat.lng, WORLD_MIN[0], WORLD_MAX[0]));
  const y = round4(clamp(e.lngLat.lat, WORLD_MIN[1], WORLD_MAX[1]));

  if (pendingStopForNodeId) {
    placeStopNode(x, y, pendingStopForNodeId);
    return;
  }

  if (pendingShape) {
    placeHallway(x, y);
    return;
  }

  if (movingHallwayId) {
    const h = getHallway(movingHallwayId);
    if (h) {
      h.coordinates = [x, y];
      movingHallwayId = null;
      map.getCanvas().style.cursor = '';
      document.getElementById('btn-move-hallway')?.classList.remove('active');
      refreshHallways();
      renderHallwayPanel();
    }
    return;
  }

  if (movingNodeId) {
    const node = getFloorNode(movingNodeId);
    if (node) {
      node.coordinates = [x, y];
      movingNodeId = null;
      map.getCanvas().style.cursor = '';
      document.getElementById('btn-move-node')?.classList.remove('active');
      refreshMap();
      renderPropsPanel();
    }
    return;
  }

  if (mode === 'add') {
    addNode(x, y);
  } else if (mode === 'connect') {
    connectFromId = null;
    updateFeatureStates();
  } else {
    selectedNodeId = null;
    selectedHallwayId = null;
    updateFeatureStates();
    updateHallwayStates();
    renderPropsPanel();
    renderNodeList();
  }
}

function handleNodeInteraction(id) {
  if (movingNodeId && id !== movingNodeId) {
    movingNodeId = null;
    map.getCanvas().style.cursor = '';
    document.getElementById('btn-move-node')?.classList.remove('active');
  }

  if (mode === 'connect') {
    handleConnectClick(id);
    return;
  }

  selectedNodeId = id;
  connectFromId = null;
  updateFeatureStates();
  renderPropsPanel();
  renderNodeList();
}

function handleConnectClick(id) {
  const node = getFloorNode(id);
  if (!node) return;

  if (!TYPE_PROPS[node.type]?.connections) {
    showToast(`${node.type} nodes cannot have manual connections.`);
    return;
  }

  if (!connectFromId) {
    connectFromId = id;
    updateFeatureStates();
    return;
  }

  if (connectFromId === id) {
    connectFromId = null;
    updateFeatureStates();
    return;
  }

  const fromNode = getFloorNode(connectFromId);
  if (!fromNode || !TYPE_PROPS[fromNode.type]?.connections) {
    connectFromId = id;
    updateFeatureStates();
    return;
  }

  // Leaf nodes (unit/amenity/cross-floor) may only connect to stop nodes
  const oneIsLeaf = NEEDS_STOP.has(fromNode.type) || NEEDS_STOP.has(node.type);
  const oneIsStop = fromNode.type === 'stop' || node.type === 'stop';
  if (oneIsLeaf && !oneIsStop) {
    showToast('Leaf nodes can only connect to stop nodes — place a stop node first.');
    connectFromId = null;
    updateFeatureStates();
    return;
  }

  toggleConnection(connectFromId, id);
  connectFromId = null;
  refreshMap();
}

/* ===== Stop node placement ===== */

function enterStopPlacementMode(leafId) {
  pendingStopForNodeId = leafId;
  map.getCanvas().style.cursor = 'crosshair';
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = `Place stop for ${leafId} — click a junction line (wires to both ends), a single junction node (wires to one), an existing stop to reuse it, or press Escape to skip.`;
}

function cancelStopPlacement() {
  pendingStopForNodeId = null;
  map.getCanvas().style.cursor = '';
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = getModeHint();
}

function placeStopNode(x, y, leafId) {
  const floor = activeFloor();
  const stopId = generateStopId(leafId);
  const stopNode = { id: stopId, type: 'stop', coordinates: [x, y], connections: [leafId] };
  floor.nodes.push(stopNode);
  usedIds.add(stopId);

  const leaf = getFloorNode(leafId);
  if (leaf?.connections) leaf.connections.push(stopId);

  cancelStopPlacement();
  selectedNodeId = stopId;
  refreshMap();
  renderPropsPanel();
  showToast('Stop node placed. Connect it to the corridor in Connect mode.');
}

/* ===== Hallway operations ===== */

function enterShapePlacement(shapeType) {
  if (pendingStopForNodeId) cancelStopPlacement();
  if (movingNodeId) { movingNodeId = null; map.getCanvas().style.cursor = ''; }
  pendingShape = shapeType;
  map.getCanvas().style.cursor = 'crosshair';
  const name = shapeType === 'hallway-v' ? 'vertical hallway' : 'horizontal hallway';
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = `Click on the map to place a ${name}. Press Escape to cancel.`;
}

function cancelShapePlacement() {
  pendingShape = null;
  map.getCanvas().style.cursor = '';
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = getModeHint();
}

function placeHallway(x, y) {
  const type = pendingShape;
  const id = generateHallwayId(type);
  const def = HALLWAY_DEFAULTS[type];
  const h = { id, type, coordinates: [x, y], width: def.width, height: def.height, label: '' };
  activeFloorHallways().push(h);
  usedIds.add(id);
  selectedHallwayId = id;
  selectedNodeId = null;
  cancelShapePlacement();
  refreshHallways();
  renderPropsPanel();
  showToast(`${type === 'hallway-v' ? 'Vertical' : 'Horizontal'} hallway placed.`);
}

function deleteHallway(id) {
  const hallways = activeFloorHallways();
  const idx = hallways.findIndex(h => h.id === id);
  if (idx === -1) return;
  hallways.splice(idx, 1);
  usedIds.delete(id);
  if (selectedHallwayId === id) selectedHallwayId = null;
  if (movingHallwayId === id) { movingHallwayId = null; map.getCanvas().style.cursor = ''; }
  refreshHallways();
  renderPropsPanel();
}

function beginMoveHallway(id) {
  movingHallwayId = id;
  map.getCanvas().style.cursor = 'crosshair';
  document.getElementById('btn-move-hallway')?.classList.add('active');
  showToast('Click on the map to move the hallway.');
}

function renderHallwayPanel() {
  const panel = document.getElementById('propsPanel');
  if (!panel) return;
  const h = getHallway(selectedHallwayId);
  if (!h) { panel.innerHTML = '<p class="empty-msg">Hallway not found.</p>'; return; }
  const typeName = h.type === 'hallway-v' ? 'Vertical Hallway' : 'Horizontal Hallway';
  panel.innerHTML = `
    <div class="prop-header">
      <span class="type-badge" style="background:#818cf8">${typeName}</span>
    </div>
    <div class="prop-row">
      <label>ID</label>
      <input type="text" id="hall-prop-id" value="${esc(h.id)}" />
    </div>
    <div class="prop-row">
      <label>Label</label>
      <input type="text" id="hall-prop-label" value="${esc(h.label || '')}" placeholder="e.g. Main Corridor" />
    </div>
    <div class="prop-row">
      <label>Width</label>
      <input type="number" id="hall-prop-width" value="${h.width}" step="0.1" min="0.1" />
    </div>
    <div class="prop-row">
      <label>Height</label>
      <input type="number" id="hall-prop-height" value="${h.height}" step="0.1" min="0.1" />
    </div>
    <div class="prop-row">
      <label>Coords</label>
      <span class="coord-val">[${h.coordinates[0]}, ${h.coordinates[1]}]</span>
      <button class="btn-move btn-sm" id="btn-move-hallway">Move</button>
    </div>
    <div class="prop-actions">
      <button class="btn btn-sm" id="btn-save-hallway">Save</button>
      <button class="btn btn-sm btn-danger" id="btn-delete-hallway">Delete</button>
    </div>
  `;
  document.getElementById('btn-save-hallway')?.addEventListener('click', saveHallwayProps);
  document.getElementById('btn-delete-hallway')?.addEventListener('click', () => deleteHallway(selectedHallwayId));
  document.getElementById('btn-move-hallway')?.addEventListener('click', () => {
    if (movingHallwayId === selectedHallwayId) {
      movingHallwayId = null;
      map.getCanvas().style.cursor = '';
      document.getElementById('btn-move-hallway')?.classList.remove('active');
    } else {
      beginMoveHallway(selectedHallwayId);
    }
  });
  if (movingHallwayId === selectedHallwayId) {
    document.getElementById('btn-move-hallway')?.classList.add('active');
  }
}

function saveHallwayProps() {
  const h = getHallway(selectedHallwayId);
  if (!h) return;

  const newId = (document.getElementById('hall-prop-id')?.value || '').trim();
  if (!newId) { showToast('ID cannot be empty.'); return; }
  if (newId !== h.id) {
    if (usedIds.has(newId)) { showToast(`ID "${newId}" is already in use.`); return; }
    usedIds.delete(h.id);
    usedIds.add(newId);
    selectedHallwayId = newId;
    h.id = newId;
  }

  h.label  = (document.getElementById('hall-prop-label')?.value  || '').trim();
  h.width  = parseFloat(document.getElementById('hall-prop-width')?.value)  || h.width;
  h.height = parseFloat(document.getElementById('hall-prop-height')?.value) || h.height;

  refreshHallways();
  renderHallwayPanel();
  showToast('Saved.');
}

function linkStopToLeaf(stopId, leafId) {
  const stop = getFloorNode(stopId);
  const leaf = getFloorNode(leafId);
  if (!stop || !leaf) return;

  if (!stop.connections.includes(leafId)) stop.connections.push(leafId);
  if (leaf.connections && !leaf.connections.includes(stopId)) leaf.connections.push(stopId);

  cancelStopPlacement();
  selectedNodeId = stopId;
  refreshMap();
  renderPropsPanel();
  showToast(`Linked to existing stop node ${stopId}.`);
}

/* ===== Node operations ===== */

function addNode(x, y) {
  const type = document.getElementById('nodeType').value;
  const floor = activeFloor();
  const id = generateId(type);

  const node = { id, type, coordinates: [x, y] };

  if (TYPE_PROPS[type]?.connections) node.connections = [];
  if (TYPE_PROPS[type]?.name)        node.name = '';
  if (TYPE_PROPS[type]?.category)    node.category = '';
  if (CROSS_FLOOR_TYPES.has(type))   node.shaft = id.replace(/-f[^-]+$/, '');

  floor.nodes.push(node);
  usedIds.add(id);

  selectedNodeId = id;
  refreshMap();
  renderPropsPanel();

  if (NEEDS_STOP.has(type)) {
    enterStopPlacementMode(id);
  }
}

function deleteNode(id) {
  const floor = activeFloor();
  const idx = floor.nodes.findIndex(n => n.id === id);
  if (idx === -1) return;

  floor.nodes.splice(idx, 1);
  usedIds.delete(id);

  for (const node of floor.nodes) {
    if (node.connections) {
      node.connections = node.connections.filter(c => c !== id);
    }
  }

  if (selectedNodeId === id) selectedNodeId = null;
  if (connectFromId === id) connectFromId = null;
  if (movingNodeId === id) { movingNodeId = null; map.getCanvas().style.cursor = ''; }
  if (pendingStopForNodeId === id) cancelStopPlacement();

  refreshMap();
  renderPropsPanel();
}

function toggleConnection(idA, idB) {
  const nodeA = getFloorNode(idA);
  const nodeB = getFloorNode(idB);
  if (!nodeA?.connections || !nodeB?.connections) return;

  if (nodeA.connections.includes(idB)) {
    nodeA.connections = nodeA.connections.filter(c => c !== idB);
    nodeB.connections = nodeB.connections.filter(c => c !== idA);
    showToast('Connection removed.');
  } else {
    nodeA.connections.push(idB);
    nodeB.connections.push(idA);
    showToast('Connection added.');
  }
}

function removeConnection(nodeId, targetId) {
  const nodeA = getFloorNode(nodeId);
  const nodeB = getFloorNode(targetId);
  if (nodeA?.connections) nodeA.connections = nodeA.connections.filter(c => c !== targetId);
  if (nodeB?.connections) nodeB.connections = nodeB.connections.filter(c => c !== nodeId);
  refreshMap();
  renderPropsPanel();
}

function beginMove(id) {
  movingNodeId = id;
  map.getCanvas().style.cursor = 'crosshair';
  document.getElementById('btn-move-node')?.classList.add('active');
  showToast('Click on the map to set the new position.');
}

/* ===== Properties panel ===== */

function renderPropsPanel() {
  if (selectedHallwayId && !selectedNodeId) { renderHallwayPanel(); return; }

  const panel = document.getElementById('propsPanel');
  if (!panel) return;

  if (!selectedNodeId) {
    panel.innerHTML = '<p class="empty-msg">Select a node to edit.</p>';
    return;
  }

  const node = getFloorNode(selectedNodeId);
  if (!node) {
    panel.innerHTML = '<p class="empty-msg">Node not found on this floor.</p>';
    return;
  }

  const props = TYPE_PROPS[node.type] || {};
  const color = TYPE_COLORS[node.type] || '#111';

  let html = `
    <div class="prop-header">
      <span class="type-badge" style="background:${color}">${node.type}</span>
    </div>
    <div class="prop-row">
      <label>ID</label>
      <input type="text" id="prop-id" value="${esc(node.id)}" />
    </div>
    <div class="prop-row">
      <label>Coords</label>
      <span class="coord-val">[${node.coordinates[0]}, ${node.coordinates[1]}]</span>
      <button class="btn-move btn-sm" id="btn-move-node">Move</button>
    </div>
  `;

  if (props.name !== undefined) {
    html += `
      <div class="prop-row">
        <label>Name</label>
        <input type="text" id="prop-name" value="${esc(node.name || '')}" placeholder="e.g. 205" />
      </div>
    `;
  }

  if (props.category !== undefined) {
    html += `
      <div class="prop-row">
        <label>Category</label>
        <input type="text" id="prop-category" value="${esc(node.category || '')}" placeholder="e.g. restaurant" />
      </div>
    `;
  }

  if (props.shaft) {
    html += `
      <div class="prop-row">
        <label>Shaft ID</label>
        <input type="text" id="prop-shaft" value="${esc(node.shaft || '')}" placeholder="e.g. N-Ev-1" />
      </div>
    `;
  }

  if (props.connections) {
    const connNodes = (node.connections || []).map(cid => getFloorNode(cid)).filter(Boolean);
    html += `
      <div class="prop-row"><label>Connections (${connNodes.length})</label></div>
      <ul class="conn-list">
    `;
    if (!connNodes.length) {
      html += `<li class="conn-empty">None — use Connect mode to add.</li>`;
    }
    for (const cn of connNodes) {
      html += `
        <li class="conn-item">
          <span class="conn-dot" style="background:${TYPE_COLORS[cn.type] || '#111'}"></span>
          <span class="conn-id">${esc(cn.id)}</span>
          <button class="btn-rm-conn" data-target="${esc(cn.id)}">✕</button>
        </li>
      `;
    }
    html += `</ul>`;
  }

  const infoRaw = node.info ? JSON.stringify(node.info, null, 2) : '';
  const infoHtml = infoRaw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  html += `
    <div class="prop-row prop-row-info">
      <label>Info (JSON)</label>
      <textarea id="prop-info" rows="3" placeholder='{"workingHours":[],"description":""}'>${infoHtml}</textarea>
    </div>
    <div class="prop-actions">
      <button class="btn btn-sm" id="btn-save-props">Save</button>
      <button class="btn btn-sm btn-danger" id="btn-delete-node">Delete</button>
    </div>
  `;

  panel.innerHTML = html;

  document.getElementById('btn-save-props')?.addEventListener('click', saveProps);
  document.getElementById('btn-delete-node')?.addEventListener('click', () => deleteNode(selectedNodeId));
  document.getElementById('btn-move-node')?.addEventListener('click', () => {
    if (movingNodeId === selectedNodeId) {
      movingNodeId = null;
      map.getCanvas().style.cursor = '';
      document.getElementById('btn-move-node')?.classList.remove('active');
    } else {
      beginMove(selectedNodeId);
    }
  });
  if (movingNodeId === selectedNodeId) {
    document.getElementById('btn-move-node')?.classList.add('active');
  }

  panel.querySelectorAll('.btn-rm-conn').forEach(btn => {
    btn.addEventListener('click', () => removeConnection(selectedNodeId, btn.dataset.target));
  });
}

function saveProps() {
  const node = getFloorNode(selectedNodeId);
  if (!node) return;
  const props = TYPE_PROPS[node.type] || {};

  const newId = (document.getElementById('prop-id')?.value || '').trim();
  if (!newId) { showToast('ID cannot be empty.'); return; }

  if (newId !== node.id) {
    if (usedIds.has(newId)) { showToast(`ID "${newId}" is already in use.`); return; }
    for (const floor of floors) {
      for (const n of floor.nodes) {
        if (n.connections) n.connections = n.connections.map(c => c === node.id ? newId : c);
      }
    }
    usedIds.delete(node.id);
    usedIds.add(newId);
    selectedNodeId = newId;
    node.id = newId;
  }

  if (props.name !== undefined) {
    node.name = (document.getElementById('prop-name')?.value || '').trim();
  }

  if (props.category !== undefined) {
    node.category = (document.getElementById('prop-category')?.value || '').trim();
  }

  if (props.shaft) {
    node.shaft = (document.getElementById('prop-shaft')?.value || '').trim();
  }

  const infoText = (document.getElementById('prop-info')?.value || '').trim();
  if (infoText) {
    try {
      node.info = JSON.parse(infoText);
    } catch {
      showToast('Info is not valid JSON — not saved.');
      return;
    }
  } else {
    delete node.info;
  }

  refreshMap();
  renderPropsPanel();
  showToast('Saved.');
}

/* ===== Floor management ===== */

function renderFloorTabs() {
  const container = document.getElementById('floorTabs');
  if (!container) return;
  container.innerHTML = '';

  floors.forEach((floor, i) => {
    const tab = document.createElement('div');
    tab.className = 'floor-tab' + (i === activeFloorIndex ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'floor-tab-label';
    label.textContent = floor.name || `Floor ${floor.number}`;
    label.addEventListener('click', () => switchFloor(i));
    tab.appendChild(label);

    if (floors.length > 1) {
      const del = document.createElement('button');
      del.className = 'floor-tab-del';
      del.textContent = '✕';
      del.title = 'Remove floor';
      del.addEventListener('click', (e) => { e.stopPropagation(); removeFloor(i); });
      tab.appendChild(del);
    }

    container.appendChild(tab);
  });
}

function renderFloorEdit() {
  const floor = activeFloor();
  const nameEl = document.getElementById('floorEditName');
  const numEl  = document.getElementById('floorEditNumber');
  if (nameEl) nameEl.value = floor.name || '';
  if (numEl)  numEl.value  = floor.number ?? '';
}

function switchFloor(idx) {
  if (idx < 0 || idx >= floors.length) return;
  selectedNodeId = null;
  selectedHallwayId = null;
  connectFromId = null;
  if (movingNodeId) { movingNodeId = null; map.getCanvas().style.cursor = ''; }
  if (movingHallwayId) { movingHallwayId = null; map.getCanvas().style.cursor = ''; }
  if (pendingStopForNodeId) cancelStopPlacement();
  if (pendingShape) cancelShapePlacement();
  clearLineHover();
  activeFloorIndex = idx;
  renderFloorTabs();
  renderFloorEdit();
  refreshMap();
  renderPropsPanel();
}

function addFloor() {
  const maxNum = Math.max(...floors.map(f => typeof f.number === 'number' ? f.number : 0), 0);
  const num = maxNum + 1;
  floors.push({ number: num, name: `Floor ${num}`, nodes: [], hallways: [] });
  switchFloor(floors.length - 1);
  renderFloorTabs();
}

function removeFloor(idx) {
  if (floors.length <= 1) { showToast('Cannot remove the last floor.'); return; }
  if (!confirm(`Remove "${floors[idx].name}"? All nodes on this floor will be deleted.`)) return;
  for (const node of floors[idx].nodes) usedIds.delete(node.id);
  floors.splice(idx, 1);
  if (activeFloorIndex >= floors.length) activeFloorIndex = floors.length - 1;
  renderFloorTabs();
  renderFloorEdit();
  refreshMap();
  renderPropsPanel();
}

function duplicateFloor() {
  const src = activeFloor();
  const maxNum = Math.max(...floors.map(f => typeof f.number === 'number' ? f.number : 0), 0);
  const newNum = maxNum + 1;
  const newFloor = { number: newNum, name: `Floor ${newNum}`, nodes: [] };

  const COPY_TYPES = new Set(['junction', 'unit', 'amenity', 'stop', 'elevator', 'stairs', 'escalator']);
  const idMap = new Map();

  // Pass A: assign IDs for all non-stop nodes
  for (const node of src.nodes) {
    if (!COPY_TYPES.has(node.type) || node.type === 'stop') continue;

    let newId;
    if (CROSS_FLOOR_TYPES.has(node.type)) {
      newId = node.id.replace(/-f[^-]+$/, `-f${newNum}`);
      if (usedIds.has(newId)) {
        showToast(`Cannot duplicate: ID "${newId}" already exists.`);
        return;
      }
    } else {
      const prefix = TYPE_ID_PREFIX[node.type];
      do {
        typeCounters[node.type] = (typeCounters[node.type] || 0) + 1;
        newId = `${prefix}${typeCounters[node.type]}`;
      } while (usedIds.has(newId));
    }

    idMap.set(node.id, newId);
  }

  // Pass B: assign IDs for stop nodes, derived from their leaf's new ID
  for (const node of src.nodes) {
    if (node.type !== 'stop') continue;
    const leafId = node.id.startsWith('S-') ? node.id.slice(2) : null;
    const newLeafId = leafId ? idMap.get(leafId) : null;
    if (!newLeafId) continue;
    const newId = `S-${newLeafId}`;
    if (usedIds.has(newId)) {
      showToast(`Cannot duplicate: stop node ID "${newId}" already exists.`);
      return;
    }
    idMap.set(node.id, newId);
  }

  // Pass C: build new nodes, remapping connections
  for (const node of src.nodes) {
    if (!COPY_TYPES.has(node.type)) continue;
    const newId = idMap.get(node.id);
    if (!newId) continue;

    const newNode = { id: newId, type: node.type, coordinates: [...node.coordinates] };
    if (node.name !== undefined) newNode.name = node.name;
    if (CROSS_FLOOR_TYPES.has(node.type)) newNode.shaft = node.shaft;
    if (node.connections) {
      newNode.connections = node.connections.map(c => idMap.get(c)).filter(Boolean);
    }
    if (node.info !== undefined) newNode.info = JSON.parse(JSON.stringify(node.info));

    newFloor.nodes.push(newNode);
    usedIds.add(newId);
  }

  floors.push(newFloor);
  switchFloor(floors.length - 1);
  showToast(`Floor duplicated as "${newFloor.name}".`);
}

/* ===== Node list ===== */

function renderNodeList() {
  const container = document.getElementById('nodeList');
  if (!container) return;
  const floor = activeFloor();
  container.innerHTML = '';

  if (!floor.nodes.length) {
    container.innerHTML = '<p class="empty-msg">No nodes on this floor yet.</p>';
    return;
  }

  const groups = {};
  for (const n of floor.nodes) {
    if (!groups[n.type]) groups[n.type] = [];
    groups[n.type].push(n);
  }

  for (const type of NODE_TYPE_ORDER) {
    if (!groups[type]?.length) continue;
    const section = document.createElement('div');
    section.className = 'node-group';
    section.innerHTML = `
      <div class="node-group-title">
        <span class="type-dot" style="background:${TYPE_COLORS[type] || '#111'}"></span>
        ${type} (${groups[type].length})
      </div>
    `;
    const ul = document.createElement('ul');
    ul.className = 'node-items';
    for (const n of groups[type]) {
      const li = document.createElement('li');
      li.className = 'node-item' + (n.id === selectedNodeId ? ' is-selected' : '');
      li.innerHTML = `
        <span class="node-item-label">${esc(n.name || n.id)}</span>
        <span class="node-item-id">${esc(n.id)}</span>
      `;
      li.addEventListener('click', () => {
        selectedNodeId = n.id;
        connectFromId = null;
        updateFeatureStates();
        renderPropsPanel();
        renderNodeList();
      });
      ul.appendChild(li);
    }
    section.appendChild(ul);
    container.appendChild(section);
  }
}

function updateNodeCount() {
  const el = document.getElementById('nodeCount');
  if (el) el.textContent = `(${activeFloor().nodes.length})`;
}

/* ===== Mode ===== */

function setMode(newMode) {
  if (pendingStopForNodeId) {
    cancelStopPlacement();
    showToast('Stop node creation cancelled.');
  }
  if (pendingShape) cancelShapePlacement();
  clearLineHover();

  mode = newMode;
  connectFromId = null;
  if (movingNodeId && newMode !== 'select') {
    movingNodeId = null;
    map.getCanvas().style.cursor = '';
  }

  document.querySelectorAll('.btn-mode').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const addToolbar = document.getElementById('addToolbar');
  if (addToolbar) addToolbar.style.display = mode === 'add' ? '' : 'none';

  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = getModeHint();

  updateFeatureStates();
}

/* ===== Import / Export ===== */

function exportProperty() {
  const data = {
    id: parseInt(document.getElementById('propId')?.value) || 1,
    name: (document.getElementById('propName')?.value || '').trim(),
    codeName: (document.getElementById('propCodeName')?.value || '').trim(),
    floors: floors.map(floor => ({
      number: floor.number,
      name: floor.name,
      hallways: (floor.hallways || []).map(h => ({ ...h })),
      nodes: floor.nodes.map(n => {
        const out = { id: n.id, type: n.type, coordinates: n.coordinates };
        if (n.name)                out.name        = n.name;
        if (n.category)            out.category    = n.category;
        if (n.connections?.length) out.connections  = [...n.connections];
        if (n.shaft)               out.shaft        = n.shaft;
        if (n.info != null)        out.info         = n.info;
        return out;
      }),
    })),
  };

  const codeName = data.codeName || 'property';
  downloadText(JSON.stringify(data, null, 2), `${codeName}.json`, 'application/json');
}

async function importProperty(file) {
  let text;
  try { text = await file.text(); } catch { showToast('Could not read file.'); return; }
  let data;
  try { data = JSON.parse(text); } catch { showToast('Invalid JSON.'); return; }
  if (!Array.isArray(data.floors)) { showToast('Invalid property file: missing floors array.'); return; }

  if (document.getElementById('propName'))     document.getElementById('propName').value     = data.name     || '';
  if (document.getElementById('propCodeName')) document.getElementById('propCodeName').value = data.codeName || '';
  if (document.getElementById('propId'))       document.getElementById('propId').value       = data.id       || '';

  usedIds.clear();
  Object.keys(typeCounters).forEach(k => delete typeCounters[k]);

  floors = data.floors.map(f => ({
    number: f.number ?? 1,
    name: f.name || `Floor ${f.number}`,
    hallways: (f.hallways || []).map(h => { usedIds.add(h.id); return { ...h }; }),
    nodes: (f.nodes || []).map(n => {
      usedIds.add(n.id);
      const node = { id: n.id, type: n.type, coordinates: n.coordinates };
      if (n.name      !== undefined) node.name        = n.name;
      if (n.category  !== undefined) node.category    = n.category;
      if (n.connections)             node.connections  = [...n.connections];
      else if (TYPE_PROPS[n.type]?.connections) node.connections = [];
      if (n.shaft)                   node.shaft        = n.shaft;
      if (n.info      !== undefined) node.info         = n.info;
      // facing is no longer part of the model — silently dropped on import
      return node;
    }),
  }));

  activeFloorIndex = 0;
  selectedNodeId = null;
  connectFromId = null;
  movingNodeId = null;
  pendingStopForNodeId = null;

  renderFloorTabs();
  renderFloorEdit();
  refreshMap();
  renderPropsPanel();
  showToast('Property loaded.');
}

/* ===== Floor background ===== */

document.getElementById('floorBg')?.addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    const aspect = img.naturalWidth / img.naturalHeight;
    let tw = 20, th = tw / aspect;
    if (th > 20) { th = 20; tw = th * aspect; }
    const [l, r, t, b] = [-tw/2, tw/2, th/2, -th/2];
    if (map.getSource('floor')) { map.removeLayer('floor-layer'); map.removeSource('floor'); }
    map.addSource('floor', { type: 'image', url, coordinates: [[l,t],[r,t],[r,b],[l,b]] });
    map.addLayer({ id: 'floor-layer', type: 'raster', source: 'floor', paint: { 'raster-opacity': 1 } }, 'grid-lines');
  };
  img.src = url;
});

/* ===== Event bindings ===== */

document.getElementById('addFloor')?.addEventListener('click', addFloor);
document.getElementById('dupFloor')?.addEventListener('click', duplicateFloor);
document.getElementById('exportJson')?.addEventListener('click', exportProperty);

document.getElementById('importJson')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) await importProperty(file);
  e.target.value = '';
});

document.querySelectorAll('.btn-mode').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

document.getElementById('nodeType')?.addEventListener('change', () => {
  if (mode === 'add' && !pendingStopForNodeId) {
    const hint = document.getElementById('modeHint');
    if (hint) hint.textContent = getModeHint();
  }
});

document.getElementById('floorEditName')?.addEventListener('input', (e) => {
  activeFloor().name = e.target.value || `Floor ${activeFloor().number}`;
  renderFloorTabs();
});

document.getElementById('floorEditNumber')?.addEventListener('change', (e) => {
  const raw = e.target.value.trim();
  const num = parseFloat(raw);
  activeFloor().number = Number.isFinite(num) ? num : (raw || activeFloor().number);
  renderFloorTabs();
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === 'Escape' && pendingStopForNodeId) {
    cancelStopPlacement();
    showToast('Stop node skipped.');
  }
  if (e.key === 'Escape' && pendingShape) {
    cancelShapePlacement();
    showToast('Shape placement cancelled.');
  }
});

/* ===== Utilities ===== */

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), 2500);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ===== Shape picker bindings ===== */

document.getElementById('openShapePicker')?.addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('shapePickerMenu')?.classList.toggle('open');
});

document.querySelectorAll('.shape-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('shapePickerMenu')?.classList.remove('open');
    enterShapePlacement(btn.dataset.shape);
  });
});

document.addEventListener('pointerdown', (e) => {
  if (!document.getElementById('shapePickerWrap')?.contains(e.target)) {
    document.getElementById('shapePickerMenu')?.classList.remove('open');
  }
});

function downloadText(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
