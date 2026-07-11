/* ===== tools-via.js — via / PTH tool, via drop, anchor helpers, net-merge prompts ===== */
"use strict";

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

/* first via (other than `via`) whose copper actually overlaps `via` (centres closer than
   the sum of the two radii — i.e. the discs cross, not merely touch) */
function firstViaOverlap(via){
  for (const o of State.vias){
    if (o === via) continue;
    if (Math.hypot(o.x-via.x, o.y-via.y) < (via.r||State.viaR) + (o.r||State.viaR)) return o;
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

/* ---------------- via / PTH tool ---------------- */
function viaDown(w, e){
  const pth = e.altKey;          // Alt-click = plated through hole (mounting/component hole)
  const newR = pth ? Math.round(State.viaR*1.8) : State.viaR;
  // don't let a new via overlap an existing one: block when the discs would cross (centre
  // distance < sum of radii). Edges may still touch.
  for (const v of State.vias){
    if (Math.hypot(w.x-v.x, w.y-v.y) < (v.r||State.viaR) + newR){
      UI.toast("There is already a " + (v.kind==="pth"?"PTH":"via") + " here"); return;
    }
  }
  pushUndo(pth ? "place PTH" : "place via");
  // Shift disables snapping (free placement) — but the via still inherits a net (from a
  // nearby trace / the picked lastViaNet). Use the V-key picker to clear/re-pick the net.
  const snap = e.shiftKey ? null : snapToConductor(w.x, w.y, "any");
  let netId = snap ? snap.netId : null;
  if (!netId){
    // sitting on a pad / via / trace (matters most when Shift skipped the snap) → inherit its net
    const h = hitTest(w.x, w.y);
    if (h && h.type === "trace") netId = h.trace.netId;
    else if (h && h.type === "pin") netId = h.comp.pins[h.pinIdx].netId;
    else if (h && h.type === "via") netId = h.via.netId;
  }
  // reuse the picked / last via net for stitching multiple vias — unless PTH.
  // (Use the V-key picker to clear or re-pick this net — see viaNetPick.)
  if (!netId && !pth && Tools.lastViaNet){
    const t = findNetByName(Tools.lastViaNet) || findNetByName(Tools.lastViaNet.toUpperCase()) || createNet(Tools.lastViaNet);
    netId = t.id;
  }
  const via = {
    id: nextId(), x: snap?snap.x:w.x, y: snap?snap.y:w.y, netId: netId||null,
    r: newR,
    hole: pth ? Math.round(State.viaHole*1.8) : State.viaHole,   // drill radius (px); retained default
    kind: pth ? "pth" : "via",
  };
  State.vias.push(via);
  anchorTracesUnderVia(via);   // placed on a trace mid-segment → split it so the trace adheres
  if (netId && !pth) Tools.lastViaNet = getNet(netId)?.name || Tools.lastViaNet; // remember
  UI.select({type:"via", via});
  pruneNets();
  requestRender();
}

/* Pressing the via-tool key (V) again acts as a net picker: if the cursor is over a
   pad / via / trace, adopt that copper's net as the net for the NEXT vias placed;
   over empty board it clears the pending net so new vias start unnetted. */
function viaNetPick(){
  const w = Tools.cursor;
  let over = false, netId = null, overVia = null;
  if (w){
    // check for a via under the cursor first so probing one copies its size + drill too
    const h = hitTest(w.x, w.y);
    if (h && h.type === "via") overVia = h.via;
    const snap = snapToConductor(w.x, w.y, "any");
    if (snap && snap.attach){ over = true; netId = snap.netId; }
    else if (h && h.type === "pin"){ over = true; netId = h.comp.pins[h.pinIdx].netId; }
    else if (h && h.type === "via"){ over = true; netId = h.via.netId; }
    else if (h && h.type === "trace"){ over = true; netId = h.trace.netId; }
  }
  // probing an existing via adopts its physical size (and drill, if it carries one) as the
  // defaults for the next vias placed — not just its net
  if (overVia){
    State.viaR = overVia.r || State.viaR;
    if (overVia.hole != null) State.viaHole = overVia.hole;
  }
  if (over && netId){
    Tools.lastViaNet = getNet(netId)?.name || null;
    const sizeTxt = overVia ? " · size " + (State.viaR*2/State.pxPerMm).toFixed(2) + " mm" : "";
    UI.toast("Via net picked → “" + (Tools.lastViaNet || "?") + "”" + sizeTxt + " (new vias match)");
  } else if (overVia){
    UI.toast("Via size picked → " + (State.viaR*2/State.pxPerMm).toFixed(2) + " mm (new vias match)");
  } else {
    Tools.lastViaNet = null;
    UI.toast("Via net cleared — new vias start unnetted");
  }
  UI.refreshInspector();
  requestRender();
}
