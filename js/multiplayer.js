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
  tabs: new Map(),     // from-id -> {tab,name,color} — which editor tab each peer is on
  edits: new Map(),    // "c12"/"v5"/"t7"/"n3" -> {color,name,ts,el} — recent remote edits (dots)
  remoteSel: new Map(),// from-id -> {keys,color,name,els} — what each peer has selected (rings)
  hiddenCursors: new Set(),   // from-ids whose live cursor the local user chose to hide
  // what guests may do — configured by the HOST (dialog), broadcast to every guest
  rights: { openProjects:false, layerTools:false, editObjects:true, editNets:true,
            editSchBom:true, saveExport:true, ai:true, clearAll:false },
  isHost: false,
  applying: false,     // true while a remote state is being written into State
  pendingCore: null,   // newest remote core deferred during a local drag
  opts: { sendImages: false, maxPxPerMm: 0 },   // 0 = auto: half the image's own px/mm (floor 5)
  _lastCore: null,     // last core string sent OR applied (echo suppression)
  _imgSig: new Map(),  // layerId -> signature of the bitmap we last sent
  _pendingImgs: new Map(), // layerId -> dataURL that arrived before its layer
  _rx: new Map(),      // chunk reassembly buffers
  _pendingInvite: null,
  _lastRemoteUndo: 0,
  _tick: null,
  _seq: 0,
  _dragT: 0,           // last live-drag broadcast (throttle)
  _remoteDragHold: 0,  // while a peer is live-dragging, don't broadcast our (stale) core
  _bigChange: false,   // set when a project open/import/new replaced the board — the next
                       // state broadcast flags it so the host can accept or decline
  _sentSel: "",        // last selection-presence payload sent (dedup)
};

const MP_RIGHTS = ["openProjects", "layerTools", "editObjects", "editNets", "editSchBom", "saveExport", "ai", "clearAll"];
const MP_NAME_MAX = 32, MP_CHAT_MAX = 255;

/* every string a peer sends is untrusted: clamp lengths, whitelist colours. Rendering
   uses textContent / .title (never innerHTML), so no markup can execute either way. */
function mpCleanName(s){ return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MP_NAME_MAX); }
function mpCleanColor(c){ return /^#[0-9a-fA-F]{3,8}$/.test(String(c || "")) ? String(c) : "#4dd2ff"; }
function mpCleanText(s){ return String(s == null ? "" : s).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, MP_CHAT_MAX); }

/* a guest lacking the given right is blocked (the host is never blocked) */
function mpRightBlocked(right){ return mpConnected() && !MP.isHost && !MP.rights[right]; }
/* toast + true when the guest may not do this */
function mpDenied(right, label){
  if (MP.applying || !mpRightBlocked(right)) return false;
  if (typeof UI !== "undefined") UI.toast("Multiplayer: the host hasn't allowed you to " + label);
  return true;
}
/* image/layer tools — kept as own names because tools.js / ui/layers.js call them */
function mpGuestLocked(){ return mpRightBlocked("layerTools"); }
function mpBlockImageOp(){ return mpDenied("layerTools", "use the layer/image tools"); }
/* autosave.js asks this before writing: a guest without save rights doesn't autosave */
function mpAutosaveBlocked(){ return mpRightBlocked("saveExport"); }

/* ---------------- small helpers ---------------- */

function mpLoadPrefs(){
  try {
    MP.name  = localStorage.getItem("pcbreveng.mpName")  || "";
    MP.color = localStorage.getItem("pcbreveng.mpColor") || "";
    const o = JSON.parse(localStorage.getItem("pcbreveng.mpOpts") || "null");
    if (o){
      MP.opts.sendImages = !!o.sendImages;
      // 10 was the old fixed default (nobody chose it) → migrate to the new auto;
      // explicit values clamp to the 5 px/mm minimum, anything unset/invalid = auto
      const v = +o.maxPxPerMm || 0;
      MP.opts.maxPxPerMm = (!v || v === 10) ? 0 : Math.max(5, v);
    }
    const r = JSON.parse(localStorage.getItem("pcbreveng.mpRights") || "null");
    if (r) for (const k of MP_RIGHTS) if (k in r) MP.rights[k] = !!r[k];
  } catch(e){}
  MP.name = mpCleanName(MP.name);
  if (!MP.name)  MP.name  = "Player-" + MP.id.slice(0, 4);
  if (!MP.color) MP.color = ["#ff5d5d","#ffb84d","#ffe14d","#6fe06f","#4dd2ff","#b48cff","#ff7ad9"][Math.floor(Math.random()*7)];
}
function mpSavePrefs(){
  try {
    localStorage.setItem("pcbreveng.mpName", MP.name);
    localStorage.setItem("pcbreveng.mpColor", MP.color);
    localStorage.setItem("pcbreveng.mpOpts", JSON.stringify(MP.opts));
    localStorage.setItem("pcbreveng.mpRights", JSON.stringify(MP.rights));
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
    mpClearCodeFields();   // handshake done — the big signaling codes are spent
    mpSendObj(peer, { t: "hi", from: MP.id, name: MP.name, color: MP.color, host: MP.isHost });
    if (MP.isHost){
      // host is authoritative: push the full board + the guest permissions to the newcomer
      const core = mpCoreString();
      MP._lastCore = core;
      mpSendObj(peer, { t: "state", from: MP.id, core });
      mpSendObj(peer, { t: "rights", from: MP.id, rights: MP.rights });
    } else if (MP._lastCore == null){
      // guest: adopt the host's board — don't blast our own on join
      MP._lastCore = mpCoreString();
    }
    // ask every sharing peer to (re)offer its image layers to me
    mpSendObj(peer, { t: "imgreq", from: MP.id });
    // tell the newcomer which editor tab I'm on (dots on the tab bar)
    mpSendObj(peer, mpTabMsgOut());
    mpStartLoop();
    mpRefreshUI();
    mpStatus("Connected — session live.");
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
    MP.tabs.delete(peer.remoteId);
    MP.hiddenCursors.delete(peer.remoteId);
    mpClearRemoteSel(peer.remoteId);
    mpRenderTabDots();
  }
  if (!MP.peers.length) mpStopLoop();
  mpRefreshUI();
  if (typeof UI !== "undefined") UI.toast("Multiplayer: peer left");
}

/* wipe the invite/reply code boxes — the codes are single-use, so once a session is
   live (or left) they're just confusing multi-KB leftovers */
function mpClearCodeFields(){
  for (const id of ["mp-offer-out", "mp-reply-in", "mp-invite-in", "mp-reply-out"]){
    const el = document.getElementById(id);
    if (el) el.value = "";
  }
}

function mpLeave(){
  mpBroadcast({ t: "bye", from: MP.id });
  for (const p of [...MP.peers]) mpDropPeer(p);
  MP.isHost = false;
  MP._pendingInvite = null;
  MP._lastCore = null;
  MP._imgSig.clear();
  mpClearCodeFields();
  for (const c of MP.cursors.values()) if (c.el) c.el.remove();
  MP.cursors.clear();
  for (const e of MP.edits.values()) if (e.el) e.el.remove();
  MP.edits.clear();
  for (const from of [...MP.remoteSel.keys()]) mpClearRemoteSel(from);
  MP.hiddenCursors.clear();
  MP._remoteDragHold = 0;
  MP._bigChange = false;
  MP._sentSel = "";
  MP.tabs.clear();
  MP._sentTab = null;   // a future session re-announces the tab
  mpRenderTabDots();
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
    // long transfers (big image layers) tick a progress line so they don't look stalled
    if (b.total > 20 && (b.got % 20 === 0 || b.got === b.total))
      mpStatus(`Receiving data… ${Math.round(100 * b.got / b.total)}%`);
    if (b.got === b.total){ MP._rx.delete(m.id); mpOnMsg(peer, b.parts.join("")); }
    return;
  }
  if (m.from && !peer.remoteId && m.t === "hi") peer.remoteId = m.from;

  // every peer-supplied display string is clamped/sanitised before it goes anywhere
  if ("name" in m) m.name = mpCleanName(m.name);
  if ("color" in m) m.color = mpCleanColor(m.color);

  switch (m.t){
    case "hi":
      peer.name = m.name || peer.name; peer.color = m.color || peer.color;
      peer.isHost = !!m.host;
      mpRefreshUI();
      break;
    case "cur":
      mpCursorMsg(m);
      if (MP.isHost) mpBroadcast(m, peer);
      break;
    case "tab":
      mpTabMsg(m);
      if (MP.isHost) mpBroadcast(m, peer);
      break;
    case "sel":
      mpSelMsg(m);
      if (MP.isHost) mpBroadcast(m, peer);
      break;
    case "chat":
      m.text = mpCleanText(m.text);
      if (!m.text) break;
      if (MP.isHost) mpBroadcast(m, peer);
      mpChatLine(m.name || peer.name, m.color || peer.color, m.text);
      break;
    case "rights":
      // only the host distributes permissions — a guest can't grant itself anything
      if (MP.isHost || !peer.isHost) break;
      for (const k of MP_RIGHTS) MP.rights[k] = !!(m.rights && m.rights[k]);
      mpApplyGuestLock(true);
      if (typeof UI !== "undefined") UI.toast("Multiplayer: the host updated your permissions");
      break;
    case "deny":
      if (typeof UI !== "undefined") UI.toast("Multiplayer: the host blocked that — you're not allowed to " + mpCleanText(m.what || "do that"));
      break;
    case "state":
      // the HOST gatekeeps what guests may change before it becomes session state
      if (MP.isHost){
        const who = m.name || peer.name || "A peer";
        if (m.big && !MP.rights.openProjects){
          mpSendObj(peer, { t: "deny", from: MP.id, what: "open or import projects" });
          MP._lastCore = null;   // force our authoritative core back out on the next tick
          break;
        }
        if (m.big && !confirm(who + " loaded a DIFFERENT project/board into the session.\n\n" +
                              "OK = accept it (replaces the current board for everyone)\n" +
                              "Cancel = keep the current board and push it back")){
          MP._lastCore = null;
          break;
        }
        const bad = mpHostViolation(MP._lastCore, m.core);
        if (bad){
          mpSendObj(peer, { t: "deny", from: MP.id, what: bad });
          MP._lastCore = null;
          if (typeof UI !== "undefined") UI.toast("Multiplayer: blocked " + who + "'s edit (" + bad + " is not allowed)");
          break;
        }
        mpBroadcast(m, peer);
      }
      MP.pendingCore = { core: m.core, from: m.from };
      mpTryApply();
      break;
    case "drag":
      // live drags are object edits — a guest without that right doesn't get to move things
      if (MP.isHost && !MP.rights.editObjects && !peer.isHost) break;
      if (MP.isHost) mpBroadcast(m, peer);
      mpApplyDrag(m);
      break;
    case "img":
      if (MP.isHost){
        // guests may only send images at all when layer tools are granted — anything
        // else is silently dropped (no prompt spam, nothing applied or relayed)
        if (!MP.rights.layerTools) break;
        // allowed senders still need a one-time accept, once per peer for the session
        if (peer._imgOk === undefined)
          peer._imgOk = confirm((peer.name || "A peer") + " wants to send image layers to you.\n\n" +
                                "Accept images from them for this session?");
        if (!peer._imgOk) break;   // declined: neither applied nor relayed
        mpBroadcast(m, peer);
      }
      mpApplyImage(m.layerId, m.data, m.w, m.h);
      break;
    case "imgreq":
      // a peer wants image layers. The HOST re-offers everything; a guest only
      // re-offers layers it added/replaced itself (so late joiners still get those).
      if (MP.isHost) mpBroadcast(m, peer);
      if (MP.opts.sendImages){
        if (MP.isHost) MP._imgSig.clear();
        else for (const l of State.layers) if (l._mpOwn) MP._imgSig.delete(l.id);
        mpSyncImages();
      }
      break;
    case "bye":
      mpDropPeer(peer);
      break;
  }
}

/* host-side rights check: diff the guest's incoming core against our current one and
   return the first category the guest isn't allowed to touch (or null when clean).
   Guest-side toasts are the polite fence; this is the actual wall. */
function mpHostViolation(prevStr, nextStr){
  const R = MP.rights;
  if (!prevStr) return null;   // no baseline yet (fresh session) — nothing to compare
  if (R.editObjects && R.editNets && R.editSchBom && R.layerTools) return null;
  try {
    const a = JSON.parse(prevStr), b = JSON.parse(nextStr);
    const diff = (x, y) => JSON.stringify(x ?? null) !== JSON.stringify(y ?? null);
    if (!R.editObjects && (diff(a.components, b.components) || diff(a.vias, b.vias) ||
                           diff(a.traces, b.traces) || diff(a.notes, b.notes)))
      return "edit objects";
    if (!R.editNets && diff(a.nets, b.nets)) return "edit nets";
    if (!R.editSchBom && (diff(a.schWires, b.schWires) || diff(a.schLabels, b.schLabels) ||
                          diff(a.bomColumns, b.bomColumns)))
      return "edit the schematic/BOM";
    if (!R.layerTools && (diff(a.layers, b.layers) || a.pxPerMm !== b.pxPerMm))
      return "use the layer tools";
  } catch(e){}
  return null;
}

/* ---------------- outgoing state sync ---------------- */

/* the shareable project core: everything serializeProject saves, minus the
   embedded image bytes (those travel separately, and only when opted in).
   Built the same way on every peer, so equal boards give equal strings. */
function mpCoreString(){
  const s = JSON.parse(serializeProject());
  // dataURL: image bytes travel separately (opt-in). visible/opacity: per-user VIEW
  // state — syncing them made one user's 1/2/3 layer switching flip everyone's view.
  // imgW/imgH describe the LOCAL bitmap (downscaled stand-in marker) — syncing them let a
  // guest's stand-in flag land on the host's ORIGINAL layer, which then accepted the
  // guest's recompressed copy and autosave baked the quality loss into the project.
  s.layers = (s.layers || []).map(l => { const { dataURL, visible, opacity, imgW, imgH, ...rest } = l; return rest; });
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
  mpSendSel();    // selection presence (cheap, dedup'd)
  if (typeof Tools !== "undefined" && Tools.drag) return;   // the full core goes when the drag ends
  // a peer is live-dragging INTO our state right now — broadcasting our core would echo
  // their mid-drag positions back as authoritative state and fight the drag
  if (Date.now() < MP._remoteDragHold) return;
  const s = mpCoreString();
  if (s !== MP._lastCore){
    MP._lastCore = s;
    mpBroadcast({ t: "state", from: MP.id, core: s, big: MP._bigChange || undefined, name: MP.name });
    MP._bigChange = false;
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
  const { core, from } = MP.pendingCore;
  MP.pendingCore = null;
  MP.applying = true;
  try {
    // one undo point per burst of remote edits (not one per keystroke of the peer)
    if (Date.now() - MP._lastRemoteUndo > 5000){
      pushUndo("multiplayer sync");
      MP._lastRemoteUndo = Date.now();
    }
    mpDiffEdits(MP._lastCore, core, from);   // dot the objects this peer just changed
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
    // visible/opacity aren't in the core (per-user view state) — give the fresh
    // layer sane view defaults instead of undefined (= invisible, NaN alpha)
    const l = { visible: false, opacity: 1, ...m, img: null, dataURL: "" };
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
      const p = MP._pendingImgs.get(m.id);
      MP._pendingImgs.delete(m.id);
      setTimeout(() => mpApplyImage(m.id, p.data, p.w, p.h), 0);
    }
    return l;
  });

  mpRemapSelection();
  if (typeof Tools !== "undefined"){ Tools.padEdit = null; }
  if (typeof View !== "undefined"){ View.hoverPin = null; View.hoverObj = null; }
  if (typeof UI !== "undefined"){
    UI.resolveActiveLayer(UI.activeLayerId);
    UI.ensureVisibleLayer();   // fresh join / remote project open: auto-view layer 1
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
    } else if (sel.type === "note"){
      // notes are replaced wholesale by the core apply — without re-finding by id the
      // inspector kept editing the ORPHANED old object and the text silently vanished
      const n = State.notes.find(n => n.id === (sel.note && sel.note.id));
      if (n) sel.note = n; else UI.sel = null;
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

/* cheap change signature for a layer bitmap — length alone collides when an
   image is replaced by another of identical size, so sample the tail too */
function mpImgSig(dataURL){
  return dataURL.length + ":" + dataURL.slice(-32) + "@" + MP.opts.maxPxPerMm;
}

function mpSyncImages(){
  // GUESTS only ever send images for layers they themselves added/replaced during the
  // session (marked _mpOwn) — and only when the host granted layer tools. The host owns
  // the board's photos; guests never re-offer them back (no connect-time burst either).
  const guest = mpConnected() && !MP.isHost;
  if (guest && !MP.rights.layerTools) return;
  for (const l of State.layers){
    if (guest && !l._mpOwn) continue;
    if (l.url || !l.dataURL) continue;   // hosted layers travel as links in the core
    const sig = mpImgSig(l.dataURL);
    if (MP._imgSig.get(l.id) === sig) continue;
    MP._imgSig.set(l.id, sig);
    mpShrinkImage(l).then(r => {
      if (r){
        // w/h = the LOGICAL pixel size the bytes stand in for — the receiver stretches
        // the (possibly downscaled) bitmap back so scale/warp math keeps working
        mpBroadcast({ t: "img", from: MP.id, layerId: l.id, data: r.data, w: r.w, h: r.h });
        const mb = (r.data.length / 1048576).toFixed(1);
        if (typeof UI !== "undefined") UI.toast(`Multiplayer: sending image “${l.name}” (${mb} MB)`);
      }
      // bitmap not decoded yet (fresh project load) — roll back so the next tick retries
      else MP._imgSig.delete(l.id);
    }).catch(() => MP._imgSig.delete(l.id));
  }
}

/* downscale a layer bitmap so its detail is at most opts.maxPxPerMm.
   A layer drawn at l.scale has pxPerMm/l.scale image pixels per board mm.
   Even when the image is already below the cap, big or non-JPEG bytes are
   re-encoded: on an uncalibrated board (pxPerMm 10, scale 1) f is 1 and the
   old "send as-is" path shipped the raw multi-MB camera file — minutes of
   silent transfer that looked like the share simply not working. */
async function mpShrinkImage(l){
  if (!l.img || !l.img.width) return null;
  // l.img always holds the LOGICAL pixel size (downscaled stand-ins are stretched
  // back on load/receive), which is what the layer's scale/warp math assumes
  const lw = l.img.width, lh = l.img.height;
  const worldScale = l.scale || 1;
  // the image's actual resolution in image-px per board-mm; the cap is the user's
  // explicit value, or (auto) HALF the actual resolution — never below 20 px/mm.
  // Images already under 20 px/mm ship at their own resolution (f caps at 1).
  const actual = (State.pxPerMm || 10) / worldScale;
  const cap = MP.opts.maxPxPerMm > 0 ? MP.opts.maxPxPerMm : Math.max(20, actual / 2);
  const f = Math.min(1, cap / actual);
  if (f >= 1 && l.dataURL.length < 600000 && /^data:image\/jpe?g/i.test(l.dataURL))
    return { data: l.dataURL, w: lw, h: lh };   // small JPEG already under the cap — send as-is
  const w = Math.max(1, Math.round(lw * f));
  const h = Math.max(1, Math.round(lh * f));
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(l.img, 0, 0, w, h);
  return { data: cv.toDataURL("image/jpeg", 0.82), w: lw, h: lh };
}

function mpApplyImage(layerId, data, w, h){
  if (!data) return;   // empty payload — an empty img.src would load the page URL
  const l = getLayer(layerId);
  if (!l){ MP._pendingImgs.set(layerId, { data, w, h }); return; }
  if (l.url) return;   // hosted layer loads from its link — ignore stale bytes
  // NEVER downgrade a locally held ORIGINAL with a peer's recompressed copy: shared
  // images are downscaled stand-ins (marked by imgW), and on session start / imgreq
  // both sides re-offer, so the host got its own image bounced back at share quality —
  // and autosave then baked the loss into the savegame. Originals stay authoritative;
  // only layers we never had bytes for (or already hold as a stand-in) accept updates.
  // NOTE: deliberately not requiring l.img — right after a project load the original's
  // bitmap is still decoding (l.img null), and requiring it opened a race window where
  // a peer's copy could overwrite the original dataURL before the decode finished.
  if (l.dataURL && !l.imgW) return;
  l.dataURL = data;
  // remember what we now hold, so our own image-sync doesn't bounce it back
  MP._imgSig.set(layerId, mpImgSig(data));
  const img = new Image();
  img.onload = () => {
    // stretch the downscaled stand-in back to its logical pixel size — the sender's
    // scale/tx/ty (synced via the core) assume the ORIGINAL dimensions, so applying
    // the small bitmap raw drew the image at completely the wrong size
    const bmp = (typeof fitBitmapTo === "function" && w && h) ? fitBitmapTo(img, w, h) : img;
    l.img = bmp;
    // persist the logical size too, so saving this board keeps the stand-in loadable
    if (w && h){ l.imgW = w; l.imgH = h; }
    l.tiles = (typeof ImageTiles !== "undefined" && ImageTiles.shouldTile(bmp)) ? ImageTiles.build(bmp) : null;
    if (typeof markImagesDirty === "function") markImagesDirty();
    UI.refreshLayerList();
    requestRender();
    if (typeof UI !== "undefined") UI.toast(`Multiplayer: received image “${l.name || layerId}”`);
  };
  img.onerror = () => {   // corrupt payload — don't keep bytes we can't decode
    l.dataURL = "";
    MP._imgSig.delete(layerId);
  };
  img.src = data;
}

/* ---------------- live drag streaming ---------------- */

/* the objects the current local drag is moving, as compact {k,id,…} records.
   Trace references for carried anchors are resolved once per drag and cached. */
function mpDragPayload(){
  const d = Tools.drag;
  if (!d || !d.moved) return null;
  const objs = [];
  const anchorTraces = () => {
    if (!d._mpTraces){
      const set = new Set();
      for (const a of (d.anchors || [])){
        const t = State.traces.find(t => t.points === a.pts);
        if (t) set.add(t);
      }
      if (d.linked) for (const L of d.linked){
        const t = State.traces.find(t => t.points === L.pts);
        if (t) set.add(t);
      }
      d._mpTraces = [...set];
    }
    return d._mpTraces;
  };
  const pushTrace = (t) => objs.push({ k: "t", id: t.id, pts: t.points.map(p => ({ x: p.x, y: p.y })) });
  switch (d.kind){
    case "move-comp":
      objs.push({ k: "c", id: d.comp.id, x: d.comp.x, y: d.comp.y });
      for (const t of anchorTraces()) pushTrace(t);
      break;
    case "move-via":
      objs.push({ k: "v", id: d.via.id, x: d.via.x, y: d.via.y });
      for (const t of anchorTraces()) pushTrace(t);
      break;
    case "move-vert":
    case "move-seg":
      pushTrace(d.trace);
      for (const t of anchorTraces()) pushTrace(t);
      break;
    case "move-note":
      objs.push({ k: "n", id: d.note.id, x: d.note.x, y: d.note.y });
      break;
    case "move-layer":
      objs.push({ k: "l", id: d.layer.id, tx: d.layer.tx, ty: d.layer.ty });
      break;
  }
  return objs.length ? objs : null;
}

/* stream the drag ~20×/s from the canvas pointermove hook */
function mpMaybeSendDrag(){
  if (!mpConnected() || MP.applying || typeof Tools === "undefined" || !Tools.drag) return;
  const now = performance.now();
  if (now - MP._dragT < 50) return;
  const objs = mpDragPayload();
  if (!objs) return;
  MP._dragT = now;
  mpBroadcast({ t: "drag", from: MP.id, objs, name: MP.name, color: MP.color });
}

/* apply a peer's live drag straight into State — no undo point, no full core rebuild;
   the authoritative core lands via the normal state sync once their drag ends */
function mpApplyDrag(m){
  if (MP.applying) return;
  if (typeof Tools !== "undefined" && Tools.drag) return;   // don't fight our own drag
  MP._remoteDragHold = Date.now() + 1200;
  const who = { color: m.color, name: m.name };
  for (const o of (m.objs || [])){
    if (o.k === "c"){
      const c = getComp(o.id);
      if (c){ c.x = o.x; c.y = o.y; mpMarkEdit("c" + o.id, who); }
    } else if (o.k === "v"){
      const v = getVia(o.id);
      if (v){ v.x = o.x; v.y = o.y; mpMarkEdit("v" + o.id, who); }
    } else if (o.k === "t"){
      const t = getTrace(o.id);
      if (t && o.pts && t.points.length === o.pts.length){
        for (let i = 0; i < o.pts.length; i++){ t.points[i].x = o.pts[i].x; t.points[i].y = o.pts[i].y; }
        mpMarkEdit("t" + o.id, who);
      }
    } else if (o.k === "n"){
      const n = State.notes.find(n => n.id === o.id);
      if (n){ n.x = o.x; n.y = o.y; mpMarkEdit("n" + o.id, who); }
    } else if (o.k === "l"){
      const l = getLayer(o.id);
      if (l){ l.tx = o.tx; l.ty = o.ty; }
    }
  }
  requestRender();
}

/* ---------------- "who edited what" markers ---------------- */

const MP_EDIT_TTL = 4000;   // ms an edit dot lingers

function mpMarkEdit(key, who){
  let e = MP.edits.get(key);
  if (!e){ e = { el: null }; MP.edits.set(key, e); }
  e.color = (who && who.color) || "#4dd2ff";
  e.name = (who && who.name) || "peer";
  e.ts = Date.now();
  mpLayoutCursors();
  // the layout loop only runs on renders — make sure expired dots get swept
  clearTimeout(MP._editSweep);
  MP._editSweep = setTimeout(mpLayoutCursors, MP_EDIT_TTL + 200);
}

/* colour/name for a peer id (used when only the from-id is known) */
function mpPeerInfo(from){
  const p = MP.peers.find(p => p.remoteId === from);
  if (p) return { color: p.color, name: p.name };
  const c = MP.cursors.get(from);
  return c ? { color: c.color, name: c.name } : null;
}

/* compare the previous synced core with the incoming one and dot everything the
   sender changed. Both strings come from the same serializer, so per-object JSON
   comparison is exact. A huge diff (project load / import) marks nothing. */
function mpDiffEdits(prevStr, nextStr, from){
  if (!prevStr || !from || from === MP.id) return;
  const who = mpPeerInfo(from);
  if (!who) return;
  try {
    const a = JSON.parse(prevStr), b = JSON.parse(nextStr);
    const changed = [];
    const scan = (tag, oldArr, newArr) => {
      const old = new Map((oldArr || []).map(o => [o.id, JSON.stringify(o)]));
      for (const o of (newArr || [])){
        const prev = old.get(o.id);
        if (prev === undefined || prev !== JSON.stringify(o)) changed.push(tag + o.id);
      }
    };
    scan("c", a.components, b.components);
    scan("v", a.vias, b.vias);
    scan("t", a.traces, b.traces);
    scan("n", a.notes, b.notes);
    if (changed.length && changed.length <= 30)   // more = bulk load, not an edit
      for (const key of changed) mpMarkEdit(key, who);
  } catch(e){}
}

/* world position of a marked object, or null when it's gone */
function mpEditPos(key){
  const id = +key.slice(1);
  switch (key[0]){
    case "c": { const c = getComp(id); return c ? { x: c.x, y: c.y } : null; }
    case "v": { const v = getVia(id); return v ? { x: v.x, y: v.y } : null; }
    case "t": { const t = getTrace(id);
                if (!t || !t.points.length) return null;
                const p = t.points[Math.floor(t.points.length / 2)];
                return { x: p.x, y: p.y }; }
    case "n": { const n = State.notes.find(n => n.id === id); return n ? { x: n.x, y: n.y } : null; }
  }
  return null;
}

/* ---------------- selection presence (steady rings while a peer edits) ----------------
   The edit dots above fade out — these don't: while a peer HAS an object selected
   (typing in the inspector, renaming, mid-edit), everyone sees a steady ring in the
   peer's colour on that object. Sent from the tick loop whenever the selection changes. */

function mpSelKeys(){
  const ks = [];
  if (typeof UI === "undefined") return ks;
  const sel = UI.sel;
  if (sel){
    if (sel.comp && sel.comp.id != null) ks.push("c" + sel.comp.id);
    else if (sel.via && sel.via.id != null) ks.push("v" + sel.via.id);
    else if (sel.trace && sel.trace.id != null) ks.push("t" + sel.trace.id);
    else if (sel.note && sel.note.id != null) ks.push("n" + sel.note.id);
  }
  for (const p of (UI.pinSel || [])) if (p.comp) ks.push("c" + p.comp.id);
  for (const t of (UI.traceSel || [])) ks.push("t" + t.id);
  return [...new Set(ks)].slice(0, 20);   // enough to show intent, bounded on the wire
}

function mpSendSel(){
  const keys = mpSelKeys();
  const sig = keys.join(",");
  if (sig === MP._sentSel) return;
  MP._sentSel = sig;
  mpBroadcast({ t: "sel", from: MP.id, keys, name: MP.name, color: MP.color });
}

function mpSelMsg(m){
  if (!m.from || m.from === MP.id) return;
  let s = MP.remoteSel.get(m.from);
  const keys = Array.isArray(m.keys) ? m.keys.slice(0, 20).map(String) : [];
  if (!keys.length){
    if (s){ if (s.els) for (const el of s.els.values()) el.remove(); MP.remoteSel.delete(m.from); }
    mpLayoutCursors();
    return;
  }
  if (!s){ s = { els: new Map() }; MP.remoteSel.set(m.from, s); }
  s.keys = keys; s.color = m.color; s.name = m.name;
  mpLayoutCursors();
}

function mpClearRemoteSel(from){
  const s = MP.remoteSel.get(from);
  if (!s) return;
  if (s.els) for (const el of s.els.values()) el.remove();
  MP.remoteSel.delete(from);
}

/* draw / expire the edit dots (called from the cursor layout pass) */
function mpLayoutEdits(){
  if (!MP.edits.size && !MP.remoteSel.size) return;
  const now = Date.now();
  const tab = (typeof EditorTabs !== "undefined") ? EditorTabs.current : "visual";
  const cont = mpCursorContainer(false);
  for (const [key, e] of MP.edits){
    const pos = now - e.ts > MP_EDIT_TTL ? null : mpEditPos(key);
    if (!pos || tab !== "visual"){
      if (e.el) e.el.remove();
      if (!pos || now - e.ts > MP_EDIT_TTL) MP.edits.delete(key);
      continue;
    }
    if (!cont) continue;
    if (!e.el){
      e.el = document.createElement("div");
      e.el.className = "mp-edit-dot";
      e.el.title = "edited by " + (e.name || "peer");
    }
    if (e.el.parentNode !== cont) cont.appendChild(e.el);
    const p = worldToScreen(pos.x, pos.y);
    e.el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(p.y)}px)`;
    e.el.style.background = e.color;
    e.el.style.color = e.color;   // glow (currentColor in the box-shadow)
    e.el.style.opacity = Math.max(0.15, 1 - (now - e.ts) / MP_EDIT_TTL);
  }
  // steady selection rings, one per (peer, object)
  for (const s of MP.remoteSel.values()){
    if (!s.els) s.els = new Map();
    const want = tab === "visual" ? new Set(s.keys || []) : new Set();
    for (const [k, el] of s.els) if (!want.has(k)){ el.remove(); s.els.delete(k); }
    if (!cont) continue;
    for (const k of want){
      const pos = mpEditPos(k);
      let el = s.els.get(k);
      if (!pos){ if (el){ el.remove(); s.els.delete(k); } continue; }
      if (!el){
        el = document.createElement("div");
        el.className = "mp-sel-ring";
        el.title = (s.name || "peer") + " is editing this";
        s.els.set(k, el);
      }
      if (el.parentNode !== cont) cont.appendChild(el);
      const p = worldToScreen(pos.x, pos.y);
      el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(p.y)}px)`;
      el.style.borderColor = s.color || "#4dd2ff";
      el.style.color = s.color || "#4dd2ff";
    }
  }
}

/* ---------------- live cursors ---------------- */

function mpCursorMsg(m){
  let c = MP.cursors.get(m.from);
  if (!c){ c = { el: null }; MP.cursors.set(m.from, c); }
  c.x = m.x; c.y = m.y; c.name = m.name; c.color = m.color;
  c.host = !!m.host;   // the session initiator gets a crown on the name tag
  c.sch = !!m.sch;   // coords are schematic mm (sender was in the schematic editor)
  c.leave = !!m.leave; c.ts = Date.now();
  mpLayoutCursors();
}

/* one overlay per editor: board cursors live in #canvas-wrap, schematic cursors in
   #sch-canvas-wrap — a peer's pointer shows on whichever sheet THEY are working on,
   visible to us only while we look at the same tab (the spaces don't map onto each other) */
function mpCursorContainer(sch){
  const id = sch ? "mp-cursors-sch" : "mp-cursors";
  let el = document.getElementById(id);
  if (!el){
    const wrap = document.getElementById(sch ? "sch-canvas-wrap" : "canvas-wrap");
    if (!wrap) return null;
    el = document.createElement("div");
    el.id = id;
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
    const tab = (typeof EditorTabs !== "undefined") ? EditorTabs.current : "visual";
    const now = Date.now();
    for (const [id, c] of MP.cursors){
      // hidden when gone-stale, hidden-by-choice, or we're not on the peer's sheet
      const wrongTab = c.sch ? tab !== "schematic" : tab !== "visual";
      const stale = c.leave || (now - c.ts > 8000) || wrongTab || MP.hiddenCursors.has(id);
      if (!c.el){
        if (stale) continue;
        c.el = document.createElement("div");
        c.el.className = "mp-cursor";
        c.el.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1 L16 8.5 L9.2 10.2 L6 17 Z" fill="currentColor" stroke="#000" stroke-width="1"/></svg><span class="mp-name"></span>';
      }
      const cont = mpCursorContainer(c.sch);
      if (!cont){ continue; }
      if (c.el.parentNode !== cont) cont.appendChild(c.el);
      c.el.style.display = stale ? "none" : "";
      if (stale) continue;
      const p = c.sch ? { x: schX2S(c.x), y: schY2S(c.y) } : worldToScreen(c.x, c.y);
      c.el.style.transform = `translate(${Math.round(p.x)}px,${Math.round(p.y)}px)`;
      c.el.style.color = c.color || "#4dd2ff";
      const nameEl = c.el.querySelector(".mp-name");
      const label = (c.host ? "\u{1F451} " : "") + (c.name || "");   // 👑 marks the host
      if (nameEl.textContent !== label) nameEl.textContent = label;
      nameEl.style.background = c.color || "#4dd2ff";
    }
    mpLayoutEdits();
}

function mpWireCursorSend(){
  const canvas = document.getElementById("canvas");
  let last = 0;
  const throttled = () => {
    if (!mpConnected()) return false;
    const now = performance.now();
    if (now - last < 45) return false;
    last = now;
    return true;
  };
  const sendLeave = () => {
    if (mpConnected()) mpBroadcast({ t: "cur", from: MP.id, leave: true, name: MP.name, color: MP.color });
  };
  if (canvas){
    canvas.addEventListener("pointermove", () => {
      mpMaybeSendDrag();   // live drag positions ride their own (finer) throttle
      if (!throttled()) return;
      const w = (typeof Tools !== "undefined" && Tools.cursor) ? Tools.cursor : null;
      if (!w) return;
      mpBroadcast({ t: "cur", from: MP.id, x: w.x, y: w.y, name: MP.name, color: MP.color, host: MP.isHost });
    });
    canvas.addEventListener("pointerleave", sendLeave);
  }
  // schematic editor cursor — same channel, sch:true marks the coords as schematic mm
  const schCv = document.getElementById("sch-canvas");
  if (schCv && typeof schS2X === "function"){
    schCv.addEventListener("pointermove", (e) => {
      if (!throttled()) return;
      const r = schCv.getBoundingClientRect();
      mpBroadcast({ t: "cur", from: MP.id, sch: true,
        x: schS2X(e.clientX - r.left), y: schS2Y(e.clientY - r.top),
        name: MP.name, color: MP.color, host: MP.isHost });
    });
    schCv.addEventListener("pointerleave", sendLeave);
  }
}

/* ---------------- tab presence (coloured dots on the editor tab bar) ---------------- */

/* my own tab announcement — sent to newcomers on dc open and broadcast on tab switch */
function mpTabMsgOut(){
  const tab = (typeof EditorTabs !== "undefined") ? EditorTabs.current : "visual";
  return { t: "tab", from: MP.id, tab, name: MP.name, color: MP.color, host: MP.isHost };
}
function mpSendTab(){
  if (!mpConnected()) return;
  const m = mpTabMsgOut();
  if (m.tab === MP._sentTab) return;
  MP._sentTab = m.tab;
  mpBroadcast(m);
}
function mpTabMsg(m){
  if (!m.from || m.from === MP.id) return;
  MP.tabs.set(m.from, { tab: m.tab, name: m.name, color: m.color, host: !!m.host });
  mpRenderTabDots();
}

/* draw one dot per peer inside the tab button the peer is currently on */
function mpRenderTabDots(){
  for (const tab of ["visual", "schematic", "bom", "nets", "projects"]){
    const btn = document.getElementById("tab-" + tab);
    if (!btn) continue;
    let box = btn.querySelector(".mp-tab-dots");
    const here = [...MP.tabs.values()].filter(p => p.tab === tab);
    if (!here.length){ if (box) box.remove(); continue; }
    if (!box){
      box = document.createElement("span");
      box.className = "mp-tab-dots";
      btn.appendChild(box);
    }
    box.innerHTML = "";
    for (const p of here){
      const d = document.createElement("span");
      d.className = "mp-tab-dot" + (p.host ? " mp-tab-dot-host" : "");
      d.style.background = p.color || "#4dd2ff";
      d.title = (p.name || "peer") + (p.host ? " (host)" : "") + " is on this tab";
      box.appendChild(d);
    }
  }
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
    if (MP.peers.length && MP.isHost){
      const me = document.createElement("div");
      me.className = "panel-hint";
      me.style.margin = "0 0 3px";
      me.textContent = "\u{1F451} You are hosting this session — you own the board, images and guest permissions.";
      list.appendChild(me);
    }
    // a hide-cursor toggle for every from-id we know a cursor for
    const eyeBtn = (fromId) => {
      const eye = document.createElement("button");
      const hidden = MP.hiddenCursors.has(fromId);
      eye.textContent = hidden ? "🚫" : "👁";
      eye.title = hidden ? "Cursor hidden — click to show it again" : "Hide this peer's cursor";
      eye.onclick = () => {
        if (!MP.hiddenCursors.delete(fromId)) MP.hiddenCursors.add(fromId);
        mpLayoutCursors(); mpRefreshUI();
      };
      return eye;
    };
    const seen = new Set();
    for (const p of MP.peers){
      if (p.remoteId) seen.add(p.remoteId);
      const row = document.createElement("div");
      row.className = "mp-peer";
      const crown = p.isHost ? "\u{1F451} " : "";
      row.innerHTML = `<span class="mp-dot${p.isHost ? " mp-dot-host" : ""}" style="background:${p.open ? mpCleanColor(p.color) : "#555"}"></span>
        <span>${p.open ? crown + mpEsc(p.name) + (p.isHost ? ' <span class="mp-host-tag">host</span>' : "") : "connecting…"}</span>
        <span class="mp-peer-state">${p.pc.connectionState}</span>`;
      if (p.remoteId && p.open) row.appendChild(eyeBtn(p.remoteId));
      const kick = document.createElement("button");
      kick.textContent = "✕";
      kick.title = "Disconnect this peer";
      kick.onclick = () => mpDropPeer(p);
      row.appendChild(kick);
      list.appendChild(row);
    }
    // peers we only know through the host's relay (other guests) — no connection to
    // manage, but their cursor can still be hidden
    for (const [id, c] of MP.cursors){
      if (seen.has(id) || id === MP.id) continue;
      const row = document.createElement("div");
      row.className = "mp-peer";
      row.innerHTML = `<span class="mp-dot" style="background:${mpCleanColor(c.color)}"></span>
        <span>${(c.host ? "\u{1F451} " : "") + mpEsc(c.name || "peer")}</span>
        <span class="mp-peer-state">via host</span>`;
      row.appendChild(eyeBtn(id));
      list.appendChild(row);
    }
  }
  const leave = document.getElementById("mp-leave");
  if (leave) leave.style.display = MP.peers.length ? "" : "none";
  // host-only controls: image re-send + guest permissions
  const resend = document.getElementById("mp-resend");
  if (resend) resend.style.display = MP.isHost ? "" : "none";
  const rightsBox = document.getElementById("mp-rights");
  if (rightsBox) rightsBox.style.display = MP.isHost ? "" : "none";
  // session chat sits above the inspector while connected (always visible)
  const chat = document.getElementById("mp-chat");
  if (chat) chat.style.display = mpConnected() ? "" : "none";
  mpApplyGuestLock();
}

/* grey out whatever the guest permissions forbid (the actual call paths are also
   guarded / host-verified, so this is the visible half of the fence) */
function mpApplyGuestLock(force){
  const lockImg  = mpRightBlocked("layerTools");
  const lockSave = mpRightBlocked("saveExport");
  const lockOpen = mpRightBlocked("openProjects");
  const lockObj  = mpRightBlocked("editObjects");
  const sig = [lockImg, lockSave, lockOpen, lockObj].join();
  if (!force && sig === MP._uiLocked) return;
  MP._uiLocked = sig;
  const setLock = (id, locked) => {
    const b = document.getElementById(id);
    if (b){ b.disabled = locked; b.classList.toggle("mp-locked", locked); }
  };
  for (const id of ["btn-align", "btn-calibrate", "btn-rotate", "btn-crop", "btn-deskew", "btn-resizexy",
                    "btn-add-layer", "btn-add-url"]) setLock(id, lockImg);
  setLock("btn-save", lockSave);
  setLock("btn-export", lockSave);
  setLock("btn-new", lockOpen);
  setLock("btn-open", lockOpen);
  document.querySelectorAll('#toolbar .tool[data-tool="align"]').forEach(b => b.classList.toggle("mp-locked", lockImg));
  document.querySelectorAll('#toolbar .tool[data-tool="component"],#toolbar .tool[data-tool="trace"],#toolbar .tool[data-tool="via"],#toolbar .tool[data-tool="cut"],#toolbar .tool[data-tool="note"]')
    .forEach(b => b.classList.toggle("mp-locked", lockObj));
  if (typeof UI !== "undefined" && UI.refreshLayerList) UI.refreshLayerList();   // per-layer-card buttons
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
    $id("mp-imgres").value = MP.opts.maxPxPerMm || "";   // blank = auto (half the image)
    for (const k of MP_RIGHTS){ const cb = $id("mpr-" + k); if (cb) cb.checked = !!MP.rights[k]; }
    mpRefreshUI(); mpStatus("");
    dlg.showModal();
  });
  $id("mp-close").addEventListener("click", () => dlg.close());
  $id("mp-name").addEventListener("change", e => { MP.name = mpCleanName(e.target.value.trim()) || MP.name; e.target.value = MP.name; mpSavePrefs(); });
  $id("mp-color").addEventListener("change", e => { MP.color = e.target.value; mpSavePrefs(); });
  $id("mp-imgshare").addEventListener("change", e => {
    MP.opts.sendImages = e.target.checked; mpSavePrefs();
    MP._imgSig.clear();                      // (re)send everything under the new setting
    if (MP.opts.sendImages && mpConnected()){
      mpSyncImages();
      // also ask the others to re-offer theirs — "share images" reads as two-way
      mpBroadcast({ t: "imgreq", from: MP.id });
    }
  });
  $id("mp-imgres").addEventListener("change", e => {
    const v = parseFloat(e.target.value);
    MP.opts.maxPxPerMm = (v > 0) ? Math.max(5, v) : 0;   // blank/invalid = auto
    e.target.value = MP.opts.maxPxPerMm || "";
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

  // host-only: force a fresh image share at the current px/mm cap
  const resend = $id("mp-resend");
  if (resend) resend.addEventListener("click", () => {
    if (!MP.isHost) return;
    MP._imgSig.clear();
    if (MP.opts.sendImages && mpConnected()){ mpSyncImages(); mpStatus("Re-sending image layers…"); }
    else mpStatus("Nothing to re-send — enable image sharing and connect first.", true);
  });

  // host-only: guest permission checkboxes — saved locally, broadcast to every guest
  for (const k of MP_RIGHTS){
    const cb = $id("mpr-" + k);
    if (!cb) continue;
    cb.addEventListener("change", () => {
      MP.rights[k] = cb.checked;
      mpSavePrefs();
      if (MP.isHost && mpConnected()) mpBroadcast({ t: "rights", from: MP.id, rights: MP.rights });
    });
  }
}

/* ---------------- session chat ---------------- */

const MP_CHAT_CAP = 200;   // rendered lines kept

function mpChatLine(name, color, text){
  const log = document.getElementById("mp-chat-log");
  if (!log) return;
  const row = document.createElement("div");
  row.className = "mp-chat-line";
  const who = document.createElement("span");
  who.className = "who";
  who.style.color = mpCleanColor(color);
  who.textContent = mpCleanName(name) || "peer";   // textContent — no markup can run
  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = mpCleanText(text);
  row.appendChild(who); row.appendChild(txt);
  log.appendChild(row);
  while (log.childNodes.length > MP_CHAT_CAP) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function mpSendChat(){
  const inp = document.getElementById("mp-chat-in");
  if (!inp) return;
  const text = mpCleanText(inp.value.trim());
  if (!text || !mpConnected()) return;
  inp.value = "";
  mpBroadcast({ t: "chat", from: MP.id, name: MP.name, color: MP.color, text });
  mpChatLine(MP.name, MP.color, text);   // own message shows immediately
}

function mpWireChat(){
  const inp = document.getElementById("mp-chat-in");
  const send = document.getElementById("mp-chat-send");
  if (send) send.addEventListener("click", mpSendChat);
  if (inp) inp.addEventListener("keydown", e => {
    if (e.key === "Enter"){ e.preventDefault(); mpSendChat(); }
    e.stopPropagation();   // typing in chat must not trigger editor hotkeys
  });
}

/* ---------------- guest permission enforcement (function wraps) ----------------
   The host verifies incoming state against the rights (mpHostViolation) — these
   wraps are the guest-side fence so blocked actions don't even happen locally. */
function mpInstallGuards(){
  const wrap = (name, right, label, bigChange) => {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function(...a){
      if (right && mpDenied(right, label)) return;
      // a project open/import/new replaces the whole board — flag it so the HOST
      // gets an accept/decline prompt instead of silently adopting it
      if (bigChange && mpConnected() && !MP.applying) MP._bigChange = true;
      return orig.apply(this, a);
    };
  };
  // mark layers this side added/replaced itself — the ONLY images a guest may offer.
  // Installed FIRST so the deny wraps below sit outside (a blocked call never marks).
  const markOwn = (name, pick) => {
    const orig = window[name];
    if (typeof orig !== "function") return;
    window[name] = function(...a){
      const r = orig.apply(this, a);
      const l = pick(a, r);
      if (l && typeof l === "object") l._mpOwn = true;
      return r;
    };
  };
  markOwn("addLayerFromImage", (a, r) => r);
  markOwn("replaceLayerImage", (a) => a[0]);
  markOwn("replaceLayerImageFromURL", (a) => a[0]);

  wrap("resetProject",    "openProjects", "start a new project", true);
  wrap("openProjectFile", "openProjects", "open projects", true);
  wrap("importBoardFile", "openProjects", "import boards", true);
  wrap("componentDown",     "editObjects", "place or edit objects");
  wrap("traceDown",         "editObjects", "place or edit objects");
  wrap("viaDown",           "editObjects", "place or edit objects");
  wrap("cutDown",           "editObjects", "place or edit objects");
  wrap("noteDown",          "editObjects", "place or edit objects");
  wrap("deleteSelection",   "editObjects", "delete objects");
  wrap("deleteBoxSelection","editObjects", "delete objects");
  wrap("rotateSelection",   "editObjects", "edit objects");
  wrap("flipSelectionSide", "editObjects", "edit objects");
  wrap("duplicateSelection","editObjects", "copy objects");
  wrap("addLayerFromImage",     "layerTools", "add image layers");
  wrap("addImageLayerFromURL",  "layerTools", "add image layers");
  wrap("replaceLayerImage",     "layerTools", "replace layer images");
  wrap("replaceLayerImageFromURL", "layerTools", "replace layer images");
  wrap("saveProject", "saveExport", "save or export the project");
  if (typeof UI !== "undefined" && typeof UI.openExport === "function"){
    const origExp = UI.openExport;
    UI.openExport = function(...a){
      if (mpDenied("saveExport", "save or export the project")) return;
      return origExp.apply(this, a);
    };
  }
  if (typeof Projects !== "undefined" && typeof Projects.open === "function"){
    const origPO = Projects.open;
    Projects.open = async function(...a){
      if (mpDenied("openProjects", "open projects")) return;
      if (mpConnected() && !MP.applying) MP._bigChange = true;
      return origPO.apply(this, a);
    };
  }
  // one switch turns every AI feature off: everything checks AI.enabled(feature)
  if (typeof AI !== "undefined" && typeof AI.enabled === "function"){
    const origEn = AI.enabled.bind(AI);
    AI.enabled = (f) => mpRightBlocked("ai") ? false : origEn(f);
  }
}

/* ---------------- boot ---------------- */

function mpInjectStyle(){
  const st = document.createElement("style");
  st.textContent = `
#mp-cursors,#mp-cursors-sch{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:6}
#sch-canvas-wrap{position:relative}
.mp-cursor{position:absolute;left:0;top:0;will-change:transform}
.mp-cursor .mp-name{position:absolute;left:12px;top:14px;color:#111;font:11px/1.5 sans-serif;
  padding:0 5px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.5)}
#btn-mp.mp-live{background:#1d4030;border-color:#2f7d52;color:#8fe6b0}
.mp-peer{display:flex;align-items:center;gap:7px;padding:3px 2px;font-size:12px}
.mp-peer .mp-dot{width:9px;height:9px;border-radius:50%;flex:none}
.mp-peer .mp-peer-state{color:#78838f;font-size:11px;margin-left:auto}
.mp-peer button{padding:0 6px}
.mp-tab-dots{display:inline-flex;gap:3px;margin-left:6px;vertical-align:middle;pointer-events:none}
.mp-tab-dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 0 1px rgba(0,0,0,.55)}
.mp-edit-dot{position:absolute;left:-6px;top:-6px;width:12px;height:12px;border-radius:50%;
  box-shadow:0 0 0 2px rgba(0,0,0,.6),0 0 8px 2px currentColor;will-change:transform,opacity;
  transition:opacity .4s linear}
.mp-sel-ring{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;
  border:2.5px solid;box-shadow:0 0 6px 1px currentColor,inset 0 0 4px currentColor;
  will-change:transform;background:transparent}
.mp-locked{opacity:.4;pointer-events:auto;cursor:not-allowed !important}
.mp-tab-dot-host{box-shadow:0 0 0 1px rgba(0,0,0,.55),0 0 0 2.5px #e7b74a}
.mp-dot-host{box-shadow:0 0 0 2px #e7b74a}
.mp-host-tag{background:#5a4716;color:#ffd76e;border-radius:4px;padding:0 4px;font-size:10px;margin-left:3px}
#mp-rights label{display:flex;gap:5px;align-items:flex-start;line-height:1.35}
#mp-rights input{margin-top:2px;flex:none}
#mp-chat{border-bottom:1px solid #2e3742;margin-bottom:8px;display:flex;flex-direction:column;
  max-height:260px;min-height:110px;flex:none}
#mp-chat-log{flex:1;min-height:60px;overflow-y:auto;font-size:12px;padding:3px 6px;
  display:flex;flex-direction:column;gap:2px}
.mp-chat-line{display:flex;gap:5px;align-items:baseline}
.mp-chat-line .who{font-weight:600;flex:none;max-width:110px;overflow:hidden;text-overflow:ellipsis}
.mp-chat-line .txt{word-break:break-word;white-space:pre-wrap;color:#cfd6de}
#mp-chat-row{display:flex;gap:4px;padding:4px 6px 6px}
#mp-chat-in{flex:1;min-width:0;background:#1c222b;border:1px solid #2e3742;border-radius:5px;
  color:#d7dde5;font-size:12px;padding:3px 6px}
#mp-chat-row button{flex:none;padding:0 9px}
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
  mpWireChat();
  mpWireCursorSend();
  mpInstallGuards();
  mpRefreshUI();
  // edits announce themselves through markDirty — piggyback a quick sync check
  const origDirty = window.markDirty;
  window.markDirty = function(...a){ origDirty.apply(this, a); mpNudge(); };
  // any re-render (pan/zoom included) repositions the remote cursors
  const origRR = window.requestRender;
  window.requestRender = function(...a){ origRR.apply(this, a); if (MP.cursors.size || MP.edits.size || MP.remoteSel.size) mpLayoutCursors(); };
  // …and the same for the schematic editor (its pan/zoom goes through Sch.render)
  if (typeof Sch !== "undefined" && Sch.render){
    const origSR = Sch.render;
    Sch.render = function(...a){ const r = origSR.apply(this, a); if (MP.cursors.size) mpLayoutCursors(); return r; };
  }
  // switching editor tabs announces where I am (dots on the peers' tab bars)
  if (typeof EditorTabs !== "undefined" && EditorTabs.show){
    const origShow = EditorTabs.show;
    EditorTabs.show = function(...a){ const r = origShow.apply(this, a); mpSendTab(); return r; };
  }
  // opening a project mid-session: a reopened board can reuse the LAYER IDS the
  // signature cache already holds, so image sync silently skipped every layer —
  // forget what was sent and let the next tick re-offer the new project's images
  if (typeof window.loadProject === "function"){
    const origLoad = window.loadProject;
    window.loadProject = function(...a){
      MP._imgSig.clear();
      MP._pendingImgs.clear();
      // a whole-board swap mid-session needs the host's accept/decline
      if (mpConnected() && !MP.applying) MP._bigChange = true;
      return origLoad.apply(this, a);
    };
  }
  window.addEventListener("beforeunload", () => { if (mpConnected()) mpBroadcast({ t: "bye", from: MP.id }); });
});
