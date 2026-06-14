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
  via:       "Click = via (reuses last net) · Shift-click = fresh via · Alt-click = PTH (plated hole) · double-click to name",
  cut:       "Click on a trace to cut it in two — disconnected halves get separate nets",
  align:     "Drag active layer to move · Alt+wheel scale · Shift+drag rotate · “Align” button = 4-point skew-correcting fit",
  measure:   "Drag to measure a distance (px and mm)",
  calibrate: "Drag along a KNOWN distance, then enter its real length in mm",
  pan:       "Drag to pan",
};

function toolCursor(name){
  return { select:"default", component:"crosshair", trace:"crosshair", via:"crosshair",
           align:"move", measure:"crosshair", calibrate:"crosshair", cut:"crosshair", pan:"grab" }[name] || "default";
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
  }
}

function onPointerMove(e){
  const pt = canvasPoint(e);
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
    Tools.snap = snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide());
  } else if (Tools.name === "via"){
    Tools.snap = snapToConductor(w.x, w.y, "any");
  } else Tools.snap = null;

  // hover net highlight in select mode
  if (Tools.name === "select"){
    const h = hitTest(w.x, w.y);
    let net = null;
    if (h){
      if (h.type==="pin") net = h.comp.pins[h.pinIdx].netId;
      else if (h.type==="via") net = h.via.netId;
      else if (h.type==="trace") net = h.trace.netId;
    }
    if (net !== View.hoverNetId){ View.hoverNetId = net; }
    View.canvas.style.cursor = h ? "pointer" : "default";
  }

  if (Tools.name==="trace" || Tools.name==="component" || Tools.name==="measure" || Tools.alignPts || Tools.deskewPts)
    requestRender();
  else if (View.hoverNetId !== Tools._lastHover){ Tools._lastHover = View.hoverNetId; requestRender(); }
}

function onPointerUp(e){
  if (!Tools.drag) return;
  const d = Tools.drag;
  Tools.drag = null;
  if (d.kind === "pan"){
    View.canvas.style.cursor = toolCursor(Tools.name); // restore the tool's cursor (e.g. crosshair for via)
  }
  if (d.kind === "move-comp" || d.kind === "move-via" || d.kind === "move-layer" || d.kind === "rot-layer" || d.kind === "move-vert"){
    if (!d.moved) Undo.stack.pop(); // no-op drag, drop the snapshot
    if (d.kind === "move-vert" && d.moved && d.snap && d.snap.attach) connectVertToSnap(d.trace, d.snap);
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
      break;
    case "move-via":
      d.moved = true;
      d.via.x = w.x; d.via.y = w.y;
      break;
    case "move-vert": {
      d.moved = true;
      // snap the anchor onto a nearby pad/via/other-trace so it can connect
      let snap = snapToConductor(w.x, w.y, d.trace.side);
      // don't let an anchor snap onto its own trace
      if (snap && snap.attach && snap.attach.type === "trace" && snap.attach.trace === d.trace) snap = null;
      d.snap = snap;
      Tools.snap = snap; // white ring indicator
      d.trace.points[d.i].x = snap ? snap.x : w.x;
      d.trace.points[d.i].y = snap ? snap.y : w.y;
      break;
    }
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
        Tools.drag = { kind:"move-vert", trace:t, i, moved:false };
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
    Tools.drag = { kind:"move-comp", comp:c, offX:w.x-c.x, offY:w.y-c.y, moved:false };
  } else if (h.type === "via"){
    pushUndo();
    Tools.drag = { kind:"move-via", via:h.via, moved:false };
  }
  requestRender();
}

function onDoubleClick(e){
  const pt = canvasPoint(e);
  const w = screenToWorld(pt.x, pt.y);
  if (Tools.name === "trace"){ finishTrace(); return; }
  if (Tools.name === "select"){
    const h = hitTest(w.x, w.y);
    if (h && (h.type==="pin" || h.type==="via" || h.type==="trace")){
      promptNetName(h);
    } else if (h && h.type==="comp"){
      UI.select(h);
      UI.openQuickEdit(h.comp); // quick ref + value editor
    }
  }
}

/* assign `name` to the geometrically-connected island around obj.
   Disconnected members of the old net keep their name; the island's traces
   follow the rename. Returns false when blocked by net protection. */
function assignNetToObject(obj, name){
  name = (name || "").trim();
  const getId = () => obj.type==="pin" ? obj.comp.pins[obj.pinIdx].netId :
                      obj.type==="via" ? obj.via.netId : obj.trace.netId;
  const setId = (id) => {
    if (obj.type==="pin") obj.comp.pins[obj.pinIdx].netId = id;
    else if (obj.type==="via") obj.via.netId = id;
    else obj.trace.netId = id;
  };
  const oldId = getId();
  if (!name){ // clearing: detach just this object
    if (oldId){
      const old = getNet(oldId);
      if (old && old.protected && netMembers(oldId).length > 1 && obj.type !== "pin"){
        UI.toast(old.name + " is protected"); return false;
      }
      setId(null);
    }
    return true;
  }
  if (oldId){
    // isolate the connected island first, so the rename never leaks to
    // same-named objects that aren't actually wired to this one
    splitNetByConnectivity(oldId);
    const islandId = getId();
    const islandNet = getNet(islandId);
    const islandSize = netMembers(islandId).length;
    if (islandNet && islandNet.name === name) return true; // no-op
    if (islandNet && islandNet.protected && islandSize > 1){
      UI.toast(islandNet.name + " is protected — disconnect first (cut tool) to rename this copper");
      return false;
    }
    if (islandSize === 1){
      // lone object: simply reassign it
      const target = findNetByName(name) ||
                     findNetByName(name.toUpperCase()) || createNet(name);
      setId(target.id);
    } else {
      if (!renameNet(islandId, name)){
        UI.toast("Could not rename — protected net");
        return false;
      }
    }
  } else {
    const target = findNetByName(name) || findNetByName(name.toUpperCase()) || createNet(name);
    setId(target.id);
  }
  pruneNets();
  return true;
}

function promptNetName(h){
  const netId = h.type==="pin" ? h.comp.pins[h.pinIdx].netId :
                h.type==="via" ? h.via.netId : h.trace.netId;
  const cur = netId ? (getNet(netId)?.name || "") : "";
  const label = h.type==="via" ? "Via net" : h.type==="trace" ? "Trace net" :
                (h.comp.ref + "." + h.comp.pins[h.pinIdx].num + " net");
  UI.openNetPopup(label, cur, (name) => {
    pushUndo("name net");
    assignNetToObject(h, name);
    if (h.type === "via" && name.trim()) Tools.lastViaNet = name.trim(); // remember for next via
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  });
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
      for (let k=0;k<t.points.length-1;k++)
        if (distToSeg(wp.x,wp.y,t.points[k],t.points[k+1]) <= myR + (t.width||3)/2){ hitNet(t.netId, "trace"); break; }
    }
  }
  View.overlapMarks = conflicts.length ? conflicts.map(c => c.pos) : null;
  if (conflicts.length){ requestRender(); UI.openOverlapDialog(conflicts); }
}

/* ---------------- checker ---------------- */
/* returns { unnetted:[{comp,pinIdx,wp}], mismatches:[{comp,pinIdx,pinNet,traceNet,trace}] } */
function runChecker(){
  const unnetted = [];
  const mismatches = [];
  for (const c of State.components){
    const fp = compFootprint(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const p = c.pins[pi];
      if (p.nc) continue;                       // explicitly no-connect → excluded
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const wp = pinWorldPos(c, fpin);
      if (!p.netId){ unnetted.push({ comp:c, pinIdx:pi, wp }); continue; }
      // does a trace physically touch this pad but carry a different net?
      const s = State.pxPerMm*(c.scale||1);
      const myR = Math.max(fpin.w, fpin.h)*s/2;
      for (const t of State.traces){
        if (t.netId === p.netId || !t.netId) continue;
        let touch = false;
        for (let k=0;k<t.points.length-1;k++)
          if (distToSeg(wp.x,wp.y,t.points[k],t.points[k+1]) <= myR + (t.width||3)/2){ touch = true; break; }
        if (touch){ mismatches.push({ comp:c, pinIdx:pi, pinNet:p.netId, traceNet:t.netId, trace:t }); break; }
      }
    }
  }
  return { unnetted, mismatches };
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
  const snap = snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide());
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
  endSnap = endSnap || snapToConductor(pts[pts.length-1].x, pts[pts.length-1].y, Tools.traceSide);

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

  const trace = {
    id: nextId(), side: Tools.traceSide, netId,
    points: pts.map(p=>({x:p.x,y:p.y})), width: State.traceW,
  };
  State.traces.push(trace);
  mergeIntersectingTraces(trace);
  Tools.tracePts = null; Tools.traceStartSnap = null;
  UI.setHint(TOOL_HINTS.trace);
  UI.refreshNets(); requestRender();
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

/* connect a dragged trace anchor that was dropped on a pad/via/trace.
   Joins nets (with the usual protected-net checks) so the anchor really wires up. */
function connectVertToSnap(trace, snap){
  const tNet = trace.netId, sNet = snap.netId;
  let net = tNet;
  if (tNet && sNet && tNet !== sNet){
    const merged = mergeNetsChecked(tNet, sNet);
    if (merged === MERGE_DECLINED) { UI.toast("Anchor moved — nets not merged"); pruneNets(); UI.refreshNets(); requestRender(); return; }
    net = merged === null ? tNet : merged; // null = both protected, keep trace's net
    if (merged === null) UI.toast("⚠ Protected nets not merged");
  } else {
    net = tNet || sNet || createNet().id;
  }
  trace.netId = net;
  applyAttach(snap, net);
  pruneNets(); UI.refreshNets();
  const where = snap.attach.type === "pin"
    ? snap.attach.comp.ref + "." + snap.attach.comp.pins[snap.attach.pinIdx].num
    : snap.attach.type === "via" ? "via" : "trace";
  UI.toast("Anchor connected to " + where + " → " + (getNet(net)?.name || "net"));
  requestRender();
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
    // pure measurement — keep the line on screen until the next click
    const disp = unit === "mil" ? (curMm/0.0254).toFixed(0) + " mil" : curMm.toFixed(2) + " mm";
    UI.toast("Distance: " + d.toFixed(1) + " px  =  " + disp);
    UI.setHint("Measured " + disp + " — drag again to re-measure");
  }
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
      items.push({ kind:"pin", comp:c, pi, x:wp.x, y:wp.y, r: Math.max(fpin.w, fpin.h)*s/2 });
    }
  }
  for (const v of State.vias)
    if (v.netId === netId) items.push({ kind:"via", via:v, x:v.x, y:v.y, r:(v.r||5) });
  for (const t of State.traces)
    if (t.netId === netId) items.push({ kind:"trace", trace:t });

  if (items.length < 2) return 1;

  const touches = (A, B) => {
    const tA = A.kind === "trace", tB = B.kind === "trace";
    if (tA && tB)
      return A.trace.side === B.trace.side && tracesTouch(A.trace, B.trace);
    if (tA || tB){
      const tr = tA ? A.trace : B.trace, p = tA ? B : A;
      const thr = p.r + (tr.width||3)/2 + 2;
      for (let i=0;i<tr.points.length-1;i++)
        if (distToSeg(p.x, p.y, tr.points[i], tr.points[i+1]) <= thr) return true;
      return false;
    }
    // pad/via to pad/via: vias bridge sides; pins of different sides only meet via a shared hole position
    return Math.hypot(A.x-B.x, A.y-B.y) <= A.r + B.r;
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
