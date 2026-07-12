/* ===== view/overlays.js — ratsnest, coverage mask, sticky-note bubbles ===== */
"use strict";


/* ---------- ratsnest: straight "airwire" links between same-net conductors ----------
   Shows a net's logical connectivity as a minimum spanning tree over its pads and
   vias. When a net is focused (hovered/selected) only that net's airwires are drawn
   bright; otherwise every net is drawn faintly so the whole board's connectivity
   reads at a glance. This is a reverse-engineering aid, not a router — it links the
   things that SHOULD be on one net, regardless of which copper layer they sit on. */
function netNodes(netId, includeVias = true){
  const pts = [];
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      if (c.pins[pi].netId !== netId) continue;
      const fpin = fp.pins[pi]; if (!fpin) continue;
      pts.push(pinWorldPos(c, fpin));
    }
  }
  if (includeVias) for (const v of State.vias) if (v.netId === netId) pts.push({ x:v.x, y:v.y });
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

/* the pad a star ratsnest hangs off: the HOVERED pad if there is one, else the SELECTED
   pad. Vias never anchor a star, and traces have no single point — only pads qualify.
   Returns its world point + net, or null when nothing usable is under the cursor/selected. */
function ratsnestHubNode(){
  const asHub = (comp, pinIdx, hover) => {
    const fp = compFootprint(comp);
    const fpin = fp.pins[pinIdx]; if (!fpin) return null;
    return { p: pinWorldPos(comp, fpin), netId: comp.pins[pinIdx].netId, hover };
  };
  const hv = View.hoverPin;
  if (hv && hv.comp) return asHub(hv.comp, hv.pinIdx, true);
  const sel = UI.sel;
  if (sel && sel.type === "pin") return asHub(sel.comp, sel.pinIdx, false);
  return null;
}

/* above this many same-net pads, a hovered star is just a hairball — don't draw it on a
   passing hover (an explicit pad SELECTION still shows the full star) */
const RATSNEST_HOVER_MAX = 50;

/* "star" ratsnest: spokes from the hovered/selected pad to every other PAD on its net —
   answers "what does THIS pad connect to". Vias are excluded; nothing is drawn until a
   pad is hovered or selected. */
function renderRatsnestStar(ctx){
  const hub = ratsnestHubNode();
  if (!hub || !hub.netId) return;
  const pts = netNodes(hub.netId, false);   // pads only — no vias in star mode
  if (pts.length < 2) return;
  // on a passing hover, don't draw a hairball for a big net (spokes = pads − the hub)
  if (hub.hover && pts.length - 1 > RATSNEST_HOVER_MAX) return;
  const col = netColor(hub.netId);
  ctx.save();
  ctx.lineCap = "round";
  ctx.setLineDash([5/View.zoom, 4/View.zoom]);
  // spokes hub → each other node
  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 1.7/View.zoom;
  ctx.beginPath();
  for (const p of pts){
    if (Math.hypot(p.x-hub.p.x, p.y-hub.p.y) < 1e-6) continue; // skip the hub itself
    ctx.moveTo(hub.p.x, hub.p.y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // node dots
  ctx.globalAlpha = 0.9; ctx.fillStyle = col;
  for (const p of pts){ ctx.beginPath(); ctx.arc(p.x, p.y, 2.4/View.zoom, 0, Math.PI*2); ctx.fill(); }
  // emphasise the hub
  ctx.globalAlpha = 1; ctx.fillStyle = "#ffffff";
  ctx.beginPath(); ctx.arc(hub.p.x, hub.p.y, 3.6/View.zoom, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 1.6/View.zoom; ctx.setLineDash([]); ctx.stroke();
  ctx.restore();
}

function renderRatsnest(ctx, selNet){
  if (View.ratsnestMode === "star"){ renderRatsnestStar(ctx); return; }
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

/* ---------- coverage mask: REMOVED (Jul 2026) ----------
   The coverage-mask overlay was dropped; the helper is retained-as-dead only if
   referenced. All wiring/buttons/keymap removed. */
let _maskCv = null;
function renderMask_removed(ctx){
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
    m.beginPath(); m.arc(v.x, v.y, (v.r||State.viaR) + margin*0.6, 0, Math.PI*2); m.fill();
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
