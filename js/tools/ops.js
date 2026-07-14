/* ===== tools-ops.js — component/measure/note/cut tools, delete/rotate/flip, pads, locks ===== */
"use strict";

/* ---------------- component tool ---------------- */
function componentDown(w, e){
  // no footprint armed → the experimental quick-add popup (if enabled) or the selector;
  // Shift-click always opens the full footprint selector, even with quick-add on
  if (!Tools.pending){
    if (!QuickAdd.enabled() || (e && e.shiftKey)) UI.openFootprintDialog(); else QuickAdd.open(w);
    return;
  }
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
    symOverride: p.symOverride || null,
    pins: fp.pins.map(fpin => ({ num:fpin.num, name:fpin.name||"", netId:null })),
  };
  // a concrete symbol pick fills in its standard pin names
  if (comp.symOverride && comp.symOverride !== "box") applySymPinNames(comp, comp.symOverride);
  // a pasted copy carries the source part's pin names + nets (matched by pin number)
  if (p.pinData){
    const byNum = new Map(p.pinData.map(pd => [String(pd.num), pd]));
    for (const cp of comp.pins){
      const pd = byNum.get(String(cp.num));
      if (pd){ if (pd.name) cp.name = pd.name; if (pd.netId != null) cp.netId = pd.netId; }
    }
  }
  State.components.push(comp);
  autoConnectPins(comp);   // pins dropped on existing copper inherit its net (e.g. plated mounting hole over a trace)
  p.ref = ""; // subsequent placements auto-number
  UI.select({type:"comp", comp});
  UI.toast("Placed " + ref + " (" + fp.label + ")");
  requestRender();
}

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
  if (!sel){
    // Delete on a box (marquee) selection = mass-delete every object inside the area
    if (UI.boxSel && UI.boxSel.length){
      deleteBoxSelection();
      return;
    }
    // Delete on a ctrl/shift multi-trace selection = the inspector's "Delete all"
    if (UI.traceSel.length){
      pushUndo("delete " + UI.traceSel.length + " traces");
      State.traces = State.traces.filter(t => !UI.traceSel.includes(t));
      UI.traceSel = [];
      pruneNets();
      UI.select(null); UI.refreshNets(); requestRender();
    } else if (UI.pinSel.length){
      // Delete on a shift-click multi-pin selection clears each pad's net (mirrors single-pad Delete)
      pushUndo("clear net on " + UI.pinSel.length + " pins");
      for (const p of UI.pinSel) p.comp.pins[p.pinIdx].netId = null;
      UI.pinSel = [];
      pruneNets();
      UI.select(null); UI.refreshNets(); UI.refreshInspector(); requestRender();
    }
    return;
  }
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
    if (typeof schForgetComp === "function") schForgetComp(sel.comp.id);   // drop its schematic wires/labels
  } else if (sel.type === "via"){
    State.vias = State.vias.filter(v => v !== sel.via);
    pruneCollinearAnchors(sel.via.x, sel.via.y);   // drop the anchor vertex the via added, if still straight
  } else if (sel.type === "trace"){
    State.traces = State.traces.filter(t => t !== sel.trace);
  } else if (sel.type === "note"){
    State.notes = State.notes.filter(n => n !== sel.note);
  }
  pruneNets();
  UI.select(null);
  UI.refreshNets(); requestRender();
}

/* mass-delete every object in the box (marquee) selection. Edit-locked components are
   skipped and left selected so nothing is removed behind a lock. */
function deleteBoxSelection(){
  const items = UI.boxSel;
  const comps = items.filter(s => s.type==="comp").map(s => s.comp);
  const locked = comps.filter(compEditLocked);
  const delComps = new Set(comps.filter(c => !compEditLocked(c)));
  const delVias  = new Set(items.filter(s => s.type==="via").map(s => s.via));
  const delTraces= new Set(items.filter(s => s.type==="trace").map(s => s.trace));
  const delNotes = new Set(items.filter(s => s.type==="note").map(s => s.note));
  const total = delComps.size + delVias.size + delTraces.size + delNotes.size;
  if (!total){ UI.toast(locked.length ? "All boxed parts are edit-locked" : "Nothing to delete"); return; }
  pushUndo("delete " + total + " objects");
  if (delComps.size){
    State.components = State.components.filter(c => !delComps.has(c));
    if (typeof schForgetComp === "function") for (const c of delComps) schForgetComp(c.id);   // drop their schematic wires/labels
  }
  if (delVias.size){
    State.vias = State.vias.filter(v => !delVias.has(v));
    for (const v of delVias) pruneCollinearAnchors(v.x, v.y);
  }
  if (delTraces.size) State.traces = State.traces.filter(t => !delTraces.has(t));
  if (delNotes.size) State.notes = State.notes.filter(n => !delNotes.has(n));
  UI.boxSel = [];
  pruneNets();
  UI.select(null);
  UI.refreshNets(); UI.refreshInspector(); requestRender();
  UI.toast("Deleted " + total + " object" + (total===1?"":"s") + (locked.length ? " (" + locked.length + " locked kept)" : ""));
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
      // a through-hole pad (round WITH a drill) reaches every copper layer; an SMD pad
      // — rect, or a round land with tht:false (BGA ball / test point) — is copper on
      // its component side only. fpin lets us test the real pad shape.
      items.push({ kind:"pin", comp:c, pi, fpin, x:wp.x, y:wp.y, r: Math.max(fpin.w, fpin.h)*s/2,
                   thru: fpin.shape === "circle" && fpin.tht !== false, side: c.side });
    }
  }
  for (const v of State.vias)
    if (v.netId === netId) items.push({ kind:"via", via:v, x:v.x, y:v.y, r:(v.r||State.viaR), thru:true, side:null });
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
                            : Math.max(0, pr.d - (p.r||State.viaR));
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
    return dA <= (B.r || State.viaR) || dB <= (A.r || State.viaR);
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
  // schematic wires drawn on the old net follow their anchor pin to whatever net it now
  // carries (a branch wire with no anchor keeps the largest island's net — best available)
  if (State.schWires) for (const w of State.schWires){
    if (w.netId !== netId) continue;
    const an = w.a || w.b;
    if (!an) continue;
    const cc = getComp(an.comp), np = cc && cc.pins[an.pin];
    if (np && np.netId) w.netId = np.netId;
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
  // Schematic wires/labels anchor to a pin by INDEX (w.a/w.b = {comp,pin}, label.pin).
  // The splice shifts every higher pin down one, so without fixing them up a wire/label
  // would silently rebind to a DIFFERENT pin (wrong net + wrong position). Drop the ones
  // on the removed pad and decrement every anchor above it.
  if (State.schWires && State.schWires.length){
    State.schWires = State.schWires.filter(w =>
      !(w.a && w.a.comp === comp.id && w.a.pin === idx) &&
      !(w.b && w.b.comp === comp.id && w.b.pin === idx));
    for (const w of State.schWires){
      if (w.a && w.a.comp === comp.id && w.a.pin > idx) w.a.pin--;
      if (w.b && w.b.comp === comp.id && w.b.pin > idx) w.b.pin--;
    }
  }
  if (State.schLabels && State.schLabels.length){
    State.schLabels = State.schLabels.filter(l => !(l.comp === comp.id && l.pin === idx));
    for (const l of State.schLabels) if (l.comp === comp.id && l.pin > idx) l.pin--;
  }
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
/* independent lock for the SCHEMATIC symbol's position (schX/schY) — the board part's
   own move-lock is separate so you can pin a symbol on the sheet without freezing the pad */
function compSchMoveLocked(c){ return !!c.schLockMove; }

function toggleLockSelection(){
  // in the schematic tab the lock pins the SYMBOL, not the board part — and a box
  // selection locks/unlocks every symbol in it together
  if (typeof EditorTabs !== "undefined" && EditorTabs.current === "schematic"){
    const box = (typeof Sch !== "undefined" && Sch.boxSel && Sch.boxSel.length) ? Sch.boxSel.slice() : null;
    if (box){
      pushUndo();
      const lockAll = box.some(x => !x.schLockMove);   // any unlocked → lock all; else unlock all
      for (const x of box) x.schLockMove = lockAll;
      UI.toast(box.length + " symbol" + (box.length===1?"":"s") + (lockAll ? " locked 🔒" : " unlocked"));
      UI.refreshInspector();
      if (typeof Sch !== "undefined") Sch.render();
      return;
    }
    const c = UI.sel && UI.sel.comp;
    if (!c) return;
    pushUndo();
    c.schLockMove = !c.schLockMove;
    UI.toast(c.ref + (c.schLockMove ? " symbol locked 🔒" : " symbol unlocked"));
    UI.refreshInspector();
    if (typeof Sch !== "undefined") Sch.render();
    return;
  }
  const c = UI.sel && UI.sel.comp;
  if (!c) return;
  pushUndo();
  migrateLock(c);
  c.lockMove = !c.lockMove;
  UI.toast(c.ref + (c.lockMove ? " move-locked 🔒" : " move unlocked"));
  UI.refreshInspector(); requestRender();
}
