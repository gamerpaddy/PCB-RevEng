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

