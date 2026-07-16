/* ===== autosave.js — OPFS autosave (survives reloads), sample-project loader =====
   The session is saved as real files in the Origin Private File System
   (autosave/*.json — same storage the Projects tab uses), which is sturdier than
   IndexedDB against "clear cookies and site data" style cleanups. Browsers without
   OPFS fall back to the old IndexedDB key/value store, and an existing IndexedDB
   autosave is migrated into OPFS once on startup. */
"use strict";

const Autosave = { db:null, ready:false, dirty:false, restoring:false, interval:2500, _timer:null };

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
  if (!Autosave.dirty || Autosave.restoring || !Autosave.ready || Autosave.saving) return;
  if (typeof Tools !== "undefined" && Tools.drag) return; // interaction in progress
  Autosave.dirty = false;
  Autosave.saving = true;
  updateSaveStatus(true);
  // rIC with a timeout: a throttled/background tab may never go "idle", which would
  // leave saving=true forever and block every later autosave
  const idle = window.requestIdleCallback
    ? ((fn)=>window.requestIdleCallback(fn, { timeout: 2000 }))
    : ((fn)=>setTimeout(()=>fn({timeRemaining:()=>5}),0));
  idle(async () => {
    try {
      const full = serializeProject();   // one serialize feeds the session AND the project mirror
      await storePut("autosave", serializeLight(full));
      await storePut("autosave_undo", JSON.stringify({ stack: Undo.stack, redo: Undo.redo }));
      // clear imagesDirty only AFTER the image write succeeds, so a failure re-tries it
      if (Autosave.imagesDirty){ await storePut("autosave_imgs", serializeImages()); Autosave.imagesDirty = false; }
      Autosave.lastSaved = Date.now();
      await storePut("autosave_meta", JSON.stringify({ savedAt: Autosave.lastSaved }));
      // mirror the board into its OPFS project: the ACTIVE project when one is open (so
      // it stays current without a manual 💾 Save), else the special Autosave slot
      if (typeof projAutosaveMirror === "function"){
        try { await projAutosaveMirror(full); } catch(e){}
      }
    } catch (e){
      // quota / write error — the change is NOT saved, so keep it pending for the next tick
      // (we optimistically cleared dirty above; put it back so we don't report a false save)
      Autosave.dirty = true;
    }
    Autosave.saving = false;
    updateSaveStatus();
  });
}

/* ---------- storage backend: OPFS files, IndexedDB fallback ---------- */
/* mutable: feature detection alone lies — Chrome on file:// pages EXPOSES
   navigator.storage.getDirectory but every call throws ("files unsafe for
   access"). autosaveInit probes it once and flips this off when it's dead. */
let AS_OPFS = !!(navigator.storage && navigator.storage.getDirectory);
const AS_KEYS = ["autosave", "autosave_undo", "autosave_imgs", "autosave_meta"];

async function asDir(){
  if (Autosave._dir) return Autosave._dir;
  const root = await navigator.storage.getDirectory();
  Autosave._dir = await root.getDirectoryHandle("autosave", { create:true });
  return Autosave._dir;
}
async function storePut(key, val){
  if (!AS_OPFS) return idbPut(key, val);
  const dir = await asDir();
  const fh = await dir.getFileHandle(key + ".json", { create:true });
  const w = await fh.createWritable();
  await w.write(val);
  await w.close();
}
async function storeGet(key){
  if (!AS_OPFS) return idbGet(key);
  try {
    const dir = await asDir();
    const fh = await dir.getFileHandle(key + ".json");
    return await (await fh.getFile()).text();
  } catch(e){ return undefined; }
}
async function storeDel(key){
  if (!AS_OPFS) return idbDel(key);
  try { const dir = await asDir(); await dir.removeEntry(key + ".json"); } catch(e){}
}

/* one-time move of a pre-OPFS IndexedDB autosave into OPFS files. Runs only when
   OPFS has no session yet; the IndexedDB copy is deleted after a successful move
   (image blobs are megabytes — no point storing the session twice). */
async function migrateIdbAutosave(){
  try {
    const existing = await storeGet("autosave");
    if (existing != null) return;                     // OPFS session already present
    Autosave.db = await idbOpen();                    // temporary handle for the move
    const light = await idbGet("autosave");
    if (light != null){
      for (const k of AS_KEYS){
        const v = await idbGet(k);
        if (v != null) await storePut(k, v);
      }
      for (const k of AS_KEYS) await idbDel(k);
    }
  } catch(e){                                         // no old data / idb blocked — fine
  } finally {
    try { if (Autosave.db) Autosave.db.close(); } catch(e){}
    Autosave.db = null;
  }
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
    const viaScript = () => {
      const s = document.createElement("script");
      s.src = "sampleproject.js?v=25";
      s.onload = () => resolve(typeof window.SAMPLE_PROJECT_JSON === "string" ? window.SAMPLE_PROJECT_JSON : null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    };
    // on file:// fetch is CORS-blocked and only spams the console — go straight to the script
    if (location.protocol === "file:"){ viaScript(); return; }
    fetch("sampleproject.pcbrev.json?v=25")
      .then(r => r.ok ? r.text() : Promise.reject(new Error("fetch " + r.status)))
      .then(resolve)
      .catch(viaScript);
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
        if (typeof projSetActive === "function") projSetActive(null);   // the example is not a saved project
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
   2.5 s autosave no longer re-encodes megabytes every tick. Pass an already
   serialized full-project string to avoid serializing twice. */
function serializeLight(fullText){
  const full = JSON.parse(fullText || serializeProject());
  full.activeLayerId = UI.activeLayerId;   // remember the selected layer across page reloads
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
  if (AS_OPFS){
    // probe OPFS for real: Chrome on file:// advertises it but every call throws
    try { await asDir(); }
    catch(e){ AS_OPFS = false; Autosave._dir = null; }
    if (typeof Projects !== "undefined") Projects.supported = AS_OPFS;
  }
  if (AS_OPFS){
    await migrateIdbAutosave();   // adopt a pre-OPFS IndexedDB session once
    Autosave.ready = true;
  } else {
    try { Autosave.db = await idbOpen(); Autosave.ready = true; }
    catch (e){ updateSaveStatus(); return; }
  }
  // restore a previous session (merge light project + stored images + undo timeline)
  try {
    const light = await storeGet("autosave");
    if (light){
      if (overlay) overlay.classList.add("show");
      const meta = await storeGet("autosave_meta");
      if (meta){ try { Autosave.lastSaved = JSON.parse(meta).savedAt; } catch(e){} }
      if (ltext && Autosave.lastSaved) ltext.textContent = "Wait, loading saved session… (saved " + relTime(Autosave.lastSaved) + ")";
      const imgs = await storeGet("autosave_imgs");
      const undoData = await storeGet("autosave_undo");
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
        UI.resolveActiveLayer(proj.activeLayerId);   // restore the last-active layer, not always layer 1
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
