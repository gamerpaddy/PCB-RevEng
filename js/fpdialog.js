/* ===== fpdialog.js — footprint selector dialog (categories, params, preview) ===== */
"use strict";

const FPD = { catId: "dip", params: {}, editComp: null, paramCache: {} };

/* remember the last category/params/value/part across opens */
function fpSaveLast(){
  try {
    localStorage.setItem("pcbreveng.fpLast", JSON.stringify({
      catId: FPD.catId, params: FPD.params,
      value: $("#fp-value").value, part: $("#fp-part").value, kicad: $("#fp-kicad").value
    }));
  } catch(e){}
}
function fpLoadLast(){
  try { return JSON.parse(localStorage.getItem("pcbreveng.fpLast") || "null"); } catch(e){ return null; }
}

UI.openFootprintDialog = (editComp) => {
  FPD.editComp = editComp || null;
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
    // restore the last-used category, params and value/part
    const last = fpLoadLast();
    if (last && getFootprintDef(last.catId)){
      FPD.catId = last.catId;
      FPD.params = {...last.params};
      $("#fp-value").value = last.value || "";
      $("#fp-part").value = last.part || "";
      $("#fp-kicad").value = last.kicad || "";
    }
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
  // remember the params of the category we're leaving, restore those of the one we enter
  FPD.paramCache[FPD.catId] = {...FPD.params};
  FPD.catId = id;
  FPD.params = FPD.paramCache[id] ? {...FPD.paramCache[id]} : {};
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
    inp.addEventListener(evt, ()=>{ FPD.params[prm.key] = read(prm, inp); drawFpPreview(); });
    if (prm.type !== "bool") label.appendChild(inp);
    box.appendChild(label);
    FPD.params[prm.key] = read(prm, inp);
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
}

UI.confirmFootprint = () => {
  const fp = generateFootprint(FPD.catId, FPD.params);
  if (!fp) return;
  const vals = {
    fpId: FPD.catId, fpParams: {...fp.params},
    ref: $("#fp-ref").value.trim(),
    value: $("#fp-value").value.trim(),
    part: $("#fp-part").value.trim(),
    kicad: $("#fp-kicad").value.trim() || fp.kicad,
  };
  if (!FPD.editComp) fpSaveLast(); // remember category/params/value for next time
  $("#fp-dialog").close();
  if (FPD.editComp){
    // apply changes to existing component
    pushUndo();
    const c = FPD.editComp;
    c.fpId = vals.fpId; c.fpParams = vals.fpParams; c._fp = null;
    if (vals.ref) { c.ref = vals.ref; registerRef(c.ref); }
    c.value = vals.value; c.part = vals.part; c.kicad = vals.kicad;
    // rebuild pin states, keep nets by pin number where possible
    const old = c.pins;
    const nfp = compFootprint(c);
    c.pins = nfp.pins.map(fpin => {
      const prev = old.find(p => p.num === fpin.num);
      return { num: fpin.num, name: prev?prev.name:(fpin.name||""), netId: prev?prev.netId:null };
    });
    pruneNets();
    UI.select({type:"comp", comp:c});
    UI.refreshNets(); requestRender();
  } else {
    Tools.pending = vals;
    Tools.ghostFp = fp;
    Tools.ghostSide = UI.copperSide() === "back" ? "back" : "front";
    setTool("component");
    if (vals.fpId === "chip2")
      UI.setHint("Place " + fp.label + " — click = R · Shift-click = C · Ctrl-click = L · R rotate, B flip side, Esc cancel");
    else
      UI.setHint("Click on the board to place " + fp.label + " — R rotate, B flip side, Esc cancel");
  }
  // clear for next time
  $("#fp-ref").value = ""; $("#fp-value").value = ""; $("#fp-part").value = ""; $("#fp-kicad").value = "";
  FPD.editComp = null;
};
