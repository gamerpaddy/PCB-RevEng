/* ===== state.js — data model, nets, undo/redo, save/load ===== */
"use strict";

const NET_COLORS = [
  "#ffd24d","#4dd2ff","#ff7eb6","#8aff80","#ffa94d","#b78aff",
  "#5dffd2","#ff6e6e","#9ecbff","#e0ff4d","#ff9ecb","#7ee787",
  "#ffc6ff","#74c0fc","#ffd8a8","#a9e34b","#f783ac","#66d9e8"
];

const SIDE_COLORS = { front:"#ff4d4d", back:"#4d7dff", xray:"#9aa3ad" };
const SIDE_LABELS = { front:"Front", back:"Back", xray:"X-ray" };
const INNER_COLORS = ["#37c871","#c87de0","#d8c44a","#4ac8c8","#e08a4a","#8a9ae0","#9ad84a","#e04a8a","#4a8ae0","#c8a37d"];
for (let i = 1; i <= 10; i++){
  SIDE_COLORS["inner"+i] = INNER_COLORS[i-1];
  SIDE_LABELS["inner"+i] = "Inner " + i;
}

const LAYER_COUNTS = [1,2,4,6,8,10,12];

/* copper foil thickness in mm for a given weight in oz/ft² (1 oz ≈ 34.79 µm) */
const OZ_TO_MM = 0.03479;

/* IPC-2221 external/internal trace ampacity estimate.
   I = k · ΔT^0.44 · A^0.725, with A the cross-section in mil² and k the layer
   constant (0.048 external, 0.024 internal). Returns amperes. */
function estimateTraceAmps(widthMm, thickMm, internal, dT){
  dT = dT || 10;
  if (!(widthMm > 0) || !(thickMm > 0)) return 0;
  const area = (widthMm / 0.0254) * (thickMm / 0.0254); // mil²
  const k = internal ? 0.024 : 0.048;
  return k * Math.pow(dT, 0.44) * Math.pow(area, 0.725);
}

const State = {
  pxPerMm: 10,          // world px per millimetre (set with Measure tool)
  layerCount: 2,        // copper layers on the board (1,2,4,…,12)
  viaR: 5,              // via radius in world px — default 1 mm Ø (at pxPerMm 10); applies to all vias
  viaHole: 2.5,         // via drill RADIUS in world px — default 0.5 mm Ø bore for new vias (retained)
  traceW: 5,            // trace width in world px (applies to all traces)
  compView: "side",     // "side" = only viewed side fully drawn (other side: THT pads/vias only) | "both"
  traceView: "active",  // "active" = only active draw side's traces shown | "all"
  overlapCheck: true,   // warn when a moved pad overlaps another net
  refTextSize: 13,      // component reference label size in px
  copperOz: 1,          // outer-layer copper weight (oz/ft²) — trace current estimator
  copperOzInner: 0.5,   // inner-layer copper weight (oz/ft²) — usually lighter than outer
  focusDim: 0.16,       // opacity of non-selected objects when a net is focused (0..1)
  layers: [],           // {id,name,side,dataURL,img,visible,opacity,tx,ty,scale,rot,mirror,locked}
  components: [],       // {id,ref,value,part,fpId,fpParams,kicad,x,y,rot,side,scale,pins:[{num,name,netId,xmm,ymm}]}
  vias: [],             // {id,x,y,netId,r}
  traces: [],           // {id,side,netId,points:[{x,y}],width}
  notes: [],            // {id,x,y,text,color} — freeform sticky-note annotations pinned to board coords
  schWires: [],         // schematic-editor wires: {id,netId,points:[{x,y}mm],a:{comp,pin}|null,b:{comp,pin}|null}
  schLabels: [],        // schematic net labels pinned to pins: {id,comp,pin,dx,dy} (offset mm from the pin)
  nets: [],             // {id,name,color,auto}
  xlinks: [],           // off-page connector links: {id, a:compId, b:compId, map:[[pinNumA,pinNumB],…]|null} (null = all pins by number); project-global like nets
  bomColumns: [],       // custom BOM column names (MPN, Supplier, …); per-part values live in component.bom
  _id: 1,
  refCounters: {},      // prefix -> last number
};

function nextId(){ return State._id++; }

/* ---------- multi-PCB pages ("boards") ----------
   A project can hold several PCBs (pages). Each board owns its geometry collections
   and image layers; nets/refs/ids/settings stay PROJECT-global so a connector on one
   page can carry the same net as its counterpart on another. The classic top-level
   State.components / State.layers / … are ALIASES of the active board's arrays —
   switching a page just repoints them, so all editor code keeps working untouched. */
const BOARD_COLS = ["layers","components","vias","traces","notes","schWires","schLabels"];

function makeBoard(name){
  return { id: nextId(), name: name || ("PCB " + (State.boards.length + 1)),
           layerCount: 2,
           layers:[], components:[], vias:[], traces:[], notes:[], schWires:[], schLabels:[] };
}
State.boards = [{ id: nextId(), name: "PCB 1", layerCount: State.layerCount,
                  layers: State.layers, components: State.components, vias: State.vias,
                  traces: State.traces, notes: State.notes,
                  schWires: State.schWires, schLabels: State.schLabels }];
State.boardIdx = 0;

function activeBoard(){ return State.boards[State.boardIdx] || State.boards[0]; }
/* The top-level State arrays are AUTHORITATIVE for the active page: lots of editor
   code replaces them wholesale (State.traces = State.traces.filter(…)), which would
   silently detach them from the board record. So adopt them back into the active
   board before anything reads the boards list — cheap (8 assignments), called from
   every boards-reading entry point. */
function boardsSyncScalars(){
  const b = activeBoard();
  if (!b) return;
  b.layerCount = State.layerCount;
  for (const col of BOARD_COLS) b[col] = State[col];
}
/* repoint the top-level aliases at board i (no UI refresh — Boards.switchTo does that) */
function setActiveBoard(i){
  i = Math.max(0, Math.min(State.boards.length - 1, i | 0));
  boardsSyncScalars();
  State.boardIdx = i;
  const b = State.boards[i];
  for (const col of BOARD_COLS) State[col] = b[col];
  State.layerCount = b.layerCount || 2;
}
/* concatenated view of one collection across every board (project-wide scans) */
function allOf(col){
  boardsSyncScalars();
  return State.boards.length === 1 ? State.boards[0][col]
       : State.boards.flatMap(b => b[col] || []);
}
/* the board an object (or layer) lives on, or null */
function boardOf(obj){
  boardsSyncScalars();
  for (const b of State.boards)
    for (const col of BOARD_COLS)
      if (b[col] && b[col].includes(obj)) return b;
  return null;
}

/* copper sides available at the current layer count, in stackup order */
function availableSides(){
  const out = ["front"];
  for (let i = 1; i <= State.layerCount - 2; i++) out.push("inner"+i);
  if (State.layerCount >= 2) out.push("back");
  return out;
}

/* ---------- via layer span (blind / buried vias) ----------
   A via with no from/to spans the whole stack (a normal through via). from/to are
   copper side names ("front","inner1",…,"back"); resolved here to indices into the
   current stackup so the span survives layer-count changes. */
function viaSpanIdx(v){
  const sides = availableSides();
  const last = sides.length - 1;
  let lo = v.from ? sides.indexOf(v.from) : 0;
  let hi = v.to   ? sides.indexOf(v.to)   : last;
  if (lo < 0) lo = 0;
  if (hi < 0) hi = last;
  if (lo > hi){ const t = lo; lo = hi; hi = t; }
  return { lo, hi, sides };
}
/* does the via reach a given copper side? */
function viaOnSide(v, side){
  const { lo, hi, sides } = viaSpanIdx(v);
  const i = sides.indexOf(side);
  return i >= 0 && i >= lo && i <= hi;
}
/* true when the via does NOT reach both outer layers (i.e. it is blind or buried) */
function viaIsBlind(v){
  const { lo, hi, sides } = viaSpanIdx(v);
  return lo > 0 || hi < sides.length - 1;
}
/* short human label for the span, e.g. "Through (all layers)" or "Front → Inner 1" */
function viaSpanLabel(v){
  const { lo, hi, sides } = viaSpanIdx(v);
  if (lo === 0 && hi === sides.length - 1) return "Through (all layers)";
  const nm = (s) => SIDE_LABELS[s] || s;
  return nm(sides[lo]) + " → " + nm(sides[hi]);
}

/* ---------- nets ---------- */
/* prefab power nets — protected: cannot be renamed, and never lose a merge */
const PROTECTED_NET_NAMES = ["GND","AGND","DGND","VCC","VDD","VSS","VEE","+3V3","+5V","+12V","-12V","VBAT"];
// ground nets black (schematic convention), power/supply nets red
const PROTECTED_COLORS = { GND:"#000000", AGND:"#1a1a1a", DGND:"#333333",
                           VCC:"#ff2b2b", VDD:"#ff4d4d", VSS:"#000000", VEE:"#3a3a3a",
                           "+3V3":"#ff6e2b", "+5V":"#ff2b2b", "+12V":"#ff5da0", "-12V":"#b04dff", VBAT:"#ff8a3b" };

/* rolling palette index so auto-net colours don't repeat unpredictably after
   merges/prunes shrink State.nets (session-local; each net persists its colour) */
let _netColorIdx = 0;

function createNet(name){
  const id = nextId();
  const auto = !name;
  if (!name) name = "N$" + id;
  const prot = PROTECTED_NET_NAMES.includes(name.toUpperCase());
  if (prot) name = name.toUpperCase();
  const color = prot ? (PROTECTED_COLORS[name] || "#66d96f")
                     : NET_COLORS[(_netColorIdx++) % NET_COLORS.length];
  const net = { id, name, color, auto, protected: prot };
  State.nets.push(net);
  return net;
}
/* getNet is called per-conductor, per-frame (netColor for every trace/via/pad), so a
   linear .find over State.nets is O(nets · objects) each render. Keep an id→net Map and
   rebuild it only when it can't be trusted: net ids never change in place — the array is
   REASSIGNED on merge/prune/load/undo (ref changes) and only GROWS on createNet (push,
   same ref). So rebuild when the array reference changes, or on a miss when the array has
   grown since we indexed it. A genuine absent-id lookup (e.g. a stale netId) then costs at
   most one extra rebuild and returns null without thrashing. */
let _netIdx = null, _netIdxRef = null;
function _rebuildNetIdx(){
  _netIdx = new Map();
  for (const n of State.nets) _netIdx.set(n.id, n);
  _netIdxRef = State.nets;
}
function getNet(id){
  if (id == null) return null;
  if (_netIdxRef !== State.nets || !_netIdx) _rebuildNetIdx();
  let n = _netIdx.get(id);
  if (n !== undefined) return n;
  if (_netIdx.size !== State.nets.length){ _rebuildNetIdx(); n = _netIdx.get(id); } // a net was pushed
  return n || null;
}
function findNetByName(name){ return State.nets.find(n => n.name === name) || null; }

/* protect / unprotect a net. Protecting locks the name and shields it from accidental
   merges (and applies the standard power/ground colour when one is known); unprotecting
   — allowed even for prefab nets like GND / VCC — just clears the flag so the net can be
   renamed and merged like any ordinary net. Returns the resulting protected state. */
function setNetProtected(id, prot){
  const net = getNet(id);
  if (!net) return false;
  net.protected = !!prot;
  if (prot){
    net.auto = false;
    const std = PROTECTED_COLORS[net.name.toUpperCase()];
    if (std) net.color = std;
  }
  return net.protected;
}

/* number of component pads on a net — project-wide (all pages) */
function netPinCount(netId){
  let n = 0;
  for (const c of allOf("components")) for (const p of c.pins) if (p.netId === netId) n++;
  return n;
}

/* a net name not already in use (NET1, NET2, …) */
function uniqueNetName(base){
  base = base || "NET";
  let i = 1;
  while (findNetByName(base + i)) i++;
  return base + i;
}

/* merge net b into net a. Returns surviving id, or null if both are (different)
   protected nets — those must never be silently joined. */
function mergeNets(aId, bId){
  if (aId === bId) return aId;
  const a = getNet(aId), b = getNet(bId);
  if (!a || !b) return aId;
  if (a.protected && b.protected) return null;
  // protected wins; otherwise the user-named net wins
  let keep = a, drop = b;
  if (b.protected) { keep = b; drop = a; }
  else if (a.protected) { keep = a; drop = b; }
  else if (a.auto && !b.auto){ keep = b; drop = a; }
  for (const c of allOf("components"))
    for (const p of c.pins) if (p.netId === drop.id) p.netId = keep.id;
  for (const v of allOf("vias"))   if (v.netId === drop.id) v.netId = keep.id;
  for (const t of allOf("traces")) if (t.netId === drop.id) t.netId = keep.id;
  for (const w of allOf("schWires")) if (w.netId === drop.id) w.netId = keep.id;
  State.nets = State.nets.filter(n => n.id !== drop.id);
  return keep.id;
}

function renameNet(id, newName){
  newName = (newName || "").trim();
  if (!newName) return false;
  const net = getNet(id);
  if (!net) return false;
  if (net.protected && newName.toUpperCase() !== net.name){
    return false; // protected nets keep their name
  }
  // collision lookup matches assignNetToObject's: exact name, else its uppercase form —
  // so typing "data" merges with an existing "DATA" here exactly like assigning does
  const existing = findNetByName(newName) || findNetByName(newName.toUpperCase());
  if (existing && existing.id !== id){
    // renaming onto an existing net merges them
    const sid = mergeNets(existing.id, id);
    if (sid == null) return false;
    // an explicit rename should end up CALLED what was typed: mergeNets' "user-named
    // net wins" keep-rule may have kept the OLD name (merging onto an auto net) — put
    // the typed name on the survivor unless it's protected or already matches (a
    // case-insensitive match keeps the existing net's casing, like assign does)
    const surv = getNet(sid);
    if (surv && !surv.protected && surv.name.toUpperCase() !== newName.toUpperCase()){
      surv.name = PROTECTED_NET_NAMES.includes(newName.toUpperCase()) ? newName.toUpperCase() : newName;
      surv.auto = false;
    }
    return true;
  }
  if (PROTECTED_NET_NAMES.includes(newName.toUpperCase())){
    net.name = newName.toUpperCase();
    net.protected = true;
    net.color = PROTECTED_COLORS[net.name] || net.color;
  } else {
    net.name = newName;
  }
  net.auto = false;
  return true;
}

function netMembers(netId){
  const out = [];
  for (const c of allOf("components"))
    for (const p of c.pins)
      if (p.netId === netId) out.push({type:"pin", comp:c, pin:p});
  for (const v of allOf("vias"))   if (v.netId === netId) out.push({type:"via", via:v});
  for (const t of allOf("traces")) if (t.netId === netId) out.push({type:"trace", trace:t});
  return out;
}

/* delete nets with no members — scans every page, so a net whose only members live on
   another PCB (an off-page connector net) is never mistaken for empty */
function pruneNets(){
  const used = new Set();
  for (const c of allOf("components")) for (const p of c.pins) if (p.netId) used.add(p.netId);
  for (const v of allOf("vias"))   if (v.netId) used.add(v.netId);
  for (const t of allOf("traces")) if (t.netId) used.add(t.netId);
  for (const w of allOf("schWires")) if (w.netId) used.add(w.netId);
  State.nets = State.nets.filter(n => used.has(n.id) || !n.auto);
}

/* ---------- refdes (unique project-wide, across all pages) ---------- */
function refExists(ref){ return allOf("components").some(c => c.ref === ref); }

function nextRef(prefix){
  let n = (State.refCounters[prefix] || 0) + 1;
  while (refExists(prefix + n)) n++;   // never collide with an existing reference
  State.refCounters[prefix] = n;
  return prefix + n;
}
function registerRef(ref){
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref || "");
  if (!m) return;
  const [, p, num] = m;
  State.refCounters[p] = Math.max(State.refCounters[p] || 0, parseInt(num, 10));
}

/* ---------- lookups (ids are global — search every page) ---------- */
function getComp(id){ return allOf("components").find(c => c.id === id) || null; }
function getVia(id){ return allOf("vias").find(v => v.id === id) || null; }
function getTrace(id){ return allOf("traces").find(t => t.id === id) || null; }
function getLayer(id){ return allOf("layers").find(l => l.id === id) || null; }
function getNote(id){ return allOf("notes").find(n => n.id === id) || null; }

/* ---------- undo / redo ---------- */
const Undo = { stack: [], redo: [], max: 25 };
try { Undo.max = Math.max(5, Math.min(200, parseInt(localStorage.getItem("pcbreveng.histLen"),10) || 25)); } catch(e){}

/* Image-pixel history for undo. Snapshots are JSON, so they can't hold a layer's
   bitmap — they store a small `imgId` instead. Pixel-baking ops (crop, deskew) call
   commitLayerImage() to register the NEW bitmap under a fresh id; the previous bitmap
   stays cached under its old id, so undo/redo just swap layer.img/dataURL/tiles back by
   id. Non-baking edits (move, 4-point align warp) never change the id and are unaffected. */
const _imgVault = new Map();   // imgId -> {img, dataURL, tiles}
let _imgVaultSeq = 1;
function commitLayerImage(l){   // call AFTER assigning the new img/dataURL/tiles
  l.imgId = _imgVaultSeq++;
  _imgVault.set(l.imgId, { img:l.img, dataURL:l.dataURL, tiles:l.tiles || null });
}
function ensureLayerImgId(l){   // lazily register a layer's current pixels (first snapshot)
  if (l.imgId == null || !_imgVault.has(l.imgId)) commitLayerImage(l);
  return l.imgId;
}

function _layerMeta(l){
  return {
    id:l.id, name:l.name, side:l.side, visible:l.visible, opacity:l.opacity,
    tx:l.tx, ty:l.ty, scale:l.scale, rot:l.rot, mirror:l.mirror, locked:l.locked,
    // url rides in the metadata: undoing "replace from URL" must restore the
    // hosted/uploaded state too, not just the bitmap (else a reload re-fetches
    // the new URL over the undone image)
    url:l.url || null,
    warp:l.warp || null, imgId: ensureLayerImgId(l)
  };
}

function snapshot(){
  boardsSyncScalars();
  return JSON.stringify({
    pxPerMm: State.pxPerMm,
    viaR: State.viaR,
    viaHole: State.viaHole,
    traceW: State.traceW,
    compView: State.compView,
    traceView: State.traceView,
    overlapCheck: State.overlapCheck,
    refTextSize: State.refTextSize,
    copperOz: State.copperOz,
    copperOzInner: State.copperOzInner,
    focusDim: State.focusDim,
    nets: State.nets,
    xlinks: State.xlinks,
    bomColumns: State.bomColumns,
    _id: State._id,
    refCounters: State.refCounters,
    boardIdx: State.boardIdx,
    boards: State.boards.map(b => ({
      id: b.id, name: b.name, layerCount: b.layerCount || 2,
      // `_fp` is a RUNTIME footprint cache — strip it (like serializeProject) so undo
      // snapshots don't balloon on big imported boards, and so a mere cache regeneration
      // isn't reported as an "edit" by diffSnapshots / selectiveUndo.
      components: b.components.map(c => { const { _fp, ...rest } = c; return rest; }),
      vias: b.vias, traces: b.traces, notes: b.notes,
      schWires: b.schWires, schLabels: b.schLabels,
      layersMeta: b.layers.map(_layerMeta),
    })),
  });
}

/* wrap a legacy (single-board, flat-collections) snapshot/project object into the
   boards form so old autosaved undo stacks and v1 project files keep working */
function _wrapLegacyBoards(s){
  if (s.boards) return s;
  s.boards = [{
    id: (State.boards[0] && State.boards[0].id) || 0, name: "PCB 1",
    layerCount: s.layerCount || 2,
    components: s.components || [], vias: s.vias || [], traces: s.traces || [],
    notes: s.notes || [], schWires: s.schWires || [], schLabels: s.schLabels || [],
    layersMeta: s.layersMeta || null, layers: s.layers || null,
  }];
  s.boardIdx = 0;
  return s;
}

/* the redo stack most recently cleared by pushUndo — kept so a pushUndo that turns out
   to be a no-op (a click that never dragged) can be rolled back WITHOUT destroying redo */
let _clearedRedo = null;
function pushUndo(label){
  Undo.stack.push({ json: snapshot(), label: label || "edit", time: Date.now() });
  if (Undo.stack.length > Undo.max) Undo.stack.shift();
  _clearedRedo = Undo.redo;   // remember what we're about to clear
  Undo.redo = [];
}

/* discard the most recent pushUndo when the action it guarded changed nothing (e.g. a
   click that never became a drag). Restores the redo stack that pushUndo cleared, so a
   no-op click no longer wipes redo history. Only valid immediately after that pushUndo,
   before any further pushUndo — which is exactly how the drag no-op paths use it. */
function cancelUndo(){
  if (!Undo.stack.length) return;
  Undo.stack.pop();
  if (_clearedRedo){ Undo.redo = _clearedRedo; _clearedRedo = null; }
}

function applySnapshot(json){
  const s = _wrapLegacyBoards(JSON.parse(json));
  State.pxPerMm = s.pxPerMm;
  State.viaR = s.viaR || 8;
  State.viaHole = s.viaHole || 3.6;
  State.traceW = s.traceW || 5;
  State.compView = s.compView || "side";
  State.traceView = s.traceView || "active";
  State.overlapCheck = s.overlapCheck !== false;
  State.refTextSize = s.refTextSize || 13;
  State.copperOz = s.copperOz || 1;
  State.copperOzInner = s.copperOzInner || 0.5;
  State.focusDim = (s.focusDim != null) ? s.focusDim : 0.16;
  State.nets = s.nets;
  State.xlinks = s.xlinks || [];
  State.bomColumns = s.bomColumns || [];
  State._id = s._id;
  State.refCounters = s.refCounters;

  /* rebuild the boards from the snapshot. Live layer OBJECTS are reused (they hold the
     decoded bitmap); layers the snapshot references but that no longer live anywhere are
     resurrected from the image vault. Boards/layers created AFTER the snapshot are kept
     (page & layer membership is not undone — matches the old layer semantics). */
  const liveLayers = new Map(allOf("layers").map(l => [l.id, l]));
  const liveBoards = new Map(State.boards.map(b => [b.id, b]));
  const snapBoardIds = new Set(s.boards.map(b => b.id));
  State.boards = s.boards.map(sb => {
    const metas = sb.layersMeta || [];
    const layers = metas.map(m => {
      let l = liveLayers.get(m.id);
      if (!l) l = { img: null, dataURL: "", tiles: null };
      else liveLayers.delete(m.id);
      Object.assign(l, m);
      // swap the bitmap back to the version this snapshot captured (undo of crop/deskew)
      if (m.imgId != null && _imgVault.has(m.imgId)){
        const v = _imgVault.get(m.imgId);
        l.img = v.img; l.dataURL = v.dataURL; l.tiles = v.tiles;
      }
      return l;
    });
    const comps = sb.components || [];
    comps.forEach(c => { c._fp = null; });   // snapshots no longer carry _fp — regenerate on demand
    return { id: sb.id, name: sb.name || "PCB", layerCount: sb.layerCount || 2,
             layers, components: comps, vias: sb.vias || [], traces: sb.traces || [],
             notes: sb.notes || [], schWires: sb.schWires || [], schLabels: sb.schLabels || [] };
  });
  // layers added after this snapshot → keep them on their (surviving) board
  for (const [id, l] of liveLayers){
    let target = null;
    for (const [bid, ob] of liveBoards)
      if (ob.layers && ob.layers.some(x => x.id === id)){ target = State.boards.find(b => b.id === bid); break; }
    (target || State.boards[State.boardIdx] || State.boards[0]).layers.push(l);
  }
  // boards added after this snapshot → keep them untouched
  for (const [bid, ob] of liveBoards)
    if (!snapBoardIds.has(bid)) State.boards.push(ob);
  const idx = Math.max(0, Math.min(State.boards.length - 1, s.boardIdx || 0));
  State.boardIdx = idx;
  const b = State.boards[idx];
  for (const col of BOARD_COLS) State[col] = b[col];
  State.layerCount = b.layerCount || 2;
  if (typeof Boards !== "undefined" && Boards.refreshTabs) Boards.refreshTabs();
}

function undo(){
  if (!Undo.stack.length) return false;
  const e = Undo.stack.pop();
  Undo.redo.push({ json: snapshot(), label: e.label, time: Date.now() });
  applySnapshot(e.json);
  return true;
}
function redo(){
  if (!Undo.redo.length) return false;
  const e = Undo.redo.pop();
  Undo.stack.push({ json: snapshot(), label: e.label, time: Date.now() });
  applySnapshot(e.json);
  return true;
}

/* ---------- selective undo: revert ONE action from the timeline ----------
   Diffs the snapshot before the action against the one after it, then restores
   only the objects that the action touched — later edits to other objects stay. */
function selectiveUndo(i){
  if (i < 0 || i >= Undo.stack.length) return false;
  boardsSyncScalars();
  const entry = Undo.stack[i];
  const before = _wrapLegacyBoards(JSON.parse(entry.json));
  const after  = _wrapLegacyBoards(JSON.parse(i + 1 < Undo.stack.length ? Undo.stack[i+1].json : snapshot()));
  // Make the selective revert itself undoable (Ctrl+Z restores the reverted action), but tag it
  // so the history dialog does NOT offer to revert the revert — that recursion ("revert: revert:
  // …") just re-applies/re-reverts the same edit endlessly. Strip any existing prefix so the label
  // stays a single clean "revert: <action>".
  pushUndo("revert: " + entry.label.replace(/^revert:\s*/, ""));
  Undo.stack[Undo.stack.length - 1].isRevert = true;
  // flatten a snapshot collection across its boards: id → {o, bid} (nets are global)
  const flat = (s, col) => {
    const m = new Map();
    if (col === "nets" || col === "xlinks"){ for (const o of (s[col] || [])) m.set(o.id, { o, bid: null }); return m; }
    for (const b of (s.boards || [])) for (const o of (b[col] || [])) m.set(o.id, { o, bid: b.id });
    return m;
  };
  const liveArr = (col, bid) => {   // the live array to re-add into (board by id, else active)
    if (col === "nets") return State.nets;
    if (col === "xlinks") return State.xlinks;
    const b = State.boards.find(x => x.id === bid) || activeBoard();
    return b[col];
  };
  for (const col of ["components","vias","traces","notes","schWires","schLabels","nets","xlinks"]){
    const bm = flat(before, col);
    const am = flat(after, col);
    const curArrs = col === "nets" ? [State.nets]
                  : col === "xlinks" ? [State.xlinks]
                  : State.boards.map(b => b[col]);
    // objects created by that action → remove (wherever they live now)
    for (const id of am.keys()){
      if (bm.has(id)) continue;
      for (const cur of curArrs){
        const idx = cur.findIndex(o => o.id === id);
        if (idx >= 0){ cur.splice(idx, 1); break; }
      }
    }
    // objects modified or deleted by that action → restore the "before" version
    for (const [id, { o: bo, bid }] of bm){
      const ae = am.get(id);
      if (ae && JSON.stringify(ae.o) === JSON.stringify(bo)) continue;
      const copy = JSON.parse(JSON.stringify(bo));
      let placed = false;
      for (const cur of curArrs){
        const idx = cur.findIndex(o => o.id === id);
        if (idx >= 0){ cur[idx] = copy; placed = true; break; }
      }
      if (!placed) liveArr(col, bid).push(copy);
    }
  }
  // image layer transforms (flatten metas across boards)
  const flatMeta = (s) => {
    const m = new Map();
    for (const b of (s.boards || [])) for (const o of (b.layersMeta || [])) m.set(o.id, o);
    return m;
  };
  const bl = flatMeta(before), al = flatMeta(after);
  for (const [id, bo] of bl){
    const ao = al.get(id);
    if (ao && JSON.stringify(ao) === JSON.stringify(bo)) continue;
    const l = getLayer(id);
    if (l) Object.assign(l, bo);
  }
  // board-wide scalar settings (mirror the list diffSnapshots reports)
  for (const k of ["pxPerMm","viaR","viaHole","traceW","compView","traceView",
                   "overlapCheck","refTextSize","copperOz","copperOzInner","focusDim"]){
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) State[k] = before[k];
  }
  // per-page layer count
  for (const sb of (before.boards || [])){
    const ab = (after.boards || []).find(x => x.id === sb.id);
    if (ab && ab.layerCount !== sb.layerCount){
      const live = State.boards.find(x => x.id === sb.id);
      if (live){ live.layerCount = sb.layerCount; if (live === activeBoard()) State.layerCount = sb.layerCount; }
    }
  }
  if (JSON.stringify(before.bomColumns) !== JSON.stringify(after.bomColumns))
    State.bomColumns = JSON.parse(JSON.stringify(before.bomColumns || []));
  const idx = Undo.stack.indexOf(entry);
  if (idx >= 0) Undo.stack.splice(idx, 1); // the action is gone from the timeline
  allOf("components").forEach(c => c._fp = null);
  pruneNets();
  return true;
}

/* ---------- timeline detail: human summary of what an action changed ----------
   Diffs the entry's "before" snapshot against the next one (or the live state for
   the most recent entry) and returns a short description, e.g.
   "J1: footprint" or "added 2 parts (R5, R6) · net GND renamed →VCC". */
function undoDetail(i){
  if (i < 0 || i >= Undo.stack.length) return "";
  const beforeJson = Undo.stack[i].json;
  const afterJson  = (i + 1 < Undo.stack.length) ? Undo.stack[i+1].json : snapshot();
  return diffSnapshots(beforeJson, afterJson);
}

/* aspects of a single component that differ between two snapshots */
function _compAspects(b, a){
  const out = [];
  if (b.ref !== a.ref)                          out.push("renamed →" + (a.ref || "?"));
  if ((b.value||"") !== (a.value||""))          out.push("value");
  if ((b.part ||"") !== (a.part ||""))          out.push("part");
  if ((b.kicad||"") !== (a.kicad||"") || b.fpId !== a.fpId) out.push("footprint");
  if (b.x !== a.x || b.y !== a.y || b.rot !== a.rot)        out.push("moved");
  if (b.schX !== a.schX || b.schY !== a.schY || b.schRot !== a.schRot ||
      !!b.schFlipH !== !!a.schFlipH || !!b.schFlipV !== !!a.schFlipV) out.push("schematic pos");
  if (b.side !== a.side)                         out.push("flipped");
  const pinNets = c => (c.pins||[]).map(p => p.netId || 0).join(",");
  if (pinNets(b) !== pinNets(a))                 out.push("net");
  const pinNC = c => (c.pins||[]).map(p => p.nc ? 1 : 0).join(",");
  if (pinNC(b) !== pinNC(a))                     out.push("no-connect");
  return out.length ? out.join(", ") : "edited";
}

function diffSnapshots(beforeJson, afterJson){
  let b, a;
  try { b = _wrapLegacyBoards(JSON.parse(beforeJson)); a = _wrapLegacyBoards(JSON.parse(afterJson)); } catch(e){ return ""; }
  // flatten per-board collections so the differs below keep their flat view
  for (const s of [b, a]){
    for (const col of ["components","vias","traces","notes","schWires","schLabels"])
      s[col] = (s.boards || []).flatMap(x => x[col] || []);
    s.layersMeta = (s.boards || []).flatMap(x => x.layersMeta || []);
  }
  const parts = [];
  if ((b.boards || []).length !== (a.boards || []).length)
    parts.push((a.boards.length > b.boards.length ? "added" : "removed") + " a PCB page");
  for (const sb of (b.boards || [])){
    const ab = (a.boards || []).find(x => x.id === sb.id);
    if (ab && ab.layerCount !== sb.layerCount) parts.push("layer count changed (" + (ab.name || "page") + ")");
  }
  const list = (names, max = 4) => {
    const f = names.filter(Boolean);
    if (!f.length) return "";
    return " (" + f.slice(0, max).join(", ") + (f.length > max ? ", +" + (f.length - max) : "") + ")";
  };
  const diffColl = (col) => {
    const bm = new Map((b[col]||[]).map(o => [o.id, o]));
    const am = new Map((a[col]||[]).map(o => [o.id, o]));
    const added = [], removed = [], changed = [];
    for (const [id, o] of am) if (!bm.has(id)) added.push(o);
    for (const [id, o] of bm){
      if (!am.has(id)){ removed.push(o); continue; }
      const ao = am.get(id);
      if (JSON.stringify(ao) !== JSON.stringify(o)) changed.push([o, ao]);
    }
    return { added, removed, changed };
  };

  // components — name + per-object aspect detail
  const c = diffColl("components");
  if (c.added.length)   parts.push("added "   + c.added.length   + " part" + (c.added.length>1?"s":"")   + list(c.added.map(o=>o.ref)));
  if (c.removed.length) parts.push("removed " + c.removed.length + " part" + (c.removed.length>1?"s":"") + list(c.removed.map(o=>o.ref)));
  c.changed.forEach(([bo, ao]) => parts.push((bo.ref || "part") + ": " + _compAspects(bo, ao)));

  // nets — name + rename / protect / colour detail
  const n = diffColl("nets");
  if (n.added.length)   parts.push("added "   + n.added.length   + " net" + (n.added.length>1?"s":"")   + list(n.added.map(o=>o.name)));
  if (n.removed.length) parts.push("removed " + n.removed.length + " net" + (n.removed.length>1?"s":"") + list(n.removed.map(o=>o.name)));
  n.changed.forEach(([bo, ao]) => {
    const a2 = [];
    if (bo.name !== ao.name)               a2.push("net " + bo.name + " renamed →" + ao.name);
    if (!!bo.protected !== !!ao.protected) a2.push("net " + ao.name + (ao.protected ? " protected" : " unprotected"));
    if (bo.color !== ao.color)             a2.push("net " + ao.name + " colour");
    if (a2.length) parts.push(a2.join(", "));
  });

  // vias, traces & notes — counts only (no useful per-object name)
  for (const [col, noun] of [["vias","via"], ["traces","trace"], ["notes","note"], ["schWires","schematic wire"], ["schLabels","net label"], ["xlinks","off-page link"]]){
    const d = diffColl(col);
    if (d.added.length)   parts.push("added "   + d.added.length   + " " + noun + (d.added.length>1?"s":""));
    if (d.removed.length) parts.push("removed " + d.removed.length + " " + noun + (d.removed.length>1?"s":""));
    if (d.changed.length) parts.push("changed " + d.changed.length + " " + noun + (d.changed.length>1?"s":""));
  }

  // image-layer transforms
  const bl = new Map((b.layersMeta||[]).map(m => [m.id, m]));
  const al = new Map((a.layersMeta||[]).map(m => [m.id, m]));
  const layerNames = [];
  for (const [id, bo] of bl){
    const ao = al.get(id);
    if (ao && JSON.stringify(ao) !== JSON.stringify(bo)) layerNames.push(bo.name);
  }
  if (layerNames.length) parts.push("adjusted " + layerNames.length + " layer" + (layerNames.length>1?"s":"") + list(layerNames));

  // board-wide scalar settings
  [ ["pxPerMm","scale"], ["viaR","via size"], ["viaHole","via drill"], ["traceW","trace width"],
    ["refTextSize","label size"], ["compView","component view"], ["traceView","trace view"],
    ["copperOz","copper weight"], ["copperOzInner","inner copper weight"], ["focusDim","focus dim"],
  ].forEach(([k, lbl]) => { if (b[k] !== a[k]) parts.push(lbl + " changed"); });

  return parts.join(" · ");
}

/* ---------- project save / load ---------- */
function _serializeLayer(l){
  return {
    // hosted (URL) layers persist only their link, never the bytes; uploaded layers
    // persist their dataURL as before
    id:l.id, name:l.name, side:l.side,
    dataURL: l.url ? "" : l.dataURL, url: l.url || null,
    visible:l.visible,
    opacity:l.opacity, tx:l.tx, ty:l.ty, scale:l.scale, rot:l.rot,
    mirror:l.mirror, locked:l.locked, warp:l.warp || null,
    // logical pixel size when the stored bitmap is a downscaled stand-in (multiplayer
    // image share) — the bitmap is stretched back to this on load so scale/warp math,
    // which assumes the ORIGINAL pixel dimensions, keeps working
    imgW: l.imgW || null, imgH: l.imgH || null,
  };
}

function serializeProject(){
  boardsSyncScalars();
  return JSON.stringify({
    app: "pcb-reveng", version: 2,
    pxPerMm: State.pxPerMm,
    viaR: State.viaR,
    viaHole: State.viaHole,
    traceW: State.traceW,
    compView: State.compView,
    traceView: State.traceView,
    overlapCheck: State.overlapCheck,
    refTextSize: State.refTextSize,
    copperOz: State.copperOz,
    copperOzInner: State.copperOzInner,
    focusDim: State.focusDim,
    _id: State._id,
    refCounters: State.refCounters,
    nets: State.nets,
    xlinks: State.xlinks,
    bomColumns: State.bomColumns,
    boardIdx: State.boardIdx,
    boards: State.boards.map(b => ({
      id: b.id, name: b.name, layerCount: b.layerCount || 2,
      // `_fp` is a RUNTIME footprint cache — never persist it. Saving it means a reloaded
      // project reuses the stale (possibly old-format) cached geometry instead of
      // regenerating from fpId+fpParams, which quietly breaks body hit-testing (e.g. the
      // shift-click → schematic jump) on loaded-but-not-freshly-placed parts.
      components: b.components.map(c => { const { _fp, ...rest } = c; return rest; }),
      vias: b.vias, traces: b.traces, notes: b.notes,
      schWires: b.schWires, schLabels: b.schLabels,
      layers: b.layers.map(_serializeLayer),
    })),
  });
}

/* stretch a decoded bitmap back to its logical pixel size when it's a downscaled
   stand-in (multiplayer image share stores small bytes + imgW/imgH). All layer
   transform math (scale, warp, tiles) assumes the ORIGINAL pixel dimensions. */
function fitBitmapTo(img, w, h){
  if (!w || !h || (img.width === w && img.height === h)) return img;
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(img, 0, 0, w, h);
  return cv;
}

function loadProject(json, done){
  const s = _wrapLegacyBoards(JSON.parse(json));
  if (s.app !== "pcb-reveng") throw new Error("Not a PCB RevEng project file");
  State.pxPerMm = s.pxPerMm || 10;
  State.viaR = s.viaR || 8;
  State.viaHole = s.viaHole || 3.6;
  State.traceW = s.traceW || 5;
  State.compView = s.compView || "side";
  State.traceView = s.traceView || "active";
  State.overlapCheck = s.overlapCheck !== false;
  State.refTextSize = s.refTextSize || 13;
  State.copperOz = s.copperOz || 1;
  State.copperOzInner = s.copperOzInner || 0.5;
  State.focusDim = (s.focusDim != null) ? s.focusDim : 0.16;
  State._id = s._id || 1;
  State.refCounters = s.refCounters || {};
  State.nets = s.nets || [];
  State.xlinks = s.xlinks || [];
  State.bomColumns = s.bomColumns || [];
  if (typeof Sch !== "undefined" && Sch.clearSelection){ Sch.clearSelection(); Sch._entered = false; }   // stale refs point at the old project's wires; re-fit the sheet to the new board
  Undo.stack.length = 0; Undo.redo.length = 0;
  _imgVault.clear(); _imgVaultSeq = 1;   // fresh project → drop any cached bitmaps

  // rebuild every page; each board carries its own layer list (bytes load async below)
  State.boards = (s.boards || []).map((sb, bi) => {
    const comps = sb.components || [];
    comps.forEach(c => { c._fp = null; });  // drop any persisted footprint cache → regenerate from fpId+fpParams
    return { id: sb.id != null ? sb.id : bi, name: sb.name || ("PCB " + (bi + 1)),
             layerCount: sb.layerCount || 2,
             layers: [], components: comps, vias: sb.vias || [], traces: sb.traces || [],
             notes: sb.notes || [], schWires: sb.schWires || [], schLabels: sb.schLabels || [] };
  });
  if (!State.boards.length) State.boards = [{ id: 0, name: "PCB 1", layerCount: 2,
    layers: [], components: [], vias: [], traces: [], notes: [], schWires: [], schLabels: [] }];
  State.boardIdx = Math.max(0, Math.min(State.boards.length - 1, s.boardIdx || 0));
  const ab = State.boards[State.boardIdx];
  for (const col of BOARD_COLS) State[col] = ab[col];
  State.layerCount = ab.layerCount || 2;
  if (typeof Boards !== "undefined" && Boards.refreshTabs) Boards.refreshTabs();

  const jobs = [];   // [board, meta] pairs across every page
  (s.boards || []).forEach((sb, bi) => {
    for (const m of (sb.layers || [])) jobs.push([State.boards[bi], m]);
  });
  let pending = jobs.length;
  if (!pending){ done && done(); return; }
  const settle = () => { if (--pending === 0 && done) done(); };
  for (const [board, m] of jobs){
    const layer = { ...m, img: null };
    board.layers.push(layer);
    if (m.url){
      // hosted layer — reload live from its URL. Try CORS first (keeps the canvas
      // readable for align/export), fall back to a plain load so it still shows on
      // servers without CORS headers.
      const attempt = (useCors) => {
        const img = new Image();
        if (useCors) img.crossOrigin = "anonymous";
        img.onload = () => { layer.img = img; settle(); };
        img.onerror = () => { if (useCors) attempt(false); else { layer.img = img; settle(); } };
        img.src = m.url;
      };
      attempt(true);
    } else if (!m.dataURL){
      // no stored bytes (e.g. the image store failed to save) — keep the layer imgless;
      // an empty img.src would resolve to the PAGE url ("Unsafe attempt to load URL…")
      settle();
    } else {
      const img = new Image();
      layer.img = img;
      img.onload = () => {
        // a downscaled multiplayer stand-in stretches back to its logical size
        const bmp = fitBitmapTo(img, m.imgW, m.imgH);
        layer.img = bmp;
        // rebuild the LOD tile pyramid for big uploaded images
        if (typeof ImageTiles !== "undefined" && ImageTiles.shouldTile(bmp)){
          const t = ImageTiles.build(bmp); if (t) layer.tiles = t;
        }
        settle();
      };
      img.onerror = settle;
      img.src = m.dataURL;
    }
  }
}

function resetProject(){
  State.pxPerMm = 10;
  State.layerCount = 2;
  State.viaR = 5;      // 1 mm Ø
  State.viaHole = 2.5; // 0.5 mm Ø
  State.traceW = 5;
  State.compView = "side";
  State.traceView = "active";
  State.overlapCheck = true;
  State.refTextSize = 13;
  State.copperOz = 1;
  State.copperOzInner = 0.5;
  State.focusDim = 0.16;
  State._id = 1;
  State.boards = [{ id: nextId(), name: "PCB 1", layerCount: 2,
                    layers: [], components: [], vias: [], traces: [],
                    notes: [], schWires: [], schLabels: [] }];
  State.boardIdx = 0;
  for (const col of BOARD_COLS) State[col] = State.boards[0][col];
  if (typeof Sch !== "undefined" && Sch.clearSelection){ Sch.clearSelection(); Sch._entered = false; }
  State.nets = [];
  State.xlinks = [];
  State.bomColumns = [];
  State.refCounters = {};
  if (typeof Boards !== "undefined" && Boards.refreshTabs) Boards.refreshTabs();
  Undo.stack.length = 0; Undo.redo.length = 0;
  _imgVault.clear(); _imgVaultSeq = 1;   // no undo history → cached bitmaps are unreachable
}
