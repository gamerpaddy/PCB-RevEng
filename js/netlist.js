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

function exportKiCadSch(){
  const L = [];
  const F = (n)=>n.toFixed(2);
  L.push('(kicad_sch (version 20211123) (generator "pcb-reveng")');
  L.push('  (uuid ' + _uuid() + ')');
  L.push('  (paper "A2")');
  // one symbol definition per component (pin names/numbers are per-part)
  L.push('  (lib_symbols');
  const geo = new Map(); // comp.id -> {w, h, pins:[{x,y,angle,len}]}
  for (const c of State.components){
    const pl = schPlacement(c);
    const refLetter = (/^[A-Za-z]+/.exec(c.ref)||["U"])[0];
    // 2-pin R/C/L/D render as KiCad's real primitive shape; everything else is a
    // sized box (KiCad draws ICs as background-filled boxes, so that stays consistent).
    const prim = c.pins.length === 2 ? SCH_PRIMS[refLetter.toUpperCase()] : null;
    const sym = "REV_" + c.ref;
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
    geo.set(c.id, { w, h, pins });
    L.push('    (symbol "reveng:' + sym + '"' + (hide ? ' (pin_numbers (hide yes)) (pin_names (hide yes))' : '') + ' (in_bom yes) (on_board yes)');
    L.push('      (property "Reference" "' + _schEsc(refLetter) + '" (at 0 ' + F(h/2+1.27) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('      (property "Value" "' + _schEsc(c.value || c.part || "~") + '" (at 0 ' + F(-h/2-1.27) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('      (symbol "' + sym + '_0_1"');
    for (const g of body) L.push('        ' + g);
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
  // instances + global labels
  let X = 30, Y = 30, rowH = 0;
  for (const c of State.components){
    const g = geo.get(c.id);
    if (X > 260){ X = 30; Y += rowH + 25; rowH = 0; }
    rowH = Math.max(rowH, g.h + 15);
    const sym = "REV_" + c.ref;
    L.push('  (symbol (lib_id "reveng:' + sym + '") (at ' + F(X) + ' ' + F(Y) + ' 0) (unit 1) (in_bom yes) (on_board yes)');
    L.push('    (uuid ' + _uuid() + ')');
    L.push('    (property "Reference" "' + _schEsc(c.ref) + '" (at ' + F(X) + ' ' + F(Y-g.h/2-2.54) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('    (property "Value" "' + _schEsc(c.value || c.part || "~") + '" (at ' + F(X) + ' ' + F(Y+g.h/2+2.54) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('    (property "Footprint" "' + _schEsc(c.kicad || "") + '" (at ' + F(X) + ' ' + F(Y) + ' 0) (effects (font (size 1.27 1.27)) hide))');
    for (const p of c.pins) L.push('    (pin "' + _schEsc(p.num) + '" (uuid ' + _uuid() + '))');
    L.push('  )');
    for (let i=0;i<c.pins.length;i++){
      const p = c.pins[i];
      if (!p.netId) continue;
      const net = getNet(p.netId);
      if (!net) continue;
      const pg = g.pins[i] || { x: -g.w/2-2.54, y: 0, angle: 0 };
      const onLeft = pg.angle === 0;
      const px = X + pg.x;
      const py = Y - pg.y; // schematic y axis points down
      L.push('  (global_label "' + _schEsc(net.name) + '" (shape passive) (at ' + F(px) + ' ' + F(py) + ' ' + (onLeft?180:0) + ') (fields_autoplaced)');
    L.push('    (effects (font (size 1.27 1.27)) (justify ' + (onLeft?"right":"left") + '))');
      L.push('    (uuid ' + _uuid() + '))');
    }
    X += g.w + 45;
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

function netlistFor(format){
  switch (format){
    case "bom":  return { text: exportBOM(),      ext: "csv",       mime: "text/csv",        base: "bom" };
    case "csv":  return { text: exportCSV(),      ext: "csv",       mime: "text/csv",        base: "netlist" };
    case "json": return { text: exportJSON(),     ext: "json",      mime: "application/json", base: "netlist" };
    case "sch":  return { text: exportKiCadSch(), ext: "kicad_sch", mime: "text/plain",      base: "schematic" };
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
