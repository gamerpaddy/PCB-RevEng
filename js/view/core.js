/* ===== view.js — canvas rendering, pan/zoom, coordinate transforms, hit testing ===== */
"use strict";

const View = {
  canvas: null, ctx: null,
  panX: 0, panY: 0, zoom: 1,
  flip: false,            // true = look at the board from the back (mirror X)
  mask: false,            // coverage mask overlay
  width: 0, height: 0,
  hoverNetId: null,       // net under cursor → highlights the WHOLE net (only when nothing is selected)
  hoverObj: null,         // trace/via under cursor → highlighted on its own (the "just this thing" hover cue)
  hoverNote: null,        // sticky note under cursor → show its text
  hoverPin: null,         // {comp,pinIdx} pad under cursor → anchors the "star" ratsnest on hover + single-pad hover cue
  cursorLabel: null,      // {text,color,x,y} discreet net-name chip drawn next to the pointer (screen px) when hovering a pad/via/trace
  blinkNet: null,         // net flashing after a net-list click
  blinkOn: false,
  ratsnest: false,        // draw straight "airwire" connections between same-net pads/vias
  ratsnestMode: "mst",    // "mst" = minimum-spanning tree over the whole net · "star" = spokes from the selected pad to every same-net pad/via
  hideTraces: false,      // hide all drawn traces (also makes them non-interactive) to read the bare photo/pads
  hideLabels: false,      // hide component reference-designator + value text (declutter dense boards)
  hideVias: false,        // hide all vias (also makes them non-interactive)
  labViaHi: false,        // EXPERIMENTAL: ring under-connected vias
  labViaMin: 0,           // EXPERIMENTAL: highlight vias touching ≥ this many copper features
  labViaMax: 1,           // EXPERIMENTAL: …and ≤ this many (range min..max, inclusive)
  _labViaSet: null,       // per-frame set of vias to ring (built in render when labViaHi)
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
  // include every conductor so an import whose copper extends past the outermost parts
  // (or a trace-only board) still fits fully in view
  const acc = (x, y, r) => { r = r || 0;
    minX=Math.min(minX,x-r); maxX=Math.max(maxX,x+r);
    minY=Math.min(minY,y-r); maxY=Math.max(maxY,y+r); any=true; };
  for (const c of State.components) acc(c.x, c.y, compRadius(c));
  for (const v of State.vias) acc(v.x, v.y, v.r || State.viaR);
  for (const t of State.traces) for (const p of t.points) acc(p.x, p.y, (t.width||3)/2);
  for (const n of State.notes) acc(n.x, n.y, 0);
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

