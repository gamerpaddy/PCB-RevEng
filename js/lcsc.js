/* ===== lcsc.js — JLCPCB / LCSC / EasyEDA part crawler (EXPERIMENTAL, OFF by default) =====
   Looks a part up by LCSC number (C25804) and imports what it finds:
     • footprint (pads converted from the EasyEDA footprint, 0.254 mm units → mm) → stored as a
       Custom footprint, placeable like any imported .kicad_mod
     • details: MPN, manufacturer, package, description, value, datasheet link, JLC class,
       price / stock — filled into the footprint dialog's Value / Part fields.
   Browsers block cross-origin reads of easyeda.com (no CORS header), so a lookup either goes
   through a local proxy URL (default "http://localhost:25615/?url={url}" – see
   tools/lcsc-proxy/, a small standalone executable built by GitHub Actions) or fails with
   a clear message.
   Nothing is ever sent unless the feature is switched on AND the user presses Fetch. */
"use strict";

const LCSC = {
  KEY_EN: "pcbreveng.lcscCrawler",
  KEY_PROXY: "pcbreveng.lcscProxy",
  DEFAULT_PROXY: "http://localhost:25615/?url={url}",
  API: "https://easyeda.com/api/products/{id}/components?version=6.4.19.5",
  UNIT: 0.254,                                  // EasyEDA unit = 10 mil in mm
  cache: new Map(),                             // id → parsed part (this session)

  enabled(){ try { return localStorage.getItem(LCSC.KEY_EN) === "on"; } catch(e){ return false; } },
  setEnabled(on){ try { localStorage.setItem(LCSC.KEY_EN, on ? "on" : "off"); } catch(e){} },
  /* the saved proxy URL, else the default local relay (an empty field resets to the default) */
  proxy(){
    let v = ""; try { v = (localStorage.getItem(LCSC.KEY_PROXY) || "").trim(); } catch(e){}
    if (!v || /^http:\/\/(localhost|127\.0\.0\.1):8765\//.test(v)) return LCSC.DEFAULT_PROXY;  // 8765 = old node relay
    return v;
  },
  setProxy(v){ try { v ? localStorage.setItem(LCSC.KEY_PROXY, v.trim()) : localStorage.removeItem(LCSC.KEY_PROXY); } catch(e){} },

  /* "C25804" | "25804" | any URL containing C25804 → "C25804" (or null) */
  parseId(s){
    const m = /(?:^|[^A-Za-z0-9])C(\d{2,9})(?!\d)/i.exec(" " + String(s || "")) ||
              /^\s*(\d{2,9})\s*$/.exec(String(s || ""));
    return m ? "C" + m[1] : null;
  },

  /* final URL for a target, routed through the configured proxy when there is one */
  _route(target){
    const p = LCSC.proxy();
    if (!p) return target;
    return p.includes("{url}") ? p.replace("{url}", encodeURIComponent(target)) : p + encodeURIComponent(target);
  },

  async _getJson(target){
    let res;
    try { res = await fetch(LCSC._route(target), { headers: { Accept: "application/json" } }); }
    catch(e){
      throw new Error(LCSC.proxy()
        ? "Could not reach the proxy (" + LCSC.proxy() + ") — is the lcsc-proxy program running?"
        : "Blocked by the browser (CORS). easyeda.com can only be read through a proxy — run the lcsc-proxy program (see the wiki) and check the Proxy URL in 🔬 Experimental.");
    }
    if (!res.ok) throw new Error("HTTP " + res.status + " from " + (LCSC.proxy() ? "proxy" : "server"));
    return res.json();
  },

  /* ---- EasyEDA footprint shapes → this app's footprint entry ({name,pins,body}) in mm ---- */
  footprintFromPackage(pd, fallbackName){
    const ds = pd && pd.dataStr;
    if (!ds || !Array.isArray(ds.shape)) return null;
    const ox = parseFloat(ds.head && ds.head.x) || 0, oy = parseFloat(ds.head && ds.head.y) || 0;
    const U = LCSC.UNIT, num = (s) => { const v = parseFloat(s); return isFinite(v) ? v : 0; };
    const pins = [];
    const silk = [];                                   // silkscreen points → body outline
    for (const raw of ds.shape){
      const f = String(raw).split("~");
      if (f[0] === "PAD"){
        const layer = f[6];
        if (layer !== "1" && layer !== "2" && layer !== "11") continue;   // copper only (not paste/mask)
        const shape = f[1];
        let w = num(f[4]) * U, h = num(f[5]) * U;
        const pts = (f[10] || "").trim().split(/\s+/).map(Number).filter(isFinite);
        if ((!(w > 0) || !(h > 0)) && pts.length >= 4){                     // polygon pads: use their bbox
          const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
          w = (Math.max(...xs) - Math.min(...xs)) * U; h = (Math.max(...ys) - Math.min(...ys)) * U;
        }
        if (!(w > 0) || !(h > 0)) continue;
        const rot = ((num(f[11]) % 360) + 360) % 360;
        if (rot === 90 || rot === 270){ const t = w; w = h; h = t; }       // rotated pad → swapped extents
        const holeR = num(f[9]), tht = layer === "11" || holeR > 0;
        const pin = {
          num: String(f[8] || pins.length + 1).trim(),
          x: (num(f[2]) - ox) * U, y: (num(f[3]) - oy) * U,
          shape: (shape === "ELLIPSE" && Math.abs(w - h) < 0.01) ? "circle" : "rect",
          w, h, tht,
        };
        if (pin.shape === "circle") pin.w = pin.h = Math.max(w, h);
        if (tht && holeR > 0) pin.hole = +(holeR * 2 * U).toFixed(3);
        if (!tht && pin.shape === "circle") pin.tht = false;
        pins.push(pin);
      } else if (f[0] === "TRACK" && f[2] === "3"){                        // TopSilkLayer line
        const p = (f[4] || "").trim().split(/\s+/).map(Number);
        for (let i = 0; i + 1 < p.length; i += 2) if (isFinite(p[i]) && isFinite(p[i+1])) silk.push([(p[i]-ox)*U, (p[i+1]-oy)*U]);
      }
    }
    if (!pins.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const take = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    for (const p of pins){ take(p.x - p.w/2, p.y - p.h/2); take(p.x + p.w/2, p.y + p.h/2); }
    const padBox = { minX, minY, maxX, maxY };
    for (const [x, y] of silk) take(x, y);
    // centre everything on the overall bbox (same convention as parseKicadMod)
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    for (const p of pins){ p.x = +(p.x - cx).toFixed(4); p.y = +(p.y - cy).toFixed(4); }
    const bw = silk.length ? maxX - minX : (padBox.maxX - padBox.minX) + 0.6;
    const bh = silk.length ? maxY - minY : (padBox.maxY - padBox.minY) + 0.6;
    const name = String((pd.dataStr.head && pd.dataStr.head.c_para && pd.dataStr.head.c_para.package) || fallbackName || "LCSC part")
      .replace(/[^\w.+\- ]+/g, "_").slice(0, 60);
    return { name, pins, body: { w: Math.max(1, +bw.toFixed(3)), h: Math.max(1, +bh.toFixed(3)) }, kicad: "" };
  },

  /* fetch + parse one LCSC part → { id,title,description,value,mpn,manufacturer,package,partClass,
                                    datasheet,url,price,stock,thumb, fp } */
  async fetchPart(idIn){
    const id = LCSC.parseId(idIn);
    if (!id) throw new Error("Not an LCSC part number — expected e.g. C25804");
    if (LCSC.cache.has(id)) return LCSC.cache.get(id);
    const j = await LCSC._getJson(LCSC.API.replace("{id}", id));
    if (!j || j.success === false || !j.result) throw new Error("Part " + id + " not found" + (j && j.message ? " (" + j.message + ")" : ""));
    const r = j.result;
    const sym = (r.dataStr && r.dataStr.head && r.dataStr.head.c_para) || {};
    const pkgPara = (r.packageDetail && r.packageDetail.dataStr && r.packageDetail.dataStr.head && r.packageDetail.dataStr.head.c_para) || {};
    const shop = r.lcsc || r.szlcsc || {};
    const part = {
      id,
      title: r.title || sym.name || "",
      description: r.description || "",
      value: sym.Value || "",
      mpn: sym["Manufacturer Part"] || r.title || "",
      manufacturer: (sym.Manufacturer || "").replace(/\(.*?\)\s*$/, "").trim(),
      package: pkgPara.package || sym.package || "",
      partClass: sym["JLCPCB Part Class"] || "",
      datasheet: pkgPara.link || "",
      url: shop.url || "",
      price: shop.price != null ? shop.price : null,
      stock: shop.stock != null ? shop.stock : null,
      thumb: r.thumb ? (String(r.thumb).startsWith("//") ? "https:" + r.thumb : r.thumb) : "",
      fp: LCSC.footprintFromPackage(r.packageDetail, sym.package),
    };
    LCSC.cache.set(id, part);
    return part;
  },

  /* store the part's footprint as a Custom footprint; returns the entry (or null) */
  importFootprint(part){
    if (!part || !part.fp) return null;
    const entry = Object.assign({}, part.fp, { lcsc: part.id });
    CustomFPs.add(entry);
    return entry;
  },

  summary(part){
    const bits = [part.id, part.mpn, part.manufacturer, part.package, part.partClass,
                  part.price != null ? "$" + part.price : "", part.stock != null ? part.stock + " in stock" : ""].filter(Boolean);
    return bits.join(" · ");
  },
};

/* ---------- Experimental-dialog wiring (box defined in index.html #lab-dialog) ---------- */
function wireLCSC(){
  const en = document.getElementById("lcsc-en"), px = document.getElementById("lcsc-proxy");
  if (!en || !px) return;
  const sync = () => { en.checked = LCSC.enabled(); px.value = LCSC.proxy(); };
  sync();
  document.getElementById("btn-lab")?.addEventListener("click", sync);
  en.addEventListener("change", () => LCSC.setEnabled(en.checked));
  px.addEventListener("change", () => LCSC.setProxy(px.value));
}

/* Download button: point it straight at the executable for this computer (the rolling release
   built by .github/workflows/build-proxy.yml). Falls back to the release page when the
   system/CPU can't be told apart (e.g. macOS in Safari/Firefox hides Intel vs Apple silicon). */
const LCSC_RELEASE = "https://github.com/gamerpaddy/PCB-RevEng/releases/";
async function wireLCSCDownload(){
  const a = document.getElementById("lcsc-dl"), note = document.getElementById("lcsc-dl-note");
  if (!a) return;
  const ua = navigator.userAgent || "", uad = navigator.userAgentData;
  const plat = ((uad && uad.platform) || navigator.platform || "") + " " + ua;
  let arch = "";
  try { if (uad && uad.getHighEntropyValues) arch = (await uad.getHighEntropyValues(["architecture"])).architecture || ""; } catch(e){}
  const arm = arch === "arm" || /arm64|aarch64/i.test(ua);
  let file = "", label = "";
  if (/win/i.test(plat) && !/darwin/i.test(plat)){ file = arm ? "lcsc-proxy-windows-arm64.exe" : "lcsc-proxy-windows-x64.exe"; label = "Windows"; }
  else if (/android/i.test(ua)) { file = ""; }
  else if (/linux|x11/i.test(plat)){ file = arm ? "lcsc-proxy-linux-arm64" : "lcsc-proxy-linux-x64"; label = "Linux"; }
  else if (/mac/i.test(plat) && arch){ file = arch === "arm" ? "lcsc-proxy-macos-apple-silicon" : "lcsc-proxy-macos-intel"; label = "macOS"; }
  if (!file){ if (note) note.textContent = "pick your system on the release page"; return; }
  a.href = LCSC_RELEASE + "download/lcsc-proxy-latest/" + file;
  a.removeAttribute("target");   // plain file download, no blank tab
  a.textContent = "⬇ Download proxy (" + label + ")";
  if (note) note.textContent = "then run it and leave it open" + (label === "Windows" ? "" : " (chmod +x first)");
}
window.addEventListener("DOMContentLoaded", wireLCSC);
window.addEventListener("DOMContentLoaded", wireLCSCDownload);
