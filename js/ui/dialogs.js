/* ===== ui/dialogs.js — export, BOM, context menu, net popup, checker, history, overlap ===== */
"use strict";

/* ---------------- footprint dialog moved to fpdialog.js ---------------- */

/* ---------------- export dialog ---------------- */
UI.openExport = () => {
  const dlg = $("#export-dialog");
  if (typeof loadKicadFootprints === "function") loadKicadFootprints(); // ensure the list is available for the check
  const warn = $("#export-warn");
  const svg = $("#export-svg");
  const arrangeRow = $("#export-arrange-row");
  const update = () => {
    const fmt = $("#export-format").value;
    const isSch = fmt === "sch";
    const arrange = $("#export-arrange").value;
    arrangeRow.style.display = isSch ? "" : "none";
    $("#export-preview").value = netlistFor(fmt, arrange).text;
    // the schematic export gets a visual arrangement preview
    if (isSch){ svg.style.display = ""; svg.innerHTML = schPreviewSVG(arrange); }
    else { svg.style.display = "none"; svg.innerHTML = ""; }
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
  $("#export-arrange").onchange = update;
  update();
  dlg.showModal();
};

/* ---------------- BOM editor ----------------
   Spreadsheet over the grouped BOM. Editing Value/Part/Footprint rewrites every part
   on that row (and may regroup); custom columns store per-part values in component.bom
   and aggregate to a row value (blank when the parts disagree). */
UI.openBomEditor = () => {
  // the BOM editor lives in its own tab now — EditorTabs.show("bom") loads the
  // KiCad footprint list and renders the table
  EditorTabs.show("bom");
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
      + `<td><input class="bom-cell bom-refs" data-f="refs" value="${escAttr(refs)}" title="Rename the actual designators on the board — comma-separated, one per part (${g.refs.length})"></td>`;
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
      if (f === "refs"){ UI._applyBomRefs(g, val); return; }  // designators: validate before snapshotting
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
  UI._wireBomColResize(table);
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

/* resizable BOM columns: a grip on each header's right edge; widths are kept for the
   session (UI._bomColW, keyed by column index) and re-applied on every table rebuild */
UI._wireBomColResize = (table) => {
  const ths = [...table.querySelectorAll("thead th")];
  const saved = UI._bomColW || {};
  if (Object.keys(saved).length) table.style.tableLayout = "fixed";
  ths.forEach((th, i) => {
    if (saved[i]) th.style.width = saved[i] + "px";
    const grip = document.createElement("span");
    grip.className = "bom-resize";
    grip.title = "Drag to resize this column";
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault(); e.stopPropagation();
      grip.classList.add("dragging");
      const startX = e.clientX, startW = th.getBoundingClientRect().width;
      // freeze every column at its current width so only the grabbed one changes
      table.style.tableLayout = "fixed";
      ths.forEach(t => { if (!t.style.width) t.style.width = t.getBoundingClientRect().width + "px"; });
      const mv = (ev) => {
        const w = Math.max(36, startW + ev.clientX - startX);
        th.style.width = w + "px";
        (UI._bomColW || (UI._bomColW = {}))[i] = w;
      };
      const up = () => {
        grip.classList.remove("dragging");
        window.removeEventListener("pointermove", mv);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", mv);
      window.addEventListener("pointerup", up);
    });
    th.appendChild(grip);
  });
};

/* References cell → rename designators AND move parts between rows. Tokens are
   matched by name:
   · a token naming a part already in this row keeps it here;
   · a token naming a part from ANOTHER row PULLS it into this one (it adopts the
     row's value / part / footprint) — paste refs into the TARGET row to move them;
   · an unknown token renames one of this row's remaining parts (positionally).
   Refs simply removed from the list keep their properties (so they regroup on the
   same row) — moving is always done by pasting into the destination row. */
UI._applyBomRefs = (g, raw) => {
  const tokens = (raw || "").split(",").map(s => s.trim()).filter(Boolean);
  const revert = msg => { UI.toast(msg); UI._renderBomTable(); };
  if (!tokens.length)
    return revert("Row can't be emptied here — paste the refs into the row they should move TO");
  const lower = tokens.map(t => t.toLowerCase());
  if (new Set(lower).size !== lower.length) return revert("Duplicate references in the list");
  const byRef = new Map(State.components.map(c => [(c.ref || "").trim().toLowerCase(), c]));
  const inGroup = new Set(g.comps);
  const kept = new Set(), movers = [], newNames = [];
  for (const t of tokens){
    const c = byRef.get(t.toLowerCase());
    if (c && inGroup.has(c)) kept.add(c);
    else if (c) movers.push(c);          // exists on another row → move it into this one
    else newNames.push(t);               // unknown name → rename one of this row's parts
  }
  const vacated = g.comps.filter(c => !kept.has(c));
  if (newNames.length > vacated.length)
    return revert(newNames.length + " new name" + (newNames.length>1?"s":"") + " but only " +
                  vacated.length + " part" + (vacated.length===1?"":"s") + " of this row left to rename");
  if (!movers.length && !newNames.length){
    if (!vacated.length){ UI._renderBomTable(); return; }   // unchanged
    return revert("Removing refs here does nothing — paste " + vacated.map(c => c.ref).join(", ") +
                  " into the TARGET row to move them there");
  }
  pushUndo("edit BOM references");
  newNames.forEach((t, i) => { vacated[i].ref = t; registerRef(t); });
  for (const c of movers){ c.value = g.value; c.part = g.part; c.kicad = g.footprint; }
  const note = [];
  if (movers.length)  note.push(movers.length + " part" + (movers.length>1?"s":"") + " moved into this row");
  if (newNames.length) note.push(newNames.length + " renamed");
  UI.toast(note.join(" · "));
  UI._renderBomTable(); UI.refreshInspector(); UI.refreshNets(); requestRender();
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

  // typing filters the quick-select buttons live (net search); numbering stays
  // stable so the 1-9 hotkeys keep meaning the same nets
  const filterQuick = () => {
    const q = inp.value.trim().toLowerCase();
    [...quick.children].forEach((b, i) =>
      b.style.display = !q || quickNames[i].toLowerCase().includes(q) ? "" : "none");
  };
  inp.oninput = filterQuick;

  $("#netname-ok").onclick = () => finish(inp.value.trim());
  $("#netname-clear").onclick = () => finish("");
  $("#netname-cancel").onclick = () => { dlg.close(); document.removeEventListener("keydown", keyPick, true); };
  inp.onkeydown = (e) => { if (e.key === "Enter"){ e.preventDefault(); finish(inp.value.trim()); } };
  // number keys 1-9 pick a quick net. They fire when the field is empty OR its whole
  // value is still selected — which is the just-opened state (we focus+select on open),
  // so the hotkeys work immediately even though the current net name is pre-filled.
  // Once the user CLICKS into the field, digits type normally — so a net name that starts
  // with a number (e.g. "5V0", "3V3_A") can be typed without a preset stealing the keypress.
  let clicked = false;
  inp.onpointerdown = () => { clicked = true; };
  const allSelected = () => inp.selectionStart === 0 && inp.selectionEnd === inp.value.length;
  const keyPick = (e) => {
    if (clicked) return;                                        // user clicked in → type freely
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
/* Ask how far a net rename should reach. `allCount` = objects on the current named net,
   `connCount` = objects in the physically-connected node. cb("all"|"connected"|"one"|null).
   Buttons that wouldn't differ (allCount<=1 / connCount<=1) are hidden. */
UI.openNetScopeDialog = (oldName, newName, allCount, connCount, cb) => {
  const dlg = $("#netscope-dialog");
  const clearing = !newName;
  const verb = clearing ? "Clear" : "Rename";
  $("#netscope-msg").innerHTML = clearing
    ? `Clear net <b>“${escAttr(oldName)}”</b> — how far should it reach?`
    : `Set net to <b>“${escAttr(newName)}”</b> — how far should it reach?`;
  const allBtn = $("#netscope-all"), connBtn = $("#netscope-connected"), oneBtn = $("#netscope-one");
  allBtn.textContent  = `${verb} whole net “${oldName}” (${allCount})`;
  connBtn.textContent = `${verb} only connected (${connCount})`;
  oneBtn.textContent  = `${verb} only this selected`;
  allBtn.style.display  = allCount  > 1 ? "" : "none";   // no separate "all" when the net is this object alone
  connBtn.style.display = connCount > 1 ? "" : "none";   // no "connected" when nothing else is wired to it
  const pick = (scope) => { dlg.close(); cb(scope); };
  allBtn.onclick  = () => pick("all");
  connBtn.onclick = () => pick("connected");
  oneBtn.onclick  = () => pick("one");
  $("#netscope-cancel").onclick = () => pick(null);
  dlg.showModal();
};

/* two DIFFERENT named nets (A, B) are being joined — let the user pick which name wins
   instead of silently choosing one. cb("toB" | "toA" | "ignore" | "undo").
   opts.msg overrides the prompt text; opts.ignore===false hides the Ignore option (for
   physical joins like a via landing on a trace, where "keep separate" makes no sense). */
UI.openNetMergeDialog = (aName, bName, cb, opts) => {
  opts = opts || {};
  const dlg = $("#netmerge-dialog");
  dlg.querySelector(".dlg-title").innerHTML = opts.title || "Trace joins two nets";
  $("#netmerge-undo").textContent = opts.undoText || "Undo — don't draw the trace";
  $("#netmerge-msg").innerHTML = opts.msg ||
    `This trace connects <b>“${escAttr(aName)}”</b> (A) and <b>“${escAttr(bName)}”</b> (B). Which net should the joined copper use?`;
  $("#netmerge-tob").textContent    = `1.  A → B  (use “${bName}”)`;
  $("#netmerge-toa").textContent    = `2.  B → A  (use “${aName}”)`;
  const ignoreBtn = $("#netmerge-ignore");
  const hasIgnore = opts.ignore !== false;
  ignoreBtn.textContent = "3.  Ignore — keep the nets separate";
  ignoreBtn.style.display = hasIgnore ? "" : "none";
  $("#netmerge-undo").textContent = (hasIgnore ? "4.  " : "3.  ") + ($("#netmerge-undo").textContent || "");
  let done = false;
  const pick = (c) => { if (done) return; done = true; dlg.removeEventListener("keydown", onKey); dlg.close(); cb(c); };
  $("#netmerge-tob").onclick    = () => pick("toB");
  $("#netmerge-toa").onclick    = () => pick("toA");
  ignoreBtn.onclick             = () => pick("ignore");
  $("#netmerge-undo").onclick   = () => pick("undo");
  // quick-select hotkeys: 1=A→B, 2=B→A, 3=Ignore, 4=Undo (3=Undo when Ignore is hidden)
  const onKey = (e) => {
    const k = { "1":"toB", "2":"toA", "3":hasIgnore?"ignore":"undo", "4":"undo" }[e.key];
    if (!k) return;
    e.preventDefault(); e.stopPropagation();
    pick(k);
  };
  dlg.addEventListener("keydown", onKey);
  dlg.addEventListener("close", () => pick("undo"), { once:true }); // Esc-dismiss = undo
  dlg.showModal();
};

/* a drawn trace physically touches SEVERAL different named nets — list them all and let
   the user merge with one of them, with all of them, or keep them separate. `overlap` is
   an array of net objects {id,name,…}. cb(netId | "all" | null). Built dynamically since
   the button count varies; styled by the app's shared <dialog> CSS. */
UI.openMultiMergeDialog = (baseName, overlap, cb) => {
  const dlg = document.createElement("dialog");
  dlg.id = "multimerge-dialog";
  let done = false;
  const pick = (v) => { if (done) return; done = true; dlg.close(); dlg.remove(); cb(v); };
  const listTxt = overlap.map(n => "“" + escAttr(n.name) + "”").join(", ");
  const netBtns = overlap.map((n, i) =>
    `<button data-net="${n.id}">${i < 9 ? '<b style="color:var(--accent)">' + (i+1) + '</b>  ' : ""}Merge with “${escAttr(n.name)}”${n.protected ? " 🛡" : ""}</button>`
  ).join("");
  dlg.innerHTML = `
    <div class="dlg-title">Trace crosses ${overlap.length} nets</div>
    <div class="panel-hint" style="max-width:380px;margin-bottom:10px">The drawn trace (net <b>“${escAttr(baseName)}”</b>) physically touches ${overlap.length} other nets: ${listTxt}.<br>Merge it with one of them, all of them, or keep them separate.</div>
    <div class="dlg-buttons" style="flex-direction:column;align-items:stretch;gap:6px">
      ${netBtns}
      <button class="primary" data-all="1">Merge with ALL (${overlap.length})</button>
      <button data-keep="1">Keep separate — don't merge</button>
    </div>`;
  document.body.appendChild(dlg);
  dlg.querySelectorAll("button[data-net]").forEach(b => b.onclick = () => pick(+b.dataset.net));
  dlg.querySelector("button[data-all]").onclick  = () => pick("all");
  dlg.querySelector("button[data-keep]").onclick = () => pick(null);
  // hotkeys: 1-9 pick a net, 0 = merge all
  const onKey = (e) => {
    if (/^[1-9]$/.test(e.key) && overlap[+e.key - 1]){ e.preventDefault(); e.stopPropagation(); pick(overlap[+e.key - 1].id); }
    else if (e.key === "0"){ e.preventDefault(); e.stopPropagation(); pick("all"); }
  };
  dlg.addEventListener("keydown", onKey);
  dlg.addEventListener("close", () => pick(null), { once:true });  // Esc = keep separate
  dlg.showModal();
};

/* ---------------- checker ---------------- */
UI.openChecker = () => {
  const res = runChecker();
  View.checkMarks = res.unnetted.map(u => u.wp);
  View.shortMarks = (res.shorts || []).map(s => s.pos);
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
  // ---- group 3: shorts (different-net traces touching) ----
  if (res.shorts && res.shorts.length){
    const rows = res.shorts.map(s => {
      const lbl = `${escAttr(getNet(s.a.netId)?.name || "?")} ⟂ ${escAttr(getNet(s.b.netId)?.name || "?")} <span style="color:#8b96a5">(${SIDE_LABELS[s.a.side]||s.a.side})</span>`;
      return row(lbl, { wp:s.pos, trace:s.a });
    }).join("");
    html += group("issues", "Shorts — different-net traces touching", res.shorts.length, rows);
  }
  if (!res.unnetted.length && !res.mismatches.length && !(res.shorts && res.shorts.length))
    html += `<div class="panel-hint" style="color:#4fd07f">All pads have nets, no mismatches, no trace shorts. 🎉</div>`;
  box.innerHTML = html;
  // "Go" → close the dialog, centre on the issue and select the pad or trace
  box.querySelectorAll(".chk-go").forEach(btn => btn.addEventListener("click", ()=>{
    const it = issues[+btn.dataset.i];
    $("#checker-dialog").close();
    if (it.trace) UI.select({ type:"trace", trace:it.trace });
    else UI.select({ type:"pin", comp:it.comp, pinIdx:it.pinIdx });
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
    const detail = (typeof undoDetail === "function") ? undoDetail(i) : "";
    // a revert entry isn't itself revertible (that just re-reverts recursively) — show it as
    // an audit row with no "Undo this" button; Ctrl+Z still rolls it back normally
    const action = e.isRevert ? `<span class="hist-detail" style="opacity:.7">reverted (Ctrl+Z to restore)</span>`
                              : `<button class="hist-undo" data-i="${i}">Undo this</button>`;
    row.innerHTML = `<span class="hist-time">${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}</span>
      <span class="hist-main">
        <span class="hist-label">${escAttr(e.label)}</span>
        ${detail ? `<span class="hist-detail">${escAttr(detail)}</span>` : ""}
      </span>
      ${action}`;
    box.appendChild(row);
  }
  box.querySelectorAll(".hist-undo").forEach(btn => btn.addEventListener("click", ()=>{
    if (selectiveUndo(+btn.dataset.i)){
      UI.toast("Action reverted (only the objects it touched)");
      UI.select(null);
      if (typeof syncSettings === "function") syncSettings();   // reflect reverted board-wide scalars in the Options panel
      UI.refreshLayerList(); UI.refreshNets(); UI.refreshInspector();
      UI.buildHistory();
      requestRender();
    }
  }));
};

/* ---------------- overlap-after-move dialog ---------------- */
UI.openOverlapDialog = (conflicts) => {
  const clearMarks = ()=>{ View.overlapMarks = null; requestRender(); };
  pushUndo("merge overlapping nets");
  let merged = 0, blocked = 0, idx = 0;
  const finish = ()=>{
    clearMarks(); pruneNets();
    if (merged || blocked)
      UI.toast(merged + " net pair(s) merged" + (blocked ? " — " + blocked + " blocked (both protected)" : ""));
    else cancelUndo();       // nothing merged → no history entry (and redo survives)
    UI.refreshNets(); UI.refreshInspector(); requestRender();
  };
  // for each conflicting pair, use the merge dialog directly (A→B / B→A / keep separate),
  // titled for a pad move; "Undo move" reverts the whole move and stops the chain
  const step = ()=>{
    if (idx >= conflicts.length){ finish(); return; }
    const c = conflicts[idx++];
    const aName = getNet(c.a)?.name, bName = getNet(c.b)?.name;
    if (!aName || !bName || c.a === c.b){ step(); return; }   // already merged away / gone
    UI.openNetMergeDialog(aName, bName, (choice)=>{
      if (choice === "toB"){ if (mergeNets(c.b, c.a) === null) blocked++; else merged++; }   // keep B
      else if (choice === "toA"){ if (mergeNets(c.a, c.b) === null) blocked++; else merged++; } // keep A
      else if (choice === "undo"){                              // revert the move entirely
        cancelUndo(); clearMarks();
        if (undo()) afterHistory();
        UI.toast("Move undone"); return;
      }
      step();                                                  // ignore → keep separate, next pair
    }, { ignore:true, title:"&#9888; Pad overlaps another net",
         undoText:"Undo move",
         msg:`Moved pad puts <b>“${escAttr(aName)}”</b> (A) and <b>“${escAttr(bName)}”</b> (B) on the same copper. Which net should the joined copper use?` });
  };
  step();
};

