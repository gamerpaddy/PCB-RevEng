/* ===== eagle.js — import / export Autodesk EAGLE board files (.brd) =====
   A .brd is XML (<!DOCTYPE eagle …>). We map:
     <element>  ⇄ component (fpId:"free", pads rebuilt from its <package>)
     <signal>   ⇄ net  (+ <contactref> → pin.netId, <wire> → traces, <via> → vias)
   Coordinates: EAGLE is millimetres, Y-up. Our world is pixels, Y-down, so
   world = (x_mm·k, −y_mm·k) with k = State.pxPerMm. A pad's local offset is stored
   raw (xmm = px, ymm = −py) and the component's rot/side reproduce EAGLE's
   rotate-after-mirror placement (comp.rot = −R, side = "back" when mirrored — the
   back-side X-flip in pinWorldPos supplies the mirror). Everything round-trips. */
"use strict";

/* ---------- shared helpers ---------- */

/* EAGLE rotation string → { mirror, angle }. Forms: R90, MR180, SR90 (spin), M … */
function eagleParseRot(s){
  s = s || "";
  const m = /R(-?\d+(?:\.\d+)?)/i.exec(s);
  return { mirror: /M/i.test(s), angle: m ? parseFloat(m[1]) : 0 };
}

function eagleNorm360(a){ return ((a % 360) + 360) % 360; }

/* ---------- IMPORT ---------- */

/* pads of a <package> as { name, x, y, shape:"circle"|"rect", w, h, size }.
   THT <pad> → round pad sized from its drill (EAGLE auto-sizes when no diameter);
   SMD <smd> → rectangle from dx/dy (swapped when the pad itself is rotated 90/270). */
function eaglePackagePads(pkg){
  const pads = [];
  if (!pkg) return pads;
  for (const pad of pkg.querySelectorAll("pad")){
    const drill = parseFloat(pad.getAttribute("drill")) || 0;
    const dia = parseFloat(pad.getAttribute("diameter")) || 0;
    const d = dia > 0 ? dia : Math.max(drill * 1.5, drill + 0.45, 0.6);
    pads.push({ name: pad.getAttribute("name"), x: +pad.getAttribute("x"), y: +pad.getAttribute("y"),
                shape: "circle", w: d, h: d, size: d });
  }
  for (const smd of pkg.querySelectorAll("smd")){
    let dx = parseFloat(smd.getAttribute("dx")) || 1, dy = parseFloat(smd.getAttribute("dy")) || 1;
    const r = eagleParseRot(smd.getAttribute("rot")).angle;
    if (r === 90 || r === 270) [dx, dy] = [dy, dx];
    pads.push({ name: smd.getAttribute("name"), x: +smd.getAttribute("x"), y: +smd.getAttribute("y"),
                shape: "rect", w: dx, h: dy, size: Math.max(dx, dy) });
  }
  return pads;
}

/* body rectangle for the free footprint (drawn centred on the package origin).
   Prefer the package's REAL outline — the silkscreen (tPlace/bPlace) and documentation
   (tDocu/bDocu) geometry the brd defines — so R/C/L get their true elongated shape
   instead of an oversized square derived from two tiny pads. Only when the package has
   no such outline do we fall back to the pad bounding box + a small margin.
   The body is symmetric about the origin (the free footprint can't offset it), so we
   take the largest absolute extent on each axis to guarantee it covers the outline. */
const EAGLE_BODY_LAYERS = new Set([21, 22, 51, 52]);   // tPlace/bPlace + tDocu/bDocu (NOT keepout/courtyard)
function eaglePackageBody(pkg, pads){
  let ax = 0, ay = 0, any = false;
  const ext = (x, y) => { ax = Math.max(ax, Math.abs(x)); ay = Math.max(ay, Math.abs(y)); any = true; };
  if (pkg){
    for (const w of pkg.querySelectorAll("wire")){
      if (!EAGLE_BODY_LAYERS.has(+w.getAttribute("layer"))) continue;
      ext(+w.getAttribute("x1"), +w.getAttribute("y1")); ext(+w.getAttribute("x2"), +w.getAttribute("y2"));
    }
    for (const r of pkg.querySelectorAll("rectangle")){
      if (!EAGLE_BODY_LAYERS.has(+r.getAttribute("layer"))) continue;
      ext(+r.getAttribute("x1"), +r.getAttribute("y1")); ext(+r.getAttribute("x2"), +r.getAttribute("y2"));
    }
    for (const c of pkg.querySelectorAll("circle")){
      if (!EAGLE_BODY_LAYERS.has(+c.getAttribute("layer"))) continue;
      const cx = +c.getAttribute("x"), cy = +c.getAttribute("y"), rad = parseFloat(c.getAttribute("radius")) || 0;
      ext(cx + rad, cy + rad); ext(cx - rad, cy - rad);
    }
    for (const v of pkg.querySelectorAll("polygon > vertex")){
      if (!EAGLE_BODY_LAYERS.has(+v.parentElement.getAttribute("layer"))) continue;
      ext(+v.getAttribute("x"), +v.getAttribute("y"));
    }
  }
  if (!any){                                   // no outline in the brd → pad bbox + 0.3 mm margin
    for (const p of pads){ ax = Math.max(ax, Math.abs(p.x) + p.w / 2 + 0.3); ay = Math.max(ay, Math.abs(p.y) + p.h / 2 + 0.3); }
  }
  return { w: Math.max(1, +(2 * ax).toFixed(3)), h: Math.max(1, +(2 * ay).toFixed(3)) };
}

/* the board's copper stackup, top→bottom, as EAGLE layer numbers → app side names.
   The authoritative source is the layerSetup design rule (e.g. "(1+2*15+16)" → a
   4-layer board on copper layers 1,2,15,16); we fall back to the copper layers that
   actually carry signal wires (always including the outer 1 & 16). Returns a Map. */
function eagleCopperSideMap(board){
  let copper = null;
  for (const p of board.querySelectorAll("designrules > param")){
    if (p.getAttribute("name") === "layerSetup"){
      const nums = (p.getAttribute("value") || "").match(/\d+/g);
      if (nums){
        copper = [];
        for (const n of nums.map(Number)) if (n >= 1 && n <= 16 && !copper.includes(n)) copper.push(n);
      }
    }
  }
  if (!copper || copper.length < 2){                          // fall back to layers with copper
    const used = new Set([1, 16]);
    for (const w of board.querySelectorAll("signals > signal > wire")){
      const L = +w.getAttribute("layer"); if (L >= 1 && L <= 16) used.add(L);
    }
    copper = [...used].sort((a, b) => a - b);
  }
  const map = new Map();
  copper.forEach((ln, i) => map.set(ln, i === 0 ? "front" : i === copper.length - 1 ? "back" : "inner" + i));
  return map;
}

/* chain a signal's wire segments into polylines, grouped by side + width, so a
   routed track becomes one trace instead of dozens of one-segment traces. Segments
   are joined where their endpoints coincide (quantised to 1 µm). sideMap resolves each
   EAGLE copper-layer number to the app side name. */
function eagleChainWires(wires, sideMap){
  const q = n => Math.round(n * 1000) / 1000;                 // µm grid
  const key = (x, y) => q(x) + "," + q(y);
  const groups = new Map();
  for (const w of wires){
    const gk = w.layer + "|" + w.width.toFixed(4);
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(w);
  }
  const out = [];
  for (const segs of groups.values()){
    const side = sideMap.get(segs[0].layer) || "front";
    const width = segs[0].width;
    const used = new Array(segs.length).fill(false);
    const byPt = new Map();
    segs.forEach((s, i) => {
      for (const kk of [key(s.x1, s.y1), key(s.x2, s.y2)]){
        if (!byPt.has(kk)) byPt.set(kk, []);
        byPt.get(kk).push(i);
      }
    });
    const grow = (pts, atStart) => {
      for (;;){
        const end = atStart ? pts[0] : pts[pts.length - 1];
        const cand = byPt.get(key(end.x, end.y)) || [];
        let hit = -1;
        for (const j of cand){ if (!used[j]){ hit = j; break; } }
        if (hit < 0) break;
        const s = segs[hit]; used[hit] = true;
        const p = (key(s.x1, s.y1) === key(end.x, end.y)) ? { x: s.x2, y: s.y2 } : { x: s.x1, y: s.y1 };
        if (atStart) pts.unshift(p); else pts.push(p);
      }
    };
    for (let i = 0; i < segs.length; i++){
      if (used[i]) continue;
      used[i] = true;
      const s = segs[i];
      const pts = [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
      grow(pts, false); grow(pts, true);
      out.push({ side, width, points: pts });
    }
  }
  return out;
}

/* parse a .brd string into State (replacing the current project). Returns a summary
   { components, nets, traces, vias } or throws on a non-board / malformed file. */
function importEagleBRD(xmlText){
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Could not parse the file as XML.");
  if (!doc.querySelector("eagle")) throw new Error("Not an EAGLE file (missing <eagle> root).");
  const board = doc.querySelector("board");
  if (!board) throw new Error("No <board> section — EAGLE schematics (.sch) aren’t supported, only boards (.brd).");

  resetProject();
  const k = State.pxPerMm;

  // copper stackup (2-, 4-, 6-layer …) from the board's layerSetup, so inner-layer
  // traces land on the right side and the app shows the correct number of layers
  const sideMap = eagleCopperSideMap(board);
  State.layerCount = sideMap.size;
  const sides = availableSides();
  const outerLo = sides[0], outerHi = sides[sides.length - 1];

  // library → package index ("lib\0pkg" → <package>)
  const pkgIndex = new Map();
  for (const lib of board.querySelectorAll("libraries > library")){
    const ln = lib.getAttribute("name");
    for (const pkg of lib.querySelectorAll("packages > package"))
      pkgIndex.set(ln + " " + pkg.getAttribute("name"), pkg);
  }

  // elements → components
  const compByRef = new Map();
  for (const el of board.querySelectorAll("elements > element")){
    const ref = el.getAttribute("name") || nextRef("U");
    const pkg = pkgIndex.get(el.getAttribute("library") + " " + el.getAttribute("package"));
    const pads = eaglePackagePads(pkg);
    const { mirror, angle } = eagleParseRot(el.getAttribute("rot"));
    const pinList = [], pins = [];
    for (const p of pads){
      pinList.push({ num: String(p.name), x: +p.x.toFixed(4), y: +(-p.y).toFixed(4),
                     shape: p.shape, w: +p.w.toFixed(4), h: +p.h.toFixed(4), size: +p.size.toFixed(3) });
      pins.push({ num: String(p.name), name: "", netId: null });
    }
    const body = eaglePackageBody(pkg, pads);
    const comp = {
      id: nextId(), ref, value: el.getAttribute("value") || "", part: "", fpId: "free",
      fpParams: { w: body.w, h: body.h, pinList }, kicad: "",
      x: (+el.getAttribute("x")) * k, y: (-(+el.getAttribute("y"))) * k,
      rot: eagleNorm360(-angle), side: mirror ? "back" : "front", scale: 1,
      pins, bom: {}, _fp: null,
    };
    State.components.push(comp);
    registerRef(ref);
    compByRef.set(ref, comp);
  }

  // signals → nets + connectivity + copper
  let traceCount = 0, viaCount = 0;
  for (const sig of board.querySelectorAll("signals > signal")){
    const net = createNet(sig.getAttribute("name") || "");
    for (const cr of sig.querySelectorAll("contactref")){
      const c = compByRef.get(cr.getAttribute("element"));
      if (!c) continue;
      const pad = String(cr.getAttribute("pad"));
      const i = c.pins.findIndex(p => String(p.num) === pad);
      if (i >= 0) c.pins[i].netId = net.id;
    }
    for (const via of sig.querySelectorAll("via")){
      const drill = parseFloat(via.getAttribute("drill")) || 0.4;
      const v = { id: nextId(), x: (+via.getAttribute("x")) * k, y: (-(+via.getAttribute("y"))) * k,
                  netId: net.id, r: Math.max((drill / 2 + 0.2) * k, 3),
                  hole: (drill / 2) * k, kind: "via" };   // keep the real drill so probing shows it (not the global default)
      // blind/buried via: extent="a-b" gives the copper layers it spans; record from/to
      // only when it's NOT a full outer-to-outer through via
      const m = /(\d+)\s*-\s*(\d+)/.exec(via.getAttribute("extent") || "");
      if (m){
        const a = sideMap.get(+m[1]), b = sideMap.get(+m[2]);
        if (a && b && !(a === outerLo && b === outerHi)){ v.from = a; v.to = b; }
      }
      State.vias.push(v);
      viaCount++;
    }
    const wires = [...sig.querySelectorAll("wire")]
      .map(w => ({ x1: +w.getAttribute("x1"), y1: +w.getAttribute("y1"),
                   x2: +w.getAttribute("x2"), y2: +w.getAttribute("y2"),
                   layer: +w.getAttribute("layer"), width: parseFloat(w.getAttribute("width")) || 0.2 }))
      .filter(w => sideMap.has(w.layer));                       // copper layers only (any of the stackup)
    for (const poly of eagleChainWires(wires, sideMap)){
      State.traces.push({ id: nextId(), side: poly.side, netId: net.id, width: poly.width * k,
                          points: poly.points.map(p => ({ x: p.x * k, y: -p.y * k })) });
      traceCount++;
    }
  }
  pruneNets();

  return { components: State.components.length, nets: State.nets.length, traces: traceCount, vias: viaCount,
           layers: State.layerCount };
}

/* ---------- EXPORT ---------- */

function eagleXmlEsc(s){
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* canonical EAGLE-7 layer table (needed for a file EAGLE will open) */
const EAGLE_LAYERS = [
  [1,"Top","4","1","yes","yes"],[16,"Bottom","1","1","yes","yes"],[17,"Pads","2","1","yes","yes"],
  [18,"Vias","14","1","yes","yes"],[19,"Unrouted","6","1","yes","yes"],[20,"Dimension","24","1","yes","yes"],
  [21,"tPlace","7","1","yes","yes"],[22,"bPlace","7","1","yes","yes"],[25,"tNames","7","1","yes","yes"],
  [26,"bNames","7","1","yes","yes"],[27,"tValues","7","1","no","yes"],[28,"bValues","7","1","no","yes"],
  [29,"tStop","2","3","no","yes"],[30,"bStop","5","6","no","yes"],[44,"Drills","7","1","no","yes"],
  [45,"Holes","7","1","no","yes"],[51,"tDocu","7","1","yes","yes"],[52,"bDocu","7","1","yes","yes"],
];

/* our side name → EAGLE copper layer number */
function eagleLayerForSide(side){
  if (side === "front") return 1;
  if (side === "back") return 16;
  const m = /inner(\d+)/.exec(side || "");
  return m ? Math.min(15, 1 + parseInt(m[1], 10)) : 1;         // inner1→2, inner2→3 …
}

/* EAGLE rot string for a component (inverse of the import mapping) */
function eagleElementRot(c){
  const a = eagleNorm360(-(c.rot || 0));
  const mir = c.side === "back";
  if (!mir && a === 0) return null;
  return (mir ? "MR" : "R") + (Number.isInteger(a) ? a : a.toFixed(1));
}

/* build a <package> for a component from its resolved footprint pins */
function eaglePackageXml(name, fp){
  const L = ['<package name="' + eagleXmlEsc(name) + '">'];
  for (const pin of fp.pins){
    const px = (+pin.xmm).toFixed(4), py = (-pin.ymm).toFixed(4);
    if (pin.shape === "rect"){
      L.push('<smd name="' + eagleXmlEsc(pin.num) + '" x="' + px + '" y="' + py +
             '" dx="' + (+pin.w).toFixed(4) + '" dy="' + (+pin.h).toFixed(4) + '" layer="1"/>');
    } else {
      const dia = Math.max(0.3, +pin.w);
      L.push('<pad name="' + eagleXmlEsc(pin.num) + '" x="' + px + '" y="' + py +
             '" drill="' + Math.max(0.3, dia * 0.55).toFixed(3) + '" diameter="' + dia.toFixed(3) + '" shape="round"/>');
    }
  }
  L.push('</package>');
  return L.join("\n");
}

/* serialise the whole project to an EAGLE 7.x .brd string */
function exportEagleBRD(){
  const k = State.pxPerMm;
  const F = n => (Math.round(n * 10000) / 10000);
  const mmX = px => F(px / k), mmY = px => F(-px / k);        // world px → EAGLE mm (Y-up)

  // board extent (for a simple dimension outline)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };
  for (const t of State.traces) for (const p of t.points) grow(mmX(p.x), mmY(p.y));
  for (const c of State.components) grow(mmX(c.x), mmY(c.y));
  if (!isFinite(minX)){ minX = minY = 0; maxX = maxY = 100; }
  const pad = 2; minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const L = [];
  L.push('<?xml version="1.0" encoding="utf-8"?>');
  L.push('<!DOCTYPE eagle SYSTEM "eagle.dtd">');
  L.push('<eagle version="7.1.2">');
  L.push('<drawing>');
  L.push('<settings><setting alwaysvectorfont="yes"/><setting verticaltext="up"/></settings>');
  L.push('<grid distance="0.05" unitdist="mm" unit="mm" style="lines" multiple="1" display="no"/>');
  // copper stackup: 1 (top), inner route layers 2…N-1, 16 (bottom)
  const nLayers = Math.max(2, State.layerCount || 2);
  const copperNums = [1];
  for (let i = 1; i <= nLayers - 2; i++) copperNums.push(1 + i);   // inner_i → layer 1+i
  copperNums.push(16);

  L.push('<layers>');
  for (const [n, nm, col, fill, vis, act] of EAGLE_LAYERS)
    L.push('<layer number="' + n + '" name="' + nm + '" color="' + col + '" fill="' + fill + '" visible="' + vis + '" active="' + act + '"/>');
  for (let i = 1; i <= nLayers - 2; i++)                           // inner Route layer definitions
    L.push('<layer number="' + (1 + i) + '" name="Route' + (1 + i) + '" color="' + (1 + i) + '" fill="1" visible="yes" active="yes"/>');
  L.push('</layers>');
  L.push('<board>');

  // outline on the Dimension layer
  L.push('<plain>');
  const rect = [[minX, minY, maxX, minY], [maxX, minY, maxX, maxY], [maxX, maxY, minX, maxY], [minX, maxY, minX, minY]];
  for (const [x1, y1, x2, y2] of rect)
    L.push('<wire x1="' + F(x1) + '" y1="' + F(y1) + '" x2="' + F(x2) + '" y2="' + F(y2) + '" width="0.2032" layer="20"/>');
  L.push('</plain>');

  // one package per component (named after its ref)
  L.push('<libraries>');
  L.push('<library name="reveng">');
  L.push('<packages>');
  const pkgName = new Map();
  for (const c of State.components){
    const nm = "PKG_" + (c.ref || ("U" + c.id)).replace(/[^A-Za-z0-9_.\-]/g, "_");
    pkgName.set(c.id, nm);
    L.push(eaglePackageXml(nm, compFootprint(c)));
  }
  L.push('</packages>');
  L.push('</library>');
  L.push('</libraries>');

  L.push('<classes><class number="0" name="default" width="0" drill="0"/></classes>');

  // record the copper stackup so a re-import restores the right layer count
  L.push('<designrules name="default">');
  L.push('<param name="layerSetup" value="(' + copperNums.join('*') + ')"/>');
  L.push('</designrules>');

  // elements
  L.push('<elements>');
  for (const c of State.components){
    const rot = eagleElementRot(c);
    L.push('<element name="' + eagleXmlEsc(c.ref) + '" library="reveng" package="' + eagleXmlEsc(pkgName.get(c.id)) +
           '" value="' + eagleXmlEsc(c.value || c.part || "") + '" x="' + mmX(c.x) + '" y="' + mmY(c.y) + '"' +
           (rot ? ' rot="' + rot + '"' : '') + '/>');
  }
  L.push('</elements>');

  // signals: net → contactrefs + copper wires + vias
  L.push('<signals>');
  const tracesByNet = new Map(), viasByNet = new Map();
  for (const t of State.traces){ if (t.netId == null) continue; (tracesByNet.get(t.netId) || tracesByNet.set(t.netId, []).get(t.netId)).push(t); }
  for (const v of State.vias){ if (v.netId == null) continue; (viasByNet.get(v.netId) || viasByNet.set(v.netId, []).get(v.netId)).push(v); }
  const pinsByNet = buildNetMap();                             // netId → [{ref,pin}]
  const netIds = new Set([...pinsByNet.keys(), ...tracesByNet.keys(), ...viasByNet.keys()]);
  for (const net of State.nets){
    if (!netIds.has(net.id)) continue;
    L.push('<signal name="' + eagleXmlEsc(net.name) + '">');
    for (const node of (pinsByNet.get(net.id) || []))
      L.push('<contactref element="' + eagleXmlEsc(node.ref) + '" pad="' + eagleXmlEsc(node.pin) + '"/>');
    for (const t of (tracesByNet.get(net.id) || [])){
      const layer = eagleLayerForSide(t.side), w = F((t.width || State.traceW) / k);
      for (let i = 0; i < t.points.length - 1; i++){
        const a = t.points[i], b = t.points[i + 1];
        L.push('<wire x1="' + mmX(a.x) + '" y1="' + mmY(a.y) + '" x2="' + mmX(b.x) + '" y2="' + mmY(b.y) +
               '" width="' + w + '" layer="' + layer + '"/>');
      }
    }
    for (const v of (viasByNet.get(net.id) || [])){
      const drill = Math.max(0.3, F((v.r / k)));
      L.push('<via x="' + mmX(v.x) + '" y="' + mmY(v.y) + '" extent="1-16" drill="' + drill + '" shape="round"/>');
    }
    L.push('</signal>');
  }
  L.push('</signals>');

  L.push('</board>');
  L.push('</drawing>');
  L.push('</eagle>');
  return L.join("\n");
}
