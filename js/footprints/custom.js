/* ===== footprints/custom.js — user-imported footprints (KiCad .kicad_mod) =====
   Imported footprints are retained in localStorage and appear as the "Custom
   (imported)" category in the footprint selector (import/delete buttons live in
   the dialog's param panel, fpdialog.js). Quick-add finds them with
   "custom:<part of the name>". Deleting is blocked while a board part uses one. */
"use strict";

const CustomFPs = {
  KEY: "pcbreveng.customFps",

  list(){
    try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); } catch(e){ return []; }
  },

  save(list){
    try { localStorage.setItem(this.KEY, JSON.stringify(list)); } catch(e){ UI.toast("Could not save custom footprints (storage full?)"); }
    this.refreshDef();
  },

  get(name){ return this.list().find(f => f.name === name) || null; },

  /* case-insensitive substring match on the stored name (quick-add "custom:usb") */
  find(part){
    const q = (part || "").toLowerCase();
    return this.list().find(f => f.name.toLowerCase().includes(q)) || null;
  },

  /* board components currently using this custom footprint */
  usedBy(name){
    return State.components.filter(c => c.fpId === "customfp" && c.fpParams && c.fpParams.name === name);
  },

  add(fp){
    const list = this.list().filter(f => f.name !== fp.name);   // re-import replaces
    list.push(fp);
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.save(list);
  },

  remove(name){
    const used = this.usedBy(name);
    if (used.length){
      UI.toast("“" + name + "” is placed on the board (" + used.map(c=>c.ref).slice(0,4).join(", ") +
               (used.length>4 ? ", +" + (used.length-4) : "") + ") — delete those parts first");
      return false;
    }
    this.save(this.list().filter(f => f.name !== name));
    return true;
  },

  /* keep the registered def's name-select options in sync with the stored list */
  refreshDef(){
    const def = getFootprintDef("customfp");
    if (!def) return;
    const names = this.list().map(f => f.name);
    def.params[0].options = names.length ? names : ["(none imported)"];
    def.params[0].def = names[0] || "(none imported)";
  },

  /* import one .kicad_mod file's text; returns the stored entry or null */
  importKicadMod(name, text){
    const fp = parseKicadMod(text);
    if (!fp || !fp.pins.length){ UI.toast("No pads found in " + name + " — is it a .kicad_mod footprint?"); return null; }
    const base = name.replace(/\.(kicad_mod|mod)$/i, "");
    const entry = { name: base, pins: fp.pins, body: fp.body, kicad: fp.libName ? "" + fp.libName : "" };
    this.add(entry);
    return entry;
  },
};

/* ---------- minimal KiCad .kicad_mod parser ----------
   Extracts pads (smd/thru_hole, at/size/drill, rotation) and a body outline bbox
   from fp_line/fp_rect/fp_circle. KiCad footprint files are mm with +y DOWN —
   the same convention as this app's footprint pins, so coords pass through. */
function parseKicadMod(text){
  const nameM = /\((?:module|footprint)\s+"?([^\s")]+)"?/.exec(text);
  const pins = [];
  // each pad block: (pad "<num>" <type> <shape> (at x y [rot]) (size w h) [(drill d)]
  const padRe = /\(pad\s+"?([^\s")]*)"?\s+(smd|thru_hole|np_thru_hole|connect)\s+(\w+)\s*([\s\S]*?)(?=\(pad\s|\)\s*$)/g;
  let m;
  while ((m = padRe.exec(text))){
    const [, num, type, shape, rest] = m;
    const at = /\(at\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+))?\)/.exec(rest);
    const size = /\(size\s+([\d.]+)\s+([\d.]+)\)/.exec(rest);
    if (!at || !size) continue;
    const rot = at[3] ? ((parseFloat(at[3]) % 360) + 360) % 360 : 0;
    let w = parseFloat(size[1]), h = parseFloat(size[2]);
    if (rot === 90 || rot === 270){ const t = w; w = h; h = t; }   // pad rotation → swapped extents
    const tht = type === "thru_hole" || type === "np_thru_hole";
    const drill = /\(drill\s+(?:oval\s+)?([\d.]+)/.exec(rest);
    const pin = {
      num: num || String(pins.length + 1),
      x: parseFloat(at[1]), y: parseFloat(at[2]),
      shape: (shape === "circle" || (tht && shape === "oval" && Math.abs(w-h) < 0.01)) ? "circle" : "rect",
      w, h, tht,
    };
    if (pin.shape === "circle"){ pin.w = pin.h = Math.max(w, h); }
    if (tht && drill) pin.hole = parseFloat(drill[1]);
    if (!tht && pin.shape === "circle") pin.tht = false;   // round SMD pad — no drill
    pins.push(pin);
  }
  if (!pins.length) return null;
  // body: outline graphics bbox, else pad bbox + margin
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity,anyG=false;
  const take = (x,y)=>{ minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); anyG=true; };
  const lineRe = /\(fp_(?:line|rect)\s+\(start\s+(-?[\d.]+)\s+(-?[\d.]+)\)\s+\(end\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g;
  while ((m = lineRe.exec(text))){ take(+m[1], +m[2]); take(+m[3], +m[4]); }
  if (!anyG){
    for (const p of pins){ take(p.x - p.w/2, p.y - p.h/2); take(p.x + p.w/2, p.y + p.h/2); }
    minX -= 0.3; minY -= 0.3; maxX += 0.3; maxY += 0.3;
  }
  // centre the footprint on its bbox middle so it places under the cursor nicely
  const cx = (minX + maxX)/2, cy = (minY + maxY)/2;
  for (const p of pins){ p.x = +(p.x - cx).toFixed(4); p.y = +(p.y - cy).toFixed(4); }
  return { libName: nameM ? nameM[1] : "", pins,
           body: { w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) } };
}

Footprints.register({
  id:"customfp", name:"Custom (imported)", prefix:"U",
  params:[{key:"name",label:"Footprint",type:"select",def:"(none imported)",options:["(none imported)"]}],
  gen(p){
    const src = CustomFPs.get(p.name);
    if (!src) return { label:"Custom (import a .kicad_mod)", pins:[], body:{w:6,h:6}, kicad:"" };
    const pins = src.pins.map(pl => _pin(pl.num, pl.x, pl.y,
      { shape: pl.shape, w: pl.w, h: pl.h, tht: pl.tht, hole: pl.hole, name: pl.name || "" }));
    return { label:"Custom "+src.name, pins, body:{ w: src.body.w, h: src.body.h }, kicad: src.kicad || "" };
  }
});
CustomFPs.refreshDef();
