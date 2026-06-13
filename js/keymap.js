/* ===== keymap.js — rebindable hotkeys, persisted in localStorage ===== */
"use strict";

const KeyActions = [
  { id:"tool.select",    label:"Select / move tool",            def:"S",      run:()=>setTool("select") },
  { id:"tool.component", label:"Place component tool",          def:"C",      run:()=>{ Tools.pending=null; setTool("component"); } },
  { id:"tool.trace",     label:"Trace tool",                    def:"W",      run:()=>setTool("trace") },
  { id:"tool.via",       label:"Via tool",                      def:"V",      run:()=>setTool("via") },
  { id:"tool.cut",       label:"Cut trace tool",                def:"K",      run:()=>setTool("cut") },
  { id:"tool.align",     label:"Align image layer tool",        def:"G",      run:()=>setTool("align") },
  { id:"tool.measure",   label:"Measure tool",                  def:"M",      run:()=>setTool("measure") },
  { id:"view.flip",      label:"Flip board view (front/back)",  def:"F",      run:()=>toggleFlip() },
  { id:"view.fit",       label:"Zoom to fit",                   def:"Z",      run:()=>zoomToFit() },
  { id:"edit.rotate",    label:"Rotate 90° (Shift = 15°)",      def:"R",      run:(e)=>rotateSelection(e && e.shiftKey ? 15 : 90) },
  { id:"edit.side",      label:"Flip component side",           def:"B",      run:()=>flipSelectionSide() },
  { id:"edit.drawside",  label:"Cycle active draw side",        def:"D",      run:()=>cycleDrawSide() },
  { id:"edit.net",       label:"Name net of selection",         def:"N",      run:()=>{ if (UI.sel && UI.sel.type!=="comp") promptNetName(UI.sel); } },
  { id:"edit.lock",      label:"Move-lock / unlock component",  def:"L",      run:()=>toggleLockSelection() },
  { id:"edit.delete",    label:"Delete selection",              def:"Delete", run:()=>deleteSelection() },
  { id:"view.mask",      label:"Toggle coverage mask",          def:"H",      run:()=>toggleMask() },
];

const RESERVED_KEYS = ["Escape","Enter"," ","Spacebar","Tab","+","=","-","?"];

const Keymap = {
  map: {},   // actionId -> key

  load(){
    this.map = {};
    for (const a of KeyActions) this.map[a.id] = a.def;
    try {
      const saved = JSON.parse(localStorage.getItem("pcbreveng.keys") || "{}");
      for (const a of KeyActions)
        if (typeof saved[a.id] === "string" && saved[a.id]) this.map[a.id] = saved[a.id];
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
