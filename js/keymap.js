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
  { id:"tool.via",       label:"Via tool",                      def:"V",      btn:"#toolbar .tool[data-tool='via']",       run:()=>setTool("via") },
  { id:"tool.cut",       label:"Cut trace tool",                def:"K",      btn:"#toolbar .tool[data-tool='cut']",       run:()=>setTool("cut") },
  { id:"tool.note",      label:"Sticky-note tool",              def:"",       btn:"#toolbar .tool[data-tool='note']",      run:()=>setTool("note") },
  { id:"tool.align",     label:"Align image layer tool",        def:"G",      run:()=>setTool("align") },
  { id:"tool.measure",   label:"Measure tool",                  def:"M",      btn:"#btn-measure",   run:()=>setTool("measure") },
  { id:"tool.calibrate", label:"Calibrate scale tool",          def:"",       btn:"#btn-calibrate", run:clickBtn("#btn-calibrate") },
  { id:"tool.deskew",    label:"Deskew layer",                  def:"",       btn:"#btn-deskew",    run:clickBtn("#btn-deskew") },
  { id:"view.flip",      label:"Flip board view (front/back)",  def:"F",      btn:"#btn-flip",      run:()=>toggleFlip() },
  { id:"view.fit",       label:"Zoom to fit",                   def:"Z",      run:()=>zoomToFit() },
  { id:"edit.rotate",    label:"Rotate 90° (Shift = 15°)",      def:"R",      run:(e)=>rotateSelection(e && e.shiftKey ? 15 : 90) },
  { id:"edit.side",      label:"Flip component side",           def:"B",      run:()=>flipSelectionSide() },
  { id:"edit.drawside",  label:"Cycle draw side (Shift = +swap image)", def:"D", run:(e)=>cycleDrawSide(e && e.shiftKey) },
  { id:"edit.net",       label:"Name net of selection",         def:"N",      run:()=>{ if (UI.sel && UI.sel.type!=="comp") promptNetName(UI.sel); } },
  { id:"edit.lock",      label:"Move-lock / unlock component",  def:"L",      run:()=>toggleLockSelection() },
  { id:"edit.delete",    label:"Delete selection",              def:"Delete", run:()=>deleteSelection() },
  { id:"view.mask",      label:"Toggle coverage mask",          def:"H",      btn:"#btn-mask",       run:()=>toggleMask() },
  { id:"view.hidetraces",label:"Toggle hide traces",            def:"",       btn:"#btn-hidetraces", run:clickBtn("#btn-hidetraces") },
  { id:"view.xray",      label:"Toggle X-ray overlay",          def:"X",      btn:"#btn-xray",       run:()=>toggleXray() },
  { id:"view.split",     label:"Toggle split view",             def:"Y",      btn:"#btn-split",      run:()=>toggleSplit() },
  { id:"view.ratsnest",  label:"Cycle ratsnest mode",           def:"",       btn:"#btn-ratsnest",   run:clickBtn("#btn-ratsnest") },
  { id:"view.stack3d",   label:"3D layer stack",                def:"",       btn:"#btn-stack3d",    run:clickBtn("#btn-stack3d") },
  { id:"view.history",   label:"Undo timeline",                 def:"",       btn:"#btn-history",    run:clickBtn("#btn-history") },
  { id:"view.check",     label:"Netless-pad checker",           def:"",       btn:"#btn-check",      run:clickBtn("#btn-check") },
  { id:"view.options",   label:"Options dialog",                def:"",       btn:"#btn-options",    run:clickBtn("#btn-options") },
  { id:"view.keys",      label:"Hotkey editor",                 def:"",       btn:"#btn-keys",       run:clickBtn("#btn-keys") },
  { id:"view.help",      label:"Help",                          def:"",       btn:"#btn-help",       run:clickBtn("#btn-help") },
  { id:"file.new",       label:"New project",                   def:"",       btn:"#btn-new",        run:clickBtn("#btn-new") },
  { id:"file.open",      label:"Open project",                  def:"",       btn:"#btn-open",       run:clickBtn("#btn-open") },
  { id:"file.save",      label:"Save project",                  def:"",       btn:"#btn-save",       run:clickBtn("#btn-save") },
  { id:"file.export",    label:"Export",                        def:"",       btn:"#btn-export",     run:clickBtn("#btn-export") },
  { id:"file.bom",       label:"BOM editor",                    def:"",       btn:"#btn-bom",        run:clickBtn("#btn-bom") },
  { id:"layer.add",      label:"Add image layer",               def:"",       btn:"#btn-add-layer",  run:clickBtn("#btn-add-layer") },
  { id:"layer.addurl",   label:"Add image from URL",            def:"",       btn:"#btn-add-url",    run:clickBtn("#btn-add-url") },
  { id:"edit.undo",      label:"Undo (button)",                 def:"",       btn:"#btn-undo",       run:clickBtn("#btn-undo") },
  { id:"edit.redo",      label:"Redo (button)",                 def:"",       btn:"#btn-redo",       run:clickBtn("#btn-redo") },
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

/* normalize a KeyboardEvent into a binding key string */
function normKey(e){
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}
