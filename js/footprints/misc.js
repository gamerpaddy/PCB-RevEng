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
      return { label:"HC-49 SMD", pins:[_pin(1,-4.8,0,{w:2.6,h:3.6}),_pin(2,4.8,0,{w:2.6,h:3.6})],
        body:{w:11.4,h:4.7}, kicad:"Crystal:Crystal_SMD_HC49-SD" };
    const d = p.pkg === "3225 SMD" ? [3.2,2.5] : [5.0,3.2];
    const px = d[0]/2 - 0.5;
    return { label:p.pkg, pins:[_pin(1,-px,d[1]/2-0.5,{w:1.2,h:1.0}),_pin(2,px,d[1]/2-0.5,{w:1.2,h:1.0}),
                                _pin(3,px,-d[1]/2+0.5,{w:1.2,h:1.0}),_pin(4,-px,-d[1]/2+0.5,{w:1.2,h:1.0})],
      body:{w:d[0],h:d[1]}, kicad:"Crystal:Crystal_SMD_"+(p.pkg==="3225 SMD"?"3225-4Pin_3.2x2.5mm":"5032-4Pin_5.0x3.2mm") };
  }
});

Footprints.register({
  id:"free", name:"Freestyle / custom", prefix:"U",
  params:[{key:"w",label:"Body W mm",type:"int",def:10,min:1,max:200,step:1},
          {key:"h",label:"Body H mm",type:"int",def:10,min:1,max:200,step:1}],
  gen(p){
    const pins = (p.pinList || []).map(pl => _pin(pl.num, pl.x, pl.y, {shape:"circle", w:1.6, h:1.6}));
    return { label:"Free-"+pins.length, pins, body:{w:p.w, h:p.h}, kicad:"" };
  }
});

Footprints.register({
  id:"pad1", name:"Single pad / test point", prefix:"TP",
  params:[{key:"dia",label:"Pad mm",type:"select",def:"1.5",options:["1.0","1.5","2.0","3.0"]}],
  gen(p){
    const d = parseFloat(p.dia);
    return { label:"Test point D"+p.dia,
      pins:[_pin(1,0,0,{shape:"circle",w:d,h:d})], body:{w:d*1.3,h:d*1.3,shape:"circle"},
      kicad:"TestPoint:TestPoint_Pad_D"+d.toFixed(1)+"mm" };
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
