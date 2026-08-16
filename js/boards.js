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

  /* Drop every remembered camera / layer choice. Board ids are only unique WITHIN a
     project — resetProject restarts the id counter and loadProject takes ids straight
     from the file — so a project opened after another one inherits its predecessor's
     pan/zoom per page (reproduced: page 2 of the new project opened at the old one's
     camera instead of zoom-to-fit). Called from loadProject/resetProject. */
  resetCameras(){
    Boards._cam.clear(); Boards._schCam.clear(); Boards._layerSel.clear();
  },

  /* An undo/redo (or a multiplayer sync) can land on a DIFFERENT page than the one being
     viewed — the snapshot carries its own boardIdx. Without this the page swapped under
     you silently and kept the previous page's camera, showing the restored board at an
     arbitrary pan/zoom with an activeLayerId belonging to the page you just left.
     Same bookkeeping switchTo does, minus the selection clearing (afterHistory owns that). */
  adoptPageChange(prevBoardId){
    const b = activeBoard();
    if (!b || b.id === prevBoardId) return;
    if (prevBoardId != null && typeof View !== "undefined")
      Boards._cam.set(prevBoardId, { zoom: View.zoom, panX: View.panX, panY: View.panY });
    if (prevBoardId != null && typeof Sch !== "undefined")
      Boards._schCam.set(prevBoardId, { zoom: Sch.zoom, panX: Sch.panX, panY: Sch.panY });
    if (prevBoardId != null && typeof UI !== "undefined")
      Boards._layerSel.set(prevBoardId, UI.activeLayerId);
    const cam = Boards._cam.get(b.id);
    if (typeof View !== "undefined"){
      if (cam){ View.zoom = cam.zoom; View.panX = cam.panX; View.panY = cam.panY; }
      else if (State.layers.length || State.components.length) zoomToFit();
      View.hoverPin = null; View.hoverNetId = null;   // pointed at the page we just left
    }
    if (typeof Sch !== "undefined"){
      const sc = Boards._schCam.get(b.id);
      if (sc){ Sch.zoom = sc.zoom; Sch.panX = sc.panX; Sch.panY = sc.panY; }
      Sch._geo = null;
    }
    if (typeof UI !== "undefined"){
      UI.resolveActiveLayer(Boards._layerSel.get(b.id));
      UI.toast("Page → " + b.name);   // never move the user between pages in silence
    }
  },

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
    if (typeof Tools !== "undefined"){
      Tools.drag = null; Tools.padEdit = null; Tools.pending = null; Tools.ghostScale = 1;
      // an in-progress trace route holds points in the OLD page's coordinates/arrays
      Tools.tracePts = null; Tools.traceStartSnap = null; Tools.traceWidth = null;
      Tools.addPinFor = null;
    }
    if (typeof View !== "undefined"){
      // hover state names a pad/net on the page we just left — the star ratsnest would
      // otherwise keep its hub on a footprint that isn't here until the next mouse move
      View.hoverPin = null; View.hoverNetId = null;
    }
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
    if (!confirm(`Delete page “${b.name}” (${b.components.length} parts, ${b.layers.length} images, ${n} objects total)?\n\nUndoable with Ctrl+Z.`)) return;
    const wasActive = i === State.boardIdx;
    // A page delete MUST have its own restore point. Without one the deletion still sat
    // in the timeline — every older snapshot carries the board, so the next unrelated
    // Ctrl+Z quietly resurrected the page along with whatever it was actually undoing.
    pushUndo("delete page " + b.name);
    State.boards.splice(i, 1);
    // links into the deleted page, and its remembered camera/layer, go with it
    State.xlinks = State.xlinks.filter(l => !b.components.some(c => c.id === l.a || c.id === l.b));
    Boards._cam.delete(b.id); Boards._schCam.delete(b.id); Boards._layerSel.delete(b.id);
    if (State.boardIdx > i) State.boardIdx--;
    if (State.boardIdx >= State.boards.length) State.boardIdx = State.boards.length - 1;
    // repoint the aliases at whatever is now active
    const nb = State.boards[State.boardIdx];
    for (const col of BOARD_COLS) State[col] = nb[col];
    State.layerCount = nb.layerCount || 2;
    // the deleted page's nets may now be empty; the deleted page's selections are gone
    pruneNets();
    if (typeof UI !== "undefined"){
      // the nets panel is page-scoped but pruneNets() is project-wide: deleting a
      // BACKGROUND page can empty a net, so refresh it either way
      if (wasActive){
        UI.sel = null;
        UI.resolveActiveLayer(Boards._layerSel.get(nb.id));
        UI.rebuildSideSelect();
        if (typeof syncSettings === "function") syncSettings();
        UI.refreshLayerList();
      }
      UI.refreshNets(); UI.refreshInspector();
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
    Boards.migrateLinks();   // adopt any old comp.xlink groups into State.xlinks records
    const el = Boards.ensureStrip();
    Boards._sig = Boards.signature();
    el.innerHTML = "";
    State.boards.forEach((b, i) => {
      const t = document.createElement("span");
      t.className = "board-tab" + (i === State.boardIdx ? " active" : "");
      t.textContent = b.name;
      t.title = b.name + (i < 12 ? " (Shift+F" + (i + 1) + ")" : "") + " — click to switch, double-click to rename, right-click for menu";
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
     One link = one State.xlinks record {id, a, b, map} between two parts, with an
     optional PIN MAP — so a 4-pin connector can go to page 2 with pins 1,2 and to
     page 3 with pins 3,4 (two records with partial maps). map = [[pinNumA,pinNumB],…];
     null means "every pin, matched by number". A part can carry any number of links. */

  /* drop records whose parts no longer exist (deleted part / deleted page) */
  pruneLinks(){
    if (!State.xlinks.length) return;
    const ok = State.xlinks.filter(l => getComp(l.a) && getComp(l.b));
    if (ok.length !== State.xlinks.length) State.xlinks = ok;
  },

  /* one-time migration of the old comp.xlink group model into pairwise records */
  migrateLinks(){
    const grouped = new Map();
    for (const c of allOf("components")){
      if (!c.xlink) continue;
      if (!grouped.has(c.xlink)) grouped.set(c.xlink, []);
      grouped.get(c.xlink).push(c);
      delete c.xlink;
    }
    for (const members of grouped.values())
      for (let i = 1; i < members.length; i++)
        State.xlinks.push({ id: nextId(), a: members[0].id, b: members[i].id, map: null });
    if (grouped.size && typeof markDirty === "function") markDirty();
  },

  /* one-pass render-time index over every board: prunes dead links once, then gives
     O(1) lookups. { byComp: Map<compId,links[]>, comp: Map<compId,comp>,
     page: Map<compId,boardName> }. The per-frame overlays MUST use this instead of
     compLinks()/boardNameOf() per part — those rescan every board per call. */
  linkIndex(){
    boardsSyncScalars();
    const comp = new Map(), page = new Map();
    for (const b of State.boards)
      for (const c of b.components){ comp.set(c.id, c); page.set(c.id, b.name); }
    const ok = State.xlinks.filter(l => comp.has(l.a) && comp.has(l.b));
    if (ok.length !== State.xlinks.length) State.xlinks = ok;
    const byComp = new Map();
    const add = (id, l) => { let a = byComp.get(id); if (!a){ a = []; byComp.set(id, a); } a.push(l); };
    for (const l of ok){ add(l.a, l); add(l.b, l); }
    return { byComp, comp, page };
  },

  compLinks(c){
    Boards.pruneLinks();
    return c ? State.xlinks.filter(l => l.a === c.id || l.b === c.id) : [];
  },
  linkOther(link, c){ return getComp(link.a === c.id ? link.b : link.a); },
  /* the pin pairs a link joins, oriented from c's side: [[myNum, otherNum], …] */
  linkPairs(link, c){
    const other = Boards.linkOther(link, c);
    if (!other) return [];
    if (link.map) return link.a === c.id ? link.map : link.map.map(([a, b]) => [b, a]);
    // no explicit map — every pin number both parts share
    const mine = new Set(c.pins.map(p => String(p.num)));
    return other.pins.map(p => String(p.num)).filter(n => mine.has(n)).map(n => [n, n]);
  },
  /* short human label for a link's pin subset ("all pins" / "pins 1,2" / "1→3, 2→4") */
  linkPinsLabel(link, c){
    if (!link.map) return "all pins";
    const pairs = Boards.linkPairs(link, c);
    if (pairs.every(([a, b]) => String(a) === String(b)))
      return "pins " + pairs.map(([a]) => a).join(",");
    return pairs.map(([a, b]) => a + "→" + b).join(", ");
  },

  /* parse the dialog's pin field: "" | "all" → null; "1,2" → same numbers both sides;
     "1>3, 2>4" (also "1-3" / "1:3" / "1 3" / "1→3") → explicit pairs — every
     separator is typeable on a plain keyboard. Returns {map} or {err}. */
  parsePinSpec(text, c, target){
    text = (text || "").trim();
    if (!text || /^all$/i.test(text)) return { map: null };
    const has = (comp, n) => comp.pins.some(p => String(p.num) === String(n));
    const map = [];
    for (const tok of text.split(",")){
      const t = tok.trim();
      if (!t) continue;
      const m = /^(.+?)\s*(?:→|->|>|:|-)\s*(.+)$/.exec(t) || /^(\S+)\s+(\S+)$/.exec(t);
      const a = (m ? m[1] : t).trim(), b = (m ? m[2] : t).trim();
      if (!has(c, a))      return { err: "pin " + a + " not on " + c.ref };
      if (!has(target, b)) return { err: "pin " + b + " not on " + target.ref };
      map.push([a, b]);
    }
    return map.length ? { map } : { map: null };
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

  /* net merge across every link of c, honouring each link's pin map. Where one side
     has a net and the other doesn't, the empty pin joins it; where both have different
     nets they merge (protected-vs-protected pairs are left alone). */
  syncLinkNets(c, quiet){
    let changed = 0;
    const releaseAll = (compId, pinIdx) => {   // page-aware releasePinWireNets
      for (const w of allOf("schWires"))
        if ((w.a && w.a.comp === compId && w.a.pin === pinIdx) ||
            (w.b && w.b.comp === compId && w.b.pin === pinIdx)) w.netId = null;
    };
    for (const link of Boards.compLinks(c)){
      const o = Boards.linkOther(link, c);
      if (!o) continue;
      for (const [myNum, otherNum] of Boards.linkPairs(link, c)){
        const pi = c.pins.findIndex(p => String(p.num) === String(myNum));
        const qi = o.pins.findIndex(p => String(p.num) === String(otherNum));
        if (pi < 0 || qi < 0) continue;
        const p = c.pins[pi], q = o.pins[qi];
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
    // net joins must reach autosave even from the bare "Sync nets" button (linkTo
    // marks dirty itself, but this is also a direct entry point)
    if (changed && typeof markDirty === "function") markDirty();
    if (!quiet && typeof UI !== "undefined"){
      UI.toast(changed ? ("Off-page link: joined " + changed + " pin net" + (changed > 1 ? "s" : "")) : "Off-page link: nets already in sync");
      UI.refreshNets(); UI.refreshInspector();
    }
    requestRender();
    return changed;
  },

  linkTo(c, target, merge, map){
    pushUndo("off-page link " + c.ref);
    // RE-linking the same pair replaces any old record whose pins overlap the new one
    // — otherwise the stale link (often "all pins") lives on and every later net sync
    // silently re-joins pins the user thought were unlinked. Non-overlapping partial
    // maps to the same target (pins 1,2 → page 2, pins 3,4 → page 3 style) survive.
    const newPins = new Set(map ? map.map(([a]) => String(a)) : c.pins.map(p => String(p.num)));
    const overlapping = State.xlinks.filter(l => {
      if (!((l.a === c.id && l.b === target.id) || (l.a === target.id && l.b === c.id))) return false;
      return Boards.linkPairs(l, c).some(([a]) => newPins.has(String(a)));
    });
    if (overlapping.length) State.xlinks = State.xlinks.filter(l => !overlapping.includes(l));
    State.xlinks.push({ id: nextId(), a: c.id, b: target.id, map: map || null });
    if (overlapping.length) UI.toast("Replaced the previous " + c.ref + " ↔ " + target.ref + " link");
    if (merge) Boards.syncLinkNets(c, true);
    if (typeof markDirty === "function") markDirty();
    UI.toast("Linked " + c.ref + " ↔ " + target.ref + " (" + Boards.boardNameOf(target) + ")" +
             (map ? " — " + map.length + " pin" + (map.length > 1 ? "s" : "") : ""));
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  },

  unlink(link, c){
    pushUndo("remove off-page link " + (c ? c.ref : ""));
    State.xlinks = State.xlinks.filter(l => l !== link && l.id !== link.id);
    if (typeof markDirty === "function") markDirty();
    UI.refreshInspector(); requestRender();
  },

  /* the Link menu — list existing links, add several without reopening (rebuilt per open) */
  openLinkDialog(c){
    let dlg = document.getElementById("xlink-dialog");
    if (dlg) dlg.remove();
    dlg = document.createElement("dialog");
    dlg.id = "xlink-dialog";
    dlg.style.cssText = "width:400px;max-width:92vw;box-sizing:border-box";
    dlg.innerHTML = `
      <div style="display:flex;align-items:baseline;gap:8px;margin:0 0 2px">
        <h3 style="margin:0">Link menu</h3>
        <span style="color:#b78aff;font-weight:bold">${escAttr(c.ref)}</span>
        <span style="color:#8b96a5;font-size:11px">${escAttr(Boards.boardNameOf(c))}${c.value ? " · " + escAttr(c.value) : ""}</span>
      </div>
      <div style="color:#8b96a5;font-size:11px;margin-bottom:10px">Join this connector to its mating halves on other pages — add as many links as you need, then close.</div>

      <div style="font-size:11px;color:#8b96a5;margin-bottom:3px">Linked now</div>
      <div id="xlink-cur" style="border:1px solid #333a44;border-radius:5px;padding:4px 6px;margin-bottom:10px;max-height:110px;overflow-y:auto"></div>

      <div style="font-size:11px;color:#8b96a5;margin-bottom:3px">Add a link</div>
      <div style="border:1px solid #333a44;border-radius:5px;padding:8px">
        <input id="xlink-search" placeholder="Search ref / value / page…" style="width:100%;box-sizing:border-box;margin-bottom:6px">
        <select id="xlink-target" size="7" style="width:100%;box-sizing:border-box"></select>
        <div style="margin:8px 0 2px;font-size:11px;color:#8b96a5">Pins to join <span style="opacity:.7">— pick per pin, or type: empty = all by number, "1,2", "1>3, 2>4" (also - : or a space)</span></div>
        <div id="xlink-grid" style="max-height:170px;overflow-y:auto;box-sizing:border-box;border:1px solid #333a44;border-radius:4px;padding:4px;margin-bottom:4px"></div>
        <input id="xlink-pins" placeholder="all — or 1,2 — or 1>3, 2>4" style="width:100%;box-sizing:border-box">
        <div id="xlink-err" style="color:#e05555;font-size:11px;min-height:14px;margin-top:2px"></div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;flex:1">
            <input type="checkbox" id="xlink-merge" checked> Join nets now</label>
          <button id="xlink-ok" class="primary">+ Add link</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px">
        <button id="xlink-close">Done</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector("#xlink-close").addEventListener("click", () => dlg.close());
    const sel = dlg.querySelector("#xlink-target");
    const search = dlg.querySelector("#xlink-search");
    const errEl = dlg.querySelector("#xlink-err");
    const pinsEl = dlg.querySelector("#xlink-pins");
    // collect candidates once per open, filter live by the search box
    const cands = [];
    for (const b of State.boards){
      if (b === boardOf(c)) continue;
      for (const o of b.components){
        if (o.id === c.id) continue;
        // same rule as the inspector section: passives/ICs/crystals/… can't be a link END either
        if (Boards._unlinkable.test((o.ref || "").trim())) continue;
        cands.push({
          id: o.id,
          label: `${b.name} — ${o.ref}  (${o.pins.length} pins${o.value ? ", " + o.value : ""})`,
          text: (b.name + " " + o.ref + " " + (o.value || "") + " " + (o.part || "")).toLowerCase(),
          rank: o.pins.length === c.pins.length ? 0 : 1,   // same pin count first: likely the mating half
        });
      }
    }
    cands.sort((a, b2) => a.rank - b2.rank || a.label.localeCompare(b2.label));
    if (!cands.length && !Boards.compLinks(c).length){
      UI.toast("No parts on other pages yet — add a page and place the mating connector first");
      dlg.remove();
      return;
    }
    /* ---- visual pin-pair editor (kept in two-way sync with the text field) ---- */
    const gridEl = dlg.querySelector("#xlink-grid");
    const curTarget = () => getComp(parseInt(sel.value, 10));
    const pinLabel = (p) => String(p.num) + (p.name && String(p.name).trim() ? " (" + p.name + ")" : "");
    const textFromGrid = () => {
      const t = curTarget(); if (!t) return;
      const pairs = [];
      for (const s of gridEl.querySelectorAll("select"))
        if (s.value) pairs.push([s.dataset.my, s.value]);
      const tNums = new Set(t.pins.map(p => String(p.num)));
      const shared = c.pins.map(p => String(p.num)).filter(n => tNums.has(n));
      // identity mapping over every shared pin = the default → keep the field empty ("all")
      const identity = pairs.length === shared.length && pairs.every(([a, b]) => a === b);
      pinsEl.value = identity ? "" : pairs.map(([a, b]) => a === b ? a : a + ">" + b).join(", ");
      errEl.textContent = "";
    };
    const buildGrid = () => {
      const t = curTarget();
      gridEl.innerHTML = "";
      if (!t){ gridEl.style.display = "none"; return; }
      if (c.pins.length > 60 || t.pins.length > 200){   // huge parts: dropdown-per-pin is unusable
        gridEl.style.display = "";
        gridEl.innerHTML = `<div style="font-size:11px;color:#8b96a5">${c.pins.length} × ${t.pins.length} pins — too many for the picker, use the text field below.</div>`;
        return;
      }
      gridEl.style.display = "";
      const spec = Boards.parsePinSpec(pinsEl.value, c, t);
      const chosen = new Map();
      if (!spec.err && spec.map) for (const [a, b] of spec.map) chosen.set(String(a), String(b));
      const explicit = !spec.err && !!spec.map;
      const tNums = new Set(t.pins.map(p => String(p.num)));
      for (const p of c.pins){
        const my = String(p.num);
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;margin:1px 0;font-size:11px";
        const lbl = document.createElement("span");
        lbl.style.cssText = "width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        lbl.textContent = pinLabel(p);
        lbl.title = pinLabel(p);
        const s = document.createElement("select");
        s.style.cssText = "flex:1;font-size:11px";
        s.dataset.my = my;
        const none = document.createElement("option");
        none.value = ""; none.textContent = "— not joined —";
        s.appendChild(none);
        for (const q of t.pins){
          const o = document.createElement("option");
          o.value = String(q.num); o.textContent = pinLabel(q);
          s.appendChild(o);
        }
        s.value = explicit ? (chosen.get(my) || "") : (tNums.has(my) ? my : "");
        s.addEventListener("change", textFromGrid);
        row.appendChild(lbl); row.appendChild(s);
        gridEl.appendChild(row);
      }
    };
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const keep = q ? cands.filter(x => q.split(/\s+/).every(w => x.text.includes(w))) : cands;
      sel.innerHTML = "";
      for (const x of keep){
        const opt = document.createElement("option");
        opt.value = String(x.id); opt.textContent = x.label;
        sel.appendChild(opt);
      }
      if (keep.length) sel.selectedIndex = 0;
      errEl.textContent = keep.length ? "" : "no match";
      buildGrid();
    };
    search.value = ""; pinsEl.value = ""; errEl.textContent = "";
    search.oninput = fill;
    sel.onchange = buildGrid;
    pinsEl.oninput = () => {
      const t = curTarget(); if (!t) return;
      const spec = Boards.parsePinSpec(pinsEl.value, c, t);
      errEl.textContent = spec.err || "";
      if (!spec.err) buildGrid();
    };
    /* ---- existing links of c, live-refreshed after every add/remove ---- */
    const curEl = dlg.querySelector("#xlink-cur");
    const renderCur = () => {
      const links = Boards.compLinks(c);
      curEl.innerHTML = "";
      if (!links.length){
        curEl.innerHTML = `<div style="font-size:11px;color:#8b96a5;padding:2px 0">No links yet.</div>`;
        return;
      }
      for (const l of links){
        const o = Boards.linkOther(l, c);
        if (!o) continue;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0";
        row.innerHTML = `<span style="color:#b78aff">↔</span>
          <b>${escAttr(o.ref)}</b>
          <span style="flex:1;color:#8b96a5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                title="${escAttr(Boards.linkPinsLabel(l, c))}">${escAttr(Boards.boardNameOf(o))} · ${escAttr(Boards.linkPinsLabel(l, c))}</span>
          <button class="danger" style="font-size:11px;padding:1px 6px" title="Remove this link (nets stay merged)">✕</button>`;
        row.querySelector("button").addEventListener("click", () => { Boards.unlink(l, c); renderCur(); });
        curEl.appendChild(row);
      }
    };
    renderCur();
    fill();
    dlg.querySelector("#xlink-ok").onclick = () => {
      const t = getComp(parseInt(sel.value, 10));
      if (!t){ errEl.textContent = "pick a part from the list"; return; }
      const spec = Boards.parsePinSpec(pinsEl.value, c, t);
      if (spec.err){ errEl.textContent = spec.err; return; }
      Boards.linkTo(c, t, dlg.querySelector("#xlink-merge").checked, spec.map);
      // stay open for the next link: refresh the list, reset the pin spec
      pinsEl.value = ""; errEl.textContent = "";
      renderCur(); buildGrid();
      search.focus();
    };
    dlg.showModal();
    search.focus();
  },

  /* inspector section — appended by UI.inspectComponent for every part */
  /* off-page links only make sense on things that leave the board — hide the section on
     passives, ICs, crystals, transistors etc. unless the part already carries links */
  _unlinkable: /^(r|c|l|d|u|q|y|x|xt|vr|rv|zd|rn|ra|fb|led|ic|t)\s*\d/i,

  // same visibility rule as linkSection — used by the right-click menus too
  canLink(c){
    if (Boards.compLinks(c).length) return true;
    return State.boards.length > 1 && !Boards._unlinkable.test((c.ref || "").trim());
  },

  linkSection(box, c){
    const links = Boards.compLinks(c);
    if (!links.length && State.boards.length <= 1) return;   // single-page project, nothing linked → stay out of the way
    if (!links.length && Boards._unlinkable.test((c.ref || "").trim())) return;
    const sec = document.createElement("div");
    sec.className = "insp-section";
    const rows = links.map(l => {
      const o = Boards.linkOther(l, c);
      if (!o) return "";
      return `<div class="insp-row"><label title="${escAttr(Boards.linkPinsLabel(l, c))}">↔ ${escAttr(o.ref)}</label>
         <span style="flex:1;color:#8b96a5;font-size:11px;overflow:hidden;text-overflow:ellipsis" title="${escAttr(Boards.linkPinsLabel(l, c))}">${escAttr(Boards.boardNameOf(o))} · ${escAttr(Boards.linkPinsLabel(l, c))}</span>
         <button class="xlink-go" data-id="${o.id}" title="Jump to ${escAttr(o.ref)} on ${escAttr(Boards.boardNameOf(o))}">Go →</button>
         <button class="xlink-del danger" data-link="${l.id}" title="Remove this link (nets stay merged)">✕</button></div>`;
    }).join("");
    sec.innerHTML = `
      <div class="insp-title" style="font-size:11px">Off-page links</div>
      ${rows}
      <div class="insp-actions">
        <button id="i-xlink-add">Page Linker…</button>
        ${links.length ? `<button id="i-xlink-sync" title="Re-join nets across all of this part's links (honours each link's pin map)">Sync nets</button>` : ""}
      </div>`;
    box.appendChild(sec);
    sec.querySelector("#i-xlink-add").addEventListener("click", () => Boards.openLinkDialog(c));
    const sync = sec.querySelector("#i-xlink-sync");
    if (sync) sync.addEventListener("click", () => { pushUndo("sync off-page nets " + c.ref); Boards.syncLinkNets(c); });
    for (const btn of sec.querySelectorAll(".xlink-go"))
      btn.addEventListener("click", () => {
        const t = getComp(parseInt(btn.dataset.id, 10));
        if (t) Boards.jumpTo(t);
      });
    for (const btn of sec.querySelectorAll(".xlink-del"))
      btn.addEventListener("click", () => {
        const l = State.xlinks.find(x => x.id === parseInt(btn.dataset.link, 10));
        if (l) Boards.unlink(l, c);
      });
  },

  init(){
    Boards.refreshTabs();
    // Shift+F1…F12 switch PCB pages (plain F1-F5 switch the editor tabs — see EditorTabs)
    window.addEventListener("keydown", (e) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const m = /^F([1-9]|1[0-2])$/.exec(e.key);
      if (!m) return;
      if (e.target && e.target.matches && e.target.matches("input,select,textarea")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      const i = parseInt(m[1], 10) - 1;
      if (i >= State.boards.length){ UI.toast("No PCB page " + (i + 1)); return; }
      Boards.switchTo(i);
      UI.toast("Page → " + State.boards[i].name);
    }, true);
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
    // hotkey actions, unbound by default — the page tabs have their own right-click menu,
    // so these are bound from the Keys dialog (⌨) under "PCB pages". Shift+F1…F12 above
    // are fixed and not rebindable.
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
