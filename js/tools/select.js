/* ===== tools-select.js — select tool, double-click, net rename, duplicate, overlap check ===== */
"use strict";

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
        // (adheres) when this anchor is moved again. SAME SIDE ONLY: a top and a bottom
        // anchor happening to coincide (e.g. both routed to a since-deleted THT pad) are
        // NOT a junction — copper on different layers only joins through a via/pad.
        const px = t.points[i].x, py = t.points[i].y;
        const jtol = Math.max((t.width||3)*0.6, 2/View.zoom) * (UI.snapFactor ? UI.snapFactor() : 1);
        const linked = [];
        for (const ot of State.traces){
          if (ot === t || ot.side !== t.side) continue;
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
    // grab a SEGMENT of the selected trace (away from any anchor) → slide it: an
    // axis-aligned segment moves perpendicular only (horizontal → up/down, vertical →
    // left/right), a diagonal one translates freely. Endpoints move together.
    const stol = (t.width||3)/2 + 6/View.zoom;
    for (let k=0;k<t.points.length-1;k++){
      const pr = projectOnSeg(w.x, w.y, t.points[k], t.points[k+1]);
      if (pr.d <= stol){
        pushUndo("move trace segment");
        const a = t.points[k], b = t.points[k+1];
        Tools.drag = { kind:"move-seg", trace:t, k, moved:false,
                       ax:a.x, ay:a.y, bx:b.x, by:b.y, wx:w.x, wy:w.y };
        requestRender();
        return;
      }
    }
  }
  let h = hitTest(w.x, w.y);
  // Shift-click semantics: a PAD → pin multi-select (bulk net assign); anywhere else on a
  // PART — its silk body, or a trace/via routed across it — → jump to the Schematic tab.
  // The pad test is tight (essentially on the pad), so the body-jump stays hittable on
  // EVERY part, not just small discretes: a click in the body gap, or a near-miss beside a
  // pad, falls through to the body. A shift-DRAG on a pad still detaches (resolved in
  // onPointerUp via shiftPin/d.moved).
  if (e.shiftKey){
    const padHit = padHitTight(w.x, w.y);
    if (padHit){
      const c = padHit.comp;
      if (compMoveLocked(c)){ UI.togglePinSel(c, padHit.pinIdx); requestRender(); return; }
      pushUndo();
      Tools.drag = { kind:"move-comp", comp:c, offX:w.x-c.x, offY:w.y-c.y, moved:false,
                     anchors:[], detach:true, shiftPin:{comp:c, pinIdx:padHit.pinIdx}, wx:w.x, wy:w.y };
      requestRender();
      return;
    }
    // precise body/pad first, then the full part extent (perimeter-pin ring, inter-pad
    // gaps) — so a shift-click anywhere on ANY part reaches the jump, not just parts with
    // a big silk gap. compExtentAt only kicks in where no precise body/pad is under the
    // cursor, so it rarely steals a click meant for a neighbour.
    const cb = compBodyAt(w.x, w.y) || compExtentAt(w.x, w.y);
    if (cb) h = { type:"comp", comp: cb };                 // body / part extent / trace-over-part → jump
    else if (h && h.type === "trace"){                     // bare trace → select its whole net
      UI.selectNetTraces(h.trace.netId);
      requestRender();
      return;
    }
  }
  // ctrl-click a trace → add/remove this segment from a multi-trace selection
  if ((e.ctrlKey || e.metaKey) && h && h.type === "trace"){
    UI.toggleTraceSel(h.trace);
    requestRender();
    return;
  }
  UI.select(h);
  if (!h){
    // drag from empty board = marquee/box select (mass-select an area); a plain click
    // that never drags just leaves the deselect above in place
    Tools.drag = { kind:"box-select", sx:w.x, sy:w.y, x:w.x, y:w.y, moved:false };
    requestRender(); return;
  }
  if (h.type === "comp" || h.type === "pin"){
    const c = h.comp;
    if (compMoveLocked(c)){
      // A move-locked part can't be DRAGGED — but a shift-click on its body is a JUMP, not
      // a move, and must still work. (The jump is normally emitted in onPointerUp off the
      // move-comp drag that the lock blocks — which is why pre-existing/locked parts, e.g.
      // an imported QFP, never jumped while freshly-placed unlocked parts did.)
      if (e && e.shiftKey && typeof SchEnabled === "function" && SchEnabled()){
        EditorTabs.show("schematic");
        Sch.focusComp(c);       // selects c on the board too (jump target)
      } else {
        UI.setHint(c.ref + " is move-locked — press " + Keymap.keyFor("edit.lock") + " to unlock");
      }
      requestRender(); return;
    }
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
    Tools.drag = { kind:"move-comp", comp:c, offX:w.x-c.x, offY:w.y-c.y, moved:false, anchors, detach, wx:w.x, wy:w.y };
  } else if (h.type === "via"){
    pushUndo();
    // grab every trace vertex sitting on the via so connected anchors move along with it;
    // Shift-drag detaches (leaves the trace behind)
    const detach = !!(e && e.shiftKey);
    const anchors = [];
    if (!detach){
      const vtol = Math.max(h.via.r || State.viaR, 6/View.zoom);
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
  // a pin marked no-connect can't take a net — unset NC first (right-click the pad)
  if (name && obj.type === "pin" && obj.comp.pins[obj.pinIdx] && obj.comp.pins[obj.pinIdx].nc){
    UI.toast(obj.comp.ref + "." + obj.comp.pins[obj.pinIdx].num + " is marked no-connect — unset NC first");
    done && done();
    return;
  }
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
      cancelUndo();
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

/* clear a pad/via/trace's net with a FIXED scope (context-menu items) — no scope dialog.
   scope "one" detaches just this object, "all" clears every object on the net. */
function clearNetScope(obj, scope){
  const oldId = objNetId(obj);
  if (!oldId) return;
  if (scope === "all"){
    const nm = getNet(oldId)?.name || "?";
    const cnt = netMembers(oldId).length;
    if (!confirm("Clear the whole net “" + nm + "”?\nThis removes the net from " + cnt + " object" + (cnt === 1 ? "" : "s") + " (undoable).")) return;
  }
  pushUndo(scope === "all" ? "clear whole net" : "clear net");
  if (scope === "all"){
    for (const c of State.components) for (const p of c.pins) if (p.netId === oldId) p.netId = null;
    for (const v of State.vias)   if (v.netId === oldId) v.netId = null;
    for (const t of State.traces) if (t.netId === oldId) t.netId = null;
  } else if (!assignNetToObject(obj, "", "one")){
    cancelUndo(); return;
  }
  pruneNets();
  UI.refreshNets(); UI.refreshInspector(); requestRender();
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

/* ---------- clipboard (Ctrl+C / Ctrl+V) ----------
   Copies the selected component; paste arms the component tool with a copy, so the
   ghost sticks to the cursor and a click places it — the exact mechanics of placing
   a new part (R rotates, B flips side, edge auto-scroll, Esc cancels). Nets are not
   copied (same as Duplicate). */
function copySelection(){
  // hard guard: copy/paste exist only in the Visual editor, never in Schematic/BOM
  if (typeof EditorTabs !== "undefined" && EditorTabs.current !== "visual") return;
  const c = UI.sel && UI.sel.comp;
  if (!c){ UI.toast("Select a component to copy (traces/vias can't be copied)"); return; }
  Tools.clipboard = {
    fpId: c.fpId, fpParams: JSON.parse(JSON.stringify(c.fpParams || {})),
    value: c.value || "", part: c.part || "", kicad: c.kicad || "",
    symOverride: c.symOverride || null,
    rot: c.rot || 0, side: c.side,
    refPrefix: (/^([A-Za-z]+)/.exec(c.ref) || [,"U"])[1],
  };
  UI.toast("Copied " + c.ref + " — Ctrl+V to place a copy");
}

function pasteClipboard(){
  const cb = Tools.clipboard;
  if (!cb){ UI.toast("Clipboard is empty — Ctrl+C a component first"); return; }
  if (typeof EditorTabs !== "undefined" && EditorTabs.current !== "visual") return;
  Tools.pending = {
    fpId: cb.fpId, fpParams: JSON.parse(JSON.stringify(cb.fpParams)),
    ref: "", value: cb.value, part: cb.part, kicad: cb.kicad,
    symOverride: cb.symOverride, refPrefix: cb.refPrefix,
  };
  Tools.ghostFp = generateFootprint(cb.fpId, Tools.pending.fpParams);
  Tools.ghostRot = cb.rot;
  Tools.ghostSide = cb.side;
  setTool("component");
  UI.setHint("Click to place the copied " + (Tools.ghostFp ? Tools.ghostFp.label : "part") + " — R rotate, B flip side, Esc cancel");
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
      if (pinEdgeDist(comp, fpin, v.x, v.y) <= (v.r||State.viaR) + 1) hitNet(v.netId, "via");
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
