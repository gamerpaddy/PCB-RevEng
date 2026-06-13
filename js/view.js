/* ===== view.js — canvas rendering, pan/zoom, coordinate transforms, hit testing ===== */
"use strict";

const View = {
  canvas: null, ctx: null,
  panX: 0, panY: 0, zoom: 1,
  flip: false,            // true = look at the board from the back (mirror X)
  mask: false,            // coverage mask overlay
  width: 0, height: 0,
  hoverNetId: null,       // net under cursor → highlighted
  blinkNet: null,         // net flashing after a net-list click
  blinkOn: false,
};

/* flash a net 3× in the view */
let _blinkTimer = null;
function blinkNet(netId){
  if (_blinkTimer){ clearInterval(_blinkTimer); }
  View.blinkNet = netId;
  let n = 0;
  View.blinkOn = true; requestRender();
  _blinkTimer = setInterval(() => {
    View.blinkOn = !View.blinkOn;
    n++;
    if (n >= 6){ clearInterval(_blinkTimer); _blinkTimer = null; View.blinkNet = null; View.blinkOn = false; }
    requestRender();
  }, 180);
}

function viewInit(canvas){
  View.canvas = canvas;
  View.ctx = canvas.getContext("2d");
  viewResize();
}

function viewResize(){
  const r = View.canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  View.canvas.width  = Math.max(1, Math.round(r.width  * dpr));
  View.canvas.height = Math.max(1, Math.round(r.height * dpr));
  View.width = r.width; View.height = r.height;
  View.dpr = dpr;
  requestRender();
}

/* world <-> screen (screen in CSS px) */
function worldToScreen(x, y){
  const fx = View.flip ? -1 : 1;
  return { x: x * View.zoom * fx + View.panX, y: y * View.zoom + View.panY };
}
function screenToWorld(x, y){
  const fx = View.flip ? -1 : 1;
  return { x: (x - View.panX) / (View.zoom * fx), y: (y - View.panY) / View.zoom };
}

function zoomAt(sx, sy, factor){
  const w = screenToWorld(sx, sy);
  View.zoom = Math.max(0.02, Math.min(80, View.zoom * factor));
  const s2 = worldToScreen(w.x, w.y);
  View.panX += sx - s2.x;
  View.panY += sy - s2.y;
  requestRender();
}

function zoomToFit(){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity, any=false;
  for (const l of State.layers){
    if (!l.img || !l.img.width) continue;
    const es = layerEffScale(l);
    const hw=l.img.width*es/2, hh=l.img.height*es/2;
    const r=Math.hypot(hw,hh);
    minX=Math.min(minX,l.tx-r); maxX=Math.max(maxX,l.tx+r);
    minY=Math.min(minY,l.ty-r); maxY=Math.max(maxY,l.ty+r);
    any=true;
  }
  for (const c of State.components){ minX=Math.min(minX,c.x-50);maxX=Math.max(maxX,c.x+50);minY=Math.min(minY,c.y-50);maxY=Math.max(maxY,c.y+50); any=true; }
  if (!any){ View.panX=View.width/2; View.panY=View.height/2; View.zoom=1; requestRender(); return; }
  const w=maxX-minX, h=maxY-minY;
  View.zoom = Math.min(View.width/(w||1), View.height/(h||1)) * 0.92;
  View.zoom = Math.max(0.02, Math.min(80, View.zoom));
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  const fx = View.flip ? -1 : 1;
  View.panX = View.width/2  - cx*View.zoom*fx;
  View.panY = View.height/2 - cy*View.zoom;
  requestRender();
}

/* effective uniform scale of a layer (sqrt|det| when warped) */
function layerEffScale(l){
  if (l.warp) return Math.sqrt(Math.abs(l.warp.a*l.warp.d - l.warp.b*l.warp.c)) || 1;
  return l.scale;
}

/* linear part (2×2) of a layer's transform, canvas convention {a,b,c,d} */
function layerLinear(l){
  if (l.warp) return { ...l.warp };
  const a = l.rot * Math.PI/180, ca = Math.cos(a), sa = Math.sin(a);
  const sx = l.scale * (l.mirror ? -1 : 1), sy = l.scale;
  return { a: ca*sx, b: sa*sx, c: -sa*sy, d: ca*sy };
}

/* ---------- component geometry ---------- */
/* pin position in world coords. Back-side components are mirrored in X (as seen from front). */
function pinWorldPos(comp, pin){
  const s = State.pxPerMm * (comp.scale || 1);
  let x = pin.xmm * s, y = pin.ymm * s;
  if (comp.side === "back") x = -x;
  const a = comp.rot * Math.PI / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return { x: comp.x + x*ca - y*sa, y: comp.y + x*sa + y*ca };
}

function compFootprint(comp){
  if (!comp._fp) comp._fp = generateFootprint(comp.fpId, comp.fpParams);
  return comp._fp;
}
function compRadius(comp){
  const fp = compFootprint(comp);
  const s = State.pxPerMm * (comp.scale || 1);
  let r = Math.hypot(fp.body.w, fp.body.h)/2 * s;
  for (const p of fp.pins) r = Math.max(r, (Math.hypot(p.xmm,p.ymm)+Math.max(p.w,p.h)) * s);
  return r;
}

/* point-in-component test using the actual outline (body shape + pads),
   not a bounding circle — so a wide connector is only clickable on its body. */
function pointInComp(comp, wx, wy){
  const fp = compFootprint(comp);
  const s = State.pxPerMm * (comp.scale || 1);
  // world → component-local mm
  let dx = wx - comp.x, dy = wy - comp.y;
  const a = -comp.rot * Math.PI/180, ca = Math.cos(a), sa = Math.sin(a);
  let lx = dx*ca - dy*sa, ly = dx*sa + dy*ca;
  if (comp.side === "back") lx = -lx;
  const mx = lx/s, my = ly/s;
  const tol = 5 / View.zoom / s; // a few screen px, expressed in mm
  if (fp.body.shape === "circle"){
    if (Math.hypot(mx,my) <= Math.max(fp.body.w,fp.body.h)/2 + tol) return true;
  } else if (Math.abs(mx) <= fp.body.w/2 + tol && Math.abs(my) <= fp.body.h/2 + tol){
    return true;
  }
  for (const p of fp.pins)
    if (Math.abs(mx-p.xmm) <= p.w/2 + tol && Math.abs(my-p.ymm) <= p.h/2 + tol) return true;
  return false;
}

/* ---------- hit testing (world coords) ---------- */
function hitTest(wx, wy){
  const tol = 6 / View.zoom;
  // vias first — they get priority over pads (vias often sit inside pads)
  for (let i=State.vias.length-1; i>=0; i--){
    const v = State.vias[i];
    if (Math.hypot(wx-v.x, wy-v.y) <= (v.r||5) + tol*0.5)
      return { type:"via", via:v };
  }
  // pins next
  for (let i=State.components.length-1; i>=0; i--){
    const c = State.components[i];
    const s = State.pxPerMm * (c.scale||1);
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const wp = pinWorldPos(c, fpin);
      const r = Math.max(fpin.w, fpin.h) * s / 2 + tol*0.6;
      if (Math.hypot(wx-wp.x, wy-wp.y) <= r)
        return { type:"pin", comp:c, pinIdx:pi };
    }
  }
  // trace segments
  for (let i=State.traces.length-1; i>=0; i--){
    const t = State.traces[i];
    if (!traceVisible(t)) continue;
    for (let k=0; k<t.points.length-1; k++){
      if (distToSeg(wx,wy,t.points[k],t.points[k+1]) <= (t.width||3)/2 + tol)
        return { type:"trace", trace:t };
    }
  }
  // component bodies (hidden-side bodies are not clickable, their pads above still are)
  for (let i=State.components.length-1; i>=0; i--){
    const c = State.components[i];
    if (!compBodyVisible(c)) continue;
    if (pointInComp(c, wx, wy))
      return { type:"comp", comp:c };
  }
  return null;
}

function distToSeg(px,py,a,b){
  const dx=b.x-a.x, dy=b.y-a.y;
  const len2 = dx*dx+dy*dy;
  let t = len2 ? ((px-a.x)*dx+(py-a.y)*dy)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px-(a.x+dx*t), py-(a.y+dy*t));
}

/* snap to nearest pin/via/trace within radius; returns {x,y,netId,attach} or null.
   traceSide: "front"/"back"/"inner1"/"inner2" limits trace snapping to that copper side,
   "any" snaps to traces on every side, omitted/null disables trace snapping. */
function snapToConductor(wx, wy, traceSide){
  const tol = 12 / View.zoom;
  let best = null, bestD = tol;
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const wp = pinWorldPos(c, fp.pins[pi]);
      const d = Math.hypot(wx-wp.x, wy-wp.y);
      if (d < bestD){ bestD=d; best={x:wp.x,y:wp.y,attach:{type:"pin",comp:c,pinIdx:pi},netId:c.pins[pi].netId}; }
    }
  }
  for (const v of State.vias){
    const d = Math.hypot(wx-v.x, wy-v.y);
    if (d < bestD){ bestD=d; best={x:v.x,y:v.y,attach:{type:"via",via:v},netId:v.netId}; }
  }
  if (traceSide){
    for (const t of State.traces){
      if (traceSide !== "any" && t.side !== traceSide) continue;
      for (let k=0; k<t.points.length-1; k++){
        const pr = projectOnSeg(wx, wy, t.points[k], t.points[k+1]);
        if (pr.d < bestD){
          bestD = pr.d;
          best = { x:pr.x, y:pr.y, attach:{type:"trace", trace:t}, netId:t.netId };
        }
      }
    }
  }
  return best;
}

function projectOnSeg(px, py, a, b){
  const dx=b.x-a.x, dy=b.y-a.y;
  const len2 = dx*dx+dy*dy;
  let t = len2 ? ((px-a.x)*dx+(py-a.y)*dy)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x+dx*t, y = a.y+dy*t;
  return { x, y, d: Math.hypot(px-x, py-y) };
}

function segsIntersect(a,b,c,d){
  const o = (p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
  const o1=o(a,b,c), o2=o(a,b,d), o3=o(c,d,a), o4=o(c,d,b);
  return ((o1>0)!==(o2>0)) && ((o3>0)!==(o4>0));
}

function minSegDist(a,b,c,d){
  if (segsIntersect(a,b,c,d)) return 0;
  return Math.min(
    distToSeg(c.x,c.y,a,b), distToSeg(d.x,d.y,a,b),
    distToSeg(a.x,a.y,c,d), distToSeg(b.x,b.y,c,d));
}

/* true when two traces genuinely connect (same-side check is the caller's job):
   a real geometric crossing, coincident endpoints (a shared junction), or one
   trace's endpoint landing on the INTERIOR of the other (a T-junction).
   Deliberately NOT a side-by-side distance test, so parallel traces running
   close together — even with aligned endpoints — are never merged. */
function tracesTouch(t1, t2){
  const tol = Math.max(2, Math.min((t1.width||3), (t2.width||3)) * 0.6);
  // actual crossings
  for (let i=0; i<t1.points.length-1; i++)
    for (let k=0; k<t2.points.length-1; k++)
      if (segsIntersect(t1.points[i], t1.points[i+1], t2.points[k], t2.points[k+1]))
        return true;
  const ends1 = [t1.points[0], t1.points[t1.points.length-1]];
  const ends2 = [t2.points[0], t2.points[t2.points.length-1]];
  // coincident endpoints
  for (const a of ends1) for (const b of ends2)
    if (Math.hypot(a.x-b.x, a.y-b.y) <= tol) return true;
  // endpoint on the other's interior (exclude the other's endpoints)
  const onInterior = (e, t) => {
    for (let k=0; k<t.points.length-1; k++){
      const pr = projectOnSeg(e.x, e.y, t.points[k], t.points[k+1]);
      if (pr.d > tol) continue;
      const segLen = Math.hypot(t.points[k+1].x-t.points[k].x, t.points[k+1].y-t.points[k].y) || 1;
      const dStart = Math.hypot(pr.x-t.points[k].x, pr.y-t.points[k].y);
      const dEnd   = segLen - dStart;
      if (dStart > tol && dEnd > tol) return true; // genuinely mid-segment
    }
    return false;
  };
  for (const e of ends1) if (onInterior(e, t2)) return true;
  for (const e of ends2) if (onInterior(e, t1)) return true;
  return false;
}

/* ---------- rendering ---------- */
let _renderQueued = false;
function requestRender(){
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; render(); });
}

/* the side you are currently working on: driven by the active draw side
   (front/back); when an inner layer is active, fall back to the flip orientation. */
function activeSide(){
  const ds = UI.drawSide();
  if (ds === "front" || ds === "back") return ds;
  return View.flip ? "back" : "front";
}

/* full component (body + SMD pads + label) shown only when it's on the active
   side; on the other side only its through-hole pads remain (drawn elsewhere). */
function compBodyVisible(c){
  return State.compView !== "side" || c.side === activeSide();
}

/* traces shown only for the active draw side (vias & pads always shown) */
function traceVisible(t){
  return State.traceView !== "active" || t.side === UI.drawSide();
}

function render(){
  const ctx = View.ctx;
  const dpr = View.dpr || 1;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,View.width,View.height);

  const fx = View.flip ? -1 : 1;
  ctx.save();
  ctx.translate(View.panX, View.panY);
  ctx.scale(View.zoom * fx, View.zoom);

  // --- image layers ---
  for (const l of State.layers){
    if (!l.visible || !l.img || !l.img.width) continue;
    ctx.save();
    ctx.globalAlpha = l.opacity;
    ctx.translate(l.tx, l.ty);
    if (l.warp){
      // full affine (set by 4-point alignment — includes skew)
      ctx.transform(l.warp.a, l.warp.b, l.warp.c, l.warp.d, 0, 0);
    } else {
      ctx.rotate(l.rot * Math.PI/180);
      ctx.scale(l.scale * (l.mirror ? -1 : 1), l.scale);
    }
    ctx.drawImage(l.img, -l.img.width/2, -l.img.height/2);
    ctx.restore();
  }

  // coverage mask (red tint = no component placed there yet)
  if (View.mask) renderMask(ctx);

  const selNet = currentHighlightNet();

  // --- traces ---
  for (const t of State.traces){
    if (!traceVisible(t)) continue;
    drawTrace(ctx, t, selNet);
  }
  // --- in-progress trace preview ---
  if (Tools.tracePts && Tools.tracePts.length){
    ctx.save();
    ctx.strokeStyle = SIDE_COLORS[Tools.traceSide] || "#fff";
    ctx.lineWidth = 3/View.zoom;
    ctx.setLineDash([6/View.zoom, 4/View.zoom]);
    ctx.beginPath();
    ctx.moveTo(Tools.tracePts[0].x, Tools.tracePts[0].y);
    for (let i=1;i<Tools.tracePts.length;i++) ctx.lineTo(Tools.tracePts[i].x, Tools.tracePts[i].y);
    if (Tools.cursor) ctx.lineTo(Tools.cursor.x, Tools.cursor.y);
    ctx.stroke();
    ctx.restore();
  }

  // --- vias ---
  for (const v of State.vias) drawVia(ctx, v, selNet);

  // --- components (other-side parts: pads only, dimmed) ---
  for (const c of State.components) drawComponent(ctx, c, selNet, !compBodyVisible(c));

  // --- trace vertex handles (selected trace, select tool) ---
  if (Tools.name === "select" && UI.sel && UI.sel.type === "trace" && traceVisible(UI.sel.trace)){
    const t = UI.sel.trace;
    const hr = 5/View.zoom;
    for (let i=0;i<t.points.length;i++){
      const p = t.points[i];
      ctx.beginPath(); ctx.arc(p.x, p.y, hr, 0, Math.PI*2);
      ctx.fillStyle = (Tools.dragVert && Tools.dragVert.trace===t && Tools.dragVert.i===i) ? "#ffffff" : "#ffd24d";
      ctx.fill();
      ctx.lineWidth = 1.5/View.zoom; ctx.strokeStyle = "#222"; ctx.stroke();
    }
  }

  // --- checker markers (pads with no net) ---
  if (View.checkMarks && View.checkMarks.length){
    ctx.save();
    ctx.strokeStyle = "#ff4dff"; ctx.lineWidth = 2.5/View.zoom;
    const r = 12/View.zoom;
    for (const m of View.checkMarks){
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI*2); ctx.stroke();
    }
    ctx.restore();
  }

  // --- snap indicator ---
  if (Tools.snap){
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5/View.zoom;
    ctx.beginPath();
    ctx.arc(Tools.snap.x, Tools.snap.y, 8/View.zoom, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }

  // --- ghost component while placing ---
  if (Tools.name === "component" && Tools.ghostFp && Tools.cursor){
    ctx.save();
    ctx.translate(Tools.cursor.x, Tools.cursor.y);
    ctx.rotate(Tools.ghostRot * Math.PI/180);
    if (Tools.ghostSide === "back") ctx.scale(-1,1);
    drawFootprintShape(ctx, Tools.ghostFp, State.pxPerMm, {alpha:0.55, zoom:View.zoom});
    ctx.restore();
  }

  // --- measure overlay ---
  if (Tools.measureA && Tools.cursor){
    const a = Tools.measureA, b = Tools.measureB || Tools.cursor;
    ctx.save();
    ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 1.5/View.zoom;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    ctx.restore();
  }

  // --- alignment reference points ---
  if (Tools.alignPts){
    ctx.save();
    Tools.alignPts.forEach((p,i)=>{
      ctx.strokeStyle = i<4 ? "#ffb648" : "#4fd07f"; // orange = points on the moving layer, green = destination
      ctx.lineWidth = 2/View.zoom;
      const r = 10/View.zoom;
      ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x-r,p.y); ctx.lineTo(p.x+r,p.y); ctx.moveTo(p.x,p.y-r); ctx.lineTo(p.x,p.y+r); ctx.stroke();
    });
    ctx.restore();
  }

  ctx.restore();
}

function currentHighlightNet(){
  if (View.blinkNet && View.blinkOn) return View.blinkNet;
  if (View.blinkNet && !View.blinkOn) return -1; // suppress other highlights mid-blink-off
  if (View.hoverNetId) return View.hoverNetId;
  if (UI.activeNetId) return UI.activeNetId;
  const sel = UI.sel;
  if (!sel) return null;
  if (sel.type==="pin")  return sel.comp.pins[sel.pinIdx].netId;
  if (sel.type==="via")  return sel.via.netId;
  if (sel.type==="trace")return sel.trace.netId;
  return null;
}

function netColor(netId){
  const n = getNet(netId);
  return n ? n.color : "#999";
}

function drawTrace(ctx, t, selNet){
  const hl = selNet && t.netId === selNet;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (hl){
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = (t.width||3) + 6/View.zoom;
    ctx.globalAlpha = 0.35;
    pathTrace(ctx, t); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  const sel = (UI.sel && UI.sel.type==="trace" && UI.sel.trace===t) || UI.isTraceSelected(t);
  ctx.strokeStyle = sel ? "#ffffff" : (t.netId ? netColor(t.netId) : SIDE_COLORS[t.side]);
  ctx.lineWidth = t.width || 3;
  ctx.globalAlpha = 0.85;
  pathTrace(ctx, t); ctx.stroke();
  // thin side-colored core so layer is identifiable
  ctx.strokeStyle = SIDE_COLORS[t.side] || "#fff";
  ctx.lineWidth = Math.max((t.width||3)*0.3, 1/View.zoom);
  pathTrace(ctx, t); ctx.stroke();
  ctx.restore();
}
function pathTrace(ctx, t){
  ctx.beginPath();
  ctx.moveTo(t.points[0].x, t.points[0].y);
  for (let i=1;i<t.points.length;i++) ctx.lineTo(t.points[i].x, t.points[i].y);
}

function drawVia(ctx, v, selNet){
  const pth = v.kind === "pth";
  const r = v.r || 5;
  const hl = selNet && v.netId === selNet;
  const sel = UI.sel && UI.sel.type==="via" && UI.sel.via===v;
  ctx.save();
  if (hl){
    ctx.fillStyle="#fff"; ctx.globalAlpha=0.35;
    ctx.beginPath(); ctx.arc(v.x,v.y,r+5/View.zoom,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;
  }
  ctx.fillStyle = v.netId ? netColor(v.netId) : (pth ? "#b8a06a" : "#cccccc");
  ctx.strokeStyle = sel ? "#fff" : (pth ? "#5a4a20" : "#222");
  // PTH = thicker annular ring (plated through hole / mounting pad), via = thin ring
  ctx.lineWidth = (pth ? 2.5 : 1.5)/View.zoom;
  ctx.beginPath(); ctx.arc(v.x,v.y,r,0,Math.PI*2); ctx.fill(); ctx.stroke();
  // drilled hole — larger relative bore for PTH
  ctx.fillStyle = "#0d0f12";
  ctx.beginPath(); ctx.arc(v.x,v.y,r*(pth?0.55:0.45),0,Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawComponent(ctx, c, selNet, padsOnly){
  const fp = compFootprint(c);
  const s = State.pxPerMm * (c.scale||1);
  const isSel = UI.sel && (UI.sel.comp === c);
  ctx.save();
  ctx.translate(c.x, c.y);
  ctx.rotate(c.rot * Math.PI/180);
  if (c.side === "back") ctx.scale(-1,1);

  const sideCol = c.side === "back" ? "#7da0ff" : "#ffd24d";
  const padDim = padsOnly ? 0.45 : 1;
  if (!padsOnly){
    // body (dashed outline = locked)
    ctx.strokeStyle = isSel ? "#ffffff" : (c.side==="back" ? "#5a78c8" : "#b9c2cf");
    ctx.lineWidth = (isSel?2.2:1.4)/View.zoom;
    ctx.globalAlpha = 0.95;
    if (compMoveLocked(c)) ctx.setLineDash([5/View.zoom, 4/View.zoom]);
    ctx.fillStyle = c.side==="back" ? "rgba(77,125,255,.10)" : "rgba(255,210,77,.08)";
    if (fp.body.shape === "circle"){
      const br = Math.max(fp.body.w, fp.body.h)*s/2;
      ctx.beginPath(); ctx.arc(0,0,br,0,Math.PI*2);
      ctx.fill(); ctx.stroke();
    } else {
      ctx.strokeRect(-fp.body.w*s/2, -fp.body.h*s/2, fp.body.w*s, fp.body.h*s);
      ctx.fillRect(-fp.body.w*s/2, -fp.body.h*s/2, fp.body.w*s, fp.body.h*s);
    }
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = padDim;

  // pads
  for (let pi=0; pi<fp.pins.length; pi++){
    const fpin = fp.pins[pi];
    // on the far side only through-hole pads (circles) remain visible
    if (padsOnly && fpin.shape !== "circle") continue;
    const st = c.pins[pi] || {};
    const hasNet = !!st.netId;
    const hl = selNet && st.netId === selNet;
    const x=fpin.xmm*s, y=fpin.ymm*s, w=fpin.w*s, h=fpin.h*s;
    const selPin = (UI.sel && UI.sel.type==="pin" && UI.sel.comp===c && UI.sel.pinIdx===pi) ||
                   UI.isPinSelected(c, pi);
    if (hl){
      ctx.fillStyle="#fff"; ctx.globalAlpha=.4;
      ctx.beginPath(); ctx.arc(x,y,Math.max(w,h)/2+4/View.zoom,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha=padDim;
    }
    ctx.fillStyle = hasNet ? netColor(st.netId) : (c.side==="back" ? "#41599c" : "#9b8338");
    if (fpin.shape==="circle"){
      ctx.beginPath(); ctx.arc(x,y,w/2,0,Math.PI*2); ctx.fill();
      ctx.fillStyle="#0d0f12";
      ctx.beginPath(); ctx.arc(x,y,w/5,0,Math.PI*2); ctx.fill();
    } else {
      ctx.fillRect(x-w/2,y-h/2,w,h);
    }
    if (selPin){
      ctx.strokeStyle="#fff"; ctx.lineWidth=2/View.zoom;
      ctx.beginPath(); ctx.arc(x,y,Math.max(w,h)/2+3/View.zoom,0,Math.PI*2); ctx.stroke();
    }
  }
  // pin1 marker (skip on far-side pad-only render)
  const p1 = fp.pins[0];
  if (p1 && !(padsOnly && p1.shape !== "circle")){
    ctx.fillStyle = "#ff5d5d";
    ctx.beginPath(); ctx.arc(p1.xmm*s, p1.ymm*s, Math.max(2.2/View.zoom, Math.max(p1.w,0.4)*s*0.18), 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();

  // reference text (always upright, readable, never mirrored) — hugs the body's top edge
  if (!padsOnly && View.zoom * s > 1.0){
    const sc = worldToScreen(c.x, c.y);
    const ar = c.rot * Math.PI/180;
    const vert = (Math.abs(Math.sin(ar))*fp.body.w + Math.abs(Math.cos(ar))*fp.body.h)/2 * s;
    const top = sc.y - vert*View.zoom - 4;
    ctx.save();
    ctx.setTransform(View.dpr,0,0,View.dpr,0,0);
    ctx.textAlign="center";
    ctx.shadowColor="rgba(0,0,0,.9)"; ctx.shadowBlur=3;
    const lockIcon = (c.lockMove || c.lockEdit || c.locked) ? "🔒" : "";
    const rsz = State.refTextSize || 13;
    ctx.font = "600 " + rsz + "px Segoe UI, sans-serif";
    ctx.fillStyle = isSel ? "#ffffff" : sideCol;
    ctx.fillText(lockIcon + c.ref, sc.x, c.value ? top - rsz*0.85 : top);
    if (c.value){
      ctx.font = Math.max(9, rsz*0.82) + "px Segoe UI, sans-serif";
      ctx.fillStyle = "#aab4c2";
      ctx.fillText(c.value, sc.x, top);
    }
    ctx.restore();
  }
}

/* ---------- coverage mask: tint board areas not yet covered by components ---------- */
let _maskCv = null;
function renderMask(ctx){
  if (!_maskCv) _maskCv = document.createElement("canvas");
  const mc = _maskCv;
  mc.width = View.canvas.width; mc.height = View.canvas.height;
  const m = mc.getContext("2d");
  m.setTransform(View.dpr,0,0,View.dpr,0,0);
  const fx = View.flip ? -1 : 1;
  m.translate(View.panX, View.panY);
  m.scale(View.zoom * fx, View.zoom);
  // tint every visible photo area
  m.fillStyle = "rgba(255,70,70,0.27)";
  for (const l of State.layers){
    if (!l.visible || !l.img || !l.img.width) continue;
    m.save();
    m.translate(l.tx, l.ty);
    if (l.warp) m.transform(l.warp.a, l.warp.b, l.warp.c, l.warp.d, 0, 0);
    else { m.rotate(l.rot*Math.PI/180); m.scale(l.scale*(l.mirror?-1:1), l.scale); }
    m.fillRect(-l.img.width/2, -l.img.height/2, l.img.width, l.img.height);
    m.restore();
  }
  // punch holes that follow each component's actual footprint shape (+ margin),
  // so a wide connector only clears its own outline, not a huge circle
  m.globalCompositeOperation = "destination-out";
  m.fillStyle = "#000";
  const margin = 1.5 * State.pxPerMm; // 1.5 mm halo around the part
  for (const c of State.components){
    const fp = compFootprint(c);
    const s = State.pxPerMm * (c.scale||1);
    m.save();
    m.translate(c.x, c.y);
    m.rotate(c.rot * Math.PI/180);
    if (c.side === "back") m.scale(-1,1);
    if (fp.body.shape === "circle"){
      const br = Math.max(fp.body.w, fp.body.h)*s/2 + margin;
      m.beginPath(); m.arc(0,0,br,0,Math.PI*2); m.fill();
    } else {
      const bw = fp.body.w*s + margin*2, bh = fp.body.h*s + margin*2;
      m.fillRect(-bw/2, -bh/2, bw, bh);
    }
    // also clear around each pad (covers pads that stick out past the body)
    for (const pin of fp.pins){
      const pr = Math.max(pin.w, pin.h)*s/2 + margin*0.6;
      m.beginPath(); m.arc(pin.xmm*s, pin.ymm*s, pr, 0, Math.PI*2); m.fill();
    }
    m.restore();
  }
  for (const v of State.vias){
    m.beginPath(); m.arc(v.x, v.y, (v.r||5) + margin*0.6, 0, Math.PI*2); m.fill();
  }
  // composite onto the main canvas in device space
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);
  ctx.drawImage(mc, 0, 0);
  ctx.restore();
}
