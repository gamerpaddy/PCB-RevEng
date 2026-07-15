/* ===== view/render.js — render loop, pane rendering, drawWorld orchestrator ===== */
"use strict";

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

/* traces shown only for the active draw side (X-ray shows all; vias & pads always shown).
   The "hide traces" toggle wins over everything, so hidden traces are also non-interactive
   (hit-testing, vertex handles, cut/edit all key off traceVisible). */
function traceVisible(t){
  if (View.hideTraces) return false;
  return State.traceView !== "active" || effXray() || t.side === effDrawSide();
}

/* a through via shows on every layer; a blind/buried via only shows on the copper
   sides it actually reaches — same idea as compBodyVisible, so it disappears on
   layers it isn't on (X-ray shows all) */
function viaVisible(v){
  if (View.hideVias) return false;   // hard hide → also non-interactive (hitTest keys off this)
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
    drawRotateGizmo(ctx);
    drawResizeBanner(ctx);
    drawModeBanner(ctx);
  }
  // leave the pane offset cleared so pointer-side transforms are correct between frames
  View._paneDX = 0; View._paneSide = null; View._paneLayerId = null; View._paneXray = null;
  drawCursorLabel(ctx);
}

/* discreet net-name chip pinned next to the pointer while hovering a pad/via/trace in
   Select mode (set in tools.js onPointerMove). Screen space, semi-transparent so it never
   obscures the board; a small dot shows the net colour. */
function drawCursorLabel(ctx){
  const L = View.cursorLabel;
  if (!L || !L.text) return;
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "top";
  const dot = L.color ? 12 : 0;
  const padX = 7, padY = 3;
  const tw = ctx.measureText(L.text).width;
  const bw = tw + dot + padX*2, bh = 19;
  // sit just below-right of the cursor; flip to the other side near a viewport edge
  let x = L.x + 15, y = L.y + 16;
  if (x + bw > View.width - 4)  x = L.x - bw - 10;
  if (y + bh > View.height - 4) y = L.y - bh - 10;
  if (x < 4) x = 4;
  if (y < 4) y = 4;
  roundRect(ctx, x, y, bw, bh, 4);
  ctx.fillStyle = "rgba(18,22,28,.82)"; ctx.fill();
  ctx.strokeStyle = "rgba(120,132,148,.45)"; ctx.lineWidth = 1; ctx.stroke();
  let tx = x + padX;
  if (L.color){
    ctx.fillStyle = L.color;
    ctx.beginPath(); ctx.arc(x + padX + 3.5, y + bh/2, 3.5, 0, Math.PI*2); ctx.fill();
    if (isDarkHex(L.color)){ ctx.strokeStyle = "rgba(154,163,173,.8)"; ctx.lineWidth = 1; ctx.stroke(); }
    tx += dot;
  }
  ctx.fillStyle = "#e6ebf1";
  ctx.fillText(L.text, tx, y + padY);
  ctx.restore();
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

  const selNet = currentHighlightNet();

  // --- traces ---
  // "hide traces" is a hard override — it also suppresses the focused-net "show across
  // all layers" exception below, so every trace really disappears.
  // Two passes by side so the ACTIVE-side copper always draws on top: otherwise a
  // focused net's other-side trace (shown "across all layers") could paint over the
  // active-side trace the cursor is actually on.
  if (!View.hideTraces){
    // resting state (no net focused) → merge-composite so overlapping/differing-width
    // copper reads as one solid track instead of stacked translucent pills
    if (!selNet){
      renderTracesMerged(ctx);
    } else {
      const aSide = effDrawSide();
      const pass = (activeSidePass) => {
        for (const t of State.traces){
          // a focused net stays visible on every layer, even ones the active-side
          // filter would normally hide — that is the "show the net across all layers" cue
          const focused = selNet && t.netId === selNet;
          if (!traceVisible(t) && !focused) continue;
          if ((t.side === aSide) !== activeSidePass) continue;
          drawTrace(ctx, t, selNet);
        }
      };
      pass(false);   // other layers first (behind)
      pass(true);    // active-side traces on top
    }
  }
  // --- in-progress trace preview ---
  if (Tools.tracePts && Tools.tracePts.length){
    const col = SIDE_COLORS[Tools.traceSide] || "#fff";
    const buildPath = () => {
      ctx.beginPath();
      ctx.moveTo(Tools.tracePts[0].x, Tools.tracePts[0].y);
      for (let i=1;i<Tools.tracePts.length;i++) ctx.lineTo(Tools.tracePts[i].x, Tools.tracePts[i].y);
      if (Tools.cursor){ const cp = traceCursorPoint(); ctx.lineTo(cp.x, cp.y); }
    };
    ctx.save();
    // translucent band at the ACTUAL width being drawn, so Shift+W changes are visible live
    ctx.strokeStyle = col; ctx.globalAlpha = 0.3;
    ctx.lineWidth = Tools.traceWidth || State.traceW;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    buildPath(); ctx.stroke();
    // dashed centreline on top
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3/View.zoom;
    ctx.setLineDash([6/View.zoom, 4/View.zoom]);
    buildPath(); ctx.stroke();
    ctx.restore();
  }

  // --- components (other-side parts: pads only, dimmed) ---
  for (const c of State.components) drawComponent(ctx, c, selNet, !compBodyVisible(c));

  // --- vias (drawn AFTER components so a via inside a pad stays visible) ---
  // "hide vias" is a hard override — like "hide traces" it also suppresses the focused-net
  // "show across all layers" exception below, so every via really disappears
  // EXPERIMENTAL: mark under-connected vias once per frame (opt-in; off = no cost, no effect)
  View._labViaSet = View.labViaHi ? computeLabViaSet() : null;
  if (!View.hideVias) for (const v of State.vias){
    // a focused net keeps its vias visible across every layer (matches traces above);
    // otherwise a blind/buried via is hidden on layers it doesn't reach
    const focused = selNet && v.netId === selNet;
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

  // checker markers fade out over 5s from when the checker last ran (View.checkMarksT0)
  const _ckNow = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const _ckAlpha = View.checkMarksT0 ? Math.max(0, 1 - (_ckNow - View.checkMarksT0) / 5000) : 1;

  // --- checker markers (pads with no net) ---
  if (_ckAlpha > 0 && View.checkMarks && View.checkMarks.length){
    ctx.save();
    ctx.globalAlpha = _ckAlpha;
    ctx.strokeStyle = "#ff4dff"; ctx.lineWidth = 2.5/View.zoom;
    const r = 12/View.zoom;
    for (const m of View.checkMarks){
      ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI*2); ctx.stroke();
    }
    ctx.restore();
  }

  // --- short markers (different-net traces touching) — red ⚡ ring + cross ---
  if (_ckAlpha > 0 && View.shortMarks && View.shortMarks.length){
    ctx.save();
    ctx.globalAlpha = _ckAlpha;
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

  // --- transient locator flash (checker "Go" jump) — red ring, fades over 5s ---
  if (View.flashMark){
    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const a = Math.max(0, 1 - (now - View.flashMark.t0) / 5000);
    if (a > 0){
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = "#ff2b2b"; ctx.lineWidth = 3/View.zoom;
      const r = 16/View.zoom;
      ctx.beginPath(); ctx.arc(View.flashMark.x, View.flashMark.y, r, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath(); ctx.arc(View.flashMark.x, View.flashMark.y, r*0.5, 0, Math.PI*2); ctx.stroke();
      ctx.restore();
    }
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

  // NB: the quick-add ghost is NOT drawn on the board — its popup samples this canvas as a
  // crop, so drawing the ghost here would double-expose it (and lag a frame while nudging).
  // The footprint is drawn only inside the popup preview (quickadd.js QuickAdd.render).

  // --- measure overlay ---
  if (Tools.measureA && Tools.cursor){
    const a = Tools.measureA, b = Tools.measureB || Tools.cursor;
    ctx.save();
    ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 1.5/View.zoom;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    ctx.restore();
  }

  // --- resize-XY reference line (locked to X or Y axis) ---
  if (Tools.resizeLine){
    const a = Tools.resizeLine.a, b = Tools.resizeLine.b;
    const col = Tools.resizeStep === 0 ? "#ffb648" : "#4fd07f";   // orange = width, green = height
    ctx.save();
    ctx.strokeStyle = col; ctx.lineWidth = 2/View.zoom;
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    const t = 6/View.zoom;   // end ticks
    if (Tools.resizeStep === 0){
      ctx.beginPath(); ctx.moveTo(a.x,a.y-t); ctx.lineTo(a.x,a.y+t); ctx.moveTo(b.x,b.y-t); ctx.lineTo(b.x,b.y+t); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(a.x-t,a.y); ctx.lineTo(a.x+t,a.y); ctx.moveTo(b.x-t,b.y); ctx.lineTo(b.x+t,b.y); ctx.stroke();
    }
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

  // --- box (marquee) selection: highlight members + draw the rubber-band while dragging ---
  drawBoxSelection(ctx);

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
  drawMeasureLabel(ctx);
  drawResizeLabel(ctx);
  drawPadEditOverlay(ctx);
  drawCropOverlay(ctx);
}

/* box-select: a cyan highlight on every marquee-selected object, plus the live rubber-band
   rectangle while the drag is in progress. All world-space (constant screen thickness). */
function drawBoxSelection(ctx){
  const col = "#39d0ff";
  if (UI.boxSel && UI.boxSel.length){
    ctx.save();
    ctx.strokeStyle = col; ctx.globalAlpha = 0.95; ctx.lineWidth = 2/View.zoom;
    for (const s of UI.boxSel){
      if (s.type === "comp"){
        const r = compRadius(s.comp) + 3/View.zoom;
        ctx.strokeRect(s.comp.x - r, s.comp.y - r, r*2, r*2);
      } else if (s.type === "via"){
        ctx.beginPath(); ctx.arc(s.via.x, s.via.y, (s.via.r||State.viaR) + 3/View.zoom, 0, Math.PI*2); ctx.stroke();
      } else if (s.type === "note"){
        ctx.beginPath(); ctx.arc(s.note.x, s.note.y, 10/View.zoom, 0, Math.PI*2); ctx.stroke();
      } else if (s.type === "trace"){
        const t = s.trace;
        ctx.beginPath(); ctx.moveTo(t.points[0].x, t.points[0].y);
        for (let i=1;i<t.points.length;i++) ctx.lineTo(t.points[i].x, t.points[i].y);
        ctx.lineWidth = (t.width||3) + 3/View.zoom; ctx.globalAlpha = 0.5; ctx.stroke();
        ctx.lineWidth = 2/View.zoom; ctx.globalAlpha = 0.95;
      }
    }
    ctx.restore();
  }
  const d = Tools.drag;
  if (d && d.kind === "box-select" && d.moved){
    ctx.save();
    ctx.strokeStyle = col; ctx.fillStyle = "rgba(57,208,255,0.10)";
    ctx.lineWidth = 1.2/View.zoom; ctx.setLineDash([5/View.zoom, 4/View.zoom]);
    const x = Math.min(d.sx,d.x), y = Math.min(d.sy,d.y), w = Math.abs(d.x-d.sx), h = Math.abs(d.y-d.sy);
    ctx.fillRect(x,y,w,h); ctx.strokeRect(x,y,w,h);
    ctx.restore();
  }
}

/* crop tool: dim everything outside the drag rectangle and draw its dashed border, so
   it's obvious what will be KEPT. Screen space, constant thickness. */
function drawCropOverlay(ctx){
  if (Tools.name !== "crop" || !Tools.cropA) return;
  const b = Tools.cropB || Tools.cursor; if (!b) return;
  const a = worldToScreen(Tools.cropA.x, Tools.cropA.y);
  const c = worldToScreen(b.x, b.y);
  const x = Math.min(a.x,c.x), y = Math.min(a.y,c.y), w = Math.abs(c.x-a.x), h = Math.abs(c.y-a.y);
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  ctx.fillStyle = "rgba(0,0,0,0.45)";                  // dim the discarded area
  ctx.beginPath();
  ctx.rect(0,0,View.width,View.height);
  ctx.rect(x,y,w,h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "#4fd0ff"; ctx.lineWidth = 1.5; ctx.setLineDash([6,4]);
  ctx.strokeRect(x,y,w,h);
  ctx.restore();
}

/* visual pad editor: draw the selected pad's oriented box with square corner handles
   (drag to resize) and a round centre handle (drag to move). Screen space so the handles
   stay a constant grabbable size at any zoom. */
function drawPadEditOverlay(ctx){
  const pe = Tools.padEdit;
  if (!pe || !pe.comp) return;
  if (!State.components.includes(pe.comp)){ Tools.padEdit = null; return; }
  const fp = compFootprint(pe.comp), fpin = fp && fp.pins[pe.idx];
  if (!fpin) return;
  const corners = padCornersWorld(pe.comp, fpin).map(c => worldToScreen(c.x, c.y));
  const cw = pinWorldPos(pe.comp, fpin);
  const ctr = worldToScreen(cw.x, cw.y);
  ctx.save();
  ctx.setTransform((View.dpr||1),0,0,(View.dpr||1),0,0);
  // box outline
  ctx.strokeStyle = "#4fd0ff"; ctx.lineWidth = 1.5;
  ctx.beginPath();
  corners.forEach((s,i)=> i ? ctx.lineTo(s.x,s.y) : ctx.moveTo(s.x,s.y));
  ctx.closePath(); ctx.stroke();
  // corner resize handles
  for (const s of corners){
    ctx.beginPath(); ctx.rect(s.x-4, s.y-4, 8, 8);
    ctx.fillStyle = "#0d1117"; ctx.fill();
    ctx.strokeStyle = "#4fd0ff"; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // centre move handle
  ctx.beginPath(); ctx.arc(ctr.x, ctr.y, 5, 0, Math.PI*2);
  ctx.fillStyle = "#ffb648"; ctx.fill();
  ctx.strokeStyle = "#0d1117"; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}

/* live readout for the Measure tool: distance plus, treating that distance as a trace
   width, the estimated current it could carry on the active copper side. Screen space so
   it stays a constant size and never covers the measured line. */
/* live px/mm span readout for the resize-XY reference line being dragged */
function drawResizeLabel(ctx){
  if (Tools.name !== "resizexy" || !Tools.resizeLine) return;
  const a = Tools.resizeLine.a, b = Tools.resizeLine.b;
  const horiz = Tools.resizeStep === 0;
  const spanPx = horiz ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
  if (spanPx < 2) return;
  const unit = UI.unit(), mm = spanPx / State.pxPerMm;
  const cur = unit === "mil" ? (mm/0.0254).toFixed(0) + " mil" : mm.toFixed(2) + " mm";
  const l1 = (horiz ? "WIDTH " : "HEIGHT ") + spanPx.toFixed(0) + " px";
  const l2 = "= " + cur + " at current scale";
  const mid = worldToScreen((a.x + b.x) / 2, (a.y + b.y) / 2);
  const col = horiz ? "#ffb648" : "#4fd07f";

  ctx.save();
  ctx.setTransform((View.dpr||1), 0, 0, (View.dpr||1), 0, 0);
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "top";
  const pad = 5, lh = 15;
  const bw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + pad*2;
  const bh = lh*2 + pad*2;
  let x = mid.x + 12, y = mid.y - bh/2;
  x = Math.min(Math.max(4, x), View.width - bw - 4);
  y = Math.min(Math.max(4, y), View.height - bh - 4);
  roundRect(ctx, x, y, bw, bh, 4);
  ctx.fillStyle = "rgba(20,24,30,.9)"; ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#e6ecf2"; ctx.fillText(l1, x + pad, y + pad);
  ctx.fillStyle = col; ctx.fillText(l2, x + pad, y + pad + lh);
  ctx.restore();
}

function drawMeasureLabel(ctx){
  if (Tools.name !== "measure" || !Tools.measureA || !Tools.cursor) return;
  const a = Tools.measureA, b = Tools.measureB || Tools.cursor;
  const dpx = Math.hypot(b.x - a.x, b.y - a.y);
  if (dpx < 2) return;
  const mm = dpx / State.pxPerMm;
  const unit = UI.unit();
  const distTxt = unit === "mil" ? (mm/0.0254).toFixed(0) + " mil" : mm.toFixed(2) + " mm";
  const est = UI.widthCurrentEst(mm);
  const l1 = distTxt;
  const l2 = "~" + est.aTxt + " A  ·  " + est.oz + " oz " + (est.internal ? "int" : "ext");
  const mid = worldToScreen((a.x + b.x) / 2, (a.y + b.y) / 2);

  ctx.save();
  ctx.setTransform((View.dpr||1), 0, 0, (View.dpr||1), 0, 0);
  ctx.font = "12px system-ui, sans-serif";
  ctx.textBaseline = "top";
  const pad = 5, lh = 15;
  const bw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + pad*2;
  const bh = lh*2 + pad*2;
  let x = mid.x + 12, y = mid.y - bh/2;
  x = Math.min(Math.max(4, x), View.width - bw - 4);
  y = Math.min(Math.max(4, y), View.height - bh - 4);
  roundRect(ctx, x, y, bw, bh, 4);
  ctx.fillStyle = "rgba(20,24,30,.9)"; ctx.fill();
  ctx.strokeStyle = "#ffb648"; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = "#ffe0b0"; ctx.fillText(l1, x + pad, y + pad);
  ctx.fillStyle = "#ffb648"; ctx.fillText(l2, x + pad, y + pad + lh);
  ctx.restore();
}
