/* ===== ui/nets.js — net list ===== */
"use strict";

/* ---------------- net list ---------------- */
UI.netFilter = "";
UI.expandedNetId = null;   // net whose per-pin focus buttons are shown (click a row to toggle)

/* every pad on a net, with the component + pin index needed to focus it on the board */
function netPinMembers(netId){
  const out = [];
  for (const c of State.components)
    for (let i = 0; i < c.pins.length; i++)
      if (c.pins[i].netId === netId) out.push({ comp: c, pinIdx: i, num: c.pins[i].num, name: c.pins[i].name });
  return out;
}

/* select a pad and centre the board on it (used by the net list's per-pin buttons) */
UI.focusPin = (comp, pinIdx) => {
  UI.select({ type: "pin", comp, pinIdx });
  const fp = compFootprint(comp);
  const fpin = fp && fp.pins[pinIdx];
  const wp = fpin ? pinWorldPos(comp, fpin) : { x: comp.x, y: comp.y };
  View.panX = View.width / 2 - wp.x * View.zoom * (View.flip ? -1 : 1);
  View.panY = View.height / 2 - wp.y * View.zoom;
  requestRender();
};

function _netPinStyle(){
  if (document.getElementById("net-pin-style")) return;
  const st = document.createElement("style");
  st.id = "net-pin-style";
  st.textContent =
    ".net-pins{display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px 8px 20px}" +
    ".net-pin-btn{font-size:11px;padding:2px 8px;background:#232b35;color:#cdd5df;" +
    "border:1px solid #3a4553;border-radius:4px;cursor:pointer;white-space:nowrap}" +
    ".net-pin-btn:hover{background:#2f3a47;color:#fff;border-color:#4a5766}";
  document.head.appendChild(st);
}

UI.refreshNets = () => {
  _netPinStyle();
  const list = $("#net-list");
  list.innerHTML = "";
  const map = buildNetMap();
  const q = UI.netFilter.trim().toLowerCase();
  let shown = 0, total = 0;
  for (const n of State.nets){
    const pinCount = (map.get(n.id) || []).length;
    if (pinCount === 0) continue;         // hide nets with no pads (0p) — not real netlist nets
    total++;
    if (q && !n.name.toLowerCase().includes(q)) continue;
    shown++;
    const item = document.createElement("div");
    item.className = "net-item" + (UI.activeNetId === n.id ? " active" : "");
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
    // one undo entry per picker session, not one per drag tick ("input" fires
    // continuously while dragging inside the picker); markDirty keeps later ticks
    // autosave-covered since only the first one goes through pushUndo
    let colArmed = false;
    item.querySelector(".net-color").addEventListener("input", e => {
      if (!colArmed){ pushUndo("net colour"); colArmed = true; }
      n.color = e.target.value; markDirty(); requestRender();
    });
    item.querySelector(".net-color").addEventListener("change", () => { colArmed = false; });
    // hovering a net row previews it on the board (and isolates its ratsnest)
    item.addEventListener("mouseenter", ()=>{ View.hoverNetId = n.id; requestRender(); });
    item.addEventListener("mouseleave", ()=>{ if (View.hoverNetId === n.id){ View.hoverNetId = null; requestRender(); } });
    item.addEventListener("click", ()=>{
      const turnOn = UI.activeNetId !== n.id;
      UI.activeNetId = turnOn ? n.id : null;
      UI.expandedNetId = turnOn ? n.id : null;   // reveal / hide this net's per-pin buttons
      UI.refreshNets();
      if (turnOn) blinkNet(n.id); else requestRender();
    });
    item.addEventListener("dblclick", ()=>{
      if (n.protected){ UI.toast(n.name + " is a protected prefab net — it cannot be renamed"); return; }
      const name = prompt("Rename net:", n.name);
      if (name === null) return;
      pushUndo("rename net " + n.name);
      if (!renameNet(n.id, name)){ cancelUndo(); UI.toast("Rename blocked (protected net)"); }
      UI.refreshNets(); UI.refreshInspector(); requestRender();
    });
    list.appendChild(item);
    // expanded net → a button per pad on it: "REF (pin name, else pin number)"; click
    // focuses that pad on the board (selects + centres it)
    if (UI.expandedNetId === n.id){
      const grp = document.createElement("div");
      grp.className = "net-pins";
      const members = netPinMembers(n.id);
      for (const m of members){
        const label = m.name && String(m.name).trim() ? m.name : m.num;
        const b = document.createElement("button");
        b.className = "net-pin-btn";
        b.textContent = m.comp.ref + " (" + label + ")";
        b.title = "Focus " + m.comp.ref + " · pin " + m.num + (m.name ? " (" + m.name + ")" : "");
        b.addEventListener("click", e => { e.stopPropagation(); UI.focusPin(m.comp, m.pinIdx); });
        grp.appendChild(b);
      }
      if (!members.length){
        const none = document.createElement("div");
        none.className = "panel-hint"; none.style.paddingLeft = "20px";
        none.textContent = "No pads on this net";
        grp.appendChild(none);
      }
      list.appendChild(grp);
    }
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

/* ---------------- net-name autocomplete (inputs with class "net-ac") ----------------
   A KiCad-footprint-style dropdown of existing nets (plus the protected prefab names)
   that appears under any inspector net field. Picking one fills the field and fires
   input/change so the field's own handler assigns the net. */
let _nacBox = null, _nacInput = null;

/* candidate net names: real named nets that have members first, then protected prefabs */
function _nacNames(){
  const names = [], seen = new Set();
  for (const n of State.nets){
    if (n.auto || seen.has(n.name) || !netMembers(n.id).length) continue;
    seen.add(n.name); names.push(n.name);
  }
  for (const p of PROTECTED_NET_NAMES) if (!seen.has(p)){ seen.add(p); names.push(p); }
  return names;
}

function _nacStyle(){
  if (document.getElementById("nac-style")) return;
  const st = document.createElement("style");
  st.id = "nac-style";
  st.textContent =
    "#net-ac-dropdown{z-index:99999;overflow:hidden;background:#1c222b;" +
    "border:1px solid #3c4856;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.6);font-size:12px}" +
    "#net-ac-dropdown .nac-item{padding:4px 9px;color:#cdd5df;cursor:pointer;white-space:nowrap}" +
    "#net-ac-dropdown .nac-item:hover,#net-ac-dropdown .nac-item.sel{background:#2a3340;color:#fff}";
  document.head.appendChild(st);
}

function _nacHide(){
  if (_nacBox){ _nacBox.remove(); _nacBox = null; }
  _nacInput = null;
  document.removeEventListener("pointerdown", _nacOutside, true);
}
function _nacOutside(e){
  if (_nacBox && !_nacBox.contains(e.target) && e.target !== _nacInput) _nacHide();
}

function _nacShow(input){
  const q = input.value.trim().toLowerCase();
  const matches = [];
  for (const nm of _nacNames()){
    if (!q || nm.toLowerCase().includes(q)){ matches.push(nm); if (matches.length >= 10) break; }
  }
  // nothing to offer (or the only match is exactly what's typed) → no dropdown
  if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === q)){ _nacHide(); return; }
  _nacStyle();
  if (!_nacBox){
    _nacBox = document.createElement("div");
    _nacBox.id = "net-ac-dropdown";
    document.addEventListener("pointerdown", _nacOutside, true);
  }
  if (_nacBox.parentNode !== document.body) document.body.appendChild(_nacBox);
  _nacInput = input;
  _nacBox.style.width = Math.max(input.getBoundingClientRect().width, 160) + "px";
  _nacBox.innerHTML = "";
  for (const m of matches){
    const d = document.createElement("div");
    d.className = "nac-item";
    d.textContent = m;
    d.addEventListener("mousedown", e => {
      e.preventDefault();
      input.value = m;
      input.dispatchEvent(new Event("input",  { bubbles:true }));
      input.dispatchEvent(new Event("change", { bubbles:true }));
      _nacHide();
    });
    _nacBox.appendChild(d);
  }
  const ir = input.getBoundingClientRect();
  const bh = _nacBox.offsetHeight;
  const flipUp = (ir.bottom + bh + 6 > window.innerHeight) && (ir.top - bh - 6 > 0);
  _nacBox.style.position = "fixed";
  _nacBox.style.left = ir.left + "px";
  _nacBox.style.top  = (flipUp ? ir.top - bh - 2 : ir.bottom + 2) + "px";
}

UI.wireNetAutocomplete = () => {
  const isTarget = t => t && t.classList && t.classList.contains("net-ac") && !t.disabled;
  document.addEventListener("input",   e => { if (isTarget(e.target)) _nacShow(e.target); }, true);
  document.addEventListener("focusin", e => { if (isTarget(e.target)) _nacShow(e.target); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && _nacBox) _nacHide(); }, true);
};

