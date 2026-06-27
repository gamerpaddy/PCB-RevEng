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

const State = {
  pxPerMm: 10,          // world px per millimetre (set with Measure tool)
  layerCount: 2,        // copper layers on the board (1,2,4,…,12)
  viaR: 8,              // via radius in world px (display/visibility, applies to all vias)
  traceW: 5,            // trace width in world px (applies to all traces)
  compView: "side",     // "side" = only viewed side fully drawn (other side: THT pads/vias only) | "both"
  traceView: "active",  // "active" = only active draw side's traces shown | "all"
  overlapCheck: true,   // warn when a moved pad overlaps another net
  bigMergeWarn: true,   // warn when joining two nets that each have >3 pads
  refTextSize: 13,      // component reference label size in px
  layers: [],           // {id,name,side,dataURL,img,visible,opacity,tx,ty,scale,rot,mirror,locked}
  components: [],       // {id,ref,value,part,fpId,fpParams,kicad,x,y,rot,side,scale,pins:[{num,name,netId,xmm,ymm}]}
  vias: [],             // {id,x,y,netId,r}
  traces: [],           // {id,side,netId,points:[{x,y}],width}
  nets: [],             // {id,name,color,auto}
  _id: 1,
  refCounters: {},      // prefix -> last number
};

function nextId(){ return State._id++; }

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

function createNet(name){
  const id = nextId();
  const auto = !name;
  if (!name) name = "N$" + id;
  const prot = PROTECTED_NET_NAMES.includes(name.toUpperCase());
  if (prot) name = name.toUpperCase();
  const color = prot ? (PROTECTED_COLORS[name] || "#66d96f")
                     : NET_COLORS[(State.nets.length) % NET_COLORS.length];
  const net = { id, name, color, auto, protected: prot };
  State.nets.push(net);
  return net;
}
function getNet(id){ return State.nets.find(n => n.id === id) || null; }
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

/* number of component pads on a net */
function netPinCount(netId){
  let n = 0;
  for (const c of State.components) for (const p of c.pins) if (p.netId === netId) n++;
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
  for (const c of State.components)
    for (const p of c.pins) if (p.netId === drop.id) p.netId = keep.id;
  for (const v of State.vias)   if (v.netId === drop.id) v.netId = keep.id;
  for (const t of State.traces) if (t.netId === drop.id) t.netId = keep.id;
  State.nets = State.nets.filter(n => n.id !== drop.id);
  return keep.id;
}

/* returns true on success, false if blocked by protection */
/* merge with a confirmation when both nets are large (>3 pads each).
   Returns the surviving net id, null if protection blocks it, or the sentinel
   MERGE_DECLINED if the user chose to keep them separate. */
const MERGE_DECLINED = "__declined__";
function mergeNetsChecked(aId, bId){
  if (aId === bId) return aId;
  if (State.bigMergeWarn && netPinCount(aId) > 3 && netPinCount(bId) > 3){
    const a = getNet(aId), b = getNet(bId);
    if (!confirm("Connect “" + (a?.name||"?") + "” (" + netPinCount(aId) + " pads) and “" +
                 (b?.name||"?") + "” (" + netPinCount(bId) + " pads)?\n\n" +
                 "Both are large nets — joining them by mistake is easy to miss.\n(Disable this warning in Options.)")){
      return MERGE_DECLINED;
    }
  }
  return mergeNets(aId, bId);
}

function renameNet(id, newName){
  newName = (newName || "").trim();
  if (!newName) return false;
  const net = getNet(id);
  if (!net) return false;
  if (net.protected && newName.toUpperCase() !== net.name){
    return false; // protected nets keep their name
  }
  const existing = findNetByName(newName) ||
                   (PROTECTED_NET_NAMES.includes(newName.toUpperCase()) ? findNetByName(newName.toUpperCase()) : null);
  if (existing && existing.id !== id){
    // renaming onto an existing net merges them
    return mergeNets(existing.id, id) !== null;
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
  for (const c of State.components)
    for (const p of c.pins)
      if (p.netId === netId) out.push({type:"pin", comp:c, pin:p});
  for (const v of State.vias)   if (v.netId === netId) out.push({type:"via", via:v});
  for (const t of State.traces) if (t.netId === netId) out.push({type:"trace", trace:t});
  return out;
}

/* delete nets with no members */
function pruneNets(){
  const used = new Set();
  for (const c of State.components) for (const p of c.pins) if (p.netId) used.add(p.netId);
  for (const v of State.vias)   if (v.netId) used.add(v.netId);
  for (const t of State.traces) if (t.netId) used.add(t.netId);
  State.nets = State.nets.filter(n => used.has(n.id) || !n.auto);
}

/* ---------- refdes ---------- */
function refExists(ref){ return State.components.some(c => c.ref === ref); }

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

/* ---------- lookups ---------- */
function getComp(id){ return State.components.find(c => c.id === id) || null; }
function getVia(id){ return State.vias.find(v => v.id === id) || null; }
function getTrace(id){ return State.traces.find(t => t.id === id) || null; }
function getLayer(id){ return State.layers.find(l => l.id === id) || null; }

/* ---------- undo / redo ---------- */
const Undo = { stack: [], redo: [], max: 25 };
try { Undo.max = Math.max(5, Math.min(200, parseInt(localStorage.getItem("pcbreveng.histLen"),10) || 25)); } catch(e){}

function snapshot(){
  return JSON.stringify({
    pxPerMm: State.pxPerMm,
    layerCount: State.layerCount,
    viaR: State.viaR,
    traceW: State.traceW,
    compView: State.compView,
    traceView: State.traceView,
    overlapCheck: State.overlapCheck,
    bigMergeWarn: State.bigMergeWarn,
    refTextSize: State.refTextSize,
    components: State.components,
    vias: State.vias,
    traces: State.traces,
    nets: State.nets,
    _id: State._id,
    refCounters: State.refCounters,
    layersMeta: State.layers.map(l => ({
      id:l.id, name:l.name, side:l.side, visible:l.visible, opacity:l.opacity,
      tx:l.tx, ty:l.ty, scale:l.scale, rot:l.rot, mirror:l.mirror, locked:l.locked,
      warp:l.warp || null
    })),
  });
}

function pushUndo(label){
  Undo.stack.push({ json: snapshot(), label: label || "edit", time: Date.now() });
  if (Undo.stack.length > Undo.max) Undo.stack.shift();
  Undo.redo.length = 0;
}

function applySnapshot(json){
  const s = JSON.parse(json);
  State.pxPerMm = s.pxPerMm;
  State.layerCount = s.layerCount || 2;
  State.viaR = s.viaR || 8;
  State.traceW = s.traceW || 5;
  State.compView = s.compView || "side";
  State.traceView = s.traceView || "active";
  State.overlapCheck = s.overlapCheck !== false;
  State.bigMergeWarn = s.bigMergeWarn !== false;
  State.refTextSize = s.refTextSize || 13;
  State.components = s.components;
  State.vias = s.vias;
  State.traces = s.traces;
  State.nets = s.nets;
  State._id = s._id;
  State.refCounters = s.refCounters;
  for (const m of s.layersMeta){
    const l = getLayer(m.id);
    if (l) Object.assign(l, m);
  }
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
  const entry = Undo.stack[i];
  const before = JSON.parse(entry.json);
  const after  = JSON.parse(i + 1 < Undo.stack.length ? Undo.stack[i+1].json : snapshot());
  pushUndo("revert: " + entry.label); // make the selective revert itself undoable (may shift indices)
  for (const col of ["components","vias","traces","nets"]){
    const bm = new Map(before[col].map(o => [o.id, o]));
    const am = new Map(after[col].map(o => [o.id, o]));
    const cur = State[col];
    // objects created by that action → remove
    for (const id of am.keys()){
      if (bm.has(id)) continue;
      const idx = cur.findIndex(o => o.id === id);
      if (idx >= 0) cur.splice(idx, 1);
    }
    // objects modified or deleted by that action → restore the "before" version
    for (const [id, bo] of bm){
      const ao = am.get(id);
      if (ao && JSON.stringify(ao) === JSON.stringify(bo)) continue;
      const copy = JSON.parse(JSON.stringify(bo));
      const idx = cur.findIndex(o => o.id === id);
      if (idx >= 0) cur[idx] = copy; else cur.push(copy);
    }
  }
  // image layer transforms
  const bl = new Map((before.layersMeta||[]).map(m => [m.id, m]));
  const al = new Map((after.layersMeta||[]).map(m => [m.id, m]));
  for (const [id, bo] of bl){
    const ao = al.get(id);
    if (ao && JSON.stringify(ao) === JSON.stringify(bo)) continue;
    const l = getLayer(id);
    if (l) Object.assign(l, bo);
  }
  if (before.pxPerMm !== after.pxPerMm) State.pxPerMm = before.pxPerMm;
  const idx = Undo.stack.indexOf(entry);
  if (idx >= 0) Undo.stack.splice(idx, 1); // the action is gone from the timeline
  State.components.forEach(c => c._fp = null);
  pruneNets();
  return true;
}

/* ---------- project save / load ---------- */
function serializeProject(){
  return JSON.stringify({
    app: "pcb-reveng", version: 1,
    pxPerMm: State.pxPerMm,
    layerCount: State.layerCount,
    viaR: State.viaR,
    traceW: State.traceW,
    compView: State.compView,
    traceView: State.traceView,
    overlapCheck: State.overlapCheck,
    bigMergeWarn: State.bigMergeWarn,
    refTextSize: State.refTextSize,
    _id: State._id,
    refCounters: State.refCounters,
    nets: State.nets,
    components: State.components,
    vias: State.vias,
    traces: State.traces,
    layers: State.layers.map(l => ({
      id:l.id, name:l.name, side:l.side, dataURL:l.dataURL, visible:l.visible,
      opacity:l.opacity, tx:l.tx, ty:l.ty, scale:l.scale, rot:l.rot,
      mirror:l.mirror, locked:l.locked, warp:l.warp || null
    })),
  });
}

function loadProject(json, done){
  const s = JSON.parse(json);
  if (s.app !== "pcb-reveng") throw new Error("Not a PCB RevEng project file");
  State.pxPerMm = s.pxPerMm || 10;
  State.layerCount = s.layerCount || 2;
  State.viaR = s.viaR || 8;
  State.traceW = s.traceW || 5;
  State.compView = s.compView || "side";
  State.traceView = s.traceView || "active";
  State.overlapCheck = s.overlapCheck !== false;
  State.bigMergeWarn = s.bigMergeWarn !== false;
  State.refTextSize = s.refTextSize || 13;
  State._id = s._id || 1;
  State.refCounters = s.refCounters || {};
  State.nets = s.nets || [];
  State.components = s.components || [];
  State.vias = s.vias || [];
  State.traces = s.traces || [];
  State.layers = [];
  Undo.stack.length = 0; Undo.redo.length = 0;
  const metas = s.layers || [];
  let pending = metas.length;
  if (!pending){ done && done(); return; }
  for (const m of metas){
    const img = new Image();
    const layer = { ...m, img };
    State.layers.push(layer);
    img.onload = img.onerror = () => { if (--pending === 0 && done) done(); };
    img.src = m.dataURL;
  }
}

function resetProject(){
  State.pxPerMm = 10;
  State.layerCount = 2;
  State.viaR = 8;
  State.traceW = 5;
  State.compView = "side";
  State.traceView = "active";
  State.overlapCheck = true;
  State.bigMergeWarn = true;
  State.refTextSize = 13;
  State.layers = [];
  State.components = [];
  State.vias = [];
  State.traces = [];
  State.nets = [];
  State._id = 1;
  State.refCounters = {};
  Undo.stack.length = 0; Undo.redo.length = 0;
}
