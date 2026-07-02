/* ===== netlist.js — export to KiCad / CSV / JSON ===== */
"use strict";

function buildNetMap(){
  // netId -> [{ref, pin}]
  const map = new Map();
  for (const c of State.components){
    for (const p of c.pins){
      if (!p.netId) continue;
      if (!map.has(p.netId)) map.set(p.netId, []);
      map.get(p.netId).push({ ref: c.ref, pin: p.num, pinName: p.name });
    }
  }
  return map;
}

function sexpEscape(s){
  s = String(s == null ? "" : s);
  if (s === "") return '""';
  if (/[\s()"\\]/.test(s)) return '"' + s.replace(/\\/g,"\\\\").replace(/"/g,'\\"') + '"';
  return s;
}

/* KiCad s-expression netlist — importable in Pcbnew (File → Import Netlist) */
function exportKiCad(){
  const lines = [];
  lines.push("(export (version D)");
  lines.push("  (design");
  lines.push("    (source " + sexpEscape("pcb-reveng") + ")");
  lines.push("    (date " + sexpEscape(new Date().toISOString()) + ")");
  lines.push("    (tool " + sexpEscape("PCB RevEng v1") + "))");
  lines.push("  (components");
  for (const c of State.components){
    const fp = compFootprint(c);
    lines.push("    (comp (ref " + sexpEscape(c.ref) + ")");
    lines.push("      (value " + sexpEscape(c.value || c.part || "~") + ")");
    lines.push("      (footprint " + sexpEscape(c.kicad || fp.kicad || fp.label) + ")");
    if (c.part) lines.push("      (libsource (lib " + sexpEscape("reveng") + ") (part " + sexpEscape(c.part) + ") (description \"\"))");
    lines.push("      (tstamp " + c.id.toString(16).padStart(8,"0").toUpperCase() + "))");
  }
  lines.push("  )");
  lines.push("  (nets");
  const map = buildNetMap();
  let code = 1;
  for (const net of State.nets){
    const nodes = map.get(net.id);
    if (!nodes || !nodes.length) continue;
    lines.push("    (net (code " + (code++) + ") (name " + sexpEscape(net.name) + ")");
    for (const n of nodes)
      lines.push("      (node (ref " + sexpEscape(n.ref) + ") (pin " + sexpEscape(n.pin) + "))");
    lines.push("    )");
  }
  lines.push("  )");
  lines.push(")");
  return lines.join("\n");
}

/* serialise a row array to RFC-4180 CSV (quote fields with comma/quote/newline) */
function _toCSV(rows){
  return rows.map(r => r.map(v => {
    v = String(v == null ? "" : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v;
  }).join(",")).join("\n");
}

function exportCSV(){
  const rows = [["ref","value","part","footprint","pin","pin_name","net"]];
  for (const c of State.components){
    const fp = compFootprint(c);
    for (const p of c.pins){
      const net = p.netId ? (getNet(p.netId)?.name || "") : "";
      rows.push([c.ref, c.value, c.part, c.kicad || fp.label, p.num, p.name, net]);
    }
  }
  return _toCSV(rows);
}

/* ---------- Bill of Materials ----------
   Collapses components that share the same value + part + footprint into a single
   BOM line, with the quantity and a naturally-sorted list of reference designators. */
function _refSortKey(ref){
  const m = /^([^0-9]*)(\d+)?(.*)$/.exec(ref || "");
  return [ (m && m[1]) || "", (m && m[2] != null) ? parseInt(m[2],10) : -1, (m && m[3]) || "" ];
}
function _refCmp(a, b){
  const ka = _refSortKey(a), kb = _refSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] < kb[0] ? -1 : 1;   // prefix (R, C, U…)
  if (ka[1] !== kb[1]) return ka[1] - kb[1];            // number, naturally (R9 < R10)
  return ka[2] < kb[2] ? -1 : (ka[2] > kb[2] ? 1 : 0);  // suffix (IC1A < IC1B)
}

function bomGroups(){
  const groups = new Map(); // key -> {value, part, footprint, comps:[], refs:[]}
  for (const c of State.components){
    const fp = compFootprint(c);
    const footprint = c.kicad || fp.kicad || fp.label || "";
    const value = (c.value || "").trim();
    const part  = (c.part  || "").trim();
    const key = [value, part, footprint].join("");   // unambiguous group key
    if (!groups.has(key)) groups.set(key, { value, part, footprint, comps: [] });
    groups.get(key).comps.push(c);
  }
  const out = [...groups.values()];
  out.forEach(g => { g.comps.sort((a,b) => _refCmp(a.ref, b.ref)); g.refs = g.comps.map(c => c.ref); });
  out.sort((a, b) => _refCmp(a.refs[0], b.refs[0]));     // cluster lines by designator
  return out;
}

/* common value of a custom BOM column across a group, or "" when its parts disagree */
function bomFieldCommon(g, col){
  let v = null;
  for (const c of g.comps){
    const cv = (c.bom && c.bom[col]) || "";
    if (v === null) v = cv; else if (v !== cv) return "";
  }
  return v || "";
}

function exportBOM(){
  const cols = State.bomColumns || [];
  const rows = [["Item","Qty","Value","Part","Footprint","References", ...cols]];
  bomGroups().forEach((g, i) => rows.push([
    i+1, g.refs.length, g.value, g.part, g.footprint, g.refs.join(", "),
    ...cols.map(col => bomFieldCommon(g, col)),
  ]));
  return _toCSV(rows);
}

function exportJSON(){
  const map = buildNetMap();
  return JSON.stringify({
    generator: "pcb-reveng v1",
    date: new Date().toISOString(),
    components: State.components.map(c => {
      const fp = compFootprint(c);
      return {
        ref: c.ref, value: c.value, part: c.part,
        footprint: c.kicad || fp.kicad || fp.label, side: c.side,
        pins: c.pins.map(p => ({ num: p.num, name: p.name, net: p.netId ? (getNet(p.netId)?.name || null) : null })),
      };
    }),
    nets: State.nets
      .filter(n => map.has(n.id))
      .map(n => ({ name: n.name, nodes: map.get(n.id).map(x => x.ref + "." + x.pin) })),
  }, null, 2);
}

/* ---------- KiCad schematic (.kicad_sch) ----------
   Generates a generic box symbol per component, laid out in a grid, with a
   global label on every connected pin — net connectivity comes from the labels,
   so the schematic is immediately usable/editable in Eeschema. */
function _uuid(){
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random()*16|0;
    return (c === "x" ? r : (r & 3 | 8)).toString(16);
  });
}
function _schEsc(s){ return String(s == null ? "" : s).replace(/\\/g,"\\\\").replace(/"/g,'\\"'); }

/* decide which side (0=left, 1=right) and vertical slot each pin sits on in the
   generated symbol. For a footprint with exactly two physical rows (headers, DIP,
   SOIC…) each row maps to one side, sorted along the row — so the schematic pin
   layout matches the footprint (e.g. odd pins left / even pins right). Otherwise
   fall back to a simple first-half-left / second-half-right split. */
function schPlacement(c){
  const fp = compFootprint(c);
  const pins = fp.pins;
  const n = pins.length;
  const place = new Array(n);
  // distinct rows by rounded ymm
  const rowsY = [...new Set(pins.map(p => Math.round(p.ymm*100)/100))].sort((a,b)=>a-b);
  if (rowsY.length === 2){
    const rowOf = (i) => Math.round(pins[i].ymm*100)/100 === rowsY[0] ? 0 : 1;
    const groups = [[], []];
    for (let i=0;i<n;i++) groups[rowOf(i)].push(i);
    groups.forEach(g => g.sort((a,b)=> pins[a].xmm - pins[b].xmm));
    // put the row that contains the lowest pin number on the LEFT (pin-1 convention)
    const minNum = (g) => Math.min(...g.map(i => parseInt(pins[i].num,10) || 1e9));
    const leftGroup = minNum(groups[0]) <= minNum(groups[1]) ? 0 : 1;
    const L0 = groups[leftGroup], R0 = groups[1-leftGroup];
    L0.forEach((idx,slot)=> place[idx] = { side:0, slot });
    R0.forEach((idx,slot)=> place[idx] = { side:1, slot });
    return { place, leftN: L0.length, rightN: R0.length };
  }
  const left = Math.ceil(n/2);
  for (let i=0;i<n;i++) place[i] = (i<left) ? {side:0, slot:i} : {side:1, slot:i-left};
  return { place, leftN: left, rightN: n-left };
}

/* KiCad's own body geometry for common 2-pin parts, taken from Device.kicad_sym.
   R/C/L are rotated +90deg so pin 1 sits on the LEFT and pin 2 on the RIGHT, matching
   the IC-box layout's left/right pin convention (D is already horizontal). `len` is the
   pin length that puts each pin's outer connection point at x = +/-3.81. */
const SCH_PRIMS = {
  R: { len: 1.27, g: [
    '(rectangle (start -2.54 -1.016) (end 2.54 1.016) (stroke (width 0) (type default)) (fill (type none)))'
  ]},
  C: { len: 2.794, g: [
    '(polyline (pts (xy -0.762 -2.032) (xy -0.762 2.032)) (stroke (width 0) (type default)) (fill (type none)))',
    '(polyline (pts (xy 0.762 -2.032) (xy 0.762 2.032)) (stroke (width 0) (type default)) (fill (type none)))'
  ]},
  L: { len: 1.27, g: [
    '(arc (start -2.54 0) (mid -1.905 0.6323) (end -1.27 0) (stroke (width 0) (type default)) (fill (type none)))',
    '(arc (start -1.27 0) (mid -0.635 0.6323) (end 0 0) (stroke (width 0) (type default)) (fill (type none)))',
    '(arc (start 0 0) (mid 0.635 0.6323) (end 1.27 0) (stroke (width 0) (type default)) (fill (type none)))',
    '(arc (start 1.27 0) (mid 1.905 0.6323) (end 2.54 0) (stroke (width 0) (type default)) (fill (type none)))'
  ]},
  D: { len: 2.54, g: [
    '(polyline (pts (xy -1.27 1.27) (xy -1.27 -1.27)) (stroke (width 0) (type default)) (fill (type none)))',
    '(polyline (pts (xy 1.27 1.27) (xy 1.27 -1.27) (xy -1.27 0) (xy 1.27 1.27)) (stroke (width 0) (type default)) (fill (type none)))'
  ]}
};

/* the component's "type" for grouping/sorting — the leading letters of its ref
   designator (R, C, U, Q…), upper-cased. */
function _refType(c){ return (/^[A-Za-z]+/.exec(c.ref)||["U"])[0].toUpperCase(); }

/* per-component symbol geometry: box/primitive size plus each pin's local position.
   Independent of where the symbol lands on the sheet, so both the exporter and the
   arrangement/preview share one source of truth. Returns Map comp.id -> {w,h,pins,body,hide}. */
function schGeometry(){
  const F = (n)=>n.toFixed(2);
  const geo = new Map();
  for (const c of State.components){
    const pl = schPlacement(c);
    const refLetter = (/^[A-Za-z]+/.exec(c.ref)||["U"])[0];
    // 2-pin R/C/L/D render as KiCad's real primitive shape; everything else is a
    // sized box (KiCad draws ICs as background-filled boxes, so that stays consistent).
    const prim = c.pins.length === 2 ? SCH_PRIMS[refLetter.toUpperCase()] : null;
    let w, h, pins, body, hide;
    if (prim){
      hide = true;
      w = 7.62; h = 5.08;
      // place this part's two pins on the fixed left/right primitive pads
      let ri = c.pins.findIndex((_,i)=> pl.place[i] && pl.place[i].side === 1);
      if (ri < 0) ri = 1;
      const li = ri === 0 ? 1 : 0;
      pins = new Array(c.pins.length);
      pins[li] = { x: -3.81, y: 0, angle: 0,   len: prim.len };
      pins[ri] = { x:  3.81, y: 0, angle: 180, len: prim.len };
      body = prim.g;
    } else {
      hide = false;
      h = Math.max(pl.leftN, pl.rightN, 1) * 2.54 + 2.54;
      let lmax = 0, rmax = 0;
      for (let i=0;i<c.pins.length;i++){
        const nl = (c.pins[i].name || "").length;
        if (pl.place[i] && pl.place[i].side === 1) rmax = Math.max(rmax, nl); else lmax = Math.max(lmax, nl);
      }
      w = Math.max(7.62, Math.min(25.4, (lmax + rmax) * 1.1 + 5.08));
      pins = new Array(c.pins.length);
      for (let i=0;i<c.pins.length;i++){
        const pp = pl.place[i] || { side:0, slot:i };
        const onLeft = pp.side === 0;
        pins[i] = { x: onLeft ? -w/2-2.54 : w/2+2.54, y: h/2 - 2.54 - pp.slot*2.54, angle: onLeft ? 0 : 180, len: 2.54 };
      }
      body = ['(rectangle (start ' + F(-w/2) + ' ' + F(h/2) + ') (end ' + F(w/2) + ' ' + F(-h/2) + ') (stroke (width 0.254) (type default)) (fill (type background)))'];
    }
    geo.set(c.id, { w, h, pins, body, hide });
  }
  return geo;
}

/* ---------- schematic arrangements ----------
   Each returns Map comp.id -> {x,y} (the symbol's centre in schematic mm). */

/* pack an ordered list of components left-to-right, wrapping at the sheet width.
   groupKey (optional): start a fresh row whenever the key changes between two
   consecutive parts, so each group forms a visible horizontal band. */
function schGridLayout(order, geo, groupKey){
  const pos = new Map();
  let X = 30, Y = 30, rowH = 0, prevKey = null;
  for (const c of order){
    const g = geo.get(c.id); if (!g) continue;
    const key = groupKey ? groupKey(c) : null;
    if (X > 260 || (groupKey && prevKey !== null && key !== prevKey)){ X = 30; Y += rowH + 25; rowH = 0; }
    rowH = Math.max(rowH, g.h + 15);
    pos.set(c.id, { x: X, y: Y });
    X += g.w + 45;
    prevKey = key;
  }
  return pos;
}

/* push apart any symbols whose boxes overlap (a few relaxation passes). Guarantees
   front/back parts that share a board location don't land on top of each other. */
function schDeOverlap(pos, geo, iters){
  const comps = State.components.filter(c => pos.has(c.id) && geo.has(c.id));
  const n = comps.length;
  if (n < 2) return;
  iters = iters || (n > 400 ? 40 : 80);
  const pad = 5;
  for (let it=0; it<iters; it++){
    let moved = false;
    for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
      const pa = pos.get(comps[i].id), pb = pos.get(comps[j].id);
      const ga = geo.get(comps[i].id), gb = geo.get(comps[j].id);
      const minX = (ga.w+gb.w)/2 + pad, minY = (ga.h+gb.h)/2 + pad;
      const dx = pb.x-pa.x, dy = pb.y-pa.y;
      const ox = minX - Math.abs(dx), oy = minY - Math.abs(dy);
      if (ox > 0 && oy > 0){                      // overlapping — separate on the shallower axis
        moved = true;
        if (ox <= oy){ const s = (dx<0?-1:1)*ox/2; pa.x -= s; pb.x += s; }
        else         { const s = (dy<0?-1:1)*oy/2; pa.y -= s; pb.y += s; }
      }
    }
    if (!moved) break;
  }
}

/* "Same as PCB" — scale the board's part positions onto the sheet, then de-overlap.
   Keeps the physical layout the user knows; the relaxation stops front/bottom parts
   at the same XY from colliding. */
function schArrangePCB(geo){
  const comps = State.components.filter(c => geo.has(c.id));
  const pos = new Map();
  if (!comps.length) return pos;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (const c of comps){ minX=Math.min(minX,c.x); maxX=Math.max(maxX,c.x); minY=Math.min(minY,c.y); maxY=Math.max(maxY,c.y); }
  const spanX = Math.max(maxX-minX,1), spanY = Math.max(maxY-minY,1);
  const target = Math.max(200, 40*Math.sqrt(comps.length));   // sheet region grows with part count
  const scale = target / Math.max(spanX, spanY);
  for (const c of comps) pos.set(c.id, { x: 30 + (c.x-minX)*scale, y: 30 + (c.y-minY)*scale });
  schDeOverlap(pos, geo);
  return pos;
}

/* "Closest" — a light force-directed relaxation that pulls net-connected parts
   together (spring to each net's centroid) while a pairwise repulsion keeps parts
   spread out. Seeded from the PCB layout; de-overlapped at the end. */
function schArrangeClosest(geo){
  const comps = State.components.filter(c => geo.has(c.id));
  const n = comps.length;
  const pos = schArrangePCB(geo);
  if (n < 2) return pos;
  const P = comps.map(c => { const p = pos.get(c.id); return { x:p.x, y:p.y }; });
  // nets touching >1 part are the only ones that pull anything together
  const nets = new Map();
  comps.forEach((c,i) => { for (const pin of c.pins) if (pin.netId){ let a = nets.get(pin.netId); if (!a) nets.set(pin.netId, a=new Set()); a.add(i); } });
  const netArr = [...nets.values()].map(s => [...s]).filter(a => a.length > 1);
  const iters = n > 250 ? 60 : 150;
  const kAttr = 0.08, kRep = 900;
  for (let it=0; it<iters; it++){
    const fx = new Float64Array(n), fy = new Float64Array(n);
    for (const a of netArr){                                  // attraction toward net centroid
      let cx=0, cy=0; for (const i of a){ cx+=P[i].x; cy+=P[i].y; } cx/=a.length; cy/=a.length;
      for (const i of a){ fx[i] += (cx-P[i].x)*kAttr; fy[i] += (cy-P[i].y)*kAttr; }
    }
    for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){             // pairwise repulsion
      let dx = P[i].x-P[j].x, dy = P[i].y-P[j].y, d2 = dx*dx+dy*dy;
      if (d2 < 1) d2 = 1;
      const inv = 1/Math.sqrt(d2), f = kRep/d2;
      fx[i] += dx*inv*f; fy[i] += dy*inv*f; fx[j] -= dx*inv*f; fy[j] -= dy*inv*f;
    }
    for (let i=0;i<n;i++){                                     // integrate with a step clamp
      P[i].x += Math.max(-20, Math.min(20, fx[i]));
      P[i].y += Math.max(-20, Math.min(20, fy[i]));
    }
  }
  comps.forEach((c,i) => pos.set(c.id, { x:P[i].x, y:P[i].y }));
  schDeOverlap(pos, geo);
  return pos;
}

/* dispatch the requested arrangement mode ("closest"|"pcb"|"type"|"name"). */
function schArrange(mode, geo){
  const comps = State.components;
  if (!comps.length) return new Map();
  switch (mode){
    case "pcb":     return schArrangePCB(geo);
    case "closest": return schArrangeClosest(geo);
    case "name":    return schGridLayout([...comps].sort((a,b)=> _refCmp(a.ref,b.ref)), geo, null);
    case "type":
    default: {
      const order = [...comps].sort((a,b)=>{
        const ta = _refType(a), tb = _refType(b);
        return ta < tb ? -1 : ta > tb ? 1 : _refCmp(a.ref, b.ref);
      });
      return schGridLayout(order, geo, c => _refType(c));
    }
  }
}

function _svgEsc(s){
  return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* an SVG preview of a schematic arrangement — component boxes coloured by side
   (front/back) plus a thin star from every connected pin to its net centroid, so
   the effect of each arrangement (especially "closest") is visible before export. */
function schPreviewSVG(mode){
  const geo = schGeometry();
  const pos = schArrange(mode || "type", geo);
  const comps = State.components.filter(c => geo.has(c.id) && pos.has(c.id));
  const f = (n)=> (Math.round(n*100)/100);
  if (!comps.length)
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><text x="60" y="23" fill="#888" font-size="6" text-anchor="middle">No components to preview</text></svg>';
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (const c of comps){
    const g = geo.get(c.id), p = pos.get(c.id);
    minX=Math.min(minX,p.x-g.w/2); maxX=Math.max(maxX,p.x+g.w/2);
    minY=Math.min(minY,p.y-g.h/2); maxY=Math.max(maxY,p.y+g.h/2);
  }
  const m = 10; minX-=m; minY-=m; maxX+=m; maxY+=m;
  const el = [];
  // net stars (drawn first, behind the boxes)
  const netPts = new Map();
  for (const c of comps){
    const g = geo.get(c.id), p = pos.get(c.id);
    for (let i=0;i<c.pins.length;i++){
      const pin = c.pins[i]; if (!pin.netId) continue;
      const pg = g.pins[i] || { x:0, y:0 };
      let a = netPts.get(pin.netId); if (!a) netPts.set(pin.netId, a=[]);
      a.push({ x: p.x+pg.x, y: p.y-pg.y });        // schematic y points down
    }
  }
  for (const [netId, pts] of netPts){
    if (pts.length < 2) continue;
    let cx=0, cy=0; for (const q of pts){ cx+=q.x; cy+=q.y; } cx/=pts.length; cy/=pts.length;
    const col = _svgEsc(netColor(netId));
    for (const q of pts)
      el.push('<line x1="'+f(q.x)+'" y1="'+f(q.y)+'" x2="'+f(cx)+'" y2="'+f(cy)+'" stroke="'+col+'" stroke-width="0.4" opacity="0.5"/>');
  }
  // component boxes + ref labels
  for (const c of comps){
    const g = geo.get(c.id), p = pos.get(c.id);
    const back = c.side === "back";
    const fill = back ? "#2b3a66" : "#5a4a1e", stroke = back ? "#7da0ff" : "#ffd24d";
    el.push('<rect x="'+f(p.x-g.w/2)+'" y="'+f(p.y-g.h/2)+'" width="'+f(g.w)+'" height="'+f(g.h)+'" rx="1" fill="'+fill+'" stroke="'+stroke+'" stroke-width="0.4"/>');
    const fs = Math.min(3.2, g.h*0.5);
    el.push('<text x="'+f(p.x)+'" y="'+f(p.y)+'" fill="#fff" font-size="'+f(fs)+'" text-anchor="middle" dominant-baseline="central" font-family="Consolas,monospace">'+_svgEsc(c.ref)+'</text>');
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="'+f(minX)+' '+f(minY)+' '+f(maxX-minX)+' '+f(maxY-minY)+'" preserveAspectRatio="xMidYMid meet">'+el.join("")+'</svg>';
}

function exportKiCadSch(mode){
  const L = [];
  const F = (n)=>n.toFixed(2);
  const geo = schGeometry();
  const pos = schArrange(mode || "type", geo);
  L.push('(kicad_sch (version 20211123) (generator "pcb-reveng")');
  L.push('  (uuid ' + _uuid() + ')');
  L.push('  (paper "A2")');
  // one symbol definition per component (pin names/numbers are per-part)
  L.push('  (lib_symbols');
  for (const c of State.components){
    const g = geo.get(c.id);
    const refLetter = (/^[A-Za-z]+/.exec(c.ref)||["U"])[0];
    const sym = "REV_" + c.ref;
    const { w, h, pins, body, hide } = g;
    L.push('    (symbol "reveng:' + sym + '"' + (hide ? ' (pin_numbers (hide yes)) (pin_names (hide yes))' : '') + ' (in_bom yes) (on_board yes)');
    L.push('      (property "Reference" "' + _schEsc(refLetter) + '" (at 0 ' + F(h/2+1.27) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('      (property "Value" "' + _schEsc(c.value || c.part || "~") + '" (at 0 ' + F(-h/2-1.27) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('      (symbol "' + sym + '_0_1"');
    for (const gg of body) L.push('        ' + gg);
    L.push('      )');
    L.push('      (symbol "' + sym + '_1_1"');
    for (let i=0;i<c.pins.length;i++){
      const pg = pins[i];
      const p = c.pins[i];
      L.push('        (pin passive line (at ' + F(pg.x) + ' ' + F(pg.y) + ' ' + pg.angle + ') (length ' + F(pg.len) + ')');
      L.push('          (name "' + _schEsc(p.name || "~") + '" (effects (font (size 1.27 1.27))))');
      L.push('          (number "' + _schEsc(p.num) + '" (effects (font (size 1.27 1.27)))))');
    }
    L.push('      )');
    L.push('    )');
  }
  L.push('  )');
  // instances + global labels, placed by the chosen arrangement
  for (const c of State.components){
    const g = geo.get(c.id);
    const p = pos.get(c.id) || { x: 30, y: 30 };
    const X = p.x, Y = p.y;
    const sym = "REV_" + c.ref;
    L.push('  (symbol (lib_id "reveng:' + sym + '") (at ' + F(X) + ' ' + F(Y) + ' 0) (unit 1) (in_bom yes) (on_board yes)');
    L.push('    (uuid ' + _uuid() + ')');
    L.push('    (property "Reference" "' + _schEsc(c.ref) + '" (at ' + F(X) + ' ' + F(Y-g.h/2-2.54) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('    (property "Value" "' + _schEsc(c.value || c.part || "~") + '" (at ' + F(X) + ' ' + F(Y+g.h/2+2.54) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('    (property "Footprint" "' + _schEsc(c.kicad || "") + '" (at ' + F(X) + ' ' + F(Y) + ' 0) (effects (font (size 1.27 1.27)) hide))');
    for (const p2 of c.pins) L.push('    (pin "' + _schEsc(p2.num) + '" (uuid ' + _uuid() + '))');
    L.push('  )');
    for (let i=0;i<c.pins.length;i++){
      const p2 = c.pins[i];
      if (!p2.netId) continue;
      const net = getNet(p2.netId);
      if (!net) continue;
      const pg = g.pins[i] || { x: -g.w/2-2.54, y: 0, angle: 0 };
      const onLeft = pg.angle === 0;
      const px = X + pg.x;
      const py = Y - pg.y; // schematic y axis points down
      L.push('  (global_label "' + _schEsc(net.name) + '" (shape passive) (at ' + F(px) + ' ' + F(py) + ' ' + (onLeft?180:0) + ') (fields_autoplaced)');
    L.push('    (effects (font (size 1.27 1.27)) (justify ' + (onLeft?"right":"left") + '))');
      L.push('    (uuid ' + _uuid() + '))');
    }
  }
  L.push(')');
  return L.join("\n");
}

/* the footprint string that the export writes for a component
   (same precedence as exportKiCad: the user's field, then the generated default) */
function exportFootprintRef(c){
  const fp = compFootprint(c);
  return c.kicad || fp.kicad || fp.label || "";
}

/* is a footprint reference present in the bundled KiCad footprint list?
   The list holds footprint NAMES (no library prefix), so a "Library:Name" value
   is matched on its Name part. */
let _kfSet = null;
function kicadFootprintKnown(ref){
  if (typeof KicadFootprints === "undefined" || !KicadFootprints.length) return true; // list not loaded - cannot judge
  if (!ref) return false;
  if (!_kfSet || _kfSet.size !== KicadFootprints.length) _kfSet = new Set(KicadFootprints);
  const name = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
  return _kfSet.has(name) || _kfSet.has(ref);
}

/* components whose export footprint is not in the KiCad list.
   Returns null when the list has not loaded yet (so the check is simply skipped),
   otherwise an array of { ref, footprint }. */
function missingKicadFootprints(){
  if (typeof KicadFootprints === "undefined" || !KicadFootprints.length) return null;
  const out = [];
  for (const c of State.components){
    const ref = exportFootprintRef(c);
    if (!kicadFootprintKnown(ref)) out.push({ ref: c.ref, footprint: ref || "(none)" });
  }
  return out;
}

function netlistFor(format, arrange){
  switch (format){
    case "bom":  return { text: exportBOM(),      ext: "csv",       mime: "text/csv",        base: "bom" };
    case "csv":  return { text: exportCSV(),      ext: "csv",       mime: "text/csv",        base: "netlist" };
    case "json": return { text: exportJSON(),     ext: "json",      mime: "application/json", base: "netlist" };
    case "sch":  return { text: exportKiCadSch(arrange), ext: "kicad_sch", mime: "text/plain", base: "schematic" };
    default:     return { text: exportKiCad(),    ext: "net",       mime: "text/plain",      base: "netlist" };
  }
}

function downloadFile(name, text, mime){
  const blob = new Blob([text], { type: mime || "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
