/* ===== gencad.js — import GENCAD 1.4 board files (.cad) =====
   A second boardview format. GENCAD is a line-oriented text format split into
   $SECTION … $ENDSECTION blocks. We map:
     $COMPONENTS ⇄ components   (footprint from $SHAPES → pins → $PADSTACKS → $PADS)
     $SIGNALS    ⇄ nets         (NODE ref pin → pin.netId)
     $ROUTES     ⇄ traces + vias (LINE/ARC per LAYER/TRACK width, VIA entries)
   Coordinates are in the header's UNITS (usually USER n = n units per inch, i.e. mils).
   Like the EAGLE importer, world = (x·u·k, −y·u·k) with u = unit→mm, k = State.pxPerMm,
   and a placed part becomes a free component (rot = −ROTATION, side = back for LAYER
   BOTTOM). Reuses eagleChainWires / eaglePackageBody / eagleNorm360 from eagle.js. */
"use strict";

/* tokenise a GENCAD line, honouring "quoted strings" as single tokens */
function gencadTokens(line){
  const out = [], re = /"([^"]*)"|(\S+)/g;
  let m; while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

/* split the file into { SECTION: [lines…] } (without the $HEADER/$END markers) */
function gencadSections(text){
  const sections = {};
  let buf = null;
  for (const raw of text.split(/\r?\n/)){
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === "$"){
      const name = line.slice(1).split(/\s+/)[0];
      buf = name.startsWith("END") ? null : (sections[name] = sections[name] || []);
      continue;
    }
    if (buf) buf.push(line);
  }
  return sections;
}

/* header UNITS → millimetres per unit. USER n = n units/inch (mils when n=1000). */
function gencadUnitToMm(headerLines){
  for (const line of headerLines){
    const t = line.split(/\s+/);
    if (t[0] !== "UNITS") continue;
    const u = (t[1] || "").toUpperCase();
    if (u === "INCH") return 25.4;
    if (u === "MM") return 1;
    if (u === "MIL" || u === "MILS" || u === "THOU") return 0.0254;
    if (u === "USER"){ const n = parseFloat(t[2]); return n > 0 ? 25.4 / n : 0.0254; }
  }
  return 0.0254;   // default: mils
}

/* copper-layer count from the header's "Number of Routing Layers" attribute */
function gencadLayerCount(headerLines){
  for (const line of headerLines){
    const m = /Routing Layers"?\s+"?(\d+)/i.exec(line);
    if (m){ const n = parseInt(m[1], 10); if (n >= 2 && n <= 32) return n; }
  }
  return 2;
}

/* GENCAD copper layer name → app side */
function gencadSide(name){
  const n = (name || "").toUpperCase();
  if (n === "TOP") return "front";
  if (n === "BOTTOM") return "back";
  const m = /INNER\D*(\d+)/.exec(n);
  return m ? "inner" + m[1] : "front";
}

/* $PADS → name → { shape:"circle"|"rect", w, h } in raw units (circle w=h=diameter,
   rect/finger from the geometry's bounding box) */
function gencadParsePads(lines){
  const pads = new Map();
  let name = null, isCirc = false, cr = 0, minX, minY, maxX, maxY;
  const ext = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  const flush = () => {
    if (name == null) return;
    if (isCirc) pads.set(name, { shape: "circle", w: cr * 2, h: cr * 2 });
    else if (isFinite(minX)) pads.set(name, { shape: "rect", w: maxX - minX, h: maxY - minY });
    else pads.set(name, { shape: "circle", w: 1, h: 1 });
  };
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "PAD"){ flush(); name = t[1]; isCirc = false; cr = 0; minX = minY = Infinity; maxX = maxY = -Infinity; }
    else if (name != null){
      if (t[0] === "CIRCLE"){ isCirc = true; cr = Math.abs(parseFloat(t[3])); }
      else if (t[0] === "RECTANGLE"){ const x = +t[1], y = +t[2]; ext(x, y); ext(x + +t[3], y + +t[4]); }
      else if (t[0] === "LINE"){ ext(+t[1], +t[2]); ext(+t[3], +t[4]); }
      else if (t[0] === "ARC"){ ext(+t[1], +t[2]); ext(+t[3], +t[4]); }
    }
  }
  flush();
  return pads;
}

/* $PADSTACKS → name → { drill, top:padName } (top = the pad used on the TOP layer) */
function gencadParsePadstacks(lines){
  const ps = new Map();
  let cur = null;
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "PADSTACK"){ cur = { drill: parseFloat(t[2]) || 0, top: null }; ps.set(t[1], cur); }
    else if (cur && t[0] === "PAD"){
      const layer = t[2];
      if (layer === "TOP") cur.top = t[1];
      else if (!cur.top && !/^SOLDER/.test(layer)) cur.top = t[1];   // fall back to first copper pad
    }
  }
  return ps;
}

/* resolve a pin's padstack to its copper pad shape/size (raw units). The padstack DRILL
   decides through-hole vs SMD: THT → round pad with a drill; SMD → the copper's real
   shape (round or rectangular) with no hole. */
function gencadPinPad(padstackName, padstacks, pads){
  const ps = padstacks.get(padstackName);
  const pad = ps && ps.top ? pads.get(ps.top) : null;
  const tht = !!(ps && ps.drill > 0);
  if (pad) return { shape: tht ? "circle" : pad.shape, w: pad.w, h: pad.h, tht };
  const d = tht ? ps.drill : 12;
  return { shape: "circle", w: d, h: d, tht };
}
/* a via's radius (raw units) plus whether the file actually specified it. `known`
   vias keep their real size; unspecified ones are sized to avoid overlaps later. */
function gencadViaRadius(padstackName, padstacks, pads){
  const ps = padstacks.get(padstackName);
  const pad = ps && ps.top ? pads.get(ps.top) : null;
  if (pad && (pad.w || pad.h)) return { r: Math.max(pad.w, pad.h) / 2, known: true };
  if (ps && ps.drill > 0) return { r: ps.drill / 2 + 3, known: false };
  return { r: 8, known: false };
}

/* size vias in world px. Known-size vias keep the file's real radius (just floored so
   they stay visible). Vias with no size in the file get their provisional radius shrunk
   so they don't overlap the nearest via, with a small margin — as requested for files
   that don't specify via sizes. A uniform grid keeps the neighbour search cheap. */
function gencadFitViaSizes(vias, k){
  for (const v of vias) if (v.known) v.r = Math.max(v.r, 0.6);
  const unknown = vias.filter(v => !v.known);
  if (!unknown.length) return;
  const MIN = 1.2, MARGIN = 0.12 * k, cell = 40;
  const grid = new Map();
  const key = (cx, cy) => cx + "," + cy;
  vias.forEach(v => { const kk = key(Math.floor(v.x/cell), Math.floor(v.y/cell)); (grid.get(kk) || grid.set(kk, []).get(kk)).push(v); });
  for (const v of unknown){
    const cx = Math.floor(v.x/cell), cy = Math.floor(v.y/cell);
    let nearest = Infinity;
    for (let gx = cx-1; gx <= cx+1; gx++) for (let gy = cy-1; gy <= cy+1; gy++){
      const arr = grid.get(key(gx, gy)); if (!arr) continue;
      for (const o of arr){ if (o === v) continue; const d = Math.hypot(v.x-o.x, v.y-o.y); if (d > 0 && d < nearest) nearest = d; }
    }
    v.r = isFinite(nearest) ? Math.max(MIN, Math.min(v.r, nearest/2 - MARGIN)) : Math.max(MIN, v.r);
  }
}

/* $SHAPES → name → { pins:[{name,padstack,x,y,rot}] } (raw units, shape-local coords) */
function gencadParseShapes(lines){
  const shapes = new Map();
  let cur = null;
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "SHAPE"){ cur = { pins: [] }; shapes.set(t[1], cur); }
    else if (cur && t[0] === "PIN")
      cur.pins.push({ name: t[1], padstack: t[2], x: +t[3], y: +t[4], rot: parseFloat(t[6]) || 0 });
  }
  return shapes;
}

/* $DEVICES → name → { part, value } (value defaults to the device name) */
function gencadParseDevices(lines){
  const dev = new Map();
  let cur = null;
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "DEVICE"){ cur = { part: "", value: t[1] }; dev.set(t[1], cur); }
    else if (cur){ if (t[0] === "PART") cur.part = t[1]; else if (t[0] === "VALUE") cur.value = t[1]; }
  }
  return dev;
}

/* $COMPONENTS → [{ref,x,y,layer,rot,shape,device}] (raw units) */
function gencadParseComponents(lines){
  const comps = [];
  let cur = null;
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "COMPONENT"){ cur = { ref: t[1], x: 0, y: 0, layer: "TOP", rot: 0, shape: null, device: null }; comps.push(cur); }
    else if (cur){
      if (t[0] === "PLACE"){ cur.x = +t[1]; cur.y = +t[2]; }
      else if (t[0] === "LAYER") cur.layer = t[1];
      else if (t[0] === "ROTATION") cur.rot = parseFloat(t[1]) || 0;
      else if (t[0] === "SHAPE") cur.shape = t[1];
      else if (t[0] === "DEVICE") cur.device = t[1];
    }
  }
  return comps;
}

/* $SIGNALS → [{name, nodes:[{ref,pin}]}] */
function gencadParseSignals(lines){
  const sigs = [];
  let cur = null;
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "SIGNAL"){ cur = { name: t[1], nodes: [] }; sigs.push(cur); }
    else if (cur && t[0] === "NODE") cur.nodes.push({ ref: t[1], pin: t[2] });
  }
  return sigs;
}

/* $TRACKS → id → width (raw units) */
function gencadParseTracks(lines){
  const tracks = new Map();
  for (const line of lines){
    const t = gencadTokens(line);
    if (t[0] === "TRACK") tracks.set(t[1], parseFloat(t[2]) || 0);
  }
  return tracks;
}

/* $ROUTES → { segsByNet: Map(net → [{x1,y1,x2,y2,side,width}]), vias:[{x,y,net,r}] }
   all in raw units. LAYER and TRACK are stateful within a ROUTE. */
function gencadParseRoutes(lines, tracks, padstacks, pads){
  const segsByNet = new Map(), vias = [];
  let net = null, side = "front", width = 1;
  const seg = (x1, y1, x2, y2) => {
    if (!net) return;
    let a = segsByNet.get(net); if (!a) segsByNet.set(net, a = []);
    a.push({ x1, y1, x2, y2, side, width });
  };
  for (const line of lines){
    const t = gencadTokens(line);
    switch (t[0]){
      case "ROUTE":  net = t[1]; side = "front"; width = 1; break;
      case "LAYER":  side = gencadSide(t[1]); break;
      case "TRACK":  { const w = tracks.get(t[1]); if (w != null) width = w; break; }
      case "LINE":   seg(+t[1], +t[2], +t[3], +t[4]); break;
      case "ARC":    seg(+t[1], +t[2], +t[3], +t[4]); break;   // chord approximation
      case "VIA":    if (net){ const vr = gencadViaRadius(t[1], padstacks, pads); vias.push({ x: +t[2], y: +t[3], net, r: vr.r, known: vr.known }); } break;
    }
  }
  return { segsByNet, vias };
}

/* parse a GENCAD .cad string into State (replacing the current project). Returns a
   summary { components, nets, traces, vias, layers } or throws on a bad file. */
function importGencadCAD(text){
  const sec = gencadSections(text);
  if (!sec.HEADER) throw new Error("Not a GENCAD file (no $HEADER section).");
  if (!sec.COMPONENTS && !sec.ROUTES) throw new Error("No $COMPONENTS or $ROUTES — not a usable GENCAD board.");

  const u = gencadUnitToMm(sec.HEADER);
  resetProject();
  const k = State.pxPerMm;

  const pads = gencadParsePads(sec.PADS || []);
  const padstacks = gencadParsePadstacks(sec.PADSTACKS || []);
  const shapes = gencadParseShapes(sec.SHAPES || []);
  const devices = gencadParseDevices(sec.DEVICES || []);
  const tracks = gencadParseTracks(sec.TRACKS || []);

  // Layer count = the board's real stackup: the header's "Number of Routing Layers", at
  // least as deep as any inner layer that actually carries copper. Some GENCAD exports
  // omit the inner power/ground PLANE copper entirely — only top/bottom signal copper and
  // the via stitching are written — so those inner layers come in empty. We still show the
  // true layer count (like a 4-layer EAGLE board) and report how many inner layers have no
  // copper geometry in the file.
  const { segsByNet, vias } = gencadParseRoutes(sec.ROUTES || [], tracks, padstacks, pads);
  const usedInner = new Set();
  for (const segs of segsByNet.values()) for (const s of segs){ const m = /inner(\d+)/.exec(s.side); if (m) usedInner.add(+m[1]); }
  const deepestUsed = usedInner.size ? Math.max(...usedInner) : 0;
  State.layerCount = Math.max(2, deepestUsed + 2, gencadLayerCount(sec.HEADER));
  const emptyInner = (State.layerCount - 2) - usedInner.size;

  // components (footprint pins resolved through shape → padstack → pad)
  const compByRef = new Map();
  for (const cd of gencadParseComponents(sec.COMPONENTS || [])){
    const shape = shapes.get(cd.shape);
    const pinList = [], pins = [], padMm = [];
    if (shape) for (const pin of shape.pins){
      const pd = gencadPinPad(pin.padstack, padstacks, pads);
      let w = pd.w, h = pd.h;
      if (pin.rot === 90 || pin.rot === 270){ const tmp = w; w = h; h = tmp; }   // rotated pad
      const xmm = pin.x * u, ymm = -pin.y * u, wmm = w * u, hmm = h * u;
      pinList.push({ num: String(pin.name), x: +xmm.toFixed(4), y: +ymm.toFixed(4),
                     shape: pd.shape, w: +wmm.toFixed(4), h: +hmm.toFixed(4), size: +Math.max(wmm, hmm).toFixed(3),
                     tht: pd.tht });
      pins.push({ num: String(pin.name), name: "", netId: null });
      padMm.push({ x: xmm, y: ymm, w: wmm, h: hmm });
    }
    const body = eaglePackageBody(null, padMm);
    const dev = devices.get(cd.device);
    const comp = {
      id: nextId(), ref: cd.ref, value: dev ? dev.value : (cd.device || ""), part: dev ? dev.part : "", fpId: "free",
      fpParams: { w: body.w, h: body.h, pinList }, kicad: "",
      x: cd.x * u * k, y: -cd.y * u * k, rot: eagleNorm360(-cd.rot),
      side: cd.layer === "BOTTOM" ? "back" : "front", scale: 1,
      pins, bom: {}, _fp: null,
    };
    State.components.push(comp);
    registerRef(cd.ref);
    compByRef.set(cd.ref, comp);
  }

  // nets from signals (+ pin connectivity)
  const netByName = new Map();
  const netFor = (name) => { let n = netByName.get(name); if (!n){ n = createNet(name || ""); netByName.set(name, n); } return n; };
  for (const sig of gencadParseSignals(sec.SIGNALS || [])){
    const net = netFor(sig.name);
    for (const nd of sig.nodes){
      const c = compByRef.get(nd.ref); if (!c) continue;
      const i = c.pins.findIndex(p => String(p.num) === String(nd.pin));
      if (i >= 0) c.pins[i].netId = net.id;
    }
  }

  // traces (chained polylines)
  const sideMap = new Map();
  for (const s of availableSides()) sideMap.set(s, s);          // identity: segments already carry app sides
  let traceCount = 0;
  for (const [netName, segs] of segsByNet){
    const net = netFor(netName);
    const wires = segs.map(s => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, layer: s.side, width: s.width }));
    for (const poly of eagleChainWires(wires, sideMap)){
      State.traces.push({ id: nextId(), side: poly.side, netId: net.id, width: poly.width * u * k,
                          points: poly.points.map(p => ({ x: p.x * u * k, y: -p.y * u * k })) });
      traceCount++;
    }
  }

  // vias — keep the file's real pad size (no min-clamp inflation); size any that the
  // file leaves unspecified so they don't overlap a neighbour (see gencadFitViaSizes)
  const vlist = vias.map(v => ({ x: v.x * u * k, y: -v.y * u * k, net: v.net, r: v.r * u * k, known: v.known }));
  gencadFitViaSizes(vlist, k);
  for (const v of vlist)
    State.vias.push({ id: nextId(), x: v.x, y: v.y, netId: netFor(v.net).id, r: v.r, kind: "via" });
  pruneNets();

  return { components: State.components.length, nets: State.nets.length, traces: traceCount, vias: vlist.length,
           layers: State.layerCount, emptyInner };
}
