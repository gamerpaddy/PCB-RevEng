/* ===== main.js — bootstrap, events, hotkeys, file I/O ===== */
"use strict";

const Keys = { space:false };

/* ---------------- autosave (IndexedDB — survives F5) ---------------- */
const Autosave = { db:null, dirty:false, restoring:false };

function idbOpen(){
  return new Promise((res, rej) => {
    const rq = indexedDB.open("pcbreveng", 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore("kv");
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
function idbPut(key, val){
  return new Promise((res, rej) => {
    const tx = Autosave.db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
function idbGet(key){
  return new Promise((res, rej) => {
    const tx = Autosave.db.transaction("kv", "readonly");
    const rq = tx.objectStore("kv").get(key);
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
function idbDel(key){
  return new Promise((res) => {
    const tx = Autosave.db.transaction("kv", "readwrite");
    tx.objectStore("kv").delete(key);
    tx.oncomplete = res; tx.onerror = res;
  });
}

function markDirty(){ Autosave.dirty = true; }
/* heavy image data changed (layer added/removed/edited) — re-save images once */
function markImagesDirty(){ Autosave.imagesDirty = true; Autosave.dirty = true; }

/* lightweight project JSON WITHOUT the base64 images (the slow part).
   Images are stored separately and only when they actually change, so the
   2.5 s autosave no longer re-encodes megabytes every tick. */
function serializeLight(){
  const full = JSON.parse(serializeProject());
  full.layers = (full.layers || []).map(l => { const { dataURL, ...rest } = l; return rest; });
  return JSON.stringify(full);
}
function serializeImages(){
  return JSON.stringify(State.layers.map(l => ({ id: l.id, dataURL: l.dataURL })));
}

function relTime(ts){
  if (!ts) return "never";
  const s = Math.round((Date.now()-ts)/1000);
  if (s < 5) return "just now";
  if (s < 60) return s + "s ago";
  const m = Math.round(s/60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m/60);
  if (h < 24) return h + "h ago";
  return new Date(ts).toLocaleString();
}
function updateSaveStatus(saving){
  const el = document.getElementById("save-status");
  if (!el) return;
  el.classList.toggle("saving", !!saving);
  if (saving){ el.textContent = "saving…"; return; }
  el.textContent = Autosave.lastSaved ? ("saved " + relTime(Autosave.lastSaved)) : "not saved yet";
}

async function autosaveInit(){
  const overlay = document.getElementById("loading-overlay");
  const ltext = document.getElementById("loading-text");
  try { Autosave.db = await idbOpen(); }
  catch (e){ updateSaveStatus(); return; }
  // restore a previous session (merge light project + stored images + undo timeline)
  try {
    const light = await idbGet("autosave");
    if (light){
      if (overlay) overlay.classList.add("show");
      const meta = await idbGet("autosave_meta");
      if (meta){ try { Autosave.lastSaved = JSON.parse(meta).savedAt; } catch(e){} }
      if (ltext && Autosave.lastSaved) ltext.textContent = "Wait, loading saved session… (saved " + relTime(Autosave.lastSaved) + ")";
      const imgs = await idbGet("autosave_imgs");
      const undoData = await idbGet("autosave_undo");
      const proj = JSON.parse(light);
      if (imgs){
        const map = new Map(JSON.parse(imgs).map(i => [i.id, i.dataURL]));
        for (const l of (proj.layers || [])) l.dataURL = map.get(l.id) || l.dataURL || "";
      }
      Autosave.restoring = true;
      loadProject(JSON.stringify(proj), () => {
        // restore the undo/redo timeline (loadProject clears it)
        if (undoData){
          try {
            const u = JSON.parse(undoData);
            if (Array.isArray(u.stack)) Undo.stack = u.stack;
            if (Array.isArray(u.redo)) Undo.redo = u.redo;
          } catch(e){}
        }
        Autosave.restoring = false;
        UI.activeLayerId = State.layers[0]?.id ?? null;
        UI.rebuildSideSelect(); syncSettings();
        UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
        if (State.layers.length || State.components.length) zoomToFit();
        if (overlay) overlay.classList.remove("show");
        updateSaveStatus();
        if (State.components.length || State.layers.length || State.traces.length)
          UI.toast("Session restored (saved " + relTime(Autosave.lastSaved) + ") — use “New” to start fresh");
      });
    } else {
      updateSaveStatus();
    }
  } catch (e){ if (overlay) overlay.classList.remove("show"); updateSaveStatus(); }
  // periodic save while dirty (uses idle time so it never blocks interaction)
  const idle = window.requestIdleCallback || ((fn)=>setTimeout(()=>fn({timeRemaining:()=>5}),0));
  setInterval(() => {
    if (!Autosave.dirty || Autosave.restoring || !Autosave.db || Autosave.saving) return;
    Autosave.dirty = false;
    Autosave.saving = true;
    updateSaveStatus(true);
    idle(async () => {
      try {
        await idbPut("autosave", serializeLight());
        await idbPut("autosave_undo", JSON.stringify({ stack: Undo.stack, redo: Undo.redo }));
        if (Autosave.imagesDirty){ Autosave.imagesDirty = false; await idbPut("autosave_imgs", serializeImages()); }
        Autosave.lastSaved = Date.now();
        await idbPut("autosave_meta", JSON.stringify({ savedAt: Autosave.lastSaved }));
      } catch (e){ /* quota — keep working without autosave */ }
      Autosave.saving = false;
      updateSaveStatus();
    });
  }, 2500);
  // refresh the "saved Xm ago" label periodically
  setInterval(() => { if (!Autosave.saving) updateSaveStatus(); }, 15000);
  // catch mutations centrally: every undo snapshot marks the project dirty
  const origPush = window.pushUndo;
  window.pushUndo = function(...a){ origPush(...a); markDirty(); };
}

window.addEventListener("DOMContentLoaded", () => {
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
  Resolver.wire();
  UI.wireFpSearch();
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
  $("#btn-add-layer").addEventListener("click", ()=> $("#file-images").click());
  $("#draw-side").addEventListener("change", ()=> requestRender()); // visibility follows active side
  $("#btn-measure").addEventListener("click", ()=> setTool("measure"));
  $("#btn-calibrate").addEventListener("click", ()=> setTool("calibrate"));
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

/* ---------------- canvas events ---------------- */
function wireCanvas(){
  const cv = View.canvas;
  cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); onPointerDown(e); });
  cv.addEventListener("pointermove", onPointerMove);
  cv.addEventListener("pointerup", onPointerUp);
  cv.addEventListener("dblclick", onDoubleClick);
  cv.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (Tools.name === "trace" && Tools.tracePts) finishTrace();
  });
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const pt = canvasPoint(e);
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
      }
      return;
    }

    // number keys: layer view (use e.code so Shift+digit works)
    if (/^Digit\d$/.test(e.code)){
      let idx = e.code === "Digit0" ? 9 : parseInt(e.code.slice(5),10) - 1;
      if (e.shiftKey) idx += 10;
      const l = State.layers[idx];
      if (l){
        if (UI.layerKeyMode() === "toggle"){
          l.visible = !l.visible;
        } else {
          for (const x of State.layers) x.visible = (x === l);
          l.opacity = Math.max(l.opacity, 0.9);
          UI.activeLayerId = l.id;
          UI.setDrawSide(l.side);
          UI.toast("Viewing layer “" + l.name + "” (" + (SIDE_LABELS[l.side]||l.side) + ")");
        }
        UI.refreshLayerList(); requestRender();
      }
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
        else if (Tools.alignPts){ Tools.alignPts=null; Tools.alignLayer=null; UI.setHint(TOOL_HINTS.align); requestRender(); }
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
      if (!Tools.drag){
        const cur = { select:"default", component:"crosshair", trace:"crosshair",
                      via:"crosshair", align:"move", measure:"crosshair" }[Tools.name] || "default";
        View.canvas.style.cursor = cur;
      }
    }
  });
}

function cycleDrawSide(){
  const sel = $("#draw-side");
  const order = availableSides();
  sel.value = order[(order.indexOf(sel.value)+1) % order.length];
  UI.toast("Drawing on " + SIDE_LABELS[sel.value]);
  requestRender(); // trace/component visibility follows the active side
}

/* ---------------- dialogs ---------------- */
function wireDialogs(){
  $("#fp-ok").addEventListener("click", ()=> UI.confirmFootprint());
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
  $("#options-close").addEventListener("click", ()=> $("#options-dialog").close());
  $("#history-close").addEventListener("click", ()=> $("#history-dialog").close());
  $("#checker-close").addEventListener("click", ()=>{ $("#checker-dialog").close(); View.checkMarks = null; requestRender(); });
  $("#export-close").addEventListener("click", ()=> $("#export-dialog").close());
  $("#export-copy").addEventListener("click", ()=>{
    navigator.clipboard?.writeText($("#export-preview").value);
    UI.toast("Copied to clipboard");
  });
  $("#export-download").addEventListener("click", ()=>{
    const f = netlistFor($("#export-format").value);
    downloadFile("netlist." + f.ext, f.text, f.mime);
  });
  $("#help-close").addEventListener("click", ()=> $("#help-dialog").close());

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
}

function addImageLayer(file){
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // guess side from filename
      const n = file.name.toLowerCase();
      let side = "front";
      if (/back|bottom|b\.|_b/.test(n)) side = "back";
      else if (/inner|in1|l2/.test(n)) side = "inner1";
      const center = screenToWorld(View.width/2, View.height/2);
      const layer = {
        id: nextId(), name: file.name.replace(/\.[^.]+$/,""),
        side, dataURL: reader.result, img,
        visible: true, opacity: side === "front" || State.layers.length===0 ? 1 : 0.6,
        tx: center.x, ty: center.y, scale: 1, rot: 0,
        mirror: side === "back", locked: false,
      };
      State.layers.push(layer);
      UI.activeLayerId = layer.id;
      markImagesDirty();
      UI.refreshLayerList();
      if (State.layers.length === 1) zoomToFit(); else requestRender();
      UI.toast("Added layer “" + layer.name + "” as " + SIDE_LABELS[side] +
               (layer.mirror ? " (mirrored)" : ""));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
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
