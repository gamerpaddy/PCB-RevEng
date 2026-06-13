/* ===== footprints/connectors.js — headers, terminals ===== */
"use strict";

Footprints.register({
  id:"sip", name:"SIP / pin header 1×N", prefix:"J",
  params:[{key:"pins",label:"Pins",type:"int",def:4,min:1,max:40,step:1},
          {key:"pitch",label:"Pitch mm",type:"select",def:"2.54",options:["1.27","2.0","2.54","3.96","5.0"]}],
  gen(p){
    const n=p.pins, pt=parseFloat(p.pitch), pins=[];
    for (let i=0;i<n;i++) pins.push(_pin(i+1,(i-(n-1)/2)*pt,0,{shape:"circle",w:pt*0.55,h:pt*0.55}));
    return { label:"1×"+n+" P"+p.pitch, pins, body:{w:n*pt,h:pt},
      kicad:"Connector_PinHeader_"+p.pitch+"mm:PinHeader_1x"+String(n).padStart(2,"0")+"_P"+p.pitch+"mm_Vertical" };
  }
});

Footprints.register({
  id:"header2", name:"Pin header 2×N (IDC)", prefix:"J",
  params:[{key:"pins",label:"Total pins",type:"int",def:10,min:2,max:80,step:2},
          {key:"pitch",label:"Pitch mm",type:"select",def:"2.54",options:["1.27","2.0","2.54"]},
          {key:"numbering",label:"Numbering",type:"select",def:"Odd/Even (1-2)",
           options:["Odd/Even (1-2)","Sequential rows (1..N)"]}],
  gen(p){
    const n=p.pins, cols=n/2, pt=parseFloat(p.pitch), pins=[];
    const seq = p.numbering && p.numbering.indexOf("Sequential") === 0;
    for (let c=0;c<cols;c++){
      const x=(c-(cols-1)/2)*pt;
      // Odd/Even (box-header standard): col c → top=2c+1 (odd), bottom=2c+2 (even)
      // Sequential rows: top row = 1..cols, bottom row = cols+1..2cols
      const top    = seq ? c+1        : c*2+1;
      const bottom = seq ? cols+c+1   : c*2+2;
      pins.push(_pin(top,    x,  pt/2, {shape:"circle",w:pt*0.5,h:pt*0.5, row:0, col:c}));
      pins.push(_pin(bottom, x, -pt/2, {shape:"circle",w:pt*0.5,h:pt*0.5, row:1, col:c}));
    }
    const kn = seq ? "Top_Bottom" : "Odd_Even";
    return { label:"2×"+cols+" P"+p.pitch+(seq?" seq":""), pins, body:{w:cols*pt,h:pt*2},
      kicad:"Connector_Generic:Conn_02x"+String(cols).padStart(2,"0")+"_"+kn };
  }
});

Footprints.register({
  id:"screw", name:"Screw terminal block", prefix:"J",
  params:[{key:"pins",label:"Ways",type:"int",def:2,min:2,max:24,step:1},
          {key:"pitch",label:"Pitch mm",type:"select",def:"5.0",options:["2.54","3.5","3.81","5.0","5.08","7.5"]}],
  gen(p){
    const n=p.pins, pt=parseFloat(p.pitch), pins=[];
    for (let i=0;i<n;i++) pins.push(_pin(i+1,(i-(n-1)/2)*pt,0,{shape:"circle",w:pt*0.45,h:pt*0.45}));
    return { label:"Terminal ×"+n+" P"+p.pitch, pins, body:{w:n*pt, h:pt*1.6},
      kicad:"TerminalBlock:TerminalBlock_bornier-"+n+"_P"+p.pitch+"mm" };
  }
});

Footprints.register({
  id:"jstxh", name:"JST-XH / Molex 1×N", prefix:"J",
  params:[{key:"pins",label:"Pins",type:"int",def:3,min:2,max:16,step:1},
          {key:"pitch",label:"Pitch mm",type:"select",def:"2.5",options:["1.25","1.5","2.0","2.5"]}],
  gen(p){
    const n=p.pins, pt=parseFloat(p.pitch), pins=[];
    for (let i=0;i<n;i++) pins.push(_pin(i+1,(i-(n-1)/2)*pt,0,{shape:"circle",w:pt*0.5,h:pt*0.5}));
    return { label:"JST ×"+n+" P"+p.pitch, pins, body:{w:n*pt+1, h:pt*2.4},
      kicad:"Connector_JST:JST_XH_B"+n+"B-XH-A_1x"+String(n).padStart(2,"0")+"_P2.50mm_Vertical" };
  }
});
