/* ===== keymap.js — rebindable hotkeys, persisted in localStorage ===== */
"use strict";

/* run-helper: trigger a toolbar button's own click handler, so a hotkey does exactly
   what pressing the button does (no duplicated logic). */
function clickBtn(sel){ return () => { const el = document.querySelector(sel); if (el) el.click(); }; }

/* `btn` (optional) is the CSS selector of the toolbar button this action drives — used
   to show its current binding in the tooltip and to set/clear it by right-clicking the
   button. Actions with def:"" are UNBOUND by default (right-click to assign a key). */
const KeyActions = [
  { id:"tool.select",    label:"Select / move tool",            def:"S",      btn:"#toolbar .tool[data-tool='select']",    run:()=>setTool("select") },
  { id:"tool.component", label:"Place component tool",          def:"C",      btn:"#toolbar .tool[data-tool='component']", run:()=>{ Tools.pending=null; setTool("component"); } },
  { id:"tool.trace",     label:"Trace tool",                    def:"W",      btn:"#toolbar .tool[data-tool='trace']",     run:()=>setTool("trace") },
  { id:"tool.via",       label:"Via tool (press again = pick/clear net under cursor)", def:"V", btn:"#toolbar .tool[data-tool='via']", run:()=>{ if (Tools.name === "via") viaNetPick(); else setTool("via"); } },
  { id:"tool.cut",       label:"Cut trace tool",                def:"K",      btn:"#toolbar .tool[data-tool='cut']",       run:()=>setTool("cut") },
  { id:"tool.note",      label:"Sticky-note tool",              def:"",       btn:"#toolbar .tool[data-tool='note']",      run:()=>setTool("note") },
  { id:"tool.align",     label:"Align image layer tool",        def:"",       run:()=>setTool("align") },
  { id:"tool.measure",   label:"Measure tool",                  def:"M",      btn:"#btn-measure",   run:()=>setTool("measure") },
  { id:"tool.calibrate", label:"Calibrate scale tool",          def:"",       btn:"#btn-calibrate", run:clickBtn("#btn-calibrate") },
  { id:"tool.rotate",    label:"Rotate layer tool",             def:"",       btn:"#btn-rotate",    run:clickBtn("#btn-rotate") },
  { id:"tool.deskew",    label:"Deskew layer",                  def:"",       btn:"#btn-deskew",    run:clickBtn("#btn-deskew") },
  { id:"tool.align4",    label:"4-point align layer (wizard)",  def:"",       btn:"#btn-align",     run:clickBtn("#btn-align") },
  { id:"tool.crop",      label:"Crop layer",                    def:"",       btn:"#btn-crop",      run:clickBtn("#btn-crop") },
  { id:"tool.resizexy",  label:"Resize XY layer",               def:"",       btn:"#btn-resizexy",  run:clickBtn("#btn-resizexy") },
  { id:"view.flip",      label:"Flip board view (front/back)",  def:"F",      btn:"#btn-flip",      run:()=>toggleFlip() },
  { id:"view.fit",       label:"Zoom to fit",                   def:"Z",      run:()=>zoomToFit() },
  { id:"edit.rotate",    label:"Rotate 90° (Shift = 15°)",      def:"R",      run:(e)=>rotateSelection(e && e.shiftKey ? 15 : 90) },
  { id:"edit.side",      label:"Flip component side",           def:"",       run:()=>flipSelectionSide() },
  { id:"edit.drawside",  label:"Cycle draw side (Shift = +swap image)", def:"D", run:(e)=>cycleDrawSide(e && e.shiftKey) },
  { id:"edit.net",       label:"Name net of selection",         def:"N",      run:()=>{ if (UI.sel && UI.sel.type!=="comp") promptNetName(UI.sel); } },
  { id:"edit.lock",      label:"Move-lock / unlock component",  def:"L",      run:()=>toggleLockSelection() },
  { id:"edit.padsize",   label:"Edit selected pad size/pos (drag)", def:"",   run:()=>{ if (UI.sel && UI.sel.type==="pin") enterPadEdit(UI.sel.comp, UI.sel.pinIdx); else UI.toast("Select a pad first"); } },
  { id:"edit.delete",    label:"Delete selection",              def:"Delete", run:()=>deleteSelection() },
  { id:"view.hidetraces",label:"Toggle hide traces",            def:"",       btn:"#tgl-hidetraces", run:()=>toggleHideTraces() },
  { id:"view.hidevias",  label:"Toggle hide vias",              def:"",       btn:"#tgl-hidevias",   run:()=>toggleHideVias() },
  { id:"view.hidelabels",label:"Toggle hide labels",            def:"",       btn:"#tgl-hidelabels", run:()=>toggleHideLabels() },
  { id:"view.xray",      label:"Toggle X-ray overlay",          def:"X",      btn:"#btn-xray",       run:()=>toggleXray() },
  { id:"view.split",     label:"Toggle split view",             def:"Y",      btn:"#btn-split",      run:()=>toggleSplit() },
  { id:"view.ratsnest",  label:"Cycle ratsnest mode",           def:"",       btn:"#btn-ratsnest",   run:clickBtn("#btn-ratsnest") },
  { id:"view.stack3d",   label:"3D layer stack",                def:"",       btn:"#btn-stack3d",    run:clickBtn("#btn-stack3d") },
  { id:"view.history",   label:"Undo timeline",                 def:"",       btn:"#btn-history",    run:clickBtn("#btn-history") },
  { id:"view.check",     label:"Netless-pad checker",           def:"",       btn:"#btn-check",      run:clickBtn("#btn-check") },
  { id:"view.options",   label:"Options dialog",                def:"",       btn:"#btn-options",    run:clickBtn("#btn-options") },
  { id:"view.keys",      label:"Hotkey editor",                 def:"",       btn:"#btn-keys",       run:clickBtn("#btn-keys") },
  { id:"view.lab",       label:"Experimental features (Lab)",   def:"",       btn:"#btn-lab",        run:clickBtn("#btn-lab") },
  { id:"view.help",      label:"Help",                          def:"",       btn:"#btn-help",       run:clickBtn("#btn-help") },
  // extra rebindable keys for Undo/Redo — the fixed Ctrl+Z / Ctrl+Y always work regardless
  { id:"edit.undo",      label:"Undo (extra key — Ctrl+Z is fixed)", def:"",  btn:"#btn-undo",       run:clickBtn("#btn-undo") },
  { id:"edit.redo",      label:"Redo (extra key — Ctrl+Y is fixed)", def:"",  btn:"#btn-redo",       run:clickBtn("#btn-redo") },
  { id:"file.new",       label:"New project",                   def:"",       btn:"#btn-new",        run:clickBtn("#btn-new") },
  { id:"file.open",      label:"Open project",                  def:"",       btn:"#btn-open",       run:clickBtn("#btn-open") },
  { id:"file.save",      label:"Save project",                  def:"",       btn:"#btn-save",       run:clickBtn("#btn-save") },
  { id:"file.export",    label:"Export",                        def:"",       btn:"#btn-export",     run:clickBtn("#btn-export") },
  { id:"layer.add",      label:"Add image layer",               def:"",       btn:"#btn-add-layer",  run:clickBtn("#btn-add-layer") },
  { id:"layer.addurl",   label:"Add image from URL",            def:"",       btn:"#btn-add-url",    run:clickBtn("#btn-add-url") },
  // editor tabs (schematic.js) + schematic-pane buttons
  { id:"view.tabvisual",    label:"Tab: Visual editor",         def:"",       btn:"#tab-visual",     run:clickBtn("#tab-visual") },
  { id:"view.tabschematic", label:"Tab: Schematic editor",      def:"",       btn:"#tab-schematic",  run:clickBtn("#tab-schematic") },
  { id:"view.tabbom",       label:"Tab: BOM editor",            def:"",       btn:"#tab-bom",        run:clickBtn("#tab-bom") },
  { id:"view.tabnets",      label:"Tab: Nets",                  def:"",       btn:"#tab-nets",       run:clickBtn("#tab-nets") },
  { id:"view.tabprojects",  label:"Tab: Projects",              def:"",       btn:"#tab-projects",   run:clickBtn("#tab-projects") },
  { id:"sch.arrange",    label:"Schematic: apply auto-arrangement", def:"",   btn:"#sch-arrange-go", run:clickBtn("#sch-arrange-go") },
  { id:"sch.fit",        label:"Schematic: zoom to fit",        def:"",       btn:"#sch-fit",        run:clickBtn("#sch-fit") },
  { id:"sch.wiretool",   label:"Schematic: wire tool (extra key — W is fixed)", def:"", btn:"#sch-wire", run:clickBtn("#sch-wire") },
  { id:"sch.export",     label:"Schematic: export dialog",      def:"",       btn:"#sch-export",     run:clickBtn("#sch-export") },
  // Quick-add popup (experimental) — used only while that dialog is open; defaults are a
  // bare-modifier tap / Enter so they don't clash with typing the part name in the field
  { id:"quickadd.rotcw", label:"Quick-add: rotate clockwise",     def:"Shift",   local:true, run:()=>{ if (QuickAdd.active) QuickAdd.rotate(90); } },
  { id:"quickadd.rotccw",label:"Quick-add: rotate counter-clockwise", def:"Control", local:true, run:()=>{ if (QuickAdd.active) QuickAdd.rotate(-90); } },
  { id:"quickadd.place", label:"Quick-add: place component",      def:"Enter",   local:true, run:()=>{ if (QuickAdd.active) QuickAdd.place(); } },
  // NB: Undo/Redo are intentionally NOT here — they're fixed to Ctrl+Z / Ctrl+Y in
  // wireKeyboard (main.js) and can't be rebound, so they don't belong in the hotkey editor.
];

const RESERVED_KEYS = ["Escape","Enter"," ","Spacebar","Tab","+","=","-","?"];

const Keymap = {
  map: {},   // actionId -> key

  load(){
    this.map = {};
    for (const a of KeyActions) this.map[a.id] = a.def;
    try {
      const saved = JSON.parse(localStorage.getItem("pcbreveng.keys") || "{}");
      // honour "" too, so a deliberately-cleared binding stays cleared after reload
      for (const a of KeyActions)
        if (typeof saved[a.id] === "string") this.map[a.id] = saved[a.id];
    } catch (e){ /* corrupt storage — keep defaults */ }
  },

  save(){
    try { localStorage.setItem("pcbreveng.keys", JSON.stringify(this.map)); } catch (e){}
  },

  reset(){
    for (const a of KeyActions) this.map[a.id] = a.def;
    this.save();
  },

  keyFor(id){ return this.map[id] || ""; },

  actionForKey(key){
    for (const a of KeyActions)
      if (this.map[a.id] === key) return a;
    return null;
  },

  /* returns the action id that previously owned the key, or null */
  bind(id, key){
    let displaced = null;
    for (const a of KeyActions)
      if (a.id !== id && this.map[a.id] === key){ displaced = a.id; this.map[a.id] = ""; }
    this.map[id] = key;
    this.save();
    return displaced;
  },
};

/* normalize a KeyboardEvent into a base (modifier-insensitive) binding key string */
function normKey(e){
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/* a modifier-aware key string: pure modifiers → "Shift"/"Control"/"Alt"; otherwise a
   prefix like "Ctrl+", "Alt+", "Shift+" ahead of the base key (e.g. "Shift+K"). Used so
   the hotkey editor can bind bare modifiers and combos in addition to plain keys. */
function comboKey(e){
  const base = normKey(e);
  if (["Shift","Control","Alt","Meta"].includes(base)) return base;
  let pre = "";
  if (e.ctrlKey || e.metaKey) pre += "Ctrl+";
  if (e.altKey) pre += "Alt+";
  if (e.shiftKey) pre += "Shift+";
  return pre + base;
}

/* is this binding string a bare modifier? (fired on tap, not as a global action) */
function isModifierKey(k){ return k === "Shift" || k === "Control" || k === "Alt"; }
