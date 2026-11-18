/* ===== tour.js — first-run guided tour ("where is everything?") =====
   Dims the app, cuts a spotlight hole around the part of the UI being explained and shows a
   small card with Back / Next / Skip. Runs once on first launch (flag in localStorage), and
   again any time from the Help (?) dialog → "Take the tour". Esc = skip. */
"use strict";

const Tour = {
  KEY: "pcbreveng.tourDone",
  active: false,
  i: 0,
  steps: [],
  dir: 1,

  /* sel: one selector or an array — every match is highlighted (all must be visible to count).
     No sel → centered card (welcome). */
  STEPS: [
    { title: "Welcome to PCB RevEng 👋",
      text: "Turn photos of a real circuit board into an editable design — pads, traces, nets, schematic. This 1-minute tour shows where things are. You can skip it any time." },
    { sel: "#left-panel .panel-title", place: "right",
      title: "1 · Import images",
      text: "Drop PCB photos onto the canvas or press <b>+ Add</b> (or <b>+ URL</b>). Add front, back and inner layers. Then straighten each photo with <b>Rotate</b>, <b>Align</b> (4-point), <b>Crop</b>, <b>Deskew</b>, and set the real scale with <b>Calibrate</b>." },
    { sel: ["#left-panel > .panel-hint", "#tb-view"], place: "below",
      title: "2 · Layers & sides",
      text: "Every photo is a layer — click one to make it active. Keys <b>1…0</b> switch which layer you look at. <b>Draw on</b> picks the copper side for new traces and parts, <b>Flip view</b> looks from the back, X-ray / Split show both sides at once." },
    { sel: "#toolbar .tool[data-tool='component']", place: "below",
      title: "3 · Place parts",
      text: "Pick the <b>Comp</b> tool (<b>C</b>), choose a footprint, then click the board over each part. Pads appear on top of your photo; drag a part to line it up. Hold <b>C</b> while clicking to jump straight to Custom parts." },
    { sel: ["#toolbar .tool[data-tool='trace']", "#toolbar .tool[data-tool='via']", "#toolbar .tool[data-tool='select']"], place: "below",
      title: "4 · Draw traces",
      text: "<b>Trace</b> (<b>W</b>): click a pad, click corners, finish on another pad, via or trace — it snaps, and the connection becomes a net. <b>Via</b> (<b>V</b>) drops a via, <b>Select</b> (<b>S</b>) moves things (Ctrl+click or drag a box to select several)." },
    { sel: "#btn-check", place: "right",
      title: "5 · Check for issues",
      text: "<b>Check</b> lists pads that still have no net so you can find missed connections. Clicking an item jumps to it. The net list below it lets you search, highlight and rename nets." },
    { sel: "#editor-tabs", place: "below",
      title: "6 · Schematic & more tabs",
      text: "The <b>Schematic</b> tab builds a schematic from your nets — drag symbols to arrange, <b>W</b> to wire, export it for KiCad. <b>BOM</b> edits values and footprints, <b>Nets</b> is a full net overview, <b>Projects</b> manages saved boards." },
    { sel: "#board-tabs", place: "above",
      title: "7 · Pages",
      text: "A project can have several <b>pages</b> — e.g. main board + daughter board. Each page has its own images, parts and traces; nets are shared. <b>+</b> adds one, double-click renames, right-click for more." },
    { sel: ["#topbar .tb-group", "#save-status", "#tab-projects"], place: "below",
      title: "8 · Save & export",
      text: "<b>Save</b> downloads a <code>.pcbrev.json</code> project file. Your work also autosaves in this browser (status at the right), and the <b>Projects</b> tab keeps many boards with version history. <b>Export</b> creates a netlist, BOM or KiCad schematic. <b>Open</b> also imports EAGLE / GENCAD boards." },
    { sel: ["#btn-options", "#btn-keys"], place: "below",
      title: "9 · Settings",
      text: "<b>Options</b> holds units, colors, snapping, edge-scroll, autosave and settings import/export. The keyboard button next to it opens the <b>hotkey editor</b>." },
    { sel: "#btn-lab", place: "below",
      title: "10 · Experimental",
      text: "<b>🔬 Experimental</b> has opt-in extras that are off by default: LCSC/JLC part lookup, AI helpers and via checks. Handy, but rough around the edges." },
    { sel: ["#btn-undo", "#btn-redo", "#btn-history"], place: "below",
      title: "11 · Undo timeline",
      text: "Undo / redo as usual — and the <b>timeline</b> (clock) lists every past action so you can revert a single earlier step without losing the work after it." },
    { sel: "#btn-mp", place: "below",
      title: "12 · Multiplayer",
      text: "<b>Live</b> lets you work on the same board together in real time, directly peer-to-peer — no account and no server. Connect by exchanging two short codes. That's it — happy reversing! The <b>?</b> button re-opens this tour." },
  ],

  seen(){ try { return localStorage.getItem(Tour.KEY) === "1"; } catch(e){ return false; } },
  markSeen(){ try { localStorage.setItem(Tour.KEY, "1"); } catch(e){} },

  /* visible rects of a step's targets ([] when anything is missing → step is skipped) */
  rects(step){
    if (!step.sel) return [];
    const sels = Array.isArray(step.sel) ? step.sel : [step.sel];
    const out = [];
    for (const s of sels){
      const el = document.querySelector(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === "hidden") return null;
      out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  },

  start(force){
    if (Tour.active) return;
    if (!force && Tour.seen()) return;
    Tour.active = true;
    // targets live in the Visual editor; make sure it is showing
    try { if (typeof EditorTabs !== "undefined" && EditorTabs.current !== "visual") EditorTabs.show("visual"); } catch(e){}
    Tour.i = 0; Tour.dir = 1;
    Tour.build();
    Tour.show(0, 1);
  },

  build(){
    const root = document.createElement("div");
    root.id = "tour-root";
    root.innerHTML =
      '<div id="tour-block"></div>' +
      '<svg id="tour-dim" xmlns="http://www.w3.org/2000/svg"><path id="tour-path" fill-rule="evenodd"></path></svg>' +
      '<div id="tour-rings"></div>' +
      '<div id="tour-card" role="dialog" aria-live="polite">' +
        '<div id="tour-title"></div><div id="tour-text"></div>' +
        '<div id="tour-foot"><button type="button" id="tour-skip">Skip tour</button><span id="tour-prog"></span>' +
        '<span class="tour-nav"><button type="button" id="tour-back">Back</button><button type="button" id="tour-next" class="primary">Next</button></span></div>' +
      '</div>';
    document.body.appendChild(root);
    root.querySelector("#tour-skip").addEventListener("click", () => Tour.end());
    root.querySelector("#tour-back").addEventListener("click", () => Tour.go(-1));
    root.querySelector("#tour-next").addEventListener("click", () => Tour.go(1));
    Tour._key = (e) => {
      if (e.key === "Escape"){ e.preventDefault(); e.stopPropagation(); Tour.end(); return; }
      if (e.key === "ArrowRight" || e.key === "Enter"){ e.preventDefault(); e.stopPropagation(); Tour.go(1); return; }
      if (e.key === "ArrowLeft"){ e.preventDefault(); e.stopPropagation(); Tour.go(-1); return; }
      e.stopPropagation();   // keep hotkeys from reaching the app mid-tour
    };
    Tour._resize = () => Tour.layout();
    window.addEventListener("keydown", Tour._key, true);
    window.addEventListener("resize", Tour._resize);
  },

  /* the steps that can be shown right now (targets present + visible) */
  usable(){ return Tour.STEPS.map((s, idx) => ({ s, idx })).filter(o => !o.s.sel || Tour.rects(o.s)); },

  go(d){
    const list = Tour.usable().map(o => o.idx);
    const pos = list.indexOf(Tour.i);
    const next = pos + d;
    if (next >= list.length){ Tour.end(); return; }
    if (next < 0) return;
    Tour.show(list[next], d);
  },

  show(idx, dir){
    Tour.i = idx; Tour.dir = dir;
    const step = Tour.STEPS[idx];
    const list = Tour.usable().map(o => o.idx);
    const pos = list.indexOf(idx);
    const root = document.getElementById("tour-root");
    if (!root) return;
    root.querySelector("#tour-title").innerHTML = step.title;
    root.querySelector("#tour-text").innerHTML = step.text;
    root.querySelector("#tour-prog").textContent = (pos + 1) + " / " + list.length;
    root.querySelector("#tour-back").style.visibility = pos > 0 ? "visible" : "hidden";
    root.querySelector("#tour-next").textContent = pos === list.length - 1 ? "Finish" : "Next";
    Tour.layout();
    root.querySelector("#tour-next").focus({ preventScroll: true });
  },

  /* (re)position spotlight holes, rings and the card for the current step */
  layout(){
    const root = document.getElementById("tour-root");
    if (!root) return;
    const step = Tour.STEPS[Tour.i];
    const W = window.innerWidth, H = window.innerHeight, pad = 5;
    const rects = (step.sel ? Tour.rects(step) : []) || [];
    // dim layer with one rectangular hole per target (even-odd fill)
    const svg = root.querySelector("#tour-dim");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    let d = "M0 0H" + W + "V" + H + "H0Z";
    const rings = root.querySelector("#tour-rings");
    rings.innerHTML = "";
    const box = rects.map(r => ({ x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), w: r.w + pad*2, h: r.h + pad*2 }));
    for (const b of box){
      d += "M" + b.x + " " + b.y + "h" + b.w + "v" + b.h + "h" + (-b.w) + "Z";
      const ring = document.createElement("div");
      ring.className = "tour-ring";
      ring.style.cssText = "left:" + b.x + "px;top:" + b.y + "px;width:" + b.w + "px;height:" + b.h + "px";
      rings.appendChild(ring);
    }
    root.querySelector("#tour-path").setAttribute("d", d);

    // card placement next to the highlighted area
    const card = root.querySelector("#tour-card");
    card.style.left = "0px"; card.style.top = "0px";
    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14;
    let x, y;
    if (!box.length){
      x = (W - cw) / 2; y = (H - ch) / 2;
    } else {
      const u = { x: Math.min(...box.map(b => b.x)), y: Math.min(...box.map(b => b.y)),
                  r: Math.max(...box.map(b => b.x + b.w)), b: Math.max(...box.map(b => b.y + b.h)) };
      const cx = (u.x + u.r) / 2;
      const spots = {
        below: () => ({ x: cx - cw/2, y: u.b + gap, ok: u.b + gap + ch <= H - 8 }),
        above: () => ({ x: cx - cw/2, y: u.y - gap - ch, ok: u.y - gap - ch >= 8 }),
        right: () => ({ x: u.r + gap, y: u.y, ok: u.r + gap + cw <= W - 8 }),
        left:  () => ({ x: u.x - gap - cw, y: u.y, ok: u.x - gap - cw >= 8 }),
      };
      const order = [step.place || "below", "below", "right", "above", "left"];
      let pick = null;
      for (const k of order){ const s = spots[k](); if (s.ok){ pick = s; break; } }
      if (!pick){ pick = { x: (W - cw) / 2, y: H - ch - 20 }; }   // nothing fits: dock at the bottom
      x = pick.x; y = pick.y;
    }
    card.style.left = Math.round(Math.max(8, Math.min(W - cw - 8, x))) + "px";
    card.style.top  = Math.round(Math.max(8, Math.min(H - ch - 8, y))) + "px";
  },

  end(){
    Tour.markSeen();
    Tour.active = false;
    window.removeEventListener("keydown", Tour._key, true);
    window.removeEventListener("resize", Tour._resize);
    document.getElementById("tour-root")?.remove();
  },

  /* first run: wait until nothing else is in the way (loading overlay, welcome dialog …) */
  autoStart(){
    if (Tour.seen()) return;
    let tries = 0;
    const tick = () => {
      if (Tour.seen() || Tour.active) return;
      const busy = document.querySelector("dialog[open]") ||
                   document.querySelector("#loading-overlay.show");
      if (!busy && tries >= 2){ Tour.start(false); return; }
      if (++tries < 240) setTimeout(tick, 500);
    };
    setTimeout(tick, 800);
  },
};

window.addEventListener("DOMContentLoaded", () => {
  // Help dialog → "Take the tour"
  const dlg = document.getElementById("help-dialog");
  const btns = dlg && dlg.querySelector(".dlg-buttons");
  if (btns && !document.getElementById("help-tour")){
    const b = document.createElement("button");
    b.id = "help-tour"; b.type = "button"; b.textContent = "Take the tour";
    b.addEventListener("click", () => { dlg.close(); setTimeout(() => Tour.start(true), 50); });
    btns.insertBefore(b, btns.firstChild);
  }
  Tour.autoStart();
});
