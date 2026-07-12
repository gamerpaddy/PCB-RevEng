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
    const key = [value, part, footprint].join("\x1f");   // separator keeps the key unambiguous
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
  if (rowsY.length === 1){
    // single physical row (pin header / connector) → one vertical column on the LEFT,
    // ordered by pin number (pin 1 at top), matching KiCad's Conn_01xNN symbols
    const order = [...Array(n).keys()].sort((a,b)=> (parseInt(pins[a].num,10)||1e9) - (parseInt(pins[b].num,10)||1e9));
    order.forEach((idx,slot)=> place[idx] = { side:0, slot });
    return { place, leftN: n, rightN: 0 };
  }
  const left = Math.ceil(n/2);
  for (let i=0;i<n;i++) place[i] = (i<left) ? {side:0, slot:i} : {side:1, slot:i-left};
  return { place, leftN: left, rightN: n-left };
}

/* ---------- IEC 60617 / KiCad schematic symbol library ----------
   Real graphic bodies (resistor rectangle, capacitor plates, diode triangle,
   transistors, etc.) so the exported schematic shows recognisable symbols instead
   of anonymous boxes. Geometry is in KiCad symbol-local mm (Device.kicad_sym style):
   +y is up, the body sits at the origin, and each terminal's OUTER connection point
   is at the listed (x,y) with the pin stub travelling toward the body along `angle`
   (0 = +x / body to the right, 180 = -x, 90 = +y / body above, 270 = -y).

   2-pin symbols keep their two terminals on the fixed left/right pads at x = -/+3.81
   (schGeometry decides which physical pin lands on which side, as for the box layout).
   3-pin symbols list their terminals in [base/gate, collector/drain, emitter/source]
   order and map to the component's pins by index. Connectivity still comes from the
   global net labels, so the symbol shape is purely visual — a mis-guessed transistor
   flavour never affects the netlist. */
const _SS = '(stroke (width 0) (type default))';
function _pl(pts, fill){ return '(polyline (pts ' + pts.map(p => '(xy ' + p[0] + ' ' + p[1] + ')').join(' ') + ') ' + _SS + ' (fill (type ' + (fill || 'none') + ')))'; }
function _rc(x1, y1, x2, y2, fill){ return '(rectangle (start ' + x1 + ' ' + y1 + ') (end ' + x2 + ' ' + y2 + ') ' + _SS + ' (fill (type ' + (fill || 'none') + ')))'; }
function _ac(sx, sy, mx, my, ex, ey){ return '(arc (start ' + sx + ' ' + sy + ') (mid ' + mx + ' ' + my + ') (end ' + ex + ' ' + ey + ') ' + _SS + ' (fill (type none)))'; }
/* two fixed left/right terminals for a 2-pin symbol, connection points at x = -/+3.81 */
const _T2 = (len) => [ { x:-3.81, y:0, angle:0, len }, { x:3.81, y:0, angle:180, len } ];

/* diode triangle+bar shared by diode/led/zener/schottky (anode on the right, cathode bar left) */
const _DIODE_BODY = [
  _pl([[-1.27,1.27],[-1.27,-1.27]]),
  _pl([[1.27,1.27],[1.27,-1.27],[-1.27,0],[1.27,1.27]]),
];

const SCH_SYM = {
  resistor:  { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(1.27),
    body:[ _rc(-2.54,-1.016,2.54,1.016) ] },
  capacitor: { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.794),
    body:[ _pl([[-1.016,0],[-0.762,0]]), _pl([[-0.762,-2.032],[-0.762,2.032]]),
           _pl([[0.762,-2.032],[0.762,2.032]]), _pl([[0.762,0],[1.016,0]]) ] },
  cap_pol:   { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.794),
    body:[ _pl([[-1.016,0],[-0.762,0]]), _pl([[-0.762,-2.032],[-0.762,2.032]]),
           _ac(0.762,-2.032,1.016,0,0.762,2.032),
           _pl([[-2.2,1.5],[-1.4,1.5]]), _pl([[-1.8,1.1],[-1.8,1.9]]) ] },  // + sign
  inductor:  { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(1.27),
    body:[ _ac(-2.54,0,-1.905,0.6323,-1.27,0), _ac(-1.27,0,-0.635,0.6323,0,0),
           _ac(0,0,0.635,0.6323,1.27,0), _ac(1.27,0,1.905,0.6323,2.54,0) ] },
  diode:     { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.54),
    body: _DIODE_BODY },
  led:       { w:7.62, h:6.35, hideNums:true, hideNames:true, term:_T2(2.54),
    body: _DIODE_BODY.concat([
      _pl([[0.5,1.4],[1.7,2.6]]), _pl([[1.05,2.55],[1.7,2.6],[1.6,1.95]]),
      _pl([[1.4,0.8],[2.6,2.0]]), _pl([[1.95,1.95],[2.6,2.0],[2.5,1.35]]) ]) },
  zener:     { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.54),
    body: _DIODE_BODY.concat([ _pl([[-1.27,1.27],[-0.68,1.86]]), _pl([[-1.27,-1.27],[-1.86,-1.86]]) ]) },
  schottky:  { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.54),
    body: _DIODE_BODY.concat([ _pl([[-1.86,1.27],[-1.27,1.27],[-1.27,0.68]]),
                               _pl([[-0.68,-1.27],[-1.27,-1.27],[-1.27,-0.68]]) ]) },
  crystal:   { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.032),
    body:[ _rc(-1.143,-2.032,1.143,2.032), _pl([[-1.778,-2.032],[-1.778,2.032]]),
           _pl([[1.778,-2.032],[1.778,2.032]]) ] },
  fuse:      { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(1.27),
    body:[ _rc(-2.54,-0.762,2.54,0.762), _pl([[-2.54,0],[2.54,0]]) ] },
  battery:   { w:7.62, h:5.08, hideNums:true, hideNames:true, term:_T2(2.54),
    body:[ _pl([[-1.27,-1.905],[-1.27,1.905]]), _pl([[-0.4,-0.9],[-0.4,0.9]]),
           _pl([[0.4,-1.905],[0.4,1.905]]),     _pl([[1.27,-0.9],[1.27,0.9]]),
           _pl([[-2.2,1.4],[-1.6,1.4]]), _pl([[-1.9,1.1],[-1.9,1.7]]) ] },   // + sign
  // 3-pin: terminals [base/gate, collector/drain, emitter/source]
  // 3-pin: terminals [base/gate, collector/drain, emitter/source]. `tab` (optional) lets a
  // 4-pad package (SOT-223/DPAK/TO-252/SOT-89…) map its tab pad — internally tied to the
  // collector/drain — onto that terminal as a branch stub, so a 4-pad part isn't stuck as a box.
  npn: { w:7.62, h:10.16, hideNums:false, hideNames:true,
    term:[ {x:-5.08,y:0,angle:0,len:3.81}, {x:2.54,y:5.08,angle:270,len:2.54}, {x:2.54,y:-5.08,angle:90,len:2.54} ],
    tab:{ term:1, pin:{x:6.35,y:2.54,angle:180,len:2.54}, line:[[2.54,2.54],[3.81,2.54]] },
    body:[ _pl([[-1.27,1.905],[-1.27,-1.905]]), _pl([[-1.27,0.635],[2.54,2.54]]),
           _pl([[-1.27,-0.635],[2.54,-2.54]]),
           _pl([[1.397,-1.969],[0.793,-1.165],[0.391,-1.969],[1.397,-1.969]],'outline') ] },
  pnp: { w:7.62, h:10.16, hideNums:false, hideNames:true,
    term:[ {x:-5.08,y:0,angle:0,len:3.81}, {x:2.54,y:5.08,angle:270,len:2.54}, {x:2.54,y:-5.08,angle:90,len:2.54} ],
    tab:{ term:1, pin:{x:6.35,y:2.54,angle:180,len:2.54}, line:[[2.54,2.54],[3.81,2.54]] },
    body:[ _pl([[-1.27,1.905],[-1.27,-1.905]]), _pl([[-1.27,0.635],[2.54,2.54]]),
           _pl([[-1.27,-0.635],[2.54,-2.54]]),
           _pl([[-0.127,-1.207],[0.879,-1.207],[0.477,-2.011],[-0.127,-1.207]],'outline') ] },
  nmos: { w:10.16, h:10.16, hideNums:false, hideNames:true,
    term:[ {x:-5.08,y:0,angle:0,len:2.54}, {x:1.27,y:5.08,angle:270,len:3.81}, {x:1.27,y:-5.08,angle:90,len:3.81} ],
    tab:{ term:1, pin:{x:5.08,y:1.27,angle:180,len:2.54}, line:[[1.27,1.27],[2.54,1.27]] },
    body:[ _pl([[-2.54,1.905],[-2.54,-1.905]]),                       // gate electrode
           _pl([[-1.27,1.905],[-1.27,0.635]]), _pl([[-1.27,0.508],[-1.27,-0.508]]), _pl([[-1.27,-0.635],[-1.27,-1.905]]),
           _pl([[-1.27,1.27],[1.27,1.27]]), _pl([[-1.27,-1.27],[1.27,-1.27]]),   // drain/source leads
           _pl([[1.27,-1.27],[1.27,0],[-1.27,0]]),                    // body tie
           _pl([[-1.27,0],[-0.5,0.4],[-0.5,-0.4],[-1.27,0]],'outline') ] },      // arrow → gate (N)
  pmos: { w:10.16, h:10.16, hideNums:false, hideNames:true,
    term:[ {x:-5.08,y:0,angle:0,len:2.54}, {x:1.27,y:5.08,angle:270,len:3.81}, {x:1.27,y:-5.08,angle:90,len:3.81} ],
    tab:{ term:1, pin:{x:5.08,y:1.27,angle:180,len:2.54}, line:[[1.27,1.27],[2.54,1.27]] },
    body:[ _pl([[-2.54,1.905],[-2.54,-1.905]]),
           _pl([[-1.27,1.905],[-1.27,0.635]]), _pl([[-1.27,0.508],[-1.27,-0.508]]), _pl([[-1.27,-0.635],[-1.27,-1.905]]),
           _pl([[-1.27,1.27],[1.27,1.27]]), _pl([[-1.27,-1.27],[1.27,-1.27]]),
           _pl([[1.27,-1.27],[1.27,0],[-1.27,0]]),
           _pl([[-0.5,0],[-1.27,0.4],[-1.27,-0.4],[-0.5,0]],'outline') ] },      // arrow → source (P)
};

/* human-readable names + canonical pin names for each symbol kind, used by the
   inspector's "Schematic sym" picker (labels) and its pin-name auto-fill (SYM_PINNAMES,
   in the same terminal order schGeometry maps component pins to). */
const SYM_LABELS = {
  resistor:"Resistor", capacitor:"Capacitor", cap_pol:"Capacitor (polarized)",
  inductor:"Inductor / ferrite", diode:"Diode", led:"LED", zener:"Zener diode",
  schottky:"Schottky diode", crystal:"Crystal / resonator", fuse:"Fuse",
  battery:"Battery / cell", npn:"Transistor NPN", pnp:"Transistor PNP",
  nmos:"MOSFET N-channel", pmos:"MOSFET P-channel",
};
// terminal-SLOT letters, aligned with each symbol's drawn geometry (sym.term order:
// [base/gate, collector/drain, emitter/source]). Used to map a pin NAME → the terminal it drives.
const SYM_PINNAMES = {
  resistor:["1","2"], capacitor:["1","2"], cap_pol:["+","-"], inductor:["1","2"],
  diode:["A","K"], led:["A","K"], zener:["A","K"], schottky:["A","K"],
  crystal:["1","2"], fuse:["1","2"], battery:["+","-"],
  npn:["B","C","E"], pnp:["B","C","E"], nmos:["G","D","S"], pmos:["G","D","S"],
};
// default letter for each pin by PIN NUMBER (rank), i.e. the package's standard pinout — this is
// NOT the terminal-slot order above. Keyed by pin count because packages differ:
//   3 pins = SOT-23/SC-59/SOT-323 → 1=B/G, 2=E/S, 3=C/D  (lone pad = collector/drain)
//   4 pins = SOT-223/DPAK/TO-252  → 1=B/G, 2=C/D, 3=E/S, tab=C/D (tab tied to pin 2)
// TO-92 etc. vary wildly — the user fixes those by renaming a pin (naming drives the geometry).
const SYM_PINORDER = {
  npn:  { 3:["B","E","C"], 4:["B","C","E","C"] },
  pnp:  { 3:["B","E","C"], 4:["B","C","E","C"] },
  nmos: { 3:["G","S","D"], 4:["G","D","S","D"] },
  pmos: { 3:["G","S","D"], 4:["G","D","S","D"] },
};
/* does symbol kind `k` fit a part with n pins? Exact terminal-count match, or a tab-capable
   3-terminal semi driving a 4-pad package (one extra tab pad tied to the collector/drain). */
function symFitsPinCount(k, n){
  const s = SCH_SYM[k];
  return !!s && (s.term.length === n || (s.tab && s.term.length === n - 1));
}
/* symbol kinds selectable for a part with n pins (drives the picker's option list) */
function symKindsForPinCount(n){
  return Object.keys(SCH_SYM).filter(k => symFitsPinCount(k, n));
}
/* the canonical pin names for kind `k` on an n-pin part (or null if it doesn't fit). For a
   tab package the extra pad inherits the collector/drain name (they're the same node). */
function symPinNames(k, n){
  const ord = SYM_PINORDER[k];               // package pin-number order wins for the semis
  if (ord && ord[n]) return ord[n].slice();
  const base = SYM_PINNAMES[k]; if (!base) return null;
  if (base.length === n) return base.slice();
  const s = SCH_SYM[k];
  if (s && s.tab && base.length === n - 1) return base.concat(base[s.tab.term]);
  return null;
}

/* first significant letter of a pin name, uppercased (for name→terminal matching) */
function _pinLetter(name){ const m = /[A-Za-z]/.exec(name || ""); return m ? m[0].toUpperCase() : null; }
/* numeric value of a pin number for ordering (non-numeric / tab pads sort last) */
function _pinNumVal(num){ const n = parseInt(num, 10); return isFinite(n) ? n : 1e9; }

/* fill a component's pin NAMES with the chosen symbol's canonical names, assigned in ascending
   pin-NUMBER order (imports don't guarantee array order matches pin numbering). Nets untouched.
   No-op for kinds without canonical names (e.g. "auto"/"box"). Returns true if it named anything. */
function applySymPinNames(c, kind){
  const names = symPinNames(kind, c.pins.length);
  if (!names) return false;
  const order = c.pins.map((_, i) => i).sort((a, b) => _pinNumVal(c.pins[a].num) - _pinNumVal(c.pins[b].num));
  order.forEach((idx, k) => c.pins[idx].name = names[k]);
  return true;
}

/* When a component is switched to the generic Box / IC symbol, strip the pin NAMES that a
   concrete symbol had auto-filled (B/C/E, G/D/S, A/K, +/- …) so they don't linger as bogus
   labels. Only names matching the PREVIOUS symbol's canonical terminal letters are cleared —
   anything the user typed themselves is left intact. Returns true if it changed anything. */
function clearAutoSymNames(c, prevKind){
  const names = prevKind ? symPinNames(prevKind, c.pins.length) : null;
  if (!names) return false;
  const set = new Set(names.map(n => (n || "").toUpperCase()));
  let changed = false;
  for (const p of c.pins){
    const up = (p.name || "").toUpperCase();
    if (up && set.has(up)){ p.name = ""; changed = true; }
  }
  return changed;
}

/* map a multi-terminal symbol's terminals onto a component's pins. Honours the pin NAMES first
   (so correcting "center pin = C" actually moves it to the collector/drain), then falls back to
   ascending pin-number order. A lone extra pad (SOT-223/DPAK tab, same letter as collector/drain)
   lands on the tab stub. Returns { pins:[{x,y,angle,len}], extra:[body sexpr] }. */
function assignSymTerminals(c, kind, sym){
  const letters = SYM_PINNAMES[kind];              // terminal-slot letters ["B","C","E"] / ["G","D","S"]
  const nt = sym.term.length;
  const out = new Array(c.pins.length);
  const usedT = new Array(nt).fill(false);
  let tabUsed = false; const extra = [];
  const order = c.pins.map((_, i) => i).sort((a, b) => _pinNumVal(c.pins[a].num) - _pinNumVal(c.pins[b].num));
  // the terminal letter each pin WANTS: its explicit name letter if recognised, else the
  // package-standard letter for its pin-number rank (SOT-23 lone pad → C, SOT-223 tab → C/D…)
  const defOrder = symPinNames(kind, c.pins.length) || [];
  const want = new Array(c.pins.length);
  order.forEach((idx, rank) => {
    const L = _pinLetter(c.pins[idx].name);
    want[idx] = (L && letters.indexOf(L) >= 0) ? L : (defOrder[rank] || null);
  });
  const leftover = [];
  for (const i of order){                          // pass 1: place by wanted letter
    const L = want[i];
    const t = L ? letters.indexOf(L) : -1;
    if (t >= 0 && !usedT[t]){ usedT[t] = true; out[i] = { ...sym.term[t] }; }
    else if (t >= 0 && sym.tab && letters[sym.tab.term] === L && !tabUsed){
      tabUsed = true; out[i] = { ...sym.tab.pin }; extra.push(_pl(sym.tab.line));   // duplicate C/D letter → tab
    } else leftover.push(i);
  }
  const freeT = []; for (let t = 0; t < nt; t++) if (!usedT[t]) freeT.push(t);
  for (const i of leftover){                       // pass 2: fill remaining terminals, then tab
    if (freeT.length){ const t = freeT.shift(); usedT[t] = true; out[i] = { ...sym.term[t] }; }
    else if (sym.tab && !tabUsed){ tabUsed = true; out[i] = { ...sym.tab.pin }; extra.push(_pl(sym.tab.line)); }
    else out[i] = { ...(sym.tab ? sym.tab.pin : sym.term[nt - 1]) };                // overflow (rare)
  }
  return { pins: out, extra };
}

/* auto-classify a component into a symbol kind (or null → generic box) from the ref-des
   letter, pin count, and value/part keywords. `_symKind` layers the manual override on top. */
function _autoSymKind(c){
  const rl = (/^[A-Za-z]+/.exec(c.ref) || ["U"])[0].toUpperCase();
  const n = c.pins.length;
  const val = ((c.value || "") + " " + (c.part || "")).toLowerCase();
  if (n === 2){
    switch (rl){
      case "R": case "RN": case "RV": case "VR": case "TH": return "resistor";
      case "C":
        // a polarized footprint (e-cap SMD / radial with the + marker on) or an
        // electrolytic/tantalum value keyword → polarized symbol
        if ((typeof compIsPolarized === "function" && compIsPolarized(c)) ||
            /elko|electroly|tantal|\btant\b|polar/.test(val)) return "cap_pol";
        return "capacitor";
      case "CP": case "CE": return "cap_pol";
      case "L": case "FB": case "FL": return "inductor";
      case "LED": return "led";
      case "D":
        if (/\bled\b/.test(val)) return "led";
        if (/zener|zdiode|bzx|zpd|zmm/.test(val)) return "zener";
        if (/schottky|\bbat\d|\bss\d|mbr|1n58/.test(val)) return "schottky";
        return "diode";
      case "Y": case "X": case "XTAL": case "OSC": case "QZ": return "crystal";
      case "F": return "fuse";
      case "BT": case "BAT": return "battery";
    }
    return null;
  }
  if (n === 3 && (rl === "Q" || rl === "T" || rl === "TR" || rl === "M")){
    if (/pnp/.test(val)) return "pnp";
    if (/npn/.test(val)) return "npn";
    if (/p.?mos|pfet|pch|p-?ch/.test(val)) return "pmos";
    if (/n.?mos|nfet|nch|n-?ch/.test(val)) return "nmos";
    if (/mos|fet/.test(val)) return "nmos";
    return "npn";
  }
  return null;
}

/* the effective symbol kind: the user's manual override (`comp.symOverride`) when set and
   valid for this pin count, else the auto guess. "box" forces a generic box (returns null). */
function _symKind(c){
  const ov = c && c.symOverride;
  if (ov){
    if (ov === "box") return null;
    if (symFitsPinCount(ov, c.pins.length)) return ov;   // ignore an override that no longer fits
  }
  return _autoSymKind(c);
}
/* the resolved symbol definition for a component, or null when it should stay a box */
function schSymFor(c){ const k = _symKind(c); return k ? SCH_SYM[k] : null; }

/* rotate a symbol-local point (mm, +y up) by the component's schematic rotation
   (c.schRot, CCW 90° steps). Shared by the exporter and the Schematic tab. */
function schRot2d(x, y, rot){
  switch (((rot || 0) % 360 + 360) % 360){
    case 90:  return { x: -y, y:  x };
    case 180: return { x: -x, y: -y };
    case 270: return { x:  y, y: -x };
    default:  return { x, y };
  }
}
/* a component's normalized schematic rotation */
function schRotOf(c){ return ((c.schRot || 0) % 360 + 360) % 360; }

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
    // R/C/L/D, transistors, LEDs, crystals… render as their real IEC/KiCad symbol;
    // everything else (ICs, multi-pin parts) stays a sized box, which is how KiCad
    // itself draws ICs (a background-filled rectangle with named pins).
    const kind = _symKind(c);
    const sym = kind ? SCH_SYM[kind] : null;
    let w, h, pins, body, hideNums, hideNames;
    if (sym){
      w = sym.w; h = sym.h; body = sym.body;
      hideNums = sym.hideNums; hideNames = sym.hideNames;
      pins = new Array(c.pins.length);
      if (c.pins.length === 2){
        // 2-pin symbol: put the part's two pins on the fixed left/right terminals,
        // honouring which physical pin the footprint placed on the right (side 1)
        let ri = c.pins.findIndex((_,i)=> pl.place[i] && pl.place[i].side === 1);
        if (ri < 0) ri = 1;
        const li = ri === 0 ? 1 : 0;
        pins[li] = { ...sym.term[0] };   // left
        pins[ri] = { ...sym.term[1] };   // right
      } else {
        // multi-terminal symbol (transistor/MOSFET): map pins to terminals by name (falling
        // back to pin-number order), routing a lone tab pad onto the collector/drain stub
        const a = assignSymTerminals(c, kind, sym);
        pins = a.pins;
        if (a.extra.length) body = sym.body.concat(a.extra);
      }
    } else {
      hideNums = false; hideNames = false;
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
    // effective bounding box for spacing: the box plus the pin stubs and the net
    // label text hung off each pin. Labels are what actually overlap between parts,
    // so arrangement/de-overlap must reserve room for them, not just the box.
    let leftExt = 0, rightExt = 0;
    for (let i=0;i<c.pins.length;i++){
      const pin = c.pins[i];
      const pg = pins[i];
      const stub = (pg ? Math.abs(pg.x) - w/2 + (pg.len||0) : 2.54);   // box edge → label anchor
      const nameLen = pin.netId ? (getNet(pin.netId)?.name || "").length : 0;
      const labelW = stub + nameLen * 1.05 + 2.0;                      // + text (~1.05mm/char) + tail
      if (pg && pg.angle === 180) rightExt = Math.max(rightExt, labelW);
      else                        leftExt  = Math.max(leftExt,  labelW);
    }
    const bw = w + 2 * Math.max(leftExt, rightExt);   // symmetric envelope (de-overlap tests centred boxes)
    const bh = h + 2 * 2.54;                           // ref/value text above and below the box
    geo.set(c.id, { w, h, pins, body, hideNums, hideNames, bw, bh });
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
    if (X > 320 || (groupKey && prevKey !== null && key !== prevKey)){ X = 30; Y += rowH + 15; rowH = 0; }
    rowH = Math.max(rowH, g.bh + 10);
    pos.set(c.id, { x: X, y: Y });
    X += g.bw + 15;
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
      const minX = (ga.bw+gb.bw)/2 + pad, minY = (ga.bh+gb.bh)/2 + pad;
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

/* "Optimized" — barycentric relaxation: every part is repeatedly pulled to the centroid
   of the parts it shares nets with, then everything is pushed apart until nothing
   overlaps. Converges on a layout where each net's members sit as close together as
   the no-overlap constraint allows. Seeded from the PCB layout. */
function schArrangeOpt(geo){
  const comps = State.components.filter(c => geo.has(c.id));
  const n = comps.length;
  const pos = schArrangePCB(geo);
  if (n < 2) return pos;
  const P = comps.map(c => { const p = pos.get(c.id); return { x:p.x, y:p.y }; });
  // adjacency: parts sharing a net (huge nets like GND excluded — they'd pull everything
  // into one clump and drown the signal nets)
  const nets = new Map();
  comps.forEach((c,i) => { for (const pin of c.pins) if (pin.netId){ let a = nets.get(pin.netId); if (!a) nets.set(pin.netId, a=new Set()); a.add(i); } });
  const neigh = comps.map(() => new Set());
  for (const s of nets.values()){
    const a = [...s];
    if (a.length < 2 || a.length > 40) continue;
    for (const i of a) for (const j of a) if (i !== j) neigh[i].add(j);
  }
  const rounds = n > 300 ? 10 : 25;
  for (let r=0; r<rounds; r++){
    for (let i=0;i<n;i++){
      const nb = neigh[i];
      if (!nb.size) continue;
      let cx=0, cy=0;
      for (const j of nb){ cx += P[j].x; cy += P[j].y; }
      P[i].x += (cx/nb.size - P[i].x) * 0.6;
      P[i].y += (cy/nb.size - P[i].y) * 0.6;
    }
    comps.forEach((c,i) => pos.set(c.id, { x:P[i].x, y:P[i].y }));
    schDeOverlap(pos, geo, 25);
    comps.forEach((c,i) => { const p = pos.get(c.id); P[i].x = p.x; P[i].y = p.y; });
  }
  schDeOverlap(pos, geo);
  return pos;
}

/* "Manual" — each component's saved schematic position (c.schX/schY in schematic mm,
   set by dragging in the Schematic tab). Parts never placed there yet are packed into
   grid rows BELOW the arranged ones; with no arranged parts at all this degrades to
   the default grouped grid. Shared by the exporter and the Schematic tab's seeding. */
function schArrangeManual(geo){
  const comps = State.components.filter(c => geo.has(c.id));
  const pos = new Map();
  const missing = [];
  let maxY = 0, any = false;
  for (const c of comps){
    if (typeof c.schX === "number" && typeof c.schY === "number"){
      pos.set(c.id, { x: c.schX, y: c.schY });
      maxY = Math.max(maxY, c.schY + geo.get(c.id).bh/2);
      any = true;
    } else missing.push(c);
  }
  if (!any) return schArrange("type", geo);
  if (missing.length){
    let X = 30, Y = maxY + 25, rowH = 0;
    for (const c of missing){
      const g = geo.get(c.id);
      if (X > 320){ X = 30; Y += rowH + 15; rowH = 0; }
      rowH = Math.max(rowH, g.bh + 10);
      pos.set(c.id, { x: X, y: Y });
      X += g.bw + 15;
    }
  }
  return pos;
}

/* dispatch the requested arrangement mode ("closest"|"pcb"|"type"|"name"|"manual"). */
function schArrange(mode, geo){
  const comps = State.components;
  if (!comps.length) return new Map();
  switch (mode){
    case "pcb":     return schArrangePCB(geo);
    case "closest": return schArrangeClosest(geo);
    case "opt":     return schArrangeOpt(geo);
    case "manual":  return schArrangeManual(geo);
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
  // Manual arrangement: hand-drawn schematic wires (State.schWires) are exported as real
  // KiCad wires, and nets they FULLY connect skip their global labels (the copper is
  // carried by the wires, exactly as drawn). Partially-wired nets keep every label so
  // connectivity survives; power nets always label (they're excluded from wiring).
  const wiredNets = new Set();
  const exportWires = mode === "manual" && typeof schNetStatus === "function" &&
                      State.schWires && State.schWires.length;
  if (exportWires){
    const stat = schNetStatus();
    for (const w of State.schWires)
      if (w.netId && w.a && w.b && (stat.get(w.netId) || {}).complete) wiredNets.add(w.netId);
  }
  L.push('(kicad_sch (version 20211123) (generator "pcb-reveng")');
  L.push('  (uuid ' + _uuid() + ')');
  L.push('  (paper "A2")');
  // one symbol definition per component (pin names/numbers are per-part)
  L.push('  (lib_symbols');
  for (const c of State.components){
    const g = geo.get(c.id);
    const refLetter = (/^[A-Za-z]+/.exec(c.ref)||["U"])[0];
    // include the component id so duplicate refdes (common in imported boards) don't
    // collide on one shared symbol definition — each part gets its own lib symbol
    const sym = "REV_" + c.ref + "_" + c.id;
    const { w, h, pins, body, hideNums, hideNames } = g;
    const hdr = (hideNums ? ' (pin_numbers (hide yes))' : '') + (hideNames ? ' (pin_names (hide yes))' : '');
    L.push('    (symbol "reveng:' + sym + '"' + hdr + ' (in_bom yes) (on_board yes)');
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
    let rot = schRotOf(c);   // manual rotation from the Schematic tab (R key)
    // manual flips (X/Y in the Schematic tab). Both flips together = a 180° rotation;
    // a single flip maps to KiCad's instance mirror.
    let fh = !!c.schFlipH, fv = !!c.schFlipV;
    if (fh && fv){ rot = (rot + 180) % 360; fh = fv = false; }
    const mirror = fh ? " (mirror y)" : fv ? " (mirror x)" : "";
    const sym = "REV_" + c.ref + "_" + c.id;
    L.push('  (symbol (lib_id "reveng:' + sym + '") (at ' + F(X) + ' ' + F(Y) + ' ' + rot + ')' + mirror + ' (unit 1) (in_bom yes) (on_board yes)');
    L.push('    (uuid ' + _uuid() + ')');
    L.push('    (property "Reference" "' + _schEsc(c.ref) + '" (at ' + F(X) + ' ' + F(Y-g.h/2-2.54) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('    (property "Value" "' + _schEsc(c.value || c.part || "~") + '" (at ' + F(X) + ' ' + F(Y+g.h/2+2.54) + ' 0) (effects (font (size 1.27 1.27))))');
    L.push('    (property "Footprint" "' + _schEsc(c.kicad || "") + '" (at ' + F(X) + ' ' + F(Y) + ' 0) (effects (font (size 1.27 1.27)) hide))');
    for (const p2 of c.pins) L.push('    (pin "' + _schEsc(p2.num) + '" (uuid ' + _uuid() + '))');
    L.push('  )');
    for (let i=0;i<c.pins.length;i++){
      const p2 = c.pins[i];
      if (!p2.netId) continue;
      if (wiredNets.has(p2.netId)) continue;   // net fully drawn as wires — no label needed
      const net = getNet(p2.netId);
      if (!net) continue;
      const pg = g.pins[i] || { x: -g.w/2-2.54, y: 0, angle: 0 };
      const rp = schRot2d(pg.x * (fh?-1:1), pg.y * (fv?-1:1), rot);  // pin offset follows flips + rotation
      let effA = pg.angle || 0;
      if (fh) effA = 180 - effA;
      if (fv) effA = -effA;
      const eff = ((effA + rot) % 360 + 360) % 360;    // effective pin direction after flips + rotation
      const px = X + rp.x;
      const py = Y - rp.y; // schematic y axis points down
      const labAngle = (eff + 180) % 360;              // label points away from the body
      const justRight = labAngle === 180 || labAngle === 270;
      L.push('  (global_label "' + _schEsc(net.name) + '" (shape passive) (at ' + F(px) + ' ' + F(py) + ' ' + labAngle + ') (fields_autoplaced)');
    L.push('    (effects (font (size 1.27 1.27)) (justify ' + (justRight?"right":"left") + '))');
      L.push('    (uuid ' + _uuid() + '))');
    }
  }
  // hand-drawn schematic wires (manual arrangement only) — one KiCad wire per segment
  if (exportWires) for (const w of State.schWires){
    if (!w.a || !w.b) continue;                       // dangling drafts don't export
    for (let i=0; i+1 < w.points.length; i++){
      const a = w.points[i], b = w.points[i+1];
      if (Math.abs(a.x-b.x) < 0.001 && Math.abs(a.y-b.y) < 0.001) continue;
      L.push('  (wire (pts (xy ' + F(a.x) + ' ' + F(a.y) + ') (xy ' + F(b.x) + ' ' + F(b.y) + '))');
      L.push('    (stroke (width 0) (type default)) (uuid ' + _uuid() + '))');
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
    case "eagle":return { text: exportEagleBRD(),  ext: "brd",       mime: "application/xml",  base: "board" };
    case "easyeda":return { text: exportEasyEDAPCB(), ext: "json",   mime: "application/json", base: "PCB_board" };
    case "gerber":return { text: gerberPreviewText(), ext: "zip",     mime: "application/zip",  base: gerberBaseName(), multi: true };
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
