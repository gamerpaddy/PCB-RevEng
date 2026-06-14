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

/* show the X-ray overlay toggle only when an X-ray image layer exists */
UI.refreshXrayBtn = () => {
  const btn = $("#btn-xray");
  if (!btn) return;
  const hasXray = State.layers.some(l => l.side === "xray");
  btn.style.display = hasXray ? "" : "none";
  if (!hasXray && View.xray){ View.xray = false; requestRender(); }
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
UI.refreshNets = () => {
  const list = $("#net-list");
  list.innerHTML = "";
  const map = buildNetMap();
  let shown = 0;
  for (const n of State.nets){
    const members = netMembers(n.id);
    if (!members.length) continue;
    shown++;
    const item = document.createElement("div");
    item.className = "net-item" + (UI.activeNetId === n.id ? " active" : "");
    const pinCount = (map.get(n.id) || []).length;
    item.innerHTML = `<input type="color" class="net-color" value="${/^#[0-9a-fA-F]{6}$/.test(n.color)?n.color:"#888888"}" title="Net colour">
      <span class="nname" title="${n.name}${n.protected?" (protected prefab)":""}">${n.protected?"🛡 ":""}${n.name}</span>
      <span class="ncount">${pinCount}p</span>`;
    item.querySelector(".net-color").addEventListener("click", e => e.stopPropagation());
    item.querySelector(".net-color").addEventListener("input", e => {
      pushUndo("net colour"); n.color = e.target.value; requestRender();
    });
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
  $("#net-count").textContent = shown ? "(" + shown + ")" : "";
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
  bindLive(sec.querySelector("#i-ref"), "rename " + c.ref, v => { if (v.trim()){ c.ref = v.trim(); registerRef(c.ref); } });
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
    pushUndo("pin net " + c.ref + "." + c.pins[i].num);
    // island-aware: renames/moves only the copper actually wired to this pin
    if (!assignNetToObject({type:"pin", comp:c, pinIdx:i}, e.target.value)){
      Undo.stack.pop(); // blocked by protection — nothing changed
    }
    UI.refreshNets(); UI.refreshInspector(); requestRender();
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
    <div class="insp-actions"><button id="i-del" class="danger">Delete</button></div>`;
  box.appendChild(sec);
  if (isViaObj){
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
    pushUndo("via net");
    if (!assignNetToObject({type:"via", via:UI.sel.via}, e.target.value)) Undo.stack.pop();
    if (e.target.value.trim()) Tools.lastViaNet = e.target.value.trim(); // remember for next via
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  });
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
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
    pushUndo("trace net");
    if (!assignNetToObject({type:"trace", trace:t}, e.target.value)) Undo.stack.pop();
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  });
  sec.querySelector("#i-tside").addEventListener("change", e => { pushUndo(); t.side = e.target.value; requestRender(); });
  sec.querySelector("#i-w").addEventListener("change", e => { pushUndo(); t.width = Math.max(0.5, parseFloat(e.target.value)||3); requestRender(); });
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
};

function escAttr(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

/* ---------------- footprint dialog ---------------- */
const FPD = { catId: "dip", params: {}, editComp: null, paramCache: {} };

/* remember the last category/params/value/part across opens */
function fpSaveLast(){
  try {
    localStorage.setItem("pcbreveng.fpLast", JSON.stringify({
      catId: FPD.catId, params: FPD.params,
      value: $("#fp-value").value, part: $("#fp-part").value, kicad: $("#fp-kicad").value
    }));
  } catch(e){}
}
function fpLoadLast(){
  try { return JSON.parse(localStorage.getItem("pcbreveng.fpLast") || "null"); } catch(e){ return null; }
}

UI.openFootprintDialog = (editComp) => {
  FPD.editComp = editComp || null;
  const dlg = $("#fp-dialog");
  if (editComp){
    FPD.catId = editComp.fpId;
    FPD.params = {...editComp.fpParams};
    $("#fp-ref").value = editComp.ref;
    $("#fp-value").value = editComp.value;
    $("#fp-part").value = editComp.part;
    $("#fp-kicad").value = editComp.kicad;
    $("#fp-ok").textContent = "Apply to " + editComp.ref;
  } else {
    // restore the last-used category, params and value/part
    const last = fpLoadLast();
    if (last && getFootprintDef(last.catId)){
      FPD.catId = last.catId;
      FPD.params = {...last.params};
      $("#fp-value").value = last.value || "";
      $("#fp-part").value = last.part || "";
      $("#fp-kicad").value = last.kicad || "";
    }
    $("#fp-ref").value = ""; // auto-numbered, increments per placement
    $("#fp-ok").textContent = "Place (click on board)";
  }
  buildFpCats();
  buildFpParams();
  dlg.showModal();
};

function buildFpCats(){
  const box = $("#fp-cats");
  box.innerHTML = "";
  Footprints.catalog.forEach((def, i) => {
    const b = document.createElement("button");
    // quick-select keys: 1–9 first nine, Shift+1–9 next nine, Ctrl+1–9 the rest
    const key = i < 9 ? String(i+1) : i < 18 ? "⇧" + (i-8) : i < 27 ? "^" + (i-17) : "";
    b.innerHTML = (key ? `<kbd class="catkey">${key}</kbd>` : "") + escAttr(def.name);
    b.classList.toggle("active", def.id === FPD.catId);
    b.addEventListener("click", ()=>{ selectFpCat(def.id); });
    box.appendChild(b);
  });
  // keep the selected category visible (e.g. when picked via number-key hotkey)
  box.querySelector("button.active")?.scrollIntoView({ block: "nearest" });
}

/* pick a footprint category by id (shared by click + number-key shortcuts) */
function selectFpCat(id){
  if (!getFootprintDef(id) || id === FPD.catId) return;
  // remember the params of the category we're leaving, restore those of the one we enter
  FPD.paramCache[FPD.catId] = {...FPD.params};
  FPD.catId = id;
  FPD.params = FPD.paramCache[id] ? {...FPD.paramCache[id]} : {};
  buildFpCats(); buildFpParams();
}

/* keyboard category shortcuts while the footprint dialog is open:
   1–9 → first nine, Shift+1–9 → next nine, Ctrl+1–9 → the rest */
function fpDialogKey(e){
  // Enter (from anywhere, including the text fields) = activate the Place / Apply button
  if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey){
    e.preventDefault();
    UI.confirmFootprint();
    return;
  }
  if (e.altKey || e.metaKey) return;
  if (e.ctrlKey && e.shiftKey) return; // reserve combined modifiers
  // don't steal digits the user is typing into ref/value/part/kicad fields
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  // key off the physical digit (e.code), not e.key — with Shift held, e.key is the
  // shifted symbol (!, /, …), which also triggers Firefox's "/" quick-find
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (!m) return;
  const base = e.ctrlKey ? 18 : e.shiftKey ? 9 : 0;
  const def = Footprints.catalog[base + (+m[1] - 1)];
  if (!def) return;
  e.preventDefault(); // note: Ctrl+1–9 is Firefox's tab-switch and may not be suppressible
  selectFpCat(def.id);
}

UI.wireFpSearch = () => {}; // search field removed (it stole the “C” keypress)

function buildFpParams(){
  const def = getFootprintDef(FPD.catId);
  const box = $("#fp-params");
  box.innerHTML = "";
  const read = (prm, inp) => prm.type === "bool" ? inp.checked
                           : prm.type === "int" ? (parseInt(inp.value,10)||prm.def)
                           : inp.value;
  for (const prm of def.params){
    const label = document.createElement("label");
    let inp;
    if (prm.type === "select"){
      label.textContent = prm.label;
      inp = document.createElement("select");
      for (const o of prm.options){
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        inp.appendChild(opt);
      }
      inp.value = FPD.params[prm.key] !== undefined ? FPD.params[prm.key] : prm.def;
    } else if (prm.type === "bool"){
      label.classList.add("fp-check");
      inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = FPD.params[prm.key] !== undefined ? !!FPD.params[prm.key] : !!prm.def;
      label.appendChild(inp);
      label.appendChild(document.createTextNode(" " + prm.label));
    } else {
      label.textContent = prm.label;
      inp = document.createElement("input");
      inp.type = "number"; inp.min = prm.min; inp.max = prm.max; inp.step = prm.step;
      inp.value = FPD.params[prm.key] !== undefined ? FPD.params[prm.key] : prm.def;
    }
    const evt = prm.type === "bool" ? "change" : "input";
    inp.addEventListener(evt, ()=>{ FPD.params[prm.key] = read(prm, inp); drawFpPreview(); });
    if (prm.type !== "bool") label.appendChild(inp);
    box.appendChild(label);
    FPD.params[prm.key] = read(prm, inp);
  }
  // R/C/L chip: spell out the modifier-click → refdes mapping right in the dialog
  if (FPD.catId === "chip2"){
    const note = document.createElement("div");
    note.className = "fp-rcl-note";
    note.innerHTML = "Reference set by how you click the board:" +
      "<span><b>click</b> = R</span><span><kbd>Shift</kbd>+click = C</span><span><kbd>Ctrl</kbd>+click = L</span>";
    box.appendChild(note);
  }
  drawFpPreview();
}

function drawFpPreview(){
  const fp = generateFootprint(FPD.catId, FPD.params);
  const cv = $("#fp-preview"), ctx = cv.getContext("2d");
  ctx.clearRect(0,0,cv.width,cv.height);
  if (!fp) return;
  let ext = Math.max(fp.body.w, fp.body.h)/2;
  for (const p of fp.pins) ext = Math.max(ext, Math.hypot(p.xmm,p.ymm)+Math.max(p.w,p.h));
  const s = Math.min(cv.width, cv.height) / (ext*2.4);
  const cx = cv.width/2, cy = cv.height/2;

  // grid: 1 mm lines (mm mode) or 50 mil lines (mil mode), bolder every 5th
  const mil = UI.unit() === "mil";
  const gridMm = mil ? 50*0.0254 : 1;   // 50 mil ≈ 1.27 mm
  const step = s * gridMm;
  ctx.lineWidth = 1;
  const nx = Math.ceil(cv.width/2/step), ny = Math.ceil(cv.height/2/step);
  for (let i=-Math.max(nx,ny); i<=Math.max(nx,ny); i++){
    const major = (i % 5 === 0);
    ctx.strokeStyle = major ? "#2c3540" : "#1c222b";
    ctx.beginPath(); ctx.moveTo(cx+i*step, 0); ctx.lineTo(cx+i*step, cv.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy+i*step); ctx.lineTo(cv.width, cy+i*step); ctx.stroke();
  }
  // axes
  ctx.strokeStyle = "#3a4654";
  ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,cv.height); ctx.moveTo(0,cy); ctx.lineTo(cv.width,cy); ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  drawFootprintShape(ctx, fp, s, {});
  ctx.restore();
  ctx.fillStyle = "#8b96a5"; ctx.font = "11px Segoe UI";
  ctx.fillText(fp.label + " · " + fp.pins.length + " pins · grid " + (mil ? "50 mil" : "1 mm"), 6, cv.height-6);
  ctx.fillText(mil
    ? (fp.body.w/0.0254).toFixed(0) + "×" + (fp.body.h/0.0254).toFixed(0) + " mil"
    : fp.body.w.toFixed(1) + "×" + fp.body.h.toFixed(1) + " mm", 6, 14);
  $("#fp-kicad").placeholder = fp.kicad || "lib:name";
}

UI.confirmFootprint = () => {
  const fp = generateFootprint(FPD.catId, FPD.params);
  if (!fp) return;
  const vals = {
    fpId: FPD.catId, fpParams: {...fp.params},
    ref: $("#fp-ref").value.trim(),
    value: $("#fp-value").value.trim(),
    part: $("#fp-part").value.trim(),
    kicad: $("#fp-kicad").value.trim() || fp.kicad,
  };
  if (!FPD.editComp) fpSaveLast(); // remember category/params/value for next time
  $("#fp-dialog").close();
  if (FPD.editComp){
    // apply changes to existing component
    pushUndo();
    const c = FPD.editComp;
    c.fpId = vals.fpId; c.fpParams = vals.fpParams; c._fp = null;
    if (vals.ref) { c.ref = vals.ref; registerRef(c.ref); }
    c.value = vals.value; c.part = vals.part; c.kicad = vals.kicad;
    // rebuild pin states, keep nets by pin number where possible
    const old = c.pins;
    const nfp = compFootprint(c);
    c.pins = nfp.pins.map(fpin => {
      const prev = old.find(p => p.num === fpin.num);
      return { num: fpin.num, name: prev?prev.name:(fpin.name||""), netId: prev?prev.netId:null };
    });
    pruneNets();
    UI.select({type:"comp", comp:c});
    UI.refreshNets(); requestRender();
  } else {
    Tools.pending = vals;
    Tools.ghostFp = fp;
    Tools.ghostSide = UI.copperSide() === "back" ? "back" : "front";
    setTool("component");
    if (vals.fpId === "chip2")
      UI.setHint("Place " + fp.label + " — click = R · Shift-click = C · Ctrl-click = L · R rotate, B flip side, Esc cancel");
    else
      UI.setHint("Click on the board to place " + fp.label + " — R rotate, B flip side, Esc cancel");
  }
  // clear for next time
  $("#fp-ref").value = ""; $("#fp-value").value = ""; $("#fp-part").value = ""; $("#fp-kicad").value = "";
  FPD.editComp = null;
};

/* ---------------- export dialog ---------------- */
UI.openExport = () => {
  const dlg = $("#export-dialog");
  const update = () => { $("#export-preview").value = netlistFor($("#export-format").value).text; };
  $("#export-format").onchange = update;
  update();
  dlg.showModal();
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
  // number keys 1-9 pick a quick net even while the input is focused
  const keyPick = (e) => {
    if (e.target === inp && inp.value !== "" && !/^[1-9]$/.test(inp.value)) {
      // allow typing digits into a name only if the field already has non-digit content
    }
    if (/^[1-9]$/.test(e.key) && quickNames[+e.key - 1] && (e.target !== inp || inp.value === "")){
      e.preventDefault(); finish(quickNames[+e.key - 1]);
    }
  };
  document.addEventListener("keydown", keyPick, true);
  dlg.addEventListener("close", () => document.removeEventListener("keydown", keyPick, true), { once:true });
  dlg.showModal();
  inp.focus(); inp.select();
};

/* ---------------- checker ---------------- */
UI.openChecker = () => {
  const res = runChecker();
  View.checkMarks = res.unnetted.map(u => u.wp);
  requestRender();
  const box = $("#checker-list");
  let html = "";
  html += `<div class="hk"><span><b>${res.unnetted.length}</b> pad(s) with no net</span>` +
          (res.unnetted.length ? `<button id="chk-zoom">Show on board</button>` : "") + `</div>`;
  if (res.mismatches.length){
    html += `<div style="margin-top:8px;color:#ffb648">${res.mismatches.length} pin/trace net mismatch(es):</div>`;
    res.mismatches.forEach((m,idx) => {
      const pinNm = m.comp.ref + "." + m.comp.pins[m.pinIdx].num;
      html += `<div class="hk"><span>${pinNm}=${getNet(m.pinNet)?.name} ⟂ trace=${getNet(m.traceNet)?.name}</span>
        <span style="display:flex;gap:4px">
          <button class="chk-fix" data-i="${idx}" data-dir="pin">pin→trace</button>
          <button class="chk-fix" data-i="${idx}" data-dir="trace">trace→pin</button>
        </span></div>`;
    });
  }
  if (!res.unnetted.length && !res.mismatches.length)
    html += `<div class="panel-hint" style="color:#4fd07f">All pads have nets and no mismatches. 🎉</div>`;
  box.innerHTML = html;
  const zoom = $("#chk-zoom");
  if (zoom) zoom.addEventListener("click", ()=>{
    if (!res.unnetted.length) return;
    const u = res.unnetted[0];
    View.panX = View.width/2 - u.wp.x*View.zoom*(View.flip?-1:1);
    View.panY = View.height/2 - u.wp.y*View.zoom;
    requestRender();
  });
  box.querySelectorAll(".chk-fix").forEach(btn => btn.addEventListener("click", ()=>{
    const m = res.mismatches[+btn.dataset.i];
    pushUndo("reconcile net");
    if (btn.dataset.dir === "pin"){
      // pin adopts the trace's net
      m.comp.pins[m.pinIdx].netId = m.traceNet;
    } else {
      // trace (and its net) adopt the pin's net name
      const mres = mergeNets(m.pinNet, m.traceNet);
      if (mres === null) UI.toast("Both nets protected — not merged");
    }
    pruneNets();
    UI.refreshNets(); requestRender();
    UI.openChecker(); // refresh
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
    if (refIn.value.trim()){ c.ref = refIn.value.trim(); registerRef(c.ref); }
    c.value = autoResolveValue(valIn.value); // auto-fill on OK (no apply click)
    UI.refreshInspector(); requestRender();
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
      ["Enter","Finish trace"],["Double-click pad/via/trace","Name its net"],
      [k("edit.drawside"),"Cycle active draw side (F.Cu/B.Cu/inner)"],[k("edit.net"),"Rename net of selection"],
      ["Ctrl+Z / Ctrl+Y","Undo / redo"],["Ctrl+D","Duplicate component"],
    ]],
    ["Project", [
      ["Ctrl+S","Save project (.json incl. images)"],["Ctrl+O","Open project"],["Ctrl+E","Export netlist (KiCad/CSV/JSON)"],
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
