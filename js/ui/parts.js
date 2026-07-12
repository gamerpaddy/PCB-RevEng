/* ===== ui/parts.js — parts list / search ===== */
"use strict";

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
    item.addEventListener("click", () => {
      // in the schematic tab, jump + zoom + pan to the symbol instead of the board
      if (typeof EditorTabs !== "undefined" && EditorTabs.current === "schematic" &&
          typeof Sch !== "undefined" && typeof c.schX === "number"){
        const dlg = $("#parts-dialog"); if (dlg && dlg.open) dlg.close();
        Sch.focusComp(c);
      } else UI.jumpToComp(c);
    });
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
  UI.refreshPartsNets();
};

/* second Find list: nets, grouped, showing the part refs on each. The shared search
   box matches a net by its name OR by any member ref. Click a net row → highlight the
   net (blink on the board / centre in schematic) AND expand it into one clickable token
   per pin (REF(pinName else pinNum)); clicking a token jumps straight to that pad. */
UI.expandedPartsNetId = null;   // net whose per-pin tokens are shown in the Find dialog

function _partsNetPinStyle(){
  if (document.getElementById("partsnet-pin-style")) return;
  const st = document.createElement("style");
  st.id = "partsnet-pin-style";
  st.textContent =
    ".pn-pins{display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px 8px 14px}" +
    ".pn-pin-btn{font-size:11px;padding:2px 8px;background:#232b35;color:#cdd5df;" +
    "border:1px solid #3a4553;border-radius:4px;cursor:pointer;white-space:nowrap}" +
    ".pn-pin-btn:hover{background:#2f3a47;color:#fff;border-color:#4a5766}";
  document.head.appendChild(st);
}

UI.refreshPartsNets = () => {
  _partsNetPinStyle();
  const list = $("#partsnet-list");
  if (!list) return;
  const sc = list.scrollTop;
  list.innerHTML = "";
  const q = (UI.partFilter || "").trim().toLowerCase();
  // net id -> [{comp, pinIdx, ref, pin, pinName}] (richer than buildNetMap so each token
  // can jump to the exact pad)
  const map = new Map();
  for (const c of State.components){
    for (let i = 0; i < c.pins.length; i++){
      const p = c.pins[i];
      if (!p.netId) continue;
      if (!map.has(p.netId)) map.set(p.netId, []);
      map.get(p.netId).push({ comp: c, pinIdx: i, ref: c.ref, pin: p.num, pinName: p.name });
    }
  }
  const rows = [];
  for (const n of State.nets){
    const members = map.get(n.id);
    if (!members || !members.length) continue;
    const refs = [...new Set(members.map(m => m.ref))];
    if (q && !(n.name.toLowerCase().includes(q) || refs.some(r => (r||"").toLowerCase().includes(q)))) continue;
    rows.push({ net: n, refs, members, pins: members.length });
  }
  rows.sort((a,b) => a.net.name.localeCompare(b.net.name, undefined, { numeric:true, sensitivity:"base" }));
  for (const r of rows){
    // one token per pin on the net: REF(pinName else pinNum) — e.g. U1(A5), R1(2)
    const nodes = r.members.map(m => (m.ref || "?") + "(" + (m.pinName || m.pin || "?") + ")");
    const item = document.createElement("div");
    item.className = "part-item" + (UI.activeNetId === r.net.id ? " active" : "");
    const refList = nodes.slice(0, 8).join(", ") + (nodes.length > 8 ? " +" + (nodes.length - 8) : "");
    item.innerHTML = `<span class="pref">${escAttr(r.net.name)}</span>
      <span class="pval">${escAttr(refList)}</span>
      <span class="pside">${r.pins}p</span>`;
    item.title = nodes.join(", ");
    item.addEventListener("click", () => {
      const turnOn = UI.expandedPartsNetId !== r.net.id;
      UI.expandedPartsNetId = turnOn ? r.net.id : null;
      UI.jumpToNet(r.net.id, true);   // highlight net, keep dialog open
      UI.refreshPartsNets();
    });
    list.appendChild(item);
    // expanded net → a clickable token per pin; jumps to that exact pad on board/schematic
    if (UI.expandedPartsNetId === r.net.id){
      const grp = document.createElement("div");
      grp.className = "pn-pins";
      for (const m of r.members){
        const label = (m.pinName && String(m.pinName).trim()) ? m.pinName : m.pin;
        const b = document.createElement("button");
        b.className = "pn-pin-btn";
        b.textContent = (m.ref || "?") + " (" + (label || "?") + ")";
        b.title = "Jump to " + (m.ref || "?") + " · pin " + (m.pin || "?") +
                  (m.pinName ? " (" + m.pinName + ")" : "");
        b.addEventListener("click", e => { e.stopPropagation(); UI.jumpToNetPin(m); });
        grp.appendChild(b);
      }
      list.appendChild(grp);
    }
  }
  if (q && !rows.length){
    const none = document.createElement("div");
    none.className = "panel-hint";
    none.textContent = "No nets match “" + UI.partFilter.trim() + "”";
    list.appendChild(none);
  }
  const cnt = $("#partsnet-count");
  if (cnt) cnt.textContent = rows.length ? "(" + rows.length + ")" : "";
  list.scrollTop = sc;
};

/* jump to one specific pin from the Find dialog's net groups. buildNetMap members
   carry the component + pin index; focus that pad on the board or in the schematic. */
UI.jumpToNetPin = (m) => {
  const c = m.comp || m.component;
  const pinIdx = (typeof m.pinIdx === "number") ? m.pinIdx : m.idx;
  if (!c || typeof pinIdx !== "number") return;
  const dlg = $("#parts-dialog");
  if (typeof EditorTabs !== "undefined" && EditorTabs.current === "schematic" &&
      typeof Sch !== "undefined" && typeof c.schX === "number"){
    if (dlg && dlg.open) dlg.close();
    Sch.focusPin(c, pinIdx);
  } else {
    UI.focusPin(c, pinIdx);
    if (dlg && dlg.open) dlg.close();
  }
};

/* highlight a net: board → blink it; schematic → centre + focus on its pins.
   keepOpen leaves the Find dialog up (used when expanding a net's pin tokens). */
UI.jumpToNet = (netId, keepOpen) => {
  UI.activeNetId = netId;
  UI.refreshNets();
  const dlg = $("#parts-dialog");
  if (typeof EditorTabs !== "undefined" && EditorTabs.current === "schematic" && typeof Sch !== "undefined"){
    const geo = Sch.geo();
    let x = 0, y = 0, n = 0;
    for (const c of State.components){
      if (typeof c.schX !== "number") continue;
      for (let i = 0; i < c.pins.length; i++) if (c.pins[i].netId === netId){
        const p = schPinPos(c, i, geo); if (!p) continue; x += p.x; y += p.y; n++;
      }
    }
    if (n){ Sch.zoom = Math.max(Sch.zoom, 7); Sch.panX = Sch.width/2 - (x/n) * Sch.zoom; Sch.panY = Sch.height/2 - (y/n) * Sch.zoom; }
    Sch.invalidate(); Sch.render();
  } else {
    // board: select every trace (wire) on the net so it stays highlighted/selected
    // after the Find dialog closes, not just a momentary blink
    if (typeof UI.selectNetTraces === "function") UI.selectNetTraces(netId);
    else if (typeof blinkNet === "function") blinkNet(netId);
    else requestRender();
  }
  if (!keepOpen && dlg && dlg.open) dlg.close();
};

/* central rename: warns when another part already owns the reference, offering
   abort or a name-swap with that part. Returns nothing; refreshes on success. */
UI.commitRename = (c, newRef, noUndo) => {
  newRef = (newRef || "").trim();
  if (!newRef || newRef === c.ref){ UI.refreshInspector(); return; }
  const dup = State.components.find(x => x !== c && (x.ref||"").trim().toLowerCase() === newRef.toLowerCase());
  if (!dup){
    // noUndo: caller (footprint dialog / quick-edit) already pushed one snapshot for the whole edit
    if (!noUndo) pushUndo("rename " + c.ref);
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

