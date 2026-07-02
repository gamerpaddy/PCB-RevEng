/* ===== main.js — bootstrap, events, hotkeys, file I/O ===== */
"use strict";

const Keys = { space:false };

/* autosave (IndexedDB) lives in autosave.js — autosaveInit, markDirty,
   markImagesDirty, loadDefaultProject, updateSaveStatus, etc. are defined there */

window.addEventListener("DOMContentLoaded", () => {
  restorePanelWidths();                 // apply the saved panel widths BEFORE the canvas is sized
  viewInit(document.getElementById("canvas"));
  Keymap.load();
  UI.updateHotkeyHints();
  UI.buildHelp();
  UI.refreshLayerList();
  UI.refreshNets();
  UI.refreshInspector();
  setTool("select");
  View.panX = View.width/2; View.panY = View.height/2;

  UI.rebuildSideSelect();
  wireToolbar();
  wireCanvas();
  wireDialogs();
  wireKeyboard();
  wireFiles();
  wireSettings();
  wirePanelResizer("#right-resizer", "#right-panel", "pcbreveng.inspW", "right");
  wirePanelResizer("#left-resizer",  "#left-panel",  "pcbreveng.leftW",  "left");
  Resolver.wire();
  UI.wireFpSearch();
  UI.wireNetSearch();
  UI.wirePartSearch();
  autosaveInit();
  window.addEventListener("resize", viewResize);
  requestRender();
});

/* ---------------- toolbar ---------------- */
function wireToolbar(){
  document.querySelectorAll("#toolbar .tool").forEach(b =>
    b.addEventListener("click", () => setTool(b.dataset.tool)));

  $("#btn-flip").addEventListener("click", toggleFlip);
  $("#btn-mask").addEventListener("click", toggleMask);
  $("#btn-options").addEventListener("click", ()=>{ syncSettings(); $("#options-dialog").showModal(); });
  $("#btn-undo").addEventListener("click", ()=>{ if (undo()) afterHistory(); });
  $("#btn-redo").addEventListener("click", ()=>{ if (redo()) afterHistory(); });
  $("#btn-help").addEventListener("click", ()=> $("#help-dialog").showModal());

  $("#btn-new").addEventListener("click", ()=>{
    if (!confirm("Start a new project? Unsaved work will be lost.")) return;
    resetProject(); UI.select(null); UI.activeLayerId = null;
    if (Autosave.db){ idbDel("autosave"); idbDel("autosave_imgs"); idbDel("autosave_undo"); idbDel("autosave_meta"); }
    Autosave.dirty = false; Autosave.lastSaved = null; updateSaveStatus();
    UI.rebuildSideSelect(); syncSettings();
    UI.refreshLayerList(); UI.refreshNets(); requestRender();
  });
  $("#btn-save").addEventListener("click", saveProject);
  $("#btn-open").addEventListener("click", ()=> $("#file-project").click());
  $("#btn-export").addEventListener("click", ()=> UI.openExport());
  $("#btn-bom").addEventListener("click", ()=> UI.openBomEditor());
  $("#btn-add-layer").addEventListener("click", ()=> $("#file-images").click());
  $("#btn-add-url").addEventListener("click", ()=> {
    const inp = $("#url-input");
    if (inp) inp.value = "";
    $("#url-dialog").showModal();
    if (inp) inp.focus();
  });
  $("#draw-side").addEventListener("change", e => {
    Tools.lastCopperSide = e.target.value;
    // in split view, the draw side controls the focused pane's trace/copper side
    if (View.split){
      const which = View.cursorPane || "left";
      View.paneSide[which] = e.target.value;
      UI.toast((which==="right"?"Right":"Left") + " view showing " + (SIDE_LABELS[e.target.value]||e.target.value) + " copper");
      UI.refreshSplitControls();
    }
    requestRender(); // visibility follows active side
  });
  $("#btn-xray").addEventListener("click", toggleXray);
  $("#btn-split").addEventListener("click", toggleSplit);
  $("#btn-ratsnest").addEventListener("click", toggleRatsnest);
  $("#btn-hidetraces").addEventListener("click", toggleHideTraces);
  $("#btn-stack3d").addEventListener("click", ()=> Stack3D.open());
  $("#btn-measure").addEventListener("click", ()=> setTool("measure"));
  $("#btn-calibrate").addEventListener("click", ()=> setTool("calibrate"));
  $("#btn-deskew").addEventListener("click", ()=> startLineDeskew());
  $("#btn-history").addEventListener("click", ()=> UI.openHistory());
  $("#btn-check").addEventListener("click", ()=> UI.openChecker());
}

function toggleFlip(){
  // keep the world point at screen centre fixed
  const c = screenToWorld(View.width/2, View.height/2);
  View.flip = !View.flip;
  const s = worldToScreen(c.x, c.y);
  View.panX += View.width/2 - s.x;
  $("#btn-flip").classList.toggle("active", View.flip);
  UI.setStatusPos(c);
  UI.toast(View.flip ? "Viewing board from the BACK" : "Viewing board from the FRONT");
  requestRender();
}

function toggleMask(){
  View.mask = !View.mask;
  $("#btn-mask").classList.toggle("active", View.mask);
  UI.toast(View.mask ? "Coverage mask ON — red tint = no components placed there yet" : "Coverage mask off");
  requestRender();
}

function toggleHideTraces(){
  View.hideTraces = !View.hideTraces;
  $("#btn-hidetraces").classList.toggle("active", View.hideTraces);
  UI.toast(View.hideTraces ? "Traces hidden — pads, vias & photo only (traces are non-selectable while hidden)" : "Traces shown");
  requestRender();
}

/* the Ratsnest button cycles Off → Net (MST over the whole net) → Star (spokes from the
   selected pad to every connected pad) → Off */
function toggleRatsnest(){
  const btn = $("#btn-ratsnest");
  if (!View.ratsnest){                    // off → net (MST)
    View.ratsnest = true; View.ratsnestMode = "mst";
    UI.toast("Ratsnest: Net — airwires link every same-net pad/via (tree); hover or select a net to isolate it");
  } else if (View.ratsnestMode === "mst"){ // net → star
    View.ratsnestMode = "star";
    UI.toast("Ratsnest: Star — hover or select a pad to see spokes to every pad it connects to");
  } else {                                 // star → off
    View.ratsnest = false; View.ratsnestMode = "mst";
    UI.toast("Ratsnest off");
  }
  btn.classList.toggle("active", View.ratsnest);
  btn.textContent = View.ratsnest ? (View.ratsnestMode === "star" ? "Ratsnest: Star" : "Ratsnest: Net") : "Ratsnest";
  requestRender();
}

function toggleXray(){
  View.xray = !View.xray;
  View.xrayAuto = false;   // a manual toggle takes over — don't auto-disable later
  $("#btn-xray").classList.toggle("active", View.xray);
  const hasXrayImg = State.layers.some(l => l.side === "xray");
  UI.toast(View.xray
    ? "X-ray ON — both sides shown" + (hasXrayImg ? " (with X-ray image)" : "; other-side traces are dimmed")
    : "X-ray off");
  requestRender();
}

/* synced split view: front on the left half, back on the right, one shared camera.
   Recenter the pan so the current view slides into the left pane when turning it on. */
function toggleSplit(){
  View.split = !View.split;
  View.panX += View.split ? -View.width/4 : View.width/4;
  if (View.split){
    // seed each pane's image layer: left = active/front, right = a back-side layer
    const frontL = State.layers.find(l => l.side === "front");
    const backL  = State.layers.find(l => l.side === "back");
    if (View.paneLayer.left == null)
      View.paneLayer.left = UI.activeLayer()?.id ?? frontL?.id ?? State.layers[0]?.id ?? null;
    if (View.paneLayer.right == null)
      View.paneLayer.right = backL?.id ?? State.layers.find(l => l.id !== View.paneLayer.left)?.id ?? State.layers[0]?.id ?? null;
    // pane side defaults to the seeded layer's side
    View.paneSide.left  = getLayer(View.paneLayer.left)?.side  || "front";
    View.paneSide.right = getLayer(View.paneLayer.right)?.side || "back";
  }
  UI.refreshSplitControls();
  $("#btn-split").classList.toggle("active", View.split);
  UI.toast(View.split
    ? "Split view ON — one camera, two panes. Keys 1-9 set the LEFT view's layer, Shift+1-9 the RIGHT. The mirror crosshair shows your cursor in the other pane."
    : "Split view off");
  requestRender();
}

function afterHistory(){
  State.components.forEach(c => c._fp = null);
  markDirty();
  UI.select(null);
  UI.rebuildSideSelect(); syncSettings();
  UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
  requestRender();
}

/* ---------------- board / display settings ---------------- */
function wireSettings(){
  const lsel = $("#set-layers");
  lsel.innerHTML = LAYER_COUNTS.map(n => `<option value="${n}">${n} layer${n>1?"s":""}</option>`).join("");
  lsel.addEventListener("change", ()=> setLayerCount(parseInt(lsel.value,10)));

  $("#set-via").addEventListener("input", e => {
    State.viaR = +e.target.value;
    for (const v of State.vias) v.r = State.viaR;
    $("#set-via-val").textContent = State.viaR + " px";
    markDirty(); requestRender();
  });
  $("#set-trace").addEventListener("input", e => {
    State.traceW = +e.target.value;
    for (const t of State.traces) t.width = State.traceW;
    $("#set-trace-val").textContent = State.traceW + " px";
    markDirty(); requestRender();
  });
  $("#set-compview").addEventListener("change", e => {
    State.compView = e.target.value;
    markDirty(); requestRender();
  });
  $("#set-traceview").addEventListener("change", e => {
    State.traceView = e.target.value;
    markDirty(); requestRender();
  });
  $("#set-reftext").addEventListener("input", e => {
    State.refTextSize = +e.target.value;
    $("#set-reftext-val").textContent = State.refTextSize + " px";
    markDirty(); requestRender();
  });
  $("#set-copper").addEventListener("change", e => {
    State.copperOz = parseFloat(e.target.value) || 1;
    markDirty(); UI.refreshInspector();
  });
  $("#set-copper-inner").addEventListener("change", e => {
    State.copperOzInner = parseFloat(e.target.value) || 0.5;
    markDirty(); UI.refreshInspector();
  });
  $("#set-focusdim").addEventListener("input", e => {
    State.focusDim = (+e.target.value) / 100;
    $("#set-focusdim-val").textContent = Math.round(State.focusDim*100) + "%";
    markDirty(); requestRender();
  });
  $("#set-overlap").addEventListener("change", e => {
    State.overlapCheck = e.target.value === "on";
    markDirty();
  });
  $("#set-bigmerge").addEventListener("change", e => {
    State.bigMergeWarn = e.target.value === "on";
    markDirty();
  });
  $("#set-histlen").addEventListener("input", e => {
    Undo.max = +e.target.value;
    $("#set-histlen-val").textContent = Undo.max;
    while (Undo.stack.length > Undo.max) Undo.stack.shift();
    try { localStorage.setItem("pcbreveng.histLen", String(Undo.max)); } catch(ex){}
  });
  const autos = $("#set-autosave");
  if (autos){
    autos.value = String(readAutosaveInterval());  // autosaveInit runs later; read the stored value directly
    autos.addEventListener("change", e => {
      setAutosaveInterval(parseInt(e.target.value, 10) || 0);
      UI.toast(Autosave.interval === 0 ? "Autosave off — use Ctrl+S / Save to keep your work"
        : "Autosave " + (Autosave.interval/1000) + "s after a change");
    });
  }
  const units = document.getElementById("set-units");
  units.value = UI.unit();
  units.addEventListener("change", ()=>{
    try { localStorage.setItem("pcbreveng.unit", units.value); } catch(e){}
    UI.setStatusPos(Tools.cursor || {x:0,y:0});
    UI.toast("Units: " + (units.value === "mil" ? "mils (thou)" : "millimetres"));
    requestRender();
  });
  const kmode = $("#set-keymode");
  kmode.value = UI.layerKeyMode();
  kmode.addEventListener("change", ()=>{
    try { localStorage.setItem("pcbreveng.layerKeyMode", kmode.value); } catch(e){}
    UI.toast(kmode.value === "switch"
      ? "Keys 1…0 now switch the view to that layer (Shift = +10)"
      : "Keys 1…0 now toggle layer visibility (Shift = +10)");
  });
  syncSettings();
}

function syncSettings(){
  $("#set-layers").value = String(State.layerCount);
  $("#set-via").value = State.viaR;
  $("#set-via-val").textContent = State.viaR + " px";
  $("#set-trace").value = State.traceW;
  $("#set-trace-val").textContent = State.traceW + " px";
  $("#set-compview").value = State.compView;
  $("#set-traceview").value = State.traceView;
  $("#set-reftext").value = State.refTextSize;
  $("#set-reftext-val").textContent = State.refTextSize + " px";
  { const cs = $("#set-copper"); if (cs) cs.value = String(State.copperOz || 1); }
  { const ci = $("#set-copper-inner"); if (ci) ci.value = String(State.copperOzInner || 0.5); }
  { const fd = $("#set-focusdim"), fdv = $("#set-focusdim-val");
    if (fd){ fd.value = Math.round((State.focusDim!=null?State.focusDim:0.16)*100); }
    if (fdv){ fdv.textContent = Math.round((State.focusDim!=null?State.focusDim:0.16)*100) + "%"; } }
  $("#set-overlap").value = State.overlapCheck ? "on" : "off";
  $("#set-bigmerge").value = State.bigMergeWarn ? "on" : "off";
  $("#set-histlen").value = Undo.max;
  $("#set-histlen-val").textContent = Undo.max;
}

function setLayerCount(n){
  const innerMax = n - 2;
  const isRemoved = (side) => side.startsWith("inner") && parseInt(side.slice(5),10) > innerMax;
  const lostTraces = State.traces.filter(t => isRemoved(t.side));
  const lostLayers = State.layers.filter(l => isRemoved(l.side));
  if (lostTraces.length || lostLayers.length){
    const parts = [];
    if (lostTraces.length) parts.push(lostTraces.length + " trace(s) will be DELETED");
    if (lostLayers.length) parts.push(lostLayers.length + " image layer(s) will be reassigned to Front");
    if (!confirm("Reducing to " + n + " copper layers removes inner layers that are in use:\n\n· " +
                 parts.join("\n· ") + "\n\nContinue?")){
      $("#set-layers").value = String(State.layerCount);
      return;
    }
    pushUndo();
    State.traces = State.traces.filter(t => !isRemoved(t.side));
    for (const l of lostLayers) l.side = "front";
    pruneNets();
  } else {
    pushUndo();
  }
  State.layerCount = n;
  UI.rebuildSideSelect(); syncSettings();
  UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
  UI.toast("Board set to " + n + " copper layer" + (n>1?"s":""));
  requestRender();
}

/* ---------------- resizable side panels ---------------- */
const panelClampW = (w) => Math.max(200, Math.min(window.innerWidth - 360, w));

/* apply the saved panel widths up front, before viewInit sizes the canvas, so the
   canvas is never left squished on reload (only a viewResize fixes the backing store,
   and zoom/pan don't trigger one) */
function restorePanelWidths(){
  const apply = (sel, key) => {
    const panel = $(sel);
    if (!panel) return;
    try { const wv = parseInt(localStorage.getItem(key),10); if (wv) panel.style.width = panelClampW(wv) + "px"; } catch(e){}
  };
  apply("#right-panel", "pcbreveng.inspW");
  apply("#left-panel",  "pcbreveng.leftW");
}

/* side "right": handle sits on the panel's LEFT edge → drag left = wider.
   side "left":  handle sits on the panel's RIGHT edge → drag right = wider. */
function wirePanelResizer(rzSel, panelSel, key, side){
  const rz = $(rzSel), panel = $(panelSel);
  if (!rz || !panel) return;
  let drag = null;
  rz.addEventListener("pointerdown", e => {
    rz.setPointerCapture(e.pointerId);
    drag = { x:e.clientX, w:panel.getBoundingClientRect().width };
    rz.classList.add("dragging");
    e.preventDefault();
  });
  rz.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = side === "left" ? (e.clientX - drag.x) : (drag.x - e.clientX);
    panel.style.width = panelClampW(drag.w + dx) + "px";
    viewResize(); // canvas fills the remaining space
  });
  const end = () => {
    if (!drag) return;
    drag = null; rz.classList.remove("dragging"); viewResize();
    try { localStorage.setItem(key, String(parseInt(panel.style.width,10) || Math.round(panel.getBoundingClientRect().width))); } catch(ex){}
  };
  rz.addEventListener("pointerup", end);
  rz.addEventListener("pointercancel", end);
}

/* ---------------- canvas events ---------------- */
function wireCanvas(){
  const cv = View.canvas;
  cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); onPointerDown(e); });
  cv.addEventListener("pointermove", onPointerMove);
  cv.addEventListener("pointerup", onPointerUp);
  cv.addEventListener("dblclick", onDoubleClick);
  let lastPlaceRC = 0; // timestamp of last right-click while placing (double = cancel)
  cv.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (Tools.name === "trace" && Tools.tracePts){ finishTrace(); return; }
    // while a component is armed for placement, a double right-click cancels it
    if (Tools.name === "component" && Tools.pending){
      const now = Date.now();
      if (now - lastPlaceRC < 450){
        lastPlaceRC = 0;
        UI.hideContextMenu();
        setTool("select");
        UI.toast("Placement cancelled");
        return;
      }
      lastPlaceRC = now;
    }
    const pt = canvasPoint(e);
    updatePane(pt);
    const w = screenToWorld(pt.x, pt.y);
    showCanvasContextMenu(e.clientX, e.clientY, w);
  });
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const pt = canvasPoint(e);
    updatePane(pt);
    if (e.altKey && Tools.name === "align"){
      const l = UI.activeLayer();
      if (l && !l.locked){
        const k = e.deltaY < 0 ? 1.02 : 1/1.02;
        if (l.warp){ l.warp.a*=k; l.warp.b*=k; l.warp.c*=k; l.warp.d*=k; }
        else l.scale *= k;
        UI.refreshLayerList(); requestRender();
      }
      return;
    }
    zoomAt(pt.x, pt.y, e.deltaY < 0 ? 1.15 : 1/1.15);
    UI.setStatusPos(screenToWorld(pt.x, pt.y));
  }, { passive:false });

  // drag & drop images / projects
  const wrap = document.getElementById("canvas-wrap");
  ["dragenter","dragover"].forEach(ev => wrap.addEventListener(ev, e => {
    e.preventDefault(); wrap.classList.add("dragover");
  }));
  ["dragleave","drop"].forEach(ev => wrap.addEventListener(ev, e => {
    e.preventDefault(); wrap.classList.remove("dragover");
  }));
  wrap.addEventListener("drop", e => {
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files){
      if (f.type.startsWith("image/")) addImageLayer(f);
      else if (/\.json$/i.test(f.name)) openProjectFile(f);
    }
  });
}

/* build the right-click menu from whatever is under the cursor (pad-aware) */
function showCanvasContextMenu(cx, cy, w){
  const h = hitTest(w.x, w.y);
  const items = [];
  if (h && h.type === "pin"){
    const c = h.comp, p = c.pins[h.pinIdx];
    UI.select(h);
    items.push({ label:"Set net…", action:()=>promptNetName(h) });
    if (p.netId) items.push({ label:"Clear net", action:()=>{ pushUndo("clear pin net"); assignNetToObject(h,""); UI.refreshNets(); UI.refreshInspector(); requestRender(); } });
    items.push({ label: p.nc ? "Unset no-connect" : "Mark no-connect (NC)", action:()=>{ pushUndo("pin NC"); p.nc=!p.nc; if(p.nc)p.netId=null; pruneNets(); UI.refreshNets(); UI.refreshInspector(); requestRender(); } });
    if (c.fpId === "free"){
      const pl = ensureFreePin(c, h.pinIdx);
      items.push({ sep:true });
      items.push({ label: pl.shape==="rect" ? "Pad → THT (round)" : "Pad → SMD (rect)", action:()=>{ pushUndo("pad type"); pl.shape = pl.shape==="rect"?"circle":"rect"; c._fp=null; UI.refreshInspector(); requestRender(); } });
      items.push({ label:"Remove this pad", danger:true, action:()=>{ pushUndo("remove pad"); removeFreePin(c, h.pinIdx); UI.select({type:"comp",comp:c}); UI.refreshInspector(); UI.refreshNets(); requestRender(); } });
    }
    items.push({ sep:true });
    items.push({ label:"Select component "+c.ref, action:()=>{ UI.select({type:"comp",comp:c}); requestRender(); } });
  } else if (h && h.type === "comp"){
    const c = h.comp; UI.select(h);
    items.push({ label:"Edit ref / value…", action:()=>UI.openQuickEdit(c) });
    items.push({ label:"Duplicate", action:()=>duplicateSelection() });
    items.push({ label:"Rotate 90°", action:()=>rotateSelection(90) });
    items.push({ label:"Flip to other side", action:()=>flipSelectionSide() });
    items.push({ label: compMoveLocked(c) ? "Unlock" : "Lock (move)", action:()=>toggleLockSelection() });
    if (compPolarParam(c)) items.push({ label: compIsPolarized(c) ? "Make non-polarized" : "Make polarized (+)", action:()=>setCompPolarized(c, !compIsPolarized(c)) });
    items.push({ sep:true });
    items.push({ label:"Delete component "+c.ref, danger:true, action:()=>deleteSelection() });
  } else if (h && h.type === "via"){
    UI.select(h);
    items.push({ label:"Set net…", action:()=>promptNetName(h) });
    items.push({ label:"Set blind/buried span…", action:()=>UI.openViaSpanEditor(h.via) });
    items.push({ label: h.via.kind==="pth" ? "Change to via" : "Change to PTH", action:()=>{ pushUndo("via type"); h.via.kind = h.via.kind==="pth"?"via":"pth"; UI.refreshInspector(); requestRender(); } });
    items.push({ sep:true });
    items.push({ label: h.via.kind==="pth"?"Delete PTH":"Delete via", danger:true, action:()=>deleteSelection() });
  } else if (h && h.type === "trace"){
    UI.select(h);
    items.push({ label:"Set net…", action:()=>promptNetName(h) });
    items.push({ label:"Select whole net", action:()=>{ if(h.trace.netId) UI.selectNetTraces(h.trace.netId); requestRender(); } });
    items.push({ label:"Cut here", action:()=>{ setTool("cut"); cutDown(w,{}); } });
    items.push({ sep:true });
    items.push({ label:"Delete trace", danger:true, action:()=>deleteSelection() });
  } else if (h && h.type === "note"){
    UI.select(h);
    items.push({ label:"Edit note text", action:()=>{ UI.select(h); UI.focusNoteText(); } });
    items.push({ sep:true });
    items.push({ label:"Delete note", danger:true, action:()=>deleteSelection() });
  } else {
    items.push({ label:"Add note here…", action:()=>{ noteDown(w, {}); } });
    items.push({ label:"Place component here…", action:()=>{ Tools.pending=null; setTool("component"); } });
    if (View.mask !== undefined) items.push({ label: View.mask?"Hide coverage mask":"Show coverage mask", action:()=>toggleMask() });
  }
  if (items.length) UI.showContextMenu(cx, cy, items);
}

/* ---------------- keyboard ---------------- */
function wireKeyboard(){
  window.addEventListener("keydown", e => {
    if (e.target.matches("input,select,textarea")) return;
    if (document.querySelector("dialog[open]")) return; // dialogs own the keyboard (Esc closes natively)

    if (e.code === "Space"){ Keys.space = true; if (!Tools.drag) View.canvas.style.cursor="grab"; e.preventDefault(); return; }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl){
      switch (e.key.toLowerCase()){
        case "s": e.preventDefault(); saveProject(); return;
        case "o": e.preventDefault(); $("#file-project").click(); return;
        case "e": e.preventDefault(); UI.openExport(); return;
        case "z": e.preventDefault(); if (e.shiftKey ? redo() : undo()) afterHistory(); return;
        case "y": e.preventDefault(); if (redo()) afterHistory(); return;
        case "d": e.preventDefault(); duplicateSelection(); return;
        case "f": e.preventDefault(); UI.openPartsDialog(); return;
      }
      return;
    }

    // number keys: layer view (use e.code so Shift+digit works)
    if (/^Digit\d$/.test(e.code)){
      const base = e.code === "Digit0" ? 9 : parseInt(e.code.slice(5),10) - 1; // 0..9
      // split view: 1-9/0 pick the LEFT pane's layer, Shift+1-9/0 pick the RIGHT pane's
      if (View.split){
        const l = State.layers[base];
        if (l){
          const which = e.shiftKey ? "right" : "left";
          View.paneLayer[which] = l.id;
          View.paneSide[which] = l.side;   // pane's copper/trace side follows the chosen image
          if (which === "left") UI.activeLayerId = l.id;
          UI.toast((which==="right"?"Right":"Left") + " view → “" + l.name + "” (" + (SIDE_LABELS[l.side]||l.side) + ")");
          UI.refreshSplitControls(); UI.refreshLayerList(); requestRender();
        }
        return;
      }
      const idx = base;   // Shift no longer adds +10 (kept simple — no 10+ layer boards)
      const l = State.layers[idx];
      if (l){
        if (UI.layerKeyMode() === "toggle"){
          l.visible = !l.visible;
        } else {
          for (const x of State.layers) x.visible = (x === l);
          l.opacity = Math.max(l.opacity, 0.9);
          UI.activeLayerId = l.id;
          UI.setDrawSide(l.side);
          UI.autoXrayForLayer(l);   // viewing the X-ray image turns on X-ray view
          UI.toast("Viewing layer “" + l.name + "” (" + (SIDE_LABELS[l.side]||l.side) + ")");
        }
        UI.refreshLayerList(); requestRender();
      }
      return;
    }

    // "^" (German-layout dedicated key = Backquote code, or a literal caret) →
    // switch this view to NO image (black). Shift = the right split pane.
    if (e.code === "Backquote" || e.key === "^"){
      e.preventDefault();
      blankView(e.shiftKey);
      return;
    }

    // rebindable actions first
    const act = Keymap.actionForKey(normKey(e));
    if (act){ act.run(e); return; }

    // fixed keys
    switch (e.key){
      case "Backspace": deleteSelection(); break;
      case "Enter": if (Tools.name==="trace") finishTrace(); break;
      case "Escape":
        if (Tools.addPinFor){ Tools.addPinFor=null; UI.setHint(TOOL_HINTS[Tools.name]||""); UI.refreshInspector(); }
        else if (Tools.tracePts) cancelTrace();
        else if (Tools.deskewPts){ Tools.deskewPts=null; Tools.deskewLayer=null; UI.setHint(TOOL_HINTS.align); requestRender(); }
        else if (Tools.alignPts){ Tools.alignPts=null; Tools.alignLayer=null; Tools.alignReturnId=null; UI.setHint(TOOL_HINTS.align); requestRender(); }
        else if (Tools.name==="component"){ setTool("select"); }
        else { UI.select(null); View.hoverNetId=null; requestRender(); }
        break;
      case "Home": zoomToFit(); break;
      case "?": $("#help-dialog").showModal(); break;
      case "+": case "=": zoomAt(View.width/2, View.height/2, 1.25); break;
      case "-": zoomAt(View.width/2, View.height/2, 1/1.25); break;
    }
  });
  window.addEventListener("keyup", e => {
    if (e.code === "Space"){
      Keys.space = false;
      if (!Tools.drag) View.canvas.style.cursor = toolCursor(Tools.name);
    }
  });
}

/* Cycle the active draw side. withImage (Shift+D) also switches the shown image to
   that side's layer — or to a black backdrop when that side has no photo. */
function cycleDrawSide(withImage){
  const order = availableSides();
  // in split view, cycle the focused pane's copper/trace side instead of the global one
  if (View.split){
    const which = View.cursorPane || "left";
    const cur = View.paneSide[which] || (which==="left"?"front":"back");
    const next = order[(order.indexOf(cur)+1) % order.length];
    View.paneSide[which] = next;
    if (withImage){
      const layerForSide = State.layers.find(l => l.side === next);
      View.paneLayer[which] = layerForSide ? layerForSide.id : null;
    }
    UI.toast((which==="right"?"Right":"Left") + " view showing " + (SIDE_LABELS[next]||next) + " copper" +
             (withImage ? (State.layers.some(l=>l.side===next) ? "" : " (no image — black)") : ""));
    UI.refreshSplitControls(); requestRender();
    return;
  }
  const sel = $("#draw-side");
  sel.value = order[(order.indexOf(sel.value)+1) % order.length];
  Tools.lastCopperSide = sel.value;
  if (withImage) viewSideImage(sel.value);   // Shift+D: also swap the displayed image
  UI.toast("Drawing on " + SIDE_LABELS[sel.value] +
           (withImage && !State.layers.some(l=>l.side===sel.value) ? " (no image — black)" : ""));
  requestRender(); // trace/component visibility follows the active side
}

/* show only the image layer(s) of `side` (others hidden); no matching image → black */
function viewSideImage(side){
  let found = null;
  for (const l of State.layers){
    const match = l.side === side;
    l.visible = match;
    if (match && !found) found = l;
  }
  if (found){ UI.activeLayerId = found.id; found.opacity = Math.max(found.opacity, 0.9); }
  UI.refreshLayerList();
}

/* "no image" view (black). Split: left pane (or right with Shift); single: hide all. */
function blankView(rightPane){
  if (View.split){
    const which = rightPane ? "right" : (View.cursorPane || "left");
    View.paneLayer[which] = null;
    UI.refreshSplitControls();
    UI.toast((which==="right"?"Right":"Left") + " view → no image (black)");
  } else {
    for (const l of State.layers) l.visible = false;
    UI.refreshLayerList();
    UI.toast("View → no image (black)");
  }
  requestRender();
}

/* ---------------- dialogs ---------------- */
function wireDialogs(){
  $("#fp-ok").addEventListener("click", ()=> UI.confirmFootprint());
  $("#fp-dialog").addEventListener("keydown", fpDialogKey);
  $("#fp-resolve").addEventListener("click", ()=>{
    const inp = $("#fp-value");
    const dec = decodeSMD(inp.value);
    if (dec){ inp.value = dec.text; UI.toast("Decoded: " + dec.text + "Ω (" + dec.how + ")"); return; }
    Resolver.open(val => { inp.value = val; });
  });
  $("#fp-cancel").addEventListener("click", ()=>{
    $("#fp-dialog").close();
    if (Tools.name === "component" && !Tools.pending) setTool("select");
  });
  // clicking the backdrop (outside the dialog box) closes the footprint selector
  $("#fp-dialog").addEventListener("click", e => {
    if (e.target === $("#fp-dialog")){
      $("#fp-dialog").close();
      if (Tools.name === "component" && !Tools.pending) setTool("select");
    }
  });
  $("#options-close").addEventListener("click", ()=> $("#options-dialog").close());
  $("#history-close").addEventListener("click", ()=> $("#history-dialog").close());
  $("#checker-close").addEventListener("click", ()=>{ $("#checker-dialog").close(); View.checkMarks = null; View.shortMarks = null; requestRender(); });
  $("#export-close").addEventListener("click", ()=> $("#export-dialog").close());
  $("#export-copy").addEventListener("click", ()=>{
    navigator.clipboard?.writeText($("#export-preview").value);
    UI.toast("Copied to clipboard");
  });
  $("#export-download").addEventListener("click", ()=>{
    const f = netlistFor($("#export-format").value);
    downloadFile((f.base || "netlist") + "." + f.ext, f.text, f.mime);
  });
  $("#bom-close").addEventListener("click", ()=> $("#bom-dialog").close());
  $("#bom-addcol").addEventListener("click", ()=> UI.addBomColumn());
  $("#bom-export").addEventListener("click", ()=>{
    const f = netlistFor("bom");
    downloadFile("bom.csv", f.text, f.mime);
  });
  $("#help-close").addEventListener("click", ()=> $("#help-dialog").close());
  $("#help-sample").addEventListener("click", ()=>{
    if (!confirm("Load the sample project? This replaces the current board. Unsaved work will be lost.")) return;
    $("#help-dialog").close();
    loadDefaultProject();
  });

  $("#btn-keys").addEventListener("click", ()=> UI.openKeysDialog());
  $("#keys-close").addEventListener("click", ()=> $("#keys-dialog").close());
  $("#keys-reset").addEventListener("click", ()=>{
    Keymap.reset();
    UI.buildKeysList();
    UI.updateHotkeyHints();
    UI.buildHelp();
    UI.toast("Hotkeys reset to defaults");
  });
}

/* ---------------- file I/O ---------------- */
function wireFiles(){
  $("#file-images").addEventListener("change", e => {
    for (const f of e.target.files) addImageLayer(f);
    e.target.value = "";
  });
  $("#file-project").addEventListener("change", e => {
    const f = e.target.files[0];
    if (f) openProjectFile(f);
    e.target.value = "";
  });
  // add-image-from-URL dialog
  const urlDlg = $("#url-dialog"), urlInput = $("#url-input");
  const loadUrl = () => { const u = urlInput.value; urlDlg.close(); addImageLayerFromURL(u); };
  $("#url-ok").addEventListener("click", loadUrl);
  $("#url-cancel").addEventListener("click", ()=> urlDlg.close());
  urlInput.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); loadUrl(); } });
}

/* guess a copper side from a file/layer name, clamped to a side that exists at the
   current layer count (don't assign Inner 1 on a 2-layer board) */
function guessLayerSide(name){
  const n = (name || "").toLowerCase();
  let side = "front";
  if (/x-?ray/.test(n)) side = "xray";
  else if (/back|bottom|b\.|_b/.test(n)) side = "back";
  else if (/inner|in1|l2/.test(n)) side = "inner1";
  if (side !== "xray" && !availableSides().includes(side)) side = "front";
  return side;
}

/* build the LOD tile pyramid for a big UPLOADED image (hosted/URL layers are left plain) */
function buildLayerTiles(layer){
  if (!layer || layer.url || !layer.img) return;              // URL layers are never tiled
  if (!ImageTiles.shouldTile(layer.img)) return;
  const tiles = ImageTiles.build(layer.img);
  if (tiles) layer.tiles = tiles;
}

/* shared layer construction for both uploaded files and hosted URLs.
   `dataURL` holds the bytes for uploaded layers (persisted); `url` is set for hosted
   layers (only the link is persisted — the image is fetched live at load). */
function addLayerFromImage(img, name, dataURL, url){
  const side = guessLayerSide(name);
  const center = screenToWorld(View.width/2, View.height/2);
  const layer = {
    id: nextId(), name: (name || "layer").replace(/\.[^.]+$/,""),
    side, dataURL: url ? "" : (dataURL || ""), url: url || null, img,
    visible: true, opacity: side === "front" || State.layers.length===0 ? 1 : 0.6,
    tx: center.x, ty: center.y, scale: 1, rot: 0,
    mirror: side === "back", locked: false,
  };
  buildLayerTiles(layer);
  State.layers.push(layer);
  UI.activeLayerId = layer.id;
  markImagesDirty();
  UI.refreshLayerList();
  if (State.layers.length === 1) zoomToFit(); else requestRender();
  UI.toast("Added layer “" + layer.name + "” as " + SIDE_LABELS[side] +
           (layer.mirror ? " (mirrored)" : "") + (layer.tiles ? " · tiled (LOD)" : "") +
           (url ? " · hosted" : ""));
  return layer;
}

function addImageLayer(file){
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => addLayerFromImage(img, file.name, reader.result, null);
    img.onerror = () => UI.toast("Could not read image “" + file.name + "”");
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* Load a background image from a live URL. The bytes are NOT downloaded into the project
   — only the URL is remembered and the image is fetched again on every load. Tries with
   CORS first (so align/warp/export can read the pixels); falls back to a plain load
   (image shows, but canvas becomes tainted) so the layer still appears on servers that
   don't send CORS headers. */
function addImageLayerFromURL(url){
  url = (url || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)){ UI.toast("Enter a full http(s):// image URL"); return; }
  const attempt = (useCors) => {
    const img = new Image();
    if (useCors) img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!img.width){ UI.toast("That URL didn’t return a usable image"); return; }
      const name = (url.split(/[?#]/)[0].split("/").pop() || "hosted image");
      addLayerFromImage(img, name, "", url);
      UI.warn("⚠ Hosted image loaded from a URL — it is NOT saved in your project. If the "
        + "link changes or goes down, this layer will disappear. For anything important, "
        + "download the image and add it as a file instead.");
    };
    img.onerror = () => {
      if (useCors) attempt(false);   // server may just lack CORS headers — retry taint-mode
      else UI.toast("Could not load image from that URL (blocked, offline, or not an image)");
    };
    img.src = url;
  };
  attempt(true);
}

function saveProject(){
  downloadFile("project.pcbrev.json", serializeProject(), "application/json");
  UI.toast("Project downloaded");
}

function openProjectFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadProject(reader.result, () => {
        UI.activeLayerId = State.layers[0]?.id ?? null;
        UI.select(null);
        UI.rebuildSideSelect(); syncSettings();
        UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
        zoomToFit();
        markImagesDirty(); // adopt the loaded project (incl. images) into the autosave slot
        UI.toast("Project loaded — " + State.components.length + " components, " + State.nets.length + " nets");
      });
    } catch (err){
      alert("Could not open file: " + err.message);
    }
  };
  reader.readAsText(file);
}
