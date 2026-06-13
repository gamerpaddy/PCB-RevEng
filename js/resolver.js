/* ===== resolver.js — resistor value resolver: SMD codes (3/4-digit, EIA-96, R/k notation)
   and THT color bands ===== */
"use strict";

/* EIA-96 significant figures, codes 01..96 */
const EIA96 = [
  100,102,105,107,110,113,115,118,121,124,127,130,133,137,140,143,147,150,154,158,
  162,165,169,174,178,182,187,191,196,200,205,210,215,221,226,232,237,243,249,255,
  261,267,274,280,287,294,301,309,316,324,332,340,348,357,365,374,383,392,402,412,
  422,432,442,453,464,475,487,499,511,523,536,549,562,576,590,604,619,634,649,665,
  681,698,715,732,750,768,787,806,825,845,866,887,909,931,953,976
];
const EIA96_MULT = { Z:0.001, Y:0.01, R:0.01, X:0.1, S:0.1, A:1, B:10, H:10, C:100, D:1000, E:10000, F:100000 };

function formatOhms(v){
  if (!(v > 0)) return String(v);
  const fmt = (x)=> (+x.toFixed(2)).toString();
  if (v >= 1e9) return fmt(v/1e9) + "G";
  if (v >= 1e6) return fmt(v/1e6) + "M";
  if (v >= 1e3) return fmt(v/1e3) + "k";
  return fmt(v);
}

/* decode an SMD marking; returns {ohms, text, how} or null */
function decodeSMD(input){
  const s = (input || "").trim().toUpperCase();
  if (!s) return null;
  let m;
  // EIA-96: two digits + multiplier letter (01C = 10k)
  if ((m = /^(\d{2})([ZYRXSABHCDEF])$/.exec(s))){
    const code = parseInt(m[1],10);
    if (code >= 1 && code <= 96){
      const ohms = EIA96[code-1] * EIA96_MULT[m[2]];
      return { ohms, text: formatOhms(ohms), how: "EIA-96 (" + m[1] + " = " + EIA96[code-1] + " × " + EIA96_MULT[m[2]] + ")" };
    }
  }
  // R / k / M decimal-point notation: 4R7, R47, 4K7, 1M2
  if ((m = /^(\d*)([RKM])(\d*)$/.exec(s)) && (m[1] || m[3])){
    const base = parseFloat((m[1]||"0") + "." + (m[3]||"0"));
    const mult = m[2] === "K" ? 1e3 : m[2] === "M" ? 1e6 : 1;
    const ohms = base * mult;
    return { ohms, text: formatOhms(ohms), how: "decimal-point notation" };
  }
  // 3 / 4 digit code: 103 = 10×10³, 4702 = 470×10²
  if ((m = /^(\d{3,4})$/.exec(s))){
    const digits = m[1];
    const sig = parseInt(digits.slice(0,-1),10);
    const exp = parseInt(digits.slice(-1),10);
    const ohms = sig * Math.pow(10, exp);
    return { ohms, text: formatOhms(ohms), how: digits.length + "-digit code (" + sig + " × 10^" + exp + ")" };
  }
  return null;
}

/* ---------------- color bands ---------------- */
const BAND_COLORS = [
  { name:"black",  css:"#1a1a1a", digit:0, mult:1 },
  { name:"brown",  css:"#7a4424", digit:1, mult:10,    tol:"1%" },
  { name:"red",    css:"#cc3333", digit:2, mult:100,   tol:"2%" },
  { name:"orange", css:"#e07b28", digit:3, mult:1e3 },
  { name:"yellow", css:"#e0c428", digit:4, mult:1e4 },
  { name:"green",  css:"#3f9e4d", digit:5, mult:1e5,   tol:"0.5%" },
  { name:"blue",   css:"#3a6fd8", digit:6, mult:1e6,   tol:"0.25%" },
  { name:"violet", css:"#9450c8", digit:7, mult:1e7,   tol:"0.1%" },
  { name:"grey",   css:"#8a8a8a", digit:8, mult:1e8,   tol:"0.05%" },
  { name:"white",  css:"#e8e8e8", digit:9, mult:1e9 },
  { name:"gold",   css:"#c8a032", mult:0.1,  tol:"5%" },
  { name:"silver", css:"#b8bcc4", mult:0.01, tol:"10%" },
];

function decodeBands(idx){ // idx = array of BAND_COLORS indices, length 4 or 5
  const n = idx.length;
  const digits = idx.slice(0, n-2).map(i => BAND_COLORS[i].digit);
  if (digits.some(d => d === undefined)) return null;
  const multC = BAND_COLORS[idx[n-2]], tolC = BAND_COLORS[idx[n-1]];
  if (multC.mult === undefined) return null;
  const sig = digits.reduce((a,d) => a*10 + d, 0);
  const ohms = sig * multC.mult;
  return { ohms, text: formatOhms(ohms), tol: tolC.tol || "±20%" };
}

/* auto-resolve a typed value: bare SMD codes (103, 01C) → ohms; anything already
   written as a human value with an R/k/M/µ/Ω/F marker (220R, 4k7, 10uF) is kept
   literal — so "220R" stays 220 Ω and is never re-read as a 3-digit code. */
function autoResolveValue(v){
  v = (v || "").trim();
  if (!v) return v;
  if (/[a-zA-ZµΩ]/.test(v)){
    // EIA-96 (two digits + a single multiplier letter) is the one lettered form we still resolve
    if (/^\d{2}[ZYRXSABHCDEF]$/i.test(v)){ const d = decodeSMD(v); if (d) return d.text; }
    return v; // otherwise literal (220R, 4k7, 10uF, NE555…)
  }
  const d = decodeSMD(v);   // bare digits → 3/4-digit code
  return d ? d.text : v;
}

/* ---------------- dialog ---------------- */
const Resolver = { onUse: null, lastValue: "" };

Resolver.open = (onUse) => {
  Resolver.onUse = onUse || null;
  Resolver.lastValue = "";
  Resolver.buildBands();
  const code = document.getElementById("res-code");
  code.value = "";
  document.getElementById("res-code-out").textContent = "";
  document.getElementById("res-dialog").showModal();
  code.focus();
};

Resolver.buildBands = () => {
  const n = parseInt(document.getElementById("res-bands").value, 10);
  const row = document.getElementById("res-band-row");
  row.innerHTML = "";
  const defaults = n === 4 ? [1,0,2,10] : [1,0,0,2,1]; // brown black (black) red gold/brown
  for (let i=0;i<n;i++){
    const sel = document.createElement("select");
    sel.className = "band-sel";
    const isMult = i === n-2, isTol = i === n-1;
    BAND_COLORS.forEach((c,ci)=>{
      const valid = isTol ? !!c.tol : isMult ? c.mult !== undefined : c.digit !== undefined;
      if (!valid) return;
      const o = document.createElement("option");
      o.value = ci; o.textContent = c.name;
      o.style.background = c.css;
      sel.appendChild(o);
    });
    sel.value = String(defaults[i]);
    sel.style.borderLeft = "10px solid " + BAND_COLORS[+sel.value].css;
    sel.addEventListener("change", ()=>{
      sel.style.borderLeft = "10px solid " + BAND_COLORS[+sel.value].css;
      Resolver.updateBands();
    });
    row.appendChild(sel);
  }
  Resolver.updateBands();
};

Resolver.updateBands = () => {
  const idx = [...document.querySelectorAll("#res-band-row select")].map(s => +s.value);
  const r = decodeBands(idx);
  const out = document.getElementById("res-band-out");
  if (r){
    out.textContent = "= " + r.text + "Ω  " + r.tol;
    Resolver.lastValue = r.text;
  } else out.textContent = "—";
};

Resolver.wire = () => {
  document.getElementById("res-code").addEventListener("input", e => {
    const r = decodeSMD(e.target.value);
    const out = document.getElementById("res-code-out");
    if (r){
      out.textContent = "= " + r.text + "Ω   (" + r.how + ")";
      Resolver.lastValue = r.text;
    } else out.textContent = e.target.value.trim() ? "unrecognized code" : "";
  });
  document.getElementById("res-code").addEventListener("keydown", e => {
    if (e.key === "Enter"){ e.preventDefault(); document.getElementById("res-use").click(); }
  });
  document.getElementById("res-bands").addEventListener("change", Resolver.buildBands);
  document.getElementById("res-close").addEventListener("click", ()=> document.getElementById("res-dialog").close());
  document.getElementById("res-use").addEventListener("click", ()=>{
    document.getElementById("res-dialog").close();
    if (Resolver.onUse && Resolver.lastValue) Resolver.onUse(Resolver.lastValue);
  });
};
