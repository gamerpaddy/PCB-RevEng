/* ===== tools-trace.js — trace tool, welding, connectivity clusters, disconnect ===== */
"use strict";

/* Constrain (x,y) so the segment from `prev` runs at the nearest multiple of 45°.
   Uses perpendicular projection onto that ray so the point stays close to the cursor. */
function traceAngleSnap(prev, x, y){
  const dx = x - prev.x, dy = y - prev.y;
  if (Math.hypot(dx, dy) < 1e-6) return { x, y };
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  const proj = Math.max(0, dx * Math.cos(ang) + dy * Math.sin(ang));   // length along the ray
  return { x: prev.x + Math.cos(ang) * proj, y: prev.y + Math.sin(ang) * proj };
}

/* The point a trace click/preview should land on: a conductor snap always wins;
   otherwise, when angle-snap is on and a segment is in progress, constrain to 45°. */
function tracePointAt(w, snap){
  if (snap) return { x:snap.x, y:snap.y };
  if (Tools.angleSnap && Tools.tracePts && Tools.tracePts.length)
    return traceAngleSnap(Tools.tracePts[Tools.tracePts.length-1], w.x, w.y);
  return { x:w.x, y:w.y };
}

/* Where the live rubber-band endpoint should be drawn (uses the hover snap in Tools.snap). */
function traceCursorPoint(){ return tracePointAt(Tools.cursor, Tools.snap); }

function traceDown(w, e){
  // Shift = free placement: don't snap this point to a conductor (mirrors the via tool's
  // reserved use of Shift-to-disable-snap)
  const snap = e.shiftKey ? null : snapToConductor(w.x, w.y, Tools.tracePts ? Tools.traceSide : UI.copperSide(), true, State.traceW);
  const p = tracePointAt(w, snap);
  if (!Tools.tracePts){
    Tools.tracePts = [p];
    Tools.traceStartSnap = snap;
    Tools.traceSide = UI.copperSide();
    // Starting on an existing trace adopts ITS width for this drawn trace, without
    // touching State.traceW (your default for new traces). Shift+W overrides it live.
    Tools.traceWidth = (snap && snap.attach && snap.attach.type === "trace" && snap.attach.trace.width)
      ? snap.attach.trace.width : State.traceW;
    const netNote = snap && snap.netId ? " — continuing net “" + (getNet(snap.netId)?.name || "?") + "”" : "";
    UI.setHint("Routing on " + SIDE_LABELS[Tools.traceSide] + netNote + " — " + UI.traceWidthLabel(Tools.traceWidth) +
      " (Shift+W) · click to add points, Enter/double-click to finish, Esc to cancel");
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
  Tools.tracePts = null; Tools.traceStartSnap = null; Tools.traceWidth = null;
  UI.setHint(TOOL_HINTS.trace);
  UI.refreshNets(); requestRender();
  // join any touching same-side trace; different-net crossings prompt A→B/B→A (async)
  if (!opts.skipAttach) mergeIntersectingTraces(trace);
}

/* Change the drawing width MID-ROUTE without re-widthing the part already drawn.
   A trace polyline has a single width, so we finalize the segment routed so far (at the
   current width) as its own trace and keep routing from the last anchor at the NEW width —
   the two share that anchor + net, so it reads as one continuous track of two widths.
   With no segment placed yet (only the start point) we simply adopt the new width. */
function changeTraceWidthWhileDrawing(px){
  let pts = Tools.tracePts;
  if (!pts) return;
  pts = pts.filter((p,i) => !i || Math.hypot(p.x-pts[i-1].x, p.y-pts[i-1].y) > 0.5);
  if (pts.length < 2){ Tools.tracePts = pts; Tools.traceWidth = px; requestRender(); return; }

  const sSnap = Tools.traceStartSnap;
  pushUndo("trace width change");
  const netId = (sSnap && sSnap.netId) ? sSnap.netId : createNet().id;
  applyAttach(sSnap, netId);
  const committed = weldOrCreateTrace(pts, Tools.traceSide, netId, sSnap, null); // width = current Tools.traceWidth

  // continue a fresh segment from the last anchor at the new width, wired to the committed copper
  const end = pts[pts.length-1];
  Tools.tracePts = [{ x:end.x, y:end.y }];
  Tools.traceStartSnap = { x:end.x, y:end.y, netId, attach:{ type:"trace", trace:committed, seg:0 } };
  Tools.traceWidth = px;
  UI.refreshNets();
  UI.setHint("Routing on " + SIDE_LABELS[Tools.traceSide] + " — " + UI.traceWidthLabel(px) +
    " (Shift+W) · width changed; earlier part kept — click to add points, Enter/double-click to finish");
  requestRender();
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
  const drawW = Tools.traceWidth || State.traceW;
  let sm = traceEndpointSnap(sSnap, side);
  let em = traceEndpointSnap(endSnap, side);
  if (sm && em && sm.trace === em.trace && sm.end === em.end) em = null; // same spot, ignore
  // Only weld into a host of the SAME width. When you changed the width mid-draw (Shift+W),
  // the drawn width differs from the host's — keep it a separate trace so the chosen width
  // survives (it still shares the junction + net via mergeIntersectingTraces).
  const wDiff = (m) => m && Math.abs((m.trace.width || State.traceW) - drawW) > 0.01;
  if (wDiff(sm)) sm = null;
  if (wDiff(em)) em = null;

  if (!sm && !em){
    const t = { id:nextId(), side, netId, points: pts.map(p=>({x:p.x,y:p.y})), width: drawW };
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
  Tools.tracePts = null; Tools.traceStartSnap = null; Tools.traceWidth = null;
  UI.setHint(TOOL_HINTS.trace);
  requestRender();
}
