/* ===== ui/nets.js — net list ===== */
"use strict";

/* ---------------- net list ---------------- */
UI.netFilter = "";
UI.refreshNets = () => {
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
    item.querySelector(".net-color").addEventListener("input", e => {
      pushUndo("net colour"); n.color = e.target.value; requestRender();
    });
    // hovering a net row previews it on the board (and isolates its ratsnest)
    item.addEventListener("mouseenter", ()=>{ View.hoverNetId = n.id; requestRender(); });
    item.addEventListener("mouseleave", ()=>{ if (View.hoverNetId === n.id){ View.hoverNetId = null; requestRender(); } });
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
      if (!renameNet(n.id, name)){ cancelUndo(); UI.toast("Rename blocked (protected net)"); }
      UI.refreshNets(); UI.refreshInspector(); requestRender();
    });
    list.appendChild(item);
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

