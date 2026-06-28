/* ===== ui.js — panels, inspector, dialogs, toasts ===== */
"use strict";

const UI = {
  sel: null,            // {type:'comp'|'pin'|'via'|'trace', ...}
  activeLayerId: null,
  activeNetId: null,    // clicked in net list → persistent highlight
  pinSel: [],           // shift-click multi-selected pins: [{comp,pinIdx}]
};

UI.togglePinSel = (comp, pinIdx) => {
  const i = UI.pinSel.findIndex(p => p.comp === comp && p.pinIdx === pinIdx);
  if (i >= 0) UI.pinSel.splice(i, 1);
  else UI.pinSel.push({comp, pinIdx});
  UI.sel = null;
  UI.refreshInspector();
};
UI.isPinSelected = (comp, pinIdx) =>
  UI.pinSel.some(p => p.comp === comp && p.pinIdx === pinIdx);

/* multi-trace selection (shift = whole net, ctrl = add/remove a segment) */
UI.traceSel = [];
UI.selectNetTraces = (netId) => {
  UI.sel = null; UI.pinSel = [];
  UI.traceSel = netId ? State.traces.filter(t => t.netId === netId) : [];
  UI.activeNetId = netId || null;
  UI.refreshInspector(); UI.refreshNets();
  if (netId) blinkNet(netId);
};
UI.toggleTraceSel = (trace) => {
  const i = UI.traceSel.indexOf(trace);
  if (i >= 0) UI.traceSel.splice(i, 1); else UI.traceSel.push(trace);
  UI.sel = null;
  UI.refreshInspector();
};
UI.isTraceSelected = (t) => UI.traceSel.includes(t);

const $ = (sel) => document.querySelector(sel);

/* ---------------- status bar ---------------- */
UI.setStatusTool = (name) => { $("#status-tool").textContent = name.toUpperCase(); };
UI.setStatusPos = (w) => {
  const u = (v)=> { const mm = v/State.pxPerMm; return UI.unit()==="mil" ? (mm/MM_PER_MIL).toFixed(0) : mm.toFixed(2); };
  $("#status-pos").textContent = `x ${w.x.toFixed(0)}  y ${w.y.toFixed(0)} px   (${u(w.x)}, ${u(w.y)} ${UI.unit()})`;
  $("#status-zoom").textContent = "zoom " + (View.zoom*100).toFixed(0) + "%" + (View.flip ? "  ·  BACK VIEW" : "");
};
UI.setHint = (t) => { $("#status-hint").textContent = t; };

UI.toast = (msg) => {
  let el = $("#toast");
  if (!el){
    el = document.createElement("div");
    el.id = "toast";
    el.style.cssText = "position:fixed;left:50%;bottom:46px;transform:translateX(-50%);background:#243044;border:1px solid #3c4856;color:#d7dde5;padding:6px 16px;border-radius:6px;z-index:99;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.4);transition:opacity .3s";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(UI._toastT);
  UI._toastT = setTimeout(()=>{ el.style.opacity = "0"; }, 2600);
};

UI.drawSide = () => $("#draw-side").value;
/* the copper side new traces/components target (X-ray is now a separate overlay,
   so the draw side is always a real copper side) */
UI.copperSide = () => UI.drawSide();
UI.activeLayer = () => getLayer(UI.activeLayerId);
UI.layerKeyMode = () => localStorage.getItem("pcbreveng.layerKeyMode") || "switch";

/* measurement units (user preference, persisted) */
UI.unit = () => localStorage.getItem("pcbreveng.unit") || "mm";
const MM_PER_MIL = 0.0254;
function fmtLen(mm){
  return UI.unit() === "mil" ? (mm/MM_PER_MIL).toFixed(1) + " mil" : mm.toFixed(2) + " mm";
}

/* options html for a layer-side <select> (copper sides + X-ray); keeps `current` if odd */
function sideOptionsHtml(current){
  const sides = [...availableSides(), "xray"];
  if (current && !sides.includes(current)) sides.push(current);
  return sides.map(s => `<option value="${s}">${SIDE_LABELS[s] || s}</option>`).join("");
}

/* rebuild the toolbar draw-side selector for the current layer count
   (X-ray is a separate overlay toggle, not a draw side) */
UI.rebuildSideSelect = () => {
  const sel = $("#draw-side");
  const cur = sel.value;
  const opts = availableSides();
  sel.innerHTML = opts.map(s =>
    `<option value="${s}">${SIDE_LABELS[s]}${s==="front"?" (F.Cu)":s==="back"?" (B.Cu)":""}</option>`).join("");
  sel.value = opts.includes(cur) ? cur : "front";
  UI.refreshXrayBtn();
};

/* X-ray overlay is always available: with no X-ray image it still shows both
   sides' copper, dimming the inactive side's traces/components */
UI.refreshXrayBtn = () => {
  const btn = $("#btn-xray");
  if (!btn) return;
  btn.style.display = "";
  btn.classList.toggle("active", !!View.xray);
};

/* switch the active draw side (e.g. when activating an image layer of that side) */
UI.setDrawSide = (side) => {
  if (side === "xray") return; // X-ray is an overlay toggle, not a draw side
  if (!availableSides().includes(side)) return;
  if ($("#draw-side").value === side) return;
  $("#draw-side").value = side;
  Tools.lastCopperSide = side;
  UI.toast("Drawing on " + SIDE_LABELS[side]);
  requestRender(); // trace/component visibility follows the draw side
};

/* ---------------- selection ---------------- */
UI.select = (sel) => {
  UI.sel = sel;
  UI.activeNetId = null;
  UI.pinSel = [];
  UI.traceSel = [];
  UI.refreshInspector();
  UI.refreshNets();
};

/* live-commit helper: one undo entry per focus session, value applied on every keystroke */
function bindLive(el, label, apply){
  el.addEventListener("focus", () => { el._undoArmed = true; });
  el.addEventListener("input", () => {
    if (el._undoArmed){ pushUndo(label); el._undoArmed = false; }
    apply(el.value);
    requestRender();
  });
}

/* ---------------- layer panel ---------------- */
UI.refreshLayerList = () => {
  const list = $("#layer-list");
  list.innerHTML = "";
  $("#drop-hint").style.display = State.layers.length ? "none" : "flex";
  for (const l of State.layers){
    const card = document.createElement("div");
    card.className = "layer-card" + (l.id === UI.activeLayerId ? " active" : "");
    card.innerHTML = `
      <div class="layer-head">
        <button class="vis" title="Show / hide">${l.visible ? "👁" : "—"}</button>
        <div class="name" title="${l.name}">${l.name}</div>
        <button class="del" title="Remove layer">✕</button>
      </div>
      <div class="layer-row">
        <select class="side-sel" title="Which physical side this photo shows">${sideOptionsHtml(l.side)}</select>
        <label title="Mirror image horizontally (back-side photos usually need this so they align with the front)">
          <input type="checkbox" class="mir" ${l.mirror?"checked":""}>⇋</label>
        <label title="Lock layer against accidental dragging"><input type="checkbox" class="lock" ${l.locked?"checked":""}>🔒</label>
        <button class="align2" title="4-point align: click 4 reference features, then the same 4 features on this layer (corrects offset, rotation, scale and skew)">Align</button>
      </div>
      <input type="range" class="op" min="0" max="100" value="${Math.round(l.opacity*100)}" title="Opacity">`;
    card.querySelector(".side-sel").value = l.side;
    card.addEventListener("click", (e)=>{
      if (e.target.closest("button,select,input,label")) return;
      UI.activeLayerId = l.id; UI.refreshLayerList();
      UI.setDrawSide(l.side); // selecting the back image switches drawing to Back, etc.
    });
    card.querySelector(".vis").addEventListener("click", ()=>{ l.visible = !l.visible; UI.refreshLayerList(); requestRender(); });
    card.querySelector(".del").addEventListener("click", ()=>{
      if (!confirm("Remove layer “" + l.name + "”?")) return;
      State.layers = State.layers.filter(x => x !== l);
      if (UI.activeLayerId === l.id) UI.activeLayerId = State.layers[0]?.id ?? null;
      if (typeof markImagesDirty === "function") markImagesDirty();
      UI.refreshLayerList(); requestRender();
    });
    card.querySelector(".side-sel").addEventListener("change", (e)=>{
      const was = l.side;
      l.side = e.target.value;
      // back photos are mirrored by default (only while not yet warped/aligned)
      if (!l.warp){
        if (l.side === "back" && was !== "back" && !l.mirror){
          l.mirror = true; UI.toast("Layer mirrored ⇋ (back-side photo default)");
        } else if (was === "back" && l.side !== "back" && l.mirror){
          l.mirror = false;
        }
      }
      UI.setDrawSide(l.side);
      UI.refreshLayerList(); requestRender();
    });
    card.querySelector(".mir").addEventListener("change", (e)=>{
      l.mirror = e.target.checked;
      if (l.warp){ // warped layers mirror in image space: W · diag(-1,1)
        l.warp = { a:-l.warp.a, b:-l.warp.b, c:l.warp.c, d:l.warp.d };
      }
      requestRender();
    });
    card.querySelector(".lock").addEventListener("change", (e)=>{ l.locked = e.target.checked; });
    card.querySelector(".align2").addEventListener("click", ()=>{
      UI.activeLayerId = l.id; UI.refreshLayerList();
      startPointAlign();
    });
    card.querySelector(".op").addEventListener("input", (e)=>{ l.opacity = e.target.value/100; requestRender(); });
    list.appendChild(card);
  }
  UI.refreshXrayBtn();
};

/* ---------------- net list ---------------- */
UI.netFilter = "";
UI.refreshNets = () => {
  const list = $("#net-list");
  list.innerHTML = "";
  const map = buildNetMap();
  const q = UI.netFilter.trim().toLowerCase();
  let shown = 0, total = 0;
  for (const n of State.nets){
    const members = netMembers(n.id);
    if (!members.length) continue;
    total++;
    if (q && !n.name.toLowerCase().includes(q)) continue;
    shown++;
    const item = document.createElement("div");
    item.className = "net-item" + (UI.activeNetId === n.id ? " active" : "");
    const pinCount = (map.get(n.id) || []).length;
    item.innerHTML = `<input type="color" class="net-color" value="${/^#[0-9a-fA-F]{6}$/.test(n.color)?n.color:"#888888"}" title="Net colour">
      <button class="nprot${n.protected?" on":""}" title="${n.protected?"Protected — locked name, shielded from accidental merges. Click to unprotect.":"Click to protect — lock the name and shield from accidental merges."}">🛡</button>
      <span class="nname" title="${escAttr(n.name)}${n.protected?" (protected)":""}">${escAttr(n.name)}</span>
      <span class="ncount">${pinCount}p</span>`;
    item.querySelector(".net-color").addEventListener("click", e => e.stopPropagation());
    item.querySelector(".nprot").addEventListener("click", e => {
      e.stopPropagation();
      pushUndo((n.protected?"unprotect ":"protect ") + n.name);
      setNetProtected(n.id, !n.protected);
      UI.refreshNets(); UI.refreshInspector(); requestRender();
    });
    item.querySelector(".net-color").addEventListener("input", e => {
      pushUndo("net colour"); n.color = e.target.value; requestRender();
    });
    // hovering a net row previews it on the board (and isolates its ratsnest)
    item.addEventListener("mouseenter", ()=>{ View.hoverNetId = n.id; requestRender(); });
    item.addEventListener("mouseleave", ()=>{ if (View.hoverNetId === n.id){ View.hoverNetId = null; requestRender(); } });
    item.addEventListener("click", ()=>{
      const turnOn = UI.activeNetId !== n.id;
      UI.activeNetId = turnOn ? n.id : null;
      UI.refreshNets();
      if (turnOn) blinkNet(n.id); else requestRender();
    });
    item.addEventListener("dblclick", ()=>{
      if (n.protected){ UI.toast(n.name + " is a protected prefab net — it cannot be renamed"); return; }
      const name = prompt("Rename net:", n.name);
      if (name === null) return;
      pushUndo("rename net " + n.name);
      if (!renameNet(n.id, name)){ Undo.stack.pop(); UI.toast("Rename blocked (protected net)"); }
      UI.refreshNets(); UI.refreshInspector(); requestRender();
    });
    list.appendChild(item);
  }
  if (q && !shown && total){
    const none = document.createElement("div");
    none.className = "panel-hint";
    none.textContent = "No nets match “" + UI.netFilter.trim() + "”";
    list.appendChild(none);
  }
  $("#net-count").textContent = q ? "(" + shown + "/" + total + ")" : (total ? "(" + total + ")" : "");
  UI.refreshParts(); // keep the parts list in sync with the same mutations that touch nets
};

/* wire the net search box (filters the net list live) */
UI.wireNetSearch = () => {
  const inp = $("#net-search");
  if (!inp) return;
  inp.addEventListener("input", () => { UI.netFilter = inp.value; UI.refreshNets(); });
};

/* ---------------- parts list / search ---------------- */
UI.partFilter = "";

UI.wirePartSearch = () => {
  const inp = $("#part-search");
  if (inp) inp.addEventListener("input", () => { UI.partFilter = inp.value; UI.refreshParts(); });
  const close = $("#parts-close");
  if (close) close.addEventListener("click", () => $("#parts-dialog").close());
};

/* open the parts search as a modal popup (Ctrl-F) */
UI.openPartsDialog = () => {
  const dlg = $("#parts-dialog");
  if (!dlg) return;
  if (!dlg.open) dlg.showModal();
  UI.refreshParts();
  const inp = $("#part-search");
  if (inp){ inp.value = UI.partFilter; inp.focus(); inp.select(); }
};

UI.refreshParts = () => {
  const list = $("#part-list");
  if (!list) return;
  const sc = list.scrollTop;                 // keep scroll position across rebuilds
  list.innerHTML = "";
  const q = (UI.partFilter || "").trim().toLowerCase();
  // tally refs (case-insensitive) so parts sharing a reference can be flagged
  const refCount = {};
  for (const c of State.components){ const k = (c.ref||"").trim().toLowerCase(); if (k) refCount[k] = (refCount[k]||0) + 1; }
  const comps = State.components.slice()
    .sort((a,b) => (a.ref||"").localeCompare(b.ref||"", undefined, { numeric:true, sensitivity:"base" }));
  const total = comps.length;
  let shown = 0, dupes = 0;
  for (const c of comps){
    if (q && !((c.ref||"") + " " + (c.value||"") + " " + (c.part||"")).toLowerCase().includes(q)) continue;
    shown++;
    const isDup = refCount[(c.ref||"").trim().toLowerCase()] > 1;
    if (isDup) dupes++;
    const item = document.createElement("div");
    item.className = "part-item" + (UI.sel && UI.sel.type==="comp" && UI.sel.comp===c ? " active" : "") + (isDup ? " dup" : "");
    item.innerHTML = `<span class="pref">${escAttr(c.ref)}${isDup ? ' <span class="dup-badge" title="Duplicate reference">dup</span>' : ''}</span>
      <span class="pval">${escAttr(c.value || "")}</span>
      <span class="pside">${c.side==="back" ? "B" : "F"}</span>`;
    item.addEventListener("click", () => UI.jumpToComp(c));
    list.appendChild(item);
  }
  if (q && !shown && total){
    const none = document.createElement("div");
    none.className = "panel-hint";
    none.textContent = "No parts match “" + UI.partFilter.trim() + "”";
    list.appendChild(none);
  }
  const cnt = $("#part-count");
  if (cnt){
    const base = q ? "(" + shown + "/" + total + ")" : (total ? "(" + total + ")" : "");
    cnt.innerHTML = base + (dupes ? ' <span class="dup-badge">' + dupes + ' dup</span>' : '');
  }
  list.scrollTop = sc;
};

/* central rename: warns when another part already owns the reference, offering
   abort or a name-swap with that part. Returns nothing; refreshes on success. */
UI.commitRename = (c, newRef) => {
  newRef = (newRef || "").trim();
  if (!newRef || newRef === c.ref){ UI.refreshInspector(); return; }
  const dup = State.components.find(x => x !== c && (x.ref||"").trim().toLowerCase() === newRef.toLowerCase());
  if (!dup){
    pushUndo("rename " + c.ref);
    c.ref = newRef; registerRef(c.ref);
    requestRender(); UI.refreshNets(); UI.refreshInspector();
    return;
  }
  UI.openDupName(c, dup, newRef);
};

/* duplicate-reference dialog: abort keeps the old name; swap gives this part the
   new ref and hands its old ref to the part that already had the new one. */
UI.openDupName = (c, dup, newRef) => {
  const dlg = $("#dupname-dialog");
  if (!dlg){ UI.refreshInspector(); return; }
  $("#dupname-msg").innerHTML =
    `Reference <b>${escAttr(newRef)}</b> is already used by another part (value “${escAttr(dup.value||"")}”, ` +
    `${dup.side==="back"?"back":"front"} side).<br><br>` +
    `<b>Swap names</b> gives this part <b>${escAttr(newRef)}</b> and renames the other part to <b>${escAttr(c.ref)}</b>.`;
  $("#dupname-abort").onclick = () => { dlg.close(); UI.refreshInspector(); };
  $("#dupname-swap").onclick = () => {
    dlg.close();
    pushUndo("swap refs " + c.ref + " ↔ " + dup.ref);
    const old = c.ref;
    c.ref = newRef; dup.ref = old;
    registerRef(c.ref); registerRef(dup.ref);
    requestRender(); UI.refreshNets(); UI.refreshInspector();
    UI.toast("Swapped: " + dup.ref + " ↔ " + c.ref);
  };
  dlg.showModal();
};

/* select a component and centre the view on it */
UI.jumpToComp = (c) => {
  UI.select({ type:"comp", comp:c });
  View.panX = View.width/2 - c.x*View.zoom*(View.flip?-1:1);
  View.panY = View.height/2 - c.y*View.zoom;
  requestRender();
};

/* ---------------- inspector ---------------- */
UI.refreshInspector = () => {
  const box = $("#inspector");
  const sel = UI.sel;
  box.innerHTML = "";
  if (UI.pinSel.length){ UI.inspectMultiPins(); return; }
  if (UI.traceSel.length){ UI.inspectMultiTraces(); return; }
  if (!sel){
    const k = (id)=>Keymap.keyFor(id) || "—";
    box.innerHTML = '<div class="panel-hint">Nothing selected.<br><br>Tips:<br>· ' +
      k("tool.select") + ' select · ' + k("tool.component") + ' component · ' + k("tool.trace") + ' trace · ' + k("tool.via") + ' via<br>' +
      '· Double-click a pad to name its net<br>· ' + k("edit.lock") + ' locks a component<br>· Press ? for all hotkeys</div>';
    return;
  }

  if (sel.type === "comp" || sel.type === "pin"){
    UI.inspectComponent(sel.comp, sel.type === "pin" ? sel.pinIdx : -1);
  } else if (sel.type === "via"){
    UI.inspectNetObj(sel.via.kind === "pth" ? "PTH" : "Via", sel.via, (netId)=>{ sel.via.netId = netId; });
  } else if (sel.type === "trace"){
    UI.inspectTrace(sel.trace);
  }
};

function inspRow(label, inputHtml){
  return `<div class="insp-row"><label>${label}</label>${inputHtml}</div>`;
}

/* shift-click multi-pin panel: one net field for all selected pins */
UI.inspectMultiPins = () => {
  const box = $("#inspector");
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const list = UI.pinSel.map(p => p.comp.ref + "." + p.comp.pins[p.pinIdx].num).join(", ");
  sec.innerHTML = `
    <div class="insp-title">${UI.pinSel.length} pins selected</div>
    <div class="panel-hint" style="word-break:break-all">${list}</div>
    ${inspRow("Net", `<input id="i-multinet" placeholder="net for ALL selected pins">`)}
    <div class="insp-actions">
      <button id="i-multiclear">Clear selection</button>
    </div>
    <div class="panel-hint">Shift-click pads to add/remove · Enter applies the net to every selected pin</div>`;
  box.appendChild(sec);
  sec.querySelector("#i-multinet").addEventListener("change", e => {
    const name = e.target.value.trim();
    if (!name) return;
    pushUndo("assign net to " + UI.pinSel.length + " pins");
    const target = findNetByName(name) || findNetByName(name.toUpperCase()) || createNet(name);
    for (const p of UI.pinSel) p.comp.pins[p.pinIdx].netId = target.id;
    pruneNets();
    UI.toast(UI.pinSel.length + " pins → " + target.name);
    UI.refreshNets(); requestRender();
  });
  sec.querySelector("#i-multiclear").addEventListener("click", ()=>{ UI.pinSel = []; UI.refreshInspector(); requestRender(); });
  sec.querySelector("#i-multinet").focus();
};

/* multi-trace panel (shift-selected whole net or ctrl-selected segments) */
UI.inspectMultiTraces = () => {
  const box = $("#inspector");
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const nets = [...new Set(UI.traceSel.map(t => t.netId))];
  const netLabel = nets.length === 1 ? (getNet(nets[0])?.name || "(none)") : nets.length + " nets";
  // common width across the selection (blank if they differ, so ↑ starts from a sane value)
  const widths = [...new Set(UI.traceSel.map(t => t.width || 3))];
  const wVal = widths.length === 1 ? widths[0] : "";
  const wPlace = widths.length === 1 ? "px" : "mixed";
  sec.innerHTML = `
    <div class="insp-title">${UI.traceSel.length} trace segments</div>
    <div class="panel-hint">Net: ${netLabel}</div>
    ${inspRow("Set net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-tsnet" placeholder="net for all" style="flex:1;min-width:0"><button id="i-tsgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${inspRow("Width", `<input id="i-tsw" type="number" step="0.5" min="0.5" value="${wVal}" placeholder="${wPlace}"> px`)}
    <div class="insp-actions">
      <button id="i-tsdel" class="danger">Delete all</button>
      <button id="i-tsclear">Clear selection</button>
    </div>`;
  box.appendChild(sec);
  sec.querySelector("#i-tsgen").addEventListener("click", ()=>{ sec.querySelector("#i-tsnet").value = uniqueNetName(); });
  sec.querySelector("#i-tsnet").addEventListener("change", e => {
    const name = e.target.value.trim(); if (!name) return;
    pushUndo("set net on " + UI.traceSel.length + " traces");
    const target = findNetByName(name) || findNetByName(name.toUpperCase()) || createNet(name);
    for (const t of UI.traceSel) t.netId = target.id;
    pruneNets(); UI.toast(UI.traceSel.length + " traces → " + target.name);
    UI.refreshNets(); requestRender();
  });
  sec.querySelector("#i-tsw").addEventListener("change", e => {
    const v = Math.max(0.5, parseFloat(e.target.value)||3);
    pushUndo("trace width"); for (const t of UI.traceSel) t.width = v; requestRender();
  });
  sec.querySelector("#i-tsdel").addEventListener("click", ()=>{
    pushUndo("delete " + UI.traceSel.length + " traces");
    State.traces = State.traces.filter(t => !UI.traceSel.includes(t));
    UI.traceSel = []; pruneNets();
    UI.select(null); UI.refreshNets(); requestRender();
  });
  sec.querySelector("#i-tsclear").addEventListener("click", ()=>{ UI.traceSel = []; UI.refreshInspector(); requestRender(); });
};

/* footprints that expose a "polarized" param (caps) → optional capability */
function compPolarParam(c){
  const def = c && getFootprintDef(c.fpId);
  return (def && def.params.find(p => p.key === "polarized")) || null;
}
function compIsPolarized(c){
  const prm = compPolarParam(c); if (!prm) return false;
  return c.fpParams.polarized !== undefined ? !!c.fpParams.polarized : !!prm.def;
}
function setCompPolarized(c, val){
  if (!compPolarParam(c)) return;
  pushUndo((val ? "polarize " : "unpolarize ") + c.ref);
  c.fpParams = {...c.fpParams, polarized: !!val};
  c._fp = null;
  const fp = compFootprint(c);                 // sync +/- pin names to the new state
  for (let i=0; i<c.pins.length; i++) if (fp.pins[i]) c.pins[i].name = fp.pins[i].name;
  if (UI.sel && UI.sel.comp === c) UI.refreshInspector();
  UI.refreshNets(); requestRender();
}

UI.inspectComponent = (c, selPin) => {
  const box = $("#inspector");
  const fp = compFootprint(c);
  const sec = document.createElement("div");
  sec.className = "insp-section";
  sec.innerHTML = `
    <div class="insp-title">${(compMoveLocked(c)||compEditLocked(c))?"🔒 ":""}${c.ref} <span style="color:#8b96a5;font-weight:400;font-size:11px">— ${fp.label}</span></div>
    <div class="insp-row"><label>Locks</label>
      <label class="lockok" style="display:flex;align-items:center;gap:3px;width:auto;color:#aab4c2;font-size:11px">
        <input type="checkbox" id="i-lockmove" class="lockok" ${compMoveLocked(c)?"checked":""}>move</label>
      <label class="lockok" style="display:flex;align-items:center;gap:3px;width:auto;color:#aab4c2;font-size:11px">
        <input type="checkbox" id="i-lockedit" class="lockok" ${compEditLocked(c)?"checked":""}>edit</label></div>
    ${inspRow("Reference", `<input id="i-ref" value="${escAttr(c.ref)}">`)}
    ${inspRow("Value", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-val" value="${escAttr(c.value)}" style="flex:1;min-width:0"><button id="i-resolve" title="Value resolver — SMD codes &amp; color bands" style="padding:1px 7px">Ω</button></span>`)}
    ${inspRow("Part name", `<input id="i-part" value="${escAttr(c.part)}">`)}
    ${inspRow("KiCad fp", `<input id="i-kicad" value="${escAttr(c.kicad)}" placeholder="lib:footprint">`)}
    ${inspRow("Side", `<select id="i-side"><option value="front">Front</option><option value="back">Back</option></select>`)}
    ${inspRow("Rotation", `<input id="i-rot" type="number" step="any" value="${c.rot.toFixed(1)}"> °`)}
    ${inspRow("Scale ×", `<input id="i-scale" type="number" step="0.05" min="0.1" value="${(c.scale||1).toFixed(2)}">`)}
    ${compPolarParam(c) ? inspRow("Polarized", `<label style="display:flex;align-items:center;gap:6px;width:auto;color:#aab4c2;font-size:11px"><input type="checkbox" id="i-polar" ${compIsPolarized(c)?"checked":""}>+ marker on pin 1</label>`) : ""}
    <div class="insp-actions">
      <button id="i-fp">Change footprint…</button>
      <button id="i-dup">Duplicate</button>
      ${c.fpId==="free" ? `<button id="i-addpin" class="${Tools.addPinFor===c?"primary":""}">${Tools.addPinFor===c?"Done adding pins":"+ Add pins (click board)"}</button>` : ""}
      <button id="i-del" class="danger">Delete</button>
    </div>`;
  box.appendChild(sec);
  sec.querySelector("#i-side").value = c.side;

  const commit = (fn) => { pushUndo("edit " + c.ref); fn(); requestRender(); UI.refreshNets(); };
  // text props commit live on every keystroke (no Enter needed)
  // ref commits on blur/Enter (not per-keystroke) so the duplicate-name check can prompt once
  const refEl = sec.querySelector("#i-ref");
  refEl.addEventListener("change", () => UI.commitRename(c, refEl.value));
  refEl.addEventListener("keydown", e => { if (e.key === "Enter"){ e.preventDefault(); refEl.blur(); } });
  bindLive(sec.querySelector("#i-val"), "edit value", v => { c.value = v; });
  // on blur/enter, auto-resolve SMD codes (220R etc. stay literal) — no apply click needed
  sec.querySelector("#i-val").addEventListener("change", e => {
    const resolved = autoResolveValue(e.target.value);
    if (resolved !== e.target.value){ c.value = resolved; e.target.value = resolved; UI.refreshNets(); requestRender(); }
  });
  sec.querySelector("#i-resolve").addEventListener("click", ()=>{
    const cur = sec.querySelector("#i-val").value;
    const dec = decodeSMD(cur);
    if (dec){ // value already holds a code → decode in place
      pushUndo(); c.value = dec.text;
      UI.toast(cur + " → " + dec.text + "Ω (" + dec.how + ")");
      UI.refreshInspector(); requestRender();
      return;
    }
    Resolver.open(val => { pushUndo(); c.value = val; UI.refreshInspector(); requestRender(); });
  });
  bindLive(sec.querySelector("#i-part"), "edit part", v => { c.part = v; });
  bindLive(sec.querySelector("#i-kicad"), "edit footprint name", v => { c.kicad = v.trim(); });
  sec.querySelector("#i-side").addEventListener("change", e => commit(()=>{ c.side = e.target.value; }));
  sec.querySelector("#i-rot").addEventListener("change", e => commit(()=>{ c.rot = parseFloat(e.target.value)||0; }));
  sec.querySelector("#i-scale").addEventListener("change", e => commit(()=>{ c.scale = Math.max(0.1, parseFloat(e.target.value)||1); }));
  const polCb = sec.querySelector("#i-polar");
  if (polCb) polCb.addEventListener("change", e => setCompPolarized(c, e.target.checked));
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
  sec.querySelector("#i-dup").addEventListener("click", duplicateSelection);
  sec.querySelector("#i-fp").addEventListener("click", ()=> UI.openFootprintDialog(c));
  const addBtn = sec.querySelector("#i-addpin");
  if (addBtn) addBtn.addEventListener("click", ()=>{
    if (Tools.addPinFor === c){
      Tools.addPinFor = null;
      UI.setHint(TOOL_HINTS[Tools.name] || "");
    } else {
      Tools.addPinFor = c;
      UI.setHint("Click on the board to drop pins onto " + c.ref + " — Esc / “Done” to finish");
    }
    UI.refreshInspector();
  });
  sec.querySelector("#i-lockmove").addEventListener("change", e => {
    pushUndo(); migrateLock(c);
    c.lockMove = e.target.checked;
    UI.refreshInspector(); requestRender();
  });
  sec.querySelector("#i-lockedit").addEventListener("change", e => {
    pushUndo(); migrateLock(c);
    c.lockEdit = e.target.checked;
    UI.refreshInspector(); requestRender();
  });
  if (compEditLocked(c))
    sec.querySelectorAll("input,select,button").forEach(el => { if (!el.classList.contains("lockok")) el.disabled = true; });

  // pin table
  const pinSec = document.createElement("div");
  pinSec.className = "insp-section";
  const isFree = c.fpId === "free";
  const plist = isFree ? (c.fpParams.pinList || []) : null;
  let rows = "";
  for (let i=0;i<c.pins.length;i++){
    const p = c.pins[i];
    const netName = p.nc ? "" : (p.netId ? (getNet(p.netId)?.name || "") : "");
    const pl = plist && plist[i];
    const padCells = isFree ? `
      <td><select class="pshape" data-i="${i}" title="Pad type">
        <option value="circle"${pl&&pl.shape!=="rect"?" selected":""}>THT</option>
        <option value="rect"${pl&&pl.shape==="rect"?" selected":""}>SMD</option></select></td>
      <td style="width:42px"><input class="psize" data-i="${i}" type="number" step="0.1" min="0.2" value="${pl?(pl.size||(pl.shape==="rect"?1.2:1.6)):1.6}" title="Pad size (mm)"></td>
      <td style="width:18px"><button class="pdel" data-i="${i}" title="Remove pin" style="padding:0 5px;color:var(--danger);border:none;background:none">✕</button></td>` : "";
    rows += `<tr data-i="${i}" class="${i===selPin?'sel':''}">
      <td style="width:30px;color:#8b96a5">${p.num}</td>
      <td><input class="pname" data-i="${i}" value="${escAttr(p.name)}" placeholder="name"></td>
      <td><input class="pnet" data-i="${i}" value="${escAttr(netName)}" placeholder="net" ${p.nc?"disabled":""}></td>
      <td style="width:24px;text-align:center" title="No-connect (excluded from checker)"><input type="checkbox" class="pnc" data-i="${i}" ${p.nc?"checked":""}></td>
      ${padCells}</tr>`;
  }
  pinSec.innerHTML = `<div class="insp-title" style="font-size:12px">Pins (${c.pins.length})
    <span style="color:#8b96a5;font-weight:400;font-size:10px">— net · NC = no-connect${isFree?" · pad type/size":""}</span></div>
    <table class="pin-table"><tr><th>#</th><th>Name</th><th>Net</th><th>NC</th>${isFree?"<th>Pad</th><th>mm</th><th></th>":""}</tr>${rows}</table>`;
  box.appendChild(pinSec);

  if (isFree){
    pinSec.querySelectorAll(".pshape").forEach(sel => sel.addEventListener("change", e => {
      const i = +e.target.dataset.i;
      pushUndo("pad type"); ensureFreePin(c, i).shape = e.target.value; c._fp = null;
      UI.refreshInspector(); requestRender();
    }));
    pinSec.querySelectorAll(".psize").forEach(inp => inp.addEventListener("change", e => {
      const i = +e.target.dataset.i;
      pushUndo("pad size"); ensureFreePin(c, i).size = Math.max(0.2, parseFloat(e.target.value)||1.0); c._fp = null;
      requestRender();
    }));
  }

  pinSec.querySelectorAll(".pnc").forEach(cb => cb.addEventListener("change", e => {
    const i = +e.target.dataset.i;
    pushUndo("pin NC " + c.ref + "." + c.pins[i].num);
    c.pins[i].nc = e.target.checked;
    if (e.target.checked) c.pins[i].netId = null; // NC pins carry no net
    pruneNets(); UI.refreshNets(); UI.refreshInspector(); requestRender();
  }));

  pinSec.querySelectorAll(".pdel").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    pushUndo();
    removeFreePin(c, +btn.dataset.i);
    UI.sel = {type:"comp", comp:c};
    UI.refreshInspector(); UI.refreshNets(); requestRender();
  }));

  pinSec.querySelectorAll(".pname").forEach(inp =>
    bindLive(inp, "edit pin name", v => { c.pins[+inp.dataset.i].name = v; }));
  pinSec.querySelectorAll(".pnet").forEach(inp => inp.addEventListener("change", e => {
    const i = +e.target.dataset.i;
    // asks whether to rename the whole net or peel just this pad off, when it shares a net
    applyNetRename({type:"pin", comp:c, pinIdx:i}, e.target.value);
  }));
  pinSec.querySelectorAll("tr[data-i]").forEach(tr => tr.addEventListener("click", e => {
    // ignore clicks on any form control (rebuilding the table would close a <select>)
    if (e.target.closest("input,select,button,option")) return;
    UI.sel = {type:"pin", comp:c, pinIdx:+tr.dataset.i};
    UI.refreshInspector(); requestRender();
  }));
  if (compEditLocked(c)) pinSec.querySelectorAll("input,button").forEach(el => el.disabled = true);
};

UI.inspectNetObj = (title, obj, setNet) => {
  const box = $("#inspector");
  const netName = obj.netId ? (getNet(obj.netId)?.name || "") : "";
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const isViaObj = obj.kind === "via" || obj.kind === "pth";
  sec.innerHTML = `
    <div class="insp-title">${title}</div>
    ${inspRow("Net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-net" value="${escAttr(netName)}" placeholder="net name" style="flex:1;min-width:0"><button id="i-netgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${isViaObj ? inspRow("Type", `<select id="i-kind"><option value="via">Via</option><option value="pth">PTH (plated hole)</option></select>`) : ""}
    ${isViaObj ? inspRow("Size", `<input id="i-vr" type="number" min="2" step="1" value="${obj.r||State.viaR}"> px`) : ""}
    ${isViaObj ? inspRow("Span", `<span style="display:flex;gap:4px;flex:1;min-width:0;align-items:center"><span id="i-vspan" style="flex:1;min-width:0;font-size:11px;color:#aab4c2">${escAttr(viaSpanLabel(obj))}</span><button id="i-vspanedit" title="Set layer span (blind / buried via)">Edit…</button></span>`) : ""}
    <div class="insp-actions"><button id="i-del" class="danger">Delete</button></div>`;
  box.appendChild(sec);
  if (isViaObj){
    sec.querySelector("#i-vspanedit").addEventListener("click", ()=> UI.openViaSpanEditor(obj));
    sec.querySelector("#i-kind").value = obj.kind || "via";
    sec.querySelector("#i-kind").addEventListener("change", e => {
      pushUndo("via type"); obj.kind = e.target.value;
      if (obj.kind === "pth" && obj.r < State.viaR*1.5) obj.r = Math.round(State.viaR*1.8);
      UI.refreshInspector(); requestRender();
    });
    sec.querySelector("#i-vr").addEventListener("change", e => {
      pushUndo("via size"); obj.r = Math.max(2, parseFloat(e.target.value)||State.viaR); requestRender();
    });
  }
  sec.querySelector("#i-netgen").addEventListener("click", ()=>{ sec.querySelector("#i-net").value = uniqueNetName(); sec.querySelector("#i-net").dispatchEvent(new Event("change")); });
  sec.querySelector("#i-net").addEventListener("change", e => {
    applyNetRename({type:"via", via:UI.sel.via}, e.target.value);
  });
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
};

/* blind / buried via editor: pick the top + bottom copper side the via connects.
   Setting the full outer span (front…back) stores nothing, keeping it a through via. */
UI.openViaSpanEditor = (via) => {
  const dlg = $("#viaspan-dialog");
  const sides = availableSides();
  if (sides.length < 3){
    // 2-layer board: a via can only be front↔back, so there's no blind/buried option
    UI.toast("Blind/buried vias need ≥3 copper layers (set a higher layer count).");
    return;
  }
  const optHtml = sides.map(s => `<option value="${s}">${SIDE_LABELS[s] || s}</option>`).join("");
  const fromSel = $("#viaspan-from"), toSel = $("#viaspan-to"), hint = $("#viaspan-hint");
  fromSel.innerHTML = optHtml; toSel.innerHTML = optHtml;
  const sp = viaSpanIdx(via);
  fromSel.value = sides[sp.lo]; toSel.value = sides[sp.hi];
  const order = () => { let lo = sides.indexOf(fromSel.value), hi = sides.indexOf(toSel.value); if (lo > hi){ const t=lo; lo=hi; hi=t; } return [lo, hi]; };
  const updateHint = () => {
    const [lo, hi] = order();
    const through = lo === 0 && hi === sides.length - 1;
    const n = hi - lo + 1;
    hint.textContent = through ? "Through via — connects all copper layers."
      : ((lo > 0 && hi < sides.length - 1) ? "Buried via" : "Blind via") + ` — spans ${n} layer${n>1?"s":""}.`;
  };
  fromSel.onchange = toSel.onchange = updateHint;
  updateHint();
  const apply = (through) => {
    dlg.close();
    pushUndo("via layer span");
    let lo = 0, hi = sides.length - 1;
    if (!through) [lo, hi] = order();
    if (lo === 0 && hi === sides.length - 1){ delete via.from; delete via.to; } // through → store nothing
    else { via.from = sides[lo]; via.to = sides[hi]; }
    UI.refreshInspector(); requestRender();
  };
  $("#viaspan-ok").onclick = () => apply(false);
  $("#viaspan-through").onclick = () => apply(true);
  $("#viaspan-cancel").onclick = () => dlg.close();
  dlg.showModal();
};

UI.inspectTrace = (t) => {
  const box = $("#inspector");
  const netName = t.netId ? (getNet(t.netId)?.name || "") : "";
  const sec = document.createElement("div");
  sec.className = "insp-section";
  sec.innerHTML = `
    <div class="insp-title">Trace <span style="color:${SIDE_COLORS[t.side]};font-size:11px">● ${SIDE_LABELS[t.side]}</span></div>
    ${inspRow("Net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-net" value="${escAttr(netName)}" style="flex:1;min-width:0"><button id="i-netgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${inspRow("Side", `<select id="i-tside">${sideOptionsHtml(t.side)}</select>`)}
    ${inspRow("Width", `<input id="i-w" type="number" step="0.5" min="0.5" value="${(t.width||3).toFixed(1)}"> px`)}
    <div class="insp-actions"><button id="i-selnet">Select whole net</button><button id="i-del" class="danger">Delete</button></div>`;
  box.appendChild(sec);
  sec.querySelector("#i-tside").value = t.side;
  sec.querySelector("#i-netgen").addEventListener("click", ()=>{ sec.querySelector("#i-net").value = uniqueNetName(); sec.querySelector("#i-net").dispatchEvent(new Event("change")); });
  sec.querySelector("#i-selnet").addEventListener("click", ()=>{ if (t.netId) UI.selectNetTraces(t.netId); requestRender(); });
  sec.querySelector("#i-net").addEventListener("change", e => {
    applyNetRename({type:"trace", trace:t}, e.target.value);
  });
  sec.querySelector("#i-tside").addEventListener("change", e => { pushUndo(); t.side = e.target.value; requestRender(); });
  sec.querySelector("#i-w").addEventListener("change", e => { pushUndo(); t.width = Math.max(0.5, parseFloat(e.target.value)||3); requestRender(); });
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
};

function escAttr(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

/* ---------------- footprint dialog moved to fpdialog.js ---------------- */

/* ---------------- export dialog ---------------- */
UI.openExport = () => {
  const dlg = $("#export-dialog");
  if (typeof loadKicadFootprints === "function") loadKicadFootprints(); // ensure the list is available for the check
  const warn = $("#export-warn");
  const update = () => {
    const fmt = $("#export-format").value;
    $("#export-preview").value = netlistFor(fmt).text;
    $("#export-editbom").style.display = (fmt === "bom") ? "" : "none";
    // only KiCad exports carry footprints, so only warn for those formats
    const missing = (fmt === "kicad" || fmt === "sch") ? missingKicadFootprints() : null;
    if (missing && missing.length){
      const shown = missing.slice(0, 25);
      warn.innerHTML = "<b>⚠ " + missing.length + " footprint" + (missing.length>1?"s":"") +
        " not found in the KiCad library list:</b><br>" +
        shown.map(m => escAttr(m.ref) + " → " + escAttr(m.footprint)).join("<br>") +
        (missing.length > shown.length ? "<br>… and " + (missing.length - shown.length) + " more" : "") +
        "<br><span class=\"export-warn-hint\">Fix the KiCad footprint field on these parts, or they will not load in Pcbnew.</span>";
      warn.style.display = "";
    } else {
      warn.style.display = "none";
    }
  };
  $("#export-format").onchange = update;
  update();
  dlg.showModal();
};

/* ---------------- BOM editor ----------------
   Spreadsheet over the grouped BOM. Editing Value/Part/Footprint rewrites every part
   on that row (and may regroup); custom columns store per-part values in component.bom
   and aggregate to a row value (blank when the parts disagree). */
UI.openBomEditor = () => {
  const dlg = $("#bom-dialog");
  if (typeof loadKicadFootprints === "function") loadKicadFootprints(); // for the footprint check
  UI._renderBomTable();
  if (!dlg.open) dlg.showModal();
};

UI._renderBomTable = () => {
  const table = $("#bom-table");
  if (!table) return;
  const wrap = $("#bom-table-wrap");
  const sc = wrap ? wrap.scrollTop : 0;
  const cols = State.bomColumns || [];
  const groups = bomGroups();
  UI._bomGroups = groups;                                 // referenced by the change handlers
  // flag footprints not present in the KiCad library list (same check as the export warning)
  let badFp = 0;
  groups.forEach(g => { g._badFp = !!g.footprint && !kicadFootprintKnown(g.footprint); if (g._badFp) badFp++; });
  $("#bom-count").textContent = "(" + groups.length + " lines · " + State.components.length + " parts" +
    (badFp ? " · ⚠ " + badFp + " footprint" + (badFp>1?"s":"") + " not in KiCad list" : "") + ")";

  let h = "<thead><tr><th class='bom-idx'>#</th><th class='bom-qty'>Qty</th><th>Value</th><th>Part</th><th>Footprint</th><th>References</th>";
  cols.forEach((c, ci) => { h += `<th>${escAttr(c)} <button class="bom-delcol" data-ci="${ci}" title="Remove column">×</button></th>`; });
  h += "</tr></thead><tbody>";
  groups.forEach((g, gi) => {
    const refs = g.refs.join(", ");
    const fpCls = "bom-cell" + (g._badFp ? " bom-badfp" : "");
    const fpTitle = g._badFp ? ' title="Not found in the KiCad footprint library list — fix it or it will not load in Pcbnew"' : "";
    h += `<tr data-gi="${gi}">`
      + `<td class="bom-idx">${gi+1}</td>`
      + `<td class="bom-qty">${g.refs.length}</td>`
      + `<td><input class="bom-cell" data-f="value" value="${escAttr(g.value)}"></td>`
      + `<td><input class="bom-cell" data-f="part" value="${escAttr(g.part)}"></td>`
      + `<td><input class="${fpCls}" data-f="footprint" value="${escAttr(g.footprint)}"${fpTitle}></td>`
      + `<td class="bom-refs" title="${escAttr(refs)}">${escAttr(refs)}</td>`;
    cols.forEach(col => { h += `<td><input class="bom-cell" data-f="col" data-col="${escAttr(col)}" value="${escAttr(bomFieldCommon(g, col))}"></td>`; });
    h += "</tr>";
  });
  h += "</tbody>";
  table.innerHTML = h;
  if (wrap) wrap.scrollTop = sc;

  table.querySelectorAll(".bom-cell").forEach(inp => {
    inp.addEventListener("change", e => {
      const g = UI._bomGroups[+e.target.closest("tr").dataset.gi];
      if (!g) return;
      const f = e.target.dataset.f, val = e.target.value;
      pushUndo("BOM edit");
      if (f === "value")      g.comps.forEach(c => c.value = val.trim());
      else if (f === "part")  g.comps.forEach(c => c.part  = val.trim());
      else if (f === "footprint") g.comps.forEach(c => { c.kicad = val.trim(); c._fp = null; });
      else if (f === "col"){
        const col = e.target.dataset.col;
        g.comps.forEach(c => { (c.bom || (c.bom = {}))[col] = val; });
        UI.refreshInspector();
        return;                                            // custom cols don't change grouping → no rebuild
      }
      UI._renderBomTable();                                // value/part/footprint may merge rows
      UI.refreshInspector(); UI.refreshNets(); requestRender();
    });
  });
  table.querySelectorAll(".bom-delcol").forEach(btn => {
    btn.addEventListener("click", e => {
      const ci = +e.target.dataset.ci, col = State.bomColumns[ci];
      if (!confirm("Remove column “" + col + "”?\n(The values stay on the parts but are no longer shown or exported.)")) return;
      pushUndo("remove BOM column");
      State.bomColumns.splice(ci, 1);
      UI._renderBomTable();
    });
  });
};

UI.addBomColumn = () => {
  const name = (prompt("New column name (e.g. MPN, Supplier, Price, Notes):", "") || "").trim();
  if (!name) return;
  if ((State.bomColumns || []).includes(name)){ UI.toast("Column “" + name + "” already exists"); return; }
  pushUndo("add BOM column");
  (State.bomColumns || (State.bomColumns = [])).push(name);
  UI._renderBomTable();
};

/* ---------------- right-click context menu ---------------- */
UI._ctxDismiss = (e) => { if (!e.target.closest("#ctx-menu")) UI.hideContextMenu(); };
UI.hideContextMenu = () => {
  const m = document.getElementById("ctx-menu");
  if (m) m.remove();
  document.removeEventListener("pointerdown", UI._ctxDismiss, true);
};
UI.showContextMenu = (x, y, items) => {
  UI.hideContextMenu();
  const m = document.createElement("div");
  m.id = "ctx-menu";
  for (const it of items){
    if (it.sep){ const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); continue; }
    const b = document.createElement("div");
    b.className = "ctx-item" + (it.danger ? " danger" : "");
    b.textContent = it.label;
    b.addEventListener("click", () => { UI.hideContextMenu(); it.action(); });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth  - r.width  - 6) + "px";
  m.style.top  = Math.min(y, window.innerHeight - r.height - 6) + "px";
  setTimeout(() => document.addEventListener("pointerdown", UI._ctxDismiss, true), 0);
};

/* ---------------- net name popup ---------------- */
UI.openNetPopup = (title, current, onPick) => {
  const dlg = $("#netname-dialog");
  $("#netname-title").textContent = title || "Net name";
  const inp = $("#netname-input");
  inp.value = current || "";
  // quick-select: protected prefab names + nets already in the project.
  // The first 9 get a number key (1-9) for instant pick.
  const quick = $("#netname-quick");
  quick.innerHTML = "";
  const seen = new Set();
  const quickNames = [];
  const addBtn = (name, prot) => {
    if (seen.has(name)) return; seen.add(name);
    const idx = quickNames.length; quickNames.push(name);
    const b = document.createElement("button");
    b.innerHTML = (idx < 9 ? `<b style="color:var(--accent)">${idx+1}</b> ` : "") + name;
    if (prot) b.className = "prot";
    b.addEventListener("click", ()=> finish(name));
    quick.appendChild(b);
  };
  const finish = (val) => { dlg.close(); document.removeEventListener("keydown", keyPick, true); onPick(val); };
  PROTECTED_NET_NAMES.forEach(n => addBtn(n, true));
  State.nets.filter(n => !n.auto && netMembers(n.id).length).forEach(n => addBtn(n.name, n.protected));

  $("#netname-ok").onclick = () => finish(inp.value.trim());
  $("#netname-clear").onclick = () => finish("");
  $("#netname-cancel").onclick = () => { dlg.close(); document.removeEventListener("keydown", keyPick, true); };
  inp.onkeydown = (e) => { if (e.key === "Enter"){ e.preventDefault(); finish(inp.value.trim()); } };
  // number keys 1-9 pick a quick net. They fire when the field is empty OR its whole
  // value is still selected — which is the just-opened state (we focus+select on open),
  // so the hotkeys work immediately even though the current net name is pre-filled.
  // Once the user starts typing (selection gone) digits type normally into the name.
  const allSelected = () => inp.selectionStart === 0 && inp.selectionEnd === inp.value.length;
  const keyPick = (e) => {
    if (!/^[1-9]$/.test(e.key) || !quickNames[+e.key - 1]) return;
    if (e.target !== inp || inp.value === "" || allSelected()){
      e.preventDefault(); finish(quickNames[+e.key - 1]);
    }
  };
  document.addEventListener("keydown", keyPick, true);
  dlg.addEventListener("close", () => document.removeEventListener("keydown", keyPick, true), { once:true });
  dlg.showModal();
  inp.focus(); inp.select();
};

/* ask whether a rename should touch the whole net or just the one pad/via.
   cb is called with "all", "one", or null (cancelled). */
UI.openNetScopeDialog = (oldName, newName, count, cb) => {
  const dlg = $("#netscope-dialog");
  $("#netscope-msg").innerHTML = `<b>“${escAttr(oldName)}”</b> has ${count} pads/vias/traces on it. What should renaming to <b>“${escAttr(newName)}”</b> affect?`;
  $("#netscope-all").textContent = "Rename all on “" + oldName + "” → “" + newName + "”";
  $("#netscope-one").textContent = "Rename just this one → “" + newName + "” (disconnect from “" + oldName + "”)";
  const pick = (scope) => { dlg.close(); cb(scope); };
  $("#netscope-all").onclick    = () => pick("all");
  $("#netscope-one").onclick    = () => pick("one");
  $("#netscope-cancel").onclick = () => pick(null);
  dlg.showModal();
};

/* ---------------- checker ---------------- */
UI.openChecker = () => {
  const res = runChecker();
  View.checkMarks = res.unnetted.map(u => u.wp);
  requestRender();
  const box = $("#checker-list");
  const issues = [];   // each row → { wp, comp, pinIdx } for the "Go" button to jump to
  const row = (label, issue) => {
    const i = issues.push(issue) - 1;
    return `<div class="hk"><span>${label}</span><button class="chk-go" data-i="${i}" title="Jump to this pad">Go</button></div>`;
  };
  // render one collapsible-looking group box (title + count) wrapping its rows
  const group = (kind, title, count, rowsHtml) =>
    `<div class="chk-group ${kind}">
       <div class="chk-group-head">${title} <span class="chk-count">${count}</span></div>
       <div class="chk-group-body">${rowsHtml}</div>
     </div>`;

  let html = "";
  // ---- group 1: missing pads (pads with no net assigned) ----
  if (res.unnetted.length){
    const rows = res.unnetted.map(u =>
      row(escAttr(u.comp.ref + "." + u.comp.pins[u.pinIdx].num), { wp:u.wp, comp:u.comp, pinIdx:u.pinIdx })).join("");
    html += group("missing", "Missing nets — unassigned pads", res.unnetted.length, rows);
  }
  // ---- group 2: actual issues (pin/trace net mismatches) ----
  if (res.mismatches.length){
    const rows = res.mismatches.map(m => {
      const pinNm = escAttr(m.comp.ref + "." + m.comp.pins[m.pinIdx].num);
      const lbl = `${pinNm}=${escAttr(getNet(m.pinNet)?.name || "?")} ⟂ trace=${escAttr(getNet(m.traceNet)?.name || "?")}`;
      const wp = pinWorldPos(m.comp, compFootprint(m.comp).pins[m.pinIdx]);
      return row(lbl, { wp, comp:m.comp, pinIdx:m.pinIdx });
    }).join("");
    html += group("issues", "Net issues — pin / trace mismatches", res.mismatches.length, rows);
  }
  if (!res.unnetted.length && !res.mismatches.length)
    html += `<div class="panel-hint" style="color:#4fd07f">All pads have nets and no mismatches. 🎉</div>`;
  box.innerHTML = html;
  // "Go" → close the dialog, centre the view on the issue and select that pad
  box.querySelectorAll(".chk-go").forEach(btn => btn.addEventListener("click", ()=>{
    const it = issues[+btn.dataset.i];
    $("#checker-dialog").close();
    UI.select({ type:"pin", comp:it.comp, pinIdx:it.pinIdx });
    View.panX = View.width/2 - it.wp.x*View.zoom*(View.flip?-1:1);
    View.panY = View.height/2 - it.wp.y*View.zoom;
    requestRender();
  }));
  $("#checker-dialog").showModal();
};

/* ---------------- history (selective undo) ---------------- */
UI.openHistory = () => {
  UI.buildHistory();
  $("#history-dialog").showModal();
};

UI.buildHistory = () => {
  const box = $("#history-list");
  box.innerHTML = "";
  if (!Undo.stack.length){
    box.innerHTML = '<div class="panel-hint">No recorded actions yet.</div>';
    return;
  }
  for (let i = Undo.stack.length - 1; i >= 0; i--){
    const e = Undo.stack[i];
    const row = document.createElement("div");
    row.className = "hist-row";
    const t = new Date(e.time||Date.now());
    row.innerHTML = `<span class="hist-time">${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}</span>
      <span class="hist-label">${e.label}</span>
      <button class="hist-undo" data-i="${i}">Undo this</button>`;
    box.appendChild(row);
  }
  box.querySelectorAll(".hist-undo").forEach(btn => btn.addEventListener("click", ()=>{
    if (selectiveUndo(+btn.dataset.i)){
      UI.toast("Action reverted (only the objects it touched)");
      UI.select(null);
      UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
      UI.buildHistory();
      requestRender();
    }
  }));
};

/* ---------------- overlap-after-move dialog ---------------- */
UI.openOverlapDialog = (conflicts) => {
  const box = $("#overlap-list");
  box.innerHTML = conflicts.map(c => `<div class="hk"><span>${c.text}</span></div>`).join("");
  const dlg = $("#overlap-dialog");
  const clearMarks = ()=>{ View.overlapMarks = null; requestRender(); };
  dlg.addEventListener("close", clearMarks, { once:true }); // also covers Esc-dismiss
  $("#overlap-merge").onclick = ()=>{
    dlg.close(); clearMarks();
    pushUndo("merge overlapping nets");
    let merged = 0, blocked = 0;
    for (const c of conflicts){
      const m = mergeNets(c.a, c.b);
      if (m === null) blocked++; else merged++;
    }
    pruneNets();
    UI.toast(merged + " net pair(s) merged" + (blocked ? " — " + blocked + " blocked (both protected)" : ""));
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  };
  $("#overlap-undo").onclick = ()=>{
    dlg.close(); clearMarks();
    if (undo()) afterHistory();
    UI.toast("Move undone");
  };
  $("#overlap-keep").onclick = ()=>{ dlg.close(); clearMarks(); };
  dlg.showModal();
};

/* ---------------- quick edit (double-click a component) ---------------- */
UI.openQuickEdit = (c) => {
  const dlg = $("#quick-dialog");
  $("#quick-title").textContent = c.ref + " — " + compFootprint(c).label;
  const refIn = $("#quick-ref"), valIn = $("#quick-value"), hint = $("#quick-resolve");
  refIn.value = c.ref; valIn.value = c.value;
  const updateHint = ()=>{
    const resolved = autoResolveValue(valIn.value);
    hint.textContent = (resolved !== valIn.value.trim()) ? ("→ " + resolved) : "";
  };
  valIn.oninput = updateHint;
  updateHint();
  $("#quick-ok").onclick = ()=>{
    dlg.close();
    if (compEditLocked(c)){ UI.toast(c.ref + " is edit-locked"); return; }
    pushUndo("quick edit " + c.ref);
    c.value = autoResolveValue(valIn.value); // auto-fill on OK (no apply click)
    UI.refreshInspector(); requestRender();
    if (refIn.value.trim()) UI.commitRename(c, refIn.value); // may prompt on a duplicate ref
  };
  $("#quick-cancel").onclick = ()=> dlg.close();
  [refIn, valIn].forEach(inp => inp.onkeydown = (e)=>{ if (e.key === "Enter"){ e.preventDefault(); $("#quick-ok").click(); } });
  dlg.showModal();
  refIn.select();
};

/* ---------------- hotkey hints / help ---------------- */
/* refresh toolbar tooltips with current bindings */
UI.updateHotkeyHints = () => {
  document.querySelectorAll("#toolbar .tool").forEach(b => {
    const key = Keymap.keyFor("tool." + b.dataset.tool);
    b.title = b.title.replace(/\s*\[[^\]]*\]\s*$/, "") + (key ? "  [" + key + "]" : "");
  });
  const flipKey = Keymap.keyFor("view.flip");
  const fb = $("#btn-flip");
  fb.title = fb.title.replace(/\s*\[[^\]]*\]\s*$/, "") + (flipKey ? "  [" + flipKey + "]" : "");
};

UI.buildHelp = () => {
  const k = (id)=>Keymap.keyFor(id) || "—";
  const HELP = [
    ["Tools (rebindable — ⌨ button)", [
      [k("tool.select"),"Select / move"],[k("tool.component"),"Place component (footprint dialog)"],
      [k("tool.trace"),"Draw trace / connect pins"],[k("tool.via"),"Place via"],
      [k("tool.cut"),"Cut a trace into two nets"],
      [k("tool.align"),"Align image layer"],[k("tool.measure"),"Measure a distance"],
    ]],
    ["View", [
      ["Mouse wheel","Zoom at cursor"],["Space + drag / middle drag","Pan"],
      [k("view.flip"),"Flip view (look from back)"],["Home / " + k("view.fit"),"Zoom to fit"],
      [k("view.mask"),"Coverage mask — tint areas without components"],
      ["1 … 9, 0","Switch view to image layer 1–10 (or toggle visibility — see Board/display panel)"],
      ["Shift + 1…0","Same, for layers 11–20"],
    ]],
    ["Editing", [
      [k("edit.rotate") + " / Shift+" + k("edit.rotate"),"Rotate 90° / 15° (selection or ghost)"],
      [k("edit.side"),"Flip component side front/back"],
      [k("edit.lock"),"Lock / unlock component (blocks move, edit, delete)"],
      [k("edit.delete") + " / Backspace","Delete selection"],["Esc","Cancel current action / deselect"],
      ["Enter","Finish trace"],["Double-click pad/trace","Name its net"],["Double-click via","Set layer span (blind / buried)"],
      [k("edit.drawside"),"Cycle active draw side (F.Cu/B.Cu/inner)"],[k("edit.net"),"Rename net of selection"],
      ["Ctrl+Z / Ctrl+Y","Undo / redo"],["Ctrl+D","Duplicate component"],
    ]],
    ["Project", [
      ["Ctrl+S","Save project (.json incl. images)"],["Ctrl+O","Open project"],["Ctrl+E","Export (netlist / BOM / schematic / CSV / JSON)"],
    ]],
    ["Workflow", [
      ["1.","Drop front & back photos · set the back photo's side to Back + Mirror ⇋"],
      ["2.",k("tool.align")+": drag/2-point-align layers so pads coincide · Calibrate button: set scale from a known dimension · "+k("tool.measure")+": measure a distance"],
      ["3.",k("tool.component")+": place components with footprints, refs and values"],
      ["4.",k("tool.trace")+": click a pad or an existing trace → route along the copper → click the destination (crossing same-side traces auto-join)"],
      ["5.",k("tool.via")+": vias where traces change sides · double-click pads to name power nets"],
      ["6.","Ctrl+E: export the KiCad netlist and import it in Pcbnew"],
    ]],
  ];
  const box = $("#help-body");
  box.innerHTML = HELP.map(([title, rows]) =>
    `<h3>${title}</h3>` + rows.map(([key,d]) =>
      `<div class="hk"><span>${d}</span><kbd>${key}</kbd></div>`).join("")
  ).join("");
};

/* ---------------- hotkey editor ---------------- */
UI.openKeysDialog = () => {
  UI.buildKeysList();
  $("#keys-dialog").showModal();
};

UI.buildKeysList = () => {
  const box = $("#keys-list");
  box.innerHTML = "";
  for (const a of KeyActions){
    const row = document.createElement("div");
    row.className = "hk key-row";
    const key = Keymap.keyFor(a.id);
    row.innerHTML = `<span>${a.label}</span>
      <button class="key-btn" data-id="${a.id}"><kbd>${key || "unbound"}</kbd></button>`;
    box.appendChild(row);
  }
  box.querySelectorAll(".key-btn").forEach(btn => btn.addEventListener("click", () => {
    // capture next key press
    box.querySelectorAll(".key-btn").forEach(b => b.classList.remove("listening"));
    btn.classList.add("listening");
    btn.querySelector("kbd").textContent = "press a key…";
    const capture = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (["Shift","Control","Alt","Meta"].includes(e.key)) return; // wait for a real key
      window.removeEventListener("keydown", capture, true);
      btn.classList.remove("listening");
      if (e.key === "Escape"){ UI.buildKeysList(); return; }
      const key = normKey(e);
      if (e.ctrlKey || e.metaKey || e.altKey || RESERVED_KEYS.includes(key) || /^[0-9]$/.test(key)){
        UI.toast("That key is reserved");
        UI.buildKeysList();
        return;
      }
      const displaced = Keymap.bind(btn.dataset.id, key);
      if (displaced){
        const old = KeyActions.find(x => x.id === displaced);
        UI.toast("“" + key + "” taken from: " + (old ? old.label : displaced) + " (now unbound)");
      }
      UI.buildKeysList();
      UI.updateHotkeyHints();
      UI.buildHelp();
      UI.refreshInspector();
    };
    window.addEventListener("keydown", capture, true);
  }));
};
