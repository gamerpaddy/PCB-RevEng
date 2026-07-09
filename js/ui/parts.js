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

