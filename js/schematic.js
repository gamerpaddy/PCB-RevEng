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

/* Lab toggle — retained across sessions like every experimental setting */
function SchEnabled(){
  try { return localStorage.getItem("pcbreveng.lab.schematic") === "on"; } catch(e){ return false; }
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
  selWire: null,                   // selected schematic wire (Delete removes it)
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

/* pins already joined by a drawn wire — their ratline is redundant */
function schWiredPinSet(){
  const set = new Set();
  for (const w of State.schWires){
    if (w.a && w.b){ set.add(w.a.comp + ":" + w.a.pin); set.add(w.b.comp + ":" + w.b.pin); }
  }
  return set;
}

/* ---------- net connectivity (wire colouring) ----------
   A net is "fully connected" when every non-power pin on it is joined into ONE
   group by fully-anchored wires (single-pin nets count as connected). A wire is
   green only when it has both ends on pins AND its net is fully connected;
   anything dangling or partial draws red. */
function schNetStatus(){
  const stat = new Map();                       // netId -> {complete}
  const pinsByNet = new Map();                  // netId -> ["compId:pin", ...]
  for (const c of State.components){
    if (typeof c.schX !== "number") continue;
    for (let i = 0; i < c.pins.length; i++){
      const nid = c.pins[i].netId;
      if (!nid || schIsPowerNet(getNet(nid))) continue;
      let a = pinsByNet.get(nid); if (!a) pinsByNet.set(nid, a = []);
      a.push(c.id + ":" + i);
    }
  }
  for (const [nid, pins] of pinsByNet){
    if (pins.length < 2){ stat.set(nid, { complete: true }); continue; }
    // union-find over the net's pins, unioned by fully-anchored wires
    const idx = new Map(pins.map((k, i) => [k, i]));
    const par = pins.map((_, i) => i);
    const find = (i) => { while (par[i] !== i){ par[i] = par[par[i]]; i = par[i]; } return i; };
    let ok = true;
    for (const w of State.schWires){
      if (w.netId !== nid) continue;
      if (!w.a || !w.b){ ok = false; continue; }      // dangling wire on this net
      const ia = idx.get(w.a.comp + ":" + w.a.pin), ib = idx.get(w.b.comp + ":" + w.b.pin);
      if (ia == null || ib == null) continue;
      par[find(ia)] = find(ib);
    }
    const root = find(0);
    for (let i = 1; i < pins.length && ok; i++) if (find(i) !== root) ok = false;
    stat.set(nid, { complete: ok });
  }
  return stat;
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

/* centre + zoom the schematic view on one component (cross-jump from the board) */
Sch.focusComp = (c) => {
  Sch.ensurePositions();
  if (typeof c.schX !== "number") return;
  Sch.resize();
  Sch.zoom = Math.max(Sch.zoom, 8);
  Sch.panX = Sch.width/2  - c.schX * Sch.zoom;
  Sch.panY = Sch.height/2 - c.schY * Sch.zoom;
  UI.select({ type: "comp", comp: c });
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

  schDrawRatlines(ctx, comps, geo);
  schDrawWires(ctx);
  for (const c of comps) schDrawSymbol(ctx, c, geo.get(c.id));
  schDrawPowerPins(ctx, comps, geo);
  schDrawNetLabels(ctx, comps, geo);
  schDrawWireDraft(ctx);
  schDrawHotPin(ctx);
  schDrawMarquee(ctx);
};

/* thin blue ratlines: per net, a minimum-spanning tree over every connected pin
   (centroid star for very large nets), showing which pins must be wired together. */
function schDrawRatlines(ctx, comps, geo){
  const wired = schWiredPinSet();
  const byNet = new Map();
  for (const c of comps){
    for (let i = 0; i < c.pins.length; i++){
      const pin = c.pins[i];
      if (!pin.netId) continue;
      const net = getNet(pin.netId);
      if (schIsPowerNet(net)) continue;              // power pins draw a symbol instead
      if (wired.has(c.id + ":" + i)) continue;       // already joined by a real wire
      const p = schPinPos(c, i, geo); if (!p) continue;
      let a = byNet.get(pin.netId); if (!a) byNet.set(pin.netId, a = []);
      a.push({ x: schX2S(p.x), y: schY2S(p.y) });
    }
  }
  const dragComp = Sch.drag && (Sch.drag.comp || (Sch.drag.group && Sch.drag.group[0] && Sch.drag.group[0].c));
  const hotNets = new Set();
  if (dragComp) for (const pin of dragComp.pins) if (pin.netId) hotNets.add(pin.netId);

  const pass = (hot) => {
    ctx.strokeStyle = hot ? "#7ec3ff" : "#3f9bff";
    ctx.lineWidth = hot ? 1.8 : 1;
    ctx.globalAlpha = hot ? 1 : (dragComp ? 0.35 : 0.75);
    ctx.beginPath();
    for (const [netId, pts] of byNet){
      if (hotNets.has(netId) !== hot) continue;
      schPathNet(ctx, pts);
    }
    ctx.stroke();
    if (hot){                                        // mark the connected pins
      ctx.fillStyle = "#7ec3ff";
      for (const [netId, pts] of byNet){
        if (!hotNets.has(netId)) continue;
        for (const p of pts){ ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI*2); ctx.fill(); }
      }
    }
  };
  pass(false);
  if (hotNets.size) pass(true);
  ctx.globalAlpha = 1;
}

/* path one net's airwires into the current ctx path (MST, or centroid star when huge) */
function schPathNet(ctx, pts){
  const n = pts.length;
  if (n < 2) return;
  if (n > 120){
    let cx = 0, cy = 0;
    for (const p of pts){ cx += p.x; cy += p.y; }
    cx /= n; cy /= n;
    for (const p of pts){ ctx.moveTo(p.x, p.y); ctx.lineTo(cx, cy); }
    return;
  }
  // Prim's MST
  const inTree = new Array(n).fill(false);
  const dist = new Array(n).fill(Infinity);
  const from = new Array(n).fill(0);
  inTree[0] = true;
  for (let i = 1; i < n; i++){
    const dx = pts[i].x - pts[0].x, dy = pts[i].y - pts[0].y;
    dist[i] = dx*dx + dy*dy;
  }
  for (let k = 1; k < n; k++){
    let best = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!inTree[i] && dist[i] < bd){ bd = dist[i]; best = i; }
    if (best < 0) break;
    inTree[best] = true;
    ctx.moveTo(pts[from[best]].x, pts[from[best]].y);
    ctx.lineTo(pts[best].x, pts[best].y);
    for (let i = 0; i < n; i++){
      if (inTree[i]) continue;
      const dx = pts[i].x - pts[best].x, dy = pts[i].y - pts[best].y;
      const d = dx*dx + dy*dy;
      if (d < dist[i]){ dist[i] = d; from[i] = best; }
    }
  }
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

  // auto labels
  if (auto){
    ctx.fillStyle = "rgba(111,146,184,0.62)";
    for (const c of comps){
      const g = geo.get(c.id);
      for (let i = 0; i < c.pins.length; i++){
        const pin = c.pins[i];
        if (!pin.netId || manual.has(c.id + ":" + i)) continue;
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
function schDrawWires(ctx){
  const stat = schNetStatus();
  for (const w of State.schWires){
    const pts = w.points;
    if (!pts || pts.length < 2) continue;
    const sel = w === Sch.selWire;
    const good = w.a && w.b && (!w.netId || (stat.get(w.netId) || { complete: true }).complete);
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
    endDot(pts[0], !!w.a);
    endDot(pts[pts.length-1], !!w.b);
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

/* 90°-snapped path from L to target T: straight when aligned, else one corner.
   prevDir ("h"/"v"/null) = direction of the previous segment; Sch.axisPref (R while
   drafting) forces which leg comes first when there's no previous segment. */
function schOrthoPath(L, T, prevDir){
  if (Math.abs(L.x - T.x) < 0.01 || Math.abs(L.y - T.y) < 0.01) return [T];
  const horizFirst = prevDir === "h" ? false : prevDir === "v" ? true
                   : Sch.axisPref === "h" ? true : Sch.axisPref === "v" ? false
                   : Math.abs(T.x - L.x) >= Math.abs(T.y - L.y);
  return horizFirst ? [{ x: T.x, y: L.y }, T] : [{ x: L.x, y: T.y }, T];
}
function schSegDir(a, b){ return Math.abs(a.y - b.y) < 0.01 ? "h" : Math.abs(a.x - b.x) < 0.01 ? "v" : null; }

/* nearest pin within `tol` screen px of a screen point, or null */
function schFindPin(sx, sy, tol){
  tol = tol || 9;
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
    // short fully-anchored wire → just re-route it as a clean straight/L run
    if (touched && w.a && w.b && w.points.length <= 3){
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

  // reference above, value below (upright, above/below the rotated bbox)
  const { hw, hh } = schHalfExt(c, g);
  if (showText){
    ctx.fillStyle = stroke;
    ctx.font = "bold " + (1.6 * s) + "px sans-serif";
    ctx.fillText(c.ref, X, Y - (hh + 1.4) * s);
    const val = c.value || c.part || "";
    if (val){
      ctx.fillStyle = "#cfd6df";
      ctx.font = (1.35 * s) + "px sans-serif";
      ctx.fillText(val, X, Y + (hh + 2.2) * s);
    }
  }
  ctx.textAlign = "left";

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
    if (Math.abs(mx - c.schX) <= hw + 3 && Math.abs(my - c.schY) <= hh + 3) return c;
  }
  return null;
};

/* rotate a symbol 90° CCW (R key) — wires anchored to its pins follow */
Sch.rotate = (c) => {
  if (!c) return;
  pushUndo("rotate schematic symbol");
  c.schRot = (schRotOf(c) + 90) % 360;
  schUpdateWiresFor(c);
  Sch.render();
};

/* flip a symbol horizontally (X) or vertically (Y) — schematic only */
Sch.flip = (c, vert) => {
  if (!c) return;
  pushUndo("flip schematic symbol");
  if (vert) c.schFlipV = !c.schFlipV; else c.schFlipH = !c.schFlipH;
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
  Sch.selWire = null;
  Sch.render();
  return lab;
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

/* finish the wire draft → a persisted State.schWires entry */
Sch.finishWire = (endAnchor) => {
  const d = Sch.wireDraft;
  Sch.wireDraft = null;
  if (!d || d.points.length < 2){ Sch.render(); return; }
  const na = schNetOfAnchor(d.a), nb = schNetOfAnchor(endAnchor);
  pushUndo("draw schematic wire");
  State.schWires.push({ id: nextId(), netId: na || nb || null, points: d.points, a: d.a, b: endAnchor || null });
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
  return !!(d && (d.kind === "comp" || d.kind === "group" || d.kind === "label" || d.kind === "marquee" || d.kind === "wireseg"));
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
        // an anchored wire end (stays on its pin) or a COLLINEAR neighbouring segment
        // (shifting the shared corner would turn it diagonal); the copy becomes a 90° jog
        if ((d.i === 0 && d.w.a) || (d.i > 0 && schSegDir(pts[d.i-1], pts[d.i]) === dir)){
          pts.splice(d.i, 0, { x: pts[d.i].x, y: pts[d.i].y });
          d.i++;
        }
        const j = d.i + 1;
        if ((j === pts.length - 1 && d.w.b) || (j < pts.length - 1 && schSegDir(pts[j], pts[j+1]) === dir))
          pts.splice(j + 1, 0, { x: pts[j].x, y: pts[j].y });
      }
      const A = pts[d.i], B = pts[d.i+1];
      if (dir === "h"){ const y = schSnap(my); A.y = y; B.y = y; }
      else            { const x = schSnap(mx); A.x = x; B.x = x; }
      d.moved = true;
      Sch.render();
      return;
    }
    if (d.kind === "comp" || d.kind === "group"){
      const items = d.kind === "comp" ? [{ c: d.comp, dx: d.dx, dy: d.dy }] : d.group;
      const lead = items[0];
      const nx = schSnap(mx - lead.dx), ny = schSnap(my - lead.dy);
      if (nx === lead.c.schX && ny === lead.c.schY) return;
      if (!d.armed){ pushUndo(d.kind === "group" ? "move schematic selection" : "move schematic symbol"); d.armed = true; }
      d.moved = true;
      const shX = nx - lead.c.schX, shY = ny - lead.c.schY;
      for (const it of items){ it.c.schX += shX; it.c.schY += shY; schUpdateWiresFor(it.c); }
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
  // coalesce rapid arrow presses into one undo step
  const now = Date.now();
  if (!Sch._nudgeAt || now - Sch._nudgeAt > 1500) pushUndo("move schematic selection");
  Sch._nudgeAt = now;
  for (const c of targets){
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
    UI.select({ type: "comp", comp: c }); Sch.render();
    items.push({ label: "Rotate 90°  [R]", action: () => Sch.rotate(c) });
    items.push({ label: "Flip horizontal  [X]", action: () => Sch.flip(c, false) });
    items.push({ label: "Flip vertical  [Y]", action: () => Sch.flip(c, true) });
    items.push({ label: "Edit ref / value…", action: () => UI.openQuickEdit(c) });
    items.push({ sep: true });
    items.push({ label: "Show on board (Visual)", action: () => schJumpToVisual(c) });
  } else if (w){
    Sch.selWire = w; Sch.render();
    items.push({ label: "Delete wire", danger: true, action: () => {
      pushUndo("delete schematic wire");
      State.schWires = State.schWires.filter(x => x !== w);
      if (Sch.selWire === w) Sch.selWire = null;
      Sch.render();
    }});
  } else {
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
        if (!pin){ UI.toast("Wires start on a pin — click a pin to begin"); return; }
        Sch.wireDraft = { points: [{ x: pin.pos.x, y: pin.pos.y }],
                          a: { comp: pin.comp.id, pin: pin.pin }, preview: null };
        UI.select(null);           // drawing must not leave a part selected (stray R rotates it)
        Sch.boxSel = [];
      } else {
        // ending on a pin of a DIFFERENT net is refused
        if (pin){
          const na = schNetOfAnchor(d.a), nb = schNetOfAnchor({ comp: pin.comp.id, pin: pin.pin });
          if (na && nb && na !== nb){
            UI.warn("Different net — " + (getNet(na)?.name || "?") + " can't connect to " + (getNet(nb)?.name || "?"));
            return;
          }
        }
        const last = d.points[d.points.length - 1];
        const prevDir = d.points.length > 1 ? schSegDir(d.points[d.points.length-2], last) : null;
        const target = pin ? pin.pos : { x: schSnap(mx), y: schSnap(my) };
        for (const q of schOrthoPath(last, target, prevDir)) d.points.push({ x: q.x, y: q.y });
        d.preview = null;
        if (pin){ Sch.finishWire({ comp: pin.comp.id, pin: pin.pin }); return; }
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
      Sch.selLabel = lab; Sch.selWire = null;
      Sch.drag = pinPos ? { kind: "label", lab, pin: pinPos, offX: mx - pinPos.x - lab.dx, offY: my - pinPos.y - lab.dy, armed: false, moved: false } : null;
      Sch.render();
      return;
    }
    if (Sch.selLabel){ Sch.selLabel = null; Sch.render(); }

    const c = Sch.hit(mx, my);
    if (c){
      if (Sch.boxSel.includes(c)){
        Sch.drag = { kind: "group", group: Sch.boxSel.map(g => ({ c: g, dx: mx - g.schX, dy: my - g.schY })), armed: false, moved: false, clickComp: c, shift: e.shiftKey };
      } else {
        Sch.boxSel = [];
        Sch.drag = { kind: "comp", comp: c, dx: mx - c.schX, dy: my - c.schY, armed: false, moved: false, clickComp: c, shift: e.shiftKey };
      }
      return;
    }
    // wire under the cursor? select it (Delete removes) and grab the SEGMENT so a
    // drag slides it perpendicular (horizontal segments move up/down, vertical ones
    // left/right); anchored ends stay pinned via an inserted corner
    const ws = schWireSegHit(p.x, p.y);
    if (ws){
      Sch.selWire = ws.w;
      Sch.drag = { kind: "wireseg", w: ws.w, i: ws.i, armed: false, moved: false };
      Sch.render();
      return;
    }
    if (Sch.selWire){ Sch.selWire = null; }
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
    if (d.kind === "wireseg"){
      if (!d.moved && d.armed) cancelUndo();
      if (d.moved){
        // drop zero-length segments a move may have collapsed (keeps the polyline clean)
        const pts = d.w.points;
        d.w.points = pts.filter((p, i) => !i || Math.abs(p.x - pts[i-1].x) > 0.001 || Math.abs(p.y - pts[i-1].y) > 0.001);
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
          pushUndo("rotate schematic selection");
          for (const c of t){ c.schRot = (schRotOf(c) + 90) % 360; schUpdateWiresFor(c); }
          Sch.render();
        }
      }
    } else if (k === "x" || k === "X" || k === "y" || k === "Y"){
      const vert = (k === "y" || k === "Y");
      const t = Sch.targets();
      if (!t.length){ /* consumed — X must not toggle the board X-ray from this tab */ }
      else if (t.length > 1){
        pushUndo("flip schematic selection");
        for (const c of t){ if (vert) c.schFlipV = !c.schFlipV; else c.schFlipH = !c.schFlipH; schUpdateWiresFor(c); }
        Sch.render();
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
      else if (Sch.selWire || Sch.selLabel){ Sch.selWire = null; Sch.selLabel = null; Sch.render(); }
      else if (Sch.boxSel.length){ Sch.boxSel = []; Sch.render(); }
      else return;   // let the global Esc (deselect) run
    } else if (k === "Delete"){
      if (Sch.selLabel){ Sch.deleteLabel(Sch.selLabel); }
      else if (Sch.selWire){
        pushUndo("delete schematic wire");
        State.schWires = State.schWires.filter(w => w !== Sch.selWire);
        Sch.selWire = null;
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

  $("#sch-arrange-go").addEventListener("click", () => {
    const mode = $("#sch-arrange").value;
    pushUndo("arrange schematic");
    const geo = (Sch.invalidate(), Sch.geo());
    const pos = schArrange(mode, geo);
    for (const c of State.components){
      const p = pos.get(c.id);
      if (p){ c.schX = schSnap(p.x); c.schY = schSnap(p.y); }
      schUpdateWiresFor(c);
    }
    Sch.fit();
    UI.toast("Schematic re-arranged (" + $("#sch-arrange").selectedOptions[0].textContent.split("—")[0].trim() + ") — undoable");
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
