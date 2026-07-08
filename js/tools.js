/* ===== tools.js — interaction tools & pointer state machine ===== */
"use strict";

const Tools = {
  name: "select",
  cursor: null,        // world pos of pointer
  snap: null,          // current snap target {x,y,attach,netId}
  // trace tool
  tracePts: null,
  traceSide: "front",
  traceStartSnap: null,
  // component tool
  ghostFp: null, ghostRot: 0, ghostSide: "front",
  pending: null,       // {fpId,fpParams,ref,value,part,kicad}
  // measure
  measureA: null, measureB: null,
  // align
  alignPts: null,      // 4 ref pts + 4 layer pts
  alignLayer: null,    // layer captured when 4-point align started (the one that moves)
  alignReturnId: null, // layer id to re-activate once a 4-point align finishes
  deskewPts: null,     // 2-line deskew clicks
  deskewLayer: null,
  // freestyle pin placement
  addPinFor: null,     // component receiving clicked pins
  // via net memory (reused for non-shift placements)
  lastViaNet: null,
  // last real copper side, used when drawing while the X-ray view is active
  lastCopperSide: "front",
  // drag state
  drag: null,
  dragVert: null,      // {trace,i} currently-dragged trace vertex (for render)
  padEdit: null,       // {comp,idx} pad being visually resized/moved (draws handles)
  // crop tool
  cropLayer: null,     // image layer being cropped
  cropA: null, cropB: null,   // world-space crop rectangle corners (during the drag)
};

const TOOL_HINTS = {
  select:    "Click to select · drag to move · R rotate · B flip side · Del delete · double-click pin to name net",
  component: "Click to place · R rotate · B side · Esc cancel · C reopens footprint dialog",
  trace:     "Click pins/points to route · Enter/double-click finish · Esc cancel · starts & ends snap to pads/vias",
  via:       "Click = via (reuses last net) · Shift-click = fresh via · Alt-click = PTH · double-click = layer span (blind/buried)",
  cut:       "Click on a trace to cut it in two — disconnected halves get separate nets",
  note:      "Click to drop a sticky note · type its text in the inspector · in Select, drag to move / double-click to edit",
  align:     "Drag active layer to move · Alt+wheel scale · Shift+drag rotate · “Align” button = 4-point skew-correcting fit",
  measure:   "Drag to measure a distance (px and mm)",
  calibrate: "Drag along a KNOWN distance, then enter its real length in mm",
  crop:      "Drag a box around the part of the image to KEEP · Esc to cancel",
  pan:       "Drag to pan",
};

function toolCursor(name){
  return { select:"default", component:"crosshair", trace:"crosshair", via:"crosshair",
           align:"crosshair", measure:"crosshair", calibrate:"crosshair", cut:"crosshair", note:"crosshair", crop:"crosshair", pan:"grab" }[name] || "default";
}

function setTool(name){
  // leaving cleanup
  if (Tools.name === "trace") cancelTrace();
  Tools.measureA = Tools.measureB = null;
  Tools.alignPts = null;
  Tools.alignLayer = null;
  Tools.alignReturnId = null;
  Tools.deskewPts = null;
  Tools.deskewLayer = null;
  Tools.addPinFor = null;
  Tools.padEdit = null;   // leave the visual pad editor when switching tools
  Tools.cropLayer = null; Tools.cropA = Tools.cropB = null;   // leave the crop tool
  Tools._edgeArmed = false;   // re-arm edge auto-scroll: must leave the margin before it kicks in
  if (name !== "component"){ Tools.ghostFp = null; Tools.pending = null; }
  if (name !== "select"){ View.hoverPin = null; View.cursorLabel = null; UI.setStatusPad(""); Tools._readout = ""; }   // pad/comp readout is select-mode only
  Tools.name = name;
  document.querySelectorAll("#toolbar .tool").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === name));
  View.canvas.style.cursor = toolCursor(name);
  UI.setStatusTool(name);
  UI.setHint(TOOL_HINTS[name] || "");
  if (name === "component" && !Tools.pending) UI.openFootprintDialog();
  requestRender();
}

/* ---------------- pointer routing ---------------- */
function onPointerDown(e){
  const pt = canvasPoint(e);
  updatePane(pt);
  const w = screenToWorld(pt.x, pt.y);
  Tools.cursor = w;
  Tools._edgeArmed = false;   // each new interaction must leave the margin before auto-scroll arms
  View.cursorLabel = null;    // hide the hover net-chip while interacting

  // middle button or space = pan, any tool
  if (e.button === 1 || Keys.space){
    Tools.drag = { kind:"pan", sx:pt.x, sy:pt.y, panX:View.panX, panY:View.panY };
    View.canvas.style.cursor = "grabbing";
    return;
  }
  if (e.button === 2) return; // context menu handled separately

  // freestyle pin placement overrides the active tool
  if (Tools.addPinFor){
    pushUndo();
    addFreePin(Tools.addPinFor, w);
    UI.refreshInspector(); requestRender();
    return;
  }

  switch (Tools.name){
    case "select":    return selectDown(w, pt, e);
    case "component": return componentDown(w, e);
    case "trace":     return traceDown(w, e);
    case "via":       return viaDown(w, e);
    case "align":     return alignDown(w, pt, e);
    case "measure":   return measureDown(w, e);
    case "calibrate": return measureDown(w, e);
    case "cut":       return cutDown(w, e);
    case "note":      return noteDown(w, e);
    case "crop":      return cropDown(w, e);
  }
}

/* status-bar text for whatever is under the cursor: a pad shows "ref.pin [name] · net",
   a component body shows "ref"; both append the part's [value · part] when set */
function hoverReadout(h){
  if (!h) return "";
  let c, head;
  if (h.type === "pin"){
    c = h.comp;
    const p = c.pins[h.pinIdx];
    const nm = (p.name && p.name !== p.num) ? " " + p.name : "";
    const net = p.nc ? "no-connect" : (p.netId ? (getNet(p.netId)?.name || "?") : "(no net)");
    head = c.ref + "." + p.num + nm + "  ·  " + net;
  } else if (h.type === "comp"){
    c = h.comp; head = c.ref;
  } else return "";
  const vp = [...new Set([c.value, c.part].filter(Boolean))].join(" · ");   // dedupe when value==part
  return head + (vp ? "   [" + vp + "]" : "");
}

function onPointerMove(e){
  const pt = canvasPoint(e);
  updatePane(pt);
  const w = screenToWorld(pt.x, pt.y);
  Tools.cursor = w;
  UI.setStatusPos(w);
  Tools._lastPt = pt; Tools._lastEvt = e;

  if (Tools.drag){
    handleDrag(pt, w, e);
    updateEdgeScroll(pt);   // auto-pan when a dragged object nears the viewport edge
    requestRender();
    return;
  }

  // ghost placement (component tool) follows the cursor with no drag object, but should
  // still auto-pan near the edges so you can drop a part off-screen
  updateEdgeScroll(pt);

  // snap preview for relevant tools
  if (Tools.name === "trace"){
    Tools.snap = snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
  } else if (Tools.name === "via"){
    Tools.snap = e.shiftKey ? null : snapToConductor(w.x, w.y, "any");   // Shift = free placement, no snap
  } else Tools.snap = null;

  // hover net / note highlight in select mode
  if (Tools.name === "select"){
    const h = hitTest(w.x, w.y);
    let net = null, note = null, pin = null, obj = null;
    if (h){
      if (h.type==="pin"){ net = h.comp.pins[h.pinIdx].netId; pin = { comp:h.comp, pinIdx:h.pinIdx }; }
      else if (h.type==="via"){ net = h.via.netId; obj = h.via; }
      else if (h.type==="trace"){ net = h.trace.netId; obj = h.trace; }
      else if (h.type==="note") note = h.note;
    }
    // track the hovered pad so the "star" ratsnest can hang off it on hover, not just click
    const pinChanged = (pin?.comp !== View.hoverPin?.comp) || (pin?.pinIdx !== View.hoverPin?.pinIdx);
    const objChanged = obj !== View.hoverObj;
    View.hoverPin = pin;
    View.hoverObj = obj;
    if (net !== View.hoverNetId){ View.hoverNetId = net; }
    if (note !== View.hoverNote){ View.hoverNote = note; requestRender(); }
    if (pinChanged && View.ratsnest && View.ratsnestMode === "star") requestRender();
    // the single-object / single-pad hover cue changes even when the net doesn't (moving
    // between two traces of the same net), so redraw on any hovered-object change too
    if (objChanged || pinChanged) requestRender();
    // discreet floating net-name label pinned next to the cursor (for a pad/via/trace).
    // Follows the pointer and shows the net colour as a small dot; replaces the old
    // bottom-bar readout so the info sits where the eye already is.
    let labelText = null, labelCol = null;
    if (h && (h.type==="pin" || h.type==="via" || h.type==="trace")){
      const nid = net, ncPin = h.type==="pin" && h.comp.pins[h.pinIdx].nc;
      labelText = ncPin ? "no-connect" : (nid ? (getNet(nid)?.name || "?") : "(no net)");
      labelCol  = nid ? netColor(nid) : null;
    }
    if (labelText){ View.cursorLabel = { text: labelText, color: labelCol, x: pt.x, y: pt.y }; requestRender(); }
    else if (View.cursorLabel){ View.cursorLabel = null; requestRender(); }
    View.canvas.style.cursor = h ? "pointer" : "default";
  }

  if (View.split || Tools.name==="trace" || Tools.name==="via" || Tools.name==="component" || Tools.name==="measure" || Tools.alignPts || Tools.deskewPts)
    requestRender();   // redraw every move so the ghost / snap-ring / mirror cursor tracks the pointer
  else if (View.hoverNetId !== Tools._lastHover){ Tools._lastHover = View.hoverNetId; requestRender(); }
}

function onPointerUp(e){
  if (!Tools.drag) return;
  stopEdgeScroll();
  const d = Tools.drag;
  Tools.drag = null;
  if (d.kind === "pan"){
    View.canvas.style.cursor = toolCursor(Tools.name); // restore the tool's cursor (e.g. crosshair for via)
  }
  if (d.kind === "move-note"){
    if (!d.moved) cancelUndo(); // a click (no drag) keeps undo clean; dblclick edits
    else Tools._dragEndedAt = Date.now();
    UI.refreshInspector();
  }
  if (d.kind === "move-comp" || d.kind === "move-via" || d.kind === "move-layer" || d.kind === "rot-layer" || d.kind === "move-vert"){
    if (!d.moved){
      cancelUndo(); // no-op drag, drop the snapshot (restores redo — a click mustn't wipe it)
      // a shift-click that never dragged a single-pad part falls back to pin multi-select
      if (d.shiftPin){ UI.togglePinSel(d.shiftPin.comp, d.shiftPin.pinIdx); requestRender(); }
      // an align-tool click that never dragged drops the next 4-point marker
      if (d.alignClick){ placeAlignMarker(d.alignClick.x, d.alignClick.y, d.alignClick.thumb); }
    }
    // a real drag must not also register as a double-click (which would delete a point
    // or pop open an editor/menu); flag it so the dblclick that may follow is ignored.
    if (d.moved){
      if (d.kind === "move-comp" || d.kind === "move-via"){
        Tools._dragEndedAt = Date.now();
      } else if (d.kind === "move-vert"){
        // only when it genuinely moved or snapped — a stationary double-click still removes the vertex
        const p = d.trace.points[d.i];
        if (d.snap || (p && Math.hypot(p.x-d.sx, p.y-d.sy) > 4/View.zoom)) Tools._dragEndedAt = Date.now();
      }
    }
    if (d.kind === "move-vert" && d.moved && d.snap && d.snap.attach) connectVertToSnap(d.trace, d.snap, d.i);
    Tools.dragVert = null;
    Tools.snap = null;
    UI.refreshInspector();
    if (d.kind === "move-comp" && d.moved){
      if (d.shiftPin) UI.select({type:"comp", comp:d.comp});   // detached shift-move: show it selected
      autoConnectPins(d.comp);          // pins moved onto copper pick up its net (fills empty pins only)
      checkMoveOverlaps(d.comp);        // then warn about any different-net pads now touching
    }
    if (d.kind === "move-via" && d.moved){
      // shift-detach: straighten the trace by dropping the anchor left behind, if it's now redundant
      if (d.detach) pruneCollinearAnchors(d.ox, d.oy);
      handleViaDrop(d.via);             // combine stacked vias + connect to landed copper (net prompts)
    }
  }
  if (d.kind === "pad-resize" || d.kind === "pad-move"){
    if (!d.moved) cancelUndo();                    // a click that didn't drag: keep undo clean
    else Tools._dragEndedAt = Date.now();          // don't let the drag double as a dblclick
    UI.refreshInspector();
  }
  if (d.kind === "measure"){
    finishMeasure();
  }
  if (d.kind === "crop-rect"){
    applyCrop();   // bakes the kept region; stays no-op & keeps undo clean if the box was tiny
  }
  requestRender();
}

function handleDrag(pt, w, e){
  const d = Tools.drag;
  switch (d.kind){
    case "pan":
      View.panX = d.panX + (pt.x - d.sx);
      View.panY = d.panY + (pt.y - d.sy);
      break;
    case "move-comp":
      d.moved = true;
      d.comp.x = w.x - d.offX; d.comp.y = w.y - d.offY;
      // drag connected trace anchors with the component, preserving relative position
      if (d.anchors) for (const a of d.anchors){ a.pts[a.i].x = d.comp.x + a.dx; a.pts[a.i].y = d.comp.y + a.dy; }
      break;
    case "move-via":
      d.moved = true;
      d.via.x = w.x - d.offX; d.via.y = w.y - d.offY; // keep the grab offset, like components
      // drag connected trace anchors with the via, preserving their relative position
      if (d.anchors) for (const a of d.anchors){ a.pts[a.i].x = d.via.x + a.dx; a.pts[a.i].y = d.via.y + a.dy; }
      break;
    case "move-vert": {
      d.moved = true;
      // DETACH is decided once, at the START of the drag (Shift held when you grab the
      // anchor): split the trace here ONE time so the anchor pulls free of its junction.
      if (d.detach && !d.detached){
        detachAnchor(d); d.detached = true;
        // after detaching, exclude ONLY the moving piece from snapping — so the freed
        // anchor can be re-snapped to the very trace it was detached from (or any other),
        // just not to its own segment
        d.excl = new Set([d.trace]);
      }
      // Snapping is suppressed only WHILE Shift is currently held. So: Shift-grab detaches
      // and pulls free without snapping; RELEASE Shift and the freed anchor snaps onto a
      // new pad/via/trace again (no need to drop and re-grab). A plain drag snaps normally
      // and a mid-drag Shift-hold lets you place freely.
      const noSnap = !!(e && e.shiftKey);
      // exclude our own trace AND any trace we're carrying, so the reach lands on a NEW conductor
      const snap = noSnap ? null : snapToConductor(w.x, w.y, d.trace.side, false, d.trace.width || 3, d.excl);
      d.snap = snap;
      Tools.snap = snap; // white ring indicator
      const nx = snap ? snap.x : w.x, ny = snap ? snap.y : w.y;
      d.trace.points[d.i].x = nx;
      d.trace.points[d.i].y = ny;
      // adhere: carry coincident junction vertices of other traces along
      if (d.linked) for (const L of d.linked){ L.pts[L.i].x = nx; L.pts[L.i].y = ny; }
      break;
    }
    case "move-note":
      d.moved = true;
      d.note.x = w.x - d.offX; d.note.y = w.y - d.offY;
      break;
    case "move-layer":
      // in the align procedure, ignore sub-4px jitter so a click stays a marker (not a nudge)
      if (d.alignClick && Math.hypot(w.x-d.wx, w.y-d.wy)*View.zoom < 4) break;
      d.moved = true;
      d.layer.tx = d.ltx + (w.x - d.wx);
      d.layer.ty = d.lty + (w.y - d.wy);
      UI.refreshLayerList();
      break;
    case "rot-layer": {
      d.moved = true;
      const a0 = Math.atan2(d.wy - d.layer.ty, d.wx - d.layer.tx);
      const a1 = Math.atan2(w.y - d.layer.ty, w.x - d.layer.tx);
      const delta = (a1 - a0) * (View.flip?-1:1);
      if (d.layer.warp){
        const ca = Math.cos(delta), sa = Math.sin(delta), W = d.lwarp0;
        d.layer.warp = { a: ca*W.a - sa*W.b, b: sa*W.a + ca*W.b,
                         c: ca*W.c - sa*W.d, d: sa*W.c + ca*W.d };
      } else {
        d.layer.rot = d.lrot + delta * 180/Math.PI;
      }
      UI.refreshLayerList();
      break;
    }
    case "pad-resize": {
      d.moved = true;
      const fp = compFootprint(d.comp), fpin = fp && fp.pins[d.idx];
      if (!fpin) break;
      const loc = compWorldToMm(d.comp, w.x, w.y);          // cursor in footprint mm
      if (fpin.shape === "circle"){
        const dia = Math.hypot(loc.x-fpin.xmm, loc.y-fpin.ymm) * 2;  // round pad stays square
        padSetSize(d.comp, d.idx, dia, dia);
      } else {
        // resize symmetrically about the pad centre so the pin position (and its traces) hold
        padSetSize(d.comp, d.idx, Math.abs(loc.x-fpin.xmm)*2, Math.abs(loc.y-fpin.ymm)*2);
      }
      break;
    }
    case "pad-move": {
      d.moved = true;
      const loc = compWorldToMm(d.comp, w.x, w.y);
      padSetPos(d.comp, d.idx, loc.x, loc.y);
      break;
    }
    case "measure":
      Tools.measureB = w;
      break;
    case "crop-rect":
      d.moved = true;
      Tools.cropB = { x:w.x, y:w.y };
      break;
  }
}

/* ---------- edge auto-scroll (drag / place near the viewport border → pan) ------
   Touchpad users can't easily pan mid-drag (no free hand for space+drag / middle
   drag). When a dragged object — or a component ghost being placed — nears an edge
   we pan the view toward it and keep it under the cursor, so you can move/drop it
   clear across a board that's larger than the screen. Only translation drags and
   component placement qualify (not view-pan / rotate / measure). */
const EDGE_SCROLL_KINDS = { "move-comp":1, "move-via":1, "move-vert":1, "move-note":1, "move-layer":1 };

/* true when the current interaction is one that should auto-pan near the edges:
   a translation drag, or the component tool tracking a ghost about to be placed.
   The whole feature can be switched off in Options (UI.edgeScrollOn). */
function edgeScrollAllowed(){
  if (!UI.edgeScrollOn()) return false;
  if (Tools.drag) return !!EDGE_SCROLL_KINDS[Tools.drag.kind];
  if (Tools.name === "component") return !!Tools.pending;   // ghost part about to drop
  if (Tools.name === "trace")     return !!Tools.tracePts;  // mid-route, rubber-band tracks cursor
  if (Tools.name === "via")       return true;              // via drops wherever the cursor lands
  return false;
}

/* true only while the pointer is actually inside the editor canvas — auto-pan must
   stop the moment the cursor leaves it (into a side panel or off the window) */
function ptInCanvas(pt){ return !!pt && pt.x >= 0 && pt.x <= View.width && pt.y >= 0 && pt.y <= View.height; }

function updateEdgeScroll(pt){
  if (!edgeScrollAllowed() || !ptInCanvas(pt)){ stopEdgeScroll(); return; }
  const m = UI.edgeMargin(), speed = UI.edgeSpeed(), W = View.width, H = View.height;
  // Don't start auto-panning until the pointer has first moved OUT of the edge margin.
  // Otherwise grabbing an object that already sits near the edge would scroll forever
  // with no intent to move — you have to leave the margin once to "arm" it.
  const inMargin = pt.x < m || pt.x > W - m || pt.y < m || pt.y > H - m;
  if (!Tools._edgeArmed){
    if (inMargin){ stopEdgeScroll(); return; }
    Tools._edgeArmed = true;
  }
  const clamp = t => t < 0 ? 0 : t > 1 ? 1 : t;   // pointer capture can report pts past the edge
  let vx = 0, vy = 0;
  if (pt.x < m)          vx =  clamp((m - pt.x) / m);
  else if (pt.x > W - m) vx = -clamp((pt.x - (W - m)) / m);
  if (pt.y < m)          vy =  clamp((m - pt.y) / m);
  else if (pt.y > H - m) vy = -clamp((pt.y - (H - m)) / m);
  if (!vx && !vy){ stopEdgeScroll(); return; }
  Tools._edgeVel = { x: vx * speed, y: vy * speed };
  if (!Tools._edgeRAF) Tools._edgeRAF = requestAnimationFrame(edgeScrollTick);
}

function edgeScrollTick(){
  Tools._edgeRAF = 0;
  const v = Tools._edgeVel, pt = Tools._lastPt;
  if (!edgeScrollAllowed() || !v || !pt || !ptInCanvas(pt)) return;
  View.panX += v.x; View.panY += v.y;
  // re-drive from the last cursor screen point: as the board scrolls under a stationary
  // finger, the object (or ghost) keeps tracking the pointer and moves along with it
  const w = screenToWorld(pt.x, pt.y);
  Tools.cursor = w;
  if (Tools.drag) handleDrag(pt, w, Tools._lastEvt);   // ghost needs only the updated cursor
  else if (Tools.name === "trace") Tools.snap = snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
  else if (Tools.name === "via")   Tools.snap = (Tools._lastEvt && Tools._lastEvt.shiftKey) ? null : snapToConductor(w.x, w.y, "any");
  UI.setStatusPos(w);
  requestRender();
  Tools._edgeRAF = requestAnimationFrame(edgeScrollTick);
}

function stopEdgeScroll(){
  if (Tools._edgeRAF){ cancelAnimationFrame(Tools._edgeRAF); Tools._edgeRAF = 0; }
  Tools._edgeVel = null;
}

/* ---------------- select tool ---------------- */
function selectDown(w, pt, e){
  // visual pad editor active → grab a resize corner or the move centre first
  if (Tools.padEdit && State.components.includes(Tools.padEdit.comp)){
    const pe = Tools.padEdit, fp = compFootprint(pe.comp), fpin = fp && fp.pins[pe.idx];
    if (fpin){
      const hr = 9/View.zoom;
      const ctr = pinWorldPos(pe.comp, fpin);
      if (Math.hypot(w.x-ctr.x, w.y-ctr.y) <= hr){
        pushUndo("move pad"); Tools.drag = { kind:"pad-move", comp:pe.comp, idx:pe.idx, moved:false };
        requestRender(); return;
      }
      for (const cn of padCornersWorld(pe.comp, fpin)){
        if (Math.hypot(w.x-cn.x, w.y-cn.y) <= hr){
          pushUndo("resize pad"); Tools.drag = { kind:"pad-resize", comp:pe.comp, idx:pe.idx, moved:false };
          requestRender(); return;
        }
      }
    }
    // clicked away from the handles → leave pad-edit mode, then fall through to a normal click
    Tools.padEdit = null; requestRender();
  }
  // dragging a vertex handle of the already-selected trace
  if (UI.sel && UI.sel.type === "trace" && traceVisible(UI.sel.trace)){
    const t = UI.sel.trace, hr = 7/View.zoom;
    for (let i=0;i<t.points.length;i++){
      if (Math.hypot(w.x-t.points[i].x, w.y-t.points[i].y) <= hr){
        pushUndo("move trace point");
        // grab coincident junction vertices on OTHER traces so the connection holds
        // (adheres) when this anchor is moved again
        const px = t.points[i].x, py = t.points[i].y, jtol = Math.max((t.width||3)*0.6, 2/View.zoom);
        const linked = [];
        for (const ot of State.traces){
          if (ot === t) continue;
          for (let j=0;j<ot.points.length;j++)
            if (Math.hypot(ot.points[j].x-px, ot.points[j].y-py) <= jtol) linked.push({ pts:ot.points, i:j, trace:ot });
        }
        const excl = new Set([t]); linked.forEach(L => excl.add(L.trace));
        // Shift held AT THE START of the drag = detach mode for the whole drag
        Tools.drag = { kind:"move-vert", trace:t, i, moved:false, sx:px, sy:py, linked, excl, detach: !!(e && e.shiftKey) };
        Tools.dragVert = { trace:t, i };
        requestRender();
        return;
      }
    }
  }
  const h = hitTest(w.x, w.y);
  // shift-click pins → multi-select for bulk net assignment.
  // BUT for a single-pad part (test point / mounting hole) a shift-DRAG detaches it from
  // any trace anchored to it — start a detached move now; if it turns out to be a click
  // with no drag, onPointerUp falls back to the multi-select toggle instead.
  if (e.shiftKey && h && h.type === "pin"){
    const c = h.comp;
    if (!compMoveLocked(c)){
      pushUndo();
      Tools.drag = { kind:"move-comp", comp:c, offX:w.x-c.x, offY:w.y-c.y, moved:false,
                     anchors:[], detach:true, shiftPin:{comp:c, pinIdx:h.pinIdx} };
      requestRender();
      return;
    }
    UI.togglePinSel(c, h.pinIdx);
    requestRender();
    return;
  }
  // shift-click a trace → select every trace on its net
  if (e.shiftKey && h && h.type === "trace"){
    UI.selectNetTraces(h.trace.netId);
    requestRender();
    return;
  }
  // ctrl-click a trace → add/remove this segment from a multi-trace selection
  if ((e.ctrlKey || e.metaKey) && h && h.type === "trace"){
    UI.toggleTraceSel(h.trace);
    requestRender();
    return;
  }
  UI.select(h);
  if (!h){ requestRender(); return; }
  if (h.type === "comp" || h.type === "pin"){
    const c = h.comp;
    if (compMoveLocked(c)){ UI.setHint(c.ref + " is move-locked — press " + Keymap.keyFor("edit.lock") + " to unlock"); requestRender(); return; }
    pushUndo();
    // grab every trace vertex sitting on one of this component's pads so connected
    // anchors translate along with the component, preserving their relative position.
    // Shift-drag detaches: skip the anchors so the trace stays put.
    const detach = !!(e && e.shiftKey);
    const anchors = [];
    if (!detach){
      const fp = compFootprint(c);
      const ctol = 6 / View.zoom;
      // an SMD pad only touches copper on ITS OWN side, so it must never grab (and drag)
      // a trace on another layer; only a through-hole pad reaches every side
      const reachesAll = (fpin) => fpin.shape === "circle" && fpin.tht !== false;
      for (let pi=0; pi<fp.pins.length; pi++){
        const fpin = fp.pins[pi]; if (!fpin) continue;
        const pinNet = c.pins[pi] ? c.pins[pi].netId : null;
        for (const t of State.traces){
          if (!(reachesAll(fpin) || t.side === c.side)) continue;
          if (t.netId !== pinNet) continue;   // a pad on a DIFFERENT net doesn't drag the trace (e.g. after clear / "ignore")
          for (let i=0;i<t.points.length;i++)
            if (pinEdgeDist(c, fpin, t.points[i].x, t.points[i].y) <= ctol)
              anchors.push({ pts:t.points, i, dx:t.points[i].x-c.x, dy:t.points[i].y-c.y });
        }
      }
    }
    Tools.drag = { kind:"move-comp", comp:c, offX:w.x-c.x, offY:w.y-c.y, moved:false, anchors, detach };
  } else if (h.type === "via"){
    pushUndo();
    // grab every trace vertex sitting on the via so connected anchors move along with it;
    // Shift-drag detaches (leaves the trace behind)
    const detach = !!(e && e.shiftKey);
    const anchors = [];
    if (!detach){
      const vtol = Math.max(h.via.r || 5, 6/View.zoom);
      for (const t of State.traces){
        if (t.netId !== h.via.netId) continue;   // a via on a DIFFERENT net doesn't drag the trace (e.g. after clear / "ignore")
        for (let i=0;i<t.points.length;i++)
          if (Math.hypot(t.points[i].x-h.via.x, t.points[i].y-h.via.y) <= vtol)
            anchors.push({ pts:t.points, i, dx:t.points[i].x-h.via.x, dy:t.points[i].y-h.via.y });
      }
    }
    Tools.drag = { kind:"move-via", via:h.via, offX:w.x-h.via.x, offY:w.y-h.via.y, moved:false, anchors, detach, ox:h.via.x, oy:h.via.y };
  } else if (h.type === "note"){
    pushUndo("move note");
    Tools.drag = { kind:"move-note", note:h.note, offX:w.x-h.note.x, offY:w.y-h.note.y, moved:false };
  }
  requestRender();
}

function onDoubleClick(e){
  const pt = canvasPoint(e);
  const w = screenToWorld(pt.x, pt.y);
  if (Tools.name === "trace"){ finishTrace(); return; }
  if (Tools.name === "select"){
    // ignore a dblclick that immediately follows a drag-drop, so dropping something never
    // doubles as a "remove this point" / "open editor" double-click
    if (Tools._dragEndedAt && (Date.now() - Tools._dragEndedAt < 250)){ Tools._dragEndedAt = 0; return; }
    Tools._dragEndedAt = 0;
    // a pad / via / component under the cursor wins over trace editing, so double-clicking
    // a pad opens its settings even when a trace runs beneath it
    const h = hitTest(w.x, w.y);
    if (h && h.type==="via"){
      UI.select(h);
      if (e.shiftKey) UI.openViaSpanEditor(h.via);   // Shift+double-click → blind/buried layer span
      else            promptNetName(h);              // double-click → set net
      return;
    }
    if (h && h.type==="pin"){ promptNetName(h); return; }
    if (h && h.type==="note"){ UI.select(h); UI.focusNoteText(); return; } // edit note text
    if (h && h.type==="comp"){ UI.select(h); UI.openQuickEdit(h.comp); return; } // quick ref + value editor
    // otherwise edit the trace under the cursor: on a vertex → remove it, on a segment → add a corner
    editTraceVertex(w);
  }
}

/* double-click trace editing.
   · on an existing vertex → remove it. Interior vertices straighten the trace
     between their neighbours; an endpoint just drops that end segment.
   · on a segment (away from any vertex) → insert a new draggable corner there.
   Returns true if it handled the double-click. */
function editTraceVertex(w){
  // 1) nearest existing vertex within a small radius → remove
  const vr = 8/View.zoom;
  let bv = null, bvd = vr;
  for (let ti=State.traces.length-1; ti>=0; ti--){
    const t = State.traces[ti];
    if (!traceVisible(t)) continue;
    for (let i=0;i<t.points.length;i++){
      const d = Math.hypot(w.x-t.points[i].x, w.y-t.points[i].y);
      if (d <= bvd){ bvd = d; bv = { trace:t, i }; }
    }
  }
  if (bv){ removeTraceVertex(bv.trace, bv.i); return true; }

  // 2) nearest segment within the trace's width → insert a corner
  let bs = null, bsd = Infinity;
  for (let ti=State.traces.length-1; ti>=0; ti--){
    const t = State.traces[ti];
    if (!traceVisible(t)) continue;
    const tol = (t.width||3)/2 + 6/View.zoom;
    for (let k=0;k<t.points.length-1;k++){
      const pr = projectOnSeg(w.x, w.y, t.points[k], t.points[k+1]);
      if (pr.d <= tol && pr.d < bsd){ bsd = pr.d; bs = { trace:t, k, x:pr.x, y:pr.y }; }
    }
  }
  if (bs){ insertTraceVertex(bs.trace, bs.k, bs.x, bs.y); return true; }
  return false;
}

function insertTraceVertex(t, k, x, y){
  pushUndo("add trace point");
  t.points.splice(k+1, 0, { x, y });
  UI.select({ type:"trace", trace:t }); // show the vertex handles so the new corner can be dragged
  markDirty();
  UI.refreshInspector();
  requestRender();
}

function removeTraceVertex(t, i){
  pushUndo("remove trace point");
  if (t.points.length <= 2){
    // a trace needs at least two points; dropping one here leaves nothing useful
    State.traces = State.traces.filter(x => x !== t);
    UI.select(null);
  } else {
    t.points.splice(i, 1); // interior → straightens between neighbours; endpoint → shortens by one segment
    UI.select({ type:"trace", trace:t });
  }
  pruneNets();
  markDirty();
  UI.refreshNets(); UI.refreshInspector();
  requestRender();
}

/* the netId currently on a pad/via/trace hit-object */
function objNetId(obj){
  return obj.type==="pin" ? obj.comp.pins[obj.pinIdx].netId :
         obj.type==="via" ? obj.via.netId : obj.trace.netId;
}

/* Assign `name` to a pad/via/trace.
   · name === ""  → detach just this object from its net.
   · scope "one"  → move ONLY this object onto `name`; the rest of the old net stays put.
   · scope "all"  → rename the whole current net (every pad/via/trace on it). Also the
                    natural path when the net has a single member.
   Returns false when blocked by net protection. */
function assignNetToObject(obj, name, scope){
  name = (name || "").trim();
  scope = scope || "all";
  const setId = (id) => {
    if (obj.type==="pin") obj.comp.pins[obj.pinIdx].netId = id;
    else if (obj.type==="via") obj.via.netId = id;
    else obj.trace.netId = id;
  };
  const oldId = objNetId(obj);

  if (!name){ // clearing: detach just this object
    if (oldId){
      const old = getNet(oldId);
      if (old && old.protected && netMembers(oldId).length > 1 && obj.type !== "pin"){
        UI.toast(old.name + " is protected"); return false;
      }
      setId(null);
      pruneNets();
    }
    return true;
  }

  const target = () => findNetByName(name) || findNetByName(name.toUpperCase()) || createNet(name);

  if (oldId){
    const old = getNet(oldId);
    if (old && old.name === name) return true;             // no-op
    if (scope === "one" && netMembers(oldId).length > 1){
      setId(target().id);                                  // peel just this object off
      pruneNets();
      return true;
    }
    if (!renameNet(oldId, name)){                          // rename (and possibly merge) the whole net
      UI.toast("Could not rename — protected net"); return false;
    }
    return true;
  }

  setId(target().id);                                      // had no net
  pruneNets();
  return true;
}

/* Assign the target net to just the physically-connected cluster around `obj` (or clear it
   when name is empty). scope "connected" — the electrical node, not the whole named net. */
function assignNetToConnected(obj, name){
  const net = name ? (findNetByName(name) || findNetByName(name.toUpperCase()) || createNet(name)) : null;
  const nid = net ? net.id : null;
  const { traces, vias, pads } = connectedCluster(obj);
  for (const t of traces) t.netId = nid;
  for (const v of vias)   v.netId = nid;
  for (const { comp, pinIdx } of pads) comp.pins[pinIdx].netId = nid;
  pruneNets();
}

/* Apply a typed net name to a pad/via/trace, asking HOW FAR the change should reach when
   there is more than one candidate: the whole named net (all), only the physically
   connected node (connected), or just this one object (one). Handles undo + refresh. */
function applyNetRename(obj, name, done){
  name = (name || "").trim();
  const oldId = objNetId(obj);
  const old = oldId ? getNet(oldId) : null;
  const members = oldId ? netMembers(oldId).length : 0;
  const cl = connectedCluster(obj);
  const connCount = cl.traces.size + cl.vias.size + cl.pads.length;
  const finish = () => {
    if (obj.type === "via" && name) Tools.lastViaNet = name;  // remember for the next via
    UI.refreshNets(); UI.refreshInspector(); requestRender();
    done && done();
  };
  const applyScope = (scope) => {
    pushUndo(name ? (scope==="all"?"rename net":scope==="connected"?"net connected":"split net")
                  : (scope==="all"?"clear whole net":scope==="connected"?"clear connected":"clear net"));
    if (scope === "connected"){
      assignNetToConnected(obj, name);
    } else if (!name && scope === "all"){                 // clear EVERY object on the current net
      if (oldId){
        for (const c of State.components) for (const p of c.pins) if (p.netId === oldId) p.netId = null;
        for (const v of State.vias)   if (v.netId === oldId) v.netId = null;
        for (const t of State.traces) if (t.netId === oldId) t.netId = null;
        pruneNets();
      }
    } else if (!assignNetToObject(obj, name, scope)){
      Undo.stack.pop();
    }
    finish();
  };
  if (!name && !old){ done && done(); return; }           // nothing to clear
  // unambiguous: unchanged name, or nothing else on the net AND nothing connected
  if ((old && old.name === name) || (members <= 1 && connCount <= 1)){
    applyScope("all");   // lone/absent net → just this object (clear or set)
    return;
  }
  // more than one candidate — ask how far the change should reach (all / connected / this)
  UI.openNetScopeDialog(old ? old.name : "(none)", name, members, connCount, (scope) => {
    if (!scope){ done && done(); return; }   // cancelled — nothing changes
    applyScope(scope);
  });
}

function promptNetName(h){
  const netId = objNetId(h);
  const cur = netId ? (getNet(netId)?.name || "") : "";
  const label = h.type==="via" ? "Via net" : h.type==="trace" ? "Trace net" :
                (h.comp.ref + "." + h.comp.pins[h.pinIdx].num + " net");
  UI.openNetPopup(label, cur, (name) => applyNetRename(h, name));
}

/* duplicate the selected component with the next free reference */
function duplicateSelection(){
  const c = UI.sel && UI.sel.comp;
  if (!c) return;
  pushUndo("duplicate " + c.ref);
  const prefix = (/^([A-Za-z]+)/.exec(c.ref) || [,"U"])[1];
  const ref = nextRef(prefix);
  registerRef(ref);
  const copy = JSON.parse(JSON.stringify({...c, _fp:undefined}));
  copy.id = nextId(); copy.ref = ref;
  copy.x += 30/View.zoom; copy.y += 30/View.zoom;
  copy.pins.forEach(p => p.netId = null);
  copy.lockMove = copy.lockEdit = false; delete copy.locked;
  delete copy._fp;
  State.components.push(copy);
  UI.select({type:"comp", comp:copy});
  UI.toast("Duplicated → " + ref);
  requestRender();
}

/* after a component move ends: warn when a pad now overlaps copper of another net */
function checkMoveOverlaps(comp){
  if (!State.overlapCheck) return;
  const fp = compFootprint(comp);
  const s = State.pxPerMm * (comp.scale||1);
  const conflicts = [];
  const seenPairs = new Set();
  const thru = (pin) => pin.shape === "circle" && pin.tht !== false; // THT pads reach every copper side (round SMD pads don't)
  for (let pi=0; pi<comp.pins.length; pi++){
    const myNet = comp.pins[pi].netId;
    if (!myNet) continue;
    const fpin = fp.pins[pi]; if (!fpin) continue;
    const wp = pinWorldPos(comp, fpin);
    const myDiag = Math.hypot(fpin.w, fpin.h)*s/2;   // circumradius, for the cheap broad reject
    const myThru = thru(fpin);
    const hitNet = (otherNet, label) => {
      if (!otherNet || otherNet === myNet) return;
      const key = Math.min(myNet,otherNet)+"-"+Math.max(myNet,otherNet);
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      conflicts.push({ a:myNet, b:otherNet, pos:{x:wp.x, y:wp.y},
        text: comp.ref + "." + comp.pins[pi].num + " (" + (getNet(myNet)?.name||"?") + ")  ⟂  " + label + " (" + (getNet(otherNet)?.name||"?") + ")" });
    };
    for (const o of State.components){
      if (o === comp) continue;
      const ofp = compFootprint(o);
      const os = State.pxPerMm * (o.scale||1);
      for (let oi=0; oi<o.pins.length; oi++){
        const opin = ofp.pins[oi]; if (!opin) continue;
        // copper only touches if they share a side, or either pad is through-hole
        if (!(myThru || thru(opin) || o.side === comp.side)) continue;
        const op = pinWorldPos(o, opin);
        // cheap circumradius reject, then the REAL rectangle overlap (so tall thin pads
        // don't falsely "reach" sideways into their neighbours)
        if (Math.hypot(wp.x-op.x, wp.y-op.y) > myDiag + Math.hypot(opin.w,opin.h)*os/2) continue;
        if (padsOverlap(comp, fpin, o, opin, 1))
          hitNet(o.pins[oi].netId, o.ref + "." + o.pins[oi].num);
      }
    }
    for (const v of State.vias)
      if (pinEdgeDist(comp, fpin, v.x, v.y) <= (v.r||5) + 1) hitNet(v.netId, "via");
    for (const t of State.traces){
      // a trace is copper on a single side — ignore unless the pad reaches that side
      if (!(myThru || t.side === comp.side)) continue;
      for (let k=0;k<t.points.length-1;k++){
        if (padHitsSeg(comp, fpin, t.points[k], t.points[k+1], (t.width||3)/2, 0.5)){ hitNet(t.netId, "trace"); break; }
      }
    }
  }
  View.overlapMarks = conflicts.length ? conflicts.map(c => c.pos) : null;
  if (conflicts.length){ requestRender(); UI.openOverlapDialog(conflicts); }
}

/* ---------------- checker ---------------- */
/* a representative world point where two traces make contact (for the "Go" marker) */
function traceContactPoint(a, b){
  let best = null, bd = Infinity;
  const scan = (pts, other) => {
    for (const p of pts)
      for (let k=0; k<other.length-1; k++){
        const pr = projectOnSeg(p.x, p.y, other[k], other[k+1]);
        if (pr.d < bd){ bd = pr.d; best = { x:(p.x+pr.x)/2, y:(p.y+pr.y)/2 }; }
      }
  };
  scan(a.points, b.points);
  scan(b.points, a.points);
  return best || a.points[0];
}

/* returns { unnetted, mismatches, shorts } where shorts = same-side trace pairs that
   physically touch but belong to DIFFERENT nets (a short — e.g. from a bad import) */
/* axis-aligned bounds of a trace, grown by its half width (its copper extent) */
function traceBBox(t){
  let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
  for (const p of t.points){
    if (p.x<minX) minX=p.x; if (p.x>maxX) maxX=p.x;
    if (p.y<minY) minY=p.y; if (p.y>maxY) maxY=p.y;
  }
  const h = (t.width||3)/2;
  return { minX:minX-h, minY:minY-h, maxX:maxX+h, maxY:maxY+h };
}
function bboxOverlap(a, b){
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function runChecker(){
  const unnetted = [];
  const mismatches = [];
  const shorts = [];
  // precompute each trace's copper bounds once, so the O(n²) short scan can reject
  // far-apart pairs with a cheap box test before the per-vertex geometry in tracesOverlap
  const bboxes = State.traces.map(traceBBox);
  // trace-to-trace shorts: two same-side traces of different nets that touch
  for (let i=0; i<State.traces.length; i++){
    const a = State.traces[i];
    if (!a.netId) continue;
    for (let j=i+1; j<State.traces.length; j++){
      const b = State.traces[j];
      if (!b.netId || b.netId === a.netId || a.side !== b.side) continue;
      if (!bboxOverlap(bboxes[i], bboxes[j])) continue;   // quick reject
      if (tracesOverlap(a, b)) shorts.push({ a, b, pos: traceContactPoint(a, b) });
    }
  }
  // via-to-trace shorts: a via whose copper (full radius, ring included — not just its
  // hole) overlaps a trace on a side it reaches, but carries a DIFFERENT net. This is the
  // via-side mirror of the pad/trace mismatch check below, so a trace dragged onto a via's
  // ring is flagged even when no vertex snapped to its centre.
  for (const v of State.vias){
    if (!v.netId) continue;
    for (const t of State.traces){
      if (!t.netId || t.netId === v.netId) continue;
      if (viaTouchesTrace(v, t)) shorts.push({ a: t, b: v, pos: { x:v.x, y:v.y } });
    }
  }
  for (const c of State.components){
    const fp = compFootprint(c);
    const s = State.pxPerMm * (c.scale||1);
    for (let pi=0; pi<c.pins.length; pi++){
      const p = c.pins[pi];
      if (p.nc) continue;                       // explicitly no-connect → excluded
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const wp = pinWorldPos(c, fpin);
      if (!p.netId){ unnetted.push({ comp:c, pinIdx:pi, wp }); continue; }
      // does a trace physically touch this pad but carry a different net?
      const tht = fpin.shape === "circle" && fpin.tht !== false; // only through-hole pads reach other sides
      const padHalf = Math.max(fpin.w, fpin.h) * s / 2;  // pad reach for the bbox reject
      for (let ti=0; ti<State.traces.length; ti++){
        const t = State.traces[ti];
        if (t.netId === p.netId || !t.netId) continue;
        if (!(tht || t.side === c.side)) continue; // SMD pad ignores traces on other sides (e.g. copper below it)
        const bb = bboxes[ti]; // bbox already includes the trace half width
        if (wp.x < bb.minX - padHalf || wp.x > bb.maxX + padHalf ||
            wp.y < bb.minY - padHalf || wp.y > bb.maxY + padHalf) continue; // quick reject
        let touch = false;
        for (let k=0;k<t.points.length-1;k++){
          if (padHitsSeg(c, fpin, t.points[k], t.points[k+1], (t.width||3)/2, 0.5)){ touch = true; break; }
        }
        if (touch){ mismatches.push({ comp:c, pinIdx:pi, pinNet:p.netId, traceNet:t.netId, trace:t }); break; }
      }
    }
  }
  return { unnetted, mismatches, shorts };
}

/* When a part lands on existing copper, adopt the net of whatever conductor each still-
   unconnected pin sits on — the same "pick up the net" the via tool does. This is what
   makes a plated mounting hole / test point placed over a trace inherit that trace's net.
   Only fills pins that currently have NO net (and aren't no-connect), so it never
   overwrites an existing assignment or silently merges nets. A through-hole pad (round
   with a drill, incl. plated mounting holes) reaches every side; an SMD land only sees
   copper on its own side. Returns true if any pin was connected. */
function autoConnectPins(comp){
  const fp = compFootprint(comp);
  const thru = (pin) => pin.shape === "circle" && pin.tht !== false;
  let changed = false;
  for (let pi=0; pi<comp.pins.length; pi++){
    const st = comp.pins[pi];
    if (st.netId || st.nc) continue;                 // keep existing / no-connect pins
    const fpin = fp.pins[pi]; if (!fpin) continue;
    const myThru = thru(fpin);
    let net = null;
    for (const v of State.vias){                     // a via / PTH under the pad
      if (v.netId && pinEdgeDist(comp, fpin, v.x, v.y) <= (v.r||5) + 1){ net = v.netId; break; }
    }
    if (!net) for (const t of State.traces){          // a trace passing under the pad
      if (!t.netId) continue;
      if (!(myThru || t.side === comp.side)) continue; // SMD land ignores other-side copper
      for (let k=0;k<t.points.length-1;k++){
        if (padHitsSeg(comp, fpin, t.points[k], t.points[k+1], (t.width||3)/2, 0.5)){ net = t.netId; break; }
      }
      if (net) break;
    }
    if (net){ st.netId = net; changed = true; }
  }
  return changed;
}

/* traces currently welded to a via (a vertex sitting on it) */
function viaAttachedTraces(via){
  const out = [], vtol = Math.max(via.r || State.viaR, 6/View.zoom);
  for (const t of State.traces)
    for (let i=0;i<t.points.length;i++)
      if (Math.hypot(t.points[i].x-via.x, t.points[i].y-via.y) <= vtol){ out.push(t); break; }
  return out;
}

/* When a via sits on top of a trace SEGMENT (not already on one of its vertices), split the
   segment at the via centre so the trace gains an anchor there and moves with the via after. */
function anchorTracesUnderVia(via){
  const r = via.r || State.viaR, vtol = Math.max(r, 6/View.zoom);
  for (const t of State.traces){
    if (!viaOnSide(via, t.side)) continue;
    let onVertex = false;
    for (const p of t.points) if (Math.hypot(p.x-via.x, p.y-via.y) <= vtol){ onVertex = true; break; }
    if (onVertex) continue;                                  // already anchored to a vertex here
    const reach = r + (t.width||State.traceW)/2;
    let bk = -1, bd = Infinity;
    for (let k=0;k<t.points.length-1;k++){
      const d = distToSeg(via.x, via.y, t.points[k], t.points[k+1]);
      if (d <= reach && d < bd){ bd = d; bk = k; }
    }
    if (bk >= 0) t.points.splice(bk+1, 0, { x: via.x, y: via.y });  // coincident vertex = anchor
  }
}

/* Remove a now-redundant trace vertex left where a via was shift-detached: an interior vertex
   near (x,y) whose two segments are nearly collinear (parallel enough) is dropped to straighten
   the trace — so detaching an unmoved via undoes the anchor it added. */
function pruneCollinearAnchors(x, y){
  const tol = Math.max(6/View.zoom, State.viaR);
  for (const t of State.traces){
    for (let i=t.points.length-2; i>=1; i--){                // interior vertices only
      const p = t.points[i];
      if (Math.hypot(p.x-x, p.y-y) > tol) continue;
      const a = t.points[i-1], b = t.points[i+1];
      const v1x = p.x-a.x, v1y = p.y-a.y, v2x = b.x-p.x, v2y = b.y-p.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (!l1 || !l2){ t.points.splice(i, 1); continue; }     // zero-length step → redundant
      if (Math.abs(v1x*v2y - v1y*v2x)/(l1*l2) < 0.12) t.points.splice(i, 1);  // ~7° → straight enough
    }
  }
}

/* net of a pad or (non-attached) trace whose copper the via now overlaps — the net the via
   just landed on. Ignores the via's own attached traces. Returns a netId or null. */
function viaLandedNet(via, attached){
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const thru = fpin.shape === "circle" && fpin.tht !== false;
      if (!thru && !viaOnSide(via, c.side)) continue;                // via must reach the pad's side
      if (c.pins[pi].netId && pinEdgeDist(c, fpin, via.x, via.y) <= (via.r||State.viaR)+1) return c.pins[pi].netId;
    }
  }
  for (const t of State.traces){
    if (!t.netId || attached.includes(t) || !viaOnSide(via, t.side)) continue;
    const reach = (via.r||State.viaR) + (t.width||State.traceW)/2;
    for (let k=0;k<t.points.length-1;k++)
      if (distToSeg(via.x, via.y, t.points[k], t.points[k+1]) <= reach) return t.netId;
  }
  return null;
}

/* first via (other than `via`) whose copper overlaps `via` */
function firstViaOverlap(via){
  for (const o of State.vias){
    if (o === via) continue;
    const rr = Math.max(via.r||State.viaR, o.r||State.viaR);
    if (Math.hypot(o.x-via.x, o.y-via.y) <= rr*0.9) return o;
  }
  return null;
}
/* fold via `other` into `via`: pull its coincident trace anchors onto `via`, then drop it */
function foldViaInto(via, other){
  const vtol = Math.max(other.r||State.viaR, 6/View.zoom);
  for (const t of State.traces)
    for (let i=0;i<t.points.length;i++)
      if (Math.hypot(t.points[i].x-other.x, t.points[i].y-other.y) <= vtol){ t.points[i].x = via.x; t.points[i].y = via.y; }
  State.vias = State.vias.filter(v => v !== other);
}

/* prompt A→B / B→A / Undo for joining two different nets (A=aId, B=bId), then apply.
   cb(survivingNetId, blocked): blocked=true when BOTH nets are protected so the merge was
   refused (a warning is already toasted, and the nets stay separate — the caller must NOT
   claim a merge happened). cb(null,false) on Undo/dismiss. No "Ignore" — via joins are
   physical. */
function promptNetMerge(aId, bId, msg, cb){
  const aName = getNet(aId)?.name || "?", bName = getNet(bId)?.name || "?";
  UI.openNetMergeDialog(aName, bName, (choice) => {
    if (choice === "toB" || choice === "toA"){
      const keep = choice === "toB" ? bId : aId, drop = choice === "toB" ? aId : bId;
      const survived = mergeNets(keep, drop);           // null only if BOTH protected
      if (survived === null){
        UI.toast("⚠ " + aName + " / " + bName + " are protected — NOT merged");
        cb(null, true);
      } else cb(survived, false);
    } else cb(null, false);                              // undo / dismissed
  }, { ignore:false, msg });
}

/* After a via move ends: fold any stacked vias into it, then wire the via to whatever copper
   it now sits on. Unnetted via silently adopts the net. Different nets prompt A→B/B→A/Undo
   (vias that combine, or a via whose traces meet a different net); a bare netted via with no
   traces just asks Undo/Overwrite. The pre-move snapshot is on the undo stack, so Undo
   reverts the whole move + any combine. Async because the choices are modal. */
function handleViaDrop(via){
  let folded = 0;
  const refresh = () => { pruneNets(); UI.refreshNets(); UI.refreshInspector(); requestRender(); };
  const revert  = () => { undo(); UI.select(null); UI.refreshNets(); UI.refreshInspector(); requestRender(); UI.toast("Move undone"); };

  // Phase 2 — reconcile the via's net with EVERY net it now physically joins: its own, any
  // trace anchored to it (anchorTracesUnderVia may have just anchored the trace it landed on),
  // and any pad/trace it overlaps. One net → adopt it; several distinct nets → prompt A→B/B→A.
  const connectPhase = () => {
    const attached = viaAttachedTraces(via);
    const landed = viaLandedNet(via, attached);
    const nets = [];
    const addNet = (id) => { if (id && !nets.includes(id)) nets.push(id); };
    addNet(via.netId);
    for (const t of attached) addNet(t.netId);   // a trace sitting on the via shares its copper
    addNet(landed);                              // a pad/trace the via overlaps but isn't anchored to

    if (!nets.length){ refresh(); if (folded) UI.toast("Vias combined"); return; }

    if (nets.length === 1){                      // one net everywhere → adopt it, no conflict
      const only = nets[0];
      const adopting = via.netId !== only;
      via.netId = only;
      for (const t of attached) if (!t.netId) t.netId = only;
      refresh();
      if (adopting) UI.toast("Via connected → “" + (getNet(only)?.name || "net") + "”");
      else if (folded) UI.toast("Vias combined");
      return;
    }

    // 2+ distinct nets meet at the via → merge them pairwise (chained prompts)
    const reconcile = (list) => {
      promptNetMerge(list[0], list[1],
        "This via now joins different nets where it sits. Which net should the joined copper use?",
        (survived, blocked) => {
          if (!blocked && survived === null){ revert(); return; }   // Undo → revert the move
          if (blocked){                                             // protected pair — can't merge
            if (!via.netId) via.netId = list[0];
            refresh(); return;
          }
          const rest = [...new Set([survived, ...list.slice(2)])];  // fold the merged net back in
          if (rest.length >= 2){ reconcile(rest); return; }
          via.netId = rest[0];
          for (const t of attached) if (!t.netId) t.netId = rest[0];
          refresh(); UI.toast("Merged → “" + (getNet(rest[0])?.name || "net") + "”");
        });
    };
    reconcile(nets);
  };

  // Phase 1 — fold overlapping vias into this one (chained: a net conflict prompts A→B/B→A)
  const combineStep = () => {
    const other = firstViaOverlap(via);
    if (!other){ connectPhase(); return; }
    if (via.netId && other.netId && via.netId !== other.netId){
      promptNetMerge(via.netId, other.netId, "Two vias overlap and combine into one, but carry different nets. Which net should the combined via use?", (survived, blocked) => {
        if (blocked){ connectPhase(); return; }   // protected — don't fold (would join protected nets); leave them
        if (survived === null){ revert(); return; }
        via.netId = survived; foldViaInto(via, other); folded++; combineStep();
      });
      return;
    }
    if (!via.netId && other.netId) via.netId = other.netId;
    foldViaInto(via, other); folded++; combineStep();
  };

  anchorTracesUnderVia(via);   // via dropped on a trace mid-segment gains an anchor there
  combineStep();
}

/* ---------------- component tool ---------------- */
function componentDown(w, e){
  if (!Tools.pending){ UI.openFootprintDialog(); return; }
  const p = Tools.pending;
  const fp = generateFootprint(p.fpId, p.fpParams);
  // no components stacked on the same spot (same side)
  const s = State.pxPerMm;
  let rNew = Math.hypot(fp.body.w, fp.body.h)/2 * s;
  for (const o of State.components){
    if (o.side !== Tools.ghostSide) continue;
    if (Math.hypot(w.x-o.x, w.y-o.y) < Math.min(rNew, compRadius(o)) * 0.8){
      UI.toast("Too close to " + o.ref + " — components can't stack"); return;
    }
  }
  pushUndo("place component");
  let ref;
  if (p.ref && p.ref.trim()){
    ref = p.ref.trim();
    // remember the typed prefix so subsequent placements continue it (D1 → D2, not R11)
    const m = /^([A-Za-z]+)/.exec(ref);
    if (m) p.refPrefix = m[1];
  } else if (p.fpId === "chip2"){
    // tantalum size = always a capacitor (C); otherwise R/C/L chip where the click
    // modifier decides the refdes prefix (click = R, Shift = C, Ctrl = L)
    const tant = p.fpParams && (p.fpParams.size || "").startsWith("Tant ");
    const prefix = tant ? "C" : (e.ctrlKey ? "L" : e.shiftKey ? "C" : "R");
    ref = nextRef(prefix);
  } else {
    ref = nextRef(p.refPrefix || refPrefixFor(p.fpId, p.value));
  }
  registerRef(ref);
  const comp = {
    id: nextId(), ref, value: p.value||"", part: p.part||"",
    fpId: p.fpId, fpParams: {...p.fpParams},
    kicad: p.kicad || fp.kicad || "",
    x: w.x, y: w.y, rot: Tools.ghostRot, side: Tools.ghostSide,
    scale: 1,
    pins: fp.pins.map(fpin => ({ num:fpin.num, name:fpin.name||"", netId:null })),
  };
  State.components.push(comp);
  autoConnectPins(comp);   // pins dropped on existing copper inherit its net (e.g. plated mounting hole over a trace)
  p.ref = ""; // subsequent placements auto-number
  UI.select({type:"comp", comp});
  UI.toast("Placed " + ref + " (" + fp.label + ")");
  requestRender();
}

/* ---------------- trace tool ---------------- */
function traceDown(w, e){
  const snap = snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
  const p = snap ? {x:snap.x, y:snap.y} : {x:w.x, y:w.y};
  if (!Tools.tracePts){
    Tools.tracePts = [p];
    Tools.traceStartSnap = snap;
    Tools.traceSide = UI.copperSide();
    const netNote = snap && snap.netId ? " — continuing net “" + (getNet(snap.netId)?.name || "?") + "”" : "";
    UI.setHint("Routing on " + SIDE_LABELS[Tools.traceSide] + netNote + " — click to add points, Enter/double-click to finish, Esc to cancel");
  } else {
    Tools.tracePts.push(p);
    if (snap){ finishTrace(snap); return; } // ended on a pad/via → done
  }
  requestRender();
}

function finishTrace(endSnap){
  let pts = Tools.tracePts;
  if (pts){ // drop consecutive duplicate points (double-click finish adds the last point twice)
    pts = pts.filter((p,i) => !i || Math.hypot(p.x-pts[i-1].x, p.y-pts[i-1].y) > 0.5);
    Tools.tracePts = pts;
  }
  if (!pts || pts.length < 2){ cancelTrace(); return; }
  endSnap = endSnap || snapToConductor(pts[pts.length-1].x, pts[pts.length-1].y, Tools.traceSide, true, State.traceW);

  // determine / create net
  const sSnap = Tools.traceStartSnap;
  const nets = [];
  if (sSnap && sSnap.netId) nets.push(sSnap.netId);
  if (endSnap && endSnap.netId) nets.push(endSnap.netId);

  // both endpoints already carry a DIFFERENT named net → don't silently pick one.
  // Ask which name wins (or leave them apart) BEFORE mutating any state.
  if (nets.length === 2 && nets[0] !== nets[1]){
    const aId = nets[0], bId = nets[1];   // A = where the trace started, B = where it ended
    const aName = getNet(aId)?.name || "?", bName = getNet(bId)?.name || "?";
    UI.openNetMergeDialog(aName, bName, (choice) => {
      if (choice !== "undo" && Tools.tracePts !== pts){ return; } // stale (cancelled meanwhile)
      if (choice === "undo" || !choice){ UI.toast("Cancelled — trace not drawn"); cancelTrace(); return; }
      if (choice === "ignore"){
        // draw the trace but keep the two nets apart: it gets its own fresh net and
        // neither pad is reassigned (the checker will flag the deliberate short)
        pushUndo();
        completeTrace(pts, sSnap, endSnap, createNet().id, { skipAttach:true });
        return;
      }
      // "toB" keeps B (A→B); "toA" keeps A (B→A)
      const keepId = choice === "toB" ? bId : aId, dropId = choice === "toB" ? aId : bId;
      pushUndo();                                  // snapshot BEFORE the merge mutates nets
      const merged = mergeNets(keepId, dropId);    // null only if BOTH are protected
      const netId = (merged === null) ? keepId : merged;
      if (merged === null) UI.toast("⚠ " + getNet(keepId).name + " / " + getNet(dropId).name + " are protected — NOT merged");
      else UI.toast("Merged nets → " + getNet(netId).name);
      completeTrace(pts, sSnap, endSnap, netId, {});
    });
    return;   // async — the trace is finalized inside the callback
  }

  pushUndo();
  const netId = nets.length ? nets[0] : createNet().id;
  completeTrace(pts, sSnap, endSnap, netId, {});
}

/* Finalize a drawn trace once its net is decided (pushUndo already fired):
   attach the endpoints to their pads/vias, weld into any touching same-side trace,
   and join crossings. `opts.skipAttach` (the "Ignore" merge choice) leaves both
   endpoint pads on their own nets — only the trace itself takes `netId`. */
function completeTrace(pts, sSnap, endSnap, netId, opts){
  opts = opts || {};
  if (!opts.skipAttach){
    applyAttach(sSnap, netId);
    applyAttach(endSnap, netId);
  }
  const trace = weldOrCreateTrace(pts, Tools.traceSide, netId, sSnap, endSnap);
  Tools.tracePts = null; Tools.traceStartSnap = null;
  UI.setHint(TOOL_HINTS.trace);
  UI.refreshNets(); requestRender();
  // join any touching same-side trace; different-net crossings prompt A→B/B→A (async)
  if (!opts.skipAttach) mergeIntersectingTraces(trace);
}

/* If a snap landed on (or very near) one END of an existing trace on `side`,
   return {trace, end} where end is 0 (first point) or 1 (last point). A mid-trace
   snap (T-junction) returns null — those stay separate and just share a net. */
function traceEndpointSnap(snap, side){
  if (!snap || !snap.attach || snap.attach.type !== "trace") return null;
  const t = snap.attach.trace;
  if (t.side !== side) return null;
  const p0 = t.points[0], pL = t.points[t.points.length-1];
  const tol = Math.max(2, (t.width||3)*0.75);
  const d0 = Math.hypot(snap.x-p0.x, snap.y-p0.y);
  const dL = Math.hypot(snap.x-pL.x, snap.y-pL.y);
  if (d0 <= tol && d0 <= dL) return { trace:t, end:0 };
  if (dL <= tol) return { trace:t, end:1 };
  return null;
}

/* append `extra` (ordered from the shared endpoint outward) onto trace `t` at
   `end` (0 = before the first point, 1 = after the last). The shared point
   (extra[0]) is dropped — `t` keeps its own endpoint. */
function appendToTraceEnd(t, end, extra){
  const add = extra.slice(1).map(p=>({x:p.x,y:p.y}));
  if (!add.length) return;
  if (end === 1) t.points.push(...add);
  else t.points.unshift(...add.reverse());
}

/* Create the drawn trace, or — when it begins/ends on the END of an existing
   same-side trace — weld it into that trace so the result is one polyline.
   If BOTH ends meet two different traces, all three become a single trace. */
function weldOrCreateTrace(pts, side, netId, sSnap, endSnap){
  const sm = traceEndpointSnap(sSnap, side);
  let em = traceEndpointSnap(endSnap, side);
  if (sm && em && sm.trace === em.trace && sm.end === em.end) em = null; // same spot, ignore

  if (!sm && !em){
    const t = { id:nextId(), side, netId, points: pts.map(p=>({x:p.x,y:p.y})), width: State.traceW };
    State.traces.push(t);
    return t;
  }

  const seq = pts.map(p=>({x:p.x,y:p.y}));
  let host, freeEnd; // freeEnd = which end of host now holds seq's outward (end) point
  if (sm){
    host = sm.trace;
    appendToTraceEnd(host, sm.end, seq);          // seq[0] coincides with host's matched end
    freeEnd = (sm.end === 1) ? "last" : "first";
  } else {
    host = em.trace;
    appendToTraceEnd(host, em.end, seq.slice().reverse()); // start is the free outward end
    em = null;
  }
  host.netId = netId;

  // both ends met traces → concatenate the second trace onto the host's free end
  if (sm && em && em.trace !== host){
    const B = em.trace;
    const bExtra = (em.end === 0 ? B.points.slice(1) : B.points.slice(0,-1).reverse()).map(p=>({x:p.x,y:p.y}));
    if (freeEnd === "last") host.points.push(...bExtra);
    else host.points.unshift(...bExtra.reverse());
    State.traces = State.traces.filter(t => t !== B);
    if (UI.sel && UI.sel.type==="trace" && UI.sel.trace===B) UI.select(null);
  }
  return host;
}

/* any same-side trace that genuinely connects to the new one joins its net. Unnamed
   crossings are absorbed silently. When the trace touches other NAMED nets it lists them
   all in one prompt: a single crossing keeps the A→B / B→A name-direction dialog; several
   distinct nets show a multi-net dialog (merge with one of them, all, or keep separate). */
function mergeIntersectingTraces(trace){
  // snapshot the touching same-side traces up front (net ids may change as we merge)
  const touching = State.traces.filter(other =>
    other !== trace && other.side === trace.side && other.netId !== trace.netId && tracesTouch(trace, other));
  if (!touching.length) return;
  // unnamed crossings just adopt the trace's net; collect the DISTINCT named nets it hits
  let absorbed = 0;
  const netIds = new Set();
  for (const other of touching){
    if (!other.netId){ other.netId = trace.netId; absorbed++; }
    else netIds.add(other.netId);
  }
  const overlap = [...netIds].map(id => getNet(id)).filter(Boolean);
  const done = (msg) => {
    UI.refreshNets(); requestRender();
    if (msg) UI.toast(msg);
    else if (absorbed) UI.toast("Joined " + absorbed + " crossing trace" + (absorbed>1?"s":""));
  };
  if (!overlap.length){ done(); return; }

  // merge the trace's net with one named net; returns the survivor id (or null if blocked)
  const mergeWith = (netId) => {
    const m = mergeNets(trace.netId, netId);
    if (m !== null) trace.netId = m;
    return m;
  };

  if (overlap.length === 1){
    const aId = trace.netId, bId = overlap[0].id;
    const aName = getNet(aId)?.name || "?", bName = overlap[0].name;
    UI.openNetMergeDialog(aName, bName, (choice) => {
      if (choice === "toB" || choice === "toA"){
        const keep = choice === "toB" ? bId : aId, drop = choice === "toB" ? aId : bId;
        const m = mergeNets(keep, drop);
        if (m === null){ done("⚠ Crossing protected nets " + aName + " / " + bName + " — NOT merged"); return; }
        trace.netId = m; done("Merged → “" + (getNet(m)?.name || "?") + "”"); return;
      }
      done();   // keep separate
    }, { ignore:false, title:"Trace crosses another net", undoText:"Keep them separate",
         msg:`This trace touches a trace on <b>“${escAttr(bName)}”</b> (B); the drawn trace is <b>“${escAttr(aName)}”</b> (A). Which net should the joined copper use?` });
    return;
  }

  // several distinct nets → list them all, let the user pick one / all / keep separate
  UI.openMultiMergeDialog(getNet(trace.netId)?.name || "?", overlap, (sel) => {
    if (sel == null){ done(); return; }                    // keep separate
    if (sel === "all"){
      let ok = 0;
      for (const n of overlap) if (mergeWith(n.id) !== null) ok++;
      done(ok ? ("Merged " + ok + " net" + (ok>1?"s":"") + " → “" + (getNet(trace.netId)?.name || "?") + "”")
              : "Protected nets — nothing merged");
      return;
    }
    const m = mergeWith(sel);                              // sel = a specific net id
    done(m === null ? "⚠ Protected nets — NOT merged" : ("Merged → “" + (getNet(trace.netId)?.name || "?") + "”"));
  });
}

/* is world point (px,py) sitting on a same-side pad's copper (within halfW)? Used by
   disconnectTrace to know when a trimmed end has physically cleared the pads. */
function padTouchingPoint(px, py, side, halfW){
  for (const c of State.components){
    if (Math.hypot(px - c.x, py - c.y) > compRadius(c) + halfW) continue;   // quick reject
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi];
      if (!fpin) continue;
      const thru = fpin.shape === "circle" && fpin.tht !== false;   // only THT pads reach every side
      if (!thru && c.side !== side) continue;
      if (pinEdgeDist(c, fpin, px, py) <= halfW) return true;
    }
  }
  return false;
}

/* does via v's copper touch trace t (on a side v reaches)? */
function viaTouchesTrace(v, t){
  if (!viaOnSide(v, t.side)) return false;
  const reach = (t.width || State.traceW) / 2 + (v.r || State.viaR);
  for (let k=0; k<t.points.length-1; k++)
    if (distToSeg(v.x, v.y, t.points[k], t.points[k+1]) <= reach) return true;
  return false;
}

/* physical connectivity for the disconnect cluster: tracesTouch (crossings, coincident
   endpoints, endpoint-on-interior) PLUS a plain any-vertex-on-copper test, so a junction that
   lands on an INTERIOR vertex — e.g. one trace passing through a 3-way junction, or two vertices
   coinciding — is caught too (tracesTouch's mid-segment guard misses those). Half-width tolerance
   keeps parallel traces (centre-lines ~a full width apart) from being joined. */
function tracesJoined(t1, t2){
  if (tracesTouch(t1, t2)) return true;
  const tol = Math.max(2, Math.min((t1.width||State.traceW), (t2.width||State.traceW)) * 0.6);
  const near = (pts, other) => {
    for (const p of pts)
      for (let k=0; k<other.points.length-1; k++)
        if (distToSeg(p.x, p.y, other.points[k], other.points[k+1]) <= tol) return true;
    return false;
  };
  return near(t1.points, t2) || near(t2.points, t1);
}

/* the whole galvanically-connected copper cluster reachable from `startTrace` through
   trace↔trace junctions and vias (and any traces those vias reach on other layers, and so
   on). Pads are the boundary — they are never traversed into. Returns {traces:Set, vias:Set}. */
function traceConnectedCluster(startTrace){
  const traces = new Set([startTrace]), vias = new Set(), queue = [startTrace];
  while (queue.length){
    const t = queue.pop();
    // vias sitting on this trace
    for (const v of State.vias){
      if (vias.has(v) || !viaTouchesTrace(v, t)) continue;
      vias.add(v);
      // every trace that via reaches (this side and, if through, other sides)
      for (const o of State.traces)
        if (!traces.has(o) && viaTouchesTrace(v, o)){ traces.add(o); queue.push(o); }
    }
    // same-side traces physically touching this one (shared junction / T / crossing / vertex)
    for (const o of State.traces)
      if (!traces.has(o) && o.side === t.side && tracesJoined(t, o)){ traces.add(o); queue.push(o); }
  }
  return { traces, vias };
}

/* Context-menu "Disconnect / clear net": strip the net from the whole connected copper
   cluster (this trace, the vias on it, and every other trace/via reachable through those
   vias and junctions) WITHOUT touching the pads it reaches, then pull each trace's end
   anchors off the pads so the cluster is physically disconnected. Removes end vertices that
   sit on a pad; for a bare 2-point trace it retracts the endpoint until its copper clears. */
function disconnectTrace(trace, scope){   // scope "one" = just this trace; else the whole cluster
  pushUndo("disconnect trace");
  const { traces, vias } = scope === "one"
    ? { traces: new Set([trace]), vias: new Set() }
    : traceConnectedCluster(trace);
  for (const t of traces){
    const halfW = (t.width || State.traceW) / 2;
    const clearEnd = (end) => {
      // drop end anchors that sit on a pad while an interior vertex still remains
      while (t.points.length > 2){
        const idx = end === 0 ? 0 : t.points.length - 1;
        const p = t.points[idx];
        if (!padTouchingPoint(p.x, p.y, t.side, halfW)) return;
        t.points.splice(idx, 1);
      }
      // only the two endpoints left — if this end still overlaps a pad, retract it inward
      const idx = end === 0 ? 0 : t.points.length - 1;
      const other = end === 0 ? t.points[1] : t.points[t.points.length - 2];
      const p = t.points[idx];
      if (!padTouchingPoint(p.x, p.y, t.side, halfW)) return;
      const dx = other.x - p.x, dy = other.y - p.y, len = Math.hypot(dx, dy) || 1;
      const step = Math.max(halfW, 2);
      for (let s = step; s < len; s += step){
        const nx = p.x + dx/len*s, ny = p.y + dy/len*s;
        if (!padTouchingPoint(nx, ny, t.side, halfW)){ p.x = nx; p.y = ny; return; }
      }
      p.x = other.x - dx/len*step; p.y = other.y - dy/len*step;   // whole span under pads — leave a stub
    };
    clearEnd(0);
    clearEnd(1);
    t.netId = null;
  }
  for (const v of vias) v.netId = null;   // pads keep their nets; only cluster copper is cleared
  pruneNets();
  UI.refreshNets(); UI.refreshInspector(); requestRender();
  UI.toast("Disconnected — cleared " + traces.size + " trace" + (traces.size>1?"s":"") +
           (vias.size ? " + " + vias.size + " via" + (vias.size>1?"s":"") : "") + ", ends pulled off pads");
}

/* does pad (comp,fpin) physically touch trace t's copper (on a side the pad reaches)? */
function padTouchesTrace(comp, fpin, t){
  const thru = fpin.shape === "circle" && fpin.tht !== false;
  if (!thru && comp.side !== t.side) return false;
  const s = State.pxPerMm * (comp.scale || 1);
  const wp = pinWorldPos(comp, fpin);
  const reach = (t.width || State.traceW)/2 + Math.min(fpin.w, fpin.h) * s / 2;
  for (let k=0; k<t.points.length-1; k++)
    if (distToSeg(wp.x, wp.y, t.points[k], t.points[k+1]) <= reach) return true;
  return false;
}
/* does pad (comp,fpin) sit on via v (on a side the via reaches)? */
function padTouchesVia(comp, fpin, v){
  const thru = fpin.shape === "circle" && fpin.tht !== false;
  if (!thru && !viaOnSide(v, comp.side)) return false;
  return pinEdgeDist(comp, fpin, v.x, v.y) <= (v.r || State.viaR) + 1;
}

/* The full electrical node physically reachable from a seed pad/via/trace — flood-fills
   through trace↔trace junctions, vias, AND pads (a pad shared by two traces bridges them).
   Unlike traceConnectedCluster (used by disconnect, which stops AT pads), this traverses
   through pads. Returns {traces:Set, vias:Set, pads:[{comp,pinIdx}]}. */
function connectedCluster(seed){
  const traces = new Set(), vias = new Set(), padKeys = new Set(), pads = [], queue = [];
  const addTrace = t => { if (!traces.has(t)){ traces.add(t); queue.push({k:"trace",o:t}); } };
  const addVia   = v => { if (!vias.has(v)){ vias.add(v); queue.push({k:"via",o:v}); } };
  const addPad   = (c,pi) => { const key=c.id+":"+pi; if (!padKeys.has(key)){ padKeys.add(key); const rec={comp:c,pinIdx:pi}; pads.push(rec); queue.push({k:"pad",o:rec}); } };
  if (seed.type === "trace") addTrace(seed.trace);
  else if (seed.type === "via") addVia(seed.via);
  else if (seed.type === "pin") addPad(seed.comp, seed.pinIdx);

  const eachPad = (fn) => { for (const c of State.components){ const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){ const fpin = fp.pins[pi]; if (fpin && !padKeys.has(c.id+":"+pi)) fn(c, pi, fpin); } } };

  while (queue.length){
    const n = queue.pop();
    if (n.k === "trace"){
      const t = n.o;
      for (const v of State.vias) if (!vias.has(v) && viaTouchesTrace(v, t)) addVia(v);
      for (const o of State.traces) if (!traces.has(o) && o !== t && o.side === t.side && tracesTouch(t, o)) addTrace(o);
      eachPad((c,pi,fpin) => { if (padTouchesTrace(c, fpin, t)) addPad(c, pi); });
    } else if (n.k === "via"){
      const v = n.o;
      for (const t of State.traces) if (!traces.has(t) && viaTouchesTrace(v, t)) addTrace(t);
      for (const o of State.vias){ if (o===v || vias.has(o)) continue; const rr = Math.max(v.r||State.viaR, o.r||State.viaR); if (Math.hypot(o.x-v.x, o.y-v.y) <= rr*0.9) addVia(o); }
      eachPad((c,pi,fpin) => { if (padTouchesVia(c, fpin, v)) addPad(c, pi); });
    } else {
      const { comp:c, pinIdx:pi } = n.o;
      const fpin = compFootprint(c).pins[pi]; if (!fpin) continue;
      for (const t of State.traces) if (!traces.has(t) && padTouchesTrace(c, fpin, t)) addTrace(t);
      for (const v of State.vias) if (!vias.has(v) && padTouchesVia(c, fpin, v)) addVia(v);
    }
  }
  return { traces, vias, pads };
}

function applyAttach(snap, netId){
  if (!snap || !snap.attach) return;
  const a = snap.attach;
  if (a.type === "pin") a.comp.pins[a.pinIdx].netId = netId;
  else if (a.type === "via") a.via.netId = netId;
  else if (a.type === "trace") a.trace.netId = netId;
}

/* Shift-detach: break a dragged anchor free. Any junction it shared is dropped
   (the linked vertices stay put). If the anchor is an INTERIOR vertex, its trace is
   split there into two and the drag continues on the tail piece so it pulls away. */
function detachAnchor(d){
  d.linked = null;                       // stop carrying coincident junctions
  const t = d.trace, i = d.i, n = t.points.length;
  if (i > 0 && i < n - 1){
    const tail = t.points.slice(i).map(p => ({ x:p.x, y:p.y }));
    const nt = { id:nextId(), side:t.side, netId:t.netId, width:t.width || State.traceW, points:tail };
    t.points = t.points.slice(0, i + 1);  // head keeps its copy of vertex i in place
    State.traces.push(nt);
    d.trace = nt; d.i = 0;                 // continue the drag on the tail's free end
    Tools.dragVert = { trace:nt, i:0 };
    UI.select({ type:"trace", trace:nt });
  }
}

/* connect a dragged trace anchor that was dropped on a pad/via/trace.
   Joins nets (with the usual protected-net checks) so the anchor really wires up. */
function connectVertToSnap(trace, snap, vi){
  const tNet = trace.netId, sNet = snap.netId;

  // wire the anchor up once the winning net is known: weld endpoint-onto-endpoint, or drop a
  // coincident T-junction vertex when it landed mid-trace
  const finish = (net, note) => {
    trace.netId = net;
    applyAttach(snap, net);
    // dragging an endpoint anchor onto the END of another same-side trace welds them into one
    if (vi != null && weldTraceAnchor(trace, vi, snap)){
      pruneNets(); UI.refreshNets();
      UI.select({ type:"trace", trace });
      UI.toast(note || ("Traces merged → " + (getNet(net)?.name || "net")));
      requestRender();
      return;
    }
    // landed mid-trace (not an endpoint weld) → drop a coincident vertex on the target so it
    // becomes a real T-junction that holds, and moves with the target if dragged
    if (snap.attach.type === "trace" && snap.attach.seg != null){
      const B = snap.attach.trace, k = snap.attach.seg;
      const a = B.points[k], b = B.points[k+1], near = 1.5 / View.zoom;
      if (a && b && Math.hypot(snap.x-a.x, snap.y-a.y) > near && Math.hypot(snap.x-b.x, snap.y-b.y) > near)
        B.points.splice(k+1, 0, { x:snap.x, y:snap.y });
    }
    pruneNets(); UI.refreshNets();
    const where = snap.attach.type === "pin"
      ? snap.attach.comp.ref + "." + snap.attach.comp.pins[snap.attach.pinIdx].num
      : snap.attach.type === "via" ? "via" : "trace";
    UI.toast(note || ("Anchor connected to " + where + " → " + (getNet(net)?.name || "net")));
    requestRender();
  };

  // two DIFFERENT nets meet at the dropped anchor → ask which name wins with the same
  // A→B/B→A dialog as drawing a trace between two nets (not the old big-merge confirm)
  if (tNet && sNet && tNet !== sNet){
    promptNetMerge(tNet, sNet,
      "This trace anchor now sits on a different net. Which net should the joined copper use?",
      (survived, blocked) => {
        if (!blocked && survived === null){       // Undo → revert the whole anchor move
          undo(); UI.select(null); UI.refreshNets(); UI.refreshInspector(); requestRender();
          UI.toast("Move undone"); return;
        }
        // protected pair: keep the trace's own net, nets stay separate (warned already)
        finish(blocked ? tNet : survived, blocked ? "Anchor moved — protected nets not merged" : null);
      });
    return;
  }
  finish(tNet || sNet || createNet().id);
}

/* Dragging an ENDPOINT vertex of `trace` (index `vi`) onto the END of another
   same-side trace joins the two into one polyline. A mid-trace landing (T) or a
   mid-vertex drag is left alone. Returns true when a weld happened. */
function weldTraceAnchor(trace, vi, snap){
  if (!snap || !snap.attach || snap.attach.type !== "trace") return false;
  const B = snap.attach.trace;
  if (B === trace || B.side !== trace.side) return false;
  const aEnd = (vi === 0) ? 0 : (vi === trace.points.length - 1) ? 1 : -1;
  if (aEnd === -1) return false;                  // not an endpoint anchor
  const em = traceEndpointSnap(snap, trace.side);
  if (!em || em.trace !== B) return false;        // must land on B's end, not its interior
  // B's points ordered from the shared endpoint outward; the shared point is dropped
  const bSeq = (em.end === 0 ? B.points : B.points.slice().reverse()).map(p => ({ x:p.x, y:p.y }));
  appendToTraceEnd(trace, aEnd, bSeq);
  State.traces = State.traces.filter(t => t !== B);
  return true;
}

function cancelTrace(){
  Tools.tracePts = null; Tools.traceStartSnap = null;
  UI.setHint(TOOL_HINTS.trace);
  requestRender();
}

/* ---------------- via / PTH tool ---------------- */
function viaDown(w, e){
  const pth = e.altKey;          // Alt-click = plated through hole (mounting/component hole)
  // no stacked vias/PTH on the same spot
  for (const v of State.vias){
    if (Math.hypot(w.x-v.x, w.y-v.y) < Math.max(v.r||5, State.viaR)){
      UI.toast("There is already a " + (v.kind==="pth"?"PTH":"via") + " here"); return;
    }
  }
  pushUndo(pth ? "place PTH" : "place via");
  // Shift = free placement: don't snap to a conductor and don't inherit its net
  const snap = e.shiftKey ? null : snapToConductor(w.x, w.y, "any");
  let netId = snap ? snap.netId : null;
  if (!netId && !e.shiftKey){
    // near a trace?
    const h = hitTest(w.x, w.y);
    if (h && h.type === "trace") netId = h.trace.netId;
  }
  // reuse the last via's net for stitching multiple vias — unless Shift-placed or PTH
  if (!netId && !e.shiftKey && !pth && Tools.lastViaNet){
    const t = findNetByName(Tools.lastViaNet) || findNetByName(Tools.lastViaNet.toUpperCase()) || createNet(Tools.lastViaNet);
    netId = t.id;
  }
  const via = {
    id: nextId(), x: snap?snap.x:w.x, y: snap?snap.y:w.y, netId: netId||null,
    r: pth ? Math.round(State.viaR*1.8) : State.viaR,
    kind: pth ? "pth" : "via",
  };
  State.vias.push(via);
  anchorTracesUnderVia(via);   // placed on a trace mid-segment → split it so the trace adheres
  if (netId && !pth) Tools.lastViaNet = getNet(netId)?.name || Tools.lastViaNet; // remember
  UI.select({type:"via", via});
  pruneNets();
  requestRender();
}

/* ---------------- align & deskew tools moved to align.js ---------------- */

/* ---------------- measure tool ---------------- */
function measureDown(w, e){
  Tools.measureA = {x:w.x, y:w.y};
  Tools.measureB = null;
  Tools.drag = { kind:"measure" };
}

function finishMeasure(){
  if (!Tools.measureA || !Tools.measureB){ Tools.measureA=null; return; }
  const d = Math.hypot(Tools.measureB.x-Tools.measureA.x, Tools.measureB.y-Tools.measureA.y);
  if (d < 2){ Tools.measureA = Tools.measureB = null; return; }
  const curMm = d / State.pxPerMm;
  const unit = UI.unit();
  if (Tools.name === "calibrate"){
    const inp = prompt("Measured " + d.toFixed(1) + " px.\nEnter the REAL length in " + unit + " to calibrate the board scale:", "");
    if (inp && parseFloat(inp) > 0){
      pushUndo("calibrate scale");
      const realMm = unit === "mil" ? parseFloat(inp)*0.0254 : parseFloat(inp);
      State.pxPerMm = d / realMm;
      UI.toast("Calibrated: " + State.pxPerMm.toFixed(2) + " px/mm — footprints now match board scale");
    }
    Tools.measureA = Tools.measureB = null;
  } else {
    // pure measurement — keep the line on screen until the next click. Also read the
    // measured span out as a trace width → estimated current on the active copper side.
    const disp = unit === "mil" ? (curMm/0.0254).toFixed(0) + " mil" : curMm.toFixed(2) + " mm";
    const est = UI.widthCurrentEst(curMm);
    const estTxt = "~" + est.aTxt + " A (" + est.oz + " oz " + (est.internal ? "internal" : "external") + ")";
    UI.toast("Distance: " + d.toFixed(1) + " px  =  " + disp + "   ·   as a trace width: " + estTxt);
    UI.setHint("Measured " + disp + " → " + estTxt + " trace — drag again to re-measure");
  }
  requestRender();
}

/* ---------------- sticky-note tool ---------------- */
function noteDown(w, e){
  pushUndo("add note");
  const note = { id: nextId(), x: w.x, y: w.y, text: "", color: "#ffd24d" };
  State.notes.push(note);
  UI.select({ type:"note", note });   // inspector opens a text box
  UI.focusNoteText();
  UI.toast("Note added — type its text in the inspector");
  requestRender();
}

/* ---------------- shared ops ---------------- */
function deleteSelection(){
  const sel = UI.sel;
  if (!sel) return;
  if (sel.comp && compEditLocked(sel.comp)){ UI.toast(sel.comp.ref + " is edit-locked"); return; }
  // Delete on a selected PAD clears just that pad's net — nuking the whole part needs the
  // component BODY selected (so editing a pin's net can't wipe the component by mistake).
  if (sel.type === "pin"){
    const p = sel.comp.pins[sel.pinIdx];
    if (!p || !p.netId){ UI.toast("Pad has no net — select the component body to delete the whole part"); return; }
    pushUndo("clear pad net");
    p.netId = null;
    pruneNets();
    UI.refreshNets(); UI.refreshInspector(); requestRender();
    return;
  }
  pushUndo();
  if (sel.type === "comp"){
    State.components = State.components.filter(c => c !== sel.comp);
  } else if (sel.type === "via"){
    State.vias = State.vias.filter(v => v !== sel.via);
  } else if (sel.type === "trace"){
    State.traces = State.traces.filter(t => t !== sel.trace);
  } else if (sel.type === "note"){
    State.notes = State.notes.filter(n => n !== sel.note);
  }
  pruneNets();
  UI.select(null);
  UI.refreshNets(); requestRender();
}

function rotateSelection(deg){
  if (Tools.name === "component"){ Tools.ghostRot = (Tools.ghostRot + deg) % 360; requestRender(); return; }
  const sel = UI.sel;
  if (sel && sel.comp){
    if (compMoveLocked(sel.comp)){ UI.toast(sel.comp.ref + " is move-locked"); return; }
    pushUndo();
    sel.comp.rot = (sel.comp.rot + deg) % 360;
    UI.refreshInspector(); requestRender();
  }
}

function flipSelectionSide(){
  if (Tools.name === "component"){
    Tools.ghostSide = Tools.ghostSide === "front" ? "back" : "front";
    UI.toast("Placing on " + SIDE_LABELS[Tools.ghostSide]);
    requestRender(); return;
  }
  const sel = UI.sel;
  if (sel && sel.comp){
    if (compMoveLocked(sel.comp)){ UI.toast(sel.comp.ref + " is move-locked"); return; }
    pushUndo();
    sel.comp.side = sel.comp.side === "front" ? "back" : "front";
    UI.refreshInspector(); requestRender();
  }
}

/* ---------------- cut tool ---------------- */
function cutDown(w, e){
  const tol = 8 / View.zoom;
  let best = null, bestD = tol;
  for (const t of State.traces){
    if (!traceVisible(t)) continue;
    for (let k=0; k<t.points.length-1; k++){
      const pr = projectOnSeg(w.x, w.y, t.points[k], t.points[k+1]);
      if (pr.d < bestD){ bestD = pr.d; best = { t, k, pt:{x:pr.x, y:pr.y} }; }
    }
  }
  if (!best){ UI.toast("Click on a trace to cut it"); return; }
  pushUndo();
  const { t, k, pt } = best;
  const a = t.points[k], b = t.points[k+1];
  const len = Math.hypot(b.x-a.x, b.y-a.y) || 1;
  const ux = (b.x-a.x)/len, uy = (b.y-a.y)/len;
  // gap must clear the trace-touch threshold ((w1+w2)/2 = width) or the halves
  // would still count as connected
  const gap = Math.max(8, (t.width || 4) * 2 + 2);
  const endA   = { x: pt.x - ux*gap/2, y: pt.y - uy*gap/2 };
  const startB = { x: pt.x + ux*gap/2, y: pt.y + uy*gap/2 };
  const ptsA = t.points.slice(0, k+1).concat([endA]);
  const ptsB = [startB].concat(t.points.slice(k+1));
  const oldNet = t.netId;
  const ta = { id: nextId(), side: t.side, netId: oldNet, width: t.width, points: ptsA };
  const tb = { id: nextId(), side: t.side, netId: oldNet, width: t.width, points: ptsB };
  const i = State.traces.indexOf(t);
  State.traces.splice(i, 1, ta, tb);
  const made = splitNetByConnectivity(oldNet);
  pruneNets();
  if (UI.sel && UI.sel.trace === t) UI.select(null);
  UI.refreshNets(); requestRender();
  UI.toast(made > 1
    ? "Trace cut — net split into " + made + " separate nets"
    : "Trace cut (halves still connected elsewhere — net unchanged)");
}

/* re-derive connectivity of a net's members; first island keeps the net,
   the others get fresh nets. Returns the number of islands. */
function splitNetByConnectivity(netId){
  if (!netId) return 1;
  // collect conductors with geometry
  const items = [];
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      if (c.pins[pi].netId !== netId) continue;
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const wp = pinWorldPos(c, fpin);
      const s = State.pxPerMm * (c.scale||1);
      // a through-hole (round) pad reaches every copper layer; an SMD (rect) pad
      // is copper on its component side only. fpin lets us test the real pad shape.
      items.push({ kind:"pin", comp:c, pi, fpin, x:wp.x, y:wp.y, r: Math.max(fpin.w, fpin.h)*s/2,
                   thru: fpin.shape === "circle", side: c.side });
    }
  }
  for (const v of State.vias)
    if (v.netId === netId) items.push({ kind:"via", via:v, x:v.x, y:v.y, r:(v.r||5), thru:true, side:null });
  for (const t of State.traces)
    if (t.netId === netId) items.push({ kind:"trace", trace:t, side:t.side });

  if (items.length < 2) return 1;

  // a pad/via only shares copper with something on another side when it is
  // through-hole (or a via, which bridges every layer)
  const reaches = (p, side) => p.thru || p.side === side;

  const touches = (A, B) => {
    const tA = A.kind === "trace", tB = B.kind === "trace";
    if (tA && tB)
      return A.trace.side === B.trace.side && tracesTouch(A.trace, B.trace);
    if (tA || tB){
      const tr = tA ? A.trace : B.trace, p = tA ? B : A;
      if (!reaches(p, tr.side)) return false;   // SMD pad does not touch a trace on a different layer
      const half = (tr.width||3)/2 + 2;
      for (let i=0;i<tr.points.length-1;i++){
        // closest point on this trace segment to the pad/via centre, then measure
        // to the pad's REAL edge (rectangle aware) rather than a round radius
        const pr = projectOnSeg(p.x, p.y, tr.points[i], tr.points[i+1]);
        const edge = p.fpin ? pinEdgeDist(p.comp, p.fpin, pr.x, pr.y)
                            : Math.max(0, pr.d - (p.r||5));
        if (edge <= half) return true;
      }
      return false;
    }
    // pad/via to pad/via: two SMD pads on different sides never share copper;
    // a through-hole pad or via bridges layers
    if (!(A.thru || B.thru) && A.side !== B.side) return false;
    if (Math.hypot(A.x-B.x, A.y-B.y) > A.r + B.r) return false; // quick reject
    // refine with the real pad shapes so two long rectangular pads only count as
    // connected when their metal actually overlaps
    const dA = A.fpin ? pinEdgeDist(A.comp, A.fpin, B.x, B.y) : 0;
    const dB = B.fpin ? pinEdgeDist(B.comp, B.fpin, A.x, A.y) : 0;
    return dA <= (B.r || 5) || dB <= (A.r || 5);
  };

  // union-find over O(n²) pairs
  const parent = items.map((_,i)=>i);
  const find = (i)=>{ while (parent[i]!==i){ parent[i]=parent[parent[i]]; i=parent[i]; } return i; };
  for (let i=0;i<items.length;i++)
    for (let j=i+1;j<items.length;j++)
      if (touches(items[i], items[j])) parent[find(i)] = find(j);

  const groups = new Map();
  items.forEach((it,i)=>{
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(it);
  });
  if (groups.size < 2) return 1;

  // largest island keeps the original net
  const islands = [...groups.values()].sort((a,b)=>b.length-a.length);
  for (let gi=1; gi<islands.length; gi++){
    const nn = createNet();
    for (const it of islands[gi]){
      if (it.kind === "pin") it.comp.pins[it.pi].netId = nn.id;
      else if (it.kind === "via") it.via.netId = nn.id;
      else it.trace.netId = nn.id;
    }
  }
  return islands.length;
}

/* ---------------- freestyle pins ---------------- */
function addFreePin(comp, w){
  const s = State.pxPerMm * (comp.scale || 1);
  let dx = w.x - comp.x, dy = w.y - comp.y;
  const a = -comp.rot * Math.PI/180, ca = Math.cos(a), sa = Math.sin(a);
  let lx = dx*ca - dy*sa, ly = dx*sa + dy*ca;
  if (comp.side === "back") lx = -lx;
  const pl = comp.fpParams.pinList = (comp.fpParams.pinList || []);
  let num = pl.length + 1;
  while (pl.some(p => String(p.num) === String(num))) num++;
  // new pins inherit the last pin's pad type/size for quick repeat placement
  const last = pl[pl.length-1];
  pl.push({ num: String(num), x: +(lx/s).toFixed(3), y: +(ly/s).toFixed(3),
            shape: last ? last.shape : "circle", size: last ? last.size : 1.6 });
  comp._fp = null;
  comp.pins.push({ num: String(num), name: "", netId: null });
  UI.setHint("Pin " + num + " added to " + comp.ref + " — keep clicking, Esc to finish");
}

function removeFreePin(comp, idx){
  if (!comp.fpParams.pinList) return;
  comp.fpParams.pinList.splice(idx, 1);
  comp.pins.splice(idx, 1);
  comp._fp = null;
  pruneNets();
}

/* ---- visual pad editor: resize/move a single pad by dragging handles ----
   Storage is per footprint type: free footprints keep per-pad geometry in pinList
   (native), generated footprints get an absolute override in fpParams.padOv[num].
   Either way the pin CENTRE for a resize stays put, so connected traces hold. */
function padSetSize(comp, idx, w, h){
  w = Math.max(0.2, w); h = Math.max(0.2, h);
  if (comp.fpId === "free"){
    const pl = ensureFreePin(comp, idx);
    pl.w = +w.toFixed(3); pl.h = +h.toFixed(3); delete pl.size;   // explicit W/H overrides size
  } else if (comp.fpId === "pad1"){
    // a single test pad's size IS its diameter — write the param (not a padOv override) so
    // the inspector's Pad Ø field reflects a drag-resize
    const p = comp.fpParams || (comp.fpParams = {});
    p.dia = +Math.max(w, h).toFixed(3);
    if (p.hole != null && parseFloat(p.hole) > p.dia) p.hole = p.dia;   // keep drill ≤ pad
    const num = comp.pins[idx].num;
    if (p.padOv && p.padOv[num]){ delete p.padOv[num].w; delete p.padOv[num].h; }   // param wins
  } else {
    const num = comp.pins[idx].num;
    const p = comp.fpParams || (comp.fpParams = {});
    const e = (p.padOv || (p.padOv = {}));
    const o = (e[num] || (e[num] = {}));
    o.w = +w.toFixed(3); o.h = +h.toFixed(3);
  }
  comp._fp = null;
}
function padSetPos(comp, idx, x, y){
  if (comp.fpId === "free"){
    const pl = ensureFreePin(comp, idx);
    pl.x = +x.toFixed(3); pl.y = +y.toFixed(3);
  } else {
    const num = comp.pins[idx].num;
    const p = comp.fpParams || (comp.fpParams = {});
    const e = (p.padOv || (p.padOv = {}));
    const o = (e[num] || (e[num] = {}));
    o.x = +x.toFixed(3); o.y = +y.toFixed(3);
  }
  comp._fp = null;
}
/* enter pad-edit mode on a component's pad — select the pad and show its drag handles */
function enterPadEdit(comp, idx){
  if (compEditLocked(comp)){ UI.toast(comp.ref + " is edit-locked"); return; }
  Tools.padEdit = { comp, idx };
  UI.select({ type:"pin", comp, pinIdx:idx });
  setTool("select");
  Tools.padEdit = { comp, idx };   // setTool cleared it — re-arm after the tool switch
  UI.toast("Editing pad " + comp.ref + "." + comp.pins[idx].num + " — drag ▢ corners to resize, ● centre to move · Esc when done");
  requestRender();
}
/* clear any per-pad override on a generated footprint (free pads have no override to clear) */
function padResetOverride(comp, idx){
  if (comp.fpId === "free") return;
  const num = comp.pins[idx].num;
  if (!(comp.fpParams && comp.fpParams.padOv && comp.fpParams.padOv[num])) return;
  pushUndo("reset pad");
  delete comp.fpParams.padOv[num];
  if (!Object.keys(comp.fpParams.padOv).length) delete comp.fpParams.padOv;
  comp._fp = null; UI.refreshInspector(); requestRender();
}

/* the pinList entry for pin index i, created if a legacy pin lacks one */
function ensureFreePin(comp, idx){
  const pl = comp.fpParams.pinList = (comp.fpParams.pinList || []);
  if (!pl[idx]) pl[idx] = { num: comp.pins[idx]?.num || String(idx+1), x:0, y:0, shape:"circle", size:1.6 };
  return pl[idx];
}

/* legacy single `locked` flag becomes two separate locks */
function migrateLock(c){
  if (c.locked){ c.lockMove = true; c.lockEdit = true; delete c.locked; }
}
function compMoveLocked(c){ return !!(c.lockMove || c.locked); }
function compEditLocked(c){ return !!(c.lockEdit || c.locked); }

function toggleLockSelection(){
  const c = UI.sel && UI.sel.comp;
  if (!c) return;
  pushUndo();
  migrateLock(c);
  c.lockMove = !c.lockMove;
  UI.toast(c.ref + (c.lockMove ? " move-locked 🔒" : " move unlocked"));
  UI.refreshInspector(); requestRender();
}

function canvasPoint(e){
  const r = View.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/* set the active pane (offset + copper side + shown layer) from a screen point, so
   coordinate transforms and side-based visibility target the half of the split under
   the cursor. No-op offset outside split mode. */
function updatePane(pt){
  if (View.split){
    const which = pt.x >= View.width/2 ? "right" : "left";
    View.cursorPane = which;
    View._paneDX = which === "right" ? View.width/2 : 0;
    View._paneLayerId = View.paneLayer[which] || null;
    View._paneSide = paneSideOf(which);
    View._paneXray = View.xray || (getLayer(View._paneLayerId)?.side === "xray");
  } else {
    View.cursorPane = null;
    View._paneDX = 0; View._paneSide = null; View._paneLayerId = null; View._paneXray = null;
  }
}
