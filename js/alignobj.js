/* ===== alignobj.js — align the multi-selected objects (right-click menu) =====
   Works in BOTH panes:
     • Visual    → marquee (box) selection of parts / vias / notes   (UI.boxSel)
     • Schematic → box-selected symbols                              (Sch.boxSel)
   Modes: "h" = all on one horizontal line (same Y), "v" = all on one vertical line (same X),
   "line" = project every object onto a line the user draws with two clicks.
   (Not to be confused with align.js, which aligns whole photo LAYERS.) */
"use strict";

const AlignObj = {
  line: null,          // active line-pick: { pane:"vis"|"sch", mode:"line", p1:{x,y}|null }

  /* ---- pure maths: new positions for a list of {x,y} ---- */
  solve(pts, mode, line){
    if (mode === "h"){ const y = pts.reduce((s, p) => s + p.y, 0) / pts.length; return pts.map(p => ({ x: p.x, y })); }
    if (mode === "v"){ const x = pts.reduce((s, p) => s + p.x, 0) / pts.length; return pts.map(p => ({ x, y: p.y })); }
    if (mode === "line"){
      const dx = line.b.x - line.a.x, dy = line.b.y - line.a.y, L2 = dx*dx + dy*dy;
      if (L2 < 1e-9) return pts.map(p => ({ x: p.x, y: p.y }));
      return pts.map(p => {
        const t = ((p.x - line.a.x) * dx + (p.y - line.a.y) * dy) / L2;
        return { x: line.a.x + t * dx, y: line.a.y + t * dy };
      });
    }
    return pts.map(p => ({ x: p.x, y: p.y }));
  },

  /* ================= Visual pane ================= */
  /* alignable objects of the box selection: {o, locked} — parts, vias, notes */
  visTargets(){
    const out = [];
    for (const s of (UI.boxSel || [])){
      if (s.type === "comp"){ if (!compMoveLocked(s.comp)) out.push({ kind:"comp", o:s.comp }); }
      else if (s.type === "via") out.push({ kind:"via", o:s.via });
      else if (s.type === "note") out.push({ kind:"note", o:s.note });
    }
    return out;
  },

  /* trace vertices sitting on a part's pads / on a via travel with it (same rule as dragging) */
  _anchorsFor(t){
    const anchors = [];
    if (t.kind === "comp"){
      const c = t.o, fp = compFootprint(c), ctol = 6 / View.zoom;
      const reachesAll = (fpin) => fpin.shape === "circle" && fpin.tht !== false;
      for (let pi = 0; pi < fp.pins.length; pi++){
        const fpin = fp.pins[pi]; if (!fpin) continue;
        const pinNet = c.pins[pi] ? c.pins[pi].netId : null;
        for (const tr of State.traces){
          if (!(reachesAll(fpin) || tr.side === c.side)) continue;
          if (tr.netId !== pinNet) continue;
          for (let i = 0; i < tr.points.length; i++)
            if (pinEdgeDist(c, fpin, tr.points[i].x, tr.points[i].y) <= ctol)
              anchors.push({ pts: tr.points, i, dx: tr.points[i].x - c.x, dy: tr.points[i].y - c.y });
        }
      }
    } else if (t.kind === "via"){
      const v = t.o, vtol = Math.max(v.r || State.viaR, 6 / View.zoom);
      for (const tr of State.traces){
        if (tr.netId !== v.netId) continue;
        for (let i = 0; i < tr.points.length; i++)
          if (Math.hypot(tr.points[i].x - v.x, tr.points[i].y - v.y) <= vtol)
            anchors.push({ pts: tr.points, i, dx: tr.points[i].x - v.x, dy: tr.points[i].y - v.y });
      }
    }
    return anchors;
  },

  visApply(mode, line){
    const ts = AlignObj.visTargets();
    if (ts.length < 2){ UI.toast("Select at least 2 objects first (drag a box)"); return false; }
    const next = AlignObj.solve(ts.map(t => ({ x: t.o.x, y: t.o.y })), mode, line);
    const anchors = ts.map(t => AlignObj._anchorsFor(t));        // gather BEFORE anything moves
    pushUndo("align objects");
    ts.forEach((t, i) => {
      t.o.x = next[i].x; t.o.y = next[i].y;
      for (const a of anchors[i]){ a.pts[a.i].x = t.o.x + a.dx; a.pts[a.i].y = t.o.y + a.dy; }
    });
    UI.refreshInspector(); requestRender();
    UI.toast("Aligned " + ts.length + " object" + (ts.length === 1 ? "" : "s") +
             (mode === "h" ? " horizontally" : mode === "v" ? " vertically" : " onto the line"));
    return true;
  },

  visMenuItems(){
    if (AlignObj.visTargets().length < 2) return [];
    return AlignObj._menu("vis");
  },

  /* ================= Schematic pane ================= */
  schTargets(){
    return (typeof Sch !== "undefined" && Sch.boxSel ? Sch.boxSel : [])
      .filter(c => typeof c.schX === "number" && !compSchMoveLocked(c));
  },

  schApply(mode, line){
    const ts = AlignObj.schTargets();
    if (ts.length < 2){ UI.toast("Box-select at least 2 symbols first"); return false; }
    const next = AlignObj.solve(ts.map(c => ({ x: c.schX, y: c.schY })), mode, line);
    pushUndo("align schematic symbols");
    ts.forEach((c, i) => {
      c.schX = schSnap(next[i].x); c.schY = schSnap(next[i].y);   // symbols live on the sheet grid
      schUpdateWiresFor(c);
    });
    schWarnForeignPinWires(ts);
    Sch.render();
    UI.toast("Aligned " + ts.length + " symbols" +
             (mode === "h" ? " horizontally" : mode === "v" ? " vertically" : " onto the line") + " (snapped to grid)");
    return true;
  },

  schMenuItems(){
    if (AlignObj.schTargets().length < 2) return [];
    return AlignObj._menu("sch");
  },

  /* ================= shared: menu + two-click line picker ================= */
  _menu(pane){
    const apply = pane === "vis" ? (m, l) => AlignObj.visApply(m, l) : (m, l) => AlignObj.schApply(m, l);
    return [
      { label: "Align horizontally (same Y)", action: () => apply("h") },
      { label: "Align vertically (same X)",   action: () => apply("v") },
      { label: "Align onto a drawn line…",    action: () => AlignObj.pickLine(pane) },
    ];
  },

  pickLine(pane){
    AlignObj.line = { pane, p1: null };
    UI.toast("Click the line's start point, then its end point — Esc cancels");
    AlignObj._redraw();
  },
  cancel(){ if (!AlignObj.line) return false; AlignObj.line = null; AlignObj._redraw(); UI.toast("Align cancelled"); return true; },

  /* a click while picking: p is in the pane's native coords (world px / schematic mm) */
  click(p){
    const L = AlignObj.line; if (!L) return false;
    if (!L.p1){ L.p1 = { x: p.x, y: p.y }; AlignObj._redraw(); return true; }
    const a = L.p1, b = { x: p.x, y: p.y }, pane = L.pane;
    AlignObj.line = null;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6){ UI.toast("Line has no length — cancelled"); AlignObj._redraw(); return true; }
    if (pane === "vis") AlignObj.visApply("line", { a, b }); else AlignObj.schApply("line", { a, b });
    AlignObj._redraw();
    return true;
  },
  _redraw(){ if (typeof requestRender === "function") requestRender(); if (typeof Sch !== "undefined" && Sch.requestRender) Sch.requestRender(); },

  /* rubber-band preview of the line being drawn */
  _drawLine(ctx, ax, ay, bx, by, lw){
    ctx.save();
    ctx.strokeStyle = "#ffb020"; ctx.fillStyle = "#ffb020"; ctx.lineWidth = lw; ctx.setLineDash([lw*4, lw*3]);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(ax, ay, lw*2.5, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  },
  drawVis(ctx){
    const L = AlignObj.line; if (!L || L.pane !== "vis" || !L.p1) return;
    const c = Tools.cursor || L.p1;
    AlignObj._drawLine(ctx, L.p1.x, L.p1.y, c.x, c.y, 2 / View.zoom);
  },
  drawSch(ctx){
    const L = AlignObj.line; if (!L || L.pane !== "sch" || !L.p1) return;
    const lp = Sch._lastP, c = lp ? { x: schS2X(lp.x), y: schS2Y(lp.y) } : L.p1;
    AlignObj._drawLine(ctx, schX2S(L.p1.x), schY2S(L.p1.y), schX2S(c.x), schY2S(c.y), 1.6);
  },
};

/* Esc cancels the line pick before any other Esc handler (deselect, tool off…) sees it */
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && AlignObj.line){ e.preventDefault(); e.stopImmediatePropagation(); AlignObj.cancel(); }
}, true);
