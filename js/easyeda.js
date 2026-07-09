/* ===== easyeda.js — export to EasyEDA / JLCEDA Standard Edition v6 PCB (.json) =====
   The container is JSON; primitives live as `~`-delimited strings inside `shape[]`
   ("TRACK~w~layer~net~x1 y1 …", "VIA~x~y~d~net~drill…", "LIB~x~y~…#@$PAD~…").
   Coord unit is EasyEDA's "10 mil" = 0.254 mm; Y grows downward (same as our world),
   so no Y-flip. Origin is offset so the board bbox lands near (4000, 3000). */
"use strict";

function _eeRound(n){ return Math.round(n * 10000) / 10000; }
function _eeSafe(s){ return String(s == null ? "" : s).replace(/[~`#@$|]/g, "_"); }

function _eeLayers(nInner){
  const L = [
    "1~TopLayer~#FF0000~true~true~true~",
    "2~BottomLayer~#0000FF~true~false~true~",
    "3~TopSilkLayer~#FFCC00~true~false~true~",
    "4~BottomSilkLayer~#66CC33~true~false~true~",
    "5~TopPasteMaskLayer~#808080~true~false~true~",
    "6~BottomPasteMaskLayer~#800000~true~false~true~",
    "7~TopSolderMaskLayer~#800080~true~false~true~0.3",
    "8~BottomSolderMaskLayer~#AA00FF~true~false~true~0.3",
    "9~Ratlines~#6464FF~true~false~true~",
    "10~BoardOutLine~#FF00FF~true~false~true~",
    "11~Multi-Layer~#C0C0C0~true~false~true~",
    "12~Document~#FFFFFF~true~false~true~",
    "13~TopAssembly~#33CC99~false~false~false~",
    "14~BottomAssembly~#5555FF~false~false~false~",
    "15~Mechanical~#F022F0~false~false~false~",
    "19~3DModel~#66CCFF~false~false~false~",
  ];
  const cols = ["#999966","#008000","#00FF00","#BC8E00","#70DBFA","#00CC66","#9966FF","#800080",
                "#008080","#15935F","#000080","#00B400","#2E4756","#99842F","#FFFFAA","#99842F"];
  for (let i = 0; i < nInner && i < 32; i++)
    L.push((21 + i) + "~Inner" + (i + 1) + "~" + (cols[i % cols.length]) + "~false~false~false~~");
  L.push("99~ComponentShapeLayer~#00CCCC~false~false~false~0.4");
  L.push("100~LeadShapeLayer~#CC9999~false~false~false~");
  L.push("101~ComponentMarkingLayer~#66FFCC~false~false~false~");
  L.push("Hole~Hole~#222222~false~false~true~");
  L.push("DRCError~DRCError~#FAD609~false~false~true~");
  return L;
}

/* copper layer id for a State side string ("top"/"bottom"/"front"/"back"/"innerN") */
function _eeCopperLayer(side){
  if (side === "back" || side === "bottom") return 2;
  const m = /^inner(\d+)$/i.exec(side || "");
  if (m) return 20 + parseInt(m[1], 10);
  return 1;
}
function _eeSilkLayer(side){ return (side === "back" || side === "bottom") ? 4 : 3; }

function exportEasyEDAPCB(){
  const pxpm = State.pxPerMm || 10;
  // world px → EasyEDA units (1 unit = 0.254 mm)
  const U = v => v / (pxpm * 0.254);

  // board bbox in world px
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  };
  for (const c of State.components){
    const fp = compFootprint(c);
    const pins = (fp.pins && fp.pins.length) ? fp.pins : c.pins;
    for (const p of pins){ const w = pinWorldPos(c, p); grow(w.x, w.y); }
  }
  for (const t of State.traces) for (const p of t.points) grow(p.x, p.y);
  for (const v of State.vias) grow(v.x, v.y);
  if (!isFinite(minX)){ minX = minY = 0; maxX = maxY = 100; }
  const margin = 5 * pxpm;                          // 5 mm border
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;

  // shift board so bbox top-left sits at (4000, 3000) EasyEDA units
  const OX = 4000 - U(minX), OY = 3000 - U(minY);
  const X = x => _eeRound(U(x) + OX);
  const Y = y => _eeRound(U(y) + OY);
  const D = v => _eeRound(U(v));                    // length (no offset)
  const MM = mm => _eeRound(mm / 0.254);            // mm → units

  let ggeSeq = 1000;
  const gge = () => "gge" + (ggeSeq++);

  // unique, sanitized net names (empty string = unassigned)
  const netName = new Map();
  const seen = new Set([""]);
  for (const n of State.nets){
    let base = (n.name || ("NET" + n.id)).replace(/[~`#@$|\s]/g, "_");
    let nm = base, i = 1;
    while (seen.has(nm)) nm = base + "_" + (i++);
    seen.add(nm); netName.set(n.id, nm);
  }
  const netOf = id => (id != null && netName.get(id)) || "";

  const shapes = [];

  // board outline on layer 10
  const bx1 = X(minX), by1 = Y(minY), bx2 = X(maxX), by2 = Y(maxY);
  shapes.push("TRACK~1~10~~" +
    [bx1, by1, bx2, by1, bx2, by2, bx1, by2, bx1, by1].join(" ") + "~" + gge() + "~0");

  const ts = Math.floor(Date.now() / 1000);

  // components → LIB with PAD children
  for (const c of State.components){
    const fp = compFootprint(c);
    const cx = X(c.x), cy = Y(c.y);
    const rot = ((c.rot || 0) % 360 + 360) % 360;
    const rotStr = rot ? String(_eeRound(rot)) : "";

    const pkg = _eeSafe(c.kicad || fp.label || ("PKG_" + (c.ref || ("U" + c.id))));
    const refPrefix = ((c.ref || "U").match(/^[A-Za-z]+/) || ["U"])[0];
    const head = "package`" + pkg +
                 "`Manufacturer Part`" + _eeSafe(c.part || "") +
                 "`Value`" + _eeSafe(c.value || "") +
                 "`spicePre`" + _eeSafe(refPrefix) + "`";
    const compGge = "gge" + "c" + c.id.toString(16);
    const puid = "puid" + c.id.toString(16);

    let lib = "LIB~" + cx + "~" + cy + "~" + head + "~" + rotStr + "~~" +
              compGge + "~1~" + puid + "~" + ts + "~0~~yes~~" + _eeSafe(c.ref || "");

    // ref designator text on silk
    const silk = _eeSilkLayer(c.side);
    lib += "#@$TEXT~P~" + cx + "~" + (cy - 20) + "~0.6~" + (rot || 0) + "~0~" + silk +
           "~~4.5~" + _eeSafe(c.ref || "") + "~none~" + gge() + "~~0~";

    // pads
    const back = c.side === "back";
    const s = pxpm * (c.scale || 1);                        // px per pad-mm
    const a = (c.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    // merge fp geometry with c.pins net data (free footprints keep pin geometry on c.pins)
    const fpByNum = new Map();
    for (const fpp of (fp.pins || [])) fpByNum.set(String(fpp.num), fpp);
    const pinsIter = (fp.pins && fp.pins.length) ? fp.pins.map(fpp => {
      const cp = c.pins.find(x => String(x.num) === String(fpp.num));
      return Object.assign({}, fpp, cp ? { netId: cp.netId } : {});
    }) : c.pins;
    for (const p of pinsIter){
      const wp = pinWorldPos(c, p);
      const px2 = X(wp.x), py2 = Y(wp.y);
      const isTHT = p.tht !== false && p.shape === "circle";
      const layer = isTHT ? 11 : _eeCopperLayer(c.side);
      const net = _eeSafe(netOf(p.netId));
      const num = _eeSafe(p.num || p.name || "");
      const pw = p.w || p.size || 1.6, ph = p.h || p.size || 1.6;
      const wU = MM(pw), hU = MM(ph);

      // hole in EasyEDA PAD field is a RADIUS in units (matches sample: 2.1654 ≈ 0.55mm for a 1.1mm-drill header)
      const drillMm = isTHT ? (p.hole > 0 ? p.hole : Math.min(pw, ph) * 0.5) : 0;
      const holeR = _eeRound((drillMm / 2) / 0.254);

      // pad rotation in EasyEDA = comp rotation (works for RECT axis alignment)
      const padRot = _eeRound(rot);

      let shape, poly = "";
      if (p.shape === "rect" || p.shape === "roundrect" || p.shape === "oval"){
        shape = p.shape === "oval" ? "OVAL" : "RECT";
        // 4 corners of the pad rectangle rotated around the pin centre
        const hw = pw * s / 2, hh = ph * s / 2;
        const corners = [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([lx, ly]) => {
          if (back) lx = -lx;
          return [X(wp.x + lx * ca - ly * sa), Y(wp.y + lx * sa + ly * ca)];
        });
        poly = corners.map(pt => pt[0] + " " + pt[1]).join(" ");
      } else {
        shape = "ELLIPSE";
      }

      lib += "#@$PAD~" + shape + "~" + px2 + "~" + py2 + "~" + wU + "~" + hU +
             "~" + layer + "~" + net + "~" + num + "~" + holeR + "~" + poly +
             "~" + padRot + "~" + gge() + "~0~~Y~0~0~0.2~" + px2 + "," + py2;
    }
    shapes.push(lib);
  }

  // routing traces
  for (const t of State.traces){
    if (!t.points || t.points.length < 2) continue;
    const layer = _eeCopperLayer(t.side);
    // trace width: State stores it in display px; convert px → mm → units
    const wMm = (t.width || State.traceW || 6) / pxpm;
    const w = _eeRound(wMm / 0.254);
    const net = _eeSafe(netOf(t.netId));
    const pts = t.points.map(p => X(p.x) + " " + Y(p.y)).join(" ");
    shapes.push("TRACK~" + w + "~" + layer + "~" + net + "~" + pts + "~" + gge() + "~0");
  }

  // vias (through). v.r is display px radius.
  // EasyEDA VIA fields: outer DIAMETER, drill RADIUS (matches PAD holeR).
  // Our state has no drill; use a 0.25 mm annular ring or half-outer, whichever is smaller.
  for (const v of State.vias){
    const outerMm = (v.r || State.viaR || 5) * 2 / pxpm;
    const drillMm = Math.round(Math.max(0.2, Math.min(outerMm * 0.5, outerMm - 0.5)) * 10) / 10;
    const outer = _eeRound(outerMm / 0.254);
    const drillR = _eeRound((drillMm / 2) / 0.254);
    const net = _eeSafe(netOf(v.netId));
    shapes.push("VIA~" + X(v.x) + "~" + Y(v.y) + "~" + outer + "~" + net + "~" + drillR +
                "~" + gge() + "~0");
  }

  const nInner = Math.max(0, (State.layerCount || 2) - 2);
  const doc = {
    head: {
      docType: "3",
      editorVersion: "6.5.57",
      newgId: true,
      c_para: { Prefix: "U" },
      x: String(_eeRound(OX)),
      y: String(_eeRound(OY)),
      importFlag: 0,
      transformList: ""
    },
    canvas: "CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mm~1~45~visible~0.5~" +
            _eeRound(OX) + "~" + _eeRound(OY) + "~1~yes",
    shape: shapes,
    layers: _eeLayers(nInner),
    objects: [
      "All~true~false","Component~true~true","Prefix~true~true","Name~true~false",
      "Track~true~true","Pad~true~true","Via~true~true","Hole~true~true",
      "Copper_Area~true~true","Circle~true~true","Arc~true~true","Solid_Region~true~true",
      "Text~true~true","Image~true~true","Rect~true~true","Dimension~true~true","Protractor~true~true"
    ],
    BBox: { x: bx1, y: by1, width: _eeRound(bx2 - bx1), height: _eeRound(by2 - by1) },
    netColors: []
  };
  return JSON.stringify(doc, null, 2);
}
