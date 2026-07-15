/* ===== ui/layers.js — layer panel ===== */
"use strict";

/* ---------------- layer panel ---------------- */
UI.refreshLayerList = () => {
  const list = $("#layer-list");
  list.innerHTML = "";
  const dh = $("#drop-hint");
  dh.style.display = State.layers.length ? "none" : "flex";
  if (!State.layers.length) dh.classList.remove("faded");   // show fresh; activity re-fades it
  for (const l of State.layers){
    const card = document.createElement("div");
    card.className = "layer-card" + (l.id === UI.activeLayerId ? " active" : "");
    card.innerHTML = `
      <div class="layer-head">
        <button class="vis" title="Show / hide">${l.visible ? "👁" : "—"}</button>
        <div class="name" title="${l.url ? "Hosted image — loaded live from "+escAttr(l.url)+" and NOT saved in the project" : escAttr(l.name)}">${l.url ? "🔗 " : ""}${escAttr(l.name)}</div>
        <button class="del" title="Remove layer">✕</button>
      </div>
      <div class="layer-row">
        <select class="side-sel" title="Which physical side this photo shows">${sideOptionsHtml(l.side)}</select>
        <label title="Mirror image horizontally (back-side photos usually need this so they align with the front)">
          <input type="checkbox" class="mir" ${l.mirror?"checked":""}>⇋</label>
        <label title="Lock layer against accidental dragging"><input type="checkbox" class="lock" ${l.locked?"checked":""}>🔒</label>
        <button class="repl" title="Replace this layer's image with another file — position, scale, rotation, mirror and alignment are kept">🖼⇆</button>
      </div>
      <input type="range" class="op" min="0" max="100" value="${Math.round(l.opacity*100)}" title="Opacity">`;
    card.querySelector(".side-sel").value = l.side;
    card.addEventListener("click", (e)=>{
      if (e.target.closest("button,select,input,label")) return;
      UI.activeLayerId = l.id; UI.refreshLayerList();
      if (typeof markDirty === "function") markDirty();   // persist the new active layer for reload
      UI.setDrawSide(l.side); // selecting the back image switches drawing to Back, etc.
      UI.autoXrayForLayer(l); // selecting the X-ray image turns on X-ray view
    });
    card.querySelector(".vis").addEventListener("click", ()=>{ l.visible = !l.visible; UI.refreshLayerList(); requestRender(); });
    card.querySelector(".del").addEventListener("click", ()=>{
      if (!confirm("Remove layer “" + l.name + "”?")) return;
      State.layers = State.layers.filter(x => x !== l);
      if (UI.activeLayerId === l.id) UI.activeLayerId = State.layers[0]?.id ?? null;
      if (typeof markImagesDirty === "function") markImagesDirty();
      UI.refreshLayerList(); requestRender();
    });
    card.querySelector(".side-sel").addEventListener("change", (e)=>{
      const was = l.side;
      l.side = e.target.value;
      // back photos are mirrored by default (only while not yet warped/aligned)
      if (!l.warp){
        if (l.side === "back" && was !== "back" && !l.mirror){
          l.mirror = true; UI.toast("Layer mirrored ⇋ (back-side photo default)");
        } else if (was === "back" && l.side !== "back" && l.mirror){
          l.mirror = false;
        }
      }
      UI.setDrawSide(l.side);
      UI.refreshLayerList(); requestRender();
    });
    card.querySelector(".mir").addEventListener("change", (e)=>{
      l.mirror = e.target.checked;
      if (l.warp){ // warped layers mirror in image space: W · diag(-1,1)
        l.warp = { a:-l.warp.a, b:-l.warp.b, c:l.warp.c, d:l.warp.d };
      }
      requestRender();
    });
    card.querySelector(".lock").addEventListener("change", (e)=>{ l.locked = e.target.checked; });
    card.querySelector(".repl").addEventListener("click", (e)=>{
      UI.showContextMenu(e.clientX, e.clientY, [
        { label:"Replace from file…", action:()=>{
            UI._replaceLayerId = l.id;
            $("#file-layer-replace").click();
          } },
        { label:"Replace from URL… (loaded live, not saved)", action:()=>{
            UI.openUrlDialog((u)=> replaceLayerImageFromURL(l, u));
          } },
      ]);
    });
    card.querySelector(".op").addEventListener("input", (e)=>{ l.opacity = e.target.value/100; requestRender(); });
    list.appendChild(card);
  }
  UI.refreshXrayBtn();
  UI.refreshSplitControls();   // keep the split-view layer dropdowns in sync with the layer list
};

