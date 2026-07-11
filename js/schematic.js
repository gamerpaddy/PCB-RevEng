/* ===== schematic.js — editor tabs (Visual / Schematic / BOM) + schematic editor =====
   The Schematic tab (experimental, enabled in the Lab dialog) is an interactive
   arrangement editor over the SAME data the .kicad_sch exporter uses: symbols come
   from schGeometry() (netlist.js), positions/rotation live on each component as
   schX/schY (schematic mm) and schRot (R key, CCW 90° steps) — serialized/undone
   with the component, exported as the "Manual" arrangement. Thin blue ratlines
   (per-net MST) show which pins belong together; power nets (GND/VCC/+5V…) draw
   as fixed power symbols instead of wires; W draws 90°-snapped schematic wires
   (State.schWires) that follow their pins when parts move or rotate.
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
  drag: null,                      // {comp,dx,dy,armed} symbol drag · {pan,sx,sy,px,py} view pan
  hover: null,                     // component under the cursor
  wireDraft: null,                 // {points:[{x,y}mm], a:{comp,pin}|null, preview:[{x,y}]|null}
  selWire: null,                   // selected schematic wire (Delete removes it)
};

const SCH_GRID = 1.27;             // KiCad half-grid — positions & wires snap to it

/* mm → screen px */
function schX2S(x){ return x * Sch.zoom + Sch.panX; }
function schY2S(y){ return y * Sch.zoom + Sch.panY; }
function schS2X(sx){ return (sx - Sch.panX) / Sch.zoom; }
function schS2Y(sy){ return (sy - Sch.panY) / Sch.zoom; }
const schSnap = (v) => Math.round(v / SCH_GRID) * SCH_GRID;

Sch.invalidate = () => { Sch._geo = null; };
Sch.geo = () => (Sch._geo || (Sch._geo = schGeometry()));

Sch.requestRender = () => {
  if (Sch._queued) return;
  Sch._queued = true;
  requestAnimationFrame(() => { Sch._queued = false; if (EditorTabs.current === "schematic") Sch.render(); });
};

/* a pin's position in schematic mm (y down), honouring the symbol's rotation */
function schPinPos(c, i, geo){
  const g = (geo || Sch.geo()).get(c.id);
  if (!g || typeof c.schX !== "number") return null;
  const pg = g.pins[i]; if (!pg) return null;
  const r = schRot2d(pg.x, pg.y, c.schRot);
  return { x: c.schX + r.x, y: c.schY - r.y };
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

/* components that never got a schematic position (project predates the editor, or a
   part was just placed on the board) → seed them from the manual arrangement (which
   packs newcomers below the already-arranged ones, or runs the default grouped grid
   when nothing is arranged yet). Passive default — not an undo step. */
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

  schDrawRatlines(ctx, comps, geo);
  schDrawWires(ctx);
  for (const c of comps) schDrawSymbol(ctx, c, geo.get(c.id));
  schDrawPowerPins(ctx, comps, geo);
  schDrawWireDraft(ctx);
};

/* thin blue ratlines: per net, a minimum-spanning tree over every connected pin
   (centroid star for very large nets), showing which pins must be wired together.
   Power nets are skipped (they get power symbols), as are pin pairs already joined
   by a drawn wire. While a symbol is being dragged, ITS nets are highlighted and
   their pins marked, so you can see exactly what the moved part connects to. */
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
  const dragComp = Sch.drag && Sch.drag.comp;
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

/* fixed power symbols: a GND bar below / supply tick + name above each pin on a
   power net — replaces their airwires entirely (KiCad-style, far fewer wires) */
function schDrawPowerPins(ctx, comps, geo){
  const s = Sch.zoom;
  const showText = s > 2.2;
  ctx.lineWidth = Math.max(1, Math.min(2, 0.22 * s));
  ctx.textAlign = "center";
  for (const c of comps){
    for (let i = 0; i < c.pins.length; i++){
      const pin = c.pins[i];
      if (!pin.netId) continue;
      const net = getNet(pin.netId);
      if (!schIsPowerNet(net)) continue;
      const p = schPinPos(c, i, geo); if (!p) continue;
      const X = schX2S(p.x), Y = schY2S(p.y);
      const gnd = schIsGroundNet(net);
      ctx.strokeStyle = ctx.fillStyle = gnd ? "#9aa3ad" : "#ff8080";
      ctx.beginPath();
      if (gnd){                       // lead down + 3 shrinking bars
        ctx.moveTo(X, Y); ctx.lineTo(X, Y + 1.5*s);
        ctx.moveTo(X - 1.1*s, Y + 1.5*s); ctx.lineTo(X + 1.1*s, Y + 1.5*s);
        ctx.moveTo(X - 0.7*s, Y + 2.0*s); ctx.lineTo(X + 0.7*s, Y + 2.0*s);
        ctx.moveTo(X - 0.3*s, Y + 2.5*s); ctx.lineTo(X + 0.3*s, Y + 2.5*s);
        ctx.stroke();
        if (showText && !/^gnd$/i.test(net.name)){
          ctx.font = (1.1 * s) + "px sans-serif";
          ctx.fillText(net.name, X, Y + 3.6*s);
        }
      } else {                        // lead up + supply bar + net name
        ctx.moveTo(X, Y); ctx.lineTo(X, Y - 1.5*s);
        ctx.moveTo(X - 0.9*s, Y - 1.5*s); ctx.lineTo(X + 0.9*s, Y - 1.5*s);
        ctx.stroke();
        if (showText){
          ctx.font = (1.2 * s) + "px sans-serif";
          ctx.fillText(net.name, X, Y - 2.1*s);
        }
      }
    }
  }
  ctx.textAlign = "left";
}

/* ---------- schematic wires ---------- */
function schWireColor(w){
  const net = w.netId ? getNet(w.netId) : null;
  return net ? (net.color || "#54c66a") : "#54c66a";
}

function schDrawWires(ctx){
  for (const w of State.schWires){
    const pts = w.points;
    if (!pts || pts.length < 2) continue;
    const sel = w === Sch.selWire;
    ctx.strokeStyle = sel ? "#4da3ff" : schWireColor(w);
    ctx.lineWidth = sel ? 2.4 : 1.6;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(schX2S(p.x), schY2S(p.y)) : ctx.moveTo(schX2S(p.x), schY2S(p.y)));
    ctx.stroke();
    // connection dots on anchored ends
    ctx.fillStyle = ctx.strokeStyle;
    if (w.a){ const p = pts[0];             ctx.beginPath(); ctx.arc(schX2S(p.x), schY2S(p.y), 2.2, 0, Math.PI*2); ctx.fill(); }
    if (w.b){ const p = pts[pts.length-1];  ctx.beginPath(); ctx.arc(schX2S(p.x), schY2S(p.y), 2.2, 0, Math.PI*2); ctx.fill(); }
  }
}

function schDrawWireDraft(ctx){
  const d = Sch.wireDraft;
  if (Sch.mode !== "wire") return;
  if (d && d.points.length){
    ctx.strokeStyle = "#54c66a";
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
  }
}

/* 90°-snapped path from L to target T: straight when aligned, else one corner.
   prevDir ("h"/"v"/null) = direction of the previous segment, so the wire turns. */
function schOrthoPath(L, T, prevDir){
  if (Math.abs(L.x - T.x) < 0.01 || Math.abs(L.y - T.y) < 0.01) return [T];
  const horizFirst = prevDir === "h" ? false : prevDir === "v" ? true
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

/* wires whose endpoint is anchored to a pin of `comp` follow the pin when the part
   moves or rotates; the neighbouring point is shifted to keep every bend at 90° */
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

/* distance (screen px) from a point to a wire, for click-select */
function schWireHit(sx, sy){
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
      if (px*px + py*py <= tol*tol) return w;
    }
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

  // geometry (body + pin stubs) is drawn inside a rotated frame; local mm +y up.
  // a CCW symbol rotation appears as a −θ canvas rotation because y is flipped.
  ctx.save();
  ctx.translate(X, Y);
  ctx.rotate(-rot * Math.PI / 180);
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

  // pin stubs (rotate with the body)
  for (let i = 0; i < c.pins.length; i++){
    const pg = g.pins[i]; if (!pg) continue;
    const a = (pg.angle || 0) * Math.PI / 180;
    ctx.beginPath();
    ctx.moveTo(lx(pg.x), ly(pg.y));
    ctx.lineTo(lx(pg.x + Math.cos(a) * pg.len), ly(pg.y + Math.sin(a) * pg.len));
    ctx.stroke();
  }
  ctx.restore();

  // pin numbers / names stay upright — positions rotated, text not
  const showText = s > 3.2;
  if (showText){
    for (let i = 0; i < c.pins.length; i++){
      const pg = g.pins[i]; if (!pg) continue;
      const a = (pg.angle || 0) * Math.PI / 180;
      const eff = ((pg.angle || 0) + rot) % 360;
      if (!g.hideNums){
        const mid = schRot2d(pg.x + Math.cos(a)*pg.len/2, pg.y + Math.sin(a)*pg.len/2, rot);
        ctx.fillStyle = "#8b96a5";
        ctx.font = (1.15 * s) + "px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.pins[i].num, X + mid.x * s, Y - mid.y * s - 0.35 * s);
      }
      if (!g.hideNames){
        // unnamed pin → show its NET name instead (display only, never exported)
        const net = c.pins[i].netId ? getNet(c.pins[i].netId) : null;
        const nm = c.pins[i].name || (net && !schIsPowerNet(net) ? net.name : "");
        if (nm){
          const inn = schRot2d(pg.x + Math.cos(a)*(pg.len + 0.6), pg.y + Math.sin(a)*(pg.len + 0.6), rot);
          ctx.fillStyle = c.pins[i].name ? "#aeb7c2" : "#6f92b8";   // net-name stand-ins slightly blue
          ctx.font = (c.pins[i].name ? "" : "italic ") + (1.15 * s) + "px sans-serif";
          ctx.textAlign = eff === 0 ? "left" : eff === 180 ? "right" : "center";
          ctx.fillText(nm, X + inn.x * s, Y - inn.y * s + 0.4 * s);
        }
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
  const selected = UI.sel && UI.sel.type === "comp" && UI.sel.comp === c;
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

Sch.setMode = (mode) => {
  Sch.mode = mode;
  Sch.wireDraft = null;
  const btn = $("#sch-wire");
  if (btn) btn.classList.toggle("active", mode === "wire");
  if (Sch.canvas) Sch.canvas.style.cursor = mode === "wire" ? "crosshair" : "default";
  Sch.render();
};

/* finish the wire draft → a persisted State.schWires entry */
Sch.finishWire = (endAnchor) => {
  const d = Sch.wireDraft;
  Sch.wireDraft = null;
  if (!d || d.points.length < 2){ Sch.render(); return; }
  // net comes from whichever end lands on a pin; two different nets = warning, first wins
  let netId = null;
  const netOf = (an) => { if (!an) return null; const c = getComp(an.comp); return c ? (c.pins[an.pin] || {}).netId || null : null; };
  const na = netOf(d.a), nb = netOf(endAnchor);
  netId = na || nb;
  if (na && nb && na !== nb)
    UI.warn("Wire joins pins of different nets (" + (getNet(na)?.name || "?") + " vs " + (getNet(nb)?.name || "?") + ") — nets are NOT merged");
  pushUndo("draw schematic wire");
  State.schWires.push({ id: nextId(), netId, points: d.points, a: d.a, b: endAnchor || null });
  Sch.render();
};

Sch.wire = () => {
  Sch.canvas = $("#sch-canvas");
  if (!Sch.canvas) return;
  Sch.ctx = Sch.canvas.getContext("2d");
  const cv = Sch.canvas;
  const pt = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  cv.addEventListener("pointerdown", (e) => {
    const p = pt(e);
    const mx = schS2X(p.x), my = schS2Y(p.y);

    if (Sch.mode === "wire" && e.button === 0){
      const pin = schFindPin(p.x, p.y);
      const d = Sch.wireDraft;
      if (!d){
        // start: on a pin (anchored) or on the grid
        const start = pin ? pin.pos : { x: schSnap(mx), y: schSnap(my) };
        Sch.wireDraft = { points: [{ x: start.x, y: start.y }],
                          a: pin ? { comp: pin.comp.id, pin: pin.pin } : null, preview: null };
      } else {
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
    const c = e.button === 0 ? Sch.hit(mx, my) : null;
    if (c){ Sch.drag = { comp: c, dx: mx - c.schX, dy: my - c.schY, armed: false, moved: false }; return; }
    // wire under the cursor? select it (Delete removes)
    const w = e.button === 0 ? schWireHit(p.x, p.y) : null;
    if (w){ Sch.selWire = w; Sch.drag = null; Sch.render(); return; }
    if (Sch.selWire){ Sch.selWire = null; Sch.render(); }
    Sch.drag = { pan: true, sx: p.x, sy: p.y, px: Sch.panX, py: Sch.panY };
  });

  cv.addEventListener("pointermove", (e) => {
    const p = pt(e);
    if (Sch.mode === "wire"){
      const d = Sch.wireDraft;
      if (d){
        const last = d.points[d.points.length - 1];
        const pin = schFindPin(p.x, p.y);
        const prevDir = d.points.length > 1 ? schSegDir(d.points[d.points.length-2], last) : null;
        const target = pin ? pin.pos : { x: schSnap(schS2X(p.x)), y: schSnap(schS2Y(p.y)) };
        d.preview = schOrthoPath(last, target, prevDir);
        Sch.requestRender();
      }
      return;
    }
    if (Sch.drag){
      if (Sch.drag.pan){
        Sch.panX = Sch.drag.px + (p.x - Sch.drag.sx);
        Sch.panY = Sch.drag.py + (p.y - Sch.drag.sy);
        Sch.render();
        return;
      }
      const c = Sch.drag.comp;
      const nx = schSnap(schS2X(p.x) - Sch.drag.dx);
      const ny = schSnap(schS2Y(p.y) - Sch.drag.dy);
      if (nx === c.schX && ny === c.schY) return;
      if (!Sch.drag.armed){ pushUndo("move schematic symbol"); Sch.drag.armed = true; }
      Sch.drag.moved = true;
      c.schX = nx; c.schY = ny;
      schUpdateWiresFor(c);          // anchored wires travel with their pins
      Sch.render();
      return;
    }
    const h = Sch.hit(schS2X(p.x), schS2Y(p.y));
    if (h !== Sch.hover){
      Sch.hover = h;
      cv.style.cursor = h ? "move" : "default";
      Sch.requestRender();
    }
  });

  const endDrag = (e) => {
    if (!Sch.drag) return;
    const d = Sch.drag;
    Sch.drag = null;
    if (d.comp && !d.moved){
      // plain click → select (synchronised with the board editor's selection)
      UI.select({ type: "comp", comp: d.comp });
      Sch.render();
    } else if (d.comp && d.moved){
      Sch.render();                  // drop the drag highlight
    }
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

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
    if (Sch.mode === "wire"){ Sch.finishWire(null); return; }   // end a wire mid-air
    const c = Sch.hit(schS2X(p.x), schS2Y(p.y));
    if (c) UI.openQuickEdit(c);
  });

  // schematic-local keys (capture phase, ahead of the global board hotkeys):
  // R rotate · W wire mode · Esc cancel/exit · Delete selected wire
  window.addEventListener("keydown", (e) => {
    if (EditorTabs.current !== "schematic") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target && e.target.matches && e.target.matches("input,select,textarea")) return;
    if (document.querySelector("dialog[open]")) return;
    const k = e.key;
    if (k === "r" || k === "R"){
      const c = Sch.hover || (UI.sel && UI.sel.type === "comp" ? UI.sel.comp : null);
      if (c) Sch.rotate(c);
    } else if (k === "w" || k === "W"){
      Sch.setMode(Sch.mode === "wire" ? "select" : "wire");
      UI.toast(Sch.mode === "wire"
        ? "Wire mode — click a pin, then click corners (90° snapped); end on a pin. Esc exits."
        : "Wire mode off");
    } else if (k === "Escape"){
      if (Sch.wireDraft){ Sch.wireDraft = null; Sch.render(); }
      else if (Sch.mode === "wire"){ Sch.setMode("select"); }
      else if (Sch.selWire){ Sch.selWire = null; Sch.render(); }
      else return;   // let the global Esc (deselect) run
    } else if ((k === "Delete" || k === "Backspace") && Sch.selWire){
      pushUndo("delete schematic wire");
      State.schWires = State.schWires.filter(w => w !== Sch.selWire);
      Sch.selWire = null;
      Sch.render();
    } else if (k === "Enter" && Sch.wireDraft){
      Sch.finishWire(null);
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
