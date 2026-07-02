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
  pan:       "Drag to pan",
};

function toolCursor(name){
  return { select:"default", component:"crosshair", trace:"crosshair", via:"crosshair",
           align:"move", measure:"crosshair", calibrate:"crosshair", cut:"crosshair", note:"crosshair", pan:"grab" }[name] || "default";
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
  if (name !== "component"){ Tools.ghostFp = null; Tools.pending = null; }
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
  }
}

function onPointerMove(e){
  const pt = canvasPoint(e);
  updatePane(pt);
  const w = screenToWorld(pt.x, pt.y);
  Tools.cursor = w;
  UI.setStatusPos(w);

  if (Tools.drag){
    handleDrag(pt, w, e);
    requestRender();
    return;
  }

  // snap preview for relevant tools
  if (Tools.name === "trace"){
    Tools.snap = snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
  } else if (Tools.name === "via"){
    Tools.snap = snapToConductor(w.x, w.y, "any");
  } else Tools.snap = null;

  // hover net / note highlight in select mode
  if (Tools.name === "select"){
    const h = hitTest(w.x, w.y);
    let net = null, note = null, pin = null;
    if (h){
      if (h.type==="pin"){ net = h.comp.pins[h.pinIdx].netId; pin = { comp:h.comp, pinIdx:h.pinIdx }; }
      else if (h.type==="via") net = h.via.netId;
      else if (h.type==="trace") net = h.trace.netId;
      else if (h.type==="note") note = h.note;
    }
    // track the hovered pad so the "star" ratsnest can hang off it on hover, not just click
    const pinChanged = (pin?.comp !== View.hoverPin?.comp) || (pin?.pinIdx !== View.hoverPin?.pinIdx);
    View.hoverPin = pin;
    if (net !== View.hoverNetId){ View.hoverNetId = net; }
    if (note !== View.hoverNote){ View.hoverNote = note; requestRender(); }
    if (pinChanged && View.ratsnest && View.ratsnestMode === "star") requestRender();
    View.canvas.style.cursor = h ? "pointer" : "default";
  }

  if (View.split || Tools.name==="trace" || Tools.name==="component" || Tools.name==="measure" || Tools.alignPts || Tools.deskewPts)
    requestRender();   // split view redraws every move so the mirror cursor tracks
  else if (View.hoverNetId !== Tools._lastHover){ Tools._lastHover = View.hoverNetId; requestRender(); }
}

function onPointerUp(e){
  if (!Tools.drag) return;
  const d = Tools.drag;
  Tools.drag = null;
  if (d.kind === "pan"){
    View.canvas.style.cursor = toolCursor(Tools.name); // restore the tool's cursor (e.g. crosshair for via)
  }
  if (d.kind === "move-note"){
    if (!d.moved) Undo.stack.pop(); // a click (no drag) keeps undo clean; dblclick edits
    else Tools._dragEndedAt = Date.now();
    UI.refreshInspector();
  }
  if (d.kind === "move-comp" || d.kind === "move-via" || d.kind === "move-layer" || d.kind === "rot-layer" || d.kind === "move-vert"){
    if (!d.moved) Undo.stack.pop(); // no-op drag, drop the snapshot
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
    if (d.kind === "move-comp" && d.moved) checkMoveOverlaps(d.comp); // only after the move ends
  }
  if (d.kind === "measure"){
    finishMeasure();
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
    case "measure":
      Tools.measureB = w;
      break;
  }
}

/* ---------------- select tool ---------------- */
function selectDown(w, pt, e){
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
  // shift-click pins → multi-select for bulk net assignment
  if (e.shiftKey && h && h.type === "pin"){
    UI.togglePinSel(h.comp, h.pinIdx);
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
    // anchors translate along with the component, preserving their relative position
    const anchors = [];
    const fp = compFootprint(c);
    const ctol = 6 / View.zoom;
    for (const fpin of fp.pins)
      for (const t of State.traces)
        for (let i=0;i<t.points.length;i++)
          if (pinEdgeDist(c, fpin, t.points[i].x, t.points[i].y) <= ctol)
            anchors.push({ pts:t.points, i, dx:t.points[i].x-c.x, dy:t.points[i].y-c.y });
    Tools.drag = { kind:"move-comp", comp:c, offX:w.x-c.x, offY:w.y-c.y, moved:false, anchors };
  } else if (h.type === "via"){
    pushUndo();
    // grab every trace vertex sitting on the via so connected anchors move along with it
    const vtol = Math.max(h.via.r || 5, 6/View.zoom);
    const anchors = [];
    for (const t of State.traces)
      for (let i=0;i<t.points.length;i++)
        if (Math.hypot(t.points[i].x-h.via.x, t.points[i].y-h.via.y) <= vtol)
          anchors.push({ pts:t.points, i, dx:t.points[i].x-h.via.x, dy:t.points[i].y-h.via.y });
    Tools.drag = { kind:"move-via", via:h.via, offX:w.x-h.via.x, offY:w.y-h.via.y, moved:false, anchors };
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

/* Apply a typed net name to a pad/via/trace, asking how far the rename should reach
   when the current net has several members (rename the whole net vs. peel this one
   off). Handles undo + refresh itself; runs `done` afterwards. */
function applyNetRename(obj, name, done){
  name = (name || "").trim();
  const oldId = objNetId(obj);
  const old = oldId ? getNet(oldId) : null;
  const members = oldId ? netMembers(oldId).length : 0;
  const finish = () => {
    if (obj.type === "via" && name) Tools.lastViaNet = name;  // remember for the next via
    UI.refreshNets(); UI.refreshInspector(); requestRender();
    done && done();
  };
  // unambiguous: clearing, no current net, unchanged name, or a lone member → no prompt
  if (!name || !old || old.name === name || members <= 1){
    pushUndo("name net");
    if (!assignNetToObject(obj, name, "all")) Undo.stack.pop();
    finish();
    return;
  }
  // the net has other members — ask what the rename should affect
  UI.openNetScopeDialog(old.name, name, members, (scope) => {
    if (!scope){ done && done(); return; }                 // cancelled — nothing changes
    pushUndo(scope === "all" ? "rename net " + old.name : "split net " + old.name);
    if (!assignNetToObject(obj, name, scope)) Undo.stack.pop();
    finish();
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
  const thru = (pin) => pin.shape === "circle"; // through-hole pads reach every copper side
  for (let pi=0; pi<comp.pins.length; pi++){
    const myNet = comp.pins[pi].netId;
    if (!myNet) continue;
    const fpin = fp.pins[pi]; if (!fpin) continue;
    const wp = pinWorldPos(comp, fpin);
    const myR = Math.max(fpin.w, fpin.h)*s/2;
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
        if (Math.hypot(wp.x-op.x, wp.y-op.y) <= myR + Math.max(opin.w,opin.h)*os/2)
          hitNet(o.pins[oi].netId, o.ref + "." + o.pins[oi].num);
      }
    }
    for (const v of State.vias)
      if (Math.hypot(wp.x-v.x, wp.y-v.y) <= myR + (v.r||5)) hitNet(v.netId, "via");
    for (const t of State.traces){
      // a trace is copper on a single side — ignore unless the pad reaches that side
      if (!(myThru || t.side === comp.side)) continue;
      for (let k=0;k<t.points.length-1;k++){
        const pr = projectOnSeg(wp.x, wp.y, t.points[k], t.points[k+1]);
        if (pinEdgeDist(comp, fpin, pr.x, pr.y) <= (t.width||3)/2 + 2){ hitNet(t.netId, "trace"); break; }
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
      const tht = fpin.shape === "circle"; // only through-hole pads reach other sides
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
          const pr = projectOnSeg(wp.x, wp.y, t.points[k], t.points[k+1]);
          if (pinEdgeDist(c, fpin, pr.x, pr.y) <= (t.width||3)/2 + 2){ touch = true; break; }
        }
        if (touch){ mismatches.push({ comp:c, pinIdx:pi, pinNet:p.netId, traceNet:t.netId, trace:t }); break; }
      }
    }
  }
  return { unnetted, mismatches, shorts };
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
    // R/C/L chip: click = R, Shift = C, Ctrl = L — modifier decides the refdes prefix
    const prefix = e.ctrlKey ? "L" : e.shiftKey ? "C" : "R";
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
  let netId = null;
  const sSnap = Tools.traceStartSnap;
  const nets = [];
  if (sSnap && sSnap.netId) nets.push(sSnap.netId);
  if (endSnap && endSnap.netId) nets.push(endSnap.netId);
  if (nets.length === 2 && nets[0] !== nets[1]){
    // ask BEFORE creating anything; "No" abandons the trace entirely
    netId = mergeNetsChecked(nets[0], nets[1]);
    if (netId === MERGE_DECLINED){
      UI.toast("Cancelled — trace not drawn");
      cancelTrace();
      return;
    }
    pushUndo();
    if (netId === null){
      netId = nets[0];
      UI.toast("⚠ " + (getNet(nets[0])?.name) + " and " + (getNet(nets[1])?.name) +
               " are protected nets — NOT merged (trace joined to " + getNet(nets[0]).name + ")");
    } else {
      UI.toast("Merged nets → " + getNet(netId).name);
    }
  } else if (nets.length){
    pushUndo();
    netId = nets[0];
  } else {
    pushUndo();
    netId = createNet().id;
  }
  // attach endpoints
  applyAttach(sSnap, netId);
  applyAttach(endSnap, netId);

  // if an endpoint started/ended on the END of an existing same-side trace, weld
  // the two into a single continuous polyline instead of leaving two objects
  const trace = weldOrCreateTrace(pts, Tools.traceSide, netId, sSnap, endSnap);
  mergeIntersectingTraces(trace);
  Tools.tracePts = null; Tools.traceStartSnap = null;
  UI.setHint(TOOL_HINTS.trace);
  UI.refreshNets(); requestRender();
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

/* any same-side trace that genuinely connects to the new one joins its net.
   Crossings with a DIFFERENT existing net ask for confirmation first. */
function mergeIntersectingTraces(trace){
  let merged = 0;
  for (const other of State.traces){
    if (other === trace || other.side !== trace.side) continue;
    if (other.netId === trace.netId) continue;
    if (!tracesTouch(trace, other)) continue;
    if (!other.netId){ other.netId = trace.netId; merged++; continue; }
    // both have nets — confirm before joining two different nets
    const tn = getNet(trace.netId)?.name || "?";
    const on = getNet(other.netId)?.name || "?";
    if (!confirm("This trace overlaps a trace on net “" + on + "”.\nConnect them (merge “" + tn + "” and “" + on + "”)?")){
      continue; // leave them separate
    }
    const m = mergeNetsChecked(trace.netId, other.netId);
    if (m === MERGE_DECLINED) continue;
    if (m === null){
      UI.toast("⚠ Crossing protected nets " + tn + " / " + on + " — NOT merged");
      continue;
    }
    trace.netId = m;
    merged++;
  }
  if (merged) UI.toast("Joined " + merged + " crossing trace" + (merged>1?"s":"") + " → net “" + (getNet(trace.netId)?.name || "?") + "”");
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
  let net = tNet;
  let quietMerge = null;  // {a,b,keep} when two different nets were joined without a confirm
  if (tNet && sNet && tNet !== sNet){
    const aName = getNet(tNet)?.name || "?", bName = getNet(sNet)?.name || "?";
    // did the big-merge confirm dialog fire? if not, this merge happens silently
    const willPrompt = State.bigMergeWarn && netPinCount(tNet) > 3 && netPinCount(sNet) > 3;
    const merged = mergeNetsChecked(tNet, sNet);
    if (merged === MERGE_DECLINED) { UI.toast("Anchor moved — nets not merged"); pruneNets(); UI.refreshNets(); requestRender(); return; }
    net = merged === null ? tNet : merged; // null = both protected, keep trace's net
    if (merged === null) UI.toast("⚠ Protected nets not merged");
    else if (!willPrompt) quietMerge = { a:aName, b:bName, keep:getNet(net)?.name || "?" };
  } else {
    net = tNet || sNet || createNet().id;
  }
  trace.netId = net;
  applyAttach(snap, net);
  // dragging an endpoint anchor onto the END of another same-side trace welds them into one
  if (vi != null && weldTraceAnchor(trace, vi, snap)){
    pruneNets(); UI.refreshNets();
    UI.select({ type:"trace", trace });
    if (quietMerge) UI.warn("Connected nets “" + quietMerge.a + "” + “" + quietMerge.b + "” → “" + quietMerge.keep + "” (Ctrl+Z to undo)");
    else UI.toast("Traces merged → " + (getNet(net)?.name || "net"));
    requestRender();
    return;
  }
  // landed mid-trace (not an endpoint weld) → drop a coincident vertex on the target
  // so it becomes a real T-junction that holds, and moves with the target if dragged
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
  if (quietMerge) UI.warn("Connected nets “" + quietMerge.a + "” + “" + quietMerge.b + "” → “" + quietMerge.keep + "” (Ctrl+Z to undo)");
  else UI.toast("Anchor connected to " + where + " → " + (getNet(net)?.name || "net"));
  requestRender();
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
  const snap = snapToConductor(w.x, w.y, "any");
  let netId = snap ? snap.netId : null;
  if (!netId){
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
  pushUndo();
  if (sel.type === "comp" || sel.type === "pin"){
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
