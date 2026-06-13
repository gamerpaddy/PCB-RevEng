/* ===== footprints/ics.js — integrated circuits ===== */
"use strict";

Footprints.register({
  id:"dip", name:"DIP", prefix:"U",
  params:[{key:"pins",label:"Pins",type:"int",def:8,min:4,max:64,step:2},
          {key:"width",label:"Row width",type:"select",def:"7.62",options:["7.62","10.16","15.24"]}],
  gen(p){
    const n=p.pins, half=n/2, w=parseFloat(p.width), pins=[];
    for (let i=0;i<half;i++){
      const x=(i-(half-1)/2)*2.54;
      pins.push(_pin(i+1, x, w/2, {shape:"circle",w:1.4,h:1.4}));   // bottom row L→R
      pins.push(_pin(n-i, x, -w/2,{shape:"circle",w:1.4,h:1.4}));   // top row R→L
    }
    return { label:"DIP-"+n, pins, body:{w:half*2.54, h:w-1.5},
      kicad:"Package_DIP:DIP-"+n+"_W"+w.toFixed(2)+"mm" };
  }
});

Footprints.register({
  id:"soic", name:"SOIC / SOP / TSSOP / MSOP", prefix:"U",
  params:[{key:"pins",label:"Pins",type:"int",def:8,min:4,max:56,step:2},
          {key:"pitch",label:"Pitch mm",type:"select",def:"1.27",options:["0.5","0.65","0.8","1.27"]},
          {key:"width",label:"Row width",type:"select",def:"6.0",options:["3.0","4.4","6.0","7.5","10.3"]}],
  gen(p){
    const n=p.pins, half=n/2, pt=parseFloat(p.pitch), w=parseFloat(p.width), pins=[];
    for (let i=0;i<half;i++){
      const x=(i-(half-1)/2)*pt;
      pins.push(_pin(i+1, x, w/2, {w:pt*0.55,h:1.5}));
      pins.push(_pin(n-i, x, -w/2,{w:pt*0.55,h:1.5}));
    }
    let fam = "SOIC-"+n, kicad = "Package_SO:SOIC-"+n+"_3.9x4.9mm_P1.27mm";
    if (pt !== 1.27){
      fam = (w <= 3.0 ? "MSOP-" : "TSSOP-") + n;
      kicad = (w <= 3.0 ? "Package_SO:MSOP-"+n+"_3x3mm_P"+p.pitch+"mm"
                        : "Package_SO:TSSOP-"+n+"_4.4x5mm_P"+p.pitch+"mm");
    }
    return { label:fam+" P"+p.pitch, pins, body:{w:half*pt+0.5, h:w-2}, kicad };
  }
});

Footprints.register({
  id:"qfp", name:"QFP / QFN / LQFP", prefix:"U",
  params:[{key:"pins",label:"Pins",type:"int",def:32,min:8,max:208,step:4},
          {key:"pitch",label:"Pitch mm",type:"select",def:"0.8",options:["0.4","0.5","0.65","0.8","1.0"]},
          {key:"style",label:"Style",type:"select",def:"QFP",options:["QFP","QFN"]}],
  gen(p){
    const n=p.pins, side=n/4, pt=parseFloat(p.pitch), pins=[];
    const ext = (side-1)*pt/2, off = ext + pt*1.6;
    let num=1;
    for (let i=0;i<side;i++) pins.push(_pin(num++,-off,-ext+i*pt,{w:1.4,h:pt*0.55})); // left, top→bottom
    for (let i=0;i<side;i++) pins.push(_pin(num++,-ext+i*pt, off,{w:pt*0.55,h:1.4})); // bottom, L→R
    for (let i=0;i<side;i++) pins.push(_pin(num++, off, ext-i*pt,{w:1.4,h:pt*0.55})); // right, bottom→top
    for (let i=0;i<side;i++) pins.push(_pin(num++, ext-i*pt,-off,{w:pt*0.55,h:1.4})); // top, R→L
    const bw = ext*2 + pt;
    return { label:p.style+"-"+n+" P"+p.pitch, pins, body:{w:bw,h:bw},
      kicad: p.style==="QFP" ? "Package_QFP:LQFP-"+n+"_7x7mm_P"+p.pitch+"mm" : "Package_DFN_QFN:QFN-"+n+"_P"+p.pitch+"mm" };
  }
});

Footprints.register({
  id:"grid", name:"Grid / BGA / custom matrix", prefix:"U",
  params:[{key:"rows",label:"Rows",type:"int",def:4,min:1,max:40,step:1},
          {key:"cols",label:"Cols",type:"int",def:4,min:1,max:40,step:1},
          {key:"pitch",label:"Pitch mm",type:"select",def:"2.54",options:["0.5","0.8","1.0","1.27","2.0","2.54"]}],
  gen(p){
    const pt=parseFloat(p.pitch), pins=[];
    const letters="ABCDEFGHJKLMNPRTUVWY"; // BGA letters (no I,O,Q,S,X,Z)
    for (let r=0;r<p.rows;r++)
      for (let c=0;c<p.cols;c++){
        const name = (letters[r]||("R"+r)) + (c+1);
        pins.push(_pin(name,(c-(p.cols-1)/2)*pt,(r-(p.rows-1)/2)*pt,{shape:"circle",w:pt*0.5,h:pt*0.5}));
      }
    return { label:"Grid "+p.rows+"×"+p.cols, pins, body:{w:p.cols*pt,h:p.rows*pt}, kicad:"" };
  }
});
