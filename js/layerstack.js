/* ===== layerstack.js — 3D copper-stack viewer =====
   The board is a real 3D object: each copper side is a plane at its own height in
   the stack, and the whole thing is rotated rigidly (turntable orbit: yaw spins,
   pitch tilts) and projected orthographically. Every primitive (planes, traces,
   real-shape pads, via pillars) is sorted by true camera depth and painted back to
   front, so the front side sits on top and occlusion is always correct. Left-drag
   orbits, middle-drag pans, wheel zooms. Read-only. */
"use strict";

const Stack3D = {
  dlg: null, canvas: null, ctx: null,
  yaw: -0.6,          // spin about the stack axis (horizontal drag)
  pitch: 1.0,         // tilt toward the viewer (vertical drag); free, no clamp
  gap: 1,             // world-space height between stacked planes (recomputed in _fit)
  gapFactor: 0.25,    // layer separation as a fraction of board extent
  scale: 1,           // world→screen content scale
  panX: 0, panY: 0,   // view pan (middle-drag)
  bounds: null,
  nSides: 2,
  drag: null,
  _wired: false,
  // section / clipping planes: a world-space box (x0..x1, y0..y1) plus a layer range
  // (zLo..zHi). Geometry is clipped to this box before projection, so you can slice
  // into the board or peel layers off the stack. `on` toggles the whole effect.
  clip: { on:false, x0:0, x1:0, y0:0, y1:0, zLo:0, zHi:1 },
};

Stack3D.open = function(){
  if (!this.dlg){
    this.dlg = document.getElementById("stack3d-dialog");
    this.canvas = document.getElementById("stack3d-canvas");
    this.ctx = this.canvas.getContext("2d");
  }
  if (!this._wired){ this._wire(); this._wired = true; }
  this.dlg.showModal();
  this._resize();
  this.panX = this.panY = 0;
  this._fit();
  this._resetClip();
  this._syncClipUI();
  this.render();
};

Stack3D.close = function(){ if (this.dlg) this.dlg.close(); };

Stack3D._wire = function(){
  const cv = this.canvas;
  cv.addEventListener("pointerdown", e => {
    cv.setPointerCapture(e.pointerId);
    const pan = e.button === 1 || e.shiftKey;
    if (e.button === 1) e.preventDefault();
    this.drag = { x:e.clientX, y:e.clientY, mode: pan ? "pan" : "orbit" };
  });
  cv.addEventListener("pointermove", e => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (this.drag.mode === "pan"){
      this.panX += dx; this.panY += dy;
    } else {
      this.yaw   += dx * 0.01;   // spin
      this.pitch += dy * 0.01;   // tilt — free rotation, no lock
    }
    this.drag.x = e.clientX; this.drag.y = e.clientY;
    this.render();
  });
  cv.addEventListener("pointerup",    () => { this.drag = null; });
  cv.addEventListener("pointercancel",() => { this.drag = null; });
  cv.addEventListener("auxclick", e => { if (e.button === 1) e.preventDefault(); });
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    this.scale *= e.deltaY < 0 ? 1.12 : 1/1.12;
    this.scale = Math.max(0.01, Math.min(120, this.scale));
    this.render();
  }, { passive:false });

  document.getElementById("stack3d-close").addEventListener("click", () => this.close());
  document.getElementById("stack3d-reset").addEventListener("click", () => {
    this.yaw = -0.6; this.pitch = 1.0; this.panX = this.panY = 0;
    this._fit(); this._resetClip(); this._syncClipUI(); this.render();
  });
  window.addEventListener("resize", () => {
    if (this.dlg && this.dlg.open){ this._resize(); this.render(); }
  });

  // --- clipping-plane controls ---
  const self = this;
  const chk = document.getElementById("s3d-clip");
  if (chk) chk.addEventListener("change", e => { self.clip.on = e.target.checked; self.render(); });
  // wire a low/high slider pair onto two clip fields, keeping low ≤ high; any drag
  // auto-enables clipping so the section is visible immediately. Reads self.clip live
  // (not a captured ref) so it keeps working even if the clip object is replaced.
  const pair = (loId, hiId, loKey, hiKey) => {
    const lo = document.getElementById(loId), hi = document.getElementById(hiId);
    if (!lo || !hi) return;
    const apply = () => {
      let a = +lo.value, b = +hi.value;
      if (a > b){ const t=a; a=b; b=t; }
      const clip = self.clip;
      clip[loKey] = a; clip[hiKey] = b;
      if (!clip.on){ clip.on = true; if (chk) chk.checked = true; }
      self.render();
    };
    lo.addEventListener("input", apply);
    hi.addEventListener("input", apply);
  };
  pair("s3d-x0", "s3d-x1", "x0", "x1");
  pair("s3d-y0", "s3d-y1", "y0", "y1");
  pair("s3d-z0", "s3d-z1", "zLo", "zHi");
};

/* reset the clip box to the full board / full stack */
Stack3D._resetClip = function(){
  const b = this.bounds; const c = this.clip;
  c.on = false;
  c.x0 = b.minX; c.x1 = b.maxX;
  c.y0 = b.minY; c.y1 = b.maxY;
  c.zLo = 0; c.zHi = Math.max(0, this.nSides - 1);
};

/* push the current clip box + board bounds into the slider widgets */
Stack3D._syncClipUI = function(){
  const b = this.bounds, c = this.clip;
  const setR = (id, min, max, val, step) => {
    const el = document.getElementById(id); if (!el) return;
    el.min = min; el.max = max; el.step = step; el.value = val;
  };
  const xs = (b.maxX - b.minX) / 300 || 1, ys = (b.maxY - b.minY) / 300 || 1;
  setR("s3d-x0", b.minX, b.maxX, c.x0, xs); setR("s3d-x1", b.minX, b.maxX, c.x1, xs);
  setR("s3d-y0", b.minY, b.maxY, c.y0, ys); setR("s3d-y1", b.minY, b.maxY, c.y1, ys);
  setR("s3d-z0", 0, this.nSides - 1, c.zLo, 1); setR("s3d-z1", 0, this.nSides - 1, c.zHi, 1);
  const chk = document.getElementById("s3d-clip"); if (chk) chk.checked = c.on;
};

Stack3D._resize = function(){
  const dpr = window.devicePixelRatio || 1;
  const r = this.canvas.getBoundingClientRect();
  this.canvas.width  = Math.max(1, Math.round(r.width  * dpr));
  this.canvas.height = Math.max(1, Math.round(r.height * dpr));
  this.cssW = r.width; this.cssH = r.height; this.dpr = dpr;
};

/* world-space bounds of all copper, for centering + fit */
Stack3D._bounds = function(){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity, any=false;
  const ext = (x,y)=>{ minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); any=true; };
  for (const t of State.traces) for (const p of t.points) ext(p.x, p.y);
  for (const v of State.vias) ext(v.x, v.y);
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const wp = pinWorldPos(c, fpin); ext(wp.x, wp.y);
    }
  }
  if (!any){ minX=-50;maxX=50;minY=-50;maxY=50; }
  return { cx:(minX+maxX)/2, cy:(minY+maxY)/2, w:(maxX-minX)||1, h:(maxY-minY)||1, minX, minY, maxX, maxY };
};

Stack3D._fit = function(){
  this.bounds = this._bounds();
  this.nSides = availableSides().length;
  const cw = this.cssW || 760, ch = this.cssH || 500;
  const ext = Math.max(this.bounds.w, this.bounds.h) || 1; // rotation may orient either way
  this.gap = this.gapFactor * ext;                          // world-space layer separation
  // Both the content (ext) and the stack height scale with `scale`, so the board stays a
  // rigid 3D object at every zoom level (fixes the squash/explode-on-zoom perspective bug).
  const denomH = ext * (1 + (this.nSides - 1) * this.gapFactor);
  this.scale = Math.min(cw * 0.6 / ext, ch * 0.6 / denomH);
  this.scale = Math.max(0.01, Math.min(120, this.scale));
};

/* project a world point on copper side `li` (0 = front) into the rotated 3D scene.
   Turntable: yaw about the stack axis, then pitch about the screen-horizontal axis.
   Returns canvas {x,y} plus a true camera `depth` (larger = nearer the viewer). */
Stack3D._project = function(wx, wy, li){
  const b = this.bounds, s = this.scale;
  const X = (wx - b.cx) * s;
  const Y = (wy - b.cy) * s;
  const Z = ((this.nSides - 1)/2 - li) * this.gap * s; // scales with zoom → rigid 3D object
  const cyaw = Math.cos(this.yaw), syaw = Math.sin(this.yaw);
  const X1 = X*cyaw - Y*syaw;
  const Y1 = X*syaw + Y*cyaw;
  const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
  const Y2    = Y1*cp + Z*sp;     // screen vertical (up positive) — front ends up on top
  const depth = Z*cp - Y1*sp;     // toward the camera
  return { x: this.cssW/2 + X1 + this.panX, y: this.cssH/2 - Y2 + this.panY, depth };
};

/* world-space polygon for a pad's real outline (rect → 4 corners, round → sampled
   circle), respecting component rotation / scale / back-mirror. */
Stack3D._padWorldPolygon = function(comp, fpin, shrink){
  shrink = shrink || 1;
  const s = State.pxPerMm * (comp.scale || 1);
  const cxL = fpin.xmm * s, cyL = fpin.ymm * s;
  const a = comp.rot * Math.PI/180, ca = Math.cos(a), sa = Math.sin(a);
  const toWorld = (lx, ly) => {
    if (comp.side === "back") lx = -lx;
    return { x: comp.x + lx*ca - ly*sa, y: comp.y + lx*sa + ly*ca };
  };
  const out = [];
  if (fpin.shape === "circle"){
    const r = fpin.w * s / 2 * shrink;
    for (let k=0; k<20; k++){ const ang = k/20*Math.PI*2; out.push(toWorld(cxL + r*Math.cos(ang), cyL + r*Math.sin(ang))); }
  } else {
    const hw = fpin.w*s/2*shrink, hh = fpin.h*s/2*shrink;
    [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].forEach(([ox,oy]) => out.push(toWorld(cxL+ox, cyL+oy)));
  }
  return out;
};

/* ---- world-space clipping against the section box (x0..x1, y0..y1) ---- */

/* Liang–Barsky: clip segment p→q to the box; returns {a,b,t0,t1} or null if fully outside. */
Stack3D._clipSeg = function(p, q, x0, x1, y0, y1){
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  const edges = [[-dx, p.x - x0], [dx, x1 - p.x], [-dy, p.y - y0], [dy, y1 - p.y]];
  for (const [pp, qq] of edges){
    if (pp === 0){ if (qq < 0) return null; }            // parallel and outside
    else {
      const r = qq / pp;
      if (pp < 0){ if (r > t1) return null; if (r > t0) t0 = r; }
      else       { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return { a:{x:p.x+t0*dx, y:p.y+t0*dy}, b:{x:p.x+t1*dx, y:p.y+t1*dy}, t0, t1 };
};

/* clip an open polyline to the box, returning a list of continuous world-space runs */
Stack3D._clipPolyline = function(pts){
  if (!this.clip.on) return [pts];
  const c = this.clip;
  const runs = []; let run = null, prevFull = false;
  for (let i=0; i<pts.length-1; i++){
    const s = this._clipSeg(pts[i], pts[i+1], c.x0, c.x1, c.y0, c.y1);
    if (!s){ run = null; prevFull = false; continue; }
    if (run && prevFull && s.t0 === 0) run.push(s.b);    // continues the previous run unbroken
    else { run = [s.a, s.b]; runs.push(run); }
    prevFull = (s.t1 === 1);
    if (!prevFull) run = null;                            // cut before the vertex → next segment starts fresh
  }
  return runs;
};

/* Sutherland–Hodgman: clip a filled polygon to the box (returns [] if nothing left) */
Stack3D._clipPolygon = function(poly){
  if (!this.clip.on) return poly;
  const c = this.clip;
  const clipEdge = (pts, inside, isect) => {
    const out = [];
    for (let i=0; i<pts.length; i++){
      const A = pts[i], B = pts[(i+1)%pts.length];
      const ai = inside(A), bi = inside(B);
      if (ai){ out.push(A); if (!bi) out.push(isect(A,B)); }
      else if (bi){ out.push(isect(A,B)); }
    }
    return out;
  };
  const ix = (k) => (A,B) => { const t = (k-A.x)/((B.x-A.x)||1e-9); return { x:k, y:A.y+t*(B.y-A.y) }; };
  const iy = (k) => (A,B) => { const t = (k-A.y)/((B.y-A.y)||1e-9); return { x:A.x+t*(B.x-A.x), y:k }; };
  let p = poly;
  p = clipEdge(p, A => A.x >= c.x0, ix(c.x0)); if (!p.length) return p;
  p = clipEdge(p, A => A.x <= c.x1, ix(c.x1)); if (!p.length) return p;
  p = clipEdge(p, A => A.y >= c.y0, iy(c.y0)); if (!p.length) return p;
  p = clipEdge(p, A => A.y <= c.y1, iy(c.y1));
  return p;
};

/* is a copper layer index hidden by the layer (Z) clip range? */
Stack3D._layerClipped = function(li){
  return this.clip.on && (li < this.clip.zLo || li > this.clip.zHi);
};

/* lighten (amt>0) / darken (amt<0) a #rrggbb colour */
function _shadeHex(hex, amt){
  if (typeof hex !== "string" || hex[0] !== "#" || hex.length < 7) return hex;
  let r = parseInt(hex.substr(1,2),16), g = parseInt(hex.substr(3,2),16), b = parseInt(hex.substr(5,2),16);
  const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round(r + (t-r)*p); g = Math.round(g + (t-g)*p); b = Math.round(b + (t-b)*p);
  return "#" + [r,g,b].map(v => Math.max(0,Math.min(255,v)).toString(16).padStart(2,"0")).join("");
}

const _avgDepth = (pts) => { let s=0; for (const p of pts) s+=p.depth; return s/pts.length; };

Stack3D.render = function(){
  const ctx = this.ctx, dpr = this.dpr || 1;
  if (!this.bounds) this._fit();
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,this.cssW,this.cssH);

  const sides = availableSides();           // [front, inner1…, back]
  this.nSides = sides.length;
  const b = this.bounds;
  const prims = [];                          // {depth, draw}

  // --- planes (a small bias keeps each plane just behind the copper drawn on it) ---
  const cl = this.clip;
  // the substrate rect, cropped to the section box when clipping is on
  const rX0 = cl.on ? Math.max(b.minX, cl.x0) : b.minX, rX1 = cl.on ? Math.min(b.maxX, cl.x1) : b.maxX;
  const rY0 = cl.on ? Math.max(b.minY, cl.y0) : b.minY, rY1 = cl.on ? Math.min(b.maxY, cl.y1) : b.maxY;
  const corners = [[rX0,rY0],[rX1,rY0],[rX1,rY1],[rX0,rY1]];
  for (let li=0; li<sides.length; li++){
    if (this._layerClipped(li)) continue;
    if (rX1 <= rX0 || rY1 <= rY0) break;       // section box empty → no planes
    const side = sides[li], col = SIDE_COLORS[side] || "#9aa3ad";
    const pts = corners.map(([x,y]) => this._project(x,y,li));
    // Sort the plane behind the FARTHEST point on itself (min depth), not its centre, so it
    // can never be painted over its own copper. Otherwise traces on the half of the board
    // tilted away from the camera have a smaller depth than the plane centre, sort in front
    // of the plane, and the dark substrate paints over them — "half the traces go black".
    const planeDepth = Math.min(...pts.map(p => p.depth)) - 0.01;
    prims.push({ depth: planeDepth, draw: () => {
      ctx.beginPath(); pts.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
      ctx.fillStyle = "rgba(20,26,34,0.45)"; ctx.fill();   // translucent substrate (x-ray stack)
      ctx.strokeStyle = col; ctx.globalAlpha = 0.95; ctx.lineWidth = 1.6; ctx.stroke(); ctx.globalAlpha = 1;
      const lp = this._project(rX0, rY0, li);
      ctx.fillStyle = col; ctx.font = "600 12px Segoe UI, sans-serif";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(SIDE_LABELS[side] || side, lp.x - 8, lp.y);
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }});
  }

  // --- traces ---
  for (const t of State.traces){
    if (t.points.length < 2) continue;
    const li = sides.indexOf(t.side); if (li < 0) continue;
    if (this._layerClipped(li)) continue;
    const col = t.netId ? netColor(t.netId) : (SIDE_COLORS[t.side] || "#9aa3ad");
    const lw  = Math.max(1.2, (t.width||3) * this.scale);
    for (const run of this._clipPolyline(t.points)){         // section box may split a trace into pieces
      if (run.length < 2) continue;
      const pts = run.map(p => this._project(p.x,p.y,li));
      prims.push({ depth: _avgDepth(pts), draw: () => {
        ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = 0.95;
        ctx.beginPath(); pts.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke(); ctx.globalAlpha = 1;
      }});
    }
  }

  // --- pads (real shape; THT pads appear on every layer) ---
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const tht = fpin.shape === "circle";
      const st = c.pins[pi] || {};
      const col = st.netId ? netColor(st.netId) : (tht ? "#b8a06a" : (c.side==="back" ? "#41599c" : "#9b8338"));
      const layers = tht ? sides.map((_,i)=>i) : [sides.indexOf(c.side)];
      const wPad  = this._clipPolygon(this._padWorldPolygon(c, fpin, 1));
      if (wPad.length < 3) continue;                          // pad fully outside the section box
      const wHole = tht ? this._clipPolygon(this._padWorldPolygon(c, fpin, 0.42)) : null;
      for (const li of layers){
        if (li < 0 || this._layerClipped(li)) continue;
        const poly = wPad.map(p => this._project(p.x,p.y,li));
        const hole = (wHole && wHole.length >= 3) ? wHole.map(p => this._project(p.x,p.y,li)) : null;
        prims.push({ depth: _avgDepth(poly) + 0.02, draw: () => {
          ctx.beginPath(); poly.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
          ctx.fillStyle = col; ctx.fill();
          if (hole){
            ctx.beginPath(); hole.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
            ctx.fillStyle = "#0d0f12"; ctx.fill();
          }
        }});
      }
    }
  }

  // --- via pillars (cylinders spanning the stack; orientation follows the rotation) ---
  for (const v of State.vias){
    const sp = viaSpanIdx(v);                               // blind/buried vias span only their layers
    let lo = sp.lo, hi = sp.hi;
    if (cl.on){
      if (v.x < cl.x0 || v.x > cl.x1 || v.y < cl.y0 || v.y > cl.y1) continue;  // outside the section box
      lo = Math.max(lo, cl.zLo); hi = Math.min(hi, cl.zHi);
      if (lo > hi) continue;                                // all of its layers are clipped away
    }
    const top = this._project(v.x, v.y, lo);              // topmost copper it reaches (after clip)
    const bot = this._project(v.x, v.y, hi);              // bottommost copper it reaches (after clip)
    const r = Math.max(2.5, (v.r||5) * this.scale);
    const col = v.netId ? netColor(v.netId) : "#b8a06a";
    prims.push({ depth: (top.depth + bot.depth)/2, draw: () => {
      // cylinder body as a thick round-capped segment between the two ends
      ctx.strokeStyle = _shadeHex(col, -0.15);
      ctx.lineWidth = 2*r; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
      // near (front) cap, lighter, with drill hole
      const near = top.depth >= bot.depth ? top : bot;
      ctx.fillStyle = _shadeHex(col, 0.2);
      ctx.beginPath(); ctx.arc(near.x, near.y, r, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = "#0d0f12";
      ctx.beginPath(); ctx.arc(near.x, near.y, r*0.42, 0, Math.PI*2); ctx.fill();
    }});
  }

  // --- paint far-to-near (painter's algorithm by true depth) ---
  prims.sort((a, bb) => a.depth - bb.depth);
  for (const p of prims) p.draw();
};
