/* ===== tools.js — Tools state, tool switch, pointer routing, edge auto-scroll =====
   Split submodules (loaded separately from index.html):
     tools-select.js   — select tool, dblclick, net rename, duplicate, overlap check
     tools-trace.js    — trace tool, welding, connectivity clusters, disconnect
     tools-via.js      — via / PTH tool, via drop, anchor helpers, net-merge prompt
     tools-checker.js  — runChecker + autoConnectPins
     tools-ops.js      — component / measure / note / cut, delete/rotate/flip, pads, locks
   Everything is top-level `function` — call-time-bound, so load order between the
   submodules doesn't matter; tools.js just has to be first so `Tools` exists. */
"use strict";

const Tools = {
  name: "select",
  cursor: null,        // world pos of pointer
  snap: null,          // current snap target {x,y,attach,netId}
  // trace tool
  tracePts: null,
  traceSide: "front",
  traceStartSnap: null,
  angleSnap: localStorage.getItem("pcbreveng.traceAngleSnap") === "on",   // constrain new segments to 45° increments
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
  // drag state
  drag: null,
  dragVert: null,      // {trace,i} currently-dragged trace vertex (for render)
  padEdit: null,       // {comp,idx} pad being visually resized/moved (draws handles)
  // crop tool
  cropLayer: null,     // image layer being cropped
  cropA: null, cropB: null,   // world-space crop rectangle corners (during the drag)
  // rotate tool
  rotateLayer: null,   // image layer being rotated (gizmo shown for it)
  rotLine: null,       // {a,b} world-space "level this" line being dragged
  // resize-XY tool
  resizeLayer: null,   // image layer being resized
  resizeLine: null,    // {a,b} world-space reference line being dragged
  resizeStep: 0,       // 0 = horizontal (X) line, 1 = vertical (Y) line
  resizeFx: 1, resizeFy: 1,   // pending per-axis scale factors
};

const TOOL_HINTS = {
  select:    "Click to select · drag to move · R rotate · B flip side · Del delete · double-click pin to name net",
  component: "Click to place · R rotate · B side · Esc cancel · C reopens footprint dialog",
  trace:     "Click pins/points to route · Enter/double-click finish · Esc cancel · starts & ends snap to pads/vias",
  via:       "Click = via (reuses last net) · Shift-click = fresh via · Alt-click = PTH · double-click = layer span (blind/buried) · press the via key again to probe the net under the cursor",
  cut:       "Click on a trace to cut it in two — disconnected halves get separate nets",
  note:      "Click to drop a sticky note · type its text in the inspector · in Select, drag to move / double-click to edit",
  align:     "Drag active layer to move · Alt+wheel scale · “Align” button = 4-point skew-correcting fit · Rotate tool = free/level rotation",
  measure:   "Drag to measure a distance (px and mm)",
  calibrate: "Drag along a KNOWN distance, then enter its real length in mm",
  crop:      "Drag a box around the part of the image to KEEP · Esc to cancel",
  rotate:    "Drag the knob (or Shift+drag anywhere) to free-rotate · drag a line along a feature that should be level → snaps it horizontal/vertical · Shift = 15° snap · Esc to exit",
  resizexy:  "Drag a HORIZONTAL then a VERTICAL line across features of known size, entering each real dimension — scales the layer's X and Y independently · Esc to cancel",
};

function toolCursor(name){
  return { select:"default", component:"crosshair", trace:"crosshair", via:"crosshair",
           align:"crosshair", measure:"crosshair", calibrate:"crosshair", cut:"crosshair", note:"crosshair", crop:"crosshair", rotate:"crosshair", resizexy:"crosshair" }[name] || "default";
}

function setTool(name){
  // image-manipulating tools are host-only during a multiplayer session
  if ((name === "align" || name === "calibrate" || name === "crop" || name === "rotate" || name === "resizexy")
      && typeof mpBlockImageOp === "function" && mpBlockImageOp()) return;
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
  Tools.rotateLayer = null; Tools.rotLine = null;   // leave the rotate tool
  Tools.resizeLayer = null; Tools.resizeLine = null; Tools.resizeStep = 0;   // leave the resize-XY tool
  Tools._edgeArmed = false;   // re-arm edge auto-scroll: must leave the margin before it kicks in
  if (name !== "component"){ Tools.ghostFp = null; Tools.pending = null; }
  if (name !== "select"){ View.hoverPin = null; View.cursorLabel = null; UI.setStatusPad(""); Tools._readout = ""; }   // pad/comp readout is select-mode only
  Tools.name = name;
  document.querySelectorAll("#toolbar .tool").forEach(b =>
    b.classList.toggle("active", b.dataset.tool === name));
  View.canvas.style.cursor = toolCursor(name);
  UI.setStatusTool(name);
  UI.setHint(TOOL_HINTS[name] || "");
  // arming the component tool opens the footprint selector — unless quick-add is enabled,
  // where the selector only appears on click (via componentDown → QuickAdd)
  if (name === "component" && !Tools.pending && !QuickAdd.enabled()) UI.openFootprintDialog();
  UI.refreshInspector();   // reflect tool-specific panels (e.g. via-tool defaults) when nothing is selected
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

  // off-page link marker (arrow + page tag above a linked connector) — click = jump
  if (typeof xlinkHitAt === "function"){
    const xh = xlinkHitAt(pt.x, pt.y);
    if (xh && typeof Boards !== "undefined"){ Boards.jumpTo(xh.target); return; }
  }

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
    case "rotate":    return rotateDown(w, pt, e);
    case "resizexy":  return resizeDown(w, e);
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

  // snap preview for relevant tools (Shift disables snapping for both trace & via)
  if (Tools.name === "trace"){
    Tools.snap = e.shiftKey ? null : snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
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
    // status-bar readout of the hovered pad/component (richer than the cursor chip:
    // ref.pin, pin name, net, [value · part])
    const readout = hoverReadout(h);
    if (readout !== Tools._readout){ Tools._readout = readout; UI.setStatusPad(readout); }
    View.canvas.style.cursor = h ? "pointer" : "default";
  }

  if (View.split || Tools.name==="trace" || Tools.name==="via" || Tools.name==="component" || Tools.name==="measure" || Tools.name==="rotate" || Tools.alignPts || Tools.deskewPts)
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
  if (d.kind === "rot-gizmo"){
    if (!d.moved) cancelUndo();   // a plain click on the knob shouldn't churn undo
    UI.refreshLayerList();
  }
  if (d.kind === "rot-line"){
    const rl = Tools.rotLine; Tools.rotLine = null;
    if (d.moved && rl) applyRotateLine(d.layer, rl.a, rl.b);
    else cancelUndo();
    requestRender();
  }
  if (d.kind === "move-comp" || d.kind === "move-via" || d.kind === "move-layer" || d.kind === "rot-layer" || d.kind === "move-vert" || d.kind === "move-seg"){
    if (!d.moved){
      cancelUndo(); // no-op drag, drop the snapshot (restores redo — a click mustn't wipe it)
      // shift-click (no drag) on a pad → toggle pin multi-select; on a component
      // BODY → show it in the Schematic tab (when that tab is enabled)
      if (d.shiftPin){ UI.togglePinSel(d.shiftPin.comp, d.shiftPin.pinIdx); requestRender(); }
      else if (d.kind === "move-comp" && d.detach && typeof SchEnabled === "function" && SchEnabled()){
        EditorTabs.show("schematic");
        Sch.focusComp(d.comp);
      }
      // an align-tool click that never dragged drops the next 4-point marker
      if (d.alignClick){ placeAlignMarker(d.alignClick.x, d.alignClick.y, d.alignClick.thumb); }
    }
    // a real drag must not also register as a double-click (which would delete a point
    // or pop open an editor/menu); flag it so the dblclick that may follow is ignored.
    if (d.moved){
      if (d.kind === "move-comp" || d.kind === "move-via" || d.kind === "move-seg"){
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
  if (d.kind === "resize-line"){
    finishResizeLine();
  }
  if (d.kind === "crop-rect"){
    applyCrop();   // bakes the kept region; stays no-op & keeps undo clean if the box was tiny
  }
  if (d.kind === "box-select"){
    if (d.moved){
      applyBoxSelect(d.sx, d.sy, d.x, d.y);
      const n = UI.boxSelCount();
      UI.toast(n ? n + " object" + (n===1?"":"s") + " selected — Del to delete" : "Nothing in the box");
      // click + click&hold-drag registers as a double-click in the browser — without this
      // flag, releasing the box would ALSO fire onDoubleClick and pop an editor/menu for
      // whatever sits under the cursor
      Tools._dragEndedAt = Date.now();
    }
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
      // shift-click = jump to the schematic; ignore sub-4px jitter so it stays a CLICK
      // (a real shift-drag past the threshold still detaches and moves as before)
      if (!d.moved && d.detach && d.wx !== undefined &&
          Math.hypot(w.x - d.wx, w.y - d.wy) * View.zoom < 4) break;
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
    case "move-seg": {
      // slide a whole trace segment: axis-aligned segments move perpendicular only
      d.moved = true;
      const a = d.trace.points[d.k], b = d.trace.points[d.k+1];
      let dx = w.x - d.wx, dy = w.y - d.wy;
      const horiz = Math.abs(d.by - d.ay) < 0.001, vert = Math.abs(d.bx - d.ax) < 0.001;
      if (horiz && !vert) dx = 0;
      if (vert && !horiz) dy = 0;
      a.x = d.ax + dx; a.y = d.ay + dy;
      b.x = d.bx + dx; b.y = d.by + dy;
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
    case "rot-gizmo": {
      d.moved = true;
      const a0 = Math.atan2(d.wy - d.layer.ty, d.wx - d.layer.tx);
      const a1 = Math.atan2(w.y - d.layer.ty, w.x - d.layer.tx);
      let delta = (a1 - a0) * (View.flip ? -1 : 1);
      if (e && e.shiftKey){ const step = Math.PI/12; delta = Math.round(delta/step)*step; }  // 15° snap
      applyLayerRotation(d.layer, delta, d.lrot, d.lwarp0);
      UI.refreshLayerList();
      break;
    }
    case "rot-line":
      d.moved = true;
      Tools.rotLine = { a: Tools.rotLine.a, b:{ x:w.x, y:w.y } };
      break;
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
    case "resize-line":
      d.moved = true;
      Tools.resizeLine = { a: Tools.resizeLine.a, b: resizeLineTo(Tools.resizeLine.a, w) };
      break;
    case "crop-rect":
      d.moved = true;
      Tools.cropB = { x:w.x, y:w.y };
      break;
    case "box-select":
      d.moved = true;
      d.x = w.x; d.y = w.y;
      break;
  }
}

/* collect every selectable object whose position falls inside the world-space box into
   UI.boxSel. A component/via/note counts when its centre is inside; a trace when any
   vertex is inside. Only VISIBLE objects are taken — the same traceVisible/viaVisible
   rules the renderer and hit-testing use, so a box can't grab a trace on a hidden side
   or a blind via that isn't on this layer. Components always show at least their pads,
   so they always count. The box bounds are kept for the inspector's "pads only" filter. */
function applyBoxSelect(x0, y0, x1, y1){
  const lx = Math.min(x0,x1), hx = Math.max(x0,x1), ly = Math.min(y0,y1), hy = Math.max(y0,y1);
  const inside = (x,y) => x >= lx && x <= hx && y >= ly && y <= hy;
  const out = [];
  for (const c of State.components) if (inside(c.x, c.y)) out.push({ type:"comp", comp:c });
  for (const v of State.vias) if (viaVisible(v) && inside(v.x, v.y)) out.push({ type:"via", via:v });
  for (const t of State.traces) if (traceVisible(t) && t.points.some(p => inside(p.x, p.y))) out.push({ type:"trace", trace:t });
  for (const n of State.notes) if (inside(n.x, n.y)) out.push({ type:"note", note:n });
  UI.boxSel = out;
  UI.boxSelBounds = { lx, hx, ly, hy };
  UI.refreshInspector();
}

/* ---------- edge auto-scroll (drag / place near the viewport border → pan) ------
   Touchpad users can't easily pan mid-drag (no free hand for space+drag / middle
   drag). When a dragged object — or a component ghost being placed — nears an edge
   we pan the view toward it and keep it under the cursor, so you can move/drop it
   clear across a board that's larger than the screen. Only translation drags and
   component placement qualify (not view-pan / rotate / measure). */
const EDGE_SCROLL_KINDS = { "move-comp":1, "move-via":1, "move-vert":1, "move-seg":1, "move-note":1, "move-layer":1 };

/* true when the current interaction is one that should auto-pan near the edges:
   a translation drag, or the component tool tracking a ghost about to be placed.
   The whole feature can be switched off in Options (UI.edgeScrollOn). */
function edgeScrollAllowed(){
  if (!UI.edgeScrollOn()) return false;
  if (Tools.drag) return !!EDGE_SCROLL_KINDS[Tools.drag.kind];
  if (Tools.name === "component") return true;              // whenever the component tool is armed (like via/trace)
  if (Tools.name === "trace")     return true;              // whenever the trace tool is armed (not just mid-route)
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
  const shift = Tools._lastEvt && Tools._lastEvt.shiftKey;
  if (Tools.drag) handleDrag(pt, w, Tools._lastEvt);   // ghost needs only the updated cursor
  else if (Tools.name === "trace") Tools.snap = shift ? null : snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
  else if (Tools.name === "via")   Tools.snap = shift ? null : snapToConductor(w.x, w.y, "any");
  UI.setStatusPos(w);
  requestRender();
  Tools._edgeRAF = requestAnimationFrame(edgeScrollTick);
}

function stopEdgeScroll(){
  if (Tools._edgeRAF){ cancelAnimationFrame(Tools._edgeRAF); Tools._edgeRAF = 0; }
  Tools._edgeVel = null;
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
