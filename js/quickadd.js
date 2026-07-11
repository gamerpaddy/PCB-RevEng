/* ===== quickadd.js — experimental "quick component" popup =====
   With the component tool active (C) and no footprint armed, clicking the board opens
   a small popup: a preview of the clicked area + a text field. Type things like
   "sot-23 npn", "sot23 npn 2n2222" (npn = value, 2n2222 = part), "ic sot23 ref30"
   (U prefix + generic box symbol), "soic14 74hc130", "0805 10k", "cap 0603 10n",
   "to-220-5" / "to220 5pin", "to92 triangle", "free 4.5x5" (freestyle body) and it
   resolves footprint / value / part / refdes prefix, live-previewing the ghost.
   Arrow keys nudge (the preview stays centred on the part — the board scrolls under
   it and is re-cropped every move), rotate/place keys are in the hotkey editor. */
"use strict";

const QuickAdd = {
  active: false, pos: null, side: "front", rot: 0,
  fp: null, parsed: null,
};

/* experimental toggle (Lab dialog), off by default, retained in localStorage */
QuickAdd.enabled = () => { try { return localStorage.getItem("pcbreveng.quickAdd") === "on"; } catch(e){ return false; } };

/* ---------------- query parser ---------------- */

const QA_CHIP_SIZES = ["0201","0402","0406","0603","0612","0805","1206","1210","2010","2512"];

// component-type keywords → refdes prefix (+ optional schematic symbol override).
// `val:true` = the keyword itself becomes the value (semiconductors: "npn", "diode"…),
// and value-ish tokens ("2n3337") are treated as PART NUMBERS, not values.
const QA_TYPES = [
  [/^(res|resistor|rs)$/, {prefix:"R"}],
  [/^(cap|capacitor|kondensator)$/, {prefix:"C"}],
  [/^(ind|inductor|coil|choke|ferrite|fb)$/, {prefix:"L"}],
  [/^npn$/, {prefix:"Q", sym:"npn", val:true}],
  [/^pnp$/, {prefix:"Q", sym:"pnp", val:true}],
  [/^(nmos|nfet|n-mos|n-fet)$/, {prefix:"Q", sym:"nmos", val:true}],
  [/^(pmos|pfet|p-mos|p-fet)$/, {prefix:"Q", sym:"pmos", val:true}],
  [/^(mosfet|fet|transistor|trans|tr)$/, {prefix:"Q", val:true}],
  [/^(diode|di)$/, {prefix:"D", sym:"diode", val:true}],
  [/^led$/, {prefix:"D", sym:"led", val:true}],
  [/^zener$/, {prefix:"D", sym:"zener", val:true}],
  [/^(schottky|sk)$/, {prefix:"D", sym:"schottky", val:true}],
  [/^(xtal|crystal|resonator|osc)$/, {prefix:"Y"}],
  [/^(ic|u|box|generic)$/, {prefix:"U", sym:"box"}],   // generic IC → U prefix + plain box symbol
];

// a value-ish token: 10k, 4k7, 100n, 1u, 0R, 223, 10uF, 4.7k, 1M2 …
function qaLooksLikeValue(t){
  return /^[0-9]+(\.[0-9]+)?[rkmnpuµ]?[0-9]*f?$/i.test(t) && /[0-9]/.test(t);
}

/* map one token → {fpId, params, label} footprint, or null */
function qaMatchFootprint(t){
  const s = t.toLowerCase();
  const num = (re) => { const m = re.exec(s); return m ? parseInt(m[1],10) : null; };

  if (QA_CHIP_SIZES.includes(s)) return { fpId:"chip2", params:{size:s} };

  // SOT-23 family (optional pin-count suffix: sot23-5 / sot-23-5 / sot235)
  let m;
  if ((m = /^sot-?23(?:-?([356]))?$/.exec(s))) return { fpId:"sot23", params:{pkg:"SOT-23", pins:m[1]||"3"} };
  if (/^sot-?323$/.test(s)) return { fpId:"sot23", params:{pkg:"SOT-323"} };
  if (/^sot-?523$/.test(s)) return { fpId:"sot23", params:{pkg:"SOT-523"} };
  if (/^sot-?723$/.test(s)) return { fpId:"sot23", params:{pkg:"SOT-723"} };
  if (/^sot-?223$/.test(s)) return { fpId:"sot223", params:{pkg:"SOT-223"} };
  if (/^sot-?89$/.test(s))  return { fpId:"sot223", params:{pkg:"SOT-89"} };
  if (/^(dpak|to-?252)$/.test(s)) return { fpId:"sot223", params:{pkg:"DPAK (TO-252)"} };

  if ((m = /^sod-?(523|323|123|80)$/.exec(s))) return { fpId:"sod", params:{pkg:"SOD-"+m[1]} };
  if (/^sm[abc]$/.test(s)) return { fpId:"sod", params:{pkg:s.toUpperCase()} };

  if (/^to-?92$/.test(s)) return { fpId:"to92", params:{} };
  // TO-220 / TO-247 with optional pin count: to220-5 / to-220-5 / to2205
  if ((m = /^to-?(220|247)(?:-?([235]))?$/.exec(s))) return { fpId:"to220", params: m[2]?{pins:m[2]}:{} };

  if ((m = /^(?:soic|so|sop)-?(\d+)$/.exec(s))) return { fpId:"soic", params:{pins:+m[1]} };
  if ((m = /^tssop-?(\d+)$/.exec(s))) return { fpId:"soic", params:{pins:+m[1], pitch:"0.65", width:"4.4"} };
  if ((m = /^msop-?(\d+)$/.exec(s))) return { fpId:"soic", params:{pins:+m[1], pitch:"0.5", width:"3.0"} };
  if ((m = /^(?:dip|pdip)-?(\d+)$/.exec(s))) return { fpId:"dip", params:{pins:+m[1]} };
  if ((m = /^(?:lqfp|tqfp|qfp)-?(\d+)$/.exec(s))) return { fpId:"qfp", params:{pins:+m[1], style:"QFP"} };
  if ((m = /^qfn-?(\d+)$/.exec(s))) return { fpId:"qfp", params:{pins:+m[1], style:"QFN"} };
  if ((m = /^bga-?(\d+)x(\d+)$/.exec(s))) return { fpId:"grid", params:{rows:+m[2], cols:+m[1]} };
  if ((m = /^bga-?(\d+)$/.exec(s))){ const n = Math.round(Math.sqrt(+m[1])); return { fpId:"grid", params:{rows:n, cols:n} }; }
  if (/^bga$/.test(s)) return { fpId:"grid", params:{} };

  if ((m = /^melf-?(0102|0204|0207)?$/.exec(s))) return { fpId:"melf", params: m[1]?{size:m[1]}:{} };
  if (/^axial$/.test(s)) return { fpId:"axial", params:{} };
  if (/^(radial)$/.test(s)) return { fpId:"radial", params:{} };
  if (/^(ecap|e-cap|electrolytic|elec)$/.test(s)) return { fpId:"ecap_smd", params:{} };
  if ((m = /^(?:sip|hdr|header)-?(\d+)?$/.exec(s))) return { fpId:"sip", params: m[1]?{pins:+m[1]}:{} };
  if (/^(xtal|crystal|resonator|osc)$/.test(s)) return { fpId:"crystal", params:{} };
  // freestyle component, optional body size: free / free4x5 / free-4.5x5
  if ((m = /^free(?:-?(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?))?$/.exec(s)))
    return { fpId:"free", params: m[1]?{w:parseFloat(m[1]), h:parseFloat(m[2])}:{} };
  return null;
}

/* package-modifier tokens applied AFTER the footprint is known (pin counts, lead form,
   freestyle body size). Returns true when the token was consumed. */
function qaApplyModifier(fp, t){
  const s = t.toLowerCase();
  let m;
  // pin count as its own token: "5pin" / "5p" / "14pins" — for any footprint with a pins param
  if ((m = /^(\d+)(?:p|pin|pins)$/.exec(s))){
    const def = getFootprintDef(fp.fpId);
    const pr = def && def.params.find(p => p.key === "pins");
    if (pr){ fp.params.pins = pr.type === "select" ? String(+m[1]) : +m[1]; return true; }
    return false;
  }
  // TO-92 lead form: "tri" / "triangle" / "wide" vs "inline" / "straight"
  if (fp.fpId === "to92"){
    if (/^(tri|triangle|wide)$/.test(s)){ fp.params.layout = "Triangle"; return true; }
    if (/^(inline|line|straight)$/.test(s)){ fp.params.layout = "Inline"; return true; }
  }
  // freestyle body size as its own token: "4x5" / "4.5x5"
  if (fp.fpId === "free" && (m = /^(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?)$/.exec(s))){
    fp.params.w = parseFloat(m[1]); fp.params.h = parseFloat(m[2]);
    return true;
  }
  return false;
}

/* parse the whole query → placement values, or null if nothing recognised.
   Two passes: 1) find the footprint + type keyword anywhere in the query,
   2) classify the remaining tokens (modifiers / pitch / value / part) with that context. */
function parseQuickQuery(str){
  const toks = (str||"").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  let fp = null, type = null;
  const rest = [];
  for (const t of toks){
    if (!fp){ const f = qaMatchFootprint(t); if (f){ fp = f; continue; } }
    if (!type){
      let hit = null;
      for (const [re, info] of QA_TYPES) if (re.test(t.toLowerCase())){ hit = {...info, tok:t.toLowerCase()}; break; }
      if (hit){ type = hit; continue; }
    }
    rest.push(t);
  }

  // semiconductors (Q/D) don't have R/C-style values: value-ish tokens ("2n3337") are
  // part numbers there, and the type keyword itself becomes the value ("npn", "diode")
  const semi = !!(type && type.val);
  let value = "", pitchMm = null, partParts = [];
  for (const t of rest){
    if (fp && qaApplyModifier(fp, t)) continue;   // "5pin", "triangle", "4.5x5" …
    // a pitch token: 1mm / 0.8mm / 50mil (applied to footprints that have a pitch param)
    let pm;
    if (pitchMm === null && (pm = /^(\d+(?:\.\d+)?)(mm|mil)$/i.exec(t))){
      pitchMm = pm[2].toLowerCase() === "mil" ? parseFloat(pm[1]) * 0.0254 : parseFloat(pm[1]);
      continue;
    }
    if (!value && !semi && qaLooksLikeValue(t)){ value = t; continue; }
    partParts.push(t);   // leftover = part number / free text
  }
  if (type && type.val) value = type.tok;   // "npn" / "diode" / "led" … as the value
  if (!fp && !type && !value && pitchMm === null && !partParts.length) return null;

  // fall back to a sensible footprint if only a value/type was given
  if (!fp){
    if (type && (type.prefix === "R" || type.prefix === "C" || type.prefix === "L")) fp = { fpId:"chip2", params:{size:"0805"} };
    else if (type && (type.prefix === "Q")) fp = { fpId:"sot23", params:{} };
    else if (type && type.prefix === "D") fp = { fpId:"sod", params:{} };
    else if (type && type.prefix === "Y") fp = { fpId:"crystal", params:{} };
    else if (value) fp = { fpId:"chip2", params:{size:"0805"} };
    else fp = { fpId:"soic", params:{} };
  }

  const def = getFootprintDef(fp.fpId);
  // apply a parsed pitch to any footprint that exposes a "pitch" param (grid/soic/qfp/sip…)
  if (pitchMm !== null && def && def.params.some(pr => pr.key === "pitch")){
    const pr = def.params.find(p => p.key === "pitch");
    if (pr.type === "select" && pr.options){
      // snap to the nearest offered option (e.g. 1mm → "1.0")
      let best = pr.options[0], bd = Infinity;
      for (const o of pr.options){ const d = Math.abs(parseFloat(o) - pitchMm); if (d < bd){ bd = d; best = o; } }
      fp.params.pitch = best;
    } else {
      fp.params.pitch = pitchMm;
    }
  }
  let prefix = type ? type.prefix : (def && def.prefix) || "U";
  // chip2 with a plain value but no explicit type: resistor by default (matches board convention)
  const sym = type ? (type.sym || null) : null;

  // resolve bare resistor codes (223 → 22k) only for resistors
  let val = value;
  if (val && prefix === "R" && typeof autoResolveValue === "function") val = autoResolveValue(val);

  return {
    fpId: fp.fpId, params: fp.params, prefix,
    value: val, part: partParts.join(" "), symOverride: sym,
  };
}

/* ---------------- popup ---------------- */

QuickAdd.open = (w) => {
  QuickAdd.active = true;
  QuickAdd.pos = { x:w.x, y:w.y };
  QuickAdd.side = Tools.ghostSide || (UI.copperSide() === "back" ? "back" : "front");
  QuickAdd.rot = Tools.ghostRot || 0;
  QuickAdd.fp = null; QuickAdd.parsed = null;
  const inp = $("#qa-input");
  inp.value = "";
  $("#qa-info").textContent = QA_PROMPT;
  $("#qa-info").className = "qa-info";
  QuickAdd.updateInfo();
  $("#qa-dialog").showModal();
  QuickAdd.render();
  requestRender();
  inp.focus(); inp.select();
  requestAnimationFrame(() => { inp.focus(); QuickAdd.render(); });  // ensure focus + correct preview size after layout
};

QuickAdd.close = () => {
  QuickAdd.active = false; QuickAdd.fp = null; QuickAdd.parsed = null;
  const d = $("#qa-dialog"); if (d.open) d.close();
  requestRender();
};

QuickAdd.update = () => {
  const parsed = parseQuickQuery($("#qa-input").value);
  QuickAdd.parsed = parsed;
  const info = $("#qa-info");
  if (!parsed){
    QuickAdd.fp = null;
    info.textContent = $("#qa-input").value.trim() ? "not recognised — keep typing…" : QA_PROMPT;
    info.className = "qa-info";
    QuickAdd.updateInfo();
    QuickAdd.render(); requestRender(); return;
  }
  const fp = generateFootprint(parsed.fpId, parsed.params);
  QuickAdd.fp = fp;
  info.textContent = "✓ " + fp.label;
  info.className = "qa-info ok";
  QuickAdd.updateInfo();
  QuickAdd.render(); requestRender();
};

const QA_PROMPT = "Type e.g.  0805 10k · sot23 npn 2n2222 · soic14 74hc130 · ic sot23 ref30 · to-220-5 · free 4x5";

/* the "next free" reference for a prefix WITHOUT reserving it (nextRef mutates counters) */
function qaPreviewRef(prefix){
  let n = (State.refCounters[prefix] || 0) + 1;
  while (refExists(prefix + n)) n++;
  return prefix + n;
}

/* structured facts grid under the input: footprint, pins, pitch, body size, value,
   part, symbol, KiCad name, placement side/rotation — refreshed on every keystroke,
   nudge and rotate (not a single bracket line any more) */
QuickAdd.updateInfo = () => {
  const facts = $("#qa-facts");
  if (!facts) return;
  const p = QuickAdd.parsed, fp = QuickAdd.fp;
  if (!p || !fp){ facts.style.display = "none"; facts.innerHTML = ""; return; }
  const rows = [];
  const add = (k, v) => { if (v !== "" && v != null) rows.push(
    `<div class="qa-k">${escAttr(k)}</div><div class="qa-v">${v}</div>`); };
  const esc = (s) => escAttr(String(s));
  const mmFmt = (n) => (+n).toFixed(2).replace(/\.?0+$/, "") + " mm";

  add("Reference", esc(qaPreviewRef(p.prefix || "U")) + ` <span class="qa-dim">(auto, prefix ${esc(p.prefix||"U")})</span>`);
  add("Footprint", esc(fp.label));
  add("Pins", String(fp.pins.length));
  if (fp.params && fp.params.rows && fp.params.cols) add("Grid", esc(fp.params.rows + " × " + fp.params.cols));
  if (fp.params && fp.params.pitch) add("Pitch", esc(mmFmt(fp.params.pitch)));
  if (fp.body) add("Body", esc(mmFmt(fp.body.w) + " × " + mmFmt(fp.body.h)));
  add("Value", p.value ? esc(p.value) : `<span class="qa-dim">—</span>`);
  add("Part name", p.part ? esc(p.part) : `<span class="qa-dim">—</span>`);
  if (p.symOverride) add("Symbol", esc((typeof SYM_LABELS !== "undefined" && SYM_LABELS[p.symOverride]) || p.symOverride));
  if (fp.kicad) add("KiCad", esc(fp.kicad));
  add("Place on", esc((SIDE_LABELS[QuickAdd.side] || QuickAdd.side) + " · " + QuickAdd.rot + "°"));
  facts.innerHTML = rows.join("");
  facts.style.display = "";
};

/* draw the board area under the part into the preview: the footprint ghost stays pinned to the
   centre of the preview and the board itself re-centres on the part every nudge, so the board
   scrolls beneath a fixed part and the preview always shows real board content (never black).
   We re-render the board straight from the model (drawWorld) at a preview-specific pan/zoom
   rather than sampling the on-screen canvas, so we're not limited to what's currently in view. */
QuickAdd.render = () => {
  const cv = $("#qa-preview"); if (!cv) return;
  const ctx = cv.getContext("2d");
  const dpr = View.dpr || 1;
  // size the drawing buffer to the (CSS-sized) box so the preview isn't stretched/squished
  const cssW = Math.round(cv.clientWidth) || 240, cssH = Math.round(cv.clientHeight) || 180;
  if (cv.width  !== cssW*dpr) cv.width  = cssW*dpr;
  if (cv.height !== cssH*dpr) cv.height = cssH*dpr;
  const PW = cv.width, PH = cv.height;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,PW,PH);
  ctx.fillStyle = "#0d0f12"; ctx.fillRect(0,0,PW,PH);

  // choose the preview scale so the WHOLE footprint (+ margin) always fits, regardless of
  // the board zoom — small parts (SOT-23) and big ICs (SOIC-14) both frame nicely
  const fp = QuickAdd.fp;
  const fx = View.flip ? -1 : 1;
  let extMm = 3;   // fallback framing radius when nothing is resolved yet (~6 mm across)
  if (fp){
    extMm = Math.max(fp.body.w, fp.body.h) / 2;
    for (const p of fp.pins) extMm = Math.max(extMm, Math.hypot(p.xmm, p.ymm) + Math.max(p.w, p.h)/2);
  }
  // preview device-px per mm — the footprint spans ~40% of the shorter side, board context around
  const pxPerMm = Math.min(PW, PH) / (extMm * 2 * 2.6);

  // re-render the board into the preview at our own pan/zoom (centred on the part). drawWorld
  // reads View.zoom / View.panX / View.panY, so temporarily override them and restore after.
  const prevZoom = View.zoom, prevPanX = View.panX, prevPanY = View.panY, prevPaneDX = View._paneDX;
  // world→device factor is dpr*zoom; we want pxPerMm device px per mm and State.pxPerMm px per mm
  const pvZoom = pxPerMm / (State.pxPerMm * dpr);
  // place the part's world point at the preview centre (base transform below scales by dpr)
  View.zoom = pvZoom; View._paneDX = 0;
  View.panX = (PW/2)/dpr - QuickAdd.pos.x * pvZoom * fx;
  View.panY = (PH/2)/dpr - QuickAdd.pos.y * pvZoom;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  try { drawWorld(ctx); } catch(e){}
  View.zoom = prevZoom; View.panX = prevPanX; View.panY = prevPanY; View._paneDX = prevPaneDX;

  ctx.setTransform(1,0,0,1,0,0);
  // crosshair at the placement point (always the preview centre — the board follows the part)
  ctx.strokeStyle = "rgba(255,210,77,0.7)"; ctx.lineWidth = 1*dpr;
  ctx.beginPath(); ctx.moveTo(PW/2-8*dpr,PH/2); ctx.lineTo(PW/2+8*dpr,PH/2);
  ctx.moveTo(PW/2,PH/2-8*dpr); ctx.lineTo(PW/2,PH/2+8*dpr); ctx.stroke();

  // overlay the footprint, pinned to the preview centre
  if (fp){
    ctx.save();
    ctx.translate(PW/2, PH/2);
    ctx.scale(fx, 1);
    ctx.rotate(QuickAdd.rot * Math.PI/180);
    if (QuickAdd.side === "back") ctx.scale(-1,1);
    drawFootprintShape(ctx, fp, pxPerMm, {alpha:0.85, zoom:1});
    ctx.restore();
  }
};

QuickAdd.nudge = (dx, dy) => {
  QuickAdd.pos.x += dx; QuickAdd.pos.y += dy;
  QuickAdd.render(); requestRender();   // render() re-crops the preview around the new pos
};

QuickAdd.rotate = (deg) => {
  QuickAdd.rot = ((QuickAdd.rot + deg) % 360 + 360) % 360;
  QuickAdd.updateInfo();   // keep the "Place on … °" fact current
  QuickAdd.render(); requestRender();
};

QuickAdd.place = () => {
  const p = QuickAdd.parsed, fp = QuickAdd.fp;
  if (!p || !fp){ UI.toast("Nothing to place — type a component first"); return; }
  const w = QuickAdd.pos;
  const rNew = Math.hypot(fp.body.w, fp.body.h)/2 * State.pxPerMm;
  for (const o of State.components){
    if (o.side !== QuickAdd.side) continue;
    if (Math.hypot(w.x-o.x, w.y-o.y) < Math.min(rNew, compRadius(o)) * 0.8){
      UI.toast("Too close to " + o.ref + " — components can't stack"); return;
    }
  }
  pushUndo("quick-add component");
  const ref = nextRef(p.prefix || "U");
  registerRef(ref);
  const comp = {
    id: nextId(), ref, value: p.value||"", part: p.part||"",
    fpId: p.fpId, fpParams: {...fp.params},
    kicad: fp.kicad || "",
    x: w.x, y: w.y, rot: QuickAdd.rot, side: QuickAdd.side,
    scale: 1,
    symOverride: p.symOverride || null,
    pins: fp.pins.map(fpin => ({ num:fpin.num, name:fpin.name||"", netId:null })),
  };
  if (comp.symOverride && comp.symOverride !== "box") applySymPinNames(comp, comp.symOverride);
  State.components.push(comp);
  autoConnectPins(comp);
  UI.select({type:"comp", comp});
  UI.toast("Placed " + ref + " (" + fp.label + ")");
  QuickAdd.close();
  requestRender();
};

QuickAdd.wire = () => {
  const inp = $("#qa-input");
  inp.addEventListener("input", QuickAdd.update);

  // rotate / place keys come from the hotkey editor (quickadd.* actions). Defaults are a
  // bare-modifier tap (Shift = CW, Ctrl = CCW) and Enter (place); a modifier binding is
  // fired on keyup only if it was pressed alone, so holding it to type a capital still works.
  const cfg = () => ({
    cw:    Keymap.keyFor("quickadd.rotcw"),
    ccw:   Keymap.keyFor("quickadd.rotccw"),
    place: Keymap.keyFor("quickadd.place"),
  });
  const MODS = ["Shift","Control","Alt"];
  let modTap = null;   // a lone-pressed modifier awaiting keyup

  inp.addEventListener("keydown", (e) => {
    const c = cfg();
    if (MODS.includes(e.key)){
      modTap = (e.key === c.cw || e.key === c.ccw || e.key === c.place) ? e.key : null;
      return;   // let the modifier through (typing capitals etc.)
    }
    modTap = null;   // any real key cancels a pending modifier tap
    const ck = comboKey(e);   // modifier-aware, e.g. "Shift+K"
    // configured non-modifier bindings (e.g. after the user rebinds to a key/combo/F-key)
    if (c.place !== "Enter" && ck === c.place){ e.preventDefault(); QuickAdd.place(); return; }
    if (!MODS.includes(c.cw)  && ck === c.cw){  e.preventDefault(); QuickAdd.rotate(90);  return; }
    if (!MODS.includes(c.ccw) && ck === c.ccw){ e.preventDefault(); QuickAdd.rotate(-90); return; }
    // built-ins
    const step = State.pxPerMm * 0.25;   // 0.25 mm
    if (e.key === "ArrowLeft"){ e.preventDefault(); QuickAdd.nudge(-step, 0); }
    else if (e.key === "ArrowRight"){ e.preventDefault(); QuickAdd.nudge(step, 0); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); QuickAdd.nudge(0, -step); }
    else if (e.key === "ArrowDown"){ e.preventDefault(); QuickAdd.nudge(0, step); }
    else if (e.key === "Enter" && c.place === "Enter"){ e.preventDefault(); QuickAdd.place(); }
    else if (e.key === "Escape"){ e.preventDefault(); QuickAdd.close(); }
  });
  inp.addEventListener("keyup", (e) => {
    if (!MODS.includes(e.key) || modTap !== e.key) return;
    const c = cfg(); modTap = null;
    if (e.key === c.cw) QuickAdd.rotate(90);
    else if (e.key === c.ccw) QuickAdd.rotate(-90);
    else if (e.key === c.place) QuickAdd.place();
  });
  $("#qa-place").addEventListener("click", QuickAdd.place);
  $("#qa-cancel").addEventListener("click", QuickAdd.close);
  $("#qa-full").addEventListener("click", () => { QuickAdd.close(); UI.openFootprintDialog(); });
  // closing via backdrop / Esc on the <dialog> itself
  $("#qa-dialog").addEventListener("close", () => { QuickAdd.active = false; QuickAdd.fp = null; requestRender(); });
};
