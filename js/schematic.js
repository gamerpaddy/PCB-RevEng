/* ===== schematic.js — editor tabs (Visual / Schematic / BOM) + schematic editor =====
   The Schematic tab (experimental, enabled in the Lab dialog) is an interactive
   arrangement editor over the SAME data the .kicad_sch exporter uses: symbols come
   from schGeometry() (netlist.js), positions/rotation/flips live on each component as
   schX/schY (schematic mm), schRot (R, CCW 90° steps) and schFlipH/schFlipV (X / Y) —
   serialized/undone with the component, exported as the "Manual" arrangement.
   All of this is SCHEMATIC-ONLY: nothing here touches the part's board x/y/rot/side.
   Thin blue ratlines (per-net MST) show which pins belong together; power nets
   (GND/VCC/+5V…) draw as fixed power symbols instead of wires; W draws 90°-snapped
   schematic wires (State.schWires) that must START on a pin, may only END on a pin of
   the same net, and colour green (fully connected net) / red (dangling or incomplete).
   Net labels: auto labels stick out of every connected pin (toolbar checkbox), and N
   pins a movable label object (State.schLabels) to the hovered pin.
   Everything reads State live, so the tab is always in sync with the board editor. */
"use strict";

/* Schematic editor is a standard feature now (on by default); still toggleable off. */
function SchEnabled(){
  try { return localStorage.getItem("pcbreveng.lab.schematic") !== "off"; } catch(e){ return true; }
}

/* ---------------- editor tabs ---------------- */
const EditorTabs = {
  current: "visual",

  show(name){
    if (name === "schematic" && !SchEnabled()) name = "visual";
    EditorTabs.current = name;
    $("#main").style.display           = name === "visual"    ? "" : "none";
    $("#schematic-pane").style.display = name === "schematic" ? "" : "none";
    $("#bom-pane").style.display       = name === "bom"       ? "" : "none";
    // leaving the schematic tab: kill the search-jump flash interval so it doesn't keep
    // firing renders at the hidden canvas for up to 5s
    if (name !== "schematic" && typeof Sch !== "undefined" && Sch._flashTimer){
      clearInterval(Sch._flashTimer); Sch._flashTimer = null; Sch.flashMark = null;
    }
    // the board tool / view button groups only apply to the visual editor —
    // the schematic and BOM tabs carry their own toolsets
    for (const sel of ["#toolbar", "#tb-view"]){
      const el = $(sel); if (el) el.style.display = name === "visual" ? "" : "none";
    }
    for (const [sel, n] of [["#tab-visual","visual"],["#tab-schematic","schematic"],["#tab-bom","bom"]])
      $(sel).classList.toggle("active", n === name);
    if (name === "visual"){ viewResize(); }
    else if (name === "schematic"){ Sch.enter(); }
    else if (name === "bom"){
      if (typeof loadKicadFootprints === "function") loadKicadFootprints();
      UI._renderBomTable();
    }
  },

  /* show/hide the Schematic tab with its Lab toggle (falling back to Visual if
     the tab being viewed just got disabled) */
  refreshLabTab(){
    const on = SchEnabled();
    $("#tab-schematic").style.display = on ? "" : "none";
    if (!on && EditorTabs.current === "schematic") EditorTabs.show("visual");
  },

  wire(){
    $("#tab-visual").addEventListener("click",    () => EditorTabs.show("visual"));
    $("#tab-schematic").addEventListener("click", () => EditorTabs.show("schematic"));
    $("#tab-bom").addEventListener("click",       () => EditorTabs.show("bom"));
    EditorTabs.refreshLabTab();
    // F1 / F2 / F3 switch tabs from anywhere (capture, ahead of the browser's F1 help)
    window.addEventListener("keydown", (e) => {
      if (!/^F[123]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.target && e.target.matches && e.target.matches("input,select,textarea")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      if (e.key === "F1") EditorTabs.show("visual");
      else if (e.key === "F2"){ if (SchEnabled()) EditorTabs.show("schematic"); else UI.toast("Schematic tab is off — enable it in 🔬 Experimental"); }
      else EditorTabs.show("bom");
    }, true);
  },
};

/* ---------------- schematic editor ---------------- */
const Sch = {
  canvas: null, ctx: null, dpr: 1,
  width: 0, height: 0,
  panX: 40, panY: 40, zoom: 5,     // zoom = screen px per schematic mm
  _geo: null,                      // cached schGeometry() Map (rebuilt after any board change)
  _queued: false,
  _entered: false,                 // first enter → zoom to fit
  mode: "select",                  // "select" | "wire" (W)
  drag: null,                      // {kind:...} — see pointerdown
  hover: null,                     // component under the cursor
  hotPin: null,                    // pin under the cursor in wire mode {comp,pin,pos}
  wireDraft: null,                 // {points:[{x,y}mm], a:{comp,pin}, preview:[{x,y}]|null}
  axisPref: null,                  // "h"|"v"|null — R while drafting toggles which leg comes first
  selWire: null,                   // primary clicked schematic wire (drag / delete anchor)
  selWires: null,                  // whole connected net highlighted with it (Delete removes all)
  selSeg: null,                    // shift-selected single segment {w,i} (Delete removes just that leg)
  selLabel: null,                  // selected manual net label (Delete removes it)
  boxSel: [],                      // box-selected components (schematic-local selection)
  _labelRects: [],                 // manual-label screen rects from the last render (hit test)
  _lastP: null, _lastEvt: null,    // last pointer canvas point / event (edge scroll re-drive)
  _edgeRAF: 0, _edgeVel: null,
};

const SCH_GRID = 1.27;             // KiCad half-grid — positions & wires snap to it

/* mm → screen px */
function schX2S(x){ return x * Sch.zoom + Sch.panX; }
function schY2S(y){ return y * Sch.zoom + Sch.panY; }
function schS2X(sx){ return (sx - Sch.panX) / Sch.zoom; }
function schS2Y(sy){ return (sy - Sch.panY) / Sch.zoom; }
const schSnap = (v) => Math.round(v / SCH_GRID) * SCH_GRID;

/* auto net labels on/off (toolbar checkbox, retained) */
function schAutoLabelsOn(){
  try { return localStorage.getItem("pcbreveng.sch.autoLabels") !== "off"; } catch(e){ return true; }
}

Sch.invalidate = () => { Sch._geo = null; };
Sch.geo = () => (Sch._geo || (Sch._geo = schGeometry()));

Sch.requestRender = () => {
  if (Sch._queued) return;
  Sch._queued = true;
  requestAnimationFrame(() => { Sch._queued = false; if (EditorTabs.current === "schematic") Sch.render(); });
};

/* local symbol point (mm, +y up) → rotated/flipped offset, honouring schFlipH/V.
   Flips are applied in symbol space BEFORE the rotation, matching the canvas draw
   order (rotate then scale). */
function schXf(c, x, y){
  return schRot2d(x * (c.schFlipH ? -1 : 1), y * (c.schFlipV ? -1 : 1), schRotOf(c));
}

/* X/Y are CANVAS axes, not symbol axes: toggle the symbol-space flip flag that
   mirrors along the requested SCREEN axis. A 90/270 rotation swaps the axes (the
   symbol's x-axis is drawn vertically), so X and Y swap which flag they touch. */
function schFlipComp(c, vert){
  const useV = (schRotOf(c) % 180 !== 0) ? !vert : vert;
  if (useV) c.schFlipV = !c.schFlipV; else c.schFlipH = !c.schFlipH;
}

/* a pin's position in schematic mm (y down), honouring rotation + flips */
function schPinPos(c, i, geo){
  const g = (geo || Sch.geo()).get(c.id);
  if (!g || typeof c.schX !== "number") return null;
  const pg = g.pins[i]; if (!pg) return null;
  const r = schXf(c, pg.x, pg.y);
  return { x: c.schX + r.x, y: c.schY - r.y };
}

/* a pin's effective direction (deg, +y-up convention: 0=points right/inward) after
   the symbol's flips + rotation. Pin angles point TOWARD the body; the label side
   is the opposite direction. */
function schPinEffAngle(c, pg){
  let a = pg.angle || 0;
  if (c.schFlipH) a = 180 - a;
  if (c.schFlipV) a = -a;
  return ((a + schRotOf(c)) % 360 + 360) % 360;
}

/* the symbol's axis-aligned half-extents after rotation (90/270 swap w/h) */
function schHalfExt(c, g){
  const swap = schRotOf(c) % 180 !== 0;
  return { hw: (swap ? g.h : g.w)/2, hh: (swap ? g.w : g.h)/2 };
}

/* power nets draw as fixed symbols (GND bar / supply arrow) instead of ratlines */
function schIsPowerNet(net){
  return !!net && (net.protected || /^(gnd|agnd|dgnd|vss|vee|vcc|vdd|vbat|[+-]?\d+(\.\d+)?v\d*)$/i.test(net.name));
}
function schIsGroundNet(net){ return !!net && /gnd|vss|vee/i.test(net.name); }

/* another wire of the same net whose copper the point sits on (mm), or null —
   the geometric test behind wire→wire junctions (T intersections) */
function schWireOnPoint(p, except, wires){
  for (const w of wires){
    if (w === except) continue;
    const pts = w.points;
    for (let i = 0; i + 1 < pts.length; i++)
      if (distToSeg(p.x, p.y, pts[i], pts[i+1]) <= 0.05) return w;
  }
  return null;
}

/* every wire electrically connected to `w` (transitively): shared net + a shared
   anchored pin, or one wire's endpoint sitting on the other (T junction / touching
   ends). Missing netId acts as a wildcard, matching the render's same-net logic. */
function schConnectedWires(w){
  const all = State.schWires;
  const netEq = (a, b) => !a.netId || !b.netId || a.netId === b.netId;
  const anchorsOf = x => [x.a, x.b].filter(Boolean).map(an => an.comp + ":" + an.pin);
  const endsOf = x => [x.points[0], x.points[x.points.length - 1]];
  const touches = (a, b) => {
    const aa = anchorsOf(a), bb = anchorsOf(b);
    if (aa.some(k => bb.includes(k))) return true;
    if (endsOf(a).some(p => schWireOnPoint(p, a, [b]))) return true;
    if (endsOf(b).some(p => schWireOnPoint(p, b, [a]))) return true;
    return false;
  };
  const result = new Set([w]);
  const queue = [w];
  while (queue.length){
    const cur = queue.pop();
    for (const other of all){
      if (result.has(other)) continue;
      if (netEq(cur, other) && touches(cur, other)){ result.add(other); queue.push(other); }
    }
  }
  return [...result];
}

/* ---------- net connectivity ----------
   Per non-power net, union its pins into connected GROUPS. Joins come from: drawn
   wires (anchored to a pin, or a wire END sitting on another same-net wire = a T
   junction), pins physically stacked on the same point (touching), and shared NET
   LABELS — two pins each carrying a manual net label of the same net are declared
   connected (a named node), exactly like KiCad labels. Returns
   Map netId -> {groups:[[{key,x,y}]...], complete}; complete = all pins in ONE group
   (single-pin nets count complete). Ratlines are drawn BETWEEN the groups so the
   missing links are visible; a wire colours green only when its net is complete. */
function schConnectivity(comps, geo, ignoreLabels){
  geo = geo || Sch.geo();
  comps = comps || State.components.filter(c => geo.has(c.id) && typeof c.schX === "number");
  const pinsByNet = new Map();                  // netId -> [{key,x,y}]
  for (const c of comps){
    if (typeof c.schX !== "number") continue;
    for (let i = 0; i < c.pins.length; i++){
      const nid = c.pins[i].netId;
      if (!nid || schIsPowerNet(getNet(nid))) continue;
      const p = schPinPos(c, i, geo); if (!p) continue;
      let a = pinsByNet.get(nid); if (!a) pinsByNet.set(nid, a = []);
      a.push({ key: c.id + ":" + i, x: p.x, y: p.y });
    }
  }
  const labelled = new Set(State.schLabels.map(l => l.comp + ":" + l.pin));
  const out = new Map();
  for (const [nid, pins] of pinsByNet){
    const idx = new Map(); const par = [];
    const node = (k) => { let i = idx.get(k); if (i == null){ i = par.length; par.push(i); idx.set(k, i); } return i; };
    const find = (i) => { while (par[i] !== i){ par[i] = par[par[i]]; i = par[i]; } return i; };
    const union = (a, b) => { par[find(a)] = find(b); };
    const pinNodes = pins.map(p => node(p.key));
    // pins stacked on the same point are directly connected (touching)
    for (let i = 0; i < pins.length; i++)
      for (let j = i + 1; j < pins.length; j++)
        if (Math.abs(pins[i].x - pins[j].x) < 0.02 && Math.abs(pins[i].y - pins[j].y) < 0.02)
          union(pinNodes[i], pinNodes[j]);
    // shared net labels → one common bus node for every labelled pin of the net.
    // The exporter passes ignoreLabels=true: for the LABEL-STRIP gate a net counts as
    // "complete" only when wires/contact truly join it, NOT when manual labels bridge it
    // (those labels are never exported, so a label-only net would electrically split in
    // KiCad if its pin labels were stripped as "already wired").
    if (!ignoreLabels){
      let busN = null;
      for (let i = 0; i < pins.length; i++)
        if (labelled.has(pins[i].key)){ if (busN == null) busN = node("lbl:" + nid); union(pinNodes[i], busN); }
    }
    // drawn wires (anchored ends + wire→wire T junctions). A wire's effective net is
    // re-derived from its anchors so a wire drawn while its pin was net-less still counts.
    const wires = State.schWires.filter(w => schWireNet(w) === nid);
    for (const w of wires){
      const wn = node("w:" + w.id);
      const ends = [[w.a, w.points[0]], [w.b, w.points[w.points.length - 1]]];
      for (const [an, p] of ends){
        if (an){ const t = idx.get(an.comp + ":" + an.pin); if (t != null) union(wn, t); }
        else { const hit = schWireOnPoint(p, w, wires); if (hit) union(wn, node("w:" + hit.id)); }
      }
    }
    const groups = new Map();
    for (let i = 0; i < pins.length; i++){ const r = find(pinNodes[i]); let g = groups.get(r); if (!g) groups.set(r, g = []); g.push(pins[i]); }
    const arr = [...groups.values()];
    out.set(nid, { groups: arr, complete: arr.length <= 1 });
  }
  return out;
}

/* {complete} view over schConnectivity for the .kicad_sch exporter (label gating) */
function schNetStatus(){
  const stat = new Map();
  // ignoreLabels=true — a net may skip its exported labels only when wires/contact fully
  // connect it, not when manual (never-exported) net labels are the only thing joining it
  for (const [nid, info] of schConnectivity(null, Sch.geo(), true)) stat.set(nid, { complete: info.complete });
  return stat;
}

/* nets whose (2+) pins ALL sit stacked on one point — they're connected by contact,
   so their auto net labels would be pure noise and are suppressed */
function schFullyTouchingNets(comps, geo){
  const m = new Map();                          // netId -> {x,y,n,same}
  for (const c of comps){
    for (let i = 0; i < c.pins.length; i++){
      const nid = c.pins[i].netId; if (!nid) continue;
      const p = schPinPos(c, i, geo); if (!p) continue;
      const e = m.get(nid);
      if (!e) m.set(nid, { x: p.x, y: p.y, n: 1, same: true });
      else { e.n++; if (Math.abs(e.x - p.x) > 0.02 || Math.abs(e.y - p.y) > 0.02) e.same = false; }
    }
  }
  const out = new Set();
  for (const [nid, e] of m) if (e.same && e.n > 1) out.add(nid);
  return out;
}

/* same-net pin pairs that currently sit on the exact same point, where only ONE side
   is in `moving` — captured at drag start so pulling them apart can leave a wire behind */
function schTouchingPairs(moving){
  const geo = Sch.geo();
  const set = new Set(moving);
  const out = [];
  for (const c of moving){
    if (typeof c.schX !== "number") continue;
    for (let i = 0; i < c.pins.length; i++){
      const nid = c.pins[i].netId; if (!nid) continue;
      const p = schPinPos(c, i, geo); if (!p) continue;
      for (const o of State.components){
        if (set.has(o) || typeof o.schX !== "number") continue;   // both moving → stay touching
        for (let j = 0; j < o.pins.length; j++){
          if (o.pins[j].netId !== nid) continue;
          const q = schPinPos(o, j, geo); if (!q) continue;
          if (Math.abs(p.x - q.x) < 0.02 && Math.abs(p.y - q.y) < 0.02)
            out.push({ a: { comp: c.id, pin: i }, b: { comp: o.id, pin: j }, netId: nid });
        }
      }
    }
  }
  return out;
}

/* after a drag: touching pairs that were pulled apart get a real wire in their place
   (part of the move's undo step — pushUndo already ran when the drag armed) */
function schSpawnTouchWires(pairs){
  const geo = Sch.geo();
  let made = 0;
  const key = (an) => an.comp + ":" + an.pin;
  for (const t of pairs){
    const ca = getComp(t.a.comp), cb = getComp(t.b.comp);
    if (!ca || !cb) continue;
    const pa = schPinPos(ca, t.a.pin, geo), pb = schPinPos(cb, t.b.pin, geo);
    if (!pa || !pb) continue;
    if (Math.abs(pa.x - pb.x) < 0.02 && Math.abs(pa.y - pb.y) < 0.02) continue;   // still touching
    if (State.schWires.some(w => w.a && w.b &&
        ((key(w.a) === key(t.a) && key(w.b) === key(t.b)) ||
         (key(w.a) === key(t.b) && key(w.b) === key(t.a))))) continue;            // already wired
    const pts = [{ x: pa.x, y: pa.y }];
    for (const q of schOrthoPath(pa, pb, null)) pts.push({ x: q.x, y: q.y });
    State.schWires.push({ id: nextId(), netId: t.netId, points: pts, a: { ...t.a }, b: { ...t.b } });
    made++;
  }
  if (made) UI.toast("Touching pins pulled apart — " + made + " wire" + (made === 1 ? "" : "s") + " keep" + (made === 1 ? "s" : "") + " them connected");
}

const SCH_WIRE_OK  = "#54c66a";
const SCH_WIRE_BAD = "#e05555";

/* components that never got a schematic position → seed them from the manual
   arrangement. Passive default — not an undo step. */
Sch.ensurePositions = () => {
  const has = (c) => typeof c.schX === "number" && typeof c.schY === "number";
  if (State.components.every(has)) return;
  const pos = schArrangeManual(Sch.geo());
  for (const c of State.components){
    if (has(c)) continue;
    const p = pos.get(c.id);
    if (p){ c.schX = p.x; c.schY = p.y; }
  }
  markDirty();
};

Sch.resize = () => {
  const wrap = $("#sch-canvas-wrap");
  if (!wrap || !Sch.canvas) return;
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  Sch.canvas.width  = Math.max(1, Math.round(r.width  * dpr));
  Sch.canvas.height = Math.max(1, Math.round(r.height * dpr));
  Sch.width = r.width; Sch.height = r.height; Sch.dpr = dpr;
};

Sch.enter = () => {
  Sch.resize();
  Sch.invalidate();
  Sch.ensurePositions();
  if (!Sch._entered){ Sch._entered = true; Sch.fit(); }
  Sch.render();
};

/* drop a transient red locator ring (schematic mm coords) that fades out over ~5s,
   so a search jump makes it obvious exactly where it panned/zoomed you to */
Sch.flashAt = (x, y) => {
  if (Sch._flashTimer){ clearInterval(Sch._flashTimer); Sch._flashTimer = null; }
  Sch.flashMark = { x, y, t0: (typeof performance !== "undefined" ? performance.now() : Date.now()) };
  Sch.render();
  Sch._flashTimer = setInterval(() => {
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (!Sch.flashMark || now - Sch.flashMark.t0 >= 5000){
      clearInterval(Sch._flashTimer); Sch._flashTimer = null; Sch.flashMark = null;
    }
    Sch.requestRender();   // no-op when the schematic tab isn't showing (guards the hidden canvas)
  }, 60);
};

/* centre + zoom the schematic view on one component (cross-jump from the board) */
Sch.focusComp = (c) => {
  Sch.ensurePositions();
  if (typeof c.schX !== "number") return;
  Sch.resize();
  Sch.zoom = Math.max(Sch.zoom, 8);
  Sch.panX = Sch.width/2  - c.schX * Sch.zoom;
  Sch.panY = Sch.height/2 - c.schY * Sch.zoom;
  UI.select({ type: "comp", comp: c });
  Sch.flashAt(c.schX, c.schY);
  Sch.render();
};

/* centre + select a single pin (pad) of a component in the schematic */
Sch.focusPin = (c, pinIdx) => {
  Sch.ensurePositions();
  if (typeof c.schX !== "number") return;
  Sch.resize();
  const geo = Sch.geo();
  const p = schPinPos(c, pinIdx, geo);
  Sch.zoom = Math.max(Sch.zoom, 9);
  const tx = p ? p.x : c.schX, ty = p ? p.y : c.schY;
  Sch.panX = Sch.width/2  - tx * Sch.zoom;
  Sch.panY = Sch.height/2 - ty * Sch.zoom;
  UI.select({ type: "pin", comp: c, pinIdx });
  Sch.flashAt(tx, ty);
  Sch.render();
};

/* jump the other way: show a schematic part on the board, zoomed + selected */
function schJumpToVisual(c){
  EditorTabs.show("visual");
  const r = Math.max(20, compRadius(c));
  View.zoom = Math.max(View.zoom, Math.min(12, View.width / (r * 10)));
  UI.jumpToComp(c);
  UI.toast(c.ref + " on the board");
}

/* Re-arranging moves every symbol, so any hand-drawn wires would be left dangling.
   Warn (if there are wires) and, on confirm, report that the caller should clear them.
   Returns false if the user backed out. Caller pushes undo, then clears on true. */
Sch.confirmArrangeClearsWires = () => {
  const n = State.schWires.length;
  if (!n) return true;
  return confirm("Re-arranging will move every symbol, so the " + n + " schematic wire" +
    (n === 1 ? "" : "s") + " you've drawn will be cleared.\n\nContinue? (undoable)");
};

/* AI auto-arrange: ask the model where to place each part, then apply + de-overlap */
Sch.arrangeAI = async () => {
  if (typeof AI === "undefined" || !AI.enabled("arrange")){
    UI.toast("Enable AI schematic auto-arrange in 🔬 Experimental → AI Connect first"); return;
  }
  if (!Sch.confirmArrangeClearsWires()) return;
  (UI.warn || UI.toast)("AI is arranging the schematic… (may take a moment / cost a request) — debug log in 🔬 Experimental → AI Connect");
  try {
    const placements = await AI.arrangeSchematic();
    const byRef = new Map(placements.map(p => [String(p.ref), p]));
    pushUndo("AI arrange schematic");
    // the UI stayed live during the await — re-check for wires NOW (not the pre-await
    // snapshot) so wires drawn meanwhile are cleared instead of left dangling on the
    // moved symbols, and clear every stale wire selection.
    const hadWires = State.schWires.length > 0;
    if (hadWires){ State.schWires = []; Sch.selWire = null; Sch.selWires = null; Sch.selSeg = null; }
    let n = 0;
    for (const c of State.components){
      const p = byRef.get(String(c.ref));
      if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
      c.schX = schSnap(p.x); c.schY = schSnap(p.y);
      if (typeof p.rot === "number") c.schRot = ((Math.round(p.rot/90)*90) % 360 + 360) % 360;
      schUpdateWiresFor(c); n++;
    }
    Sch.invalidate(); Sch.fit();
    UI.toast("AI placed " + n + " symbol" + (n===1?"":"s") +
      (hadWires ? " — wires cleared" : "") + " — undoable");
  } catch(err){ UI.warn ? UI.warn("AI arrange failed: " + err.message) : UI.toast("AI arrange failed: " + err.message); }
};

Sch.fit = () => {
  const geo = Sch.geo();
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,any=false;
  for (const c of State.components){
    const g = geo.get(c.id);
    if (!g || typeof c.schX !== "number") continue;
    const swap = schRotOf(c) % 180 !== 0;
    const hw = (swap ? g.bh : g.bw)/2, hh = (swap ? g.bw : g.bh)/2;
    minX=Math.min(minX,c.schX-hw); maxX=Math.max(maxX,c.schX+hw);
    minY=Math.min(minY,c.schY-hh); maxY=Math.max(maxY,c.schY+hh);
    any=true;
  }
  for (const w of State.schWires) for (const p of w.points){
    minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x);
    minY=Math.min(minY,p.y); maxY=Math.max(maxY,p.y); any=true;
  }
  if (!any){ Sch.panX = 40; Sch.panY = 40; Sch.zoom = 5; Sch.render(); return; }
  const w = maxX-minX || 1, h = maxY-minY || 1;
  Sch.zoom = Math.max(0.4, Math.min(40, Math.min(Sch.width/w, Sch.height/h) * 0.9));
  Sch.panX = Sch.width/2  - (minX+maxX)/2 * Sch.zoom;
  Sch.panY = Sch.height/2 - (minY+maxY)/2 * Sch.zoom;
  Sch.render();
};

/* ---------- symbol-body primitives ----------
   schGeometry's bodies are KiCad s-expression strings (built by _pl/_rc/_ac in
   netlist.js). Parse the three shapes they can contain into drawable primitives.
   Local symbol coords are mm with +y UP (KiCad convention) — flipped when drawn. */
const _schBodyCache = new Map();
function schParseBody(str){
  if (_schBodyCache.has(str)) return _schBodyCache.get(str);
  let out = null, m;
  if ((m = /^\(polyline \(pts (.+?)\)\s*\(stroke/.exec(str))){
    const pts = [...m[1].matchAll(/\(xy (-?[\d.]+) (-?[\d.]+)\)/g)].map(x => [ +x[1], +x[2] ]);
    const fm = /\(fill \(type (\w+)\)\)/.exec(str);
    out = { kind:"poly", pts, fill: fm ? fm[1] : "none" };
  } else if ((m = /^\(rectangle \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\)/.exec(str))){
    const fm = /\(fill \(type (\w+)\)\)/.exec(str);
    out = { kind:"rect", x1:+m[1], y1:+m[2], x2:+m[3], y2:+m[4], fill: fm ? fm[1] : "none" };
  } else if ((m = /^\(arc \(start (-?[\d.]+) (-?[\d.]+)\) \(mid (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\)/.exec(str))){
    out = { kind:"arc", sx:+m[1], sy:+m[2], mx:+m[3], my:+m[4], ex:+m[5], ey:+m[6] };
  }
  _schBodyCache.set(str, out);
  return out;
}

/* Drop every schematic-local selection/interaction reference. Call after any wholesale
   State swap (undo/redo, project load/reset) or bulk wire clear (arrange), because those
   REPLACE the very objects these fields point at — a stale selSeg/selWire otherwise still
   references a wire that no longer exists in State.schWires, and a Delete on it can even
   resurrect the deleted wire's fragments (see Sch.deleteSegment). */
Sch.clearSelection = () => {
  Sch.selWire = null; Sch.selWires = null; Sch.selSeg = null; Sch.selLabel = null;
  Sch.boxSel = []; Sch.hover = null; Sch.drag = null;
  Sch.wireDraft = null; Sch.hotPin = null;
};

/* ---------- rendering ---------- */
Sch.render = () => {
  const cv = Sch.canvas; if (!cv) return;
  const ctx = Sch.ctx;
  ctx.setTransform(Sch.dpr, 0, 0, Sch.dpr, 0, 0);
  ctx.fillStyle = "#0d0f12";
  ctx.fillRect(0, 0, Sch.width, Sch.height);

  Sch.ensurePositions();
  const geo = Sch.geo();
  const comps = State.components.filter(c => geo.has(c.id) && typeof c.schX === "number");

  if (!comps.length){
    ctx.fillStyle = "#5a6470";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No components yet — place parts in the Visual editor, they appear here automatically.", Sch.width/2, Sch.height/2);
    ctx.textAlign = "left";
    return;
  }

  // drop labels whose component/pin no longer exists (part deleted on the board)
  if (State.schLabels.length){
    const ok = (l) => { const c = getComp(l.comp); return c && c.pins[l.pin]; };
    if (State.schLabels.some(l => !ok(l))) State.schLabels = State.schLabels.filter(ok);
    if (Sch.selLabel && !State.schLabels.includes(Sch.selLabel)) Sch.selLabel = null;
  }

  const conn = schConnectivity(comps, geo);
  schDrawRatlines(ctx, comps, geo, conn);
  schDrawWires(ctx, conn);
  schDrawJunctions(ctx);
  for (const c of comps) schDrawSymbol(ctx, c, geo.get(c.id));
  schDrawPowerPins(ctx, comps, geo);
  schDrawNetLabels(ctx, comps, geo);
  schDrawWireDraft(ctx);
  schDrawHotPin(ctx);
  schDrawMarquee(ctx);

  // transient red locator ring from a search jump — fades out over 5s
  if (Sch.flashMark){
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const a = Math.max(0, 1 - (now - Sch.flashMark.t0) / 5000);
    if (a > 0){
      const X = schX2S(Sch.flashMark.x), Y = schY2S(Sch.flashMark.y);
      const r = Math.max(14, Sch.zoom * 3);
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = "#ff2b2b"; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.arc(X, Y, r*0.5, 0, Math.PI*2); ctx.stroke();
      ctx.restore();
    }
  }
};

/* thin blue ratlines: for each INCOMPLETE net, draw airwires BETWEEN its connected
   groups (a link lands on the nearest pin pair across the two groups) so the missing
   connections — and only the missing ones — are shown. Fully-connected nets (wired
   or net-labelled) draw nothing. */
function schDrawRatlines(ctx, comps, geo, conn){
  conn = conn || schConnectivity(comps, geo);
  const byNet = new Map();                          // netId -> [ [screenPt...] per group ]
  for (const [nid, info] of conn){
    if (info.complete) continue;                    // fully connected → no ratlines
    byNet.set(nid, info.groups.map(g => g.map(p => ({ x: schX2S(p.x), y: schY2S(p.y) }))));
  }
  const dragComp = Sch.drag && (Sch.drag.comp || (Sch.drag.group && Sch.drag.group[0] && Sch.drag.group[0].c));
  const hotNets = new Set();
  if (dragComp) for (const pin of dragComp.pins) if (pin.netId) hotNets.add(pin.netId);
  // wire tool: light up the net being routed (draft in progress, else the hovered pin's
  // net) so the airwires show where the wire still has to go
  let wireFocus = false;
  if (Sch.mode === "wire"){
    const nid = Sch.wireDraft ? (schNetOfAnchor(Sch.wireDraft.a) || Sch.wireDraft.netId)
              : (Sch.hotPin ? (Sch.hotPin.comp.pins[Sch.hotPin.pin] || {}).netId : null);
    if (nid){ hotNets.add(nid); wireFocus = true; }
  }

  const pass = (hot) => {
    ctx.strokeStyle = hot ? "#7ec3ff" : "#3f9bff";
    ctx.lineWidth = hot ? 1.8 : 1;
    ctx.globalAlpha = hot ? 1 : ((dragComp || wireFocus) ? 0.35 : 0.75);
    ctx.beginPath();
    for (const [netId, groups] of byNet){
      if (hotNets.has(netId) !== hot) continue;
      schPathGroups(ctx, groups);
    }
    ctx.stroke();
    if (hot){                                        // mark the still-unconnected pins
      ctx.fillStyle = "#7ec3ff";
      for (const [netId, groups] of byNet){
        if (!hotNets.has(netId)) continue;
        for (const g of groups) for (const p of g){ ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); }
      }
    }
  };
  pass(false);
  if (hotNets.size) pass(true);
  ctx.globalAlpha = 1;
}

/* airwires linking a net's disconnected GROUPS: MST over group centroids, but each
   link is drawn between the nearest pin pair across the two groups (so it touches
   real pins, showing exactly where a wire is still needed). Centroid star when the
   net is very fragmented. */
function schPathGroups(ctx, groups){
  const n = groups.length;
  if (n < 2) return;
  const reps = groups.map(g => { let x=0,y=0; for (const p of g){ x+=p.x; y+=p.y; } return { x:x/g.length, y:y/g.length }; });
  if (n > 60){
    let cx=0, cy=0; for (const r of reps){ cx+=r.x; cy+=r.y; } cx/=n; cy/=n;
    for (const r of reps){ ctx.moveTo(r.x, r.y); ctx.lineTo(cx, cy); }
    return;
  }
  const inTree = new Array(n).fill(false), dist = new Array(n).fill(Infinity), from = new Array(n).fill(0);
  inTree[0] = true;
  for (let i = 1; i < n; i++){ const dx = reps[i].x-reps[0].x, dy = reps[i].y-reps[0].y; dist[i] = dx*dx+dy*dy; }
  for (let k = 1; k < n; k++){
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!inTree[i] && dist[i] < bd){ bd = dist[i]; best = i; }
    if (best < 0) break;
    inTree[best] = true;
    const pr = schNearestPair(groups[from[best]], groups[best]);
    ctx.moveTo(pr[0].x, pr[0].y); ctx.lineTo(pr[1].x, pr[1].y);
    for (let i = 0; i < n; i++){
      if (inTree[i]) continue;
      const dx = reps[i].x-reps[best].x, dy = reps[i].y-reps[best].y;
      const d = dx*dx+dy*dy;
      if (d < dist[i]){ dist[i] = d; from[i] = best; }
    }
  }
}

/* nearest pin pair between two screen-space groups (capped for huge groups) */
function schNearestPair(ga, gb){
  const A = ga.length > 24 ? ga.slice(0, 24) : ga;
  const B = gb.length > 24 ? gb.slice(0, 24) : gb;
  let bd = Infinity, ra = A[0], rb = B[0];
  for (const p of A) for (const q of B){
    const dx = p.x-q.x, dy = p.y-q.y, d = dx*dx+dy*dy;
    if (d < bd){ bd = d; ra = p; rb = q; }
  }
  return [ra, rb];
}

/* fixed power symbols: a GND bar / supply tick + name on each pin of a power net —
   replaces their airwires entirely (KiCad-style, far fewer wires). The symbol
   extends OUTWARD in the pin's own direction (honouring rotation/flips), so a
   left/right pin gets a sideways-leading symbol instead of one drawn over the
   part; the net-name text itself stays upright. */
function schDrawPowerPins(ctx, comps, geo){
  const s = Sch.zoom;
  const showText = s > 2.2;
  ctx.lineWidth = Math.max(1, Math.min(2, 0.22 * s));
  for (const c of comps){
    const g = geo.get(c.id);
    for (let i = 0; i < c.pins.length; i++){
      const pin = c.pins[i];
      if (!pin.netId) continue;
      const net = getNet(pin.netId);
      if (!schIsPowerNet(net)) continue;
      const p = schPinPos(c, i, geo); if (!p) continue;
      const pg = g && g.pins[i];
      const X = schX2S(p.x), Y = schY2S(p.y);
      const gnd = schIsGroundNet(net);
      // pin angles point INWARD (toward the body) — the symbol leads the other way
      const out = pg ? (schPinEffAngle(c, pg) + 180) % 360 : (gnd ? 270 : 90);
      const dirX = Math.cos(out * Math.PI/180), dirY = -Math.sin(out * Math.PI/180);  // screen
      ctx.strokeStyle = ctx.fillStyle = gnd ? "#9aa3ad" : "#ff8080";
      // draw in a frame where local +y = the outward direction
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(Math.atan2(-dirX, dirY));
      ctx.beginPath();
      let tipMm;                       // where (along the lead) the text hangs off
      if (gnd){                        // lead out + 3 shrinking bars
        ctx.moveTo(0, 0); ctx.lineTo(0, 1.5*s);
        ctx.moveTo(-1.1*s, 1.5*s); ctx.lineTo(1.1*s, 1.5*s);
        ctx.moveTo(-0.7*s, 2.0*s); ctx.lineTo(0.7*s, 2.0*s);
        ctx.moveTo(-0.3*s, 2.5*s); ctx.lineTo(0.3*s, 2.5*s);
        tipMm = 3.3;
      } else {                         // lead out + supply bar
        ctx.moveTo(0, 0); ctx.lineTo(0, 1.5*s);
        ctx.moveTo(-0.9*s, 1.5*s); ctx.lineTo(0.9*s, 1.5*s);
        tipMm = 2.0;
      }
      ctx.stroke();
      ctx.restore();
      // upright net name just past the symbol tip, out in the same direction
      if (showText && !(gnd && /^gnd$/i.test(net.name))){
        ctx.font = (gnd ? 1.1 : 1.2) * s + "px sans-serif";
        const tx = X + dirX * tipMm * s, ty = Y + dirY * tipMm * s;
        if (out === 0){        ctx.textAlign = "left";   ctx.fillText(net.name, tx + 0.3*s, ty + 0.4*s); }
        else if (out === 180){ ctx.textAlign = "right";  ctx.fillText(net.name, tx - 0.3*s, ty + 0.4*s); }
        else if (out === 90){  ctx.textAlign = "center"; ctx.fillText(net.name, tx, ty - 0.3*s); }        // up
        else {                 ctx.textAlign = "center"; ctx.fillText(net.name, tx, ty + 1.1*s); }        // down
      }
    }
  }
  ctx.textAlign = "left";
}

/* ---------- net labels ----------
   Auto labels (checkbox): every connected, non-power pin shows its net name just
   past the pin tip, sticking OUT in the pin's direction — faint, display only.
   Manual labels (N / context menu, State.schLabels): stronger, selectable, movable;
   they follow their pin when the part moves/rotates/flips. */
function schDrawNetLabels(ctx, comps, geo){
  Sch._labelRects = [];
  const s = Sch.zoom;
  if (s <= 2.2) return;
  const fpx = Math.max(8, 1.15 * s);
  ctx.font = fpx + "px sans-serif";
  const manual = new Set(State.schLabels.map(l => l.comp + ":" + l.pin));
  const auto = schAutoLabelsOn();

  // auto labels — a net whose pins all sit stacked on one point is connected by
  // contact, so its labels are suppressed (they come back the moment a third pin
  // elsewhere joins the net or the stack is pulled apart)
  if (auto){
    const touching = schFullyTouchingNets(comps, geo);
    ctx.fillStyle = "rgba(111,146,184,0.62)";
    for (const c of comps){
      const g = geo.get(c.id);
      for (let i = 0; i < c.pins.length; i++){
        const pin = c.pins[i];
        if (!pin.netId || manual.has(c.id + ":" + i)) continue;
        if (touching.has(pin.netId)) continue;
        const net = getNet(pin.netId);
        if (!net || schIsPowerNet(net)) continue;
        const pg = g.pins[i]; if (!pg) continue;
        const p = schPinPos(c, i, geo); if (!p) continue;
        schLabelText(ctx, net.name, schX2S(p.x), schY2S(p.y), schPinEffAngle(c, pg), s, false);
      }
    }
  }

  // manual labels
  for (const lab of State.schLabels){
    const c = getComp(lab.comp);
    if (!c || typeof c.schX !== "number") continue;
    const p = schPinPos(c, lab.pin, geo); if (!p) continue;
    const net = c.pins[lab.pin] && c.pins[lab.pin].netId ? getNet(c.pins[lab.pin].netId) : null;
    const text = net ? net.name : "(no net)";
    const X = schX2S(p.x + lab.dx), Y = schY2S(p.y + lab.dy);
    const wpx = ctx.measureText(text).width;
    const sel = lab === Sch.selLabel;
    // leader dot on the pin + label text with a subtle plate
    ctx.fillStyle = sel ? "#4da3ff" : "#8fd0ff";
    ctx.beginPath(); ctx.arc(schX2S(p.x), schY2S(p.y), 2, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = sel ? "rgba(77,163,255,0.22)" : "rgba(20,28,38,0.75)";
    ctx.fillRect(X - 3, Y - fpx + 1, wpx + 6, fpx + 5);
    if (sel){ ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = 1.2; ctx.strokeRect(X - 3, Y - fpx + 1, wpx + 6, fpx + 5); }
    ctx.fillStyle = net ? "#8fd0ff" : "#e0b34a";
    ctx.textAlign = "left";
    ctx.fillText(text, X, Y);
    Sch._labelRects.push({ lab, x: X - 3, y: Y - fpx + 1, w: wpx + 6, h: fpx + 5 });
  }
}

/* place label text sticking out along the pin's outward direction */
function schLabelText(ctx, text, X, Y, effAngle, s, plate){
  const out = (effAngle + 180) % 360;   // pins point inward — labels go the other way
  const gap = 0.7 * s;
  ctx.textAlign = "left";
  if (out === 0){ ctx.textAlign = "left";  ctx.fillText(text, X + gap, Y + 0.4*s); }
  else if (out === 180){ ctx.textAlign = "right"; ctx.fillText(text, X - gap, Y + 0.4*s); }
  else if (out === 90){  ctx.textAlign = "center"; ctx.fillText(text, X, Y - gap); }         // up
  else {                 ctx.textAlign = "center"; ctx.fillText(text, X, Y + gap + 0.9*s); } // down
  ctx.textAlign = "left";
}

/* ---------- schematic wires ---------- */
function schDrawWires(ctx, conn){
  const stat = conn || schConnectivity(null, Sch.geo());
  for (const w of State.schWires){
    const pts = w.points;
    if (!pts || pts.length < 2) continue;
    const sel = w === Sch.selWire || (Sch.selWires && Sch.selWires.includes(w));
    // an end counts as landed when anchored to a pin OR sitting on another wire
    // of the same net (T junction — drawn as a filled dot). Net comparison uses the
    // EFFECTIVE net (re-derived from anchors) so a wire drawn while net-less still matches.
    const wn = schWireNet(w);
    const sameNet = State.schWires.filter(x => { if (x === w) return false; const xn = schWireNet(x); return !xn || !wn || xn === wn; });
    const aOn = !!w.a || !!schWireOnPoint(pts[0], w, sameNet);
    const bOn = !!w.b || !!schWireOnPoint(pts[pts.length-1], w, sameNet);
    const good = aOn && bOn && (!wn || (stat.get(wn) || { complete: true }).complete);
    ctx.strokeStyle = sel ? "#4da3ff" : (good ? SCH_WIRE_OK : SCH_WIRE_BAD);
    ctx.lineWidth = sel ? 2.4 : 1.6;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(schX2S(p.x), schY2S(p.y)) : ctx.moveTo(schX2S(p.x), schY2S(p.y)));
    ctx.stroke();
    // connection dots on anchored ends; an open end gets a hollow red ring
    ctx.fillStyle = ctx.strokeStyle;
    const endDot = (p, anchored) => {
      const X = schX2S(p.x), Y = schY2S(p.y);
      ctx.beginPath(); ctx.arc(X, Y, 2.2, 0, Math.PI*2);
      if (anchored) ctx.fill();
      else { ctx.strokeStyle = SCH_WIRE_BAD; ctx.lineWidth = 1.4; ctx.stroke(); ctx.strokeStyle = sel ? "#4da3ff" : (good ? SCH_WIRE_OK : SCH_WIRE_BAD); }
    };
    endDot(pts[0], aOn);
    endDot(pts[pts.length-1], bOn);
    // shift-selected single segment → highlight it (Delete removes just this leg)
    if (Sch.selSeg && Sch.selSeg.w === w && pts[Sch.selSeg.i + 1]){
      const a = pts[Sch.selSeg.i], b = pts[Sch.selSeg.i + 1];
      ctx.strokeStyle = "#ff9d3d"; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(schX2S(a.x), schY2S(a.y)); ctx.lineTo(schX2S(b.x), schY2S(b.y));
      ctx.stroke();
    }
  }
}

/* junction dots where 3+ wire conductors meet — a small filled node, sized to about half a
   pin-name letter and scaling with zoom, so a real branch point reads clearly without the
   heavy blob. A point's incidence count decides it (≥3 → junction):
     · each wire SEGMENT contributes +1 at each of its two endpoints, so a polyline's
       interior VERTEX (a corner) accrues +2 and a plain end +1;
     · an ANCHORED wire end adds +1 more — the pin it lands on is itself a conductor, so a
       wire whose end merely TOUCHES another wire's anchored end still totals 3 (fixes the
       "no dot on a corner / anchor" case);
     · a wire vertex landing on the INTERIOR of another wire's straight run adds +2 (that
       run passes through — a T onto a mid-segment).
   Pins are never counted on their own, so two part pins touching (with a single wire on
   them) stay a plain 2-conductor node — no dot. Crossings with no shared vertex/end aren't
   junctions either (KiCad semantics). */
function schDrawJunctions(ctx){
  const wires = State.schWires;
  if (!wires || wires.length < 2 || wires.length > 4000) return;
  const key = (x, y) => Math.round(x * 10) + "," + Math.round(y * 10);
  const inc = new Map();                              // key -> {x,y,n}
  const bump = (x, y, n) => { const k = key(x, y); let e = inc.get(k); if (!e) inc.set(k, e = { x, y, n: 0 }); e.n += n; };
  // (1) segment endpoints (corners score +2, ends +1) and (1b) the pin behind an anchor
  for (const w of wires){
    const p = w.points; if (!p || p.length < 2) continue;
    for (let i = 0; i + 1 < p.length; i++){ bump(p[i].x, p[i].y, 1); bump(p[i+1].x, p[i+1].y, 1); }
    if (w.a) bump(p[0].x, p[0].y, 1);
    if (w.b) bump(p[p.length - 1].x, p[p.length - 1].y, 1);
  }
  // (2) a vertex landing mid-segment of ANOTHER wire → that wire passes through (+2)
  for (const w of wires){
    const p = w.points; if (!p || p.length < 2) continue;
    for (const v of p){
      const vk = key(v.x, v.y);
      for (const o of wires){
        if (o === w) continue;
        const op = o.points; if (!op || op.length < 2) continue;
        let atVertex = false;
        for (const q of op){ if (key(q.x, q.y) === vk){ atVertex = true; break; } }
        if (atVertex) continue;                         // shared vertex — already counted in (1)
        for (let i = 0; i + 1 < op.length; i++)
          if (distToSeg(v.x, v.y, op[i], op[i+1]) <= 0.05){ bump(v.x, v.y, 2); break; }
      }
    }
  }
  // size: ~half a pin-name letter (font is 1.15·zoom px tall), scaling with zoom
  const r = Math.max(1.8, 0.3 * Sch.zoom);
  ctx.fillStyle = SCH_WIRE_OK;
  for (const e of inc.values()){
    if (e.n < 3) continue;
    ctx.beginPath();
    ctx.arc(schX2S(e.x), schY2S(e.y), r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function schDrawWireDraft(ctx){
  const d = Sch.wireDraft;
  if (Sch.mode !== "wire") return;
  if (d && d.points.length){
    ctx.strokeStyle = SCH_WIRE_OK;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    d.points.forEach((p, i) => i ? ctx.lineTo(schX2S(p.x), schY2S(p.y)) : ctx.moveTo(schX2S(p.x), schY2S(p.y)));
    ctx.stroke();
    if (d.preview && d.preview.length){
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      const last = d.points[d.points.length-1];
      ctx.moveTo(schX2S(last.x), schY2S(last.y));
      for (const p of d.preview) ctx.lineTo(schX2S(p.x), schY2S(p.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // highlight the start anchor pin for the whole draft
    const a = d.points[0];
    ctx.strokeStyle = "#7ec3ff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(schX2S(a.x), schY2S(a.y), 5.5, 0, Math.PI*2); ctx.stroke();
  }
}

/* ring around the pin the wire tool would anchor to */
function schDrawHotPin(ctx){
  if (Sch.mode !== "wire" || !Sch.hotPin) return;
  const p = Sch.hotPin.pos;
  ctx.strokeStyle = "#ffd24d"; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(schX2S(p.x), schY2S(p.y), 6.5, 0, Math.PI*2); ctx.stroke();
}

function schDrawMarquee(ctx){
  const d = Sch.drag;
  // live marquee
  if (d && d.kind === "marquee" && d.moved){
    const x = Math.min(schX2S(d.sx), schX2S(d.x)), y = Math.min(schY2S(d.sy), schY2S(d.y));
    const w = Math.abs(schX2S(d.x) - schX2S(d.sx)), h = Math.abs(schY2S(d.y) - schY2S(d.sy));
    ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillStyle = "rgba(77,163,255,0.08)";
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
}

/* collinear-overlap length between segment A-B and C-D (0 when they merely cross, are
   perpendicular, or don't share a line). Crossings are fine — only wires lying ON TOP of
   each other count. */
function schSegOverlapLen(a, b, c, d){
  const eps = 0.03;
  const aH = Math.abs(a.y - b.y) < eps, cH = Math.abs(c.y - d.y) < eps;
  const aV = Math.abs(a.x - b.x) < eps, cV = Math.abs(c.x - d.x) < eps;
  if (aH && cH && Math.abs(a.y - c.y) < eps){                 // both horizontal, same row
    const lo = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
    const hi = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
    return Math.max(0, hi - lo);
  }
  if (aV && cV && Math.abs(a.x - c.x) < eps){                 // both vertical, same column
    const lo = Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
    const hi = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
    return Math.max(0, hi - lo);
  }
  return 0;
}

/* total length a candidate path (points starting from `start`) would lie on top of any
   existing schematic wire. Used to pick the elbow that avoids overlapping straights. */
function schPathOverlap(start, pathPts){
  let prev = start, total = 0;
  for (const q of pathPts){
    for (const w of State.schWires)
      for (let i = 0; i < w.points.length - 1; i++)
        total += schSegOverlapLen(prev, q, w.points[i], w.points[i + 1]);
    prev = q;
  }
  return total;
}

/* 90°-snapped path from L to target T: straight when aligned, else one corner.
   prevDir ("h"/"v"/null) = direction of the previous segment; Sch.axisPref (R while
   drafting) forces which leg comes first. With no forced preference the elbow that lies
   on top of existing wires the LEAST wins (crossings are fine, overlapping straights are
   not), falling back to prev-segment alternation / the long axis on a tie. */
function schOrthoPath(L, T, prevDir){
  if (Math.abs(L.x - T.x) < 0.01 || Math.abs(L.y - T.y) < 0.01) return [T];
  const hPath = [{ x: T.x, y: L.y }, T];   // horizontal leg first
  const vPath = [{ x: L.x, y: T.y }, T];   // vertical leg first
  if (Sch.axisPref === "h") return hPath;  // explicit R-key preference wins on every corner
  if (Sch.axisPref === "v") return vPath;
  const ho = schPathOverlap(L, hPath), vo = schPathOverlap(L, vPath);
  if (ho + 0.05 < vo) return hPath;        // clearly less overlap one way → take it
  if (vo + 0.05 < ho) return vPath;
  // tie (usually both zero) → old behaviour: alternate off the previous leg, else long axis
  const horizFirst = prevDir === "h" ? false : prevDir === "v" ? true
                   : Math.abs(T.x - L.x) >= Math.abs(T.y - L.y);
  return horizFirst ? hPath : vPath;
}
function schSegDir(a, b){ return Math.abs(a.y - b.y) < 0.01 ? "h" : Math.abs(a.x - b.x) < 0.01 ? "v" : null; }

/* nearest pin within `tol` screen px of a screen point, or null */
function schFindPin(sx, sy, tol){
  tol = tol || 15;
  const geo = Sch.geo();
  let best = null, bd = tol * tol;
  for (const c of State.components){
    const g = geo.get(c.id);
    if (!g || typeof c.schX !== "number") continue;
    for (let i = 0; i < c.pins.length; i++){
      const p = schPinPos(c, i, geo); if (!p) continue;
      const dx = schX2S(p.x) - sx, dy = schY2S(p.y) - sy;
      const d = dx*dx + dy*dy;
      if (d < bd){ bd = d; best = { comp: c, pin: i, pos: p }; }
    }
  }
  return best;
}

/* net of a wire anchor, or null */
function schNetOfAnchor(an){
  if (!an) return null;
  const c = getComp(an.comp);
  return c ? (c.pins[an.pin] || {}).netId || null : null;
}

/* a wire's EFFECTIVE net: its stored netId if set, else re-derived live from whichever
   end is anchored to a pin. A wire drawn from a then-netless pin keeps netId:null forever
   even after the pin gets a net in the Visual editor — trusting the stored value alone
   would leave the net reporting incomplete (ratlines linger, exporter never suppresses
   its labels). Deriving it lazily keeps connectivity + export honest without mutating the
   stored wire. */
function schWireNet(w){
  return (w && w.netId) || schNetOfAnchor(w && w.a) || schNetOfAnchor(w && w.b) || null;
}

/* a board component is being deleted — remove the schematic wires anchored to its pins
   and any manual net labels pinned to it, so nothing is left dangling on a ghost part.
   Called from the delete paths (inside their pushUndo, so it's part of that undo step). */
function schForgetComp(compId){
  if (State.schWires && State.schWires.length)
    State.schWires = State.schWires.filter(w =>
      !(w.a && w.a.comp === compId) && !(w.b && w.b.comp === compId));
  if (State.schLabels && State.schLabels.length)
    State.schLabels = State.schLabels.filter(l => l.comp !== compId);
}

/* may a dragged free wire end of `w` legally land on `pin` ({comp,pin})? Only when they
   share a net (or either side is still net-less). Keeps an end from snapping onto — or
   anchoring to — a different-net pin. */
function schWireEndPinOK(w, pin){
  const wireNet = w.netId || schNetOfAnchor(w.a) || schNetOfAnchor(w.b);
  const pinNet = schNetOfAnchor({ comp: pin.comp.id, pin: pin.pin });
  return !wireNet || !pinNet || wireNet === pinNet;
}

/* wires whose endpoint is anchored to a pin of `comp` follow the pin when the part
   moves/rotates/flips; the neighbouring point is shifted to keep every bend at 90° */
function schUpdateWiresFor(comp){
  const geo = Sch.geo();
  for (const w of State.schWires){
    let touched = false;
    for (const key of ["a", "b"]){
      const an = w[key];
      if (!an || an.comp !== comp.id) continue;
      const p = schPinPos(comp, an.pin, geo);
      if (!p) continue;
      const pts = w.points;
      const endIdx = key === "a" ? 0 : pts.length - 1;
      const old = pts[endIdx];
      if (pts.length > 2){
        const nb = pts[endIdx + (endIdx === 0 ? 1 : -1)];
        if (Math.abs(nb.y - old.y) < 0.01) nb.y = p.y;        // adjoining segment was horizontal
        else if (Math.abs(nb.x - old.x) < 0.01) nb.x = p.x;   // …or vertical
      }
      pts[endIdx] = { x: p.x, y: p.y };
      touched = true;
    }
    // short wire with a moved anchored end → re-route it as a clean straight/L run so it
    // never goes diagonal. This also covers a 2-point wire with ONE free end (every
    // T-junction branch is a:null,b:pin, or vice-versa): its free/T-landed end stays put
    // (keeping the junction) while an inserted elbow keeps the 90° invariant that
    // schWireSegPoint / schSegDir / the overlap tests all rely on. Only `touched` wires
    // reach here, so at least one end is anchored to the moved part.
    if (touched && w.points.length <= 3){
      const A = w.points[0], B = w.points[w.points.length - 1];
      w.points = (Math.abs(A.x-B.x) < 0.01 || Math.abs(A.y-B.y) < 0.01)
        ? [A, B] : [A, { x: B.x, y: A.y }, B];
    }
  }
}

/* wire + segment index under a screen point (for click-select and segment dragging) */
function schWireSegHit(sx, sy){
  const tol = 5;
  for (let k = State.schWires.length - 1; k >= 0; k--){
    const w = State.schWires[k];
    const pts = w.points;
    for (let i = 0; i + 1 < pts.length; i++){
      const ax = schX2S(pts[i].x), ay = schY2S(pts[i].y);
      const bx = schX2S(pts[i+1].x), by = schY2S(pts[i+1].y);
      const dx = bx - ax, dy = by - ay;
      const len2 = dx*dx + dy*dy || 1;
      let t = ((sx - ax)*dx + (sy - ay)*dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t*dx - sx, py = ay + t*dy - sy;
      if (px*px + py*py <= tol*tol) return { w, i };
    }
  }
  return null;
}

/* a FREE wire endpoint (not anchored to a pin) within tol screen px, or null.
   Used to grab and drag a stray/unconnected wire end around. */
function schWireEndHit(sx, sy){
  const tol = 7;
  for (let k = State.schWires.length - 1; k >= 0; k--){
    const w = State.schWires[k];
    const pts = w.points;
    const ends = [[0, !w.a], [pts.length - 1, !w.b]];
    for (const [idx, free] of ends){
      if (!free || idx < 0) continue;
      const dx = schX2S(pts[idx].x) - sx, dy = schY2S(pts[idx].y) - sy;
      if (dx*dx + dy*dy <= tol*tol) return { w, idx };
    }
  }
  return null;
}

/* the grid-snapped point (mm) on a hit wire segment nearest the cursor — where a
   branching wire attaches (clamped to stay on the segment) */
function schWireSegPoint(ws, mx, my){
  const A = ws.w.points[ws.i], B = ws.w.points[ws.i + 1];
  if (Math.abs(A.y - B.y) < 0.01){                                   // horizontal
    const lo = Math.min(A.x, B.x), hi = Math.max(A.x, B.x);
    return { x: Math.min(hi, Math.max(lo, schSnap(mx))), y: A.y };
  }
  if (Math.abs(A.x - B.x) < 0.01){                                   // vertical
    const lo = Math.min(A.y, B.y), hi = Math.max(A.y, B.y);
    return { x: A.x, y: Math.min(hi, Math.max(lo, schSnap(my))) };
  }
  const pr = projectOnSeg(mx, my, A, B);                             // diagonal (legacy)
  return { x: pr.x, y: pr.y };
}

/* distance (screen px) from a point to a wire, for click-select */
function schWireHit(sx, sy){
  const h = schWireSegHit(sx, sy);
  return h ? h.w : null;
}

/* manual label under a screen point (uses the rects captured during render) */
function schLabelHit(sx, sy){
  for (let i = Sch._labelRects.length - 1; i >= 0; i--){
    const r = Sch._labelRects[i];
    if (sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return r.lab;
  }
  return null;
}

function schDrawSymbol(ctx, c, g){
  const s = Sch.zoom;
  const X = schX2S(c.schX), Y = schY2S(c.schY);
  const rot = schRotOf(c);
  // cull symbols fully outside the viewport
  const rx = (Math.max(g.bw, g.bh)/2 + 4) * s, ry = rx;
  if (X + rx < 0 || X - rx > Sch.width || Y + ry < 0 || Y - ry > Sch.height) return;

  const back = c.side === "back";
  const stroke = back ? "#7da0ff" : "#ffd24d";           // same side colours as the export preview
  const boxFill = back ? "rgba(43,58,102,0.45)" : "rgba(90,74,30,0.45)";
  ctx.lineWidth = Math.max(1, Math.min(2.2, 0.25 * s));
  ctx.strokeStyle = stroke;

  // geometry (body + pin stubs) is drawn inside a rotated+flipped frame; local mm +y up.
  // a CCW symbol rotation appears as a −θ canvas rotation because y is flipped; the
  // X/Y flips apply as a scale in symbol space (matching schXf's flip-then-rotate).
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(-rot * Math.PI / 180);
  ctx.scale(c.schFlipH ? -1 : 1, c.schFlipV ? -1 : 1);
  const lx = (x) => x * s;
  const ly = (y) => -y * s;

  for (const str of g.body){
    const b = schParseBody(str);
    if (!b) continue;
    if (b.kind === "rect"){
      const x = Math.min(lx(b.x1), lx(b.x2)), y = Math.min(ly(b.y1), ly(b.y2));
      const w = Math.abs(lx(b.x2) - lx(b.x1)), h = Math.abs(ly(b.y2) - ly(b.y1));
      if (b.fill === "background"){ ctx.fillStyle = boxFill; ctx.fillRect(x, y, w, h); }
      ctx.strokeRect(x, y, w, h);
    } else if (b.kind === "poly"){
      ctx.beginPath();
      b.pts.forEach((p, i) => i ? ctx.lineTo(lx(p[0]), ly(p[1])) : ctx.moveTo(lx(p[0]), ly(p[1])));
      if (b.fill === "outline"){ ctx.closePath(); ctx.fillStyle = stroke; ctx.fill(); }
      ctx.stroke();
    } else if (b.kind === "arc"){
      // circle through start/mid/end (KiCad arc definition)
      const ax=b.sx, ay=b.sy, bx=b.mx, by=b.my, cx2=b.ex, cy2=b.ey;
      const d = 2 * (ax*(by-cy2) + bx*(cy2-ay) + cx2*(ay-by));
      if (Math.abs(d) < 1e-9){        // collinear → straight lines
        ctx.beginPath(); ctx.moveTo(lx(ax), ly(ay)); ctx.lineTo(lx(bx), ly(by)); ctx.lineTo(lx(cx2), ly(cy2)); ctx.stroke();
        continue;
      }
      const ux = ((ax*ax+ay*ay)*(by-cy2) + (bx*bx+by*by)*(cy2-ay) + (cx2*cx2+cy2*cy2)*(ay-by)) / d;
      const uy = ((ax*ax+ay*ay)*(cx2-bx) + (bx*bx+by*by)*(ax-cx2) + (cx2*cx2+cy2*cy2)*(bx-ax)) / d;
      const r = Math.hypot(ax-ux, ay-uy);
      const a0 = Math.atan2(ay-uy, ax-ux), am = Math.atan2(by-uy, bx-ux), a1 = Math.atan2(cy2-uy, cx2-ux);
      const norm = (a) => (a - a0 + Math.PI*4) % (Math.PI*2);
      const ccwLocal = norm(am) <= norm(a1);              // sweep through the mid point
      ctx.beginPath();
      // local +y-up angles map to canvas angles negated (y is flipped on screen)
      ctx.arc(lx(ux), ly(uy), r * s, -a0, -a1, ccwLocal);
      ctx.stroke();
    }
  }

  // pin stubs (rotate/flip with the body)
  for (let i = 0; i < c.pins.length; i++){
    const pg = g.pins[i]; if (!pg) continue;
    const a = (pg.angle || 0) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(lx(pg.x), ly(pg.y));
    ctx.lineTo(lx(pg.x + Math.cos(a) * pg.len), ly(pg.y + Math.sin(a) * pg.len));
    ctx.stroke();
  }
  ctx.restore();

  // pin numbers / names stay upright — positions rotated/flipped, text not
  const showText = s > 3.2;
  if (showText){
    for (let i = 0; i < c.pins.length; i++){
      const pg = g.pins[i]; if (!pg) continue;
      const a = (pg.angle || 0) * Math.PI / 180;
      const eff = schPinEffAngle(c, pg);
      if (!g.hideNums){
        const mid = schXf(c, pg.x + Math.cos(a)*pg.len/2, pg.y + Math.sin(a)*pg.len/2);
        ctx.fillStyle = "#8b96a5";
        ctx.font = (1.15 * s) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.pins[i].num, X + mid.x * s, Y - mid.y * s - 0.35 * s);
      }
      if (!g.hideNames && c.pins[i].name){
        // net names are no longer drawn inside the box — the outward net labels
        // (auto or manual) carry them without obstructing the symbol
        const inn = schXf(c, pg.x + Math.cos(a)*(pg.len + 0.6), pg.y + Math.sin(a)*(pg.len + 0.6));
        ctx.fillStyle = "#aeb7c2";
        ctx.font = (1.15 * s) + "px sans-serif";
        ctx.textAlign = eff === 0 ? "left" : eff === 180 ? "right" : "center";
        ctx.fillText(c.pins[i].name, X + inn.x * s, Y - inn.y * s + 0.4 * s);
      }
    }
  }
  ctx.textAlign = "center";

  // reference + value stay upright. Horizontal symbols: ref above, value below.
  // Vertical (90/270) 2-pin parts have their pins — and net labels — sticking out of
  // the top/bottom, so the texts move BESIDE the body (ref left, value right) to keep
  // clear of the pin labels.
  const { hw, hh } = schHalfExt(c, g);
  if (showText){
    const vertical = schRotOf(c) % 180 !== 0;
    const val = c.value || c.part || "";
    ctx.fillStyle = stroke;
    ctx.font = "bold " + (1.6 * s) + "px sans-serif";
    if (g.isBox){
      // box/IC symbols: reference (prefix) centred inside the box, value just below it
      ctx.textAlign = "center";
      ctx.fillText(c.ref, X, Y + 0.55 * s);
      if (val){
        ctx.fillStyle = "#cfd6df";
        ctx.font = (1.35 * s) + "px sans-serif";
        ctx.fillText(val, X, Y + (hh + 1.6) * s);
      }
    } else if (vertical){
      ctx.textAlign = "right";
      ctx.fillText(c.ref, X - (hw + 0.8) * s, Y + (val ? -0.3 : 0.55) * s);
      if (val){
        ctx.fillStyle = "#cfd6df";
        ctx.font = (1.35 * s) + "px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(val, X + (hw + 0.8) * s, Y + 0.55 * s);
      }
    } else {
      ctx.fillText(c.ref, X, Y - (hh + 1.4) * s);
      if (val){
        ctx.fillStyle = "#cfd6df";
        ctx.font = (1.35 * s) + "px sans-serif";
        ctx.fillText(val, X, Y + (hh + 2.2) * s);
      }
    }
  }
  ctx.textAlign = "left";

  // move-lock badge: a small padlock at the symbol's top-left so a locked part is
  // visible at a glance (mirrors the 🔒 in the inspector title)
  if (compSchMoveLocked(c) && s > 2.5){
    ctx.font = (1.6 * s) + "px sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText("🔒", X - (hw + 0.4) * s, Y - (hh + 0.4) * s);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
  }

  // selection / hover outline (axis-aligned around the rotated symbol)
  const selected = (UI.sel && UI.sel.type === "comp" && UI.sel.comp === c) || Sch.boxSel.includes(c);
  if (selected || Sch.hover === c){
    ctx.save();
    ctx.strokeStyle = selected ? "#4da3ff" : "rgba(77,163,255,0.45)";
    ctx.lineWidth = selected ? 1.6 : 1.2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(X - (hw + 3) * s, Y - (hh + 3) * s, (hw + 3) * 2 * s, (hh + 3) * 2 * s);
    ctx.restore();
  }
}

/* ---------- interaction ---------- */
Sch.hit = (mx, my) => {
  const geo = Sch.geo();
  for (let i = State.components.length - 1; i >= 0; i--){
    const c = State.components[i];
    const g = geo.get(c.id);
    if (!g || typeof c.schX !== "number") continue;
    const { hw, hh } = schHalfExt(c, g);
    if (Math.abs(mx - c.schX) <= hw + 1 && Math.abs(my - c.schY) <= hh + 1) return c;
  }
  return null;
};

/* true when (mx,my) mm lands on a component's actual body (no margin) — used to let a
   wire routed under a part's bounding box still be picked when clicking off the body */
function schPtInBody(c, mx, my){
  const g = Sch.geo().get(c.id);
  if (!g) return false;
  const { hw, hh } = schHalfExt(c, g);
  return Math.abs(mx - c.schX) <= hw && Math.abs(my - c.schY) <= hh;
}

/* rotate a symbol 90° CCW (R key) — wires anchored to its pins follow */
Sch.rotate = (c) => {
  if (!c) return;
  if (compSchMoveLocked(c)){ UI.toast(c.ref + " symbol is locked 🔒"); return; }
  pushUndo("rotate schematic symbol");
  c.schRot = (schRotOf(c) + 90) % 360;
  schUpdateWiresFor(c);
  Sch.render();
};

/* flip a symbol horizontally (X) or vertically (Y) — schematic only */
Sch.flip = (c, vert) => {
  if (!c) return;
  if (compSchMoveLocked(c)){ UI.toast(c.ref + " symbol is locked 🔒"); return; }
  pushUndo("flip schematic symbol");
  schFlipComp(c, vert);
  schUpdateWiresFor(c);
  Sch.render();
};

/* the component(s) the current keys act on: box selection, else selected, else hovered */
Sch.targets = () => {
  if (Sch.boxSel.length) return Sch.boxSel.slice();
  if (UI.sel && UI.sel.type === "comp" && typeof UI.sel.comp.schX === "number") return [UI.sel.comp];
  if (Sch.hover) return [Sch.hover];
  return [];
};

Sch.setMode = (mode) => {
  Sch.mode = mode;
  Sch.wireDraft = null;
  Sch.hotPin = null;
  const btn = $("#sch-wire");
  if (btn) btn.classList.toggle("active", mode === "wire");
  if (Sch.canvas) Sch.canvas.style.cursor = mode === "wire" ? "crosshair" : "default";
  if (mode !== "wire") schStopEdgeScroll();
  Sch.render();
};

/* add (or select) a manual net label on a pin */
Sch.addLabel = (comp, pin) => {
  const existing = State.schLabels.find(l => l.comp === comp.id && l.pin === pin);
  if (existing){ Sch.selLabel = existing; Sch.render(); return existing; }
  if (!comp.pins[pin] || !comp.pins[pin].netId){ UI.toast("That pin has no net — assign one in the Visual editor first"); return null; }
  const g = Sch.geo().get(comp.id);
  const pg = g && g.pins[pin];
  // default offset: stick out in the pin's outward direction
  let dx = 1.2, dy = 0;
  if (pg){
    const out = (schPinEffAngle(comp, pg) + 180) % 360;
    dx = Math.round(Math.cos(out * Math.PI/180)) * 1.6;
    dy = -Math.round(Math.sin(out * Math.PI/180)) * 1.6;   // schematic y is down
  }
  pushUndo("add net label");
  const lab = { id: nextId(), comp: comp.id, pin, dx, dy };
  State.schLabels.push(lab);
  Sch.selLabel = lab;
  Sch.selWire = null; Sch.selWires = null;
  Sch.render();
  return lab;
};

/* delete a single wire segment (shift-selected): splits the polyline into the run
   before the cut and the run after it, dropping any piece too short to survive */
Sch.deleteSegment = (seg) => {
  const w = seg.w, i = seg.i;
  if (!w || !w.points || i + 1 >= w.points.length) return;
  // the selected segment may reference a wire that was already removed (undo/redo or an
  // arrange cleared State.schWires without this stale selSeg noticing) — splitting it
  // would push its fragments back in, resurrecting a deleted wire. Bail if it's gone.
  if (!State.schWires.includes(w)){ Sch.selSeg = null; Sch.selWire = null; Sch.selWires = null; return; }
  pushUndo("delete wire segment");
  const pts = w.points;
  const before = pts.slice(0, i + 1);      // keeps w.a
  const after  = pts.slice(i + 1);         // keeps w.b
  State.schWires = State.schWires.filter(x => x !== w);
  if (before.length >= 2)
    State.schWires.push({ id: nextId(), netId: w.netId, points: before, a: w.a || null, b: null });
  if (after.length >= 2)
    State.schWires.push({ id: nextId(), netId: w.netId, points: after, a: null, b: w.b || null });
  Sch.selSeg = null; Sch.selWire = null; Sch.selWires = null;
  Sch.render();
};

Sch.deleteLabel = (lab) => {
  if (!lab) return;
  pushUndo("delete net label");
  State.schLabels = State.schLabels.filter(l => l !== lab);
  if (Sch.selLabel === lab) Sch.selLabel = null;
  Sch.render();
};

/* edit a label's net = rename/reassign the pin's net (kept in sync with the board) */
Sch.editLabel = (lab) => {
  const c = getComp(lab.comp);
  if (!c) return;
  const pin = c.pins[lab.pin];
  const cur = pin && pin.netId ? (getNet(pin.netId)?.name || "") : "";
  UI.openNetPopup(c.ref + "." + (pin ? pin.num : "?") + " net", cur, (name) => {
    applyNetRename({ type: "pin", comp: c, pinIdx: lab.pin }, name);
    Sch.invalidate(); Sch.render();
  });
};

/* collapse consecutive collinear points in a polyline so a straight run is ONE
   segment (dragged as a whole, not split into pieces) — and drop zero-length steps */
function schCleanPoints(pts){
  const eps = 0.001;
  const out = pts.filter((p, i) => !i || Math.abs(p.x - pts[i-1].x) > eps || Math.abs(p.y - pts[i-1].y) > eps);
  for (let i = 1; i + 1 < out.length; ){
    const a = out[i-1], b = out[i], c = out[i+1];
    const abH = Math.abs(a.y - b.y) < eps, bcH = Math.abs(b.y - c.y) < eps;
    const abV = Math.abs(a.x - b.x) < eps, bcV = Math.abs(b.x - c.x) < eps;
    if ((abH && bcH && Math.abs(a.y - c.y) < eps) || (abV && bcV && Math.abs(a.x - c.x) < eps))
      out.splice(i, 1);          // b lies on the a-c straight → drop it
    else i++;
  }
  return out;
}
Sch.cleanWire = (w) => { if (w && w.points) w.points = schCleanPoints(w.points); };

/* finish the wire draft → a persisted State.schWires entry */
Sch.finishWire = (endAnchor) => {
  const d = Sch.wireDraft;
  Sch.wireDraft = null;
  if (!d || d.points.length < 2){ Sch.render(); return; }
  const na = schNetOfAnchor(d.a), nb = schNetOfAnchor(endAnchor);
  pushUndo("draw schematic wire");
  State.schWires.push({ id: nextId(), netId: na || nb || d.netId || null, points: schCleanPoints(d.points), a: d.a, b: endAnchor || null });
  Sch.render();
};

/* ---------- schematic edge auto-scroll ----------
   Active while the wire tool is enabled (not just mid-draft), while dragging a
   symbol/group/label and while box-selecting — shares the Options prefs with the
   board editor (UI.edgeScrollOn/edgeMargin/edgeSpeed). */
function schEdgeScrollAllowed(){
  if (!UI.edgeScrollOn()) return false;
  if (Sch.mode === "wire") return true;
  const d = Sch.drag;
  return !!(d && (d.kind === "comp" || d.kind === "group" || d.kind === "label" || d.kind === "marquee" || d.kind === "wireseg" || d.kind === "wireend"));
}

function schUpdateEdgeScroll(p){
  if (!schEdgeScrollAllowed() || !p || p.x < 0 || p.x > Sch.width || p.y < 0 || p.y > Sch.height){
    schStopEdgeScroll(); return;
  }
  const m = UI.edgeMargin(), speed = UI.edgeSpeed(), W = Sch.width, H = Sch.height;
  const clamp = t => t < 0 ? 0 : t > 1 ? 1 : t;
  let vx = 0, vy = 0;
  if (p.x < m)          vx =  clamp((m - p.x) / m);
  else if (p.x > W - m) vx = -clamp((p.x - (W - m)) / m);
  if (p.y < m)          vy =  clamp((m - p.y) / m);
  else if (p.y > H - m) vy = -clamp((p.y - (H - m)) / m);
  if (!vx && !vy){ schStopEdgeScroll(); return; }
  Sch._edgeVel = { x: vx * speed, y: vy * speed };
  if (!Sch._edgeRAF) Sch._edgeRAF = requestAnimationFrame(schEdgeTick);
}

function schEdgeTick(){
  Sch._edgeRAF = 0;
  const v = Sch._edgeVel, p = Sch._lastP;
  // stop the moment the cursor is no longer inside the canvas (pointermove stops
  // firing once it leaves, so the tick must re-check the last known point itself)
  if (!schEdgeScrollAllowed() || !v || !p ||
      p.x < 0 || p.x > Sch.width || p.y < 0 || p.y > Sch.height) return;
  Sch.panX += v.x; Sch.panY += v.y;
  // re-drive the interaction from the stationary cursor so the dragged thing tracks it
  Sch.onMove(p, Sch._lastEvt || {});
  Sch.render();
  Sch._edgeRAF = requestAnimationFrame(schEdgeTick);
}

function schStopEdgeScroll(){
  if (Sch._edgeRAF){ cancelAnimationFrame(Sch._edgeRAF); Sch._edgeRAF = 0; }
  Sch._edgeVel = null;
}

/* pointer-move core, callable from both the event handler and the edge-scroll tick */
Sch.onMove = (p, e) => {
  const mx = schS2X(p.x), my = schS2Y(p.y);

  // an active pan (wheel-click / Space) works in EVERY mode, including wire mode
  if (Sch.drag && Sch.drag.kind === "pan"){
    Sch.panX = Sch.drag.px + (p.x - Sch.drag.sx);
    Sch.panY = Sch.drag.py + (p.y - Sch.drag.sy);
    Sch.render();
    return;
  }

  if (Sch.mode === "wire"){
    const pin = schFindPin(p.x, p.y);
    Sch.hotPin = pin;
    const d = Sch.wireDraft;
    if (d){
      const last = d.points[d.points.length - 1];
      const prevDir = d.points.length > 1 ? schSegDir(d.points[d.points.length-2], last) : null;
      const target = pin ? pin.pos : { x: schSnap(mx), y: schSnap(my) };
      d.preview = schOrthoPath(last, target, prevDir);
    }
    Sch.requestRender();
    return;
  }

  const d = Sch.drag;
  if (d){
    if (d.kind === "marquee"){
      d.moved = true;
      d.x = mx; d.y = my;
      Sch.render();
      return;
    }
    if (d.kind === "label"){
      const lab = d.lab;
      if (!d.armed){ pushUndo("move net label"); d.armed = true; }
      d.moved = true;
      lab.dx = mx - d.pin.x - d.offX;
      lab.dy = my - d.pin.y - d.offY;
      Sch.render();
      return;
    }
    if (d.kind === "wireseg"){
      const pts = d.w.points;
      const dir = schSegDir(pts[d.i], pts[d.i+1]);
      if (!dir) return;
      if (!d.armed){
        pushUndo("move wire segment");
        d.armed = true;
        // pin a copy of an endpoint in place when it can't shift with the segment —
        // an anchored wire end (stays on its pin), a COLLINEAR neighbouring segment
        // (shifting the shared corner would turn it diagonal), OR a free end sitting on
        // ANOTHER wire (a T junction — keep it landed so the connection survives); the
        // copy becomes a 90° jog, i.e. a new horizontal/vertical bridge wire in place
        const others = State.schWires.filter(x => x !== d.w);
        const startJct = d.i === 0 && !d.w.a && !!schWireOnPoint(pts[0], d.w, others);
        if ((d.i === 0 && d.w.a) || startJct || (d.i > 0 && schSegDir(pts[d.i-1], pts[d.i]) === dir)){
          pts.splice(d.i, 0, { x: pts[d.i].x, y: pts[d.i].y });
          d.i++;
        }
        const j = d.i + 1;
        const endJct = j === pts.length - 1 && !d.w.b && !!schWireOnPoint(pts[pts.length-1], d.w, others);
        if ((j === pts.length - 1 && d.w.b) || endJct || (j < pts.length - 1 && schSegDir(pts[j], pts[j+1]) === dir))
          pts.splice(j + 1, 0, { x: pts[j].x, y: pts[j].y });
        // OTHER wires whose free end lands ON this segment (a T junction into this wire):
        // record them so they ride along and the connection survives moving THIS wire
        // (the other-wire-moves case was already handled by the jct pin above)
        d.riders = [];
        const sa = pts[d.i], sb = pts[d.i+1];
        for (const ow of State.schWires){
          if (ow === d.w) continue;
          const op = ow.points;
          const ends = [[0, !ow.a], [op.length - 1, !ow.b]];
          for (const [idx, free] of ends){
            if (!free || idx < 0) continue;
            if (distToSeg(op[idx].x, op[idx].y, sa, sb) <= 0.05) d.riders.push({ ow, idx });
          }
        }
      }
      const A = pts[d.i], B = pts[d.i+1];
      // prospective new position, then reject it if the segment would lie ON TOP of any
      // other wire (crossings are fine — only collinear overlap is blocked)
      const nA = { x: A.x, y: A.y }, nB = { x: B.x, y: B.y };
      if (dir === "h"){ const y = schSnap(my); nA.y = y; nB.y = y; }
      else            { const x = schSnap(mx); nA.x = x; nB.x = x; }
      let overlaps = false;
      for (const ow of State.schWires){
        if (ow === d.w) continue;
        for (let k = 0; k + 1 < ow.points.length && !overlaps; k++)
          if (schSegOverlapLen(nA, nB, ow.points[k], ow.points[k+1]) > 0.05) overlaps = true;
        if (overlaps) break;
      }
      if (overlaps) return;                 // keep the segment where it was
      const dX = nA.x - A.x, dY = nA.y - A.y;
      A.x = nA.x; A.y = nA.y; B.x = nB.x; B.y = nB.y;
      // drag every riding T-junction endpoint the same amount, re-squaring its own wire
      if (d.riders) for (const r of d.riders){
        const op = r.ow.points, pt = op[r.idx];
        pt.x += dX; pt.y += dY;
        if (op.length > 1){
          const nb = op[r.idx + (r.idx === 0 ? 1 : -1)];
          if (dir === "h"){ if (Math.abs(nb.y - (pt.y - dY)) < 0.01) nb.y = pt.y; }
          else            { if (Math.abs(nb.x - (pt.x - dX)) < 0.01) nb.x = pt.x; }
        }
      }
      d.moved = true;
      Sch.render();
      return;
    }
    if (d.kind === "wireend"){
      if (!d.armed){ pushUndo("move wire end"); d.armed = true; }
      const rawPin = schFindPin(p.x, p.y);   // snapping to a pin lets a stray end re-connect
      // only snap onto a pin the end may legally join — a different-net pin is ignored so
      // the end can't visually attach where it can't electrically connect
      const pin = (rawPin && schWireEndPinOK(d.w, rawPin)) ? rawPin : null;
      Sch.hotPin = pin;
      const pt = d.w.points[d.idx];
      const tgt = pin ? pin.pos : { x: schSnap(mx), y: schSnap(my) };
      pt.x = tgt.x; pt.y = tgt.y;
      d.moved = true;
      Sch.render();
      return;
    }
    if (d.kind === "comp" || d.kind === "group"){
      const items = d.kind === "comp" ? [{ c: d.comp, dx: d.dx, dy: d.dy }] : d.group;
      // the shift is measured from a LEAD item's position each frame, so the lead must be
      // one that actually moves — a locked lead never updates its schX, making shX grow
      // every frame and flinging the unlocked parts across the sheet. Lead off a movable one.
      const movable = items.filter(it => !compSchMoveLocked(it.c));
      if (!movable.length) return;                 // whole selection locked → nothing to move
      const lead = movable[0];
      const nx = schSnap(mx - lead.dx), ny = schSnap(my - lead.dy);
      if (nx === lead.c.schX && ny === lead.c.schY) return;
      if (!d.armed){
        pushUndo(d.kind === "group" ? "move schematic selection" : "move schematic symbol");
        d.armed = true;
        // record which pins are touching a stationary same-net pin right now, so pulling
        // them apart can drop a wire in the gap (see schSpawnTouchWires on release)
        d.touchPairs = schTouchingPairs(movable.map(it => it.c));
      }
      d.moved = true;
      const shX = nx - lead.c.schX, shY = ny - lead.c.schY;
      for (const it of movable){ it.c.schX += shX; it.c.schY += shY; schUpdateWiresFor(it.c); }
      Sch.render();
      return;
    }
    return;
  }

  const h = Sch.hit(mx, my);
  if (h !== Sch.hover){
    Sch.hover = h;
    Sch.canvas.style.cursor = h ? "move" : "default";
    Sch.requestRender();
  }
};

/* nudge the current selection (box selection or selected part) one grid step */
Sch.nudgeSelection = (dx, dy) => {
  const targets = Sch.boxSel.length ? Sch.boxSel
                : (UI.sel && UI.sel.type === "comp" && typeof UI.sel.comp.schX === "number") ? [UI.sel.comp] : [];
  if (!targets.length) return false;
  // skip locked symbols; an all-locked selection is still "consumed" (arrows don't pan
  // the view over it) but must NOT push an empty undo step
  const movable = targets.filter(c => !compSchMoveLocked(c));
  if (!movable.length) return true;
  // coalesce rapid arrow presses into one undo step
  const now = Date.now();
  if (!Sch._nudgeAt || now - Sch._nudgeAt > 1500) pushUndo("move schematic selection");
  Sch._nudgeAt = now;
  for (const c of movable){
    c.schX = schSnap(c.schX + dx * SCH_GRID);
    c.schY = schSnap(c.schY + dy * SCH_GRID);
    schUpdateWiresFor(c);
  }
  Sch.render();
  return true;
};

/* schematic-pane context menu (right-click) */
function schContextMenu(clientX, clientY, p){
  const mx = schS2X(p.x), my = schS2Y(p.y);
  const items = [];
  const lab = schLabelHit(p.x, p.y);
  const pin = schFindPin(p.x, p.y, 12);
  const w = schWireHit(p.x, p.y);
  const c = Sch.hit(mx, my);
  const boxSel = (Sch.boxSel && Sch.boxSel.length) ? Sch.boxSel.slice() : null;
  // "Lock/Unlock movement" — pins the symbol's sheet position (schLockMove). Group form
  // toggles the whole box selection together (lock all unless every one is already locked).
  const groupLockItem = () => {
    const lockAll = boxSel.some(x => !x.schLockMove);
    return { label: (lockAll ? "Lock movement" : "Unlock movement") + " · " + boxSel.length + " symbol" + (boxSel.length===1?"":"s"),
      action: () => {
        pushUndo();
        for (const x of boxSel) x.schLockMove = lockAll;
        UI.toast(boxSel.length + " symbol" + (boxSel.length===1?"":"s") + (lockAll ? " locked 🔒" : " unlocked"));
        UI.refreshInspector(); Sch.render();
      } };
  };
  const singleLockItem = (cc) => ({ label: cc.schLockMove ? "Unlock movement" : "Lock movement",
    action: () => {
      pushUndo();
      cc.schLockMove = !cc.schLockMove;
      UI.toast(cc.ref + (cc.schLockMove ? " symbol locked 🔒" : " symbol unlocked"));
      UI.refreshInspector(); Sch.render();
    } });
  if (lab){
    Sch.selLabel = lab; Sch.render();
    items.push({ label: "Edit net name…", action: () => Sch.editLabel(lab) });
    items.push({ label: "Delete net label", danger: true, action: () => Sch.deleteLabel(lab) });
  } else if (pin){
    const pnum = pin.comp.pins[pin.pin] ? pin.comp.pins[pin.pin].num : "?";
    items.push({ label: "Add net label to " + pin.comp.ref + "." + pnum, action: () => Sch.addLabel(pin.comp, pin.pin) });
    items.push({ label: "Set net…", action: () => {
      const cur = pin.comp.pins[pin.pin].netId ? (getNet(pin.comp.pins[pin.pin].netId)?.name || "") : "";
      UI.openNetPopup(pin.comp.ref + "." + pnum + " net", cur, (name) => { applyNetRename({ type:"pin", comp:pin.comp, pinIdx:pin.pin }, name); Sch.invalidate(); Sch.render(); });
    }});
    if (Sch.mode === "wire") items.push({ label: "Start wire here", action: () => {
      Sch.wireDraft = { points: [{ x: pin.pos.x, y: pin.pos.y }], a: { comp: pin.comp.id, pin: pin.pin }, preview: null };
      UI.select(null); Sch.render();
    }});
  } else if (c){
    // right-clicking a boxed part keeps the box selection and acts on the whole group
    const inBox = boxSel && boxSel.length > 1 && boxSel.includes(c);
    if (!inBox){ UI.select({ type: "comp", comp: c }); Sch.render(); }
    items.push({ label: "Rotate 90°  [R]", action: () => Sch.rotate(c) });
    items.push({ label: "Flip horizontal  [X]", action: () => Sch.flip(c, false) });
    items.push({ label: "Flip vertical  [Y]", action: () => Sch.flip(c, true) });
    items.push({ label: "Edit ref / value…", action: () => UI.openQuickEdit(c) });
    items.push({ sep: true });
    items.push(inBox ? groupLockItem() : singleLockItem(c));
    items.push({ sep: true });
    items.push({ label: "Show on board (Visual)", action: () => schJumpToVisual(c) });
  } else if (w){
    const net = schConnectedWires(w);
    Sch.selWire = w; Sch.selWires = net; Sch.render();
    items.push({ label: "Delete wire", danger: true, action: () => {
      pushUndo("delete schematic wire");
      State.schWires = State.schWires.filter(x => x !== w);
      if (Sch.selWire === w){ Sch.selWire = null; Sch.selWires = null; }
      Sch.render();
    }});
    if (net.length > 1)
      items.push({ label: "Delete connected wires (" + net.length + ")", danger: true, action: () => {
        const kill = new Set(net);
        pushUndo("delete schematic wires");
        State.schWires = State.schWires.filter(x => !kill.has(x));
        Sch.selWire = null; Sch.selWires = null;
        Sch.render();
      }});
  } else {
    // empty space with a box selection → offer to lock/unlock the whole group
    if (boxSel){ items.push(groupLockItem()); items.push({ sep: true }); }
    items.push({ label: Sch.mode === "wire" ? "Wire mode off  [W/Esc]" : "Wire mode  [W]", action: () => Sch.setMode(Sch.mode === "wire" ? "select" : "wire") });
    items.push({ label: "Zoom to fit", action: () => Sch.fit() });
  }
  if (items.length) UI.showContextMenu(clientX, clientY, items);
}

Sch.wire = () => {
  Sch.canvas = $("#sch-canvas");
  if (!Sch.canvas) return;
  Sch.ctx = Sch.canvas.getContext("2d");
  const cv = Sch.canvas;
  const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  cv.addEventListener("pointerdown", (e) => {
    const p = pt(e);
    Sch._lastP = p; Sch._lastEvt = e;
    const mx = schS2X(p.x), my = schS2Y(p.y);

    // middle button / space = pan (any mode) — unless it grabs the box selection
    if (e.button === 1 || Keys.space){
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch(ex){}
      const c = Sch.hit(mx, my);
      if (e.button === 1 && c && Sch.boxSel.includes(c)){
        // wheel-click drag moves the box-selected group
        Sch.drag = { kind: "group", group: Sch.boxSel.map(g => ({ c: g, dx: mx - g.schX, dy: my - g.schY })), armed: false, moved: false };
        return;
      }
      Sch.drag = { kind: "pan", sx: p.x, sy: p.y, px: Sch.panX, py: Sch.panY };
      cv.style.cursor = "grabbing";
      return;
    }
    if (e.button === 2) return;   // context menu handled separately

    if (Sch.mode === "wire"){
      // no panning / selecting with the wire tool — clicks only place wire points
      const pin = schFindPin(p.x, p.y);
      const d = Sch.wireDraft;
      if (!d){
        if (pin){
          Sch.wireDraft = { points: [{ x: pin.pos.x, y: pin.pos.y }],
                            a: { comp: pin.comp.id, pin: pin.pin }, netId: null, preview: null };
        } else {
          // no pin — an existing wire can also start a branch (T junction, same net)
          const ws = schWireSegHit(p.x, p.y);
          if (!ws){ UI.toast("Wires start on a pin or an existing wire"); return; }
          const q = schWireSegPoint(ws, mx, my);
          Sch.wireDraft = { points: [{ x: q.x, y: q.y }], a: null, netId: ws.w.netId || null, preview: null };
        }
        UI.select(null);           // drawing must not leave a part selected (stray R rotates it)
        Sch.boxSel = [];
      } else {
        const dNet = schNetOfAnchor(d.a) || d.netId;
        let target = null, endsWire = false;
        if (pin){
          // ending on a pin of a DIFFERENT net is refused
          const nb = schNetOfAnchor({ comp: pin.comp.id, pin: pin.pin });
          if (dNet && nb && dNet !== nb){
            UI.warn("Different net — " + (getNet(dNet)?.name || "?") + " can't connect to " + (getNet(nb)?.name || "?"));
            return;
          }
          target = pin.pos;
        } else {
          // ending on an existing wire of the same net makes a T junction
          const ws = schWireSegHit(p.x, p.y);
          if (ws){
            if (dNet && ws.w.netId && dNet !== ws.w.netId){
              UI.warn("Different net — " + (getNet(dNet)?.name || "?") + " can't connect to " + (getNet(ws.w.netId)?.name || "?"));
              return;
            }
            target = schWireSegPoint(ws, mx, my);
            endsWire = true;
          } else target = { x: schSnap(mx), y: schSnap(my) };
        }
        const last = d.points[d.points.length - 1];
        const prevDir = d.points.length > 1 ? schSegDir(d.points[d.points.length-2], last) : null;
        for (const q of schOrthoPath(last, target, prevDir)) d.points.push({ x: q.x, y: q.y });
        d.preview = null;
        if (pin){ Sch.finishWire({ comp: pin.comp.id, pin: pin.pin }); return; }
        if (endsWire){ Sch.finishWire(null); return; }
      }
      Sch.render();
      return;
    }

    try { cv.setPointerCapture(e.pointerId); } catch(ex){}
    if (e.button !== 0) return;

    // manual net label under the cursor → select + drag it
    const lab = schLabelHit(p.x, p.y);
    if (lab){
      const c = getComp(lab.comp);
      const pinPos = c ? schPinPos(c, lab.pin) : null;
      Sch.selLabel = lab; Sch.selWire = null; Sch.selWires = null;
      Sch.drag = pinPos ? { kind: "label", lab, pin: pinPos, offX: mx - pinPos.x - lab.dx, offY: my - pinPos.y - lab.dy, armed: false, moved: false } : null;
      Sch.render();
      return;
    }
    if (Sch.selLabel){ Sch.selLabel = null; Sch.render(); }

    // a FREE wire endpoint under the cursor → grab it and move it freely (2-D, grid
    // snapped). Endpoints take priority over the segment grab so a stray end can be
    // repositioned / dropped back onto a pin. Only when NOT over a part body.
    const endHit = schWireEndHit(p.x, p.y);
    if (endHit){
      const cOver = Sch.hit(mx, my);
      if (!(cOver && schPtInBody(cOver, mx, my))){
        Sch.selWire = endHit.w; Sch.selWires = schConnectedWires(endHit.w); Sch.selSeg = null;
        Sch.drag = { kind: "wireend", w: endHit.w, idx: endHit.idx, armed: false, moved: false };
        UI.select(null);
        Sch.render();
        return;
      }
    }

    // wire under the cursor? a wire only loses to a part when the click is over the
    // part's actual BODY — so wires routed under a symbol's bounding-box margin stay
    // selectable. Shift-click selects just this segment (to delete a single leg).
    const ws = schWireSegHit(p.x, p.y);
    const c = Sch.hit(mx, my);
    const wireWins = ws && (!c || !schPtInBody(c, mx, my));
    if (c && !wireWins){
      // a symbol-locked part can be selected/inspected but not dragged on the sheet
      if (compSchMoveLocked(c) && !Sch.boxSel.includes(c)){
        Sch.boxSel = [];
        Sch.selWire = null; Sch.selWires = null; Sch.selLabel = null; Sch.selSeg = null;
        if (e.shiftKey){ schJumpToVisual(c); return; }
        if (!(UI.sel && UI.sel.type === "comp" && UI.sel.comp === c)) UI.select({ type: "comp", comp: c });
        UI.setHint && UI.setHint(c.ref + " symbol is locked — press " + (Keymap.keyFor ? Keymap.keyFor("edit.lock") : "L") + " to unlock");
        Sch.render();
        return;
      }
      if (Sch.boxSel.includes(c)){
        Sch.drag = { kind: "group", group: Sch.boxSel.map(g => ({ c: g, dx: mx - g.schX, dy: my - g.schY })), armed: false, moved: false, clickComp: c, shift: e.shiftKey };
      } else {
        // select the grabbed part right away so the previously-selected object doesn't
        // stay highlighted while this one is being dragged
        Sch.boxSel = [];
        Sch.selWire = null; Sch.selWires = null; Sch.selLabel = null; Sch.selSeg = null;
        if (!(UI.sel && UI.sel.type === "comp" && UI.sel.comp === c)) UI.select({ type: "comp", comp: c });
        Sch.drag = { kind: "comp", comp: c, dx: mx - c.schX, dy: my - c.schY, armed: false, moved: false, clickComp: c, shift: e.shiftKey };
        Sch.render();
      }
      return;
    }
    // wire under the cursor? select it (Delete removes) and grab the SEGMENT so a
    // drag slides it perpendicular (horizontal segments move up/down, vertical ones
    // left/right); anchored ends stay pinned via an inserted corner. Shift-click marks
    // ONLY the clicked segment (Delete then removes that leg, splitting the wire).
    if (ws){
      Sch.selWire = ws.w;
      Sch.selWires = schConnectedWires(ws.w);          // highlight the whole connected net
      Sch.selSeg = e.shiftKey ? { w: ws.w, i: ws.i } : null;
      Sch.drag = e.shiftKey ? null : { kind: "wireseg", w: ws.w, i: ws.i, armed: false, moved: false };
      UI.select(null);
      Sch.render();
      return;
    }
    if (Sch.selWire || Sch.selSeg){ Sch.selWire = null; Sch.selWires = null; Sch.selSeg = null; }
    // empty space: box select (left-drag pan is gone — pan with wheel-click / Space)
    Sch.boxSel = [];
    UI.select(null);
    Sch.drag = { kind: "marquee", sx: mx, sy: my, x: mx, y: my, moved: false };
    Sch.render();
  });

  cv.addEventListener("pointermove", (e) => {
    const p = pt(e);
    Sch._lastP = p; Sch._lastEvt = e;
    Sch.onMove(p, e);
    schUpdateEdgeScroll(p);
  });

  // no pointer capture in wire mode → move events stop at the canvas border; kill the
  // auto-pan (and invalidate the stale last point) the moment the cursor leaves
  cv.addEventListener("pointerleave", () => {
    Sch._lastP = null;
    schStopEdgeScroll();
    if (Sch.hotPin){ Sch.hotPin = null; Sch.requestRender(); }
  });

  const endDrag = (e) => {
    schStopEdgeScroll();
    if (!Sch.drag) return;
    const d = Sch.drag;
    Sch.drag = null;
    if (d.kind === "pan"){ cv.style.cursor = Sch.mode === "wire" ? "crosshair" : "default"; return; }
    if (d.kind === "marquee"){
      if (d.moved){
        const lx = Math.min(d.sx, d.x), hx = Math.max(d.sx, d.x);
        const ly = Math.min(d.sy, d.y), hy = Math.max(d.sy, d.y);
        Sch.boxSel = State.components.filter(c => typeof c.schX === "number" &&
          c.schX >= lx && c.schX <= hx && c.schY >= ly && c.schY <= hy);
        UI.toast(Sch.boxSel.length ? Sch.boxSel.length + " symbol" + (Sch.boxSel.length===1?"":"s") + " selected — drag / arrows / wheel-click to move" : "Nothing in the box");
      }
      Sch.render();
      return;
    }
    if (d.kind === "wireend"){
      Sch.hotPin = null;
      if (!d.moved && d.armed){ cancelUndo(); Sch.render(); return; }
      // dropped on a pin? anchor the end to it (net-compatible only) so it re-connects
      const pin = d.moved ? schFindPin(Sch._lastP ? Sch._lastP.x : -1, Sch._lastP ? Sch._lastP.y : -1) : null;
      if (pin){
        const wireNet = d.w.netId || schNetOfAnchor(d.w.a) || schNetOfAnchor(d.w.b);
        const pinNet = schNetOfAnchor({ comp: pin.comp.id, pin: pin.pin });
        if (schWireEndPinOK(d.w, pin)){
          const key = d.idx === 0 ? "a" : "b";
          d.w[key] = { comp: pin.comp.id, pin: pin.pin };
          d.w.points[d.idx] = { x: pin.pos.x, y: pin.pos.y };
          if (!d.w.netId) d.w.netId = wireNet || pinNet || null;
        } else {
          UI.warn("Different net — " + (getNet(wireNet)?.name || "?") + " can't connect to " + (getNet(pinNet)?.name || "?"));
        }
      } else if (d.moved){
        // not on a pin — did the end land on another wire? allow it, but warn (like pins
        // do) when that wire is a different net so a stray touch isn't mistaken for a join
        const ep = d.w.points[d.idx];
        const hit = ep ? schWireOnPoint(ep, d.w, State.schWires) : null;
        if (hit){
          const wireNet = d.w.netId || schNetOfAnchor(d.w.a) || schNetOfAnchor(d.w.b);
          if (wireNet && hit.netId && wireNet !== hit.netId)
            UI.warn("Different net — " + (getNet(wireNet)?.name || "?") + " is touching " + (getNet(hit.netId)?.name || "?") + " but won't connect");
        }
      }
      d.w.points = schCleanPoints(d.w.points);
      Sch.render();
      return;
    }
    if (d.kind === "wireseg"){
      if (!d.moved && d.armed) cancelUndo();
      if (d.moved){
        // drop zero-length + collinear points a move may have collapsed (keeps it clean,
        // and re-merges a leg dragged back into line with its neighbour into one segment)
        d.w.points = schCleanPoints(d.w.points);
      }
      Sch.render();
      return;
    }
    if ((d.kind === "comp" || d.kind === "group") && !d.moved){
      if (d.armed) cancelUndo();
      const c = d.clickComp;
      if (c && d.shift){ schJumpToVisual(c); return; }
      if (c){ Sch.boxSel = []; UI.select({ type: "comp", comp: c }); }
      Sch.render();
    } else if (d.moved){
      // a moved symbol/group that pulled touching pins apart leaves a wire behind
      if ((d.kind === "comp" || d.kind === "group") && d.touchPairs && d.touchPairs.length)
        schSpawnTouchWires(d.touchPairs);
      Sch.render();                  // drop the drag highlight
    } else if (d.kind === "label" && !d.moved && d.armed){
      cancelUndo();
    }
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const p = pt(e);
    schContextMenu(e.clientX, e.clientY, p);
  });

  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pt(e);
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const wx = schS2X(p.x), wy = schS2Y(p.y);
    Sch.zoom = Math.max(0.4, Math.min(40, Sch.zoom * f));
    Sch.panX = p.x - wx * Sch.zoom;
    Sch.panY = p.y - wy * Sch.zoom;
    Sch.render();
  }, { passive: false });

  cv.addEventListener("dblclick", (e) => {
    const p = pt(e);
    if (Sch.mode === "wire"){ Sch.finishWire(null); return; }   // end a wire mid-air (stays red)
    const lab = schLabelHit(p.x, p.y);
    if (lab){ Sch.editLabel(lab); return; }
    const c = Sch.hit(schS2X(p.x), schS2Y(p.y));
    if (c) UI.openQuickEdit(c);
  });

  // schematic-local keys (capture phase, ahead of the global board hotkeys):
  // R rotate (or toggle wire H/V-first while drafting) · X/Y flip · W wire mode ·
  // N net label at cursor · arrows nudge selection / pan · Esc · Delete
  window.addEventListener("keydown", (e) => {
    if (EditorTabs.current !== "schematic") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && e.target.matches && e.target.matches("input,select,textarea")) return;
    if (document.querySelector("dialog[open]")) return;
    const k = e.key;
    if (k === "r" || k === "R"){
      if (Sch.mode === "wire"){
        // while tracing, R flips which leg is routed first (vertical ⇄ horizontal)
        Sch.axisPref = Sch.axisPref === "v" ? "h" : "v";
        UI.toast("Wire routing: " + (Sch.axisPref === "v" ? "vertical" : "horizontal") + " first");
        if (Sch.wireDraft && Sch._lastP) Sch.onMove(Sch._lastP, e);
      } else {
        const t = Sch.targets();
        if (!t.length){ /* consumed — R must never rotate the BOARD part from this tab */ }
        else if (t.length === 1) Sch.rotate(t[0]);
        else {
          // rotate the whole selection as ONE block: every symbol spins 90° AND its
          // position orbits the group's centre (not each part spinning in place).
          // Bail without an undo step if every symbol in the selection is locked.
          const movable = t.filter(c => !compSchMoveLocked(c));
          if (movable.length){
            pushUndo("rotate schematic selection");
            let cx = 0, cy = 0;
            for (const c of t){ cx += c.schX; cy += c.schY; }
            cx = schSnap(cx / t.length); cy = schSnap(cy / t.length);
            for (const c of movable){
              const dx = c.schX - cx, dy = c.schY - cy;
              c.schX = schSnap(cx + dy);   // 90° CCW on screen (y-down): (dx,dy) → (dy,−dx)
              c.schY = schSnap(cy - dx);
              c.schRot = (schRotOf(c) + 90) % 360;
              schUpdateWiresFor(c);
            }
            Sch.render();
          }
        }
      }
    } else if (k === "x" || k === "X" || k === "y" || k === "Y"){
      const vert = (k === "y" || k === "Y");
      const t = Sch.targets();
      if (!t.length){ /* consumed — X must not toggle the board X-ray from this tab */ }
      else if (t.length > 1){
        const movable = t.filter(c => !compSchMoveLocked(c));
        if (movable.length){
          pushUndo("flip schematic selection");
          for (const c of movable){ schFlipComp(c, vert); schUpdateWiresFor(c); }
          Sch.render();
        }
      } else Sch.flip(t[0], vert);
    } else if (k === "n" || k === "N"){
      if (!Sch._lastP) return;
      const pin = schFindPin(Sch._lastP.x, Sch._lastP.y, 16);
      if (pin) Sch.addLabel(pin.comp, pin.pin);
      else UI.toast("Hover a pin and press N to pin a net label to it");
    } else if (k === "w" || k === "W"){
      Sch.setMode(Sch.mode === "wire" ? "select" : "wire");
      UI.toast(Sch.mode === "wire"
        ? "Wire mode — start on a pin, click corners (90° snapped), end on a same-net pin. R flips H/V-first, Esc exits."
        : "Wire mode off");
    } else if (k === "Escape"){
      if (Sch.mode === "wire"){ Sch.wireDraft = null; Sch.setMode("select"); UI.toast("Wire mode off"); }
      else if (Sch.selWire || Sch.selLabel || Sch.selSeg){ Sch.selWire = null; Sch.selWires = null; Sch.selLabel = null; Sch.selSeg = null; Sch.render(); }
      else if (Sch.boxSel.length){ Sch.boxSel = []; Sch.render(); }
      else return;   // let the global Esc (deselect) run
    } else if (k === "Delete"){
      if (Sch.selLabel){ Sch.deleteLabel(Sch.selLabel); }
      else if (Sch.selSeg){ Sch.deleteSegment(Sch.selSeg); }
      else if (Sch.selWire){
        const kill = new Set(Sch.selWires && Sch.selWires.length ? Sch.selWires : [Sch.selWire]);
        pushUndo(kill.size > 1 ? "delete schematic wires" : "delete schematic wire");
        State.schWires = State.schWires.filter(w => !kill.has(w));
        Sch.selWire = null; Sch.selWires = null;
        Sch.render();
      }
      // always consumed: Delete on this tab must never delete the part from the BOARD
    } else if (k === "Enter" && Sch.wireDraft){
      Sch.finishWire(null);
    } else if (k.startsWith("Arrow")){
      const dx = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0;
      const dy = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
      if (!Sch.nudgeSelection(dx, dy)){
        // nothing selected → arrows pan the schematic view
        Sch.panX -= dx * 60; Sch.panY -= dy * 60;
        Sch.render();
      }
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  $("#sch-arrange-go").addEventListener("click", async () => {
    const mode = $("#sch-arrange").value;
    if (mode === "ai"){ Sch.arrangeAI(); return; }
    // re-arranging moves every part, so any hand-drawn wires would be left dangling —
    // clear them, but warn first so the user can back out (undoable either way).
    const hadWires = State.schWires.length > 0;
    if (!Sch.confirmArrangeClearsWires()) return;
    pushUndo("arrange schematic");
    if (hadWires){ State.schWires = []; Sch.selWire = null; Sch.selWires = null; Sch.selSeg = null; }
    const geo = (Sch.invalidate(), Sch.geo());
    const pos = schArrange(mode, geo);
    for (const c of State.components){
      const p = pos.get(c.id);
      if (p){ c.schX = schSnap(p.x); c.schY = schSnap(p.y); }
      schUpdateWiresFor(c);
    }
    Sch.fit();
    UI.toast("Schematic re-arranged (" + $("#sch-arrange").selectedOptions[0].textContent.split("—")[0].trim() + ")" +
      (hadWires ? " — wires cleared" : "") + " — undoable");
  });
  $("#sch-fit").addEventListener("click", () => Sch.fit());
  $("#sch-wire").addEventListener("click", () => {
    Sch.setMode(Sch.mode === "wire" ? "select" : "wire");
  });
  $("#sch-export").addEventListener("click", () => {
    $("#export-format").value = "sch";
    $("#export-arrange").value = "manual";
    UI.openExport();
  });
  const auto = $("#sch-autolabels");
  if (auto){
    auto.checked = schAutoLabelsOn();
    auto.addEventListener("change", () => {
      try { localStorage.setItem("pcbreveng.sch.autoLabels", auto.checked ? "on" : "off"); } catch(e){}
      Sch.render();
    });
  }

  window.addEventListener("resize", () => {
    if (EditorTabs.current === "schematic"){ Sch.resize(); Sch.render(); }
  });
};

/* every board mutation ends in a requestRender() — piggy-back on it so the schematic
   (geometry, nets, values) always reflects the live model while its tab is open */
const _schPrevRequestRender = window.requestRender;
window.requestRender = function(){
  _schPrevRequestRender();
  if (EditorTabs.current === "schematic"){ Sch.invalidate(); Sch.requestRender(); }
};

window.addEventListener("DOMContentLoaded", () => {
  EditorTabs.wire();
  Sch.wire();
});
