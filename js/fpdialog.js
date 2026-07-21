/* ===== fpdialog.js — footprint selector dialog (categories, params, preview) ===== */
"use strict";

const FPD = { catId: "dip", params: {}, editComp: null, paramCache: {}, fieldCache: {} };

/* the dialog's text fields, cached PER CATEGORY (value/part/kicad/ref/symbol travel
   with the footprint category instead of leaking from one category into the next) */
function fpFields(){
  return { value: $("#fp-value").value, part: $("#fp-part").value,
           kicad: $("#fp-kicad").value, ref: $("#fp-ref").value, sym: FPD.symOverride };
}
function fpSetFields(f){
  f = f || {};
  $("#fp-value").value = f.value || "";
  $("#fp-part").value  = f.part  || "";
  $("#fp-kicad").value = f.kicad || "";
  $("#fp-ref").value   = f.ref   || "";
  FPD.symOverride = f.sym || "auto";
}

/* remember the last category + per-category params/fields across opens */
function fpSaveLast(){
  try {
    FPD.fieldCache[FPD.catId] = fpFields();
    FPD.paramCache[FPD.catId] = {...FPD.params};
    localStorage.setItem("pcbreveng.fpLast", JSON.stringify({
      catId: FPD.catId, params: FPD.params, fields: FPD.fieldCache
    }));
  } catch(e){}
}
function fpLoadLast(){
  try { return JSON.parse(localStorage.getItem("pcbreveng.fpLast") || "null"); } catch(e){ return null; }
}

UI.openFootprintDialog = (editComp) => {
  FPD.editComp = editComp || null;
  FPD.symOverride = editComp ? (editComp.symOverride || "auto") : "auto";
  // wire the schematic-symbol picker once (the <select> is static; its options are rebuilt)
  if (!FPD._symWired){
    const s = $("#fp-sym");
    if (s){ s.addEventListener("change", e => { FPD.symOverride = e.target.value; }); FPD._symWired = true; }
  }
  const dlg = $("#fp-dialog");
  if (editComp){
    FPD.catId = editComp.fpId;
    FPD.params = {...editComp.fpParams};
    $("#fp-ref").value = editComp.ref;
    $("#fp-value").value = editComp.value;
    $("#fp-part").value = editComp.part;
    $("#fp-kicad").value = editComp.kicad;
    $("#fp-ok").textContent = "Apply to " + editComp.ref;
  } else {
    // restore the last-used category, its params and the per-category text fields
    const last = fpLoadLast();
    if (last){
      if (last.fields) FPD.fieldCache = last.fields;
      else if (last.value || last.part || last.kicad)   // migrate the old single-set format
        FPD.fieldCache[last.catId] = { value: last.value, part: last.part, kicad: last.kicad };
      if (getFootprintDef(last.catId)){
        FPD.catId = last.catId;
        FPD.params = {...last.params};
      }
    }
    fpSetFields(FPD.fieldCache[FPD.catId]);
    $("#fp-ref").value = ""; // auto-numbered, increments per placement
    $("#fp-ok").textContent = "Place (click on board)";
  }
  buildFpCats();
  buildFpParams();
  dlg.showModal();
  // the preview canvas can only measure its (flex-sized) box once the dialog is
  // actually laid out — redraw now so the first open isn't squished/low-res
  drawFpPreview();
};

function buildFpCats(){
  const box = $("#fp-cats");
  box.innerHTML = "";
  Footprints.catalog.forEach((def, i) => {
    const b = document.createElement("button");
    // quick-select keys: 1–9 first nine, Shift+1–9 next nine, Ctrl+1–9 the rest
    const key = i < 9 ? String(i+1) : i < 18 ? "⇧" + (i-8) : i < 27 ? "^" + (i-17) : "";
    b.innerHTML = (key ? `<kbd class="catkey">${key}</kbd>` : "") + escAttr(def.name);
    b.classList.toggle("active", def.id === FPD.catId);
    b.addEventListener("click", ()=>{ selectFpCat(def.id); });
    box.appendChild(b);
  });
  // keep the selected category visible (e.g. when picked via number-key hotkey)
  box.querySelector("button.active")?.scrollIntoView({ block: "nearest" });
}

/* pick a footprint category by id (shared by click + number-key shortcuts) */
function selectFpCat(id){
  if (!getFootprintDef(id) || id === FPD.catId) return;
  // remember the params AND text fields (value/part/kicad/ref/symbol) of the category
  // we're leaving, restore those of the one we enter — every setting is per category
  FPD.paramCache[FPD.catId] = {...FPD.params};
  if (!FPD.editComp) FPD.fieldCache[FPD.catId] = fpFields();
  FPD.catId = id;
  FPD.params = FPD.paramCache[id] ? {...FPD.paramCache[id]} : {};
  if (!FPD.editComp) fpSetFields(FPD.fieldCache[id]);
  buildFpCats(); buildFpParams();
}

/* keyboard category shortcuts while the footprint dialog is open:
   1–9 → first nine, Shift+1–9 → next nine, Ctrl+1–9 → the rest */
function fpDialogKey(e){
  // Enter (from anywhere, including the text fields) = activate the Place / Apply button
  if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey){
    e.preventDefault();
    UI.confirmFootprint();
    return;
  }
  if (e.altKey || e.metaKey) return;
  if (e.ctrlKey && e.shiftKey) return; // reserve combined modifiers
  // don't steal digits the user is typing into ref/value/part/kicad fields
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
  // key off the physical digit (e.code), not e.key — with Shift held, e.key is the
  // shifted symbol (!, /, …), which also triggers Firefox's "/" quick-find
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (!m) return;
  const base = e.ctrlKey ? 18 : e.shiftKey ? 9 : 0;
  const def = Footprints.catalog[base + (+m[1] - 1)];
  if (!def) return;
  e.preventDefault(); // note: Ctrl+1–9 is Firefox's tab-switch and may not be suppressible
  selectFpCat(def.id);
}

function buildFpParams(){
  const def = getFootprintDef(FPD.catId);
  const box = $("#fp-params");
  box.innerHTML = "";
  const read = (prm, inp) => prm.type === "bool" ? inp.checked
                           : prm.type === "int" ? (parseInt(inp.value,10)||prm.def)
                           : inp.value;
  for (const prm of def.params){
    // a param may hide itself based on the others (e.g. Hole Ø only when Through-hole is on)
    if (prm.showIf && !prm.showIf(FPD.params)) continue;
    const label = document.createElement("label");
    let inp;
    if (prm.type === "select"){
      label.textContent = prm.label;
      inp = document.createElement("select");
      for (const o of prm.options){
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o;
        inp.appendChild(opt);
      }
      inp.value = FPD.params[prm.key] !== undefined ? FPD.params[prm.key] : prm.def;
    } else if (prm.type === "bool"){
      label.classList.add("fp-check");
      inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = FPD.params[prm.key] !== undefined ? !!FPD.params[prm.key] : !!prm.def;
      label.appendChild(inp);
      label.appendChild(document.createTextNode(" " + prm.label));
    } else {
      label.textContent = prm.label;
      inp = document.createElement("input");
      inp.type = "number"; inp.min = prm.min; inp.max = prm.max; inp.step = prm.step;
      inp.value = FPD.params[prm.key] !== undefined ? FPD.params[prm.key] : prm.def;
    }
    const evt = prm.type === "bool" ? "change" : "input";
    // `rebuilds` params (e.g. the THT toggle) re-render the whole panel so dependent
    // fields (Hole Ø) appear/disappear; others just redraw the preview
    inp.addEventListener(evt, ()=>{ FPD.params[prm.key] = read(prm, inp); if (prm.rebuilds) buildFpParams(); else drawFpPreview(); });
    if (prm.type !== "bool") label.appendChild(inp);
    box.appendChild(label);
    FPD.params[prm.key] = read(prm, inp);
  }
  // universal SMD pad tuning — scale every pad, and stretch pads along their length
  // (radially outward). Hidden for THT footprints, where it has no effect.
  // a single-pad test point sizes itself straight from its diameter field (like a via),
  // so the scale/length pad-tuning multipliers don't apply to it
  const probe = generateFootprint(FPD.catId, FPD.params);
  if (isSmdFootprint(probe) && FPD.catId !== "pad1"){
    const grp = document.createElement("div");
    grp.className = "fp-pad-tune";
    grp.innerHTML = `<div class="fp-pad-tune-h">SMD pad tuning</div>`;
    const mk = (key, text, def) => {
      const label = document.createElement("label");
      label.textContent = text;
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "0.3"; inp.max = "4"; inp.step = "0.05";
      inp.value = FPD.params[key] !== undefined ? FPD.params[key] : def;
      inp.addEventListener("input", ()=>{
        const v = parseFloat(inp.value); FPD.params[key] = (isFinite(v) && v > 0) ? v : def; drawFpPreview();
      });
      label.appendChild(inp);
      grp.appendChild(label);
      if (FPD.params[key] === undefined) FPD.params[key] = def;
    };
    mk("padScale", "Pad scale ×", 1);
    mk("padLen",   "Pad length ×", 1);
    box.appendChild(grp);
  }

  // Custom (imported) category: import .kicad_mod files + manage the stored list
  if (FPD.catId === "customfp"){
    const grp = document.createElement("div");
    grp.className = "fp-custom-box";
    const imp = document.createElement("button");
    imp.type = "button"; imp.textContent = "Import .kicad_mod…";
    imp.title = "Import KiCad footprint files — they are retained in this browser and searchable in quick-add as custom:<name>";
    imp.addEventListener("click", () => $("#file-customfp").click());
    grp.appendChild(imp);
    // AI footprint maker (experimental) — describe a part, get a generated .kicad_mod
    if (typeof AI !== "undefined" && AI.enabled("footprint")){
      const aiBox = document.createElement("div");
      aiBox.className = "fp-custom-row";
      aiBox.style.cssText = "flex-direction:column;align-items:stretch;gap:4px;margin:6px 0;padding:6px;border:1px solid #3a2f22;border-radius:5px";
      const lbl = document.createElement("div");
      lbl.className = "panel-hint"; lbl.style.color = "#e0a94a";
      lbl.textContent = "🤖 AI footprint maker (very experimental) — describe the part:";
      const ta = document.createElement("input");
      ta.type = "text"; ta.placeholder = "e.g. USB-C SMD 629722000214";
      ta.style.cssText = "width:100%;box-sizing:border-box";
      const go = document.createElement("button");
      go.type = "button"; go.textContent = "Generate footprint";
      const st = document.createElement("span"); st.className = "panel-hint";
      go.addEventListener("click", async () => {
        const prompt = ta.value.trim();
        if (!prompt){ st.textContent = "Type a description first"; return; }
        st.textContent = "Generating…";
        try {
          const mod = await AI.makeFootprint(prompt);
          const nm = (prompt.replace(/[^\w -]+/g, "").trim().slice(0, 40) || "AI part");
          const entry = CustomFPs.importKicadMod(nm + ".kicad_mod", mod);
          if (entry){ FPD.params.name = entry.name; st.textContent = "✓ " + entry.name + " (" + entry.pins.length + " pads)"; buildFpParams(); }
          else st.textContent = "⚠ Generated text had no pads";
        } catch(err){ st.textContent = "⚠ " + err.message; }
      });
      aiBox.appendChild(lbl); aiBox.appendChild(ta); aiBox.appendChild(go); aiBox.appendChild(st);
      grp.appendChild(aiBox);
    }
    for (const f of CustomFPs.list()){
      const row = document.createElement("div");
      row.className = "fp-custom-row";
      const b = document.createElement("button");
      b.type = "button"; b.textContent = f.name; b.title = "Select " + f.name;
      b.classList.toggle("active", FPD.params.name === f.name);
      b.addEventListener("click", () => { FPD.params.name = f.name; buildFpParams(); });
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "✕"; del.className = "fp-custom-del";
      const used = CustomFPs.usedBy(f.name).length;
      del.title = used ? "In use by " + used + " placed part" + (used>1?"s":"") + " — can't delete" : "Delete this custom footprint";
      del.addEventListener("click", () => { if (CustomFPs.remove(f.name)){ UI.toast("Deleted custom footprint " + f.name); buildFpParams(); } });
      row.appendChild(b); row.appendChild(del);
      grp.appendChild(row);
    }
    if (!CustomFPs.list().length){
      const hint = document.createElement("div");
      hint.className = "panel-hint";
      hint.textContent = "No custom footprints yet — import KiCad .kicad_mod files. Quick-add finds them via custom:<name>.";
      grp.appendChild(hint);
    }
    box.appendChild(grp);
  }

  // Freestyle: quick-select from the freestyle parts already placed on the board —
  // clicking copies that part's pad layout into the params (place a twin)
  if (FPD.catId === "free"){
    const placed = State.components.filter(c => c.fpId === "free" && c.fpParams && (c.fpParams.pinList || []).length);
    if (placed.length){
      const grp = document.createElement("div");
      grp.className = "fp-custom-box";
      const h = document.createElement("div");
      h.className = "fp-pad-tune-h"; h.textContent = "Placed freestyle parts";
      grp.appendChild(h);
      for (const c of placed.slice(0, 30)){
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = c.ref + " · " + (c.fpParams.pinList.length) + " pads" + (c.value ? " · " + c.value : "");
        b.title = "Copy " + c.ref + "'s pad layout as the new part";
        b.addEventListener("click", () => {
          FPD.params = { w: c.fpParams.w, h: c.fpParams.h, pinList: JSON.parse(JSON.stringify(c.fpParams.pinList)) };
          $("#fp-value").value = c.value || ""; $("#fp-part").value = c.part || ""; $("#fp-kicad").value = c.kicad || "";
          buildFpParams();
        });
        grp.appendChild(b);
      }
      box.appendChild(grp);
    }
  }

  // R/C/L chip: spell out the modifier-click → refdes mapping right in the dialog
  if (FPD.catId === "chip2"){
    const note = document.createElement("div");
    note.className = "fp-rcl-note";
    note.innerHTML = "Reference set by how you click the board:" +
      "<span><b>click</b> = R</span><span><kbd>Shift</kbd>+click = C</span><span><kbd>Ctrl</kbd>+click = L</span>";
    box.appendChild(note);
  }
  drawFpPreview();
}

function drawFpPreview(){
  const fp = generateFootprint(FPD.catId, FPD.params);
  const cv = $("#fp-preview"), ctx = cv.getContext("2d");
  // match the drawing buffer to the (flex-sized) CSS box so the preview stays crisp
  // and uses the enlarged dialog's space; fall back to the attribute size pre-layout
  const cssW = Math.round(cv.clientWidth), cssH = Math.round(cv.clientHeight);
  if (cssW > 0 && cv.width  !== cssW) cv.width  = cssW;
  if (cssH > 0 && cv.height !== cssH) cv.height = cssH;
  ctx.clearRect(0,0,cv.width,cv.height);
  if (!fp) return;
  let ext = Math.max(fp.body.w, fp.body.h)/2;
  for (const p of fp.pins) ext = Math.max(ext, Math.hypot(p.xmm,p.ymm)+Math.max(p.w,p.h));
  const s = Math.min(cv.width, cv.height) / (ext*2.4);
  const cx = cv.width/2, cy = cv.height/2;

  // grid: 1 mm lines (mm mode) or 50 mil lines (mil mode), bolder every 5th
  const mil = UI.unit() === "mil";
  const gridMm = mil ? 50*0.0254 : 1;   // 50 mil ≈ 1.27 mm
  const step = s * gridMm;
  ctx.lineWidth = 1;
  const nx = Math.ceil(cv.width/2/step), ny = Math.ceil(cv.height/2/step);
  for (let i=-Math.max(nx,ny); i<=Math.max(nx,ny); i++){
    const major = (i % 5 === 0);
    ctx.strokeStyle = major ? "#2c3540" : "#1c222b";
    ctx.beginPath(); ctx.moveTo(cx+i*step, 0); ctx.lineTo(cx+i*step, cv.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cy+i*step); ctx.lineTo(cv.width, cy+i*step); ctx.stroke();
  }
  // axes
  ctx.strokeStyle = "#3a4654";
  ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,cv.height); ctx.moveTo(0,cy); ctx.lineTo(cv.width,cy); ctx.stroke();

  ctx.save();
  ctx.translate(cx, cy);
  drawFootprintShape(ctx, fp, s, {});
  ctx.restore();
  ctx.fillStyle = "#8b96a5"; ctx.font = "11px Segoe UI";
  ctx.fillText(fp.label + " · " + fp.pins.length + " pins · grid " + (mil ? "50 mil" : "1 mm"), 6, cv.height-6);
  ctx.fillText(mil
    ? (fp.body.w/0.0254).toFixed(0) + "×" + (fp.body.h/0.0254).toFixed(0) + " mil"
    : fp.body.w.toFixed(1) + "×" + fp.body.h.toFixed(1) + " mm", 6, 14);
  $("#fp-kicad").placeholder = fp.kicad || "lib:name";
  buildFpSymRow(fp);
}

/* populate the "Schematic symbol" picker from the current footprint's pin count — the symbol
   options depend on how many pins the (live) footprint has, so it rebuilds on every change.
   Hidden when no symbol fits the pin count. */
function buildFpSymRow(fp){
  const row = $("#fp-sym-row"), sel = $("#fp-sym");
  if (!row || !sel) return;
  const n = fp ? fp.pins.length : 0;
  const kinds = symKindsForPinCount(n);
  if (!kinds.length){ row.style.display = "none"; return; }
  const cur = FPD.symOverride || "auto";
  sel.innerHTML = [`<option value="auto"${cur==="auto"?" selected":""}>Auto (detect)</option>`]
    .concat(kinds.map(k => `<option value="${k}"${cur===k?" selected":""}>${SYM_LABELS[k]}</option>`))
    .concat(`<option value="box"${cur==="box"?" selected":""}>Box / IC (generic)</option>`)
    .join("");
  row.style.display = "";
}

/* custom-footprint import file input (Custom category's Import… button) */
window.addEventListener("DOMContentLoaded", () => {
  const inp = $("#file-customfp");
  if (!inp) return;
  inp.addEventListener("change", async () => {
    let last = null, n = 0;
    for (const f of inp.files){
      try {
        const entry = CustomFPs.importKicadMod(f.name, await f.text());
        if (entry){ last = entry; n++; }
      } catch(e){ UI.toast("Could not read " + f.name); }
    }
    inp.value = "";
    if (!n) return;
    UI.toast("Imported " + n + " custom footprint" + (n>1?"s":"") + " — quick-add: custom:" + last.name);
    if ($("#fp-dialog").open && FPD.catId === "customfp"){ FPD.params.name = last.name; buildFpParams(); }
  });
});

UI.confirmFootprint = () => {
  const fp = generateFootprint(FPD.catId, FPD.params);
  if (!fp) return;
  // "auto" (or unset) → no override; a concrete kind / "box" is stored on the component
  const symOv = (!FPD.symOverride || FPD.symOverride === "auto") ? null : FPD.symOverride;
  const vals = {
    fpId: FPD.catId, fpParams: {...fp.params},
    ref: $("#fp-ref").value.trim(),
    value: $("#fp-value").value.trim(),
    part: $("#fp-part").value.trim(),
    kicad: $("#fp-kicad").value.trim() || fp.kicad,
    symOverride: symOv,
  };
  if (!FPD.editComp) fpSaveLast(); // remember category/params/value for next time
  $("#fp-dialog").close();
  if (FPD.editComp){
    // apply changes to existing component
    pushUndo();
    const c = FPD.editComp;
    c.fpId = vals.fpId; c.fpParams = vals.fpParams; c._fp = null;
    c.value = vals.value; c.part = vals.part; c.kicad = vals.kicad;
    c.symOverride = vals.symOverride;
    // rebuild pin states, keep nets + no-connect flags by pin number where possible
    const old = c.pins;
    const nfp = compFootprint(c);
    c.pins = nfp.pins.map(fpin => {
      const prev = old.find(p => p.num === fpin.num);
      return { num: fpin.num, name: prev?prev.name:(fpin.name||""), netId: prev?prev.netId:null,
               nc: prev ? prev.nc : undefined };
    });
    // a concrete symbol pick fills in its standard pin names (nets/NC preserved above)
    if (vals.symOverride && vals.symOverride !== "box") applySymPinNames(c, vals.symOverride);
    pruneNets();
    UI.select({type:"comp", comp:c});
    UI.refreshNets(); requestRender();
    // rename goes through the central path so a duplicate reference prompts (abort/swap)
    if (vals.ref && vals.ref !== c.ref) UI.commitRename(c, vals.ref, true);
  } else {
    Tools.pending = vals;
    Tools.ghostFp = fp;
    Tools.ghostSide = UI.copperSide() === "back" ? "back" : "front";
    // fresh placement always starts at a straight 0/90/180/270 — snap any leftover
    // free angle from the rotate gizmo (or a prior paste) so R keeps everything aligned
    Tools.ghostRot = ((Math.round((Tools.ghostRot || 0) / 90) * 90) % 360 + 360) % 360;
    setTool("component");
    if (vals.fpId === "chip2")
      UI.setHint("Place " + fp.label + " — click = R · Shift-click = C · Ctrl-click = L · R rotate, B flip side, Esc cancel");
    else
      UI.setHint("Click on the board to place " + fp.label + " — R rotate, B flip side, Esc cancel");
  }
  // only the reference clears (auto-numbered); value/part/kicad/symbol stay with the category
  $("#fp-ref").value = "";
  FPD.editComp = null;
};
