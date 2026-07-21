/* ===== quickadd.js — experimental "quick component" popup =====
   With the component tool active (C) and no footprint armed, clicking the board opens
   a small popup: a preview of the clicked area + a text field. Type things like
   "sot-23 npn", "sot23 npn 2n2222" (npn = value, 2n2222 = part), "ic sot23 ref30"
   (U prefix + generic box symbol), "soic14 74hc130", "0805 10k", "cap 0603 10n",
   "to-220-5" / "to220 5pin", "to92 triangle", "free 4.5x5" (freestyle body) and it
   resolves footprint / value / part / refdes prefix, live-previewing the ghost.
   Arrow keys nudge (the preview stays centred on the part — the board scrolls under
   it and is re-cropped every move), rotate/place keys are in the hotkey editor. */
"use strict";

const QuickAdd = {
  active: false, pos: null, side: "front", rot: 0,
  fp: null, parsed: null,
  pvZoom: 1,      // preview zoom factor (mouse wheel over the preview)
};

/* standard feature now (on by default); still disable-able via localStorage */
QuickAdd.enabled = () => { try { return localStorage.getItem("pcbreveng.quickAdd") !== "off"; } catch(e){ return true; } };

/* ---------------- query parser ---------------- */

const QA_CHIP_SIZES = ["0201","0402","0406","0603","0612","0805","1206","1210","2010","2512"];

// component-type keywords → refdes prefix (+ optional schematic symbol override).
// `val:true` = the keyword itself becomes the value (semiconductors: "npn", "diode"…),
// and value-ish tokens ("2n3337") are treated as PART NUMBERS, not values.
// `fpHint` = footprint id to fall back on when no package token was given (film caps
// are always axial THT, connectors default to a pin strip, …).
const QA_TYPES = [
  [/^(res|resistor|rs|widerstand)$/, {prefix:"R"}],
  [/^(cap|capacitor|kondensator|ker|ceramic|mlcc)$/, {prefix:"C"}],
  [/^(film|foil|folie|mks|mkp|mkt|fkp|fks|wima)$/, {prefix:"C", fpHint:"axial", tht:true}],  // film/foil caps → axial THT
  [/^(ind|inductor|coil|spule|drossel|choke|ferrite|fb|bead)$/, {prefix:"L"}],
  [/^npn$/, {prefix:"Q", sym:"npn", val:true}],
  [/^pnp$/, {prefix:"Q", sym:"pnp", val:true}],
  [/^(nmos|nfet|n-mos|n-fet|nch)$/, {prefix:"Q", sym:"nmos", val:true}],
  [/^(pmos|pfet|p-mos|p-fet|pch)$/, {prefix:"Q", sym:"pmos", val:true}],
  [/^(mosfet|fet|transistor|trans|tr)$/, {prefix:"Q", val:true}],
  [/^(diode|di)$/, {prefix:"D", sym:"diode", val:true}],
  [/^led$/, {prefix:"D", sym:"led", val:true}],
  [/^zener$/, {prefix:"D", sym:"zener", val:true}],
  [/^(schottky|sk)$/, {prefix:"D", sym:"schottky", val:true}],
  [/^(xtal|crystal|quarz|resonator|osc|oscillator)$/, {prefix:"Y"}],
  [/^(fuse|sicherung|polyfuse|ptc-?fuse)$/, {prefix:"F", sym:"fuse", val:true}],
  [/^(bat|batt|battery|cell|coincell)$/, {prefix:"BT", sym:"battery", val:true}],
  [/^(sw|switch|button|btn|tact|taster)$/, {prefix:"SW", fpHint:"sip"}],
  [/^(con|conn|connector|jack|plug|socket)$/, {prefix:"J", fpHint:"sip"}],
  [/^(relay|relais)$/, {prefix:"K", fpHint:"dip"}],
  [/^(ntc|ptc|thermistor)$/, {prefix:"TH"}],   // value stays free (ntc 10k → value 10k)
  [/^(varistor|mov)$/, {prefix:"RV"}],
  [/^(ic|u|box|generic)$/, {prefix:"U", sym:"box"}],   // generic IC → U prefix + plain box symbol
];

// mounting technology keywords, consumed anywhere in the query: "tht" biases every
// type fallback to its through-hole variant and converts an SMD e-cap / crystal
const QA_THT_RE = /^(tht|through|throughhole|through-hole|bedrahtet)$/;
const QA_SMD_RE = /^smd$/;

// a value-ish token: 10k, 4k7, 100n, 1u, 0R, 223, 10uF, 4.7k, 1M2 — plus the SMD
// resistor code formats the resolver understands: EIA-96 (01C), R/K/M-leading
// decimal notation (R005, R47, K15) and milliohm notation (5m0, 5mR)
function qaLooksLikeValue(t){
  if (/^[0-9]+(\.[0-9]+)?[rkmnpuµ]?[0-9]*f?$/i.test(t) && /[0-9]/.test(t)) return true;
  if (/^\d{2}[zyrxsabhcdef]$/i.test(t)) return true;      // EIA-96: 01C = 10k
  if (/^[rkm]\d+$/i.test(t)) return true;                 // R005 / R47 / K15 / M1
  if (/^\d*m\d*r?$/.test(t) && /\d/.test(t)) return true; // 5m0 / 5mR (milliohms)
  return false;
}

/* nearest option of a select param (options are numeric strings like "2.5") */
function qaNearestOption(options, want){
  let best = options[0], bd = Infinity;
  for (const o of options){ const d = Math.abs(parseFloat(o) - want); if (d < bd){ bd = d; best = o; } }
  return best;
}

/* map one token → {fpId, params, prefix?} footprint, or null.
   A trailing dash ("to220-", "soic-") is tolerated — it's the user mid-typing a
   suffix like "to220-5", and must not derail the match. `prefix` (optional) is a
   refdes hint the token itself carries (r0805 → R, c0603 → C). */
function qaMatchFootprint(t){
  let s = t.toLowerCase().replace(/-+$/, "");
  const num = (re) => { const m = re.exec(s); return m ? parseInt(m[1],10) : null; };

  // user-imported footprint: custom:<part of the stored name>
  if (s.startsWith("custom:")){
    const hit = typeof CustomFPs !== "undefined" ? CustomFPs.find(s.slice(7)) : null;
    if (hit) return { fpId:"customfp", params:{name:hit.name} };
    return null;
  }

  if (QA_CHIP_SIZES.includes(s)) return { fpId:"chip2", params:{size:s} };
  // prefixed chip size: r0805 / c0603 / l0402 — the letter doubles as the type
  let cm;
  if ((cm = /^([rcl])(\d{4})$/.exec(s)) && QA_CHIP_SIZES.includes(cm[2]))
    return { fpId:"chip2", params:{size:cm[2]}, prefix:cm[1].toUpperCase() };

  // SOT-23 family (optional pin-count suffix: sot23-5 / sot-23-5 / sot235 / sot-323-6).
  // Keep the SOT-23 pin suffix to 5/6 — SOT-23 defaults to 3, and matching a bare "3"
  // used to eat the trailing digit of SOT-323 ("sot-323" → SOT-23 pins=3), leaving the
  // SOT-323 rules below unreachable.
  let m;
  if ((m = /^sot-?23(?:-?([56]))?$/.exec(s))) return { fpId:"sot23", params:{pkg:"SOT-23", pins:m[1]||"3"} };
  if ((m = /^sot-?323(?:-?([356]))?$/.exec(s))) return { fpId:"sot23", params:{pkg:"SOT-323", pins:m[1]||"3"} };
  if ((m = /^sot-?523(?:-?([356]))?$/.exec(s))) return { fpId:"sot23", params:{pkg:"SOT-523", pins:m[1]||"3"} };
  if ((m = /^sot-?723(?:-?([356]))?$/.exec(s))) return { fpId:"sot23", params:{pkg:"SOT-723", pins:m[1]||"3"} };
  if (/^sot-?223$/.test(s)) return { fpId:"sot223", params:{pkg:"SOT-223"} };
  if (/^sot-?89$/.test(s))  return { fpId:"sot223", params:{pkg:"SOT-89"} };
  if (/^(dpak|to-?252)$/.test(s)) return { fpId:"sot223", params:{pkg:"DPAK (TO-252)"} };

  if ((m = /^sod-?(523|323|123|80)$/.exec(s))) return { fpId:"sod", params:{pkg:"SOD-"+m[1]} };
  if (/^sm[abc]$/.test(s)) return { fpId:"sod", params:{pkg:s.toUpperCase()} };

  if (/^to-?92$/.test(s)) return { fpId:"to92", params:{} };
  if (/^to-?3$/.test(s)) return { fpId:"to3", params:{} };   // the metal can, NOT TO-3P
  // small metal cans with optional pin count: to5 / to-18-4 / to39-8 / to99 (=TO-5-8) / to100 (=TO-5-10)
  if ((m = /^to-?(18|39|46|52|72|5|8)(?:-?(2|3|4|6|8|10))?$/.exec(s)))
    return { fpId:"tocan", params:{pkg:"TO-"+m[1], pins:m[2] || (m[1]==="72" ? "4" : "3")} };
  if (/^to-?99$/.test(s))  return { fpId:"tocan", params:{pkg:"TO-5", pins:"8"} };
  if (/^to-?100$/.test(s)) return { fpId:"tocan", params:{pkg:"TO-5", pins:"10"} };
  // TO-220 family with optional pin count: to220-5 / to-247 / to3p / to264 / to126
  if ((m = /^to-?(220|247|264|126|3p)(?:-?([235]))?$/.exec(s))){
    const pkg = { "220":"TO-220", "247":"TO-247", "264":"TO-264", "126":"TO-126", "3p":"TO-3P" }[m[1]];
    const p = { pkg };
    if (m[2]) p.pins = m[2];
    return { fpId:"to220", params:p };
  }

  if ((m = /^(?:soic|so|sop)-?(\d+)$/.exec(s))) return { fpId:"soic", params:{pins:+m[1]} };
  if ((m = /^tssop-?(\d+)$/.exec(s))) return { fpId:"soic", params:{pins:+m[1], pitch:"0.65", width:"4.4"} };
  if ((m = /^msop-?(\d+)$/.exec(s))) return { fpId:"soic", params:{pins:+m[1], pitch:"0.5", width:"3.0"} };
  if ((m = /^(?:dip|pdip)-?(\d+)$/.exec(s))) return { fpId:"dip", params:{pins:+m[1]} };
  if ((m = /^(?:lqfp|tqfp|qfp)-?(\d+)$/.exec(s))) return { fpId:"qfp", params:{pins:+m[1], style:"QFP"} };
  if ((m = /^qfn-?(\d+)$/.exec(s))) return { fpId:"qfp", params:{pins:+m[1], style:"QFN"} };
  if ((m = /^bga-?(\d+)x(\d+)$/.exec(s))) return { fpId:"grid", params:{rows:+m[2], cols:+m[1]} };
  if ((m = /^bga-?(\d+)$/.exec(s))){ const n = Math.round(Math.sqrt(+m[1])); return { fpId:"grid", params:{rows:n, cols:n} }; }
  if (/^bga$/.test(s)) return { fpId:"grid", params:{} };

  if ((m = /^melf-?(0102|0204|0207)?$/.exec(s))) return { fpId:"melf", params: m[1]?{size:m[1]}:{} };
  if (/^(axial|ax)$/.test(s)) return { fpId:"axial", params:{}, prefix:"R" };
  if (/^(radial|rad)$/.test(s)) return { fpId:"radial", params:{}, prefix:"C" };
  // electrolytic cap, optional diameter suffix: ecap8 / elko6.3 (dNN also works as a modifier)
  if ((m = /^(?:ecap|e-cap|electrolytic|elec|elko)(\d+(?:\.\d+)?)?$/.exec(s))){
    const p = {};
    if (m[1]){
      const def = getFootprintDef("ecap_smd");
      p.dia = qaNearestOption(def.params.find(pr => pr.key === "dia").options, parseFloat(m[1]));
    }
    return { fpId:"ecap_smd", params:p, prefix:"C" };
  }
  if ((m = /^(?:sip|hdr|header|pinheader|pin-header|pinhdr)-?(\d+)?$/.exec(s))) return { fpId:"sip", params: m[1]?{pins:+m[1]}:{} };
  // dual-row header / IDC: idc10 (total pins) or 2x5 (cols); 1x5 = single-row header
  if ((m = /^idc-?(\d+)?$/.exec(s))) return { fpId:"header2", params: m[1]?{pins:+m[1]}:{} };
  if ((m = /^1x-?(\d+)$/.exec(s))) return { fpId:"sip", params:{pins:+m[1]} };
  if ((m = /^2x-?(\d+)$/.exec(s))) return { fpId:"header2", params:{pins:2*+m[1]} };
  // SMD FPC/FFC flex socket: fpc32 p1 / ffc50 p0.5
  if ((m = /^(?:fpc|ffc)-?(\d+)?$/.exec(s))) return { fpId:"fpc", params: m[1]?{pins:+m[1]}:{}, prefix:"J" };
  // screw terminal block: screw / terminal / tb, optional way count (screw2, terminal-3)
  if ((m = /^(?:screw|terminal|term|tb|klemme)-?(\d+)?$/.exec(s)))
    return { fpId:"screw", params: m[1]?{pins:+m[1]}:{}, prefix:"J" };
  // JST family (+ bare series names) → JST/Molex 1×N; pitch follows the series
  if ((m = /^(?:jst-?)?(xh|ph|zh|sh|eh|gh|vh)?(?:-?(\d+))?$/.exec(s)) && /^jst|^(xh|ph|zh|sh|eh|gh|vh)/.test(s)){
    const series = m[1];
    const pitchOf = { xh:2.5, eh:2.5, vh:2.5, ph:2.0, zh:1.5, sh:1.25, gh:1.25 };
    const p = {};
    if (series){
      const def = getFootprintDef("jstxh");
      p.pitch = qaNearestOption(def.params.find(pr => pr.key === "pitch").options, pitchOf[series] || 2.5);
    }
    if (m[2]) p.pins = +m[2];
    return { fpId:"jstxh", params:p, prefix:"J" };
  }
  if (/^molex$/.test(s)) return { fpId:"jstxh", params:{}, prefix:"J" };
  if (/^(xtal|crystal|resonator|osc)$/.test(s)) return { fpId:"crystal", params:{} };
  if (/^hc-?49$/.test(s)) return { fpId:"crystal", params:{pkg:"HC-49"}, prefix:"Y" };
  if (/^(tp|testpoint|test-point)$/.test(s)) return { fpId:"pad1", params:{} };
  if ((m = /^(?:mount|mounting|hole)$/.exec(s))) return { fpId:"mount", params:{} };
  if ((m = /^m(2(?:\.5)?|3|4|5)$/.exec(s))) return { fpId:"mount", params:{size:"M"+m[1]} };
  // freestyle component, optional body size: free / free4x5 / free-4.5x5
  if ((m = /^free(?:-?(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?))?$/.exec(s)))
    return { fpId:"free", params: m[1]?{w:parseFloat(m[1]), h:parseFloat(m[2])}:{} };
  // less-strict retry: drop underscores/dots ("sot_23", "to.220") and have another go
  const s2 = s.replace(/[_.]/g, "");
  if (s2 !== s) return qaMatchFootprint(s2);
  return null;
}

/* package-modifier tokens applied AFTER the footprint is known (pin counts, lead form,
   freestyle body size, diameters, pitch shorthand). Returns true when consumed. */
function qaApplyModifier(fp, t){
  const s = t.toLowerCase();
  const def = getFootprintDef(fp.fpId);
  const param = (key) => def && def.params.find(p => p.key === key);
  let m;
  // pin count as its own token: "5pin" / "5p" / "14pins" / "3way" — any footprint with a pins param
  if ((m = /^(\d+)(?:p|pin|pins|way|ways)$/.exec(s))){
    const pr = param("pins");
    if (pr){ fp.params.pins = pr.type === "select" ? String(+m[1]) : +m[1]; return true; }
    return false;
  }
  // pitch shorthand: "p3" / "p2.54" — any footprint with a pitch (or axial span) param
  if ((m = /^p(\d+(?:\.\d+)?)$/.exec(s))){
    const want = parseFloat(m[1]);
    const pr = param("pitch") || param("span");
    if (pr){ fp.params[pr.key] = pr.type === "select" ? qaNearestOption(pr.options, want) : want; return true; }
    return false;
  }
  // diameter: "d8" / "d6.3" — e-cap size; on a radial THT cap it picks the pitch that
  // yields roughly that body diameter (body ≈ pitch × 1.8)
  if ((m = /^d(\d+(?:\.\d+)?)$/.exec(s))){
    const want = parseFloat(m[1]);
    if (fp.fpId === "ecap_smd"){ fp.params.dia = qaNearestOption(param("dia").options, want); return true; }
    if (fp.fpId === "radial"){ fp.params.pitch = qaNearestOption(param("pitch").options, want/1.8); return true; }
    if (fp.fpId === "pad1"){ fp.params.dia = want; return true; }
    return false;
  }
  // radial cap body shape: round vs square (film/foil box caps)
  if (fp.fpId === "radial"){
    if (/^round$/.test(s)){ fp.params.shape = "Round"; return true; }
    if (/^(square|box|foil|film)$/.test(s)){ fp.params.shape = "Square (foil)"; return true; }
    if (/^(bipolar|np|non-?polar(ized)?)$/.test(s)){ fp.params.polarized = false; return true; }
  }
  // crystal package names
  if (fp.fpId === "crystal"){
    if (/^hc-?49$/.test(s)){ fp.params.pkg = "HC-49"; return true; }
    if (/^3225$/.test(s)){ fp.params.pkg = "3225 SMD"; return true; }
    if (/^5032$/.test(s)){ fp.params.pkg = "5032 SMD"; return true; }
  }
  // mounting-hole screw size
  if (fp.fpId === "mount" && (m = /^m(2(?:\.5)?|3|4|5)$/.exec(s))){
    fp.params.size = "M" + m[1]; return true;
  }
  // JST series name as its own token ("jst xh 4pin") → the series' pitch
  if (fp.fpId === "jstxh" && (m = /^(xh|ph|zh|sh|eh|gh|vh)$/.exec(s))){
    const pitchOf = { xh:2.5, eh:2.5, vh:2.5, ph:2.0, zh:1.5, sh:1.25, gh:1.25 };
    fp.params.pitch = qaNearestOption(param("pitch").options, pitchOf[m[1]]);
    return true;
  }
  // TO-92 lead form: "tri" / "triangle" / "wide" vs "inline" / "straight"
  if (fp.fpId === "to92"){
    if (/^(tri|triangle|wide)$/.test(s)){ fp.params.layout = "Triangle"; return true; }
    if (/^(inline|line|straight)$/.test(s)){ fp.params.layout = "Inline"; return true; }
  }
  // freestyle body size as its own token: "4x5" / "4.5x5"
  if (fp.fpId === "free" && (m = /^(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?)$/.exec(s))){
    fp.params.w = parseFloat(m[1]); fp.params.h = parseFloat(m[2]);
    return true;
  }
  return false;
}

/* parse the whole query → placement values, or null if nothing recognised.
   Two passes: 1) find the footprint, its modifiers, tht/smd and the type keyword
   anywhere in the query, 2) classify the remaining tokens (pitch / value / part). */
function parseQuickQuery(str){
  const toks = (str||"").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  let fp = null, type = null, tht = false;
  const rest = [];
  for (const t of toks){
    const low = t.toLowerCase();
    if (!fp){ const f = qaMatchFootprint(t); if (f){ fp = f; continue; } }
    // modifiers must run before type keywords: "radial foil" should set the radial
    // cap's square body, not switch the type to a film cap
    if (fp && qaApplyModifier(fp, t)) continue;
    if (QA_THT_RE.test(low)){ tht = true; continue; }
    if (QA_SMD_RE.test(low)){ tht = false; continue; }
    if (!type){
      let hit = null;
      for (const [re, info] of QA_TYPES) if (re.test(low)){ hit = {...info, tok:low}; break; }
      if (hit){ type = hit; if (hit.tht) tht = true; continue; }
    }
    rest.push(t);
  }

  // semiconductors (Q/D) don't have R/C-style values: value-ish tokens ("2n3337") are
  // part numbers there, and the type keyword itself becomes the value ("npn", "diode")
  const semi = !!(type && type.val);
  let value = "", pitchMm = null, partParts = [];
  for (const t of rest){
    if (fp && qaApplyModifier(fp, t)) continue;   // modifiers of a late footprint token
    // a pitch token: 1mm / 0.8mm / 50mil (applied to footprints with a pitch/span param)
    let pm;
    if (pitchMm === null && (pm = /^(\d+(?:\.\d+)?)(mm|mil)$/i.exec(t))){
      pitchMm = pm[2].toLowerCase() === "mil" ? parseFloat(pm[1]) * 0.0254 : parseFloat(pm[1]);
      continue;
    }
    if (!value && !semi && qaLooksLikeValue(t)){ value = t; continue; }
    partParts.push(t);   // leftover = part number / free text
  }
  if (type && type.val) value = type.tok;   // "npn" / "diode" / "led" … as the value
  if (!fp && !type && !value && pitchMm === null && !partParts.length) return null;

  // "tht" converts an explicitly-SMD package where a THT twin exists
  if (fp && tht){
    if (fp.fpId === "ecap_smd"){                     // SMD e-cap → radial THT, keeping ~the body Ø
      const p = {};
      if (fp.params.dia){
        const pr = getFootprintDef("radial").params.find(x => x.key === "pitch");
        p.pitch = qaNearestOption(pr.options, parseFloat(fp.params.dia) / 1.8);
      }
      fp = { fpId:"radial", params:p, prefix:"C" };
    }
    else if (fp.fpId === "crystal" && !fp.params.pkg) fp.params.pkg = "2-pin THT";
    else if (fp.fpId === "pad1") fp.params.tht = true;
  }

  // fall back to a sensible footprint if only a value/type was given — honouring "tht"
  // (res tht → axial, cap tht → radial, q tht → TO-92, diode tht → axial). Pure free
  // text (no footprint, no type, no value) resolves to NOTHING — guessing a random
  // SOIC here used to place surprise parts for half-typed package names.
  if (!fp){
    if (type && type.fpHint) fp = { fpId:type.fpHint, params: type.fpHint==="sip" ? {pins:2} : {} };
    else if (type && (type.prefix === "R" || type.prefix === "L" || type.prefix === "TH" || type.prefix === "RV" || type.prefix === "F"))
      fp = tht ? { fpId:"axial", params:{} } : { fpId:"chip2", params:{size:"0805"} };
    else if (type && type.prefix === "C") fp = tht ? { fpId:"radial", params:{} } : { fpId:"chip2", params:{size:"0805"} };
    else if (type && type.prefix === "Q") fp = tht ? { fpId:"to92", params:{} } : { fpId:"sot23", params:{} };
    else if (type && type.prefix === "D") fp = tht ? { fpId:"axial", params:{} } : { fpId:"sod", params:{} };
    else if (type && type.prefix === "Y") fp = { fpId:"crystal", params: tht ? {pkg:"2-pin THT"} : {} };
    else if (type && type.prefix === "BT") fp = { fpId:"radial", params:{polarized:true} };
    else if (type) fp = tht ? { fpId:"dip", params:{} } : { fpId:"soic", params:{} };
    else if (value) fp = tht ? { fpId:"axial", params:{} } : { fpId:"chip2", params:{size:"0805"} };
    else return null;
  }

  const def = getFootprintDef(fp.fpId);
  // apply a parsed pitch to any footprint exposing a "pitch" (or axial "span") param
  const pitchPr = def && (def.params.find(pr => pr.key === "pitch") || def.params.find(pr => pr.key === "span"));
  if (pitchMm !== null && pitchPr){
    fp.params[pitchPr.key] = (pitchPr.type === "select" && pitchPr.options)
      ? qaNearestOption(pitchPr.options, pitchMm)   // snap to the nearest offered option
      : pitchMm;
  }
  let prefix = type ? type.prefix : fp.prefix || (def && def.prefix) || "U";
  // chip2 with a plain value but no explicit type: resistor by default (matches board convention)
  const sym = type ? (type.sym || null) : null;

  // resolve bare resistor codes (223 → 22k, 01C → 10k, R005 → 5m) only for resistors
  let val = value;
  if (val && prefix === "R" && typeof autoResolveValue === "function") val = autoResolveValue(val);

  return {
    fpId: fp.fpId, params: fp.params, prefix,
    value: val, part: partParts.join(" "), symOverride: sym,
  };
}

/* ---------------- popup ---------------- */

/* clickable example queries (right panel) */
const QA_EXAMPLES = [
  "0805 10k", "cap 0603 100n", "res tht 4k7", "mks 100n",
  "sot23 npn 2n2222", "to92 bc547", "to220-3 irfz44n", "to3 2n3055",
  "sod123 schottky", "led 0603", "ecap d8 470u",
  "soic14 74hc00", "dip8 ne555", "qfp32 atmega328",
  "1x5", "2x10", "idc16 p2", "sip4 1mm",
  "fpc32 p1", "ffc50 p0.5", "jst xh 4pin", "screw 3way",
  "xtal hc49 16mhz", "tp d2", "m3", "free 4x5",
];

/* last-used queries, newest first (retained per browser, capped at 20) */
function qaHistory(){
  try { return JSON.parse(localStorage.getItem("pcbreveng.qaHistory") || "[]"); } catch(e){ return []; }
}
function qaPushHistory(q){
  q = (q || "").trim();
  if (!q) return;
  const h = [q, ...qaHistory().filter(x => x !== q)].slice(0, 20);
  try { localStorage.setItem("pcbreveng.qaHistory", JSON.stringify(h)); } catch(e){}
}

/* fill the history (left) / examples (right) side panels with clickable entries */
QuickAdd.renderSides = () => {
  const fill = (sel, items, emptyText) => {
    const box = $(sel);
    if (!box) return;
    box.innerHTML = "";
    if (!items.length && emptyText){
      const d = document.createElement("div");
      d.className = "panel-hint"; d.textContent = emptyText;
      box.appendChild(d);
      return;
    }
    for (const q of items){
      const b = document.createElement("button");
      b.type = "button"; b.textContent = q; b.title = q;
      b.addEventListener("click", () => {
        const inp = $("#qa-input");
        inp.value = q;
        QuickAdd.update();
        inp.focus();
      });
      box.appendChild(b);
    }
  };
  fill("#qa-hist-list", qaHistory(), "Placed parts appear here for quick reuse.");
  fill("#qa-ex-list", qaShuffled(QA_EXAMPLES), "");
};

/* a shuffled copy (Fisher–Yates) — the examples come up in a fresh order every open */
function qaShuffled(arr){
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

QuickAdd.open = (w) => {
  QuickAdd.active = true;
  QuickAdd.pos = { x:w.x, y:w.y };
  // follow the active draw side (the "Draw on: …" selector). Quick-add only opens with NO
  // footprint armed, so Tools.ghostSide is a stale leftover from the last placement and
  // must not override an explicit Draw-on-Back — place where the user is drawing.
  QuickAdd.side = (UI.copperSide() === "back") ? "back" : "front";
  // brand-new placement snaps to a straight 0/90/180/270 — any leftover free angle from
  // the rotate gizmo or a paste shouldn't stick to the next fresh part
  QuickAdd.rot = ((Math.round((Tools.ghostRot || 0) / 90) * 90) % 360 + 360) % 360;
  QuickAdd.fp = null; QuickAdd.parsed = null;
  QuickAdd.pvZoom = 1;
  const inp = $("#qa-input");
  inp.value = "";
  $("#qa-info").textContent = QA_PROMPT;
  $("#qa-info").className = "qa-info";
  QuickAdd.renderSides();
  QuickAdd.updateKeysHint();
  QuickAdd.updateInfo();
  $("#qa-dialog").showModal();
  QuickAdd.render();
  requestRender();
  inp.focus(); inp.select();
  requestAnimationFrame(() => { inp.focus(); QuickAdd.render(); });  // ensure focus + correct preview size after layout
};

QuickAdd.close = () => {
  QuickAdd.active = false; QuickAdd.fp = null; QuickAdd.parsed = null;
  const d = $("#qa-dialog"); if (d.open) d.close();
  requestRender();
};

QuickAdd.update = () => {
  const parsed = parseQuickQuery($("#qa-input").value);
  QuickAdd.parsed = parsed;
  const info = $("#qa-info");
  if (!parsed){
    QuickAdd.fp = null;
    info.textContent = $("#qa-input").value.trim() ? "not recognised — keep typing…" : QA_PROMPT;
    info.className = "qa-info";
    QuickAdd.updateInfo();
    QuickAdd.render(); requestRender(); return;
  }
  const fp = generateFootprint(parsed.fpId, parsed.params);
  QuickAdd.fp = fp;
  info.textContent = "✓ " + fp.label;
  info.className = "qa-info ok";
  QuickAdd.updateInfo();
  QuickAdd.render(); requestRender();
};

const QA_PROMPT = "Describe the part (package · value · part number) — the Examples list shows the syntax, click one to try it";

/* the keys line under the input reflects the ACTUAL bound hotkeys (rotate CW/CCW/place),
   so a rebind in the hotkey editor shows up here instead of a stale "Shift rotate CW" */
QuickAdd.updateKeysHint = () => {
  const el = $("#qa-keys");
  if (!el) return;
  const kf = (id) => (typeof Keymap !== "undefined" && Keymap.keyFor(id)) || "—";
  const cw = kf("quickadd.rotcw"), ccw = kf("quickadd.rotccw"), place = kf("quickadd.place");
  el.innerHTML = "Arrows or drag the preview nudge · " + escAttr(cw) + " rotate CW · " + escAttr(ccw) +
    " rotate CCW · right-click preview rotates · " + escAttr(place) + " place · Esc cancel · wheel over preview zooms  " +
    '<span style="opacity:.7">(keys editable in the hotkey editor)</span>';
};

/* the "next free" reference for a prefix WITHOUT reserving it (nextRef mutates counters) */
function qaPreviewRef(prefix){
  let n = (State.refCounters[prefix] || 0) + 1;
  while (refExists(prefix + n)) n++;
  return prefix + n;
}

/* structured facts grid under the input: footprint, pins, pitch, body size, value,
   part, symbol, KiCad name, placement side/rotation — refreshed on every keystroke,
   nudge and rotate (not a single bracket line any more) */
QuickAdd.updateInfo = () => {
  const facts = $("#qa-facts");
  if (!facts) return;
  const p = QuickAdd.parsed, fp = QuickAdd.fp;
  if (!p || !fp){ facts.style.display = "none"; facts.innerHTML = ""; return; }
  const rows = [];
  const add = (k, v) => { if (v !== "" && v != null) rows.push(
    `<div class="qa-k">${escAttr(k)}</div><div class="qa-v">${v}</div>`); };
  const esc = (s) => escAttr(String(s));
  const mmFmt = (n) => (+n).toFixed(2).replace(/\.?0+$/, "") + " mm";

  add("Reference", esc(qaPreviewRef(p.prefix || "U")) + ` <span class="qa-dim">(auto, prefix ${esc(p.prefix||"U")})</span>`);
  add("Footprint", esc(fp.label));
  add("Pins", String(fp.pins.length));
  if (fp.params && fp.params.rows && fp.params.cols) add("Grid", esc(fp.params.rows + " × " + fp.params.cols));
  if (fp.params && fp.params.pitch) add("Pitch", esc(mmFmt(fp.params.pitch)));
  if (fp.body) add("Body", esc(mmFmt(fp.body.w) + " × " + mmFmt(fp.body.h)));
  add("Value", p.value ? esc(p.value) : `<span class="qa-dim">—</span>`);
  add("Part name", p.part ? esc(p.part) : `<span class="qa-dim">—</span>`);
  if (p.symOverride) add("Symbol", esc((typeof SYM_LABELS !== "undefined" && SYM_LABELS[p.symOverride]) || p.symOverride));
  if (fp.kicad) add("KiCad", esc(fp.kicad));
  add("Place on", esc((SIDE_LABELS[QuickAdd.side] || QuickAdd.side) + " · " + QuickAdd.rot + "°"));
  facts.innerHTML = rows.join("");
  facts.style.display = "";
};

/* draw the board area under the part into the preview: the footprint ghost stays pinned to the
   centre of the preview and the board itself re-centres on the part every nudge, so the board
   scrolls beneath a fixed part and the preview always shows real board content (never black).
   We re-render the board straight from the model (drawWorld) at a preview-specific pan/zoom
   rather than sampling the on-screen canvas, so we're not limited to what's currently in view. */
QuickAdd.render = () => {
  const cv = $("#qa-preview"); if (!cv) return;
  const ctx = cv.getContext("2d");
  const dpr = View.dpr || 1;
  // size the drawing buffer to the (CSS-sized) box so the preview isn't stretched/squished
  const cssW = Math.round(cv.clientWidth) || 240, cssH = Math.round(cv.clientHeight) || 180;
  if (cv.width  !== cssW*dpr) cv.width  = cssW*dpr;
  if (cv.height !== cssH*dpr) cv.height = cssH*dpr;
  const PW = cv.width, PH = cv.height;
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,PW,PH);
  ctx.fillStyle = "#0d0f12"; ctx.fillRect(0,0,PW,PH);

  // choose the preview scale so the WHOLE footprint (+ margin) always fits, regardless of
  // the board zoom — small parts (SOT-23) and big ICs (SOIC-14) both frame nicely
  const fp = QuickAdd.fp;
  const fx = View.flip ? -1 : 1;
  let extMm = 3;   // fallback framing radius when nothing is resolved yet (~6 mm across)
  if (fp){
    extMm = Math.max(fp.body.w, fp.body.h) / 2;
    for (const p of fp.pins) extMm = Math.max(extMm, Math.hypot(p.xmm, p.ymm) + Math.max(p.w, p.h)/2);
  }
  // preview device-px per mm — the footprint spans ~40% of the shorter side, board context
  // around; the wheel-zoom factor magnifies on top (big parts: zoom in to align pins)
  const pxPerMm = Math.min(PW, PH) / (extMm * 2 * 2.6) * (QuickAdd.pvZoom || 1);
  QuickAdd._pxPerMm = pxPerMm;   // device px per mm — used to map a preview drag back to world px

  // re-render the board into the preview at our own pan/zoom (centred on the part). drawWorld
  // reads View.zoom / View.panX / View.panY, so temporarily override them and restore after.
  const prevZoom = View.zoom, prevPanX = View.panX, prevPanY = View.panY, prevPaneDX = View._paneDX;
  // world→device factor is dpr*zoom; we want pxPerMm device px per mm and State.pxPerMm px per mm
  const pvZoom = pxPerMm / (State.pxPerMm * dpr);
  // place the part's world point at the preview centre (base transform below scales by dpr)
  View.zoom = pvZoom; View._paneDX = 0;
  View.panX = (PW/2)/dpr - QuickAdd.pos.x * pvZoom * fx;
  View.panY = (PH/2)/dpr - QuickAdd.pos.y * pvZoom;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  try { drawWorld(ctx); } catch(e){}
  View.zoom = prevZoom; View.panX = prevPanX; View.panY = prevPanY; View._paneDX = prevPaneDX;

  ctx.setTransform(1,0,0,1,0,0);
  // crosshair at the placement point (always the preview centre — the board follows the part)
  ctx.strokeStyle = "rgba(255,210,77,0.7)"; ctx.lineWidth = 1*dpr;
  ctx.beginPath(); ctx.moveTo(PW/2-8*dpr,PH/2); ctx.lineTo(PW/2+8*dpr,PH/2);
  ctx.moveTo(PW/2,PH/2-8*dpr); ctx.lineTo(PW/2,PH/2+8*dpr); ctx.stroke();

  // overlay the footprint, pinned to the preview centre
  if (fp){
    ctx.save();
    ctx.translate(PW/2, PH/2);
    ctx.scale(fx, 1);
    ctx.rotate(QuickAdd.rot * Math.PI/180);
    if (QuickAdd.side === "back") ctx.scale(-1,1);
    drawFootprintShape(ctx, fp, pxPerMm, {alpha:0.85, zoom:1});
    ctx.restore();
  }
};

QuickAdd.nudge = (dx, dy) => {
  QuickAdd.pos.x += dx; QuickAdd.pos.y += dy;
  QuickAdd.render(); requestRender();   // render() re-crops the preview around the new pos
};

QuickAdd.rotate = (deg) => {
  QuickAdd.rot = ((QuickAdd.rot + deg) % 360 + 360) % 360;
  QuickAdd.updateInfo();   // keep the "Place on … °" fact current
  QuickAdd.render(); requestRender();
};

QuickAdd.place = () => {
  const p = QuickAdd.parsed, fp = QuickAdd.fp;
  if (!p || !fp){ UI.toast("Nothing to place — type a component first"); return; }
  if (!fp.pins.length && p.fpId !== "free"){ UI.toast("That footprint has no pads — check the query"); return; }
  const w = QuickAdd.pos;
  const rNew = Math.hypot(fp.body.w, fp.body.h)/2 * State.pxPerMm;
  for (const o of State.components){
    if (o.side !== QuickAdd.side) continue;
    if (Math.hypot(w.x-o.x, w.y-o.y) < Math.min(rNew, compRadius(o)) * 0.8){
      UI.toast("Too close to " + o.ref + " — components can't stack"); return;
    }
  }
  pushUndo("quick-add component");
  const ref = nextRef(p.prefix || "U");
  registerRef(ref);
  const comp = {
    id: nextId(), ref, value: p.value||"", part: p.part||"",
    fpId: p.fpId, fpParams: {...fp.params},
    kicad: fp.kicad || "",
    x: w.x, y: w.y, rot: QuickAdd.rot, side: QuickAdd.side,
    scale: 1,
    symOverride: p.symOverride || null,
    pins: fp.pins.map(fpin => ({ num:fpin.num, name:fpin.name||"", netId:null })),
  };
  if (comp.symOverride && comp.symOverride !== "box") applySymPinNames(comp, comp.symOverride);
  State.components.push(comp);
  autoConnectPins(comp);
  UI.select({type:"comp", comp});
  UI.toast("Placed " + ref + " (" + fp.label + ")");
  qaPushHistory($("#qa-input").value);
  QuickAdd.close();
  requestRender();
};

QuickAdd.wire = () => {
  const inp = $("#qa-input");
  inp.addEventListener("input", QuickAdd.update);

  // rotate / place keys come from the hotkey editor (quickadd.* actions). Defaults are a
  // bare-modifier tap (Shift = CW, Ctrl = CCW) and Enter (place); a modifier binding is
  // fired on keyup only if it was pressed alone, so holding it to type a capital still works.
  const cfg = () => ({
    cw:    Keymap.keyFor("quickadd.rotcw"),
    ccw:   Keymap.keyFor("quickadd.rotccw"),
    place: Keymap.keyFor("quickadd.place"),
  });
  const MODS = ["Shift","Control","Alt"];
  let modTap = null;   // a lone-pressed modifier awaiting keyup

  inp.addEventListener("keydown", (e) => {
    const c = cfg();
    if (MODS.includes(e.key)){
      modTap = (e.key === c.cw || e.key === c.ccw || e.key === c.place) ? e.key : null;
      return;   // let the modifier through (typing capitals etc.)
    }
    modTap = null;   // any real key cancels a pending modifier tap
    const ck = comboKey(e);   // modifier-aware, e.g. "Shift+K"
    // configured non-modifier bindings (e.g. after the user rebinds to a key/combo/F-key)
    if (c.place !== "Enter" && ck === c.place){ e.preventDefault(); QuickAdd.place(); return; }
    if (!MODS.includes(c.cw)  && ck === c.cw){  e.preventDefault(); QuickAdd.rotate(90);  return; }
    if (!MODS.includes(c.ccw) && ck === c.ccw){ e.preventDefault(); QuickAdd.rotate(-90); return; }
    // built-ins
    const step = State.pxPerMm * 0.25;   // 0.25 mm
    if (e.key === "ArrowLeft"){ e.preventDefault(); QuickAdd.nudge(-step, 0); }
    else if (e.key === "ArrowRight"){ e.preventDefault(); QuickAdd.nudge(step, 0); }
    else if (e.key === "ArrowUp"){ e.preventDefault(); QuickAdd.nudge(0, -step); }
    else if (e.key === "ArrowDown"){ e.preventDefault(); QuickAdd.nudge(0, step); }
    else if (e.key === "Enter" && c.place === "Enter"){ e.preventDefault(); QuickAdd.place(); }
    else if (e.key === "Escape"){ e.preventDefault(); QuickAdd.close(); }
  });
  inp.addEventListener("keyup", (e) => {
    if (!MODS.includes(e.key) || modTap !== e.key) return;
    const c = cfg(); modTap = null;
    if (e.key === c.cw) QuickAdd.rotate(90);
    else if (e.key === c.ccw) QuickAdd.rotate(-90);
    else if (e.key === c.place) QuickAdd.place();
  });
  // dialog-level keys: nudge / rotate / place / cancel keep working even when focus has
  // left the text field (e.g. after clicking the preview) — the input's own handler still
  // owns keys while it's focused (typing, bare-modifier taps for capitals).
  $("#qa-dialog").addEventListener("keydown", (e) => {
    if (!QuickAdd.active || e.target === inp) return;
    if (e.repeat) return;                     // holding a modifier auto-repeats keydown
    const c = cfg();
    const step = State.pxPerMm * 0.25;        // 0.25 mm
    if (e.key === "ArrowLeft"){ e.preventDefault(); QuickAdd.nudge(-step, 0); return; }
    if (e.key === "ArrowRight"){ e.preventDefault(); QuickAdd.nudge(step, 0); return; }
    if (e.key === "ArrowUp"){ e.preventDefault(); QuickAdd.nudge(0, -step); return; }
    if (e.key === "ArrowDown"){ e.preventDefault(); QuickAdd.nudge(0, step); return; }
    if (e.key === "Escape"){ e.preventDefault(); QuickAdd.close(); return; }
    // rotate / place via the configured bindings — bare modifiers fire on keydown here
    // (no text field to protect), everything else via the modifier-aware combo string
    const ck = comboKey(e);
    if (ck === c.cw){ e.preventDefault(); QuickAdd.rotate(90); return; }
    if (ck === c.ccw){ e.preventDefault(); QuickAdd.rotate(-90); return; }
    if (ck === c.place || (c.place === "Enter" && e.key === "Enter")){ e.preventDefault(); QuickAdd.place(); return; }
  });

  // drag anywhere on the preview to nudge the part (alternative to the arrow keys); the
  // part stays pinned to the preview centre and the board scrolls under it, exactly like
  // arrow nudging. Right-click the preview rotates (Shift = counter-clockwise).
  const pv = $("#qa-preview");
  let pvDrag = null;
  pv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pvDrag = { x: e.clientX, y: e.clientY };
    try { pv.setPointerCapture(e.pointerId); } catch(ex){}
    pv.style.cursor = "grabbing";
  });
  pv.addEventListener("pointermove", (e) => {
    if (!pvDrag) return;
    const dpr = View.dpr || 1;
    // CSS px → world px: inverse of the preview's world→device scale (QuickAdd._pxPerMm)
    const f = (State.pxPerMm * dpr) / (QuickAdd._pxPerMm || (State.pxPerMm * dpr));
    const fx = View.flip ? -1 : 1;            // flipped view mirrors world x on screen
    const dxw = (e.clientX - pvDrag.x) * f * fx;
    const dyw = (e.clientY - pvDrag.y) * f;
    pvDrag.x = e.clientX; pvDrag.y = e.clientY;
    QuickAdd.nudge(dxw, dyw);
  });
  const pvStop = (e) => { if (pvDrag){ pvDrag = null; pv.style.cursor = ""; } };
  pv.addEventListener("pointerup", pvStop);
  pv.addEventListener("pointercancel", pvStop);
  pv.addEventListener("contextmenu", (e) => { e.preventDefault(); QuickAdd.rotate(e.shiftKey ? -90 : 90); });

  // mouse wheel over the preview zooms it (large parts make pin alignment hard otherwise)
  $("#qa-preview").addEventListener("wheel", (e) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.2 : 1/1.2;
    QuickAdd.pvZoom = Math.max(0.3, Math.min(10, (QuickAdd.pvZoom || 1) * f));
    QuickAdd.render();
  }, { passive:false });
  const histClear = $("#qa-hist-clear");
  if (histClear) histClear.addEventListener("click", () => {
    try { localStorage.removeItem("pcbreveng.qaHistory"); } catch(e){}
    QuickAdd.renderSides();
  });
  $("#qa-place").addEventListener("click", QuickAdd.place);
  $("#qa-cancel").addEventListener("click", QuickAdd.close);
  $("#qa-full").addEventListener("click", () => { QuickAdd.close(); UI.openFootprintDialog(); });
  // closing via backdrop / Esc on the <dialog> itself
  $("#qa-dialog").addEventListener("close", () => { QuickAdd.active = false; QuickAdd.fp = null; requestRender(); });
};
