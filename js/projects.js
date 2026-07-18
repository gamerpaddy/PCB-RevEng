/* ===== projects.js — the PROJECTS tab =====
   A file browser for whole boards, stored in the browser's Origin Private File
   System (OPFS — real files on disk, private to this site, surviving cache clears
   of localStorage-style data). Layout on disk:

     projects/<pid>/meta.json          {id,name,created,modified,size,stats,thumb,versions[]}
     projects/<pid>/current.json       the project's latest saved board (serializeProject)
     projects/<pid>/versions/<vid>.json  frozen snapshots ("versions") of the board

   Each card shows a thumbnail (captured from the board canvas, zoomed to fit),
   the object counts, size and dates, plus per-project actions: open, save the live
   board into it, download as a .pcbrev.json file, delete, and a version history
   where "+ Version" freezes the live board under a label (and also becomes the
   project's current state). Upload works via the toolbar button or by dropping
   .pcbrev.json files anywhere on the pane. Everything is async but serialized per
   action; the whole pane re-renders after every mutation. */
"use strict";

const Projects = {
  supported: !!(navigator.storage && navigator.storage.getDirectory),
  expanded: new Set(),   // project ids whose version list is open
  activeId: (() => { try { return localStorage.getItem("pcbreveng.activeProject") || null; } catch(e){ return null; } })(),
};

function projSetActive(id){
  Projects.activeId = id || null;
  try {
    if (id) localStorage.setItem("pcbreveng.activeProject", id);
    else localStorage.removeItem("pcbreveng.activeProject");
  } catch(e){}
  Projects.refreshBadge();
}

/* the tab bar's right-side "📁 project name" label — follows the active project */
Projects.refreshBadge = async () => {
  const el = $("#active-project");
  if (!el) return;
  let name = null;
  if (Projects.supported && Projects.activeId){
    const meta = await projReadMeta(Projects.activeId);
    if (meta) name = meta.name;
  }
  el.style.display = name ? "" : "none";
  el.textContent = name ? "📁 " + name : "";
  el.title = name ? "Current project “" + name + "” — the board you are editing belongs to it. Click to open the Projects tab." : "";
};

function projNewId(prefix){
  return (prefix || "p") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ---------------- autosave mirror ---------------- */
/* While a project is ACTIVE, the periodic autosave also writes the live board into it —
   no manual 💾 Save needed to keep the project current. While NO project is active (a
   new board, or one opened from a file/import), the board mirrors into this special
   pseudo-project instead: it can be opened, downloaded and cleared, but never shared,
   versioned or deleted — save the board as a real project to graduate out of it. */
const PROJ_AUTOSAVE_ID = "_autosave";

async function projAutosaveMirror(json){
  if (!Projects.supported) return;
  let meta = Projects.activeId ? await projReadMeta(Projects.activeId) : null;
  if (!meta){
    meta = await projReadMeta(PROJ_AUTOSAVE_ID) || {
      id: PROJ_AUTOSAVE_ID, name: "Autosave",
      created: Date.now(), modified: 0, size: 0, stats: null, thumb: null, versions: [],
    };
    meta.kind = "autosave";
  }
  await projSaveInto(meta, json, null);   // keeps the existing thumbnail
}

/* refresh the mirror target's thumbnail from the live board — done when the Projects
   tab opens (the board canvas is hidden then, so the zoom-to-fit capture can't flash) */
async function projRefreshMirrorThumb(){
  try {
    if (!Projects.supported || typeof boardHasContent !== "function" || !boardHasContent()) return;
    const meta = await projReadMeta(Projects.activeId || PROJ_AUTOSAVE_ID);
    if (!meta) return;
    const t = projCaptureThumb();
    if (t){ meta.thumb = t; await projWriteMeta(meta); }
  } catch(e){}
}

/* the live board just got saved into a REAL project — the Autosave slot's copy of it
   is now redundant (and would linger as a stale duplicate), so drop it silently */
async function projDropAutosaveSlot(){
  try { const root = await projRootDir(); await root.removeEntry(PROJ_AUTOSAVE_ID, { recursive: true }); } catch(e){}
}

Projects.clearAutosave = async () => {
  if (!confirm("Clear the Autosave slot? The board you are editing stays open — only the stored autosave copy is emptied. While the board isn't saved as a project, the slot fills up again on the next change.")) return;
  try { const root = await projRootDir(); await root.removeEntry(PROJ_AUTOSAVE_ID, { recursive: true }); } catch(e){}
  UI.toast("Autosave slot cleared");
  Projects.render();
};

/* ---------------- OPFS I/O ---------------- */
async function projRootDir(){
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("projects", { create: true });
}
async function projDir(pid, create){
  const root = await projRootDir();
  return root.getDirectoryHandle(pid, { create: !!create });
}
async function projWrite(dir, name, text){
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(text);
  await w.close();
}
async function projRead(dir, name){
  try {
    const fh = await dir.getFileHandle(name);
    return await (await fh.getFile()).text();
  } catch(e){ return null; }
}
async function projReadMeta(pid){
  try {
    const d = await projDir(pid);
    const t = await projRead(d, "meta.json");
    if (!t) return null;
    const m = JSON.parse(t);
    if (!Array.isArray(m.versions)) m.versions = [];
    return m;
  } catch(e){ return null; }
}
async function projWriteMeta(meta){
  const d = await projDir(meta.id, true);
  await projWrite(d, "meta.json", JSON.stringify(meta));
}
async function projVersionText(pid, vid){
  try {
    const d = await projDir(pid);
    if (!vid) return await projRead(d, "current.json");
    const vd = await d.getDirectoryHandle("versions");
    return await projRead(vd, vid + ".json");
  } catch(e){ return null; }
}

/* every project meta, newest-modified first */
Projects.list = async () => {
  const out = [];
  const root = await projRootDir();
  for await (const [name, handle] of root.entries()){
    if (handle.kind !== "directory") continue;
    const meta = await projReadMeta(name);
    if (meta) out.push(meta);
  }
  out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return out;
};

/* ---------------- formatting ---------------- */
function projFmtSize(n){
  if (!n && n !== 0) return "?";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
function projFmtDate(ts){
  return ts ? new Date(ts).toLocaleString() : "?";
}
function projStatsOf(projJson){
  let p = projJson;
  if (typeof p === "string"){ try { p = JSON.parse(p); } catch(e){ p = {}; } }
  // v2 projects keep the collections per PCB page under `boards`; v1 keeps them flat
  const F = (col) => p.boards ? p.boards.reduce((n, b) => n + (b[col] || []).length, 0)
                              : (p[col] || []).length;
  return {
    components: F("components"),
    nets:       (p.nets || []).length,
    traces:     F("traces"),
    vias:       F("vias"),
    layers:     F("layers"),
    boards:     p.boards ? p.boards.length : 1,
  };
}
function projStatsLabel(s){
  if (!s) return "";
  return (s.boards > 1 ? s.boards + " PCBs · " : "") +
         s.components + " parts · " + s.nets + " nets · " + s.traces + " traces · " +
         s.vias + " vias · " + s.layers + " images";
}
async function projStorageLabel(){
  try {
    const est = await navigator.storage.estimate();
    return "browser storage: " + projFmtSize(est.usage || 0) + " of " + projFmtSize(est.quota || 0);
  } catch(e){ return ""; }
}

/* ---------------- thumbnail ---------------- */
/* Photograph the live board: point the camera at the whole board, draw one frame
   synchronously, scale it down, then put the camera back. Returns a JPEG dataURL,
   or null when the canvas is unusable (no size yet, or tainted by a hosted image
   loaded without CORS). */
function projCaptureThumb(w){
  const cv = View.canvas;
  if (!cv || !cv.width || !cv.height) return null;
  const saved = { panX: View.panX, panY: View.panY, zoom: View.zoom };
  try {
    zoomToFit();
    render();
    const W = w || 280;
    const H = Math.max(64, Math.min(W, Math.round(W * cv.height / cv.width)));
    const t = document.createElement("canvas");
    t.width = W; t.height = H;
    const tc = t.getContext("2d");
    tc.fillStyle = "#10141a"; tc.fillRect(0, 0, W, H);
    tc.drawImage(cv, 0, 0, W, H);
    return t.toDataURL("image/jpeg", 0.72);
  } catch(e){
    return null;
  } finally {
    View.panX = saved.panX; View.panY = saved.panY; View.zoom = saved.zoom;
    requestRender();
  }
}

/* ---------------- save / open / delete ---------------- */
/* write the LIVE board into a project's current slot (stats/size/thumb refresh) */
async function projSaveInto(meta, json, thumb){
  const d = await projDir(meta.id, true);
  await projWrite(d, "current.json", json);
  meta.modified = Date.now();
  meta.size = json.length;
  meta.stats = projStatsOf(json);
  meta.thumb = thumb || meta.thumb || null;
  await projWriteMeta(meta);
}

Projects.saveAsNew = async () => {
  if (!Projects.supported){ UI.toast("Browser storage isn't available here — see the note on the Projects tab"); return; }
  const name = prompt("New project name:", "Board " + new Date().toLocaleDateString());
  if (name == null) return;
  const meta = {
    id: projNewId("p"), name: name.trim() || "Untitled board",
    created: Date.now(), modified: Date.now(),
    size: 0, stats: null, thumb: null, versions: [],
  };
  try {
    await projSaveInto(meta, serializeProject(), projCaptureThumb());
  } catch(e){
    UI.toast("Could not save the project: " + e.message);
    return;
  }
  projSetActive(meta.id);
  await projDropAutosaveSlot();   // the board graduated into a real project
  UI.toast("Saved board as project “" + meta.name + "”");
  Projects.render();
};

Projects.save = async (pid) => {
  const meta = await projReadMeta(pid);
  if (!meta){ UI.toast("That project no longer exists"); Projects.render(); return; }
  if (pid !== Projects.activeId &&
      !confirm("Overwrite “" + meta.name + "” with the board you are editing now? Its previous state is lost unless it was frozen as a version.")) return;
  await projSaveInto(meta, serializeProject(), projCaptureThumb());
  projSetActive(pid);
  await projDropAutosaveSlot();   // the board graduated into a real project
  UI.toast("Saved board into “" + meta.name + "”");
  Projects.render();
};

/* freeze the LIVE board as a named version — it also becomes the project's current state */
Projects.addVersion = async (pid) => {
  const meta = await projReadMeta(pid);
  if (!meta){ UI.toast("That project no longer exists"); Projects.render(); return; }
  const label = prompt("Version label:", "v" + (meta.versions.length + 1));
  if (label == null) return;
  const json = serializeProject();
  const thumb = projCaptureThumb();
  const vid = projNewId("v");
  const d = await projDir(pid, true);
  const vd = await d.getDirectoryHandle("versions", { create: true });
  await projWrite(vd, vid + ".json", json);
  meta.versions.unshift({
    id: vid, label: label.trim() || ("v" + (meta.versions.length + 1)),
    created: Date.now(), size: json.length, stats: projStatsOf(json), thumb,
  });
  await projSaveInto(meta, json, thumb);
  projSetActive(pid);
  await projDropAutosaveSlot();   // the board graduated into a real project
  Projects.expanded.add(pid);
  UI.toast("Version “" + meta.versions[0].label + "” saved in “" + meta.name + "”");
  Projects.render();
};

Projects.open = async (pid, vid) => {
  const meta = await projReadMeta(pid);
  const text = await projVersionText(pid, vid);
  if (!meta || !text){ UI.toast("Could not read that saved project"); Projects.render(); return; }
  const ver = vid ? meta.versions.find(v => v.id === vid) : null;
  const what = "“" + meta.name + "”" + (ver ? " version “" + ver.label + "”" : "");
  if (boardHasContent() && !confirm("Open " + what + "? This replaces the current board. Unsaved work will be lost.")) return;
  try {
    loadProject(text, () => {
      UI.activeLayerId = State.layers[0]?.id ?? null;
      UI.ensureVisibleLayer();   // all-hidden board (e.g. saved by a multiplayer guest) → show layer 1
      UI.select(null);
      UI.rebuildSideSelect(); syncSettings();
      UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
      zoomToFit();
      markImagesDirty(); // adopt the opened project (incl. images) into the autosave slot
      // opening the autosave slot itself keeps the board "unsaved" (no active project)
      projSetActive(pid === PROJ_AUTOSAVE_ID ? null : pid);
      EditorTabs.show("visual");
      UI.toast("Opened " + what + " — " + State.components.length + " components, " + State.nets.length + " nets");
    });
  } catch(err){
    alert("Could not open project: " + err.message);
  }
};

Projects.download = async (pid, vid) => {
  const meta = await projReadMeta(pid);
  const text = await projVersionText(pid, vid);
  if (!meta || !text){ UI.toast("Could not read that saved project"); return; }
  const ver = vid ? meta.versions.find(v => v.id === vid) : null;
  const safe = (s) => (s || "project").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
  const fname = safe(meta.name) + (ver ? "-" + safe(ver.label) : "") + ".pcbrev.json";
  downloadFile(fname, text, "application/json");
  UI.toast("Downloaded " + fname);
};

/* ---------------- image-layer zip export ---------------- */
/* minimal ZIP writer (store method, no compression — the images are already
   compressed PNG/JPEG). Local file headers + central directory + end record. */
const PROJ_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++){
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function projCrc32(bytes){
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = PROJ_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function projBuildZip(files){   // files: [{name, bytes:Uint8Array}]
  const enc = new TextEncoder();
  const u16 = (v) => [v & 255, (v >> 8) & 255];
  const u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const parts = [], central = [];
  let offset = 0;
  for (const f of files){
    const nameB = enc.encode(f.name);
    const crc = projCrc32(f.bytes);
    const head = new Uint8Array([0x50,0x4B,0x03,0x04, ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(f.bytes.length), ...u32(f.bytes.length),
      ...u16(nameB.length), ...u16(0)]);
    parts.push(head, nameB, f.bytes);
    central.push(new Uint8Array([0x50,0x4B,0x01,0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(crc), ...u32(f.bytes.length), ...u32(f.bytes.length),
      ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nameB);
    offset += head.length + nameB.length + f.bytes.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new Uint8Array([0x50,0x4B,0x05,0x06, ...u16(0), ...u16(0), ...u16(files.length),
    ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}
function projDownloadBlob(fname, blob){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
function projSafeName(s){
  return (s || "project").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "project";
}

/* download every stored image layer of a project as <name>-images.zip. Hosted (URL)
   layers keep no bytes in the project, so they can't be included and are counted out. */
Projects.downloadImages = async (pid) => {
  const meta = await projReadMeta(pid);
  const raw = await projVersionText(pid, null);
  if (!meta || !raw){ UI.toast("Could not read that saved project"); return; }
  let p;
  try { p = JSON.parse(raw); } catch(e){ UI.toast("Could not parse that project"); return; }
  const files = [];
  const used = new Set();
  let hosted = 0;
  const allLayers = (p.layers || []).concat((p.boards || []).flatMap(b => b.layers || []));
  allLayers.forEach((l, i) => {
    const m = /^data:image\/([a-z0-9.+-]+);base64,(.+)$/i.exec(l.dataURL || "");
    if (!m){ if (l.url) hosted++; return; }
    let ext = m[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    if (ext === "svg+xml") ext = "svg";
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    let base = projSafeName(l.name || ("layer" + (i + 1)));
    let name = base + "." + ext, k = 2;
    while (used.has(name)) name = base + "-" + (k++) + "." + ext;
    used.add(name);
    files.push({ name, bytes });
  });
  if (!files.length){
    UI.toast(hosted ? "This project's image layers are URL-hosted — no image bytes are stored to zip"
                    : "This project has no image layers");
    return;
  }
  const fname = projSafeName(meta.name) + "-images.zip";
  projDownloadBlob(fname, projBuildZip(files));
  UI.toast("Downloaded " + fname + " (" + files.length + " image" + (files.length === 1 ? "" : "s") +
           (hosted ? " — " + hosted + " URL-hosted layer" + (hosted === 1 ? "" : "s") + " not included" : "") + ")");
};

Projects.remove = async (pid) => {
  const meta = await projReadMeta(pid);
  if (!meta){ Projects.render(); return; }
  const vn = meta.versions.length;
  if (!confirm("Delete project “" + meta.name + "”" + (vn ? " and its " + vn + " version" + (vn > 1 ? "s" : "") : "") +
               " from browser storage? This cannot be undone.")) return;
  const root = await projRootDir();
  await root.removeEntry(pid, { recursive: true });
  if (Projects.activeId === pid) projSetActive(null);
  Projects.expanded.delete(pid);
  UI.toast("Deleted “" + meta.name + "”");
  Projects.render();
};

Projects.removeVersion = async (pid, vid) => {
  const meta = await projReadMeta(pid);
  if (!meta) return;
  const ver = meta.versions.find(v => v.id === vid);
  if (!ver) return;
  if (!confirm("Delete version “" + ver.label + "” of “" + meta.name + "”? This cannot be undone.")) return;
  meta.versions = meta.versions.filter(v => v.id !== vid);
  try {
    const d = await projDir(pid);
    const vd = await d.getDirectoryHandle("versions");
    await vd.removeEntry(vid + ".json");
  } catch(e){}
  await projWriteMeta(meta);
  UI.toast("Deleted version “" + ver.label + "”");
  Projects.render();
};

Projects.rename = async (pid, name) => {
  const meta = await projReadMeta(pid);
  if (!meta) return;
  name = (name || "").trim();
  if (!name || name === meta.name){ Projects.render(); return; }
  meta.name = name;
  await projWriteMeta(meta);
  Projects.refreshBadge();
  Projects.render();
};

/* ---------------- upload (button + drag & drop) ---------------- */
/* validate project JSON text and store it as a NEW project — the live board is
   untouched. Returns the meta, or null (with a toast) when the text isn't a project. */
async function projImportText(name, text){
  let p;
  try { p = JSON.parse(text); } catch(e){ p = null; }
  if (!p || p.app !== "pcb-reveng"){
    UI.toast("“" + name + "” is not a PCB RevEng project (expected .pcbrev.json content)");
    return null;
  }
  const meta = {
    id: projNewId("p"),
    name: (name || "").trim() || "Imported board",
    created: Date.now(), modified: Date.now(),
    size: text.length, stats: projStatsOf(p), thumb: null, versions: [],
  };
  const d = await projDir(meta.id, true);
  await projWrite(d, "current.json", text);
  await projWriteMeta(meta);
  return meta;
}

Projects.importFiles = async (files) => {
  let added = 0;
  for (const f of files){
    if (!/\.json$/i.test(f.name)){
      UI.toast("Skipped “" + f.name + "” — only .pcbrev.json project files can be uploaded here");
      continue;
    }
    const text = await f.text();
    if (await projImportText(f.name.replace(/\.pcbrev\.json$|\.json$/i, ""), text)) added++;
  }
  if (added) UI.toast("Uploaded " + added + " project" + (added > 1 ? "s" : "") + " into browser storage");
  Projects.render();
};

/* ---------------- pastebin share / import ---------------- */
/* Share = upload a project's JSON to dpaste.com (a pastebin that, unlike
   pastebin.com, allows browser uploads — no API key, CORS open; pastes expire
   after PASTE_EXPIRY_DAYS). Board photos are NEVER included in a paste — their
   dataURLs are megabytes of base64 that no paste site accepts — so the user is
   warned up front (confirm) and again in the result dialog. Import accepts a
   paste URL (dpaste.com is fetched directly; pastebin.com and friends block
   browser reads, so the dialog also has a "paste the raw text" box that works
   with ANY pastebin). */
const PASTE_API = "https://dpaste.com/api/v2/";
const PASTE_EXPIRY_DAYS = 30;

function projStripImages(text){
  try {
    const p = JSON.parse(text);
    let stripped = false;
    const lists = [p.layers || []].concat((p.boards || []).map(b => b.layers || []));
    for (const ls of lists)
      for (const l of ls)
        if (l.dataURL){ l.dataURL = ""; stripped = true; }
    return { text: JSON.stringify(p), stripped };
  } catch(e){ return { text, stripped: false }; }
}

Projects.share = async (pid) => {
  const meta = await projReadMeta(pid);
  const raw = await projVersionText(pid, null);
  if (!meta || !raw){ UI.toast("Could not read that saved project"); return; }
  const s = projStripImages(raw);
  let body = s.text, note = "";
  if (s.stripped){
    if (!confirm("⚠ Board photos are NOT included when sharing to a paste site — the image data (" +
                 projFmtSize(raw.length) + " here) is far too much for a paste.\n\n" +
                 "The link will carry the full board — parts, nets, traces, vias, notes — but no photo layers. " +
                 "Use ⬇ File to pass the complete project including its images.\n\nShare “" +
                 meta.name + "” without the photos?")) return;
    note = "⚠ Board photos were NOT included (too much data for a paste site) — " +
           "send the .pcbrev.json file (⬇ File) if the recipient needs them.";
  }
  UI.toast("Uploading “" + meta.name + "” to dpaste.com…");
  let url;
  try {
    const r = await fetch(PASTE_API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        content: body, syntax: "json",
        title: "PCB RevEng — " + meta.name,
        expiry_days: String(PASTE_EXPIRY_DAYS),
      }),
    });
    const t = (await r.text()).trim();
    if (!r.ok || !/^https?:\/\//.test(t)) throw new Error(t.slice(0, 200) || ("HTTP " + r.status));
    url = t;
  } catch(err){
    alert("Paste upload failed: " + err.message +
          "\n\nThe paste service may be down or the board too large (" +
          projFmtSize(body.length) + " sent). Use ⬇ File instead.");
    return;
  }
  const dlg = $("#paste-share-dialog");
  $("#paste-share-url").value = url;
  $("#paste-share-note").textContent =
    "Anyone with this link can import the board (Projects → 🌐 Import from URL). " +
    "It expires in " + PASTE_EXPIRY_DAYS + " days. " + note;
  try { await navigator.clipboard.writeText(url); UI.toast("Paste link copied to clipboard"); } catch(e){}
  dlg.showModal();
  $("#paste-share-url").select();
};

/* a paste URL → its raw-text URL (dpaste.com/XXX → …/XXX.txt, pastebin.com/XXX →
   pastebin.com/raw/XXX, raw/gist links pass through) */
function projPasteRawUrl(u){
  u = (u || "").trim();
  if (!/^https?:\/\//i.test(u)) return null;
  let m = u.match(/^https?:\/\/dpaste\.com\/([A-Za-z0-9]+)/);
  if (m) return "https://dpaste.com/" + m[1] + ".txt";
  m = u.match(/^https?:\/\/(?:www\.)?pastebin\.com\/(?:raw\/)?([A-Za-z0-9]+)/);
  if (m) return "https://pastebin.com/raw/" + m[1];
  return u;
}

Projects.openImportDialog = () => {
  $("#paste-import-url").value = "";
  $("#paste-import-text").value = "";
  $("#paste-import-status").textContent = "";
  $("#paste-import-dialog").showModal();
};

async function projImportFromPasteDialog(){
  const status = $("#paste-import-status");
  const urlIn = $("#paste-import-url").value.trim();
  let text = $("#paste-import-text").value.trim();
  let name = "URL import";
  if (!text && urlIn){
    const raw = projPasteRawUrl(urlIn);
    if (!raw){ status.textContent = "That doesn't look like a http(s) paste URL."; return; }
    status.textContent = "Fetching paste…";
    try {
      const r = await fetch(raw);
      if (!r.ok) throw new Error("HTTP " + r.status);
      text = await r.text();
    } catch(err){
      status.textContent = "Could not fetch that URL from the browser (" + err.message +
        "). pastebin.com blocks direct reads — open the paste, copy its RAW text and paste it in the box below.";
      return;
    }
    name = "Paste " + (raw.split("/").pop() || "").replace(/\.txt$/, "");
  }
  if (!text){ status.textContent = "Give a paste URL or paste the project JSON below."; return; }
  const meta = await projImportText(name, text);
  if (!meta){ status.textContent = "That content is not a PCB RevEng project — copy the paste's RAW text, not the page."; return; }
  $("#paste-import-dialog").close();
  UI.toast("Imported “" + meta.name + "” from paste — " + projStatsLabel(meta.stats));
  Projects.render();
}

/* ---------------- rendering ---------------- */
function projEl(tag, cls, text){
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}
function projBtn(label, title, onclick){
  const b = projEl("button", null, label);
  if (title) b.title = title;
  b.addEventListener("click", onclick);
  return b;
}
function projThumbEl(thumb, cls){
  if (thumb){
    const img = projEl("img", cls);
    img.src = thumb;
    return img;
  }
  return projEl("div", cls + " empty", "no preview");
}

function projVersionRow(meta, v){
  const row = projEl("div", "proj-ver");
  row.appendChild(projThumbEl(v.thumb, "proj-ver-thumb"));
  const grow = projEl("div", "grow");
  grow.appendChild(projEl("div", "proj-ver-label", v.label));
  grow.appendChild(projEl("div", "proj-ver-sub",
    projFmtDate(v.created) + " · " + projFmtSize(v.size)));
  grow.title = projStatsLabel(v.stats);
  row.appendChild(grow);
  row.appendChild(projBtn("Open", "Load this frozen version onto the board", () => Projects.open(meta.id, v.id)));
  row.appendChild(projBtn("⬇", "Download this version as a .pcbrev.json file", () => Projects.download(meta.id, v.id)));
  row.appendChild(projBtn("🗑", "Delete this version", () => Projects.removeVersion(meta.id, v.id)));
  return row;
}

function projCard(meta){
  const isAuto = meta.kind === "autosave";
  const card = projEl("div", "proj-card" + (isAuto ? " special" : "") +
                             (!isAuto && meta.id === Projects.activeId ? " active" : ""));
  card.appendChild(projThumbEl(meta.thumb, "proj-thumb"));

  const nameRow = projEl("div", "proj-name-row");
  if (isAuto){
    const name = projEl("div", "proj-name-static", "Autosave");
    name.title = "The special autosave slot — the board you are editing lands here automatically while it isn't saved as a project";
    nameRow.appendChild(name);
    nameRow.appendChild(projEl("span", "proj-badge special", "autosave"));
  } else {
    const name = projEl("input", "proj-name");
    name.value = meta.name;
    name.title = "Project name — click to rename";
    name.addEventListener("change", () => Projects.rename(meta.id, name.value));
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
    nameRow.appendChild(name);
    if (meta.id === Projects.activeId)
      nameRow.appendChild(projEl("span", "proj-badge", "current"));
  }
  card.appendChild(nameRow);

  const det = projEl("div", "proj-meta");
  det.appendChild(projEl("div", null, projStatsLabel(meta.stats)));
  det.appendChild(projEl("div", null, projFmtSize(meta.size) + " · saved " + projFmtDate(meta.modified)));
  det.appendChild(projEl("div", null, isAuto
    ? "Not a saved project — “＋ Save current project as new project” makes it one"
    : "created " + projFmtDate(meta.created)));
  card.appendChild(det);

  const acts = projEl("div", "proj-actions");
  acts.appendChild(projBtn("Open", isAuto
    ? "Load the autosaved board (replaces the current board)"
    : "Load this project onto the board (replaces the current board)", () => Projects.open(meta.id)));
  if (!isAuto){
    acts.appendChild(projBtn("💾 Save", meta.id === Projects.activeId
      ? "Save the board you are editing into this project (it also autosaves here while it is current)"
      : "Overwrite this project with the board you are editing (asks first)", () => Projects.save(meta.id)));
    acts.appendChild(projBtn("＋ Version", "Freeze the board you are editing as a named version of this project", () => Projects.addVersion(meta.id)));
  }
  acts.appendChild(projBtn("⬇ File", "Download this " + (isAuto ? "autosaved board" : "project") + " as a .pcbrev.json file", () => Projects.download(meta.id)));
  acts.appendChild(projBtn("🖼 Images", "Download this project's stored image layers as a .zip", () => Projects.downloadImages(meta.id)));
  if (isAuto){
    acts.appendChild(projBtn("⌫ Clear", "Empty the autosave slot (the board you are editing stays open)", () => Projects.clearAutosave()));
  } else {
    acts.appendChild(projBtn("🌐 Share", "Upload this project to dpaste.com and get a link anyone can import (expires after " + PASTE_EXPIRY_DAYS + " days). Board photos are NOT included — use ⬇ File for the complete project.", () => Projects.share(meta.id)));
    acts.appendChild(projBtn("🗑", "Delete this project from browser storage", () => Projects.remove(meta.id)));
  }
  card.appendChild(acts);

  if (!isAuto){
    const vs = projEl("div", "proj-versions");
    const open = Projects.expanded.has(meta.id);
    const vn = meta.versions.length;
    const tog = projBtn((open ? "▾ " : "▸ ") + vn + " version" + (vn === 1 ? "" : "s"),
      "Version history — frozen snapshots of this project", () => {
        if (open) Projects.expanded.delete(meta.id); else Projects.expanded.add(meta.id);
        Projects.render();
      });
    tog.className = "proj-ver-toggle";
    vs.appendChild(tog);
    if (open) for (const v of meta.versions) vs.appendChild(projVersionRow(meta, v));
    card.appendChild(vs);
  }
  return card;
}

/* the bundled sample board, presented as a permanent read-only "example" card:
   open only — it can't be deleted, versioned, shared or downloaded from here */
function projExampleCard(){
  const card = projEl("div", "proj-card special");
  const img = projEl("img", "proj-thumb");
  img.src = "sample-thumb.jpg?v=1";
  img.alt = "";
  img.addEventListener("error", () => { img.replaceWith(projEl("div", "proj-thumb empty", "no preview")); });
  card.appendChild(img);
  const nameRow = projEl("div", "proj-name-row");
  const name = projEl("div", "proj-name-static", "Example board");
  name.title = "The sample project bundled with the app";
  nameRow.appendChild(name);
  nameRow.appendChild(projEl("span", "proj-badge special", "example"));
  card.appendChild(nameRow);
  const det = projEl("div", "proj-meta");
  det.appendChild(projEl("div", null, "The bundled sample project — a small demo board to explore the app with."));
  det.appendChild(projEl("div", null, "Built in — always available, never changes."));
  card.appendChild(det);
  const acts = projEl("div", "proj-actions");
  acts.appendChild(projBtn("Open", "Load the example board (replaces the current board)", async () => {
    if (boardHasContent() && !confirm("Open the example board? This replaces the current board. Unsaved work will be lost.")) return;
    projSetActive(null);
    await loadDefaultProject();
    EditorTabs.show("visual");
  }));
  card.appendChild(acts);
  return card;
}

Projects.render = async () => {
  const grid = $("#projects-grid");
  if (!grid || $("#projects-pane").style.display === "none") return;
  const empty = $("#projects-empty");
  const fileHint = location.protocol === "file:"
    ? " Chrome blocks browser storage (OPFS) for pages opened straight from disk (file://) — serve the app over http(s) with any small local server, or use Firefox. The board itself still autosaves."
    : "";
  let metas = [], storageErr = null;
  if (!Projects.supported){
    storageErr = "Saved projects need the Origin Private File System (OPFS), which isn't available here." + fileHint;
  } else {
    try { metas = await Projects.list(); }
    catch(e){
      Projects.supported = false;   // runtime failure (e.g. Chrome on file://) — stop retrying
      storageErr = "Could not read browser storage: " + e.message + "." + fileHint;
    }
  }
  // the autosave slot and the built-in example are pinned in their own section,
  // clearly apart from real saved projects
  const specials = metas.filter(m => m.kind === "autosave");
  const normal = metas.filter(m => m.kind !== "autosave");
  $("#projects-count").textContent = normal.length ? "(" + normal.length + ")" : "";
  const store = $("#proj-storage");
  store.textContent = "";
  if (!storageErr) projStorageLabel().then(t => { store.textContent = t; });
  empty.style.display = (storageErr || !normal.length) ? "" : "none";
  empty.textContent = storageErr ||
    "No saved projects yet — “＋ Save current project as new project” stores the board you are editing here, or drop a .pcbrev.json file anywhere on this tab.";
  grid.innerHTML = "";
  grid.appendChild(projEl("div", "proj-sep", "Autosave & example — not saved projects"));
  for (const m of specials) grid.appendChild(projCard(m));
  grid.appendChild(projExampleCard());
  grid.appendChild(projEl("div", "proj-sep", "Saved projects"));
  for (const m of normal) grid.appendChild(projCard(m));
};

Projects.enter = () => {
  // refresh the current mirror target's thumbnail first (the board canvas is hidden
  // while this tab shows, so the capture can't visibly flash), then draw the grid
  projRefreshMirrorThumb().finally(() => Projects.render());
};

Projects.wire = () => {
  const pane = $("#projects-pane");
  if (!pane) return;
  // Chromium refuses OPFS on file:// pages — flag it loudly so nobody "saves" into the void
  const warn = $("#proj-file-warning");
  const chromium = !!window.chrome || /Chrom(e|ium)|Edg\//.test(navigator.userAgent);
  if (warn && location.protocol === "file:" && chromium) warn.style.display = "";
  $("#proj-saveas").addEventListener("click", () => Projects.saveAsNew());
  $("#proj-upload").addEventListener("click", () => $("#file-proj-upload").click());
  $("#file-proj-upload").addEventListener("change", (e) => {
    Projects.importFiles([...e.target.files]);
    e.target.value = "";
  });
  // pastebin share / import dialogs
  $("#proj-paste-import").addEventListener("click", () => Projects.openImportDialog());
  $("#paste-import-go").addEventListener("click", () => projImportFromPasteDialog());
  $("#paste-import-cancel").addEventListener("click", () => $("#paste-import-dialog").close());
  $("#paste-share-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#paste-share-url").value); UI.toast("Link copied"); }
    catch(e){ $("#paste-share-url").select(); document.execCommand("copy"); }
  });
  $("#paste-share-close").addEventListener("click", () => $("#paste-share-dialog").close());
  $("#active-project").addEventListener("click", () => EditorTabs.show("projects"));
  Projects.refreshBadge();
  // drag & drop upload anywhere on the pane
  ["dragenter", "dragover"].forEach(ev => pane.addEventListener(ev, (e) => {
    e.preventDefault(); pane.classList.add("dragover");
  }));
  ["dragleave", "drop"].forEach(ev => pane.addEventListener(ev, (e) => {
    e.preventDefault(); pane.classList.remove("dragover");
  }));
  pane.addEventListener("drop", (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) Projects.importFiles(files);
  });
};

window.addEventListener("DOMContentLoaded", () => { Projects.wire(); });
