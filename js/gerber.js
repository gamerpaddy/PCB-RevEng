/* ===== gerber.js — RS-274X copper Gerber export, one file per copper layer =====
   Emits a Gerber (extended, X2 attributes) per copper side: front→.GTL, back→.GBL,
   inner1→.G1, inner2→.G2, … and bundles them in a stored ZIP.

   Coordinate system: all layers are output in the app's top-view world frame (world px
   → mm via State.pxPerMm, Y flipped because world Y points down while Gerber Y points
   up). So the bottom copper is written "as seen from the top", the usual CAM convention.

   Geometry mapping:
     · round pads / vias → flashed circle apertures (D03)
     · rectangular pads  → filled regions (G36/G37) built from the pad's rotated corners,
                           so any rotation/scale/back-mirror is exact
     · traces            → round-aperture draws (D02 move, D01 line) of the trace width
   Only copper is written (no drill file). */
"use strict";

/* CRC-32 (for the ZIP central directory) */
function _crc32(bytes){
  if (!_crc32.table){
    const t = _crc32.table = new Uint32Array(256);
    for (let n=0; n<256; n++){ let c=n; for (let k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); t[n]=c>>>0; }
  }
  const t = _crc32.table;
  let crc = 0xFFFFFFFF;
  for (let i=0; i<bytes.length; i++) crc = t[(crc ^ bytes[i]) & 0xFF] ^ (crc>>>8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/* build a minimal STORED (uncompressed) zip Blob from [{name,text}] */
function makeZipBlob(files){
  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.length; };
  const u16 = (n) => new Uint8Array([n & 255, (n>>8) & 255]);
  const u32 = (n) => new Uint8Array([n & 255, (n>>8) & 255, (n>>16) & 255, (n>>>24) & 255]);
  const records = [];
  for (const f of files){
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.text);
    const crc = _crc32(data);
    const localOffset = offset;
    push(u32(0x04034b50));                      // local file header signature
    push(u16(20)); push(u16(0)); push(u16(0));  // version, flags, method(0=store)
    push(u16(0)); push(u16(0));                 // mod time, mod date
    push(u32(crc)); push(u32(data.length)); push(u32(data.length));
    push(u16(nameBytes.length)); push(u16(0));  // name len, extra len
    push(nameBytes); push(data);
    records.push({ nameBytes, crc, size: data.length, localOffset });
  }
  const centralStart = offset;
  for (const r of records){
    push(u32(0x02014b50));                      // central directory header signature
    push(u16(20)); push(u16(20)); push(u16(0)); push(u16(0));
    push(u16(0)); push(u16(0));                 // time, date
    push(u32(r.crc)); push(u32(r.size)); push(u32(r.size));
    push(u16(r.nameBytes.length)); push(u16(0)); push(u16(0));   // name, extra, comment len
    push(u16(0)); push(u16(0)); push(u32(0));   // disk, int attrs, ext attrs
    push(u32(r.localOffset));
    push(r.nameBytes);
  }
  const centralSize = offset - centralStart;
  push(u32(0x06054b50));                        // end of central directory
  push(u16(0)); push(u16(0));
  push(u16(records.length)); push(u16(records.length));
  push(u32(centralSize)); push(u32(centralStart));
  push(u16(0));                                 // comment len
  return new Blob(parts, { type: "application/zip" });
}

/* file extension per copper side */
function gerberExt(side){
  if (side === "front") return "GTL";
  if (side === "back")  return "GBL";
  const m = /^inner(\d+)$/.exec(side);
  if (m) return "G" + m[1];
  return "GBR";
}

function gerberBaseName(){ return "pcbreveng"; }

/* Gerber text for one copper side */
function exportGerberLayer(side){
  const pxPerMm = State.pxPerMm || 10;
  const CX = (wx) => Math.round(wx / pxPerMm * 1e6);      // world px → mm → 4.6 int
  const CY = (wy) => Math.round(-wy / pxPerMm * 1e6);     // Y flip (world down → gerber up)

  const flashes = [];   // { dia(mm), x, y }  round pads / vias   (x,y world px)
  const regions = [];   // [ [{x,y}...] ]     rectangular pad polygons (world px)
  const tracks  = [];   // { width(mm), pts:[{x,y}...] }

  // pads
  for (const c of State.components){
    const fp = compFootprint(c), scale = c.scale || 1;
    for (let pi=0; pi<c.pins.length; pi++){
      const fpin = fp.pins[pi]; if (!fpin) continue;
      const reachesAll = fpin.shape === "circle" && fpin.tht !== false;   // THT reaches every side
      if (!(reachesAll || c.side === side)) continue;                     // SMD pad: own side only
      if (fpin.shape === "circle"){
        const dia = fpin.w * scale;
        if (dia > 0){ const wp = pinWorldPos(c, fpin); flashes.push({ dia, x:wp.x, y:wp.y }); }
      } else {
        regions.push(padCornersWorld(c, fpin));
      }
    }
  }
  // vias (through / blind reaching this side)
  for (const v of State.vias){
    if (!viaOnSide(v, side)) continue;
    const dia = 2 * (v.r || State.viaR) / pxPerMm;
    if (dia > 0) flashes.push({ dia, x:v.x, y:v.y });
  }
  // traces on this side
  for (const t of State.traces){
    if (t.side !== side || !t.points || t.points.length < 2) continue;
    tracks.push({ width: (t.width || 3) / pxPerMm, pts: t.points });
  }

  // ---- aperture table (D10 kept as a default for region mode) ----
  const apDefs = ["%ADD10C,0.100*%"];
  const apMap = new Map();
  let dcode = 11;
  const roundAp = (diaMm) => {
    const key = diaMm.toFixed(4);
    let code = apMap.get(key);
    if (code == null){ code = dcode++; apMap.set(key, code); apDefs.push("%ADD" + code + "C," + diaMm.toFixed(4) + "*%"); }
    return code;
  };
  for (const f of flashes) f.code = roundAp(f.dia);
  for (const t of tracks)  t.code = roundAp(t.width);

  // ---- emit ----
  const sides = availableSides();
  const idx = sides.indexOf(side) + 1;
  const posTag = side === "front" ? "Top" : side === "back" ? "Bot" : "Inr";
  const L = [];
  L.push("G04 PCB RevEng - " + (SIDE_LABELS[side] || side) + " copper *");
  L.push("%TF.GenerationSoftware,PCB RevEng*%");
  L.push("%TF.FileFunction,Copper,L" + idx + "," + posTag + "*%");
  L.push("%TF.FilePolarity,Positive*%");
  L.push("%FSLAX46Y46*%");
  L.push("%MOMM*%");
  L.push("%LPD*%");
  for (const d of apDefs) L.push(d);
  L.push("G01*");
  // rectangular pads as filled regions
  if (regions.length){
    L.push("D10*");
    for (const poly of regions){
      if (!poly || poly.length < 3) continue;
      L.push("G36*");
      L.push("X" + CX(poly[0].x) + "Y" + CY(poly[0].y) + "D02*");
      for (let i=1; i<poly.length; i++) L.push("X" + CX(poly[i].x) + "Y" + CY(poly[i].y) + "D01*");
      L.push("X" + CX(poly[0].x) + "Y" + CY(poly[0].y) + "D01*");   // close contour
      L.push("G37*");
    }
  }
  // round pads / vias
  let cur = null;
  for (const f of flashes){
    if (f.code !== cur){ L.push("D" + f.code + "*"); cur = f.code; }
    L.push("X" + CX(f.x) + "Y" + CY(f.y) + "D03*");
  }
  // traces
  cur = null;
  for (const t of tracks){
    if (t.code !== cur){ L.push("D" + t.code + "*"); cur = t.code; }
    t.pts.forEach((p,i) => L.push("X" + CX(p.x) + "Y" + CY(p.y) + (i === 0 ? "D02" : "D01") + "*"));
  }
  L.push("M02*");
  return L.join("\n") + "\n";
}

/* every copper layer as [{name,text}] */
function exportGerbers(){
  const base = gerberBaseName();
  return availableSides().map(side => ({ name: base + "." + gerberExt(side), text: exportGerberLayer(side) }));
}

/* human-readable summary + first-layer sample, shown in the export dialog preview */
function gerberPreviewText(){
  const files = exportGerbers();
  let s = "Gerber (RS-274X) — " + files.length + " copper layer file" + (files.length>1?"s":"") + ", downloads as "
        + gerberBaseName() + "-gerbers.zip:\n";
  for (const f of files) s += "  • " + f.name + "   (" + f.text.length + " bytes)\n";
  s += "\nCoordinates in mm (calibrate the board for real-world scale). No drill file is included.\n";
  s += "\n----- preview: " + files[0].name + " -----\n" + files[0].text;
  return s;
}

/* bundle + download the zip */
function downloadGerbers(){
  const files = exportGerbers();
  const blob = makeZipBlob(files);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = gerberBaseName() + "-gerbers.zip";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  UI.toast("Exported " + files.length + " Gerber layer" + (files.length>1?"s":"") + " → " + a.download);
}
