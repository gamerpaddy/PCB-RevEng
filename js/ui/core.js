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

/* box (marquee) selection: a heterogeneous set of hit-style objects
   {type:"comp",comp} / {type:"via",via} / {type:"trace",trace} / {type:"note",note}
   dragged out over empty board. Used for mass operations (delete an area). */
UI.boxSel = [];
UI.clearBoxSel = () => { UI.boxSel = []; };
UI.boxSelHas = (kind, obj) => UI.boxSel.some(s => s[kind] === obj);
UI.boxSelCount = () => UI.boxSel.length;

const $ = (sel) => document.querySelector(sel);

/* ---------------- status bar ---------------- */
UI.setStatusTool = (name) => { $("#status-tool").textContent = name.toUpperCase(); };
UI.setStatusPos = (w) => {
  const u = (v)=> { const mm = v/State.pxPerMm; return UI.unit()==="mil" ? (mm/MM_PER_MIL).toFixed(0) : mm.toFixed(2); };
  $("#status-pos").textContent = `x ${w.x.toFixed(0)}  y ${w.y.toFixed(0)} px   (${u(w.x)}, ${u(w.y)} ${UI.unit()})`;
  $("#status-zoom").textContent = "zoom " + (View.zoom*100).toFixed(0) + "%" + (View.flip ? "  ·  BACK VIEW" : "");
};
UI.setHint = (t) => { const el = $("#status-hint"); if (el) el.textContent = t; };  // hint element removed; no-op
/* hovered-pad readout (ref.pin · net) — cleared with "" */
UI.setStatusPad = (t) => { $("#status-pad").textContent = t || ""; };

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

/* auto-hiding WARNING banner (amber, top-centre) — no button. For actions that go
   through without a confirm dialog but the user should still notice, e.g. a small
   trace-drag that quietly merged two nets. */
UI.warn = (msg) => {
  let el = $("#warn-toast");
  if (!el){
    el = document.createElement("div");
    el.id = "warn-toast";
    el.style.cssText = "position:fixed;left:50%;top:52px;transform:translateX(-50%);background:#3a2a16;border:1px solid #7a5a24;color:#ffce8a;padding:7px 18px;border-radius:6px;z-index:99;font-size:12px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.45);transition:opacity .3s;pointer-events:none;max-width:70vw;text-align:center";
    document.body.appendChild(el);
  }
  el.textContent = "⚠ " + msg;
  el.style.opacity = "1";
  clearTimeout(UI._warnT);
  UI._warnT = setTimeout(()=>{ el.style.opacity = "0"; }, 3600);
};

UI.drawSide = () => $("#draw-side").value;
/* the copper side new traces/components target. In split view this follows the pane
   under the cursor (front/back); otherwise it's the draw-side selector. */
UI.copperSide = () => (typeof effDrawSide === "function" ? effDrawSide() : UI.drawSide());
UI.activeLayer = () => getLayer(UI.activeLayerId);
/* pick the active layer after a load: keep the remembered id if it still exists, else fall
   back to the first layer. Lets a page reload restore the last-used layer instead of layer 1. */
UI.resolveActiveLayer = (preferId) => {
  UI.activeLayerId = (preferId != null && getLayer(preferId)) ? preferId : (State.layers[0]?.id ?? null);
};
UI.layerKeyMode = () => localStorage.getItem("pcbreveng.layerKeyMode") || "switch";

/* mouse-wheel zoom sensitivity as a percent of the original speed (5–200).
   100 == the old hard-coded 1.15 factor (default); lower = finer/slower zoom,
   200 = double. Used by the canvas wheel handler. */
UI.zoomSens = () => { const v = parseInt(localStorage.getItem("pcbreveng.zoomSens"), 10);
  return (v >= 5 && v <= 200) ? v : 100; };

/* edge auto-scroll while dragging/placing near the viewport border (see tools.js).
   Preferences (per-browser, ride along with Options export/import):
   · on/off (default OFF) · margin px where it starts · max speed px/frame at the edge */
UI.edgeScrollOn = () => localStorage.getItem("pcbreveng.edgeScroll") === "on";
UI.edgeMargin = () => { const v = parseInt(localStorage.getItem("pcbreveng.edgeMargin"), 10);
  return (v >= 20 && v <= 400) ? v : 120; };
UI.edgeSpeed = () => { const v = parseFloat(localStorage.getItem("pcbreveng.edgeSpeed"));
  return (v >= 2 && v <= 40) ? v : 12; };

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

/* copper-only side options (NO X-ray) — for a trace's side, which must be a real copper
   layer; X-ray is a view overlay, not a side a trace can live on */
function copperSideOptionsHtml(current){
  const sides = availableSides().slice();
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

/* viewing the X-ray IMAGE layer turns X-ray mode on by default (so its copper from
   both sides is shown over the see-through image); switching back to a normal layer
   turns it off again — but only if X-ray was auto-enabled here, never overriding a
   manual toggle. Single-view only — split panes handle X-ray per-pane (View._paneXray). */
UI.autoXrayForLayer = (l) => {
  if (View.split) return;
  if (l && l.side === "xray"){
    if (!View.xray){
      View.xray = true; View.xrayAuto = true;
      UI.refreshXrayBtn();
      UI.toast("X-ray view ON (showing the X-ray layer)");
      requestRender();
    }
  } else if (View.xrayAuto && View.xray){   // left the X-ray layer → undo the auto-enable
    View.xray = false; View.xrayAuto = false;
    UI.refreshXrayBtn();
    UI.toast("X-ray view off");
    requestRender();
  }
};

/* per-pane layer dropdowns overlaid on the split view. Selecting a layer sets which
   image that pane shows and points its trace/copper side at that layer's side. */
UI.refreshSplitControls = () => {
  const selL = $("#split-layer-left"), selR = $("#split-layer-right");
  if (!selL || !selR) return;
  const show = !!View.split;
  selL.style.display = selR.style.display = show ? "" : "none";
  if (!show) return;
  const opts = (cur) => {
    let h = `<option value="">— no image —</option>`;
    for (const l of State.layers)
      h += `<option value="${l.id}"${l.id===cur?" selected":""}>${escAttr(l.name)} · ${SIDE_LABELS[l.side]||l.side}</option>`;
    return h;
  };
  selL.innerHTML = opts(View.paneLayer.left);
  selR.innerHTML = opts(View.paneLayer.right);
  selL.value = View.paneLayer.left != null ? String(View.paneLayer.left) : "";
  selR.value = View.paneLayer.right != null ? String(View.paneLayer.right) : "";
  const pick = (which, sel) => () => {
    const id = sel.value ? +sel.value : null;
    View.paneLayer[which] = id;
    const l = getLayer(id);
    if (l) View.paneSide[which] = l.side;   // trace/copper side follows the picked image
    if (which === "left" && id) UI.activeLayerId = id;
    UI.refreshSplitControls(); requestRender();
  };
  selL.onchange = pick("left", selL);
  selR.onchange = pick("right", selR);
};

/* switch the active draw side (e.g. when activating an image layer of that side) */
UI.setDrawSide = (side) => {
  if (side === "xray") return; // X-ray is an overlay toggle, not a draw side
  if (!availableSides().includes(side)) return;
  if ($("#draw-side").value === side) return;
  $("#draw-side").value = side;
  UI.toast("Drawing on " + SIDE_LABELS[side]);
  requestRender(); // trace/component visibility follows the draw side
};

/* ---------------- selection ---------------- */
UI.select = (sel) => {
  UI.sel = sel;
  UI.activeNetId = null;
  UI.pinSel = [];
  UI.traceSel = [];
  UI.boxSel = [];
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

