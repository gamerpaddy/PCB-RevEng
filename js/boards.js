/* ===== boards.js — multi-PCB pages: bottom tab strip + off-page connector links =====
   A project can hold several PCBs ("pages"). The data model lives in state.js
   (State.boards + top-level aliases); this file is the UI: the bottom tab row shown
   in the Visual and Schematic editors, page add/rename/delete/switch with per-page
   camera memory, and the "off-page link" system that ties connectors on different
   pages together (pin-by-pin net merge + jump-to-page buttons in the inspector). */
"use strict";

const Boards = {
  _cam: new Map(),      // board id -> {zoom,panX,panY} (visual editor camera)
  _schCam: new Map(),   // board id -> {zoom,panX,panY} (schematic camera)
  _layerSel: new Map(), // board id -> UI.activeLayerId
  _sig: "",             // strip signature (names+idx) to skip needless DOM rebuilds

  /* ---------- page switching ---------- */
  switchTo(i){
    i = Math.max(0, Math.min(State.boards.length - 1, i | 0));
    if (i === State.boardIdx) return;
    const oldB = activeBoard();
    // remember where we were on this page
    if (typeof View !== "undefined") Boards._cam.set(oldB.id, { zoom: View.zoom, panX: View.panX, panY: View.panY });
    if (typeof Sch !== "undefined")  Boards._schCam.set(oldB.id, { zoom: Sch.zoom, panX: Sch.panX, panY: Sch.panY });
    if (typeof UI !== "undefined")   Boards._layerSel.set(oldB.id, UI.activeLayerId);

    setActiveBoard(i);
    const b = activeBoard();

    // selections/drags point into the old page's arrays — drop them
    if (typeof Tools !== "undefined"){ Tools.drag = null; Tools.padEdit = null; Tools.pending = null; }
    if (typeof UI !== "undefined"){
      UI.sel = null;
      if (UI.pinSel) UI.pinSel.length = 0;
      if (UI.traceSel) UI.traceSel.length = 0;
      if (UI.boxSel) UI.boxSel.length = 0;
      UI.resolveActiveLayer(Boards._layerSel.get(b.id));
      UI.rebuildSideSelect();
      if (typeof syncSettings === "function") syncSettings();
      UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
    }
    // restore this page's camera (or fit it on first visit)
    const cam = Boards._cam.get(b.id);
    if (typeof View !== "undefined"){
      if (cam){ View.zoom = cam.zoom; View.panX = cam.panX; View.panY = cam.panY; }
      else if (State.layers.length || State.components.length) zoomToFit();
    }
    if (typeof Sch !== "undefined"){
      const sc = Boards._schCam.get(b.id);
      if (sc){ Sch.zoom = sc.zoom; Sch.panX = sc.panX; Sch.panY = sc.panY; }
      else Sch._entered = false;   // first visit on this page → re-fit the sheet
      Sch._geo = null;
      if (Sch.clearSelection) Sch.clearSelection();
      if (typeof EditorTabs !== "undefined" && EditorTabs.current === "schematic") Sch.enter();
    }
    if (typeof markDirty === "function") markDirty();   // boardIdx is persisted
    Boards.refreshTabs();
    requestRender();
  },

  addBoard(){
    boardsSyncScalars();
    const b = makeBoard();
    State.boards.push(b);
    Boards.switchTo(State.boards.length - 1);
    if (typeof UI !== "undefined") UI.toast("Added " + b.name + " — pages share nets, use off-page links on connectors");
  },

  renameBoard(i){
    const b = State.boards[i]; if (!b) return;
    const name = prompt("Page name", b.name);
    if (name == null || !name.trim()) return;
    b.name = name.trim().slice(0, 40);
    if (typeof markDirty === "function") markDirty();
    Boards.refreshTabs();
  },

  removeBoard(i){
    if (State.boards.length <= 1){ if (typeof UI !== "undefined") UI.toast("Can't delete the last page"); return; }
    boardsSyncScalars();
    const b = State.boards[i]; if (!b) return;
    const n = b.components.length + b.vias.length + b.traces.length;
    if (!confirm(`Delete page “${b.name}” (${b.components.length} parts, ${b.layers.length} images, ${n} objects total)?\n\nThis cannot be undone.`)) return;
    const wasActive = i === State.boardIdx;
    State.boards.splice(i, 1);
    if (State.boardIdx > i) State.boardIdx--;
    if (State.boardIdx >= State.boards.length) State.boardIdx = State.boards.length - 1;
    // repoint the aliases at whatever is now active
    const nb = State.boards[State.boardIdx];
    for (const col of BOARD_COLS) State[col] = nb[col];
    State.layerCount = nb.layerCount || 2;
    // the deleted page's nets may now be empty; the deleted page's selections are gone
    pruneNets();
    if (wasActive && typeof UI !== "undefined"){
      UI.sel = null;
      UI.resolveActiveLayer(Boards._layerSel.get(nb.id));
      UI.rebuildSideSelect();
      if (typeof syncSettings === "function") syncSettings();
      UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
    }
    if (typeof markDirty === "function") markDirty();
    Boards.refreshTabs();
    requestRender();
  },

  /* ---------- tab strip ---------- */
  ensureStrip(){
    let el = document.getElementById("board-tabs");
    if (el) return el;
    el = document.createElement("div");
    el.id = "board-tabs";
    const app = document.getElementById("app") || document.body;
    app.appendChild(el);
    return el;
  },

  refreshTabs(){
    const el = Boards.ensureStrip();
    Boards._sig = Boards.signature();
    el.innerHTML = "";
    State.boards.forEach((b, i) => {
      const t = document.createElement("span");
      t.className = "board-tab" + (i === State.boardIdx ? " active" : "");
      t.textContent = b.name;
      t.title = b.name + " — click to switch, double-click to rename, right-click for menu";
      t.addEventListener("click", () => Boards.switchTo(i));
      t.addEventListener("dblclick", (e) => { e.preventDefault(); Boards.renameBoard(i); });
      t.addEventListener("contextmenu", (e) => { e.preventDefault(); Boards.tabMenu(i, e.clientX, e.clientY); });
      el.appendChild(t);
    });
    const add = document.createElement("span");
    add.className = "board-tab board-tab-add";
    add.textContent = "+";
    add.title = "Add a PCB page (its own images, parts and traces — nets are shared)";
    add.addEventListener("click", () => Boards.addBoard());
    el.appendChild(add);
    Boards.refreshVisibility();
  },

  /* right-click menu on a page tab — the home for future per-page actions
     (duplicate page, move left/right, merge into…, export just this page, …) */
  tabMenu(i, x, y){
    const b = State.boards[i]; if (!b) return;
    const items = [
      { label: "Rename…", action: () => Boards.renameBoard(i) },
    ];
    if (i !== State.boardIdx)
      items.unshift({ label: "Switch to " + b.name, action: () => Boards.switchTo(i) });
    if (State.boards.length > 1) items.push(
      { sep: true },
      { label: "Delete page…", danger: true, action: () => Boards.removeBoard(i) },
    );
    UI.showContextMenu(x, y, items);
  },

  refreshVisibility(){
    const el = document.getElementById("board-tabs");
    if (!el) return;
    const tab = (typeof EditorTabs !== "undefined") ? EditorTabs.current : "visual";
    el.style.display = (tab === "visual" || tab === "schematic") ? "" : "none";
  },

  signature(){
    return State.boardIdx + "|" + State.boards.map(b => b.id + ":" + b.name).join("|");
  },

  /* ---------- off-page connector links ----------
     comp.xlink = shared group id. Every part with the same xlink is "the same
     connection" — nets merge pin-by-pin (matched by pin NUMBER), and the inspector
     shows a jump button per partner. More than two members are fine (e.g. one bus
     connector fanning out to several PCBs). */
  linkPartners(c){
    if (!c || !c.xlink) return [];
    return allOf("components").filter(o => o.xlink === c.xlink && o.id !== c.id);
  },

  boardNameOf(comp){
    const b = boardOf(comp);
    return b ? b.name : "?";
  },

  jumpTo(comp){
    const b = boardOf(comp);
    if (!b) return;
    const i = State.boards.indexOf(b);
    if (i !== State.boardIdx) Boards.switchTo(i);
    if (typeof EditorTabs !== "undefined" && EditorTabs.current === "schematic" &&
        typeof Sch !== "undefined" && Sch.focusComp) Sch.focusComp(comp);
    else UI.jumpToComp(comp);
  },

  /* pin-by-pin net merge across every member of c's link group (pins matched by num).
     Where one side has a net and the other doesn't, the empty pin joins it; where both
     have different nets they merge (protected-vs-protected pairs are left alone). */
  syncLinkNets(c, quiet){
    const partners = Boards.linkPartners(c);
    if (!partners.length) return 0;
    let changed = 0;
    const releaseAll = (compId, pinIdx) => {   // page-aware releasePinWireNets
      for (const w of allOf("schWires"))
        if ((w.a && w.a.comp === compId && w.a.pin === pinIdx) ||
            (w.b && w.b.comp === compId && w.b.pin === pinIdx)) w.netId = null;
    };
    for (const o of partners){
      for (let pi = 0; pi < c.pins.length; pi++){
        const p = c.pins[pi];
        const qi = o.pins.findIndex(q => String(q.num) === String(p.num));
        if (qi < 0) continue;
        const q = o.pins[qi];
        if (p.netId && q.netId && p.netId !== q.netId){
          const kept = mergeNets(p.netId, q.netId);
          if (kept != null) changed++;
        } else if (p.netId && !q.netId){
          q.netId = p.netId; releaseAll(o.id, qi); changed++;
        } else if (!p.netId && q.netId){
          p.netId = q.netId; releaseAll(c.id, pi); changed++;
        }
      }
    }
    pruneNets();
    if (!quiet && typeof UI !== "undefined"){
      UI.toast(changed ? ("Off-page link: joined " + changed + " pin net" + (changed > 1 ? "s" : "")) : "Off-page link: nets already in sync");
      UI.refreshNets(); UI.refreshInspector();
    }
    requestRender();
    return changed;
  },

  linkTo(c, target, merge){
    pushUndo("off-page link " + c.ref);
    const group = target.xlink || c.xlink || nextId();
    c.xlink = group; target.xlink = group;
    if (merge) Boards.syncLinkNets(c, true);
    if (typeof markDirty === "function") markDirty();
    UI.toast("Linked " + c.ref + " ↔ " + target.ref + " (" + Boards.boardNameOf(target) + ")");
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  },

  unlink(c){
    if (!c.xlink) return;
    pushUndo("remove off-page link " + c.ref);
    c.xlink = null;
    if (typeof markDirty === "function") markDirty();
    UI.refreshInspector(); requestRender();
  },

  /* pick a part on another page to link with (dialog is built once, filled per open) */
  openLinkDialog(c){
    let dlg = document.getElementById("xlink-dialog");
    if (!dlg){
      dlg = document.createElement("dialog");
      dlg.id = "xlink-dialog";
      dlg.innerHTML = `
        <h3 style="margin:0 0 8px">Link across pages</h3>
        <div style="color:#8b96a5;font-size:11px;margin-bottom:8px">Pick the connector this one plugs into on another page.<br>Pins are matched by pin number.</div>
        <select id="xlink-target" size="10" style="width:320px"></select>
        <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:12px">
          <input type="checkbox" id="xlink-merge" checked> Join nets pin-by-pin now</label>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          <button id="xlink-cancel">Cancel</button>
          <button id="xlink-ok" class="primary">Link</button>
        </div>`;
      document.body.appendChild(dlg);
      dlg.querySelector("#xlink-cancel").addEventListener("click", () => dlg.close());
    }
    const sel = dlg.querySelector("#xlink-target");
    sel.innerHTML = "";
    const opts = [];
    for (const b of State.boards){
      if (b === boardOf(c)) continue;
      for (const o of b.components){
        if (o.id === c.id) continue;
        const opt = document.createElement("option");
        opt.value = String(o.id);
        opt.textContent = `${b.name} — ${o.ref}  (${o.pins.length} pins${o.value ? ", " + o.value : ""})`;
        // same pin count first: most likely the mating half
        opt._rank = o.pins.length === c.pins.length ? 0 : 1;
        opts.push(opt);
      }
    }
    opts.sort((a, b2) => a._rank - b2._rank || a.textContent.localeCompare(b2.textContent));
    for (const o of opts) sel.appendChild(o);
    if (!opts.length){
      UI.toast("No parts on other pages yet — add a page and place the mating connector first");
      return;
    }
    sel.selectedIndex = 0;
    dlg.querySelector("#xlink-ok").onclick = () => {
      const t = getComp(parseInt(sel.value, 10));
      dlg.close();
      if (t) Boards.linkTo(c, t, dlg.querySelector("#xlink-merge").checked);
    };
    dlg.showModal();
  },

  /* inspector section — appended by UI.inspectComponent for every part */
  linkSection(box, c){
    const partners = Boards.linkPartners(c);
    if (!partners.length && State.boards.length <= 1) return;   // single-page project, nothing linked → stay out of the way
    const sec = document.createElement("div");
    sec.className = "insp-section";
    const rows = partners.map(o =>
      `<div class="insp-row"><label>↔ ${escAttr(o.ref)}</label>
         <span style="flex:1;color:#8b96a5;font-size:11px;overflow:hidden;text-overflow:ellipsis">${escAttr(Boards.boardNameOf(o))}</span>
         <button class="xlink-go" data-id="${o.id}" title="Jump to ${escAttr(o.ref)} on ${escAttr(Boards.boardNameOf(o))}">Go →</button></div>`).join("");
    sec.innerHTML = `
      <div class="insp-title" style="font-size:11px">Off-page link</div>
      ${rows}
      <div class="insp-actions">
        <button id="i-xlink-add">${partners.length ? "Link another…" : "Link to another page…"}</button>
        ${partners.length ? `<button id="i-xlink-sync" title="Re-join nets pin-by-pin across all linked connectors">Sync nets</button>
        <button id="i-xlink-del" class="danger" title="Remove THIS part from the link group (nets stay merged)">Unlink</button>` : ""}
      </div>`;
    box.appendChild(sec);
    sec.querySelector("#i-xlink-add").addEventListener("click", () => Boards.openLinkDialog(c));
    const sync = sec.querySelector("#i-xlink-sync");
    if (sync) sync.addEventListener("click", () => { pushUndo("sync off-page nets " + c.ref); Boards.syncLinkNets(c); });
    const del = sec.querySelector("#i-xlink-del");
    if (del) del.addEventListener("click", () => Boards.unlink(c));
    for (const btn of sec.querySelectorAll(".xlink-go"))
      btn.addEventListener("click", () => {
        const t = getComp(parseInt(btn.dataset.id, 10));
        if (t) Boards.jumpTo(t);
      });
  },

  init(){
    Boards.refreshTabs();
    // the strip only shows on the Visual/Schematic tabs — follow tab switches
    if (typeof EditorTabs !== "undefined"){
      const orig = EditorTabs.show.bind(EditorTabs);
      EditorTabs.show = (name) => { orig(name); Boards.refreshVisibility(); };
    }
    // undo/redo/load/multiplayer replace State.boards wholesale — refresh the strip
    // whenever a render notices the page list changed (cheap string compare)
    const origRR = window.requestRender;
    window.requestRender = function(...a){
      if (Boards._sig !== Boards.signature()) Boards.refreshTabs();
      return origRR.apply(this, a);
    };
    // hotkey actions (unbound by default — right-click… nothing to right-click here,
    // bind them via the Keys dialog)
    if (typeof KeyActions !== "undefined"){
      KeyActions.push(
        { id:"board.next", label:"Next PCB page",     def:"", run:()=>Boards.switchTo(State.boardIdx + 1 >= State.boards.length ? 0 : State.boardIdx + 1) },
        { id:"board.prev", label:"Previous PCB page", def:"", run:()=>Boards.switchTo(State.boardIdx - 1 < 0 ? State.boards.length - 1 : State.boardIdx - 1) },
        { id:"board.add",  label:"Add PCB page",      def:"", run:()=>Boards.addBoard() },
      );
    }
  },
};

document.addEventListener("DOMContentLoaded", () => Boards.init());
