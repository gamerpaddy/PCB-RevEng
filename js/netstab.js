/* ===== netstab.js — the NETS tab =====
   A full-pane, expanded version of the left panel's net list: every net with its pad /
   via / trace membership, the trace widths and via drills that make it up, and inline
   editing of the things the side panel can only nudge — net name, colour, protection,
   and the net assignment of an individual pad.

   Reassigning a pad's net is the destructive one: a pad's schematic wires and the board
   traces touching it describe the OLD connection, so they're removed with the change
   (warned + confirmed first). Everything reads State live; UI.refreshNets() is wrapped
   at the bottom of this file so any net mutation elsewhere re-renders this table too —
   the same "the tab is always in sync" trick schematic.js uses on requestRender. */
"use strict";

const NetsTab = {
  filter: "",
  expanded: new Set(),   // netIds whose connection list is open
};

const NETS_CAP = 300;    // max net rows drawn at once (imports carry 1000s — filter to see more)

/* ---------------- formatting helpers ---------------- */
const _ntMm  = (px) => px / State.pxPerMm;
const _ntNum = (v, d) => {
  const s = v.toFixed(d == null ? 3 : d);
  return s.replace(/\.?0+$/, "");   // 1.200 → 1.2, 2.000 → 2
};
const _ntSide = (s) => SIDE_LABELS[s] || s;
const _ntWidthMm = (t) => _ntMm(t.width || State.traceW);
const _ntTraceLenMm = (t) => {
  let len = 0;
  for (let i = 0; i + 1 < t.points.length; i++)
    len += Math.hypot(t.points[i+1].x - t.points[i].x, t.points[i+1].y - t.points[i].y);
  return _ntMm(len);
};
const _ntPinLabel = (p) => p.name && String(p.name).trim() ? p.num + " (" + p.name + ")" : String(p.num);

/* ---------------- membership ---------------- */
/* everything on one net, split by kind (netMembers() flattens pads without their index,
   and the pad rows need the index to focus / reassign the pad) */
function ntMembers(netId){
  const pads = [], vias = [], traces = [];
  for (const c of State.components)
    for (let i = 0; i < c.pins.length; i++)
      if (c.pins[i].netId === netId) pads.push({ comp: c, pinIdx: i, pin: c.pins[i] });
  for (const v of State.vias)   if (v.netId === netId) vias.push(v);
  for (const t of State.traces) if (t.netId === netId) traces.push(t);
  return { pads, vias, traces };
}

/* the schematic wires anchored to a pad, and the board traces physically touching it —
   i.e. everything that would be left describing a connection the pad no longer has */
function ntPadAttachments(comp, pinIdx){
  const wires = (State.schWires || []).filter(w =>
    (w.a && w.a.comp === comp.id && w.a.pin === pinIdx) ||
    (w.b && w.b.comp === comp.id && w.b.pin === pinIdx));
  const fp = compFootprint(comp);
  const fpin = fp && fp.pins[pinIdx];
  const traces = fpin ? State.traces.filter(t => padTouchesTrace(comp, fpin, t)) : [];
  return { wires, traces };
}

/* ---------------- focusing (all jump back to the visual editor) ---------------- */
function ntCentreOn(x, y){
  View.panX = View.width / 2 - x * View.zoom * (View.flip ? -1 : 1);
  View.panY = View.height / 2 - y * View.zoom;
  requestRender();
}
NetsTab.focusPad = (comp, pinIdx) => { EditorTabs.show("visual"); UI.focusPin(comp, pinIdx); };
NetsTab.focusVia = (via) => {
  EditorTabs.show("visual");
  UI.select({ type: "via", via });
  ntCentreOn(via.x, via.y);
};
NetsTab.focusTrace = (trace) => {
  EditorTabs.show("visual");
  UI.select({ type: "trace", trace });
  const pts = trace.points;
  const mid = pts[Math.floor(pts.length / 2)] || pts[0];
  ntCentreOn(mid.x, mid.y);
};

/* ---------------- edits ---------------- */
/* Move ONE pad onto another net (or off every net when `name` is blank).
   The pad's schematic wires and the traces touching it wired it to its OLD net, so they
   go with the change — warned about and confirmed first, all inside one undo step. */
NetsTab.reassignPad = (comp, pinIdx, name) => {
  name = (name || "").trim();
  const pin = comp.pins[pinIdx];
  const cur = pin.netId ? (getNet(pin.netId)?.name || "") : "";
  const tag = comp.ref + "." + pin.num;
  if (name === cur){ NetsTab.render(); return; }
  if (name && pin.nc){
    UI.toast(tag + " is marked no-connect — unset NC first (right-click the pad)");
    NetsTab.render(); return;
  }
  const { wires, traces } = ntPadAttachments(comp, pinIdx);
  if (wires.length || traces.length){
    const bits = [];
    if (traces.length) bits.push(traces.length + " board trace" + (traces.length === 1 ? "" : "s"));
    if (wires.length)  bits.push(wires.length + " schematic wire" + (wires.length === 1 ? "" : "s"));
    const many = traces.length + wires.length > 1;
    if (!confirm(tag + " has " + bits.join(" and ") + " attached.\n\n" +
                 "Moving it to “" + (name || "(no net)") + "” deletes " + (many ? "them" : "it") +
                 " — " + (many ? "they wire" : "it wires") + " the pad to " + (cur || "its current net") + ".\n\n" +
                 "Continue? (undoable)")){
      NetsTab.render(); return;   // cancelled — put the input back to the real value
    }
  }
  pushUndo("net assign " + tag);
  // Assign FIRST: it's the step that can be refused (protected net), and cancelUndo()
  // only drops the undo entry — it does not roll State back. Deleting before a refusal
  // would strand the deletions with no way back.
  if (!assignNetToObject({ type: "pin", comp, pinIdx }, name, "one")){
    cancelUndo(); NetsTab.render(); return;
  }
  if (traces.length){
    const drop = new Set(traces);
    State.traces = State.traces.filter(t => !drop.has(t));
    if (UI.sel && UI.sel.type === "trace" && drop.has(UI.sel.trace)) UI.sel = null;
    UI.traceSel = (UI.traceSel || []).filter(t => !drop.has(t));
  }
  if (wires.length){
    const drop = new Set(wires);
    State.schWires = State.schWires.filter(w => !drop.has(w));
    if (typeof Sch !== "undefined"){ Sch.selWire = null; Sch.selWires = null; Sch.selSeg = null; }
  }
  pruneNets();
  markDirty();
  const gone = traces.length + wires.length;
  if (gone) UI.toast(tag + " → " + (name || "no net") + " · removed " + gone + " stale connection" + (gone === 1 ? "" : "s"));
  UI.refreshNets(); UI.refreshInspector(); requestRender();
  if (typeof Sch !== "undefined" && Sch.requestRender) Sch.requestRender();
};

NetsTab.renameNet = (net, name) => {
  name = (name || "").trim();
  if (!name || name === net.name){ NetsTab.render(); return; }
  if (net.protected){
    UI.toast(net.name + " is protected — unprotect it (🛡) to rename");
    NetsTab.render(); return;
  }
  const existing = findNetByName(name) || findNetByName(name.toUpperCase());
  if (existing && existing.id !== net.id &&
      !confirm("“" + name + "” already exists.\n\nRenaming merges " + net.name + " into it — " +
               "every pad, via and trace on both ends up on one net.\n\nContinue? (undoable)")){
    NetsTab.render(); return;
  }
  pushUndo("rename net " + net.name);
  if (!renameNet(net.id, name)){ cancelUndo(); UI.toast("Rename blocked (protected net)"); }
  markDirty();
  UI.refreshNets(); UI.refreshInspector(); requestRender();
};

NetsTab.setColor = (net, color) => {
  pushUndo("net colour");
  net.color = color;
  markDirty();
  requestRender();
};

NetsTab.toggleProtect = (net) => {
  pushUndo((net.protected ? "unprotect " : "protect ") + net.name);
  setNetProtected(net.id, !net.protected);
  markDirty();
  UI.refreshNets(); UI.refreshInspector(); requestRender();
};

/* ---------------- rendering ---------------- */
/* one connection row: [kind] [what] [detail] [net field | —] [focus] */
function ntDetailRow(kind, what, detail, netCell, onFocus){
  const tr = document.createElement("tr");
  const add = (cls, content) => {
    const td = document.createElement("td");
    if (cls) td.className = cls;
    if (content instanceof Node) td.appendChild(content); else td.textContent = content;
    tr.appendChild(td);
    return td;
  };
  add("nt-kind nt-k-" + kind, kind);
  add("nt-what", what);
  add("nt-detail", detail);
  add("nt-netcell", netCell || "—");
  const b = document.createElement("button");
  b.className = "nt-focus";
  b.textContent = "Focus";
  b.title = "Select it on the board and centre the view";
  b.addEventListener("click", onFocus);
  add("", b);
  return tr;
}

/* the expanded body of one net: every pad, via and trace on it */
function ntDetailTable(net, m){
  const tbl = document.createElement("table");
  tbl.className = "nt-sub";
  const head = document.createElement("tr");
  for (const h of ["", "Item", "Details", "Net", ""]){
    const th = document.createElement("th"); th.textContent = h; head.appendChild(th);
  }
  tbl.appendChild(head);

  for (const p of m.pads){
    const c = p.comp;
    const bits = [];
    if (c.value) bits.push(c.value);
    if (c.part && c.part !== c.value) bits.push(c.part);
    bits.push(_ntSide(c.side));
    if (p.pin.nc) bits.push("NC");
    const inp = document.createElement("input");
    inp.className = "nt-net net-ac";
    inp.value = net.name;
    inp.title = "Net for " + c.ref + "." + p.pin.num +
                " — type another net to move just this pad (blank = no net). " +
                "Attached wires/traces are removed (you'll be asked first).";
    inp.addEventListener("change", () => NetsTab.reassignPad(c, p.pinIdx, inp.value));
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    tbl.appendChild(ntDetailRow("pad", c.ref + " · pin " + _ntPinLabel(p.pin),
      bits.join(" · "), inp, () => NetsTab.focusPad(c, p.pinIdx)));
  }

  for (const v of m.vias){
    const dia = _ntNum(_ntMm((v.r || State.viaR) * 2), 2) + " mm Ø";
    const drill = v.hole ? _ntNum(_ntMm(v.hole * 2), 2) + " mm drill" : null;
    const det = [viaSpanLabel(v), dia, drill].filter(Boolean).join(" · ");
    tbl.appendChild(ntDetailRow("via", v.kind === "pth" ? "PTH" : "Via", det, null,
      () => NetsTab.focusVia(v)));
  }

  for (const t of m.traces){
    const wmm = _ntWidthMm(t);
    const det = [_ntSide(t.side),
                 _ntNum(wmm, 3) + " mm (" + _ntNum(wmm / 0.0254, 1) + " mil) wide",
                 _ntNum(_ntTraceLenMm(t), 2) + " mm long",
                 t.points.length + " pts"].join(" · ");
    tbl.appendChild(ntDetailRow("trace", "Trace", det, null, () => NetsTab.focusTrace(t)));
  }

  if (!m.pads.length && !m.vias.length && !m.traces.length){
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5; td.className = "panel-hint"; td.textContent = "Nothing on this net";
    tr.appendChild(td); tbl.appendChild(tr);
  }
  return tbl;
}

/* the summary of the trace widths / via sizes a net is built from */
function ntGaugeText(m){
  const bits = [];
  const ws = [...new Set(m.traces.map(t => _ntNum(_ntWidthMm(t), 3)))].sort((a, b) => a - b);
  if (ws.length) bits.push(ws.join(" / ") + " mm");
  const vs = [...new Set(m.vias.map(v => _ntNum(_ntMm((v.r || State.viaR) * 2), 2)))].sort((a, b) => a - b);
  if (vs.length) bits.push("Ø " + vs.join(" / "));
  return bits.join(" · ") || "—";
}

NetsTab.render = () => {
  const tbl = $("#nets-table");
  if (!tbl || $("#nets-pane").style.display === "none") return;
  tbl.innerHTML = "";
  const head = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const h of ["", "", "", "Net", "Pads", "Vias", "Traces", "Widths / via Ø"]){
    const th = document.createElement("th"); th.textContent = h; hr.appendChild(th);
  }
  head.appendChild(hr); tbl.appendChild(head);

  const q = NetsTab.filter.trim().toLowerCase();
  let shown = 0, total = 0, capped = false;
  for (const net of State.nets){
    const m = ntMembers(net.id);
    if (!m.pads.length && !m.vias.length && !m.traces.length) continue;   // same rule as the side panel
    total++;
    if (q && !net.name.toLowerCase().includes(q)) continue;
    if (shown >= NETS_CAP){ capped = true; continue; }
    shown++;

    const body = document.createElement("tbody");
    const tr = document.createElement("tr");
    tr.className = "nt-row" + (NetsTab.expanded.has(net.id) ? " open" : "");
    const cell = (cls) => { const td = document.createElement("td"); if (cls) td.className = cls; tr.appendChild(td); return td; };

    const open = NetsTab.expanded.has(net.id);
    const exp = document.createElement("button");
    exp.className = "nt-exp"; exp.textContent = open ? "▾" : "▸";
    exp.title = open ? "Hide connections" : "Show every pad, via and trace on this net";
    exp.addEventListener("click", () => {
      if (NetsTab.expanded.has(net.id)) NetsTab.expanded.delete(net.id);
      else NetsTab.expanded.add(net.id);
      NetsTab.render();
    });
    cell("nt-expcell").appendChild(exp);

    const col = document.createElement("input");
    col.type = "color"; col.className = "nt-color";
    col.value = /^#[0-9a-fA-F]{6}$/.test(net.color) ? net.color : "#888888";
    col.title = "Net colour";
    col.addEventListener("input", () => NetsTab.setColor(net, col.value));
    cell("nt-colcell").appendChild(col);

    const prot = document.createElement("button");
    prot.className = "nt-prot" + (net.protected ? " on" : "");
    prot.textContent = "🛡";
    prot.title = net.protected
      ? "Protected — locked name, shielded from accidental merges. Click to unprotect."
      : "Click to protect — lock the name and shield from accidental merges.";
    prot.addEventListener("click", () => NetsTab.toggleProtect(net));
    cell("nt-protcell").appendChild(prot);

    const nm = document.createElement("input");
    nm.className = "nt-name" + (net.protected ? " prot" : "");
    nm.value = net.name;
    nm.title = net.protected ? net.name + " is protected — unprotect (🛡) to rename"
                             : "Rename this net (renaming onto an existing net merges them)";
    nm.readOnly = !!net.protected;
    nm.addEventListener("change", () => NetsTab.renameNet(net, nm.value));
    nm.addEventListener("keydown", (e) => { if (e.key === "Enter") nm.blur(); });
    cell("nt-namecell").appendChild(nm);

    cell("nt-num").textContent = m.pads.length;
    cell("nt-num").textContent = m.vias.length;
    cell("nt-num").textContent = m.traces.length;
    cell("nt-gauge").textContent = ntGaugeText(m);

    tr.addEventListener("mouseenter", () => { View.hoverNetId = net.id; requestRender(); });
    tr.addEventListener("mouseleave", () => { if (View.hoverNetId === net.id){ View.hoverNetId = null; requestRender(); } });
    body.appendChild(tr);

    if (open){
      const dtr = document.createElement("tr");
      dtr.className = "nt-detailrow";
      const td = document.createElement("td");
      td.colSpan = 8;
      td.appendChild(ntDetailTable(net, m));
      dtr.appendChild(td);
      body.appendChild(dtr);
    }
    tbl.appendChild(body);
  }

  const hint = $("#nets-empty");
  hint.textContent = !total ? "No nets yet — nets appear once pads, vias or traces carry one."
    : capped ? "Showing the first " + NETS_CAP + " of " + total + " nets — use the filter to narrow it down."
    : (q && !shown) ? "No nets match “" + NetsTab.filter.trim() + "”"
    : "";
  hint.style.display = hint.textContent ? "" : "none";
  $("#nets-count").textContent = q ? "(" + shown + "/" + total + ")" : (total ? "(" + total + ")" : "");
};

NetsTab.enter = () => { NetsTab.render(); };

NetsTab.wire = () => {
  const s = $("#nets-search");
  s.addEventListener("input", () => { NetsTab.filter = s.value; NetsTab.render(); });
  $("#nets-expand").addEventListener("click", () => {
    for (const n of State.nets) NetsTab.expanded.add(n.id);
    NetsTab.render();
  });
  $("#nets-collapse").addEventListener("click", () => { NetsTab.expanded.clear(); NetsTab.render(); });
};

window.addEventListener("DOMContentLoaded", () => { NetsTab.wire(); });

/* Keep the tab live: every net mutation in the app already funnels through
   UI.refreshNets() for the side panel — piggyback on it so this table follows along
   (render() no-ops while the pane is hidden). */
(function wrapRefreshNets(){
  const inner = UI.refreshNets;
  UI.refreshNets = function(){
    inner.apply(this, arguments);
    if (EditorTabs.current === "nets") NetsTab.render();
  };
})();
