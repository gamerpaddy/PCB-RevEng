/* ===== autosave.js — IndexedDB autosave (survives F5), sample-project loader ===== */
"use strict";

const Autosave = { db:null, dirty:false, restoring:false, interval:2500, _timer:null };

/* autosave interval (ms) between a change and the save; 0 = off. Persisted. */
function readAutosaveInterval(){
  try { const v = localStorage.getItem("pcbreveng.autosaveInterval");
        if (v != null) return Math.max(0, parseInt(v,10) || 0); } catch(e){}
  return 2500;
}
function scheduleAutosave(){
  clearTimeout(Autosave._timer);
  if (Autosave.interval > 0) Autosave._timer = setTimeout(autosaveTick, Autosave.interval);
}
function setAutosaveInterval(ms){
  Autosave.interval = Math.max(0, ms | 0);
  try { localStorage.setItem("pcbreveng.autosaveInterval", String(Autosave.interval)); } catch(e){}
  scheduleAutosave();
  updateSaveStatus();
}

/* one autosave check. Re-arms itself, then saves only when there is a pending change
   and nothing is being dragged (don't save mid-move of a part/anchor/via/note — wait
   for the drop, so the timeline/undo isn't peppered with in-progress states). */
function autosaveTick(){
  scheduleAutosave(); // arm the next tick regardless of what happens below
  if (!Autosave.dirty || Autosave.restoring || !Autosave.db || Autosave.saving) return;
  if (typeof Tools !== "undefined" && Tools.drag) return; // interaction in progress
  Autosave.dirty = false;
  Autosave.saving = true;
  updateSaveStatus(true);
  const idle = window.requestIdleCallback || ((fn)=>setTimeout(()=>fn({timeRemaining:()=>5}),0));
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
}

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

/* obtain the sample project JSON. Works both over http (fetch) and as a local
   file:// page (where fetch is CORS-blocked) by pulling in sampleproject.js,
   a plain <script> that assigns window.SAMPLE_PROJECT_JSON. */
function ensureSampleData(){
  return new Promise((resolve) => {
    if (typeof window.SAMPLE_PROJECT_JSON === "string"){ resolve(window.SAMPLE_PROJECT_JSON); return; }
    fetch("sampleproject.pcbrev.json?v=25")
      .then(r => r.ok ? r.text() : Promise.reject(new Error("fetch " + r.status)))
      .then(resolve)
      .catch(() => {
        const s = document.createElement("script");
        s.src = "sampleproject.js?v=25";
        s.onload = () => resolve(typeof window.SAMPLE_PROJECT_JSON === "string" ? window.SAMPLE_PROJECT_JSON : null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
      });
  });
}

/* load the bundled sample project (used by the welcome dialog) */
function loadDefaultProject(overlay, ltext){
  overlay = overlay || document.getElementById("loading-overlay");
  ltext = ltext || document.getElementById("loading-text");
  return new Promise((resolve) => {
    if (overlay) overlay.classList.add("show");
    if (ltext) ltext.textContent = "Loading sample project…";
    ensureSampleData().then((text) => {
      if (!text){ if (overlay) overlay.classList.remove("show"); UI.toast("Could not load the sample project file"); resolve(); return; }
      Autosave.restoring = true; // hold off autosave until the project is fully built
      loadProject(text, () => {
        Autosave.restoring = false;
        UI.activeLayerId = State.layers[0]?.id ?? null;
        UI.rebuildSideSelect(); syncSettings();
        UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
        if (State.layers.length || State.components.length) zoomToFit();
        if (overlay) overlay.classList.remove("show");
        // adopt the sample (including its images) into the autosave slot, so a
        // page refresh restores the board with its photos intact
        markImagesDirty();
        UI.toast("Loaded sample project — use “New” to start your own");
        resolve();
      });
    });
  });
}
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
  // hosted (URL) layers keep no bytes — only their link (persisted in the light project)
  return JSON.stringify(State.layers.map(l => ({ id: l.id, dataURL: l.url ? "" : l.dataURL })));
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
  if (Autosave.interval === 0){
    el.textContent = Autosave.lastSaved ? ("autosave off · saved " + relTime(Autosave.lastSaved)) : "autosave off";
    return;
  }
  el.textContent = Autosave.lastSaved ? ("saved " + relTime(Autosave.lastSaved)) : "not saved yet";
}

/* first launch with an empty cache: ask the user to start fresh or load the sample */
function showWelcome(overlay, ltext){
  const dlg = document.getElementById("welcome-dialog");
  if (!dlg){ return; }
  const newBtn = document.getElementById("welcome-new");
  const sampleBtn = document.getElementById("welcome-sample");
  if (newBtn) newBtn.onclick = () => { dlg.close(); /* keep the empty project */ };
  if (sampleBtn) sampleBtn.onclick = () => { dlg.close(); loadDefaultProject(overlay, ltext); };
  dlg.showModal();
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
      // no saved session → let the user choose: empty project or the bundled sample
      updateSaveStatus();
      showWelcome(overlay, ltext);
    }
  } catch (e){ if (overlay) overlay.classList.remove("show"); updateSaveStatus(); }
  // periodic save while dirty (self-rescheduling so the interval is user-configurable;
  // pauses during drags and honours the "off" setting — see autosaveTick / Options)
  Autosave.interval = readAutosaveInterval();
  scheduleAutosave();
  // refresh the "saved Xm ago" label periodically
  setInterval(() => { if (!Autosave.saving) updateSaveStatus(); }, 15000);
  // catch mutations centrally: every undo snapshot marks the project dirty
  const origPush = window.pushUndo;
  window.pushUndo = function(...a){ origPush(...a); markDirty(); };
}
