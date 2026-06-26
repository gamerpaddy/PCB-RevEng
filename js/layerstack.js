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
  gap: 70,            // world-px height between stacked planes
  scale: 1,           // world→screen content scale
  panX: 0, panY: 0,   // view pan (middle-drag)
  bounds: null,
  nSides: 2,
  drag: null,
  _wired: false,
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
    this._fit(); this.render();
  });
  window.addEventListener("resize", () => {
    if (this.dlg && this.dlg.open){ this._resize(); this.render(); }
  });
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
  const stackH = (this.nSides - 1) * this.gap;
  const ext = Math.max(this.bounds.w, this.bounds.h) || 1; // rotation may orient either way
  this.scale = Math.min(cw * 0.6 / ext, (ch * 0.6 - stackH) / ext);
  this.scale = Math.max(0.01, Math.min(120, this.scale));
};

/* project a world point on copper side `li` (0 = front) into the rotated 3D scene.
   Turntable: yaw about the stack axis, then pitch about the screen-horizontal axis.
   Returns canvas {x,y} plus a true camera `depth` (larger = nearer the viewer). */
Stack3D._project = function(wx, wy, li){
  const b = this.bounds, s = this.scale;
  const X = (wx - b.cx) * s;
  const Y = (wy - b.cy) * s;
  const Z = ((this.nSides - 1)/2 - li) * this.gap; // front (li 0) highest in the stack
  const cyaw = Math.cos(this.yaw), syaw = Math.sin(this.yaw);
  const X1 = X*cyaw - Y*syaw;
  const Y1 = X*syaw + Y*cyaw;
  const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
  const Y2    = Y1*cp + Z*sp;     // screen vertical (up positive) — front ends up on top
  const depth = Z*cp - Y1*sp;     // toward the camera
  return { x: this.cssW/2 + X1 + this.panX, y: this.cssH/2 - Y2 + this.panY, depth };
};

/* world-space polygon for a pad's real outline on side `li` (rect → 4 corners,
   round → sampled circle), respecting component rotation / scale / back-mirror. */
Stack3D._padPolygon = function(comp, fpin, li, shrink){
  shrink = shrink || 1;
  const s = State.pxPerMm * (comp.scale || 1);
  const cxL = fpin.xmm * s, cyL = fpin.ymm * s;
  const a = comp.rot * Math.PI/180, ca = Math.cos(a), sa = Math.sin(a);
  const toScreen = (lx, ly) => {
    if (comp.side === "back") lx = -lx;
    return this._project(comp.x + lx*ca - ly*sa, comp.y + lx*sa + ly*ca, li);
  };
  const out = [];
  if (fpin.shape === "circle"){
    const r = fpin.w * s / 2 * shrink;
    for (let k=0; k<20; k++){ const ang = k/20*Math.PI*2; out.push(toScreen(cxL + r*Math.cos(ang), cyL + r*Math.sin(ang))); }
  } else {
    const hw = fpin.w*s/2*shrink, hh = fpin.h*s/2*shrink;
    [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].forEach(([ox,oy]) => out.push(toScreen(cxL+ox, cyL+oy)));
  }
  return out;
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
  const corners = [[b.minX,b.minY],[b.maxX,b.minY],[b.maxX,b.maxY],[b.minX,b.maxY]];
  for (let li=0; li<sides.length; li++){
    const side = sides[li], col = SIDE_COLORS[side] || "#9aa3ad";
    const pts = corners.map(([x,y]) => this._project(x,y,li));
    prims.push({ depth: _avgDepth(pts) - 0.01, draw: () => {
      ctx.beginPath(); pts.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
      ctx.fillStyle = "rgba(20,26,34,0.82)"; ctx.fill();   // solid-looking substrate
      ctx.strokeStyle = col; ctx.globalAlpha = 0.95; ctx.lineWidth = 1.6; ctx.stroke(); ctx.globalAlpha = 1;
      const lp = this._project(b.minX, b.minY, li);
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
    const pts = t.points.map(p => this._project(p.x,p.y,li));
    const col = t.netId ? netColor(t.netId) : (SIDE_COLORS[t.side] || "#9aa3ad");
    const lw  = Math.max(1.2, (t.width||3) * this.scale);
    prims.push({ depth: _avgDepth(pts), draw: () => {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.globalAlpha = 0.95;
      ctx.beginPath(); pts.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke(); ctx.globalAlpha = 1;
    }});
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
      for (const li of layers){
        if (li < 0) continue;
        const poly = this._padPolygon(c, fpin, li);
        prims.push({ depth: _avgDepth(poly) + 0.02, draw: () => {
          ctx.beginPath(); poly.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
          ctx.fillStyle = col; ctx.fill();
          if (tht){
            const hole = this._padPolygon(c, fpin, li, 0.42);
            ctx.beginPath(); hole.forEach((p,i)=> i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.closePath();
            ctx.fillStyle = "#0d0f12"; ctx.fill();
          }
        }});
      }
    }
  }

  // --- via pillars (cylinders spanning the stack; orientation follows the rotation) ---
  for (const v of State.vias){
    const top = this._project(v.x, v.y, 0);                 // front end
    const bot = this._project(v.x, v.y, sides.length - 1);  // back end
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
