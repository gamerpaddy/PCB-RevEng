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

function exportCSV(){
  const rows = [["ref","value","part","footprint","pin","pin_name","net"]];
  for (const c of State.components){
    const fp = compFootprint(c);
    for (const p of c.pins){
      const net = p.netId ? (getNet(p.netId)?.name || "") : "";
      rows.push([c.ref, c.value, c.part, c.kicad || fp.label, p.num, p.name, net]);
    }
  }
  return rows.map(r => r.map(v => {
    v = String(v == null ? "" : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v;
  }).join(",")).join("\n");
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

function exportKiCadSch(){
  const L = [];
  const F = (n)=>n.toFixed(2);
  L.push('(kicad_sch (version 20211123) (generator "pcb-reveng")');
  L.push('  (uuid ' + _uuid() + ')');
  L.push('  (paper "A2")');
  // one symbol definition per component (pin names/numbers are per-part)
  L.push('  (lib_symbols');
  const geo = new Map(); // comp.id -> {w,h,place,leftN,rightN}
  for (const c of State.components){
    const n = c.pins.length || 1;
    const pl = schPlacement(c);
    const h = Math.max(pl.leftN, pl.rightN, 1) * 2.54 + 2.54;
    const w = 15.24;
    geo.set(c.id, {w, h, place: pl.place});
    const sym = "REV_" + c.ref;
    L.push('    (symbol "reveng:' + sym + '" (in_bom yes) (on_board yes)');
    L.push('      (property "Reference" "' + _schEsc((/^[A-Za-z]+/.exec(c.ref)||["U"])[0]) + '" (at 0 ' + F(h/2+1.27) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('      (property "Value" "' + _schEsc(c.value || c.part || "~") + '" (at 0 ' + F(-h/2-1.27) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('      (symbol "' + sym + '_0_1"');
    L.push('        (rectangle (start ' + F(-w/2) + ' ' + F(h/2) + ') (end ' + F(w/2) + ' ' + F(-h/2) + ') (stroke (width 0.254) (type default)) (fill (type background)))');
    L.push('      )');
    L.push('      (symbol "' + sym + '_1_1"');
    for (let i=0;i<c.pins.length;i++){
      const pp = geo.get(c.id).place[i] || {side:0, slot:i};
      const onLeft = pp.side === 0;
      const y = h/2 - 2.54 - pp.slot*2.54;
      const x = onLeft ? -w/2-2.54 : w/2+2.54;
      const ang = onLeft ? 0 : 180;
      const p = c.pins[i];
      L.push('        (pin passive line (at ' + F(x) + ' ' + F(y) + ' ' + ang + ') (length 2.54)');
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
      const pp = g.place[i] || {side:0, slot:i};
      const onLeft = pp.side === 0;
      const yLocal = g.h/2 - 2.54 - pp.slot*2.54;
      const px = X + (onLeft ? -g.w/2-2.54 : g.w/2+2.54);
      const py = Y - yLocal; // schematic y axis points down
      L.push('  (global_label "' + _schEsc(net.name) + '" (shape passive) (at ' + F(px) + ' ' + F(py) + ' ' + (onLeft?180:0) + ') (fields_autoplaced)');
    L.push('    (effects (font (size 1.27 1.27)) (justify ' + (onLeft?"right":"left") + '))');
      L.push('    (uuid ' + _uuid() + '))');
    }
    X += g.w + 45;
  }
  L.push(')');
  return L.join("\n");
}

function netlistFor(format){
  switch (format){
    case "csv":  return { text: exportCSV(),      ext: "csv",       mime: "text/csv" };
    case "json": return { text: exportJSON(),     ext: "json",      mime: "application/json" };
    case "sch":  return { text: exportKiCadSch(), ext: "kicad_sch", mime: "text/plain" };
    default:     return { text: exportKiCad(),    ext: "net",       mime: "text/plain" };
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
