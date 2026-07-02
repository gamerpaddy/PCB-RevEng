/* ===== view.js — canvas rendering, pan/zoom, coordinate transforms, hit testing ===== */
"use strict";

const View = {
  canvas: null, ctx: null,
  panX: 0, panY: 0, zoom: 1,
  flip: false,            // true = look at the board from the back (mirror X)
  mask: false,            // coverage mask overlay
  width: 0, height: 0,
  hoverNetId: null,       // net under cursor → highlighted
  hoverNote: null,        // sticky note under cursor → show its text
  blinkNet: null,         // net flashing after a net-list click
  blinkOn: false,
  ratsnest: false,        // draw straight "airwire" connections between same-net pads/vias
  xrayAuto: false,        // true when X-ray was auto-enabled by viewing the X-ray layer (so leaving it turns X-ray back off)
  split: false,           // synced split view — left & right panes share one camera
  paneLayer: { left:null, right:null }, // image-layer id shown in each split pane
  paneSide: { left:"front", right:"back" }, // copper side whose traces/vias/parts show in each pane
  cursorPane: null,       // which split pane the pointer is over ("left"/"right"/null)
  _paneDX: 0,             // horizontal screen offset of the pane currently being drawn / hit-tested
  _paneSide: null,        // copper side that pane represents; null = use the draw-side selector
  _paneLayerId: null,     // image layer drawn in the pane currently being rendered
  _paneXray: null,        // per-pane X-ray state (a pane showing the X-ray layer is X-ray); null = use View.xray
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

/* world <-> screen (screen in CSS px). View._paneDX shifts the mapping into the
   pane currently being drawn / hit-tested (0 in normal single-view mode). */
function worldToScreen(x, y){
  const fx = View.flip ? -1 : 1;
  return { x: x * View.zoom * fx + View.panX + View._paneDX, y: y * View.zoom + View.panY };
}
function screenToWorld(x, y){
  const fx = View.flip ? -1 : 1;
  return { x: (x - View.panX - View._paneDX) / (View.zoom * fx), y: (y - View.panY) / View.zoom };
}

/* the effective copper side for visibility filtering: the pane's side while a split
   pane is being drawn / interacted with, otherwise the draw-side selector */
function effDrawSide(){
  return (View._paneSide) ? View._paneSide : UI.drawSide();
}

/* copper side a split pane's traces/vias/components follow. Independent of the image
   layer shown (so you can e.g. view the front photo but the back copper), but picking
   a layer sets it to that layer's side by default. */
function paneSideOf(which){
  const s = View.paneSide[which];
  if (s) return s;
  return which === "left" ? "front" : "back";
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

/* distance in world pixels from a world point to a pad's ACTUAL edge (0 when the
   point is inside the pad). Rectangular SMD pads use their real rectangle,
   respecting component rotation, scale and back-side mirror, instead of a round
   max(w,h)/2 hitbox. This stops long rectangular pads from behaving like big
   circles that grab traces they do not really touch. */
function pinEdgeDist(comp, fpin, wx, wy){
  const s = State.pxPerMm * (comp.scale || 1);
  let dx = wx - comp.x, dy = wy - comp.y;
  const a = -comp.rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  let lx = dx*ca - dy*sa, ly = dx*sa + dy*ca;   // undo component rotation
  if (comp.side === "back") lx = -lx;            // undo back-side mirror
  const px = lx - fpin.xmm*s, py = ly - fpin.ymm*s; // offset from pad centre, world px
  if (fpin.shape === "circle") return Math.max(0, Math.hypot(px, py) - fpin.w*s/2);
  const ex = Math.max(Math.abs(px) - fpin.w*s/2, 0);
  const ey = Math.max(Math.abs(py) - fpin.h*s/2, 0);
  return Math.hypot(ex, ey);
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
    if (!viaVisible(v)) continue;   // a buried via you can't see here can't be grabbed here
    if (Math.hypot(wx-v.x, wy-v.y) <= (v.r||5) + tol*0.5)
      return { type:"via", via:v };
  }
  // pins next — only pads that are actually drawn on the current layer are grabbable:
  // a THT (round) pad reaches every copper side, an SMD (rect) pad only shows on its
  // own side (unless its body is visible here — X-ray / "both" / same side)
  for (let i=State.components.length-1; i>=0; i--){
    const c = State.components[i];
    if (Math.hypot(wx-c.x, wy-c.y) > compRadius(c) + tol) continue; // skip far parts entirely
    const s = State.pxPerMm * (c.scale||1);
    const fp = compFootprint(c);
    const smdShown = compBodyVisible(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      if (fpin.shape !== "circle" && !smdShown) continue;   // SMD pad not on this layer
      if (pinEdgeDist(c, fpin, wx, wy) <= tol*0.9)
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
  // sticky notes — small markers, tested before big component bodies so they can be
  // grabbed, but after pads/vias/traces so they never obstruct real copper
  const noteR = 11 / View.zoom;
  for (let i=State.notes.length-1; i>=0; i--){
    const n = State.notes[i];
    if (Math.hypot(wx-n.x, wy-n.y) <= noteR)
      return { type:"note", note:n };
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
   traceSide: copper side being drawn ("front"/"back"/"inner1"…). Pads only snap if
   they're reachable from that side — through-hole pads (circles) reach every layer,
   SMD pads only their own side. "any" (via tool) snaps to everything;
   omitted/null disables trace snapping. */
function snapToConductor(wx, wy, traceSide, tightTrace, traceWidth, exclude){
  const tol = 8 / View.zoom;         // vias
  const traceTol = 42 / View.zoom;   // generous reach for dragging an anchor onto a trace
  // when a trace width is supplied (drawing / moving an anchor) pads only snap when the
  // cursor is right at the pad CENTRE — no edge grabbing. The reach scales with the pad's
  // own size, clamped to 0.5×…2× the trace width, so tiny pads snap tight while big pads
  // (where the centre is far from where you click) still grab from up to 2× the width.
  const padCenter = !!traceWidth;
  let best = null, bestD = Infinity;
  const filterPads = traceSide && traceSide !== "any";
  // widest distance a pad can still snap from, so a component whose bounding circle is
  // farther than that from the cursor can be skipped without touching its pads
  const padReach = padCenter ? Math.max(tol, (traceWidth || 0) * 2) : tol;
  for (const c of State.components){
    if (Math.hypot(wx - c.x, wy - c.y) > compRadius(c) + padReach) continue; // quick reject
    const fp = compFootprint(c);
    const s = State.pxPerMm * (c.scale || 1);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi];
      if (!fpin) continue;   // comp.pins can outnumber fp.pins (freestyle / regen) — guard
      // skip pads not reachable from this copper side (SMD pad on a different side)
      if (filterPads && fpin.shape !== "circle" && c.side !== traceSide) continue;
      let wp = null, d, ptol;
      if (padCenter){
        wp = pinWorldPos(c, fpin); d = Math.hypot(wx-wp.x, wy-wp.y);     // to pad centre
        const padR = Math.min(fpin.w, fpin.h) * s / 2;                   // pad's narrow half-extent
        ptol = Math.max(traceWidth * 0.5, Math.min(padR, traceWidth * 2));
      } else { d = pinEdgeDist(c, fpin, wx, wy); ptol = tol; }            // to pad edge (via tool)
      if (d <= ptol && d < bestD){ if (!wp) wp = pinWorldPos(c, fpin); bestD=d; best={x:wp.x,y:wp.y,attach:{type:"pin",comp:c,pinIdx:pi},netId:c.pins[pi].netId}; }
    }
  }
  for (const v of State.vias){
    if (filterPads && !viaOnSide(v, traceSide)) continue;  // blind via doesn't reach this copper side
    const d = Math.hypot(wx-v.x, wy-v.y);
    if (d <= tol && d < bestD){ bestD=d; best={x:v.x,y:v.y,attach:{type:"via",via:v},netId:v.netId}; }
  }
  if (traceSide){
    // when drawing (tightTrace) only snap within the nearby trace's own width, so a far
    // trace doesn't grab the cursor; dragging an anchor keeps the generous reach. A
    // pad/via still wins only when it is actually closer than the chosen trace.
    let tBest = null, tBestD = Infinity;
    for (const t of State.traces){
      if (exclude && (exclude === t || (exclude.has && exclude.has(t)))) continue;
      if (traceSide !== "any" && t.side !== traceSide) continue;
      const ttol = tightTrace ? ((t.width||3)/2 + 2/View.zoom) : traceTol;
      for (let k=0; k<t.points.length-1; k++){
        const pr = projectOnSeg(wx, wy, t.points[k], t.points[k+1]);
        if (pr.d <= ttol && pr.d < tBestD){
          tBestD = pr.d;
          tBest = { x:pr.x, y:pr.y, attach:{type:"trace", trace:t, seg:k}, netId:t.netId };
        }
      }
    }
    if (tBest && (!best || tBestD < bestD)) best = tBest;
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

/* true when the COPPER of two traces genuinely overlaps — a physical short test used by
   the design checker. Fires on a real crossing, or when a vertex/endpoint of one trace
   sits on the other's copper (within its half width). This catches an anchor dropped on
   another trace's centre-line, a T-junction at an interior vertex, and one trace lying
   over another, WITHOUT flagging parallel traces that merely run edge-to-edge (their
   centre-lines stay farther apart than a half width). */
function tracesOverlap(a, b){
  // a real geometric crossing
  for (let i=0; i<a.points.length-1; i++)
    for (let k=0; k<b.points.length-1; k++)
      if (segsIntersect(a.points[i], a.points[i+1], b.points[k], b.points[k+1])) return true;
  // a vertex of one trace lying on the other's copper (centre-line within its half width)
  const onCopper = (pts, other, halfW) => {
    for (const p of pts)
      for (let k=0; k<other.points.length-1; k++)
        if (distToSeg(p.x, p.y, other.points[k], other.points[k+1]) <= halfW) return true;
    return false;
  };
  return onCopper(a.points, b, (b.width||3)/2) || onCopper(b.points, a, (a.width||3)/2);
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
  if (effXray()) return "xray";              // X-ray overlay shows both sides
  const ds = effDrawSide();
  if (ds === "front" || ds === "back") return ds;
  return View.flip ? "back" : "front";
}

/* whether X-ray is active for the current context: per-pane in split view (a pane
   showing the X-ray image layer is X-ray by itself), otherwise the global toggle */
function effXray(){
  return (View._paneXray != null) ? View._paneXray : View.xray;
}

/* full component (body + SMD pads + label) shown only when it's on the CURRENT draw
   side (inner layers included — an SMD part on front is not "active" on Inner 1);
   X-ray view shows everything; on any other side only its through-hole pads remain */
function compBodyVisible(c){
  return State.compView !== "side" || effXray() || c.side === effDrawSide();
}

/* traces shown only for the active draw side (X-ray shows all; vias & pads always shown) */
function traceVisible(t){
  return State.traceView !== "active" || effXray() || t.side === effDrawSide();
}

/* a through via shows on every layer; a blind/buried via only shows on the copper
   sides it actually reaches — same idea as compBodyVisible, so it disappears on
   layers it isn't on (X-ray shows all) */
function viaVisible(v){
  return effXray() || viaOnSide(v, effDrawSide());
}

/* in X-ray mode, fade objects that aren't on the side currently being drawn on
   (so the active side stands out over the see-through other side) */
function xrayDim(side){
  return (effXray() && side !== effDrawSide()) ? 0.4 : 1;
}

function render(){
  const ctx = View.ctx;
  const dpr = View.dpr || 1;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,View.width,View.height);

  if (View.split){
    const halfW = View.width / 2;
    renderPane(ctx, 0,     halfW, 0,     "left");
    renderPane(ctx, halfW, halfW, halfW, "right");
    drawSplitChrome(ctx, halfW);
    drawSecondCursor(ctx, halfW);
  } else {
    View._paneDX = 0; View._paneSide = null; View._paneLayerId = null; View._paneXray = null;
    // no image layer visible → solid black backdrop so traces read on black
    if (!State.layers.some(l => l.visible && l.img && l.img.width)) fillBlack(ctx, 0, View.width);
    drawWorld(ctx);
    drawAlignOverlay(ctx);
  }
  // leave the pane offset cleared so pointer-side transforms are correct between frames
  View._paneDX = 0; View._paneSide = null; View._paneLayerId = null; View._paneXray = null;
}

/* draw one synced split pane (which = "left"/"right"): a clipped half-canvas showing
   that pane's selected image layer + its side's copper, offset by paneDX so the SAME
   world region appears in each half (features line up for cross-side correlation). */
function renderPane(ctx, x0, w, paneDX, which){
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, w, View.height);   // CSS px (transform already scales by dpr)
  ctx.clip();
  View._paneDX = paneDX;
  View._paneLayerId = View.paneLayer[which] || null;
  View._paneSide = paneSideOf(which);
  // a pane showing the X-ray image layer renders in X-ray by itself
  View._paneXray = View.xray || (getLayer(View._paneLayerId)?.side === "xray");
  // no image chosen for this pane → black backdrop
  if (!(getLayer(View._paneLayerId)?.img?.width)) fillBlack(ctx, x0, w);
  drawWorld(ctx);
  drawAlignOverlay(ctx);
  ctx.restore();
}

/* solid black backdrop over a screen-space rect (used when a view has no image) */
function fillBlack(ctx, x0, w){
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  ctx.fillStyle = "#000";
  ctx.fillRect(x0, 0, w, View.height);
  ctx.restore();
}

/* divider for the split view (per-pane layer/side controls are DOM dropdowns overlaid
   on each pane — see UI.refreshSplitControls) */
function drawSplitChrome(ctx, halfW){
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  ctx.strokeStyle = "#2e3742"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(halfW, 0); ctx.lineTo(halfW, View.height); ctx.stroke();
  ctx.restore();
}

/* mirror cursor: show where the pointer is in the OTHER pane (same world point),
   so you can line up a feature across the two synced views */
function drawSecondCursor(ctx, halfW){
  if (!Tools.cursor || !View.cursorPane) return;
  const other = View.cursorPane === "left" ? "right" : "left";
  const paneDX = other === "left" ? 0 : halfW;
  const fx = View.flip ? -1 : 1;
  const sx = Tools.cursor.x * View.zoom * fx + View.panX + paneDX;
  const sy = Tools.cursor.y * View.zoom + View.panY;
  if (sx < (other === "left" ? 0 : halfW) || sx > (other === "left" ? halfW : View.width)) return;
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  ctx.strokeStyle = "rgba(255,255,255,.55)"; ctx.lineWidth = 1;
  const r = 9;
  ctx.beginPath();
  ctx.moveTo(sx - r, sy); ctx.lineTo(sx + r, sy);
  ctx.moveTo(sx, sy - r); ctx.lineTo(sx, sy + r);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI*2);
  ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.stroke();
  ctx.restore();
}

function drawWorld(ctx){
  const fx = View.flip ? -1 : 1;
  ctx.save();
  ctx.translate(View.panX + View._paneDX, View.panY);
  ctx.scale(View.zoom * fx, View.zoom);

  // --- image layers ---
  // split view shows only each pane's selected layer; single view shows all visible ones
  for (const l of State.layers){
    if (View.split){ if (l.id !== View._paneLayerId) continue; }
    else if (!l.visible) continue;
    if (!l.img || !l.img.width) continue;
    ctx.save();
    ctx.globalAlpha = View.split ? Math.max(l.opacity, 0.9) : l.opacity;
    ctx.translate(l.tx, l.ty);
    if (l.warp){
      // full affine (set by 4-point alignment — includes skew)
      ctx.transform(l.warp.a, l.warp.b, l.warp.c, l.warp.d, 0, 0);
    } else {
      ctx.rotate(l.rot * Math.PI/180);
      ctx.scale(l.scale * (l.mirror ? -1 : 1), l.scale);
    }
    // large uploaded photos draw through a level-of-detail tile pyramid (only visible
    // tiles, at a resolution matched to zoom); everything else is a plain image blit
    if (l.tiles) ImageTiles.draw(ctx, l);
    else ctx.drawImage(l.img, -l.img.width/2, -l.img.height/2);
    ctx.restore();
  }

  // coverage mask (red tint = no component placed there yet)
  if (View.mask) renderMask(ctx);

  const selNet = currentHighlightNet();

  // --- traces ---
  for (const t of State.traces){
    // a focused net stays visible on every layer, even ones the active-side
    // filter would normally hide — that is the "show the net across all layers" cue
    const focused = selNet && selNet !== -1 && t.netId === selNet;
    if (!traceVisible(t) && !focused) continue;
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

  // --- components (other-side parts: pads only, dimmed) ---
  for (const c of State.components) drawComponent(ctx, c, selNet, !compBodyVisible(c));

  // --- vias (drawn AFTER components so a via inside a pad stays visible) ---
  for (const v of State.vias){
    // a focused net keeps its vias visible across every layer (matches traces above);
    // otherwise a blind/buried via is hidden on layers it doesn't reach
    const focused = selNet && selNet !== -1 && v.netId === selNet;
    if (!viaVisible(v) && !focused) continue;
    drawVia(ctx, v, selNet);
  }

  // --- ratsnest airwires (logical same-net connections) ---
  if (View.ratsnest) renderRatsnest(ctx, selNet);

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

  // --- short markers (different-net traces touching) — red ⚡ ring + cross ---
  if (View.shortMarks && View.shortMarks.length){
    ctx.save();
    ctx.strokeStyle = "#ff2b2b"; ctx.lineWidth = 3/View.zoom;
    const r = 13/View.zoom;
    for (const m of View.shortMarks){
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(m.x-r*0.6, m.y-r*0.6); ctx.lineTo(m.x+r*0.6, m.y+r*0.6);
      ctx.moveTo(m.x+r*0.6, m.y-r*0.6); ctx.lineTo(m.x-r*0.6, m.y+r*0.6);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- overlap markers (red cross where a pad collided with another net) ---
  if (View.overlapMarks && View.overlapMarks.length){
    ctx.save();
    ctx.strokeStyle = "#ff3b3b"; ctx.lineWidth = 2.5/View.zoom;
    const r = 9/View.zoom;
    for (const m of View.overlapMarks){
      ctx.beginPath();
      ctx.moveTo(m.x-r, m.y-r); ctx.lineTo(m.x+r, m.y+r);
      ctx.moveTo(m.x+r, m.y-r); ctx.lineTo(m.x-r, m.y+r);
      ctx.stroke();
    }
    ctx.restore();
  }

  // --- snap indicator ---
  if (Tools.snap){
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5/View.zoom;
    ctx.beginPath();
    ctx.arc(Tools.snap.x, Tools.snap.y, 11/View.zoom, 0, Math.PI*2);
    ctx.stroke();
    // solid centre dot marks the exact point the anchor will land on
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(Tools.snap.x, Tools.snap.y, 2.5/View.zoom, 0, Math.PI*2);
    ctx.fill();
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

  // --- 2-line deskew: draw the line(s) the user is defining ---
  if (Tools.deskewPts){
    ctx.save();
    ctx.lineWidth = 2/View.zoom;
    const pts = Tools.deskewPts;
    const seg = (a,b,col)=>{ ctx.strokeStyle=col; ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); };
    const dot = (p,col)=>{ ctx.fillStyle=col; ctx.beginPath(); ctx.arc(p.x,p.y,4/View.zoom,0,Math.PI*2); ctx.fill(); };
    if (pts[0] && pts[1]) seg(pts[0],pts[1],"#ffb648"); else if (pts[0] && Tools.cursor) seg(pts[0],Tools.cursor,"#ffb64880");
    if (pts[2] && pts[3]) seg(pts[2],pts[3],"#4fd07f"); else if (pts[2] && Tools.cursor) seg(pts[2],Tools.cursor,"#4fd07f80");
    pts.forEach((p,i)=> dot(p, i<2 ? "#ffb648" : "#4fd07f"));
    ctx.restore();
  }

  // --- alignment reference points (world-space crosshair at exact location) ---
  if (Tools.alignPts){
    ctx.save();
    Tools.alignPts.forEach((p,i)=>{
      ctx.strokeStyle = i<4 ? "#ffb648" : "#4fd07f"; // orange = points on the moving layer, green = destination
      ctx.lineWidth = 1.5/View.zoom;
      const r = 9/View.zoom;
      ctx.beginPath(); ctx.moveTo(p.x-r,p.y); ctx.lineTo(p.x+r,p.y); ctx.moveTo(p.x,p.y-r); ctx.lineTo(p.x,p.y+r); ctx.stroke();
    });
    ctx.restore();
  }

  ctx.restore();

  // sticky-note markers (screen space, constant size, drawn after the world transform)
  drawNotes(ctx);
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

/* dark net colors (e.g. black GND) get a light outline so they stay visible */
function isDarkHex(c){
  if (typeof c !== "string" || c[0] !== "#") return false;
  const h = c.length === 4 ? c.replace(/#(.)(.)(.)/,"#$1$1$2$2$3$3") : c;
  const r=parseInt(h.substr(1,2),16), g=parseInt(h.substr(3,2),16), b=parseInt(h.substr(5,2),16);
  return (0.299*r + 0.587*g + 0.114*b) < 70;
}

/* when a net is focused (selected/hovered), everything not on it is dimmed so the
   focused net pops; selNet === -1 is the blink-off frame (dim everything). */
function focusAlpha(netId, selNet){
  if (!selNet) return 1;
  const dim = (State.focusDim != null) ? State.focusDim : 0.16;
  if (selNet === -1) return dim;
  return netId === selNet ? 1 : dim;
}

function drawTrace(ctx, t, selNet){
  const hl = selNet && selNet !== -1 && t.netId === selNet;
  const fa = focusAlpha(t.netId, selNet) * xrayDim(t.side);
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (hl){
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = (t.width||3) + 7/View.zoom;
    ctx.globalAlpha = 0.5;
    pathTrace(ctx, t); ctx.stroke();
  }
  const sel = (UI.sel && UI.sel.type==="trace" && UI.sel.trace===t) || UI.isTraceSelected(t);
  ctx.strokeStyle = sel ? "#ffffff" : (t.netId ? netColor(t.netId) : SIDE_COLORS[t.side]);
  ctx.lineWidth = t.width || 3;
  ctx.globalAlpha = 0.85 * fa;
  pathTrace(ctx, t); ctx.stroke();
  // side-colored core so the layer is identifiable (and easy to aim an anchor at)
  ctx.strokeStyle = SIDE_COLORS[t.side] || "#fff";
  ctx.lineWidth = Math.max((t.width||3)*0.55, 2/View.zoom);
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
  const hl = selNet && selNet !== -1 && v.netId === selNet;
  const fa = focusAlpha(v.netId, selNet);
  const sel = UI.sel && UI.sel.type==="via" && UI.sel.via===v;
  ctx.save();
  if (hl){
    ctx.fillStyle="#fff"; ctx.globalAlpha=0.4;
    ctx.beginPath(); ctx.arc(v.x,v.y,r+5/View.zoom,0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = fa;
  const viaCol = v.netId ? netColor(v.netId) : (pth ? "#b8a06a" : "#cccccc");
  ctx.fillStyle = viaCol;
  ctx.strokeStyle = sel ? "#fff" : (isDarkHex(viaCol) ? "#9aa3ad" : (pth ? "#5a4a20" : "#222"));
  // PTH = thicker annular ring (plated through hole / mounting pad), via = thin ring
  ctx.lineWidth = (pth ? 2.5 : 1.5)/View.zoom;
  ctx.beginPath(); ctx.arc(v.x,v.y,r,0,Math.PI*2); ctx.fill(); ctx.stroke();
  // drilled hole — larger relative bore for PTH
  ctx.fillStyle = "#0d0f12";
  ctx.beginPath(); ctx.arc(v.x,v.y,r*(pth?0.55:0.45),0,Math.PI*2); ctx.fill();
  // blind / buried via: dashed outer ring so it reads as "not a full through via"
  if (viaIsBlind(v)){
    ctx.setLineDash([3/View.zoom, 2.5/View.zoom]);
    ctx.lineWidth = 1.4/View.zoom;
    ctx.strokeStyle = isDarkHex(viaCol) ? "#9aa3ad" : viaCol;
    ctx.beginPath(); ctx.arc(v.x, v.y, r + 2.6/View.zoom, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  }
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
  // dim the whole part when a different net is focused (pads on the focused net stay bright)
  const onFocusNet = selNet && selNet !== -1 && c.pins.some(p => p.netId === selNet);
  const dim = (State.focusDim != null) ? State.focusDim : 0.16;
  // an off-net component body stays a touch brighter than its pads so it still reads
  const compFa = ((!selNet) ? 1 : (onFocusNet ? 1 : (selNet === -1 ? dim : Math.min(1, dim*1.9)))) * xrayDim(c.side);
  const padDim = (padsOnly ? 0.45 : 1) * compFa;
  if (!padsOnly){
    // body (dashed outline = locked)
    ctx.strokeStyle = isSel ? "#ffffff" : (c.side==="back" ? "#5a78c8" : "#b9c2cf");
    ctx.lineWidth = (isSel?2.2:1.4)/View.zoom;
    ctx.globalAlpha = 0.95 * compFa;
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
    // a pad on the focused net stays full-bright even if its component is dimmed
    const padA = (selNet && selNet !== -1 && st.netId === selNet) ? (padsOnly?0.45:1) : padDim;
    if (hl){
      ctx.fillStyle="#fff"; ctx.globalAlpha=.5;
      ctx.beginPath(); ctx.arc(x,y,Math.max(w,h)/2+4/View.zoom,0,Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = padA;
    const padCol = hasNet ? netColor(st.netId) : (c.side==="back" ? "#41599c" : "#9b8338");
    ctx.fillStyle = padCol;
    const darkNet = hasNet && isDarkHex(padCol);
    if (fpin.shape==="circle"){
      ctx.beginPath(); ctx.arc(x,y,w/2,0,Math.PI*2); ctx.fill();
      if (darkNet){ ctx.strokeStyle="#9aa3ad"; ctx.lineWidth=1/View.zoom; ctx.stroke(); }
      ctx.fillStyle="#0d0f12";
      ctx.beginPath(); ctx.arc(x,y,w/5,0,Math.PI*2); ctx.fill();
    } else {
      ctx.fillRect(x-w/2,y-h/2,w,h);
      if (darkNet){ ctx.strokeStyle="#9aa3ad"; ctx.lineWidth=1/View.zoom; ctx.strokeRect(x-w/2,y-h/2,w,h); }
    }
    if (selPin){
      ctx.strokeStyle="#fff"; ctx.lineWidth=2/View.zoom;
      ctx.beginPath(); ctx.arc(x,y,Math.max(w,h)/2+3/View.zoom,0,Math.PI*2); ctx.stroke();
    }
  }
  // overlay symbols (diode glyph, polarity +) — full part view only
  if (!padsOnly){
    ctx.globalAlpha = compFa;
    if (fp.symbol === "diode") drawDiodeSymbol(ctx, fp, s, {zoom:View.zoom});
    if (fp.polar) drawPolaritySymbol(ctx, fp, s, {zoom:View.zoom});
  }
  // pin1 marker (skip on far-side pad-only render)
  const p1 = fp.pins[0];
  if (p1 && !(padsOnly && p1.shape !== "circle")){
    ctx.globalAlpha = compFa;
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

/* grab a small square crop of the rendered canvas around a click (CSS-px point)
   to use as a "what you clicked" thumbnail for alignment guidance */
const ALIGN_THUMB = 60;     // thumbnail size in px
function captureAlignThumb(pt){
  const dpr = View.dpr || 1;
  const css = 50;           // captured region (CSS px) around the click
  const c = document.createElement("canvas");
  c.width = ALIGN_THUMB; c.height = ALIGN_THUMB;
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = true;
  try {
    x.drawImage(View.canvas, (pt.x - css/2)*dpr, (pt.y - css/2)*dpr, css*dpr, css*dpr,
                0, 0, ALIGN_THUMB, ALIGN_THUMB);
  } catch(e){ /* tainted/empty — skip */ }
  // crosshair marking the exact clicked centre
  x.strokeStyle = "rgba(255,255,255,.85)"; x.lineWidth = 1;
  x.beginPath(); x.moveTo(ALIGN_THUMB/2,6); x.lineTo(ALIGN_THUMB/2,ALIGN_THUMB-6);
  x.moveTo(6,ALIGN_THUMB/2); x.lineTo(ALIGN_THUMB-6,ALIGN_THUMB/2); x.stroke();
  return c;
}

/* numbered markers + click thumbnails for the 4+4 alignment, drawn in screen space */
function drawAlignOverlay(ctx){
  if (!Tools.alignPts || !Tools.alignPts.length) return;
  ctx.save();
  ctx.setTransform(View.dpr,0,0,View.dpr,0,0);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  Tools.alignPts.forEach((p,i) => {
    const moving = i < 4;
    const num = (i % 4) + 1;
    const col = moving ? "#ffb648" : "#4fd07f";
    const sc = worldToScreen(p.x, p.y);
    // numbered badge on the marker
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(sc.x, sc.y, 9, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = "#10141a"; ctx.font = "bold 12px Segoe UI";
    ctx.fillText(num, sc.x, sc.y+0.5);
    // thumbnail of what was clicked, just up-right of the marker
    if (p.thumb){
      const tx = sc.x + 12, ty = sc.y - 12 - ALIGN_THUMB;
      ctx.drawImage(p.thumb, tx, ty);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.strokeRect(tx, ty, ALIGN_THUMB, ALIGN_THUMB);
      ctx.fillStyle = col;
      ctx.fillRect(tx, ty-13, 15, 13);
      ctx.fillStyle = "#10141a"; ctx.font = "bold 10px Segoe UI";
      ctx.fillText(num, tx+7, ty-6);
    }
  });
  // during the destination phase, show the moving-layer thumbnails as a reference
  // strip so you know which feature to match next
  if (Tools.alignPts.length >= 4){
    const need = Tools.alignPts.length - 4; // index of the next destination to place (0..3)
    const pad = 8, sz = ALIGN_THUMB, x0 = 10, y0 = 60;
    ctx.fillStyle = "rgba(16,20,26,.92)";
    ctx.fillRect(x0-pad, y0-26, sz+pad*2, 26 + (sz+pad)*4);
    ctx.fillStyle = "#cfd6df"; ctx.font = "11px Segoe UI"; ctx.textAlign = "left";
    ctx.fillText("Match these features:", x0, y0-13);
    ctx.textAlign = "center";
    for (let i=0;i<4 && i<Tools.alignPts.length;i++){
      const yy = y0 + i*(sz+pad);
      if (Tools.alignPts[i].thumb) ctx.drawImage(Tools.alignPts[i].thumb, x0, yy);
      const active = i === need;
      ctx.strokeStyle = active ? "#ffffff" : "#ffb648";
      ctx.lineWidth = active ? 3 : 1.5;
      ctx.strokeRect(x0, yy, sz, sz);
      ctx.fillStyle = "#ffb648"; ctx.fillRect(x0, yy, 16, 14);
      ctx.fillStyle = "#10141a"; ctx.font = "bold 11px Segoe UI";
      ctx.fillText(i+1, x0+8, yy+7);
      if (active){ ctx.fillStyle="#ffffff"; ctx.font="11px Segoe UI"; ctx.textAlign="left"; ctx.fillText("◄ place now", x0+sz+6, yy+sz/2); ctx.textAlign="center"; }
    }
  }
  ctx.restore();
}

/* ---------- ratsnest: straight "airwire" links between same-net conductors ----------
   Shows a net's logical connectivity as a minimum spanning tree over its pads and
   vias. When a net is focused (hovered/selected) only that net's airwires are drawn
   bright; otherwise every net is drawn faintly so the whole board's connectivity
   reads at a glance. This is a reverse-engineering aid, not a router — it links the
   things that SHOULD be on one net, regardless of which copper layer they sit on. */
function netNodes(netId){
  const pts = [];
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      if (c.pins[pi].netId !== netId) continue;
      const fpin = fp.pins[pi]; if (!fpin) continue;
      pts.push(pinWorldPos(c, fpin));
    }
  }
  for (const v of State.vias) if (v.netId === netId) pts.push({ x:v.x, y:v.y });
  return pts;
}

/* Prim's minimum spanning tree over a small point set → list of [i,j] edges */
function mstEdges(pts){
  const n = pts.length, edges = [];
  if (n < 2) return edges;
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(-1);
  best[0] = 0;
  for (let k=0; k<n; k++){
    let u = -1, bd = Infinity;
    for (let i=0; i<n; i++) if (!inTree[i] && best[i] < bd){ bd = best[i]; u = i; }
    if (u < 0) break;
    inTree[u] = true;
    if (from[u] >= 0) edges.push([from[u], u]);
    for (let v=0; v<n; v++){
      if (inTree[v]) continue;
      const d = Math.hypot(pts[u].x - pts[v].x, pts[u].y - pts[v].y);
      if (d < best[v]){ best[v] = d; from[v] = u; }
    }
  }
  return edges;
}

function renderRatsnest(ctx, selNet){
  const focused = selNet && selNet !== -1;
  ctx.save();
  ctx.lineCap = "round";
  ctx.setLineDash([5/View.zoom, 4/View.zoom]);
  for (const net of State.nets){
    if (focused && net.id !== selNet) continue;
    const pts = netNodes(net.id);
    if (pts.length < 2) continue;
    const edges = mstEdges(pts);
    const col = net.color || "#9aa3ad";
    // airwires
    ctx.strokeStyle = col;
    ctx.globalAlpha = focused ? 0.95 : 0.38;
    ctx.lineWidth = (focused ? 1.7 : 1.1)/View.zoom;
    ctx.beginPath();
    for (const [i,j] of edges){
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[j].x, pts[j].y);
    }
    ctx.stroke();
    // node dots at each endpoint
    ctx.globalAlpha = focused ? 0.9 : 0.32;
    ctx.fillStyle = col;
    for (const p of pts){
      ctx.beginPath(); ctx.arc(p.x, p.y, 2.4/View.zoom, 0, Math.PI*2); ctx.fill();
    }
  }
  ctx.restore();
}

/* ---------- coverage mask: tint board areas not yet covered by components ---------- */
let _maskCv = null;
function renderMask(ctx){
  if (!_maskCv) _maskCv = document.createElement("canvas");
  const mc = _maskCv;
  // only resize when the canvas actually changed — assigning width/height reallocates the
  // buffer (and clears it), so doing it every frame the mask is on is pure waste
  if (mc.width !== View.canvas.width || mc.height !== View.canvas.height){
    mc.width = View.canvas.width; mc.height = View.canvas.height;
  }
  const m = mc.getContext("2d");
  m.setTransform(1,0,0,1,0,0);
  m.clearRect(0,0,mc.width,mc.height);   // clear ourselves since we no longer realloc each frame
  m.setTransform(View.dpr,0,0,View.dpr,0,0);
  const fx = View.flip ? -1 : 1;
  m.translate(View.panX + View._paneDX, View.panY);
  m.scale(View.zoom * fx, View.zoom);
  // strong dark-red tint over every visible photo area (covered areas get punched
  // out below, so they stay bright — high contrast against the darkened rest)
  const tintLayers = (style) => {
    m.fillStyle = style;
    for (const l of State.layers){
      if (!l.visible || !l.img || !l.img.width) continue;
      m.save();
      m.translate(l.tx, l.ty);
      if (l.warp) m.transform(l.warp.a, l.warp.b, l.warp.c, l.warp.d, 0, 0);
      else { m.rotate(l.rot*Math.PI/180); m.scale(l.scale*(l.mirror?-1:1), l.scale); }
      m.fillRect(-l.img.width/2, -l.img.height/2, l.img.width, l.img.height);
      m.restore();
    }
  };
  tintLayers("rgba(8,9,12,0.62)");    // darken
  tintLayers("rgba(255,55,55,0.42)"); // then red
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

/* ---------- sticky-note annotations ----------
   Non-obstructing by design: a small constant-size marker is always shown, but the
   note's text only appears (as a bubble) when the note is hovered or selected, so
   annotations never cover the board they point at. */
const NOTE_MARK = 15;      // marker size in screen px
function noteColor(n){ return (n && /^#[0-9a-fA-F]{6}$/.test(n.color)) ? n.color : "#ffd24d"; }

function drawNotes(ctx){
  if (!State.notes.length) return;
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  const half = NOTE_MARK/2;
  for (const n of State.notes){
    const sc = worldToScreen(n.x, n.y);
    // In split mode drawNotes runs once per pane with that pane's _paneDX, and the
    // surrounding pane clip keeps drawing inside its own half — so each note simply
    // lands at its true world position in every pane, regardless of the pane's copper
    // side (notes aren't tied to a layer). The old front/back test mislabelled inner
    // side panes and could drop notes entirely; the clip handles it correctly instead.
    const col = noteColor(n);
    const selected = UI.sel && UI.sel.type === "note" && UI.sel.note === n;
    const hovered = View.hoverNote === n;
    // sticky-note icon (rounded square + folded corner), centred on the anchor
    ctx.save();
    ctx.translate(sc.x, sc.y);
    if (selected || hovered){
      ctx.fillStyle = "rgba(255,255,255,.35)";
      ctx.beginPath(); ctx.arc(0, 0, half + 4, 0, Math.PI*2); ctx.fill();
    }
    roundRect(ctx, -half, -half, NOTE_MARK, NOTE_MARK, 3);
    ctx.fillStyle = col; ctx.fill();
    ctx.strokeStyle = selected ? "#ffffff" : "rgba(0,0,0,.55)";
    ctx.lineWidth = selected ? 2 : 1; ctx.stroke();
    // folded corner (bottom-right)
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.beginPath();
    ctx.moveTo(half-5, half); ctx.lineTo(half, half-5); ctx.lineTo(half, half); ctx.closePath(); ctx.fill();
    // a couple of "text lines" so it reads as a note even when collapsed
    ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-half+3, -2); ctx.lineTo(half-3, -2);
    ctx.moveTo(-half+3,  2); ctx.lineTo(half-5,  2);
    ctx.stroke();
    ctx.restore();
    // text bubble on hover / selection
    if (selected || hovered) drawNoteBubble(ctx, sc.x + half + 6, sc.y - half, n, col);
  }
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}

function drawNoteBubble(ctx, x, y, n, col){
  const text = (n.text || "").trim() || "(empty note — double-click to edit)";
  ctx.font = "12px Segoe UI, sans-serif";
  const maxW = 240, padX = 8, padY = 6, lh = 15;
  const lines = wrapText(ctx, text, maxW);
  let bw = 0;
  for (const l of lines) bw = Math.max(bw, ctx.measureText(l).width);
  bw = Math.min(maxW, bw) + padX*2;
  const bh = lines.length * lh + padY*2;
  // keep the bubble on-screen (flip to the left / clamp vertically)
  if (x + bw > View.width - 4) x = View.width - 4 - bw;
  if (y + bh > View.height - 4) y = View.height - 4 - bh;
  if (y < 4) y = 4;
  roundRect(ctx, x, y, bw, bh, 5);
  ctx.fillStyle = "rgba(16,20,26,.95)"; ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = n.text ? "#e6ebf1" : "#8b96a5";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, x + padX, y + padY + i*lh));
}

/* greedy word-wrap; also respects explicit newlines */
function wrapText(ctx, text, maxW){
  const out = [];
  for (const para of String(text).split("\n")){
    let line = "";
    for (const word of para.split(/\s+/)){
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line){ out.push(line); line = word; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}
