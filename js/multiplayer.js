/* ===== multiplayer.js — live collaboration over WebRTC (P2P, serverless) =====
   Peers connect directly via manual copy-paste signaling (invite / reply codes,
   deflate+base64 — no server involved beyond a public STUN lookup). One side
   hosts; the host relays between guests, so 3+ people work.

   Sync model: the WHOLE project core (parts, nets, traces, vias, notes,
   schematic, layer transforms — everything serializeProject covers except the
   embedded image bytes) is broadcast whenever it changes and applied on the
   other side. Simultaneous edits are last-write-wins. Hosted (URL) image
   layers always travel as links; embedded photos are only sent when the
   "share images" option is on, downscaled to a px/mm cap. Cursors are
   broadcast live and drawn as coloured pointers with name tags. */
"use strict";

const MP = {
  id: Math.random().toString(36).slice(2, 10),   // my peer id (also keys my cursor)
  peers: [],           // [{pc, dc, open, name, color, remoteId, q}]
  cursors: new Map(),  // from-id -> {x,y,name,color,ts,el,leave}
  isHost: false,
  applying: false,     // true while a remote state is being written into State
  pendingCore: null,   // newest remote core deferred during a local drag
  opts: { sendImages: false, maxPxPerMm: 10 },
  _lastCore: null,     // last core string sent OR applied (echo suppression)
  _imgSig: new Map(),  // layerId -> signature of the bitmap we last sent
  _pendingImgs: new Map(), // layerId -> dataURL that arrived before its layer
  _rx: new Map(),      // chunk reassembly buffers
  _pendingInvite: null,
  _lastRemoteUndo: 0,
  _tick: null,
  _seq: 0,
};

/* ---------------- small helpers ---------------- */

function mpLoadPrefs(){
  try {
    MP.name  = localStorage.getItem("pcbreveng.mpName")  || "";
    MP.color = localStorage.getItem("pcbreveng.mpColor") || "";
    const o = JSON.parse(localStorage.getItem("pcbreveng.mpOpts") || "null");
    if (o){ MP.opts.sendImages = !!o.sendImages; MP.opts.maxPxPerMm = +o.maxPxPerMm || 10; }
  } catch(e){}
  if (!MP.name)  MP.name  = "Player-" + MP.id.slice(0, 4);
  if (!MP.color) MP.color = ["#ff5d5d","#ffb84d","#ffe14d","#6fe06f","#4dd2ff","#b48cff","#ff7ad9"][Math.floor(Math.random()*7)];
}
function mpSavePrefs(){
  try {
    localStorage.setItem("pcbreveng.mpName", MP.name);
    localStorage.setItem("pcbreveng.mpColor", MP.color);
    localStorage.setItem("pcbreveng.mpOpts", JSON.stringify(MP.opts));
  } catch(e){}
}
function mpConnected(){ return MP.peers.some(p => p.open); }

/* ---------------- invite/reply codes: deflate + base64 ---------------- */

async function mpPack(obj){
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = bytes;
  if (window.CompressionStream){
    const cs = new CompressionStream("deflate-raw");
    out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  }
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return (window.CompressionStream ? "PCBMP1:" : "PCBMP0:") + btoa(bin);
}
async function mpUnpack(code){
  code = (code || "").trim();
  const m = /^PCBMP([01]):([A-Za-z0-9+/=\s]+)$/.exec(code);
  if (!m) throw new Error("That doesn't look like a PCB RevEng multiplayer code");
  const bin = atob(m[2].replace(/\s+/g, ""));
  let bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
  if (m[1] === "1"){
    const ds = new DecompressionStream("deflate-raw");
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* ---------------- connection setup ---------------- */

function mpNewPC(){
  return new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
}
function mpWaitIce(pc){
  return new Promise(res => {
    if (pc.iceGatheringState === "complete") return res();
    const t = setTimeout(res, 4000);   // whatever candidates we have by then
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete"){ clearTimeout(t); res(); }
    });
  });
}

function mpAddPeer(pc){
  const peer = { pc, dc: null, open: false, name: "…", color: "#888", remoteId: null, q: [] };
  MP.peers.push(peer);
  pc.onconnectionstatechange = () => {
    if (["failed", "disconnected", "closed"].includes(pc.connectionState)) mpDropPeer(peer);
    mpRefreshUI();
  };
  return peer;
}

function mpBindDC(peer, dc){
  peer.dc = dc;
  dc.bufferedAmountLowThreshold = 1 << 20;   // 1 MB
  dc.onbufferedamountlow = () => mpDrainQueue(peer);
  dc.onopen = () => {
    peer.open = true;
    mpSendObj(peer, { t: "hi", from: MP.id, name: MP.name, color: MP.color });
    if (MP.isHost){
      // host is authoritative: push the full board to the newcomer
      const core = mpCoreString();
      MP._lastCore = core;
      mpSendObj(peer, { t: "state", from: MP.id, core });
      MP._imgSig.clear();   // re-offer images so the newcomer gets them too
    } else if (MP._lastCore == null){
      // guest: adopt the host's board — don't blast our own on join
      MP._lastCore = mpCoreString();
    }
    mpStartLoop();
    mpRefreshUI();
    if (typeof UI !== "undefined") UI.toast("Multiplayer: peer connected");
  };
  dc.onclose = () => mpDropPeer(peer);
  dc.onmessage = (e) => mpOnMsg(peer, e.data);
}

function mpDropPeer(peer){
  const i = MP.peers.indexOf(peer);
  if (i < 0) return;
  MP.peers.splice(i, 1);
  try { peer.dc && peer.dc.close(); } catch(e){}
  try { peer.pc.close(); } catch(e){}
  if (peer.remoteId){
    const c = MP.cursors.get(peer.remoteId);
    if (c && c.el) c.el.remove();
    MP.cursors.delete(peer.remoteId);
  }
  if (!MP.peers.length) mpStopLoop();
  mpRefreshUI();
  if (typeof UI !== "undefined") UI.toast("Multiplayer: peer left");
}

function mpLeave(){
  mpBroadcast({ t: "bye", from: MP.id });
  for (const p of [...MP.peers]) mpDropPeer(p);
  MP.isHost = false;
  MP._pendingInvite = null;
  MP._lastCore = null;
  MP._imgSig.clear();
  for (const c of MP.cursors.values()) if (c.el) c.el.remove();
  MP.cursors.clear();
  mpRefreshUI();
}

/* host side: mint an invite code (one pending guest at a time) */
async function mpCreateInvite(){
  const pc = mpNewPC();
  const peer = mpAddPeer(pc);
  mpBindDC(peer, pc.createDataChannel("mp"));
  await pc.setLocalDescription(await pc.createOffer());
  await mpWaitIce(pc);
  MP._pendingInvite = peer;
  MP.isHost = true;
  return mpPack({ k: "offer", sdp: pc.localDescription.sdp });
}
async function mpAcceptReply(code){
  const o = await mpUnpack(code);
  if (o.k !== "answer") throw new Error("That is an invite code — paste the guest's REPLY code here");
  if (!MP._pendingInvite) throw new Error("Create an invite code first");
  await MP._pendingInvite.pc.setRemoteDescription({ type: "answer", sdp: o.sdp });
  MP._pendingInvite = null;
}
/* guest side: consume an invite, produce the reply code */
async function mpJoin(code){
  const o = await mpUnpack(code);
  if (o.k !== "offer") throw new Error("That is a reply code — the HOST pastes that, not you");
  const pc = mpNewPC();
  const peer = mpAddPeer(pc);
  pc.ondatachannel = (e) => mpBindDC(peer, e.channel);
  await pc.setRemoteDescription({ type: "offer", sdp: o.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await mpWaitIce(pc);
  return mpPack({ k: "answer", sdp: pc.localDescription.sdp });
}

/* ---------------- transport: chunked JSON over the data channel ---------------- */

const MP_CHUNK = 60000;   // chars per message — safely under the SCTP limit

function mpRawSend(peer, s){
  if (!peer.open || !peer.dc) return;
  if (peer.q.length || peer.dc.bufferedAmount > (8 << 20)){ peer.q.push(s); return; }
  try { peer.dc.send(s); } catch(e){ peer.q.push(s); }
}
function mpDrainQueue(peer){
  while (peer.q.length && peer.open && peer.dc.bufferedAmount < (8 << 20)){
    try { peer.dc.send(peer.q.shift()); } catch(e){ break; }
  }
}
function mpSendObj(peer, obj){
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (s.length <= MP_CHUNK){ mpRawSend(peer, s); return; }
  const id = MP.id + ":" + (MP._seq++);
  const total = Math.ceil(s.length / MP_CHUNK);
  for (let i = 0; i < total; i++)
    mpRawSend(peer, JSON.stringify({ t: "chunk", id, seq: i, total, data: s.substr(i * MP_CHUNK, MP_CHUNK) }));
}
function mpBroadcast(obj, except){
  const s = JSON.stringify(obj);
  for (const p of MP.peers) if (p !== except && p.open) mpSendObj(p, s);
}

function mpOnMsg(peer, raw){
  let m;
  try { m = JSON.parse(raw); } catch(e){ return; }
  if (m.t === "chunk"){
    let b = MP._rx.get(m.id);
    if (!b){ b = { total: m.total, parts: [], got: 0 }; MP._rx.set(m.id, b); }
    if (b.parts[m.seq] == null){ b.parts[m.seq] = m.data; b.got++; }
    if (b.got === b.total){ MP._rx.delete(m.id); mpOnMsg(peer, b.parts.join("")); }
    return;
  }
  if (m.from && !peer.remoteId && m.t === "hi") peer.remoteId = m.from;

  switch (m.t){
    case "hi":
      peer.name = m.name || peer.name; peer.color = m.color || peer.color;
      mpRefreshUI();
      break;
    case "cur":
      mpCursorMsg(m);
      if (MP.isHost) mpBroadcast(m, peer);
      break;
    case "state":
      if (MP.isHost) mpBroadcast(m, peer);
      MP.pendingCore = m.core;
      mpTryApply();
      break;
    case "img":
      if (MP.isHost) mpBroadcast(m, peer);
      mpApplyImage(m.layerId, m.data);
      break;
    case "bye":
      mpDropPeer(peer);
      break;
  }
}

/* ---------------- outgoing state sync ---------------- */

/* the shareable project core: everything serializeProject saves, minus the
   embedded image bytes (those travel separately, and only when opted in).
   Built the same way on every peer, so equal boards give equal strings. */
function mpCoreString(){
  const s = JSON.parse(serializeProject());
  s.layers = (s.layers || []).map(l => { const { dataURL, ...rest } = l; return rest; });
  return JSON.stringify(s);
}

function mpStartLoop(){
  if (MP._tick) return;
  MP._tick = setInterval(mpTickFn, 700);
}
function mpStopLoop(){
  clearInterval(MP._tick); MP._tick = null;
}
function mpTickFn(){
  mpTryApply();   // a deferred remote apply waiting for a drag to end
  if (!mpConnected() || MP.applying) return;
  if (typeof Tools !== "undefined" && Tools.drag) return;   // don't stream mid-drag
  const s = mpCoreString();
  if (s !== MP._lastCore){
    MP._lastCore = s;
    mpBroadcast({ t: "state", from: MP.id, core: s });
  }
  if (MP.opts.sendImages) mpSyncImages();
}
/* markDirty is wrapped below to call this — an edit triggers a near-immediate sync */
function mpNudge(){
  if (!mpConnected() || MP.applying || MP._nudgeT) return;
  MP._nudgeT = setTimeout(() => { MP._nudgeT = null; mpTickFn(); }, 200);
}

/* ---------------- incoming state apply ---------------- */

function mpTryApply(){
  if (MP.pendingCore == null) return;
  if (typeof Tools !== "undefined" && Tools.drag) return;   // retried from the tick loop
  const core = MP.pendingCore;
  MP.pendingCore = null;
  MP.applying = true;
  try {
    // one undo point per burst of remote edits (not one per keystroke of the peer)
    if (Date.now() - MP._lastRemoteUndo > 5000){
      pushUndo("multiplayer sync");
      MP._lastRemoteUndo = Date.now();
    }
    mpApplyCore(core);
    MP._lastCore = core;
  } catch(e){
    console.error("multiplayer apply failed", e);
  } finally {
    MP.applying = false;
  }
}

function mpApplyCore(coreStr){
  const s = JSON.parse(coreStr);
  State.pxPerMm = s.pxPerMm || 10;
  State.layerCount = s.layerCount || 2;
  State.viaR = s.viaR || 8;
  State.viaHole = s.viaHole || 3.6;
  State.traceW = s.traceW || 5;
  State.compView = s.compView || "side";
  State.traceView = s.traceView || "active";
  State.overlapCheck = s.overlapCheck !== false;
  State.refTextSize = s.refTextSize || 13;
  State.copperOz = s.copperOz || 1;
  State.copperOzInner = s.copperOzInner || 0.5;
  State.focusDim = (s.focusDim != null) ? s.focusDim : 0.16;
  State._id = Math.max(State._id || 1, s._id || 1);
  State.refCounters = s.refCounters || {};
  State.nets = s.nets || [];
  State.bomColumns = s.bomColumns || [];
  State.components = s.components || [];
  State.components.forEach(c => { c._fp = null; });
  State.vias = s.vias || [];
  State.traces = s.traces || [];
  State.notes = s.notes || [];
  State.schWires = s.schWires || [];
  State.schLabels = s.schLabels || [];

  // layers: match by id — adopt remote meta/transform, keep our local bitmap
  const old = new Map(State.layers.map(l => [l.id, l]));
  State.layers = (s.layers || []).map(m => {
    const ex = old.get(m.id);
    if (ex){
      const img = ex.img, dataURL = ex.dataURL, tiles = ex.tiles;
      Object.assign(ex, m);
      ex.img = img; ex.dataURL = dataURL; ex.tiles = tiles;
      return ex;
    }
    const l = { ...m, img: null, dataURL: "" };
    if (m.url){
      const attempt = (useCors) => {
        const img = new Image();
        if (useCors) img.crossOrigin = "anonymous";
        img.onload = () => { l.img = img; requestRender(); };
        img.onerror = () => { if (useCors) attempt(false); };
        img.src = m.url;
      };
      attempt(true);
    } else if (MP._pendingImgs.has(m.id)){
      const data = MP._pendingImgs.get(m.id);
      MP._pendingImgs.delete(m.id);
      setTimeout(() => mpApplyImage(m.id, data), 0);
    }
    return l;
  });

  mpRemapSelection();
  if (typeof Tools !== "undefined"){ Tools.padEdit = null; }
  if (typeof View !== "undefined"){ View.hoverPin = null; View.hoverObj = null; }
  if (typeof UI !== "undefined"){
    UI.resolveActiveLayer(UI.activeLayerId);
    UI.rebuildSideSelect();
    UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
  }
  if (typeof markDirty === "function") markDirty();   // autosave the synced board
  requestRender();
}

/* local selections point into the replaced arrays — re-find everything by id,
   dropping whatever the remote edit deleted */
function mpRemapSelection(){
  const sel = UI.sel;
  if (sel){
    if (sel.type === "comp" || sel.type === "pin"){
      const c = getComp(sel.comp && sel.comp.id);
      if (!c || (sel.type === "pin" && !(c.pins && c.pins[sel.pinIdx]))) UI.sel = null;
      else sel.comp = c;
    } else if (sel.type === "via"){
      const v = getVia(sel.via && sel.via.id);
      if (v) sel.via = v; else UI.sel = null;
    } else if (sel.type === "trace"){
      const t = getTrace(sel.trace && sel.trace.id);
      if (t) sel.trace = t; else UI.sel = null;
    }
  }
  UI.pinSel = UI.pinSel
    .map(p => { const c = getComp(p.comp && p.comp.id); return c && c.pins[p.pinIdx] ? { comp: c, pinIdx: p.pinIdx } : null; })
    .filter(Boolean);
  UI.traceSel = UI.traceSel.map(t => getTrace(t.id)).filter(Boolean);
  UI.boxSel = UI.boxSel.map(sl => {
    if (sl.comp){ const c = getComp(sl.comp.id); return c ? { ...sl, comp: c } : null; }
    if (sl.via){ const v = getVia(sl.via.id); return v ? { ...sl, via: v } : null; }
    if (sl.trace){ const t = getTrace(sl.trace.id); return t ? { ...sl, trace: t } : null; }
    return sl.note ? (State.notes.includes(sl.note) ? sl : null) : sl;
  }).filter(Boolean);
}

/* ---------------- image layer sharing (optional) ---------------- */

function mpSyncImages(){
  for (const l of State.layers){
    if (l.url || !l.dataURL) continue;   // hosted layers travel as links in the core
    const sig = l.dataURL.length + "@" + MP.opts.maxPxPerMm;
    if (MP._imgSig.get(l.id) === sig) continue;
    MP._imgSig.set(l.id, sig);
    mpShrinkImage(l).then(data => {
      if (data) mpBroadcast({ t: "img", from: MP.id, layerId: l.id, data });
    }).catch(() => MP._imgSig.delete(l.id));
  }
}

/* downscale a layer bitmap so its detail is at most opts.maxPxPerMm.
   A layer drawn at l.scale has pxPerMm/l.scale image pixels per board mm. */
async function mpShrinkImage(l){
  if (!l.img || !l.img.width) return null;
  const worldScale = l.scale || 1;
  const f = MP.opts.maxPxPerMm * worldScale / (State.pxPerMm || 10);
  if (f >= 1) return l.dataURL;   // already at or below the cap — send as-is
  const w = Math.max(1, Math.round(l.img.width * f));
  const h = Math.max(1, Math.round(l.img.height * f));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(l.img, 0, 0, w, h);
  return cv.toDataURL("image/jpeg", 0.82);
}

function mpApplyImage(layerId, data){
  const l = getLayer(layerId);
  if (!l){ MP._pendingImgs.set(layerId, data); return; }
  if (l.url) return;   // hosted layer loads from its link — ignore stale bytes
  l.dataURL = data;
  // remember what we now hold, so our own image-sync doesn't bounce it back
  MP._imgSig.set(layerId, data.length + "@" + MP.opts.maxPxPerMm);
  const img = new Image();
  img.onload = () => {
    l.img = img;
    l.tiles = (typeof ImageTiles !== "undefined" && ImageTiles.shouldTile(img)) ? ImageTiles.build(img) : null;
    if (typeof markImagesDirty === "function") markImagesDirty();
    UI.refreshLayerList();
    requestRender();
  };
  img.src = data;
}

/* ---------------- live cursors ---------------- */

function mpCursorMsg(m){
  let c = MP.cursors.get(m.from);
  if (!c){ c = { el: null }; MP.cursors.set(m.from, c); }
  c.x = m.x; c.y = m.y; c.name = m.name; c.color = m.color;
  c.leave = !!m.leave; c.ts = Date.now();
  mpLayoutCursors();
}

function mpCursorContainer(){
  let el = document.getElementById("mp-cursors");
  if (!el){
    el = document.createElement("div");
    el.id = "mp-cursors";
    const wrap = document.getElementById("canvas-wrap");
    if (!wrap) return null;
    wrap.appendChild(el);
  }
  return el;
}

function mpLayoutCursors(){
  if (MP._layoutQ) return;
  MP._layoutQ = true;
  // rAF for smoothness, with a timer fallback (rAF stalls in hidden/throttled tabs)
  const run = () => {
    if (!MP._layoutQ) return;
    MP._layoutQ = false;
    mpLayoutCursorsNow();
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}
function mpLayoutCursorsNow(){
    const cont = mpCursorContainer();
    if (!cont) return;
    const now = Date.now();
    for (const [id, c] of MP.cursors){
      const stale = c.leave || (now - c.ts > 8000);
      if (!c.el){
        if (stale) continue;
        c.el = document.createElement("div");
        c.el.className = "mp-cursor";
        c.el.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1 L16 8.5 L9.2 10.2 L6 17 Z" fill="currentColor" stroke="#000" stroke-width="1"/></svg><span class="mp-name"></span>';
        cont.appendChild(c.el);
      }
      c.el.style.display = stale ? "none" : "";
      if (stale) continue;
      const p = worldToScreen(c.x, c.y);
      c.el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(p.y)}px)`;
      c.el.style.color = c.color || "#4dd2ff";
      const nameEl = c.el.querySelector(".mp-name");
      if (nameEl.textContent !== (c.name || "")) nameEl.textContent = c.name || "";
      nameEl.style.background = c.color || "#4dd2ff";
    }
}

function mpWireCursorSend(){
  const canvas = document.getElementById("canvas");
  if (!canvas) return;
  let last = 0;
  canvas.addEventListener("pointermove", () => {
    if (!mpConnected()) return;
    const now = performance.now();
    if (now - last < 45) return;
    last = now;
    const w = (typeof Tools !== "undefined" && Tools.cursor) ? Tools.cursor : null;
    if (!w) return;
    mpBroadcast({ t: "cur", from: MP.id, x: w.x, y: w.y, name: MP.name, color: MP.color });
  });
  canvas.addEventListener("pointerleave", () => {
    if (mpConnected()) mpBroadcast({ t: "cur", from: MP.id, leave: true, name: MP.name, color: MP.color });
  });
}

/* ---------------- dialog / UI ---------------- */

function mpRefreshUI(){
  const btn = document.getElementById("btn-mp");
  const n = MP.peers.filter(p => p.open).length;
  if (btn){
    btn.classList.toggle("mp-live", n > 0);
    btn.innerHTML = n > 0 ? ("&#128101; " + n) : "&#128101; Live";
  }
  const list = document.getElementById("mp-peers");
  if (list){
    list.innerHTML = "";
    if (!MP.peers.length) list.innerHTML = '<div class="panel-hint">No peers connected.</div>';
    for (const p of MP.peers){
      const row = document.createElement("div");
      row.className = "mp-peer";
      row.innerHTML = `<span class="mp-dot" style="background:${p.open ? p.color : "#555"}"></span>
        <span>${p.open ? mpEsc(p.name) : "connecting…"}</span>
        <span class="mp-peer-state">${p.pc.connectionState}</span>`;
      const kick = document.createElement("button");
      kick.textContent = "✕";
      kick.title = "Disconnect this peer";
      kick.onclick = () => mpDropPeer(p);
      row.appendChild(kick);
      list.appendChild(row);
    }
  }
  const leave = document.getElementById("mp-leave");
  if (leave) leave.style.display = MP.peers.length ? "" : "none";
}
function mpEsc(s){ return String(s ?? "").replace(/[<>&"]/g, ch => ({ "<":"&lt;", ">":"&gt;", "&":"&amp;", '"':"&quot;" }[ch])); }

function mpStatus(msg, isErr){
  const el = document.getElementById("mp-status");
  if (el){ el.textContent = msg || ""; el.style.color = isErr ? "#ff7d7d" : "#9ab"; }
}

async function mpCopy(text, btn){
  try { await navigator.clipboard.writeText(text); if (btn){ const t = btn.textContent; btn.textContent = "Copied!"; setTimeout(() => btn.textContent = t, 1200); } }
  catch(e){ mpStatus("Clipboard blocked — select and copy the code manually", true); }
}

function mpWireDialog(){
  const dlg = document.getElementById("mp-dialog");
  const btn = document.getElementById("btn-mp");
  if (!dlg || !btn) return;
  const $id = (s) => document.getElementById(s);

  btn.addEventListener("click", () => {
    $id("mp-name").value = MP.name;
    $id("mp-color").value = MP.color;
    $id("mp-imgshare").checked = MP.opts.sendImages;
    $id("mp-imgres").value = MP.opts.maxPxPerMm;
    mpRefreshUI(); mpStatus("");
    dlg.showModal();
  });
  $id("mp-close").addEventListener("click", () => dlg.close());
  $id("mp-name").addEventListener("change", e => { MP.name = e.target.value.trim() || MP.name; mpSavePrefs(); });
  $id("mp-color").addEventListener("change", e => { MP.color = e.target.value; mpSavePrefs(); });
  $id("mp-imgshare").addEventListener("change", e => {
    MP.opts.sendImages = e.target.checked; mpSavePrefs();
    MP._imgSig.clear();                      // (re)send everything under the new setting
    if (MP.opts.sendImages && mpConnected()) mpSyncImages();
  });
  $id("mp-imgres").addEventListener("change", e => {
    MP.opts.maxPxPerMm = Math.max(0.5, parseFloat(e.target.value) || 10);
    e.target.value = MP.opts.maxPxPerMm;
    mpSavePrefs(); MP._imgSig.clear();
    if (MP.opts.sendImages && mpConnected()) mpSyncImages();
  });

  $id("mp-make-invite").addEventListener("click", async () => {
    try {
      mpStatus("Gathering connection candidates…");
      $id("mp-offer-out").value = await mpCreateInvite();
      mpStatus("Invite ready — send it to your guest, then paste their reply below.");
      mpRefreshUI();
    } catch(e){ mpStatus(e.message, true); }
  });
  $id("mp-copy-offer").addEventListener("click", (e) => mpCopy($id("mp-offer-out").value, e.target));
  $id("mp-accept-reply").addEventListener("click", async () => {
    try { await mpAcceptReply($id("mp-reply-in").value); $id("mp-reply-in").value = ""; mpStatus("Connecting…"); }
    catch(e){ mpStatus(e.message, true); }
  });

  $id("mp-make-reply").addEventListener("click", async () => {
    try {
      mpStatus("Building reply…");
      $id("mp-reply-out").value = await mpJoin($id("mp-invite-in").value);
      mpStatus("Reply ready — send it back to the host. The session starts when they paste it.");
    } catch(e){ mpStatus(e.message, true); }
  });
  $id("mp-copy-reply").addEventListener("click", (e) => mpCopy($id("mp-reply-out").value, e.target));

  $id("mp-leave").addEventListener("click", () => { mpLeave(); mpStatus("Left the session."); });
}

/* ---------------- boot ---------------- */

function mpInjectStyle(){
  const st = document.createElement("style");
  st.textContent = `
#mp-cursors{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:6}
.mp-cursor{position:absolute;left:0;top:0;will-change:transform}
.mp-cursor .mp-name{position:absolute;left:12px;top:14px;color:#111;font:11px/1.5 sans-serif;
  padding:0 5px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.5)}
#btn-mp.mp-live{background:#1d4030;border-color:#2f7d52;color:#8fe6b0}
.mp-peer{display:flex;align-items:center;gap:7px;padding:3px 2px;font-size:12px}
.mp-peer .mp-dot{width:9px;height:9px;border-radius:50%;flex:none}
.mp-peer .mp-peer-state{color:#78838f;font-size:11px;margin-left:auto}
.mp-peer button{padding:0 6px}
#mp-dialog textarea{width:100%;box-sizing:border-box;height:52px;resize:vertical;
  background:#1c222b;border:1px solid #2e3742;border-radius:5px;color:#d7dde5;font-size:10px}
#mp-dialog fieldset{border:1px solid #2e3742;border-radius:6px;margin:8px 0;min-width:0}
#mp-dialog legend{font-size:12px;color:#9ab;padding:0 5px}`;
  document.head.appendChild(st);
}

window.addEventListener("load", () => {
  mpLoadPrefs();
  mpInjectStyle();
  mpWireDialog();
  mpWireCursorSend();
  mpRefreshUI();
  // edits announce themselves through markDirty — piggyback a quick sync check
  const origDirty = window.markDirty;
  window.markDirty = function(...a){ origDirty.apply(this, a); mpNudge(); };
  // any re-render (pan/zoom included) repositions the remote cursors
  const origRR = window.requestRender;
  window.requestRender = function(...a){ origRR.apply(this, a); if (MP.cursors.size) mpLayoutCursors(); };
  window.addEventListener("beforeunload", () => { if (mpConnected()) mpBroadcast({ t: "bye", from: MP.id }); });
});
