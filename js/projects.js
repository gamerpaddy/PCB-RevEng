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
}

function projNewId(prefix){
  return (prefix || "p") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

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
  return {
    components: (p.components || []).length,
    nets:       (p.nets || []).length,
    traces:     (p.traces || []).length,
    vias:       (p.vias || []).length,
    layers:     (p.layers || []).length,
  };
}
function projStatsLabel(s){
  if (!s) return "";
  return s.components + " parts · " + s.nets + " nets · " + s.traces + " traces · " +
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
  const name = prompt("New project name:", "Board " + new Date().toLocaleDateString());
  if (name == null) return;
  const meta = {
    id: projNewId("p"), name: name.trim() || "Untitled board",
    created: Date.now(), modified: Date.now(),
    size: 0, stats: null, thumb: null, versions: [],
  };
  await projSaveInto(meta, serializeProject(), projCaptureThumb());
  projSetActive(meta.id);
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
      UI.select(null);
      UI.rebuildSideSelect(); syncSettings();
      UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
      zoomToFit();
      markImagesDirty(); // adopt the opened project (incl. images) into the autosave slot
      projSetActive(pid);
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
   after PASTE_EXPIRY_DAYS). Big boards carry megabytes of photo dataURLs that no
   paste site accepts, so images are stripped from the shared copy past ~1 MB and
   the recipient is told. Import accepts a paste URL (dpaste.com is fetched
   directly; pastebin.com and friends block browser reads, so the dialog also has
   a "paste the raw text" box that works with ANY pastebin). */
const PASTE_API = "https://dpaste.com/api/v2/";
const PASTE_EXPIRY_DAYS = 30;
const PASTE_STRIP_OVER = 1024 * 1024;

function projStripImages(text){
  try {
    const p = JSON.parse(text);
    let stripped = false;
    for (const l of (p.layers || [])){
      if (l.dataURL){ l.dataURL = ""; stripped = true; }
    }
    return { text: JSON.stringify(p), stripped };
  } catch(e){ return { text, stripped: false }; }
}

Projects.share = async (pid) => {
  const meta = await projReadMeta(pid);
  const raw = await projVersionText(pid, null);
  if (!meta || !raw){ UI.toast("Could not read that saved project"); return; }
  let body = raw, note = "";
  if (raw.length > PASTE_STRIP_OVER){
    const s = projStripImages(raw);
    if (s.stripped){
      body = s.text;
      note = "Board photos were left out (" + projFmtSize(raw.length) +
             " is too big for a paste site) — share image layers as files instead.";
    }
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
    "Anyone with this link can import the board (Projects → 🌐 Import from pastebin). " +
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
  let name = "Pastebin import";
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
  const card = projEl("div", "proj-card" + (meta.id === Projects.activeId ? " active" : ""));
  card.appendChild(projThumbEl(meta.thumb, "proj-thumb"));

  const nameRow = projEl("div", "proj-name-row");
  const name = projEl("input", "proj-name");
  name.value = meta.name;
  name.title = "Project name — click to rename";
  name.addEventListener("change", () => Projects.rename(meta.id, name.value));
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
  nameRow.appendChild(name);
  if (meta.id === Projects.activeId)
    nameRow.appendChild(projEl("span", "proj-badge", "current"));
  card.appendChild(nameRow);

  const det = projEl("div", "proj-meta");
  det.appendChild(projEl("div", null, projStatsLabel(meta.stats)));
  det.appendChild(projEl("div", null, projFmtSize(meta.size) + " · saved " + projFmtDate(meta.modified)));
  det.appendChild(projEl("div", null, "created " + projFmtDate(meta.created)));
  card.appendChild(det);

  const acts = projEl("div", "proj-actions");
  acts.appendChild(projBtn("Open", "Load this project onto the board (replaces the current board)", () => Projects.open(meta.id)));
  acts.appendChild(projBtn("💾 Save", meta.id === Projects.activeId
    ? "Save the board you are editing into this project"
    : "Overwrite this project with the board you are editing (asks first)", () => Projects.save(meta.id)));
  acts.appendChild(projBtn("＋ Version", "Freeze the board you are editing as a named version of this project", () => Projects.addVersion(meta.id)));
  acts.appendChild(projBtn("⬇ File", "Download this project as a .pcbrev.json file", () => Projects.download(meta.id)));
  acts.appendChild(projBtn("🌐 Share", "Upload this project to dpaste.com and get a link anyone can import (expires after " + PASTE_EXPIRY_DAYS + " days)", () => Projects.share(meta.id)));
  acts.appendChild(projBtn("🗑", "Delete this project from browser storage", () => Projects.remove(meta.id)));
  card.appendChild(acts);

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
  return card;
}

Projects.render = async () => {
  const grid = $("#projects-grid");
  if (!grid || $("#projects-pane").style.display === "none") return;
  const empty = $("#projects-empty");
  if (!Projects.supported){
    grid.innerHTML = "";
    empty.style.display = "";
    empty.textContent = "This browser does not support the Origin Private File System (OPFS) — the project browser needs a recent Chrome, Edge, Firefox or Safari.";
    return;
  }
  let metas = [];
  try { metas = await Projects.list(); }
  catch(e){
    grid.innerHTML = "";
    empty.style.display = "";
    empty.textContent = "Could not read browser storage: " + e.message;
    return;
  }
  $("#projects-count").textContent = metas.length ? "(" + metas.length + ")" : "";
  const store = $("#proj-storage");
  projStorageLabel().then(t => { store.textContent = t; });
  empty.style.display = metas.length ? "none" : "";
  empty.textContent = "No saved projects yet — “＋ Save board as project” stores the board you are editing here, or drop a .pcbrev.json file anywhere on this tab.";
  grid.innerHTML = "";
  for (const m of metas) grid.appendChild(projCard(m));
};

Projects.enter = () => { Projects.render(); };

Projects.wire = () => {
  const pane = $("#projects-pane");
  if (!pane) return;
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
