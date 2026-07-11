/* ===== footprints/misc.js — crystals, freestyle, test points, mounting ===== */
"use strict";

Footprints.register({
  id:"crystal", name:"Crystal / resonator", prefix:"Y",
  params:[{key:"pkg",label:"Package",type:"select",def:"HC-49",options:["HC-49","3225 SMD","5032 SMD","2-pin THT"]}],
  gen(p){
    if (p.pkg === "2-pin THT")
      return { label:"Crystal THT", pins:[_pin(1,-2.45,0,{shape:"circle",w:1.4,h:1.4}),_pin(2,2.45,0,{shape:"circle",w:1.4,h:1.4})],
        body:{w:11,h:4.5}, kicad:"Crystal:Crystal_HC49-U_Vertical" };
    if (p.pkg === "HC-49")
      return { label:"HC-49 SMD", pins:[_pin(1,-4.8,0,{w:2.6,h:2.2}),_pin(2,4.8,0,{w:2.6,h:2.2})],
        body:{w:11.4,h:4.7}, kicad:"Crystal:Crystal_SMD_HC49-SD" };
    const d = p.pkg === "3225 SMD" ? [3.2,2.5] : [5.0,3.2];
    const px = d[0]/2 - 0.5;
    return { label:p.pkg, pins:[_pin(1,-px,d[1]/2-0.5,{w:1.2,h:1.0}),_pin(2,px,d[1]/2-0.5,{w:1.2,h:1.0}),
                                _pin(3,px,-d[1]/2+0.5,{w:1.2,h:1.0}),_pin(4,-px,-d[1]/2+0.5,{w:1.2,h:1.0})],
      body:{w:d[0],h:d[1]}, kicad:"Crystal:Crystal_SMD_"+(p.pkg==="3225 SMD"?"3225-4Pin_3.2x2.5mm":"5032-4Pin_5.0x3.2mm") };
  }
});

Footprints.register({
  id:"free", name:"Freestyle", prefix:"U",   // imported footprints live in "Custom (imported)"
  // "num" (not int) so fractional bodies work — quick-add "free 4.5x5" etc.
  params:[{key:"w",label:"Body W mm",type:"num",def:10,min:1,max:200,step:0.5},
          {key:"h",label:"Body H mm",type:"num",def:10,min:1,max:200,step:0.5}],
  gen(p){
    const pins = (p.pinList || []).map(pl => {
      const shape = pl.shape || "circle";          // "circle" = round pad, "rect" = SMD rectangle
      const sz = pl.size || (shape==="circle" ? 1.6 : 1.2);
      // pl.w/pl.h give a non-square pad (e.g. imported SMD/QFP pads); fall back to size
      const w = pl.w || sz, h = pl.h || sz;
      // tht:false marks a round pad with no drill (e.g. an imported BGA ball); a round pad
      // defaults to through-hole (with a drill), which is what a hand-placed round pad means
      return _pin(pl.num, pl.x, pl.y, { shape, w, h, tht: pl.tht });
    });
    return { label:"Free-"+pins.length, pins,
      body:{w:parseFloat(p.w)||10, h:parseFloat(p.h)||10}, kicad:"" };
  }
});

Footprints.register({
  id:"pad1", name:"Single pad / test point", prefix:"TP",
  // free-entry diameters (like a via's size) rather than a fixed size list. SMD by default
  // (one-sided land, no drill); tick Through-hole to add a drilled, all-layers pad.
  params:[{key:"tht",label:"Through-hole",type:"bool",def:false,rebuilds:true},
          {key:"dia",label:"Pad Ø mm",type:"num",def:1.5,min:0.3,max:30,step:0.1},
          {key:"hole",label:"Hole Ø mm",type:"num",def:0.8,min:0.1,max:30,step:0.1,
           showIf:p=>!!p.tht}],
  gen(p){
    const d = parseFloat(p.dia) || 1.5;
    const tht = !!p.tht;
    const opts = { shape:"circle", w:d, h:d, tht };
    if (tht){
      let hole = parseFloat(p.hole); if (!isFinite(hole) || hole <= 0) hole = Math.min(0.8, d);
      if (hole > d) hole = d;                 // a drill can never be wider than its pad
      opts.hole = hole;
    }
    return { label: tht ? "THT pad D"+d.toFixed(1) : "Test point D"+d.toFixed(1),
      pins:[_pin(1,0,0,opts)], body:{w:d*1.3,h:d*1.3,shape:"circle"},
      kicad: tht ? "TestPoint:TestPoint_THTPad_D"+d.toFixed(1)+"mm"
                 : "TestPoint:TestPoint_Pad_D"+d.toFixed(1)+"mm" };
  }
});

Footprints.register({
  id:"mount", name:"Mounting hole", prefix:"H",
  params:[{key:"size",label:"Screw",type:"select",def:"M3",options:["M2","M2.5","M3","M4","M5"]},
          {key:"plated",label:"Plated",type:"select",def:"Yes",options:["Yes","No"]}],
  gen(p){
    const dia = { "M2":2.2, "M2.5":2.7, "M3":3.2, "M4":4.3, "M5":5.3 }[p.size];
    const pad = dia + 2;
    return { label:"Mount "+p.size+(p.plated==="Yes"?" (PTH)":""),
      pins:[_pin(1,0,0,{shape:"circle",w:pad,h:pad,name:p.plated==="Yes"?"":"NPTH"})],
      body:{w:pad*1.2,h:pad*1.2,shape:"circle"},
      kicad:"MountingHole:MountingHole_"+dia.toFixed(1)+"mm_"+p.size+(p.plated==="Yes"?"_Pad":"") };
  }
});
