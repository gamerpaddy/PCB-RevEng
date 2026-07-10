/* ===== ui/misc.js — quick edit, hotkey hints/help, hotkey editor ===== */
"use strict";

/* ---------------- quick edit (double-click a component) ---------------- */
UI.openQuickEdit = (c) => {
  const dlg = $("#quick-dialog");
  $("#quick-title").textContent = c.ref + " — " + compFootprint(c).label;
  const refIn = $("#quick-ref"), valIn = $("#quick-value"), hint = $("#quick-resolve");
  refIn.value = c.ref; valIn.value = c.value;
  // resolving an SMD code (103 → 10k) is resistor-only, keyed off the (possibly edited) ref
  const resolveVal = () => isResistorRef(refIn.value.trim() || c.ref) ? autoResolveValue(valIn.value) : valIn.value.trim();
  const updateHint = ()=>{
    const resolved = resolveVal();
    hint.textContent = (resolved !== valIn.value.trim()) ? ("→ " + resolved) : "";
  };
  valIn.oninput = updateHint;
  refIn.oninput = updateHint;   // changing the designator to/from R flips whether it resolves
  updateHint();
  $("#quick-ok").onclick = ()=>{
    dlg.close();
    if (compEditLocked(c)){ UI.toast(c.ref + " is edit-locked"); return; }
    pushUndo("quick edit " + c.ref);
    c.value = resolveVal(); // auto-fill on OK (no apply click)
    UI.refreshInspector(); requestRender();
    if (refIn.value.trim()) UI.commitRename(c, refIn.value, true); // may prompt on a duplicate ref
  };
  $("#quick-cancel").onclick = ()=> dlg.close();
  [refIn, valIn].forEach(inp => inp.onkeydown = (e)=>{ if (e.key === "Enter"){ e.preventDefault(); $("#quick-ok").click(); } });
  dlg.showModal();
  refIn.select();
};

/* ---------------- hotkey hints / help ---------------- */
/* refresh each bindable button's tooltip with its current binding. The button's
   original title (minus any hard-coded single-key hint like "[S]", but KEEPING
   modifier combos like "[Ctrl+E]") is cached once in dataset.baseTitle. */
UI.updateHotkeyHints = () => {
  for (const a of KeyActions){
    if (!a.btn) continue;
    document.querySelectorAll(a.btn).forEach(b => {
      if (b.dataset.baseTitle == null){
        b.dataset.baseTitle = (b.title || "")
          .replace(/\s*\[[^\]]*\]\s*$/, m => /ctrl|cmd|alt|shift|\+/i.test(m) ? m : "")
          .replace(/\s+$/, "");
      }
      const key = Keymap.keyFor(a.id);
      b.title = b.dataset.baseTitle + (key ? "  [" + key + "]" : "");
    });
  }
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
      ["Arrow keys","Pan the view (Shift = half a screen per press)"],
      [k("view.flip"),"Flip view (look from back)"],["Home / " + k("view.fit"),"Zoom to fit"],
      [k("view.mask"),"Coverage mask — tint areas without components"],
      ["1 … 9, 0","Switch view to image layer 1–10 (or toggle visibility — see Board/display panel)"],
      [k("view.split"),"Split view — Front/Back side by side; 1…0 set the LEFT view's layer, Shift+1…0 the RIGHT"],
    ]],
    ["Editing", [
      [k("edit.rotate") + " / Shift+" + k("edit.rotate"),"Rotate 90° / 15° (selection or ghost)"],
      [k("edit.side"),"Flip component side front/back"],
      [k("edit.lock"),"Lock / unlock component (blocks move, edit, delete)"],
      [k("edit.padsize"),"Edit selected pad — drag handles to resize / move it"],
      [k("edit.delete") + " / Backspace","Delete selection"],["Esc","Cancel current action / deselect"],
      ["Enter","Finish trace"],["Double-click pad/trace/via","Name its net"],["Shift+double-click via","Set layer span (blind / buried)"],
      ["Shift+drag trace anchor","Detach it (no snapping)"],
      [k("edit.drawside"),"Cycle active draw side (F.Cu/B.Cu/inner)"],[k("edit.net"),"Rename net of selection"],
      ["Ctrl+Z / Ctrl+Y","Undo / redo"],["Ctrl+D","Duplicate component"],
    ]],
    ["Project", [
      ["Ctrl+S","Save project (.json incl. images)"],["Ctrl+O","Open project"],["Ctrl+E","Export (netlist / BOM / schematic / CSV / JSON)"],
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
      // already taken by another action → confirm before stealing it
      const owner = Keymap.actionForKey(key);
      if (owner && owner.id !== btn.dataset.id &&
          !confirm("“" + key + "” is already the hotkey for “" + owner.label + "”.\n\n" +
                   "OK = overwrite (it becomes unbound)\nCancel = keep it")){
        UI.buildKeysList();   // aborted — restore the row, no change
        return;
      }
      Keymap.bind(btn.dataset.id, key);
      UI.buildKeysList();
      UI.updateHotkeyHints();
      UI.buildHelp();
      UI.refreshInspector();
    };
    window.addEventListener("keydown", capture, true);
  }));
};

/* refresh every place a binding is shown after it changes */
UI.afterHotkeyChange = (msg) => {
  if (msg) UI.toast(msg);
  UI.updateHotkeyHints();
  UI.buildHelp();
  const kd = $("#keys-dialog");
  if (kd && kd.open) UI.buildKeysList();
  UI.refreshInspector();
};

/* listen for the next key press and bind it to an action (same validation as the
   hotkey editor). Shared by the editor's rows and the button right-click menu. */
UI.captureHotkey = (id) => {
  const a = KeyActions.find(k => k.id === id);
  if (!a) return;
  UI.toast("Press a key for “" + a.label + "”   (Esc cancels)");
  const capture = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (["Shift","Control","Alt","Meta"].includes(e.key)) return;   // wait for a real key
    window.removeEventListener("keydown", capture, true);
    if (e.key === "Escape") return;
    const key = normKey(e);
    if (e.ctrlKey || e.metaKey || e.altKey || RESERVED_KEYS.includes(key) || /^[0-9]$/.test(key)){
      UI.toast("That key is reserved"); return;
    }
    // already taken by another action → confirm before stealing it
    const owner = Keymap.actionForKey(key);
    if (owner && owner.id !== id &&
        !confirm("“" + key + "” is already the hotkey for “" + owner.label + "”.\n\n" +
                 "OK = overwrite (it becomes unbound)\nCancel = keep it")){
      UI.toast("Cancelled — “" + owner.label + "” keeps " + key);
      return;
    }
    Keymap.bind(id, key);
    UI.afterHotkeyChange("“" + a.label + "” → " + key +
      (owner && owner.id !== id ? "  (was “" + owner.label + "”)" : ""));
  };
  window.addEventListener("keydown", capture, true);
};

/* right-click menu on a bindable toolbar button: set / change / clear its hotkey */
UI.openButtonHotkeyMenu = (id, x, y) => {
  const a = KeyActions.find(k => k.id === id);
  if (!a) return;
  const key = Keymap.keyFor(id);
  const items = [
    { label: key ? "Change hotkey  (now " + key + ")…" : "Set hotkey…", action: () => UI.captureHotkey(id) },
  ];
  if (key) items.push({ label: "Clear hotkey", action: () => { Keymap.bind(id, ""); UI.afterHotkeyChange("“" + a.label + "” hotkey cleared"); } });
  items.push({ sep: true });
  items.push({ label: "Open hotkey editor…", action: () => UI.openKeysDialog() });
  UI.showContextMenu(x, y, items);
};

/* ---------------- trace width (Shift+W quick picker) ---------------- */
/* short human label for a width in display px, e.g. "0.25 mm / 10 mil" */
UI.traceWidthLabel = (px) => {
  const mm = px / State.pxPerMm;
  return mm.toFixed(2) + " mm / " + Math.round(mm / MM_PER_MIL) + " mil";
};

/* Apply a width (display px). While routing, it changes the width for the REST of the
   trace (splitting off the part already drawn at its current width — see
   changeTraceWidthWhileDrawing) without touching your default. Idle, it sets State.traceW
   (the new-trace default). Only call from deliberate confirms (Enter / preset / field
   change), never per-keystroke, or it would split on every digit typed. */
UI.setTraceWidth = (px) => {
  if (!(px > 0)) return;
  px = Math.max(0.05, px);
  if (Tools.tracePts) changeTraceWidthWhileDrawing(px);
  else { State.traceW = px; requestRender(); }
};

/* floating quick picker: a mm/mil input plus common presets. Sets the drawing width
   (mid-route) or the new-trace default (idle). Closes on Enter / Esc / click-away. */
UI.openTraceWidthMenu = (x, y) => {
  UI.closeTraceWidthMenu();
  const drawing = !!Tools.tracePts;
  const curPx = drawing ? (Tools.traceWidth || State.traceW) : State.traceW;
  const m = document.createElement("div");
  m.id = "tracew-menu";
  const presetsMm = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1.0];
  m.innerHTML = `
    <div class="tracew-title">${drawing ? "Current trace width" : "New-trace width"}</div>
    <div class="tracew-inputs">
      <input id="tracew-mm" type="number" step="0.05" min="0.05" title="Width in millimetres"><span>mm</span>
      <input id="tracew-mil" type="number" step="1" min="0.5" title="Width in mils (thou)"><span>mil</span>
    </div>
    <div class="tracew-presets">${presetsMm.map(mm => `<button data-mm="${mm}">${mm}</button>`).join("")}</div>`;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth  - r.width  - 6) + "px";
  m.style.top  = Math.min(y, window.innerHeight - r.height - 6) + "px";

  const mmIn = m.querySelector("#tracew-mm"), milIn = m.querySelector("#tracew-mil");
  const setFields = (px) => {
    const mm = px / State.pxPerMm;
    mmIn.value = mm.toFixed(3);
    milIn.value = (mm / MM_PER_MIL).toFixed(1);
  };
  // Apply is deliberate (Enter / preset) — never per-keystroke, since while routing it
  // splits the trace at the current anchor. Confirming closes the picker.
  const apply = (px) => {
    UI.setTraceWidth(px);
    UI.refreshInspector();
    if (!Tools.tracePts) UI.toast("New-trace width → " + UI.traceWidthLabel(State.traceW));
    UI.closeTraceWidthMenu();
  };
  setFields(curPx);
  // typing just keeps the paired unit in sync; the value is applied on Enter or a preset
  mmIn.addEventListener("input",  () => { const mm = parseFloat(mmIn.value)||0; milIn.value = (mm / MM_PER_MIL).toFixed(1); });
  milIn.addEventListener("input", () => { const mil = parseFloat(milIn.value)||0; mmIn.value = (mil * MM_PER_MIL).toFixed(3); });
  m.querySelectorAll(".tracew-presets button").forEach(b =>
    b.addEventListener("click", () => apply(parseFloat(b.dataset.mm) * State.pxPerMm)));
  m.addEventListener("keydown", (e) => {
    if (e.key === "Enter"){ e.preventDefault(); apply((parseFloat(mmIn.value)||0) * State.pxPerMm); }
    else if (e.key === "Escape"){ e.preventDefault(); UI.closeTraceWidthMenu(); }
  });
  setTimeout(() => document.addEventListener("pointerdown", UI._tracewDismiss, true), 0);
  mmIn.focus(); mmIn.select();
};
UI._tracewDismiss = (e) => { if (!e.target.closest("#tracew-menu")) UI.closeTraceWidthMenu(); };
UI.closeTraceWidthMenu = () => {
  const m = document.getElementById("tracew-menu");
  if (m) m.remove();
  document.removeEventListener("pointerdown", UI._tracewDismiss, true);
};
