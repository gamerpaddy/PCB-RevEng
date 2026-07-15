/* ===== footprints/discrete.js — transistors, diodes, regulators ===== */
"use strict";

Footprints.register({
  id:"sot23", name:"SOT-23 / 323 / 523", prefix:"Q",
  params:[{key:"pkg",label:"Package",type:"select",def:"SOT-23",options:["SOT-23","SOT-323","SOT-523","SOT-723"]},
          {key:"pins",label:"Pins",type:"select",def:"3",options:["3","5","6"]}],
  gen(p){
    const k = { "SOT-23":1, "SOT-323":0.68, "SOT-523":0.5, "SOT-723":0.42 }[p.pkg];
    const n = parseInt(p.pins,10), pins=[];
    const px = 0.95*k, py = 1.15*k;
    const pad = { w:0.55*k, h:0.8*k };
    if (n===3){
      pins.push(_pin(1,-px,py,{...pad}),_pin(2,px,py,{...pad}),_pin(3,0,-py,{...pad}));
    } else {
      const top = n===5 ? 2 : 3;
      for (let i=0;i<3;i++) pins.push(_pin(i+1,(i-1)*px,py,{...pad}));
      for (let i=0;i<top;i++) pins.push(_pin(3+i+1,(top===2 ? (i ? -px : px) : (1-i)*px), -py,{...pad}));
    }
    const kicadName = { "SOT-23":"SOT-23", "SOT-323":"SOT-323_SC-70", "SOT-523":"SOT-523", "SOT-723":"SOT-723" }[p.pkg];
    return { label:p.pkg+(n>3?"-"+n:""), pins, body:{w:3.0*k,h:1.6*k},
      kicad:"Package_TO_SOT_SMD:" + (n===3 ? kicadName : "SOT-23-"+n) };
  }
});

Footprints.register({
  id:"sot223", name:"SOT-223 / SOT-89 / DPAK", prefix:"Q",
  params:[{key:"pkg",label:"Package",type:"select",def:"SOT-223",options:["SOT-223","SOT-89","DPAK (TO-252)"]}],
  gen(p){
    const pins=[];
    if (p.pkg==="SOT-223"){
      pins.push(_pin(1,-2.3,3.25,{w:1.2,h:2}),_pin(2,0,3.25,{w:1.2,h:2}),_pin(3,2.3,3.25,{w:1.2,h:2}),
                _pin(4,0,-3.25,{w:3.6,h:2,name:"TAB"}));
      return { label:"SOT-223", pins, body:{w:6.5,h:3.5}, kicad:"Package_TO_SOT_SMD:SOT-223-3_TabPin2" };
    }
    if (p.pkg==="SOT-89"){
      pins.push(_pin(1,-1.5,2.0,{w:0.9,h:1.2}),_pin(2,0,2.0,{w:0.9,h:1.2}),_pin(3,1.5,2.0,{w:0.9,h:1.2}),
                _pin(4,0,-1.8,{w:2.0,h:1.6,name:"TAB"}));
      return { label:"SOT-89", pins, body:{w:4.5,h:2.5}, kicad:"Package_TO_SOT_SMD:SOT-89-3" };
    }
    pins.push(_pin(1,-2.28,4.4,{w:1.4,h:2.2}),_pin(2,2.28,4.4,{w:1.4,h:2.2}),
              _pin(3,0,-3.5,{w:5.6,h:4.6,name:"TAB"}));
    return { label:"DPAK", pins, body:{w:6.6,h:6.1}, kicad:"Package_TO_SOT_SMD:TO-252-2" };
  }
});

Footprints.register({
  id:"sod", name:"SOD / SMA-SMC diode", prefix:"D",
  params:[{key:"pkg",label:"Package",type:"select",def:"SOD-123",options:["SOD-523","SOD-323","SOD-123","SOD-80","SMA","SMB","SMC"]}],
  gen(p){
    const dims = { // [bodyL, bodyW, padW, padH, pitchCenter]
      "SOD-523":[1.2,0.8,0.5,0.7,1.6], "SOD-323":[1.7,1.25,0.6,0.9,2.2],
      "SOD-123":[2.7,1.6,0.9,1.2,3.6], "SOD-80":[3.5,1.5,0.9,1.2,4.2],
      "SMA":[4.3,2.6,1.5,1.8,5.2], "SMB":[4.3,3.6,1.6,2.2,5.4], "SMC":[6.0,4.5,1.8,2.6,7.6] };
    const [L,W,pw,ph,pc] = dims[p.pkg];
    return {
      label:p.pkg,
      pins:[_pin(1,-pc/2,0,{w:pw,h:ph,name:"K"}), _pin(2,pc/2,0,{w:pw,h:ph,name:"A"})],
      body:{w:L,h:W},
      symbol:"diode",
      kicad:"Diode_SMD:D_"+p.pkg
    };
  }
});

Footprints.register({
  id:"to92", name:"TO-92", prefix:"Q",
  params:[{key:"layout",label:"Lead form",type:"select",def:"Inline",options:["Inline","Triangle"]}],
  gen(p){
    const tri = p.layout === "Triangle";
    const pins = tri
      ? [_pin(1,-1.27,0.6,{shape:"circle",w:1.2,h:1.2}),_pin(2,0,-0.6,{shape:"circle",w:1.2,h:1.2}),_pin(3,1.27,0.6,{shape:"circle",w:1.2,h:1.2})]
      : [_pin(1,-1.27,0,{shape:"circle",w:1.2,h:1.2}),_pin(2,0,0,{shape:"circle",w:1.2,h:1.2}),_pin(3,1.27,0,{shape:"circle",w:1.2,h:1.2})];
    return { label:"TO-92 "+p.layout, pins, body:{w:5,h:4.5},
      kicad:"Package_TO_SOT_THT:TO-92_"+(tri?"Wide":"Inline") };
  }
});

Footprints.register({
  id:"to3", name:"TO-3 (metal can)", prefix:"Q",
  params:[{key:"case",label:"Case pads",type:"select",def:"yes",options:["yes","no"]}],
  gen(p){
    // JEDEC TO-204AA (classic 2N3055 can), dimensions from the KiCad TO-3 footprint:
    // two leads 10.92 mm apart, offset 1.8 mm from the mounting-hole axis; mounting
    // holes 30.2 mm apart (Ø4 drill, Ø6.35 pad). The CASE is the collector, contacted
    // through the mounting holes — so they're pads (named C), not just holes.
    // Package centre = midpoint between the mounting holes; leads sit to its left.
    const pins = [
      _pin(1,-1.8,-5.46,{shape:"circle",w:2.6,h:2.6,name:"B"}),
      _pin(2,-1.8, 5.46,{shape:"circle",w:2.6,h:2.6,name:"E"}),
    ];
    if (p.case !== "no"){
      pins.push(_pin(3,-15.1,0,{shape:"circle",w:6.35,h:6.35,name:"C"}),
                _pin(4, 15.1,0,{shape:"circle",w:6.35,h:6.35,name:"C"}));
    }
    return { label:"TO-3", pins, body:{w:39.4,h:26.7},
      kicad:"Package_TO_SOT_THT:TO-3" };
  }
});

Footprints.register({
  id:"to220", name:"TO-220 / 247 / 3P / 264 / 126", prefix:"Q",
  params:[{key:"pkg",label:"Package",type:"select",def:"TO-220",
           options:["TO-220","TO-247","TO-3P","TO-264","TO-126"]},
          {key:"pins",label:"Pins",type:"select",def:"3",options:["2","3","5"]},
          {key:"pitch",label:"Pitch",type:"select",def:"auto",options:["auto","1.7","2.54","5.08","5.45"]}],
  gen(p){
    // [body W, body H, lead Ø, default pitch] mm per package family
    const dims = {
      "TO-220":[10.2,4.6,1.6,2.54], "TO-126":[8.0,3.2,1.4,2.54],
      "TO-247":[15.9,5.2,2.0,5.45], "TO-3P":[15.5,5.0,2.0,5.45], "TO-264":[20.0,5.6,2.0,5.45] };
    const [bw,bh,lead,defPitch] = dims[p.pkg] || dims["TO-220"];
    const n = parseInt(p.pins,10);
    const pitch = p.pitch === "auto" ? defPitch : parseFloat(p.pitch);
    const pins = [];
    for (let i=0;i<n;i++) pins.push(_pin(i+1,(i-(n-1)/2)*pitch,0,{shape:"circle",w:lead,h:lead}));
    return { label:p.pkg+"-"+n, pins, body:{w:Math.max(bw,n*pitch+3),h:bh},
      kicad:"Package_TO_SOT_THT:"+p.pkg+"-"+n+"_Vertical" };
  }
});
