/* ===== view/draw.js — trace/via/component drawing, net colors, align overlay ===== */
"use strict";


function currentHighlightNet(){
  if (View.blinkNet && View.blinkOn) return View.blinkNet;
  if (View.blinkNet && !View.blinkOn) return -1; // suppress other highlights mid-blink-off
  // Whole-net hover highlight ONLY when nothing is selected. With a selection active,
  // hovering a different net must not light up that whole net — just the single hovered
  // object is emphasised (see drawTrace/drawVia/drawComponent), and the selection's net
  // stays the highlighted one.
  const hasSelection = !!(UI.sel || UI.activeNetId);
  if (View.hoverNetId && !hasSelection) return View.hoverNetId;
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
  // the single hovered trace glows and stays full-bright even when it's not on the
  // focused net (so a selection can be held while pointing at another net's trace)
  const isHover = View.hoverObj === t;
  const hl = (selNet && selNet !== -1 && t.netId === selNet) || isHover;
  // while a net is highlighted, traces on a layer other than the active one are drawn
  // at half opacity so the active-layer copper reads clearly on top (xray has its own
  // dimming, so leave it alone there)
  const otherDim = (selNet && selNet !== -1 && t.side !== effDrawSide() && !effXray()) ? 0.5 : 1;
  const fa = (isHover ? 1 : focusAlpha(t.netId, selNet)) * xrayDim(t.side) * otherDim;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (hl){
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = (t.width||3) + 7/View.zoom;
    ctx.globalAlpha = 0.5 * otherDim;
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
  const r = v.r || State.viaR;
  const isHover = View.hoverObj === v;   // single hovered via glows on its own
  const hl = (selNet && selNet !== -1 && v.netId === selNet) || isHover;
  const fa = isHover ? 1 : focusAlpha(v.netId, selNet);
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
  // EXPERIMENTAL: bright magenta ring on under-connected vias (independent of net colour)
  if (View._labViaSet && View._labViaSet.has(v)){
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = "#ff2d78";
    ctx.lineWidth = 2.4/View.zoom;
    ctx.beginPath(); ctx.arc(v.x, v.y, r + 4.5/View.zoom, 0, Math.PI*2); ctx.stroke();
  }
  ctx.restore();
}

/* EXPERIMENTAL: set of vias with ≤ View.labViaMax copper "arms" — dangling vias that connect
   little or nothing. An arm is a piece of copper leaving the via: a trace END on the via = 1
   arm, a trace passing THROUGH it (interior vertex, or a segment crossing it) = 2 arms, each
   touching pad = 1 arm. So a via with one trace through it reads as 2 (not flagged), while a
   via at the dead end of a single trace reads as 1. Early-breaks once a via clears the max. */
function computeLabViaSet(){
  const set = new Set();
  const max = Math.max(0, View.labViaMax|0);
  for (const v of State.vias) if (viaArmCount(v, max) <= max) set.add(v);
  return set;
}
function viaArmCount(v, cap){
  let arms = 0;
  const r = v.r || State.viaR;
  for (const t of State.traces){
    if (!viaOnSide(v, t.side)) continue;
    const tol = r + (t.width || State.traceW) / 2;
    let vArms = 0, vertexOn = false;
    for (let i=0; i<t.points.length; i++){
      if (Math.hypot(t.points[i].x - v.x, t.points[i].y - v.y) <= tol){
        vertexOn = true;
        if (i > 0) vArms++;                       // segment coming in
        if (i < t.points.length - 1) vArms++;     // segment going out
      }
    }
    if (!vertexOn){                                // no vertex on the via — a segment passing over it?
      for (let k=0; k<t.points.length-1; k++)
        if (distToSeg(v.x, v.y, t.points[k], t.points[k+1]) <= tol){ vArms = 2; break; }
    }
    arms += vArms;
    if (arms > cap) return arms;                  // early out — this via is well enough connected
  }
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      if (padTouchesVia(c, fpin, v) && ++arms > cap) return arms;
    }
  }
  return arms;
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
    // on the far side only through-hole pads reach through — a round SMD land (tht:false,
    // e.g. a test point or BGA ball) lives on ONE side, so it must NOT show on the far side
    if (padsOnly && !(fpin.shape === "circle" && fpin.tht !== false)) continue;
    const st = c.pins[pi] || {};
    const hasNet = !!st.netId;
    // the single hovered pad glows on its own (the "just this thing" hover cue), so a
    // selection can be held while pointing at another net's pad
    const isHoverPad = View.hoverPin && View.hoverPin.comp === c && View.hoverPin.pinIdx === pi;
    const hl = (selNet && st.netId === selNet) || isHoverPad;
    const x=fpin.xmm*s, y=fpin.ymm*s, w=fpin.w*s, h=fpin.h*s;
    const selPin = (UI.sel && UI.sel.type==="pin" && UI.sel.comp===c && UI.sel.pinIdx===pi) ||
                   UI.isPinSelected(c, pi);
    // a pad on the focused net (or the hovered pad) stays full-bright even if its component is dimmed
    const padA = ((selNet && selNet !== -1 && st.netId === selNet) || isHoverPad) ? (padsOnly?0.45:1) : padDim;
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
      // drill hole only for through-hole pads — a round SMD pad (tht:false, e.g. a BGA
      // ball) is a solid dot with no hole
      if (fpin.tht !== false){
        ctx.fillStyle="#0d0f12";
        const hr = fpin.hole ? Math.min(fpin.hole, fpin.w)*s/2 : w/5;   // explicit hole Ø, else default
        ctx.beginPath(); ctx.arc(x,y,hr,0,Math.PI*2); ctx.fill();
      }
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
  if (p1 && !(padsOnly && !(p1.shape === "circle" && p1.tht !== false))){
    ctx.globalAlpha = compFa;
    ctx.fillStyle = "#ff5d5d";
    ctx.beginPath(); ctx.arc(p1.xmm*s, p1.ymm*s, Math.max(2.2/View.zoom, Math.max(p1.w,0.4)*s*0.18), 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();

  // reference text (always upright, readable, never mirrored) — hugs the body's top edge
  if (!padsOnly && !View.hideLabels && View.zoom * s > 1.0){
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
function drawAlignBanner(ctx){
  // top-centre pill making the current align state unmistakable
  const marker = !!(Tools.alignPts);
  const deskew = !!(Tools.deskewPts);
  let txt, bg;
  if (deskew){ txt = "DESKEW — click the line points · Esc: exit"; bg = "#5a2f7a"; }
  else if (marker){
    const n = Tools.alignPts.length;
    txt = "ALIGN 4-POINT — click: place marker (" + n + "/8) · drag: move image · Esc: exit";
    bg = "#7a5a24";
  } else {
    txt = "ALIGN / MOVE — drag: move image · Shift+drag: rotate · Esc: exit";
    bg = "#245a4a";
  }
  ctx.font = "600 12px Segoe UI, sans-serif";
  const w = ctx.measureText(txt).width, pad = 12, h = 24;
  const cx = View.width/2, x = cx - w/2 - pad, y = 8;
  ctx.fillStyle = bg;
  ctx.strokeStyle = "rgba(255,255,255,.25)"; ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w + pad*2, h, 6); else ctx.rect(x, y, w + pad*2, h, 6);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#ffce8a"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(txt, cx, y + h/2 + 0.5);
}

function drawAlignOverlay(ctx){
  if (Tools.name !== "align") return;
  ctx.save();
  ctx.setTransform(View.dpr,0,0,View.dpr,0,0);
  drawAlignBanner(ctx);
  if (!Tools.alignPts || !Tools.alignPts.length){ ctx.restore(); return; }
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
