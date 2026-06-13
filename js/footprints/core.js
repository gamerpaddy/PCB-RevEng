/* ===== footprints/core.js — registry, generator, renderer (all dims in mm) =====
   A footprint definition:
     { id, name, prefix?, params:[{key,label,type:'int'|'select',def,min,max,step,options}], gen(params) }
   gen() returns:
     { pins:[{num,name,xmm,ymm,shape:'rect'|'circle',w,h}], body:{w,h,shape?}, kicad, label }
   Category files (passives.js, discrete.js, …) call Footprints.register(def) in load order.
*/
"use strict";

function _pin(num, x, y, opts){
  return Object.assign({ num:String(num), name:"", xmm:x, ymm:y, shape:"rect", w:1.0, h:0.6 }, opts);
}

const Footprints = {
  catalog: [],
  register(def){ this.catalog.push(def); return def; },
};

function getFootprintDef(id){ return Footprints.catalog.find(f => f.id === id) || null; }

function generateFootprint(fpId, params){
  const def = getFootprintDef(fpId);
  if (!def) return null;
  const p = Object.assign({}, params); // keep undeclared extras (e.g. freestyle pinList)
  for (const prm of def.params) p[prm.key] = params && params[prm.key] !== undefined ? params[prm.key] : prm.def;
  // sanitize ints
  for (const prm of def.params) if (prm.type === "int"){
    let v = parseInt(p[prm.key],10); if (isNaN(v)) v = prm.def;
    v = Math.max(prm.min, Math.min(prm.max, v));
    if (prm.step > 1) v = Math.round(v/prm.step)*prm.step;
    p[prm.key] = v;
  }
  const fp = def.gen(p);
  fp.fpId = fpId; fp.params = p;
  return fp;
}

/* default refdes prefix per footprint family — each def may declare `prefix` */
function refPrefixFor(fpId, value){
  const v = (value||"").toLowerCase();
  if (fpId === "chip2" && /^\d|k$|m$|r/.test(v)) return "R";
  const def = getFootprintDef(fpId);
  return (def && def.prefix) || "U";
}

/* draw a generated footprint into a 2D ctx, centred at 0,0; scale = px per mm */
function drawFootprintShape(ctx, fp, pxPerMm, opts){
  opts = opts || {};
  const padFill   = opts.padFill   || "#d8b34a";
  const bodyLine  = opts.bodyLine  || "#cfd6df";
  const s = pxPerMm;
  ctx.lineWidth = Math.max(1/(opts.zoom||1), 1.2);
  // body
  ctx.strokeStyle = bodyLine;
  ctx.globalAlpha = (opts.alpha!==undefined?opts.alpha:1) * 0.9;
  if (fp.body.shape === "circle"){
    ctx.beginPath(); ctx.arc(0, 0, Math.max(fp.body.w, fp.body.h)*s/2, 0, Math.PI*2); ctx.stroke();
  } else {
    ctx.strokeRect(-fp.body.w*s/2, -fp.body.h*s/2, fp.body.w*s, fp.body.h*s);
  }
  // pads
  for (const pin of fp.pins){
    const x=pin.xmm*s, y=pin.ymm*s, w=pin.w*s, h=pin.h*s;
    ctx.fillStyle = padFill;
    ctx.globalAlpha = (opts.alpha!==undefined?opts.alpha:1) * 0.85;
    if (pin.shape==="circle"){
      ctx.beginPath(); ctx.arc(x,y,w/2,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha = (opts.alpha!==undefined?opts.alpha:1);
      ctx.fillStyle="#0d0f12";
      ctx.beginPath(); ctx.arc(x,y,w/5,0,Math.PI*2); ctx.fill();
    } else {
      ctx.fillRect(x-w/2,y-h/2,w,h);
    }
  }
  // pin-1 marker
  const p1 = fp.pins[0];
  if (p1){
    ctx.globalAlpha = (opts.alpha!==undefined?opts.alpha:1);
    ctx.fillStyle = "#ff5d5d";
    ctx.beginPath();
    ctx.arc(p1.xmm*s, p1.ymm*s, Math.max(p1.w,0.5)*s*0.22+2/(opts.zoom||1), 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
