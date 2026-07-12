/* ===== view/hittest.js — hit testing + conductor snap + segment math ===== */
"use strict";

/* ---------- hit testing (world coords) ---------- */
function hitTest(wx, wy){
  const tol = 6 / View.zoom;
  // vias first — they get priority over pads (vias often sit inside pads)
  for (let i=State.vias.length-1; i>=0; i--){
    const v = State.vias[i];
    if (!viaVisible(v)) continue;   // a buried via you can't see here can't be grabbed here
    if (Math.hypot(wx-v.x, wy-v.y) <= (v.r||State.viaR) + tol*0.5)
      return { type:"via", via:v };
  }
  // pins next — only pads that are actually drawn on the current layer are grabbable:
  // a THT (round) pad reaches every copper side, an SMD (rect) pad only shows on its
  // own side (unless its body is visible here — X-ray / "both" / same side)
  for (let i=State.components.length-1; i>=0; i--){
    const c = State.components[i];
    if (Math.hypot(wx-c.x, wy-c.y) > compRadius(c) + tol) continue; // skip far parts entirely
    const s = State.pxPerMm * (c.scale||1);
    const fp = compFootprint(c);
    const smdShown = compBodyVisible(c);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      // when the body isn't shown here, only a true through-hole pad (round WITH a
      // drill) stays grabbable — a round SMD land (tht:false, e.g. a BGA ball) isn't
      // drawn on the far side (see drawComponent), so it must not catch clicks either
      if (!smdShown && !(fpin.shape === "circle" && fpin.tht !== false)) continue;
      if (pinEdgeDist(c, fpin, wx, wy) <= tol*0.9)
        return { type:"pin", comp:c, pinIdx:pi };
    }
  }
  // trace segments
  for (let i=State.traces.length-1; i>=0; i--){
    const t = State.traces[i];
    if (!traceVisible(t)) continue;
    for (let k=0; k<t.points.length-1; k++){
      if (distToSeg(wx,wy,t.points[k],t.points[k+1]) <= (t.width||3)/2 + tol)
        return { type:"trace", trace:t };
    }
  }
  // sticky notes — small markers, tested before big component bodies so they can be
  // grabbed, but after pads/vias/traces so they never obstruct real copper
  const noteR = 11 / View.zoom;
  for (let i=State.notes.length-1; i>=0; i--){
    const n = State.notes[i];
    if (Math.hypot(wx-n.x, wy-n.y) <= noteR)
      return { type:"note", note:n };
  }
  // component bodies (hidden-side bodies are not clickable, their pads above still are)
  for (let i=State.components.length-1; i>=0; i--){
    const c = State.components[i];
    if (!compBodyVisible(c)) continue;
    if (pointInComp(c, wx, wy))
      return { type:"comp", comp:c };
  }
  return null;
}

/* topmost visible component whose BODY contains the point — regardless of what
   hitTest would return first (used so shift-click reaches a part through the
   traces/vias routed across its body) */
function compBodyAt(wx, wy){
  for (let i=State.components.length-1; i>=0; i--){
    const c = State.components[i];
    if (!compBodyVisible(c)) continue;
    if (pointInComp(c, wx, wy)) return c;
  }
  return null;
}

function distToSeg(px,py,a,b){
  const dx=b.x-a.x, dy=b.y-a.y;
  const len2 = dx*dx+dy*dy;
  let t = len2 ? ((px-a.x)*dx+(py-a.y)*dy)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px-(a.x+dx*t), py-(a.y+dy*t));
}

/* snap to nearest pin/via/trace within radius; returns {x,y,netId,attach} or null.
   traceSide: copper side being drawn ("front"/"back"/"inner1"…). Pads only snap if
   they're reachable from that side — through-hole pads (circles) reach every layer,
   SMD pads only their own side. "any" (via tool) snaps to everything;
   omitted/null disables trace snapping. */
function snapToConductor(wx, wy, traceSide, tightTrace, traceWidth, exclude){
  // user-set snap distance multiplier (Options → Input & snap) scales every reach below
  const sf = (typeof UI !== "undefined" && UI.snapFactor) ? UI.snapFactor() : 1;
  const tol = 8 * sf / View.zoom;         // vias
  const traceTol = 42 * sf / View.zoom;   // generous reach for dragging an anchor onto a trace
  // when a trace width is supplied (drawing / moving an anchor) pads only snap when the
  // cursor is right at the pad CENTRE — no edge grabbing. The reach scales with the pad's
  // own size, clamped to 0.5×…2× the trace width, so tiny pads snap tight while big pads
  // (where the centre is far from where you click) still grab from up to 2× the width.
  const padCenter = !!traceWidth;
  let best = null, bestD = Infinity;
  const filterPads = traceSide && traceSide !== "any";
  // widest distance a pad can still snap from, so a component whose bounding circle is
  // farther than that from the cursor can be skipped without touching its pads
  const padReach = padCenter ? Math.max(tol, (traceWidth || 0) * 2 * sf) : tol;
  for (const c of State.components){
    if (Math.hypot(wx - c.x, wy - c.y) > compRadius(c) + padReach) continue; // quick reject
    const fp = compFootprint(c);
    const s = State.pxPerMm * (c.scale || 1);
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi];
      if (!fpin) continue;   // comp.pins can outnumber fp.pins (freestyle / regen) — guard
      // skip pads not reachable from this copper side. Only a true through-hole pad
      // (round WITH a drill) reaches every side; a round SMD land (tht:false, e.g. a test
      // point) lives on its own side just like a rectangular SMD pad.
      if (filterPads && !(fpin.shape === "circle" && fpin.tht !== false) && c.side !== traceSide) continue;
      let wp = null, d, ptol;
      if (padCenter){
        wp = pinWorldPos(c, fpin); d = Math.hypot(wx-wp.x, wy-wp.y);     // to pad centre
        const padR = Math.min(fpin.w, fpin.h) * s / 2;                   // pad's narrow half-extent
        ptol = Math.max(traceWidth * 0.5, Math.min(padR, traceWidth * 2)) * sf;
      } else { d = pinEdgeDist(c, fpin, wx, wy); ptol = tol; }            // to pad edge (via tool)
      if (d <= ptol && d < bestD){ if (!wp) wp = pinWorldPos(c, fpin); bestD=d; best={x:wp.x,y:wp.y,attach:{type:"pin",comp:c,pinIdx:pi},netId:c.pins[pi].netId}; }
    }
  }
  for (const v of State.vias){
    if (filterPads && !viaOnSide(v, traceSide)) continue;  // blind via doesn't reach this copper side
    const d = Math.hypot(wx-v.x, wy-v.y);
    // a via is a small, discrete target: if the cursor is anywhere on its copper ring it
    // should snap — whether DRAWING a trace onto it or dragging an anchor over it. So the
    // reach is the via's own radius (plus the small fixed tol), even in tight-draw mode.
    // Otherwise a large via/PTH would only connect on its tiny inner hole, not its ring.
    const vtol = Math.max(tol, (v.r || State.viaR || 0) * sf);
    if (d <= vtol && d < bestD){ bestD=d; best={x:v.x,y:v.y,attach:{type:"via",via:v},netId:v.netId}; }
  }
  if (traceSide){
    // when drawing (tightTrace) only snap within the nearby trace's own width, so a far
    // trace doesn't grab the cursor; dragging an anchor keeps the generous reach. A
    // pad/via still wins only when it is actually closer than the chosen trace.
    let tBest = null, tBestD = Infinity;
    for (const t of State.traces){
      if (exclude && (exclude === t || (exclude.has && exclude.has(t)))) continue;
      if (traceSide !== "any" && t.side !== traceSide) continue;
      // never snap onto a trace that isn't currently drawn (hidden, or on a copper side
      // that's filtered out by the trace-view setting) — X-ray shows all, so it snaps there
      if (!traceVisible(t)) continue;
      const ttol = tightTrace ? ((t.width||3)/2 + 2/View.zoom) * sf : traceTol;
      for (let k=0; k<t.points.length-1; k++){
        const pr = projectOnSeg(wx, wy, t.points[k], t.points[k+1]);
        if (pr.d <= ttol && pr.d < tBestD){
          tBestD = pr.d;
          tBest = { x:pr.x, y:pr.y, attach:{type:"trace", trace:t, seg:k}, netId:t.netId };
        }
      }
    }
    if (tBest && (!best || tBestD < bestD)) best = tBest;
  }
  return best;
}

function projectOnSeg(px, py, a, b){
  const dx=b.x-a.x, dy=b.y-a.y;
  const len2 = dx*dx+dy*dy;
  let t = len2 ? ((px-a.x)*dx+(py-a.y)*dy)/len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x+dx*t, y = a.y+dy*t;
  return { x, y, d: Math.hypot(px-x, py-y) };
}

function segsIntersect(a,b,c,d){
  const o = (p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
  const o1=o(a,b,c), o2=o(a,b,d), o3=o(c,d,a), o4=o(c,d,b);
  return ((o1>0)!==(o2>0)) && ((o3>0)!==(o4>0));
}

function minSegDist(a,b,c,d){
  if (segsIntersect(a,b,c,d)) return 0;
  return Math.min(
    distToSeg(c.x,c.y,a,b), distToSeg(d.x,d.y,a,b),
    distToSeg(a.x,a.y,c,d), distToSeg(b.x,b.y,c,d));
}

/* true when the COPPER of two traces genuinely overlaps — a physical short test used by
   the design checker. Fires on a real crossing, or when a vertex/endpoint of one trace
   sits on the other's copper (within its half width). This catches an anchor dropped on
   another trace's centre-line, a T-junction at an interior vertex, and one trace lying
   over another, WITHOUT flagging parallel traces that merely run edge-to-edge (their
   centre-lines stay farther apart than a half width). */
function tracesOverlap(a, b){
  // a real geometric crossing
  for (let i=0; i<a.points.length-1; i++)
    for (let k=0; k<b.points.length-1; k++)
      if (segsIntersect(a.points[i], a.points[i+1], b.points[k], b.points[k+1])) return true;
  // a vertex of one trace lying on the other's copper (centre-line within its half width)
  const onCopper = (pts, other, halfW) => {
    for (const p of pts)
      for (let k=0; k<other.points.length-1; k++)
        if (distToSeg(p.x, p.y, other.points[k], other.points[k+1]) <= halfW) return true;
    return false;
  };
  return onCopper(a.points, b, (b.width||3)/2) || onCopper(b.points, a, (a.width||3)/2);
}

/* true when two traces genuinely connect (same-side check is the caller's job):
   a real geometric crossing, coincident endpoints (a shared junction), or one
   trace's endpoint landing on the INTERIOR of the other (a T-junction).
   Deliberately NOT a side-by-side distance test, so parallel traces running
   close together — even with aligned endpoints — are never merged. */
function tracesTouch(t1, t2){
  const tol = Math.max(2, Math.min((t1.width||3), (t2.width||3)) * 0.6);
  // actual crossings
  for (let i=0; i<t1.points.length-1; i++)
    for (let k=0; k<t2.points.length-1; k++)
      if (segsIntersect(t1.points[i], t1.points[i+1], t2.points[k], t2.points[k+1]))
        return true;
  const ends1 = [t1.points[0], t1.points[t1.points.length-1]];
  const ends2 = [t2.points[0], t2.points[t2.points.length-1]];
  // coincident endpoints
  for (const a of ends1) for (const b of ends2)
    if (Math.hypot(a.x-b.x, a.y-b.y) <= tol) return true;
  // endpoint on the other's interior (exclude the other's endpoints)
  const onInterior = (e, t) => {
    for (let k=0; k<t.points.length-1; k++){
      const pr = projectOnSeg(e.x, e.y, t.points[k], t.points[k+1]);
      if (pr.d > tol) continue;
      const segLen = Math.hypot(t.points[k+1].x-t.points[k].x, t.points[k+1].y-t.points[k].y) || 1;
      const dStart = Math.hypot(pr.x-t.points[k].x, pr.y-t.points[k].y);
      const dEnd   = segLen - dStart;
      if (dStart > tol && dEnd > tol) return true; // genuinely mid-segment
    }
    return false;
  };
  for (const e of ends1) if (onInterior(e, t2)) return true;
  for (const e of ends2) if (onInterior(e, t1)) return true;
  return false;
}

