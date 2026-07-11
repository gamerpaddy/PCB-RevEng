/* ===== ui/inspector.js — component/via/trace/note inspectors ===== */
"use strict";

/* ---------------- inspector ---------------- */
UI.refreshInspector = () => {
  const box = $("#inspector");
  const sel = UI.sel;
  box.innerHTML = "";
  if (UI.pinSel.length){ UI.inspectMultiPins(); return; }
  if (UI.traceSel.length){ UI.inspectMultiTraces(); return; }
  if (UI.boxSel && UI.boxSel.length){ UI.inspectBoxSel(); return; }
  if (!sel){
    // via tool active → show the retained defaults for newly placed vias (size + drill)
    if (typeof Tools !== "undefined" && Tools.name === "via"){ UI.inspectViaTool(); return; }
    // trace tool active → show placement mode (free vs 45° angle snap)
    if (typeof Tools !== "undefined" && Tools.name === "trace"){ UI.inspectTraceTool(); return; }
    const k = (id)=>Keymap.keyFor(id) || "—";
    box.innerHTML = '<div class="panel-hint">Nothing selected.<br><br>Tips:<br>· ' +
      k("tool.select") + ' select · ' + k("tool.component") + ' component · ' + k("tool.trace") + ' trace · ' + k("tool.via") + ' via<br>' +
      '· Double-click a pad to name its net<br>· ' + k("edit.lock") + ' locks a component<br>· Press ? for all hotkeys</div>';
    return;
  }

  if (sel.type === "comp" || sel.type === "pin"){
    UI.inspectComponent(sel.comp, sel.type === "pin" ? sel.pinIdx : -1);
  } else if (sel.type === "via"){
    UI.inspectNetObj(sel.via.kind === "pth" ? "PTH" : "Via", sel.via);
  } else if (sel.type === "trace"){
    UI.inspectTrace(sel.trace);
  } else if (sel.type === "note"){
    UI.inspectNote(sel.note);
  }
};

function inspRow(label, inputHtml){
  return `<div class="insp-row"><label>${label}</label>${inputHtml}</div>`;
}

/* marquee (box) selection panel: object counts + a mass Delete */
UI.inspectBoxSel = () => {
  const box = $("#inspector");
  const n = { comp:0, via:0, trace:0, note:0 };
  for (const s of UI.boxSel) n[s.type]++;
  const parts = [];
  if (n.comp)  parts.push(n.comp + " component" + (n.comp===1?"":"s"));
  if (n.via)   parts.push(n.via + " via" + (n.via===1?"":"s"));
  if (n.trace) parts.push(n.trace + " trace" + (n.trace===1?"":"s"));
  if (n.note)  parts.push(n.note + " note" + (n.note===1?"":"s"));
  const sec = document.createElement("div");
  sec.className = "insp-sec";
  sec.innerHTML = `<div class="insp-title">Box selection (${UI.boxSel.length})</div>
    <div class="panel-hint">${parts.join(" · ") || "nothing"}</div>
    <div class="insp-actions"><button id="i-box-del" class="danger">Delete all</button></div>`;
  box.appendChild(sec);
  sec.querySelector("#i-box-del").addEventListener("click", () => deleteBoxSelection());
};

/* shift-click multi-pin panel: one net field for all selected pins */
UI.inspectMultiPins = () => {
  const box = $("#inspector");
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const list = UI.pinSel.map(p => p.comp.ref + "." + p.comp.pins[p.pinIdx].num).join(", ");
  sec.innerHTML = `
    <div class="insp-title">${UI.pinSel.length} pins selected</div>
    <div class="panel-hint" style="word-break:break-all">${list}</div>
    ${inspRow("Net", `<input id="i-multinet" class="net-ac" placeholder="net for ALL selected pins">`)}
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
    let applied = 0, skipped = 0;
    for (const p of UI.pinSel){
      const pin = p.comp.pins[p.pinIdx];
      if (pin.nc){ skipped++; continue; }                 // NC pins carry no net — leave them untouched
      pin.netId = target.id; applied++;
    }
    pruneNets();
    UI.toast(applied + " pins → " + target.name + (skipped ? " (" + skipped + " NC skipped)" : ""));
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
  // common width across the selection (blank if they differ, so a value isn't implied)
  const widths = [...new Set(UI.traceSel.map(t => t.width || 3))];
  const wUniform = widths.length === 1;
  sec.innerHTML = `
    <div class="insp-title">${UI.traceSel.length} trace segments</div>
    <div class="panel-hint">Net: ${netLabel}</div>
    ${inspRow("Set net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-tsnet" class="net-ac" placeholder="net for all" style="flex:1;min-width:0"><button id="i-tsgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${inspRow("Width", UI.traceWidthInputs(widths[0]||3, "i-tsw", wUniform))}
    ${wUniform ? UI.traceCurrentRow(UI.traceSel[0]) : ""}
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
  const applyAllW = (px) => {
    if (!(px > 0)) return;
    pushUndo("trace width"); for (const t of UI.traceSel) t.width = Math.max(0.05, px);
    UI.refreshInspector(); requestRender();
  };
  sec.querySelector("#i-tswmm").addEventListener("change",  e => applyAllW((parseFloat(e.target.value)||0) * State.pxPerMm));
  sec.querySelector("#i-tswmil").addEventListener("change", e => applyAllW((parseFloat(e.target.value)||0) * MM_PER_MIL * State.pxPerMm));
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

/* the Ω value resolver (SMD codes / colour bands → ohms) only makes sense for resistors;
   a designator starting R / RN / RP indicates one. Other parts get a plain value field. */
function isResistorRef(ref){
  const m = /^([A-Za-z]+)/.exec((ref||"").trim());
  const p = m ? m[1].toUpperCase() : "";
  return p === "R" || p === "RN" || p === "RP";
}

UI.inspectComponent = (c, selPin) => {
  const box = $("#inspector");
  const fp = compFootprint(c);
  const isR = isResistorRef(c.ref);
  // "Schematic sym" picker: Auto (shows what auto-detect resolves to) · every symbol whose
  // terminal count matches this part's pin count · Box/IC. Drives the KiCad schematic export.
  const symCur = c.symOverride || "auto";
  const symAuto = _autoSymKind(c);
  const symOpts = [`<option value="auto"${symCur==="auto"?" selected":""}>Auto (${symAuto?SYM_LABELS[symAuto]:"box / IC"})</option>`]
    .concat(symKindsForPinCount(c.pins.length).map(k =>
      `<option value="${k}"${symCur===k?" selected":""}>${SYM_LABELS[k]}</option>`))
    .concat(`<option value="box"${symCur==="box"?" selected":""}>Box / IC (generic)</option>`)
    .join("");
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
    ${inspRow("Value", isR
      ? `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-val" value="${escAttr(c.value)}" style="flex:1;min-width:0"><button id="i-resolve" title="Value resolver — SMD codes &amp; color bands" style="padding:1px 7px">Ω</button></span>`
      : `<input id="i-val" value="${escAttr(c.value)}">`)}
    ${inspRow("Part name", `<input id="i-part" value="${escAttr(c.part)}">`)}
    ${inspRow("KiCad fp", `<input id="i-kicad" value="${escAttr(c.kicad)}" placeholder="lib:footprint">`)}
    ${inspRow("Schematic sym", `<select id="i-sym" title="Symbol used in the KiCad schematic export. Picking a type also fills in its standard pin names.">${symOpts}</select>`)}
    ${inspRow("Side", `<select id="i-side"><option value="front">Front</option><option value="back">Back</option></select>`)}
    ${inspRow("Rotation", `<input id="i-rot" type="number" step="any" value="${c.rot.toFixed(1)}"> °`)}
    ${inspRow("Scale ×", `<input id="i-scale" type="number" step="0.05" min="0.1" value="${(c.scale||1).toFixed(2)}">`)}
    ${c.fpId==="pad1" ? inspRow("Pad type", `<label style="display:flex;align-items:center;gap:6px;width:auto;color:#aab4c2;font-size:11px"><input type="checkbox" id="i-tp-tht" ${c.fpParams.tht?"checked":""}>Through-hole (drilled)</label>`) : ""}
    ${c.fpId==="pad1" ? inspRow("Pad Ø", `<span style="display:flex;gap:4px;flex:1;min-width:0;align-items:center"><input id="i-tp-dia" type="number" step="0.1" min="0.3" value="${(parseFloat(c.fpParams.dia)||1.5).toFixed(2)}" style="flex:1;min-width:0"><span style="color:#8b96a5;font-size:10px">mm</span></span>`) : ""}
    ${c.fpId==="pad1" && c.fpParams.tht ? inspRow("Hole Ø", `<span style="display:flex;gap:4px;flex:1;min-width:0;align-items:center"><input id="i-tp-hole" type="number" step="0.1" min="0.1" max="${(parseFloat(c.fpParams.dia)||1.5).toFixed(2)}" value="${(parseFloat(c.fpParams.hole)||0.8).toFixed(2)}" style="flex:1;min-width:0"><span style="color:#8b96a5;font-size:10px">mm</span></span>`) : ""}
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
  // on blur/enter, auto-resolve SMD codes (220R etc. stay literal) — resistors only, so a
  // capacitor code like "104" isn't misread as ohms; no apply click needed
  if (isR) sec.querySelector("#i-val").addEventListener("change", e => {
    const resolved = autoResolveValue(e.target.value);
    if (resolved !== e.target.value){ c.value = resolved; e.target.value = resolved; UI.refreshNets(); requestRender(); }
  });
  const resolveBtn = sec.querySelector("#i-resolve");
  if (resolveBtn) resolveBtn.addEventListener("click", ()=>{
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
  sec.querySelector("#i-sym").addEventListener("change", e => {
    const v = e.target.value;
    pushUndo("symbol type " + c.ref);
    const prevKind = _symKind(c);            // resolved symbol BEFORE the switch
    c.symOverride = (v === "auto") ? null : v;
    if (v === "box"){
      // generic box has no canonical pin names → drop the ones a concrete symbol
      // auto-filled (BCE / GDS / …) so they don't linger as wrong labels
      clearAutoSymNames(c, prevKind);
    } else {
      // auto-fill this symbol's standard pin NAMES (by pin number; a SOT-223-style tab pad
      // inherits the collector/drain name) — nets are untouched
      applySymPinNames(c, v);
    }
    UI.refreshInspector(); UI.refreshNets(); requestRender();
  });
  sec.querySelector("#i-side").addEventListener("change", e => commit(()=>{ c.side = e.target.value; }));
  sec.querySelector("#i-rot").addEventListener("change", e => commit(()=>{ c.rot = parseFloat(e.target.value)||0; }));
  sec.querySelector("#i-scale").addEventListener("change", e => commit(()=>{ c.scale = Math.max(0.1, parseFloat(e.target.value)||1); }));
  // single-pad / test-point geometry: SMD vs THT, pad Ø, and (THT only) hole Ø ≤ pad Ø
  const tpTht = sec.querySelector("#i-tp-tht");
  if (tpTht) tpTht.addEventListener("change", e => {
    pushUndo("pad type"); c.fpParams = {...c.fpParams, tht:e.target.checked}; c._fp = null;
    UI.refreshInspector(); UI.refreshNets(); requestRender();
  });
  const tpDia = sec.querySelector("#i-tp-dia");
  if (tpDia) tpDia.addEventListener("change", e => {
    let d = parseFloat(e.target.value); if (!(d > 0)) d = 1.5;
    const np = {...c.fpParams, dia:d};
    if (np.hole != null && parseFloat(np.hole) > d) np.hole = d;   // keep hole within the pad
    // dia is authoritative for a single pad — drop any absolute pad-size override (e.g. from a
    // prior drag-resize) so the new diameter actually takes effect, not just the body outline
    if (np.padOv){
      np.padOv = {...np.padOv};
      for (const k of Object.keys(np.padOv)){
        const o = {...np.padOv[k]}; delete o.w; delete o.h;
        if (Object.keys(o).length) np.padOv[k] = o; else delete np.padOv[k];
      }
      if (!Object.keys(np.padOv).length) delete np.padOv;
    }
    pushUndo("pad size"); c.fpParams = np; c._fp = null; UI.refreshInspector(); requestRender();
  });
  const tpHole = sec.querySelector("#i-tp-hole");
  if (tpHole) tpHole.addEventListener("change", e => {
    let hv = parseFloat(e.target.value); if (!(hv > 0)) hv = 0.1;
    const d = parseFloat(c.fpParams.dia) || 1.5; if (hv > d) hv = d;   // clamp: hole ≤ pad
    pushUndo("hole size"); c.fpParams = {...c.fpParams, hole:hv}; c._fp = null;
    UI.refreshInspector(); requestRender();
  });
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
  // Big footprints (BGAs with thousands of pads) would render thousands of native
  // <select>/<input> controls — the browser's layout/paint of those can hang for many
  // seconds. Only render a window of rows (centred on the selected pad); edit the rest
  // by clicking a pad on the board, which selects it and re-centres this window.
  const PIN_CAP = 300;
  const total = c.pins.length;
  const truncated = total > PIN_CAP;
  let lo = 0, hi = total;
  if (truncated){
    lo = selPin >= 0 ? Math.max(0, Math.min(selPin - (PIN_CAP >> 1), total - PIN_CAP)) : 0;
    hi = Math.min(lo + PIN_CAP, total);
  }
  let rows = "";
  for (let i=lo;i<hi;i++){
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
      <td><input class="pnet net-ac" data-i="${i}" value="${escAttr(netName)}" placeholder="net" ${p.nc?"disabled":""}></td>
      <td style="width:24px;text-align:center" title="No-connect (excluded from checker)"><input type="checkbox" class="pnc" data-i="${i}" ${p.nc?"checked":""}></td>
      ${padCells}</tr>`;
  }
  const truncNote = truncated
    ? `<div style="color:#c8922e;font-weight:400;font-size:10px;padding:2px 0">Showing pads ${lo+1}–${hi} of ${total}. Click a pad on the board to jump to &amp; edit it (large footprints aren’t fully listed, for performance).</div>`
    : "";
  pinSec.innerHTML = `<div class="insp-title" style="font-size:12px">Pins (${c.pins.length})
    <span style="color:#8b96a5;font-weight:400;font-size:10px">— net · NC = no-connect${isFree?" · pad type/size":""}</span></div>${truncNote}
    <table class="pin-table"><tr><th>#</th><th>Name</th><th>Net</th><th>NC</th>${isFree?"<th>Pad</th><th>mm</th><th></th>":""}</tr>${rows}</table>`;
  box.appendChild(pinSec);

  if (isFree){
    pinSec.querySelectorAll(".pshape").forEach(sel => sel.addEventListener("change", e => {
      const i = +e.target.dataset.i;
      pushUndo("pad type");
      const pl = ensureFreePin(c, i); pl.shape = e.target.value; delete pl.w; delete pl.h; // square from now on
      pl.tht = pl.shape === "circle";   // THT round pad gets a drill hole; SMD (rect) has none
      c._fp = null;
      UI.refreshInspector(); requestRender();
    }));
    pinSec.querySelectorAll(".psize").forEach(inp => inp.addEventListener("change", e => {
      const i = +e.target.dataset.i;
      pushUndo("pad size");
      const pl = ensureFreePin(c, i);
      pl.size = Math.max(0.2, parseFloat(e.target.value)||1.0); delete pl.w; delete pl.h; // manual size overrides imported w/h
      c._fp = null;
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

/* Via tool defaults panel (shown when the via tool is active and nothing is selected).
   Edits the retained board-wide defaults State.viaR (size) and State.viaHole (drill), both
   stored as world-px RADII; every newly placed via inherits them (PTH scales them ×1.8). */
UI.inspectViaTool = () => {
  const box = $("#inspector");
  const sec = document.createElement("div");
  sec.className = "insp-section";
  sec.innerHTML = `
    <div class="insp-title">Via tool</div>
    ${inspRow("Net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-dvnet" class="net-ac" value="${escAttr(Tools.lastViaNet || "")}" placeholder="(inherit / none)" style="flex:1;min-width:0"><button id="i-dvnetgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${inspRow("Size Ø", UI.viaSizeInputs(State.viaR, "i-dvr-"))}
    ${inspRow("Drill Ø", UI.viaSizeInputs(State.viaHole, "i-dvh-"))}
    <div class="panel-hint">Net is assigned to new vias (unless one snaps onto a conductor). Alt-click = PTH · Shift-click = free (no net). Values are retained.</div>`;
  box.appendChild(sec);
  const applyNet = (name) => { Tools.lastViaNet = name.trim() || null; };
  const netEl = sec.querySelector("#i-dvnet");
  netEl.addEventListener("change", e => applyNet(e.target.value));
  sec.querySelector("#i-dvnetgen").addEventListener("click", () => { const n = uniqueNetName(); netEl.value = n; applyNet(n); });
  const applySize = (mm) => { if (!(mm > 0)) return; pushUndo("via size"); State.viaR = Math.max(1, mm*State.pxPerMm/2); UI.refreshInspector(); requestRender(); };
  const applyDrill = (mm) => { if (!(mm > 0)) return; pushUndo("via drill"); State.viaHole = Math.max(0.5, mm*State.pxPerMm/2); UI.refreshInspector(); requestRender(); };
  sec.querySelector("#i-dvr-mm").addEventListener("change",  e => applySize(parseFloat(e.target.value)||0));
  sec.querySelector("#i-dvr-mil").addEventListener("change", e => applySize((parseFloat(e.target.value)||0) * MM_PER_MIL));
  sec.querySelector("#i-dvh-mm").addEventListener("change",  e => applyDrill(parseFloat(e.target.value)||0));
  sec.querySelector("#i-dvh-mil").addEventListener("change", e => applyDrill((parseFloat(e.target.value)||0) * MM_PER_MIL));
};

/* Trace-tool defaults panel (shown by refreshInspector when the trace tool is active and
   nothing is selected): choose free placement or constrain new segments to 45° increments.
   The choice rides on Tools.angleSnap and is remembered in localStorage. */
UI.inspectTraceTool = () => {
  const box = $("#inspector");
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const on = !!Tools.angleSnap;
  // while drawing, the width row edits THIS trace's live width (Tools.traceWidth);
  // otherwise it edits State.traceW, the default applied to new traces
  const drawing = !!Tools.tracePts;
  const wPx = drawing ? (Tools.traceWidth || State.traceW) : State.traceW;
  sec.innerHTML = `
    <div class="insp-title">Trace tool</div>
    ${inspRow(drawing ? "Width (drawing)" : "New-trace width", UI.traceWidthInputs(wPx, "i-tw"))}
    ${inspRow("Placement", `<select id="i-tanglesnap">
       <option value="free">Free (any angle)</option>
       <option value="snap">Snap to 45°</option>
     </select>`)}
    <div class="panel-hint">Shift+W opens a quick width picker (works mid-route too). Angle snap constrains each new segment to 45° steps from the previous point. Pads/vias still snap normally.</div>`;
  box.appendChild(sec);
  const applyW = (px) => { UI.setTraceWidth(px); UI.refreshInspector(); requestRender(); };
  sec.querySelector("#i-twmm").addEventListener("change",  e => applyW((parseFloat(e.target.value)||0) * State.pxPerMm));
  sec.querySelector("#i-twmil").addEventListener("change", e => applyW((parseFloat(e.target.value)||0) * MM_PER_MIL * State.pxPerMm));
  const selEl = sec.querySelector("#i-tanglesnap");
  selEl.value = on ? "snap" : "free";
  selEl.addEventListener("change", e => {
    Tools.angleSnap = e.target.value === "snap";
    localStorage.setItem("pcbreveng.traceAngleSnap", Tools.angleSnap ? "on" : "off");
    requestRender();
  });
};

UI.inspectNetObj = (title, obj) => {
  const box = $("#inspector");
  const netName = obj.netId ? (getNet(obj.netId)?.name || "") : "";
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const isViaObj = obj.kind === "via" || obj.kind === "pth";
  sec.innerHTML = `
    <div class="insp-title">${title}</div>
    ${inspRow("Net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-net" class="net-ac" value="${escAttr(netName)}" placeholder="net name" style="flex:1;min-width:0"><button id="i-netgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${isViaObj ? inspRow("Type", `<select id="i-kind"><option value="via">Via</option><option value="pth">PTH (plated hole)</option></select>`) : ""}
    ${isViaObj ? inspRow("Size Ø", UI.viaSizeInputs(obj.r||State.viaR, "i-vr-")) : ""}
    ${isViaObj ? inspRow("Drill Ø", UI.viaSizeInputs(obj.hole != null ? obj.hole : State.viaHole, "i-vh-")) : ""}
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
    const applyVr = (mm) => { if (!(mm > 0)) return; pushUndo("via size"); obj.r = Math.max(1, mm*State.pxPerMm/2); UI.refreshInspector(); requestRender(); };
    sec.querySelector("#i-vr-mm").addEventListener("change",  e => applyVr(parseFloat(e.target.value)||0));
    sec.querySelector("#i-vr-mil").addEventListener("change", e => applyVr((parseFloat(e.target.value)||0) * MM_PER_MIL));
    const applyVh = (mm) => { if (!(mm > 0)) return; pushUndo("via drill"); obj.hole = Math.max(0.5, mm*State.pxPerMm/2); UI.refreshInspector(); requestRender(); };
    sec.querySelector("#i-vh-mm").addEventListener("change",  e => applyVh(parseFloat(e.target.value)||0));
    sec.querySelector("#i-vh-mil").addEventListener("change", e => applyVh((parseFloat(e.target.value)||0) * MM_PER_MIL));
  }
  sec.querySelector("#i-netgen").addEventListener("click", ()=>{ sec.querySelector("#i-net").value = uniqueNetName(); sec.querySelector("#i-net").dispatchEvent(new Event("change")); });
  sec.querySelector("#i-net").addEventListener("change", e => {
    applyNetRename({type:"via", via:obj}, e.target.value);
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

/* total polyline length of a trace, in mm (uses the board scale) */
UI.traceLengthMm = (t) => {
  let px = 0;
  const p = t.points || [];
  for (let i = 1; i < p.length; i++) px += Math.hypot(p[i].x - p[i-1].x, p[i].y - p[i-1].y);
  return px / State.pxPerMm;
};

/* trace DC resistance in milliohms: ρ·L/(w·t), ρ_Cu ≈ 1.72e-8 Ω·m at ~25 °C */
const RHO_CU = 1.72e-8;
function traceResistanceMilliOhm(lenMm, widthMm, thickMm){
  const area = (widthMm/1000) * (thickMm/1000);   // m²
  if (!(area > 0)) return 0;
  return RHO_CU * (lenMm/1000) / area * 1000;      // Ω → mΩ
}

/* Electrical readout for a trace. Ampacity (IPC-2221) depends on cross-section only,
   but resistance and voltage drop scale with LENGTH and WIDTH — so both are shown and
   both update when you edit the trace's width, its length, or the board copper weight. */
UI.traceCurrentRow = (t, opts) => {
  opts = opts || {};
  const widthMm = (t.width || 3) / State.pxPerMm;
  const internal = t.side !== "front" && t.side !== "back";
  const oz = internal ? (State.copperOzInner || 0.5) : (State.copperOz || 1);
  const thickMm = oz * OZ_TO_MM;
  const amps = estimateTraceAmps(widthMm, thickMm, internal, 10);
  const aTxt = amps >= 10 ? amps.toFixed(1) : amps.toFixed(2);
  const layerTxt = internal ? "internal" : "external";
  let html = inspRow("Est. current", `<span style="flex:1;min-width:0;color:#aab4c2;font-size:11px" title="IPC-2221 max current for a 10 °C rise. Depends on cross-section (width × copper thickness), not length. Physical width = display width ÷ board scale — calibrate the board for accuracy; set outer/inner copper weight in Options.">~${aTxt} A <span style="color:#6b7684">· ${fmtLen(widthMm)} · ${oz} oz · ${layerTxt} · ΔT 10°C</span></span>`);
  if (opts.showLength){
    const lenMm = UI.traceLengthMm(t);
    const R = traceResistanceMilliOhm(lenMm, widthMm, thickMm);
    const rTxt = R >= 1 ? R.toFixed(1) + " mΩ" : (R*1000).toFixed(0) + " µΩ";
    const vDrop = amps * R / 1000; // V at the estimated max current
    html += inspRow("Length · R", `<span style="flex:1;min-width:0;color:#aab4c2;font-size:11px" title="DC resistance R = ρ·L/(w·t) with ρ_Cu = 1.72e-8 Ω·m. Voltage drop is at the estimated max current above.">${fmtLen(lenMm)} · ${rTxt} <span style="color:#6b7684">· ${vDrop.toFixed(2)} V @ ${aTxt} A</span></span>`);
  }
  return html;
};

/* estimated current a bare copper strip of this width (mm) would carry on the ACTIVE
   copper side — used by the Measure tool so measuring a trace's width reads out its
   ampacity, using the same IPC-2221 model and copper weights as the trace inspector. */
UI.widthCurrentEst = (widthMm) => {
  const side = (typeof effDrawSide === "function") ? effDrawSide()
             : (UI.drawSide ? UI.drawSide() : "front");
  const internal = side !== "front" && side !== "back";
  const oz = internal ? (State.copperOzInner || 0.5) : (State.copperOz || 1);
  const amps = estimateTraceAmps(widthMm, oz * OZ_TO_MM, internal, 10);
  const aTxt = amps >= 10 ? amps.toFixed(1) : amps.toFixed(2);
  return { amps, aTxt, oz, internal, side };
};

/* trace width as side-by-side mm + mil inputs (stored internally as display px).
   ids: mm = idBase+"mm", mil = idBase+"mil" */
UI.traceWidthInputs = (widthPx, idBase, uniform) => {
  uniform = uniform !== false;
  const mm = widthPx / State.pxPerMm;
  const mil = mm / MM_PER_MIL;
  const mmV  = uniform ? mm.toFixed(3)  : "";
  const milV = uniform ? mil.toFixed(1) : "";
  const ph = uniform ? "" : "mixed";
  return `<span style="display:flex;gap:4px;flex:1;min-width:0;align-items:center">
    <input id="${idBase}mm" type="number" step="0.05" min="0.05" value="${mmV}" placeholder="${ph}" style="flex:1;min-width:0;width:0" title="Trace width in millimetres">
    <span style="color:#8b96a5;font-size:10px">mm</span>
    <input id="${idBase}mil" type="number" step="1" min="0.5" value="${milV}" placeholder="${ph}" style="flex:1;min-width:0;width:0" title="Trace width in mils (thou)">
    <span style="color:#8b96a5;font-size:10px">mil</span></span>`;
};

/* via/PTH size as side-by-side mm + mil DIAMETER inputs (stored internally as a px radius).
   ids: mm = idBase+"mm", mil = idBase+"mil" */
UI.viaSizeInputs = (rPx, idBase) => {
  const mm = (rPx * 2) / State.pxPerMm;      // diameter
  const mil = mm / MM_PER_MIL;
  return `<span style="display:flex;gap:4px;flex:1;min-width:0;align-items:center">
    <input id="${idBase}mm" type="number" step="0.05" min="0.1" value="${mm.toFixed(3)}" style="flex:1;min-width:0;width:0" title="Via diameter in millimetres">
    <span style="color:#8b96a5;font-size:10px">mm</span>
    <input id="${idBase}mil" type="number" step="1" min="1" value="${mil.toFixed(1)}" style="flex:1;min-width:0;width:0" title="Via diameter in mils (thou)">
    <span style="color:#8b96a5;font-size:10px">mil</span></span>`;
};

UI.inspectTrace = (t) => {
  const box = $("#inspector");
  const netName = t.netId ? (getNet(t.netId)?.name || "") : "";
  const sec = document.createElement("div");
  sec.className = "insp-section";
  sec.innerHTML = `
    <div class="insp-title">Trace <span style="color:${SIDE_COLORS[t.side]};font-size:11px">● ${SIDE_LABELS[t.side]}</span></div>
    ${inspRow("Net", `<span style="display:flex;gap:4px;flex:1;min-width:0"><input id="i-net" class="net-ac" value="${escAttr(netName)}" style="flex:1;min-width:0"><button id="i-netgen" title="Generate a new unique net name">⊕</button></span>`)}
    ${inspRow("Side", `<select id="i-tside">${copperSideOptionsHtml(t.side)}</select>`)}
    ${inspRow("Width", UI.traceWidthInputs(t.width||3, "i-w"))}
    ${UI.traceCurrentRow(t, {showLength:true})}
    <div class="insp-actions"><button id="i-selnet">Select whole net</button><button id="i-del" class="danger">Delete</button></div>`;
  box.appendChild(sec);
  sec.querySelector("#i-tside").value = t.side;
  sec.querySelector("#i-netgen").addEventListener("click", ()=>{ sec.querySelector("#i-net").value = uniqueNetName(); sec.querySelector("#i-net").dispatchEvent(new Event("change")); });
  sec.querySelector("#i-selnet").addEventListener("click", ()=>{ if (t.netId) UI.selectNetTraces(t.netId); requestRender(); });
  sec.querySelector("#i-net").addEventListener("change", e => {
    applyNetRename({type:"trace", trace:t}, e.target.value);
  });
  sec.querySelector("#i-tside").addEventListener("change", e => { pushUndo(); t.side = e.target.value; UI.refreshInspector(); requestRender(); });
  const applyW = (px) => { if (!(px > 0)) return; pushUndo("trace width"); t.width = Math.max(0.05, px); UI.refreshInspector(); requestRender(); };
  sec.querySelector("#i-wmm").addEventListener("change",  e => applyW((parseFloat(e.target.value)||0) * State.pxPerMm));
  sec.querySelector("#i-wmil").addEventListener("change", e => applyW((parseFloat(e.target.value)||0) * MM_PER_MIL * State.pxPerMm));
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
};

/* sticky-note editor. Text commits live (so the on-board bubble updates as you type);
   a colour swatch row recolours the marker + bubble. */
UI.inspectNote = (n) => {
  const box = $("#inspector");
  const sec = document.createElement("div");
  sec.className = "insp-section";
  const swatches = ["#ffd24d","#4dd2ff","#8aff80","#ff7eb6","#ffa94d","#b78aff","#ff6e6e","#ffffff"];
  sec.innerHTML = `
    <div class="insp-title">📝 Note</div>
    ${inspRow("Text", `<textarea id="i-note-text" rows="4" placeholder="Type your note…" style="flex:1;min-width:0;resize:vertical;font:12px/1.4 Segoe UI,sans-serif">${escAttr(n.text)}</textarea>`)}
    <div class="insp-row"><label>Colour</label><div id="i-note-cols" style="display:flex;gap:4px;flex-wrap:wrap;flex:1"></div></div>
    <div class="panel-hint">Shown as a small marker; its text appears when you hover or select it. Drag in Select to move · double-click to edit.</div>
    <div class="insp-actions"><button id="i-del" class="danger">Delete note</button></div>`;
  box.appendChild(sec);
  bindLive(sec.querySelector("#i-note-text"), "edit note", v => { n.text = v; });
  const cols = sec.querySelector("#i-note-cols");
  swatches.forEach(c => {
    const b = document.createElement("button");
    b.title = c;
    b.style.cssText = `width:20px;height:20px;padding:0;border-radius:4px;cursor:pointer;background:${c};border:2px solid ${n.color===c?"#fff":"transparent"}`;
    b.addEventListener("click", () => { pushUndo("note colour"); n.color = c; UI.refreshInspector(); requestRender(); });
    cols.appendChild(b);
  });
  sec.querySelector("#i-del").addEventListener("click", deleteSelection);
};

/* focus (and select) the note text box — used right after placing / double-clicking */
UI.focusNoteText = () => {
  const el = $("#i-note-text");
  if (el){ el.focus(); el.select(); }
};

function escAttr(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }

