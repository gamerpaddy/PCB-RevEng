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
  viaR: 8,              // via radius in world px (display/visibility, applies to all vias)
  traceW: 5,            // trace width in world px (applies to all traces)
  compView: "side",     // "side" = only viewed side fully drawn (other side: THT pads/vias only) | "both"
  traceView: "active",  // "active" = only active draw side's traces shown | "all"
  overlapCheck: true,   // warn when a moved pad overlaps another net
  bigMergeWarn: true,   // warn when joining two nets that each have >3 pads
  refTextSize: 13,      // component reference label size in px
  copperOz: 1,          // outer-layer copper weight (oz/ft²) — trace current estimator
  copperOzInner: 0.5,   // inner-layer copper weight (oz/ft²) — usually lighter than outer
  focusDim: 0.16,       // opacity of non-selected objects when a net is focused (0..1)
  layers: [],           // {id,name,side,dataURL,img,visible,opacity,tx,ty,scale,rot,mirror,locked}
  components: [],       // {id,ref,value,part,fpId,fpParams,kicad,x,y,rot,side,scale,pins:[{num,name,netId,xmm,ymm}]}
  vias: [],             // {id,x,y,netId,r}
  traces: [],           // {id,side,netId,points:[{x,y}],width}
  notes: [],            // {id,x,y,text,color} — freeform sticky-note annotations pinned to board coords
  nets: [],             // {id,name,color,auto}
  bomColumns: [],       // custom BOM column names (MPN, Supplier, …); per-part values live in component.bom
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
function getNote(id){ return State.notes.find(n => n.id === id) || null; }

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
    copperOz: State.copperOz,
    copperOzInner: State.copperOzInner,
    focusDim: State.focusDim,
    components: State.components,
    vias: State.vias,
    traces: State.traces,
    notes: State.notes,
    nets: State.nets,
    bomColumns: State.bomColumns,
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
  State.copperOz = s.copperOz || 1;
  State.copperOzInner = s.copperOzInner || 0.5;
  State.focusDim = (s.focusDim != null) ? s.focusDim : 0.16;
  State.components = s.components;
  State.vias = s.vias;
  State.traces = s.traces;
  State.notes = s.notes || [];
  State.nets = s.nets;
  State.bomColumns = s.bomColumns || [];
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
  for (const col of ["components","vias","traces","notes","nets"]){
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
  if (b.side !== a.side)                         out.push("flipped");
  const pinNets = c => (c.pins||[]).map(p => p.netId || 0).join(",");
  if (pinNets(b) !== pinNets(a))                 out.push("net");
  const pinNC = c => (c.pins||[]).map(p => p.nc ? 1 : 0).join(",");
  if (pinNC(b) !== pinNC(a))                     out.push("no-connect");
  return out.length ? out.join(", ") : "edited";
}

function diffSnapshots(beforeJson, afterJson){
  let b, a;
  try { b = JSON.parse(beforeJson); a = JSON.parse(afterJson); } catch(e){ return ""; }
  const parts = [];
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
  for (const [col, noun] of [["vias","via"], ["traces","trace"], ["notes","note"]]){
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
  [ ["pxPerMm","scale"], ["layerCount","layer count"], ["viaR","via size"], ["traceW","trace width"],
    ["refTextSize","label size"], ["compView","component view"], ["traceView","trace view"],
    ["copperOz","copper weight"], ["copperOzInner","inner copper weight"], ["focusDim","focus dim"],
  ].forEach(([k, lbl]) => { if (b[k] !== a[k]) parts.push(lbl + " changed"); });

  return parts.join(" · ");
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
    copperOz: State.copperOz,
    copperOzInner: State.copperOzInner,
    focusDim: State.focusDim,
    _id: State._id,
    refCounters: State.refCounters,
    nets: State.nets,
    bomColumns: State.bomColumns,
    components: State.components,
    vias: State.vias,
    traces: State.traces,
    notes: State.notes,
    layers: State.layers.map(l => ({
      // hosted (URL) layers persist only their link, never the bytes; uploaded layers
      // persist their dataURL as before
      id:l.id, name:l.name, side:l.side,
      dataURL: l.url ? "" : l.dataURL, url: l.url || null,
      visible:l.visible,
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
  State.copperOz = s.copperOz || 1;
  State.copperOzInner = s.copperOzInner || 0.5;
  State.focusDim = (s.focusDim != null) ? s.focusDim : 0.16;
  State._id = s._id || 1;
  State.refCounters = s.refCounters || {};
  State.nets = s.nets || [];
  State.bomColumns = s.bomColumns || [];
  State.components = s.components || [];
  State.vias = s.vias || [];
  State.traces = s.traces || [];
  State.notes = s.notes || [];
  State.layers = [];
  Undo.stack.length = 0; Undo.redo.length = 0;
  const metas = s.layers || [];
  let pending = metas.length;
  if (!pending){ done && done(); return; }
  const settle = () => { if (--pending === 0 && done) done(); };
  for (const m of metas){
    const layer = { ...m, img: null };
    State.layers.push(layer);
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
    } else {
      const img = new Image();
      layer.img = img;
      img.onload = () => {
        // rebuild the LOD tile pyramid for big uploaded images
        if (typeof ImageTiles !== "undefined" && ImageTiles.shouldTile(img)){
          const t = ImageTiles.build(img); if (t) layer.tiles = t;
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
  State.viaR = 8;
  State.traceW = 5;
  State.compView = "side";
  State.traceView = "active";
  State.overlapCheck = true;
  State.bigMergeWarn = true;
  State.refTextSize = 13;
  State.copperOz = 1;
  State.copperOzInner = 0.5;
  State.focusDim = 0.16;
  State.layers = [];
  State.components = [];
  State.vias = [];
  State.traces = [];
  State.notes = [];
  State.nets = [];
  State.bomColumns = [];
  State._id = 1;
  State.refCounters = {};
  Undo.stack.length = 0; Undo.redo.length = 0;
}
