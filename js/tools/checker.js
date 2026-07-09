/* ===== tools-checker.js — DRC-style checks + auto-connect on placement ===== */
"use strict";

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
      if (v.netId && pinEdgeDist(comp, fpin, v.x, v.y) <= (v.r||State.viaR) + 1){ net = v.netId; break; }
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
