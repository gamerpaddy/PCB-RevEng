/* ===== footprints/passives.js — resistors, capacitors, inductors ===== */
"use strict";

Footprints.register({
  id:"chip2", name:"R / C / L chip (SMD)", prefix:"R",
  params:[{key:"size",label:"Size",type:"select",def:"0805",
           options:["0201","0402","0603","0805","1206","1210","2010","2512",
                    "Tant 2012-12","Tant 3216-18","Tant 3528-15",
                    "Tant 6032-28","Tant 7343-31","Tant 7343-43"]},
          {key:"polarized",label:"Polarized (tantalum)",type:"bool",def:false}],
  gen(p){
    // Tantalum SMD cap (EIA metric case code, e.g. 3216-18 = 3.2×1.6mm, 1.8mm tall).
    // Always polarized: pin 1 = + (anode), wide gull-wing terminations at each end.
    if (p.size && p.size.startsWith("Tant ")){
      const code = p.size.slice(5);
      const tdims = { // [body length, body width] mm — the 4-digit part of the code
        "2012-12":[2.0,1.25], "3216-18":[3.2,1.6], "3528-15":[3.5,2.8],
        "6032-28":[6.0,3.2],  "7343-31":[7.3,4.3], "7343-43":[7.3,4.3] };
      const kem = { "3216-18":"_Kemet-A", "6032-28":"_Kemet-C",
                    "7343-31":"_Kemet-D", "7343-43":"_Kemet-X" };
      const [L,W] = tdims[code] || [3.2,1.6];
      const px = L*0.42, pw = L*0.375, ph = W*0.75;   // pad centre / radial length / tangential width
      return {
        label:"Tantalum "+code,
        pins:[_pin(1,-px,0,{w:pw,h:ph,name:"+"}), _pin(2,px,0,{w:pw,h:ph,name:"-"})],
        body:{w:L, h:W},
        polar:true,
        kicad:"Capacitor_Tantalum_SMD:CP_EIA-"+code+(kem[code]||"")
      };
    }
    const dims = {  // [length, width] mm
      "0201":[0.6,0.3],"0402":[1.0,0.5],"0603":[1.6,0.8],"0805":[2.0,1.25],
      "1206":[3.2,1.6],"1210":[3.2,2.5],"2010":[5.0,2.5],"2512":[6.3,3.2] };
    const [L,W] = dims[p.size];
    const px = L/2 + W*0.35;
    const code = {"0201":"0603","0402":"1005","0603":"1608","0805":"2012","1206":"3216","1210":"3225","2010":"5025","2512":"6332"}[p.size];
    return {
      label:"Chip "+p.size,
      pins:[_pin(1,-px,0,{w:W*0.9,h:W*1.1,name:p.polarized?"+":""}), _pin(2,px,0,{w:W*0.9,h:W*1.1,name:p.polarized?"-":""})],
      body:{w:L, h:W},
      polar:!!p.polarized,
      kicad:"Resistor_SMD:R_"+p.size+"_"+code+"Metric"
    };
  }
});

Footprints.register({
  id:"melf", name:"MELF (SMD axial)", prefix:"R",
  params:[{key:"size",label:"Size",type:"select",def:"0204",options:["0102","0204","0207"]}],
  gen(p){
    const dims = { "0102":[3.6,1.4], "0204":[5.8,2.2], "0207":[9.0,3.6] };
    const [L,W] = dims[p.size];
    const px = L/2 - W*0.2;
    return {
      label:"MELF "+p.size,
      pins:[_pin(1,-px,0,{w:W*0.7,h:W*1.1}), _pin(2,px,0,{w:W*0.7,h:W*1.1})],
      body:{w:L*0.7, h:W},
      kicad:"Resistor_SMD:R_MELF_MMB"+p.size
    };
  }
});

Footprints.register({
  id:"axial", name:"Axial THT (R / D / film)", prefix:"R",
  params:[{key:"span",label:"Pitch mm",type:"int",def:10,min:5,max:30,step:1}],
  gen(p){
    return {
      label:"Axial "+p.span+"mm",
      pins:[_pin(1,-p.span/2,0,{shape:"circle",w:1.6,h:1.6}), _pin(2,p.span/2,0,{shape:"circle",w:1.6,h:1.6})],
      body:{w:p.span*0.6, h:2.5},
      kicad:"Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P"+p.span.toFixed(2)+"mm_Horizontal"
    };
  }
});

Footprints.register({
  id:"radial", name:"Radial THT cap", prefix:"C",
  params:[{key:"pitch",label:"Pitch mm",type:"select",def:"2.5",options:["2.0","2.5","3.5","5.0","7.5"]},
          {key:"shape",label:"Body",type:"select",def:"Round",options:["Round","Square (foil)"]},
          {key:"polarized",label:"Polarized",type:"bool",def:true}],
  gen(p){
    const d = parseFloat(p.pitch);
    const dia = Math.max(d*1.8, d + 3);
    const square = p.shape !== "Round";
    const pol = !!p.polarized;
    return {
      label:(square?"Foil cap P":"Radial P")+p.pitch,
      pins:[_pin(1,-d/2,0,{shape:"circle",w:1.4,h:1.4,name:pol?"+":""}), _pin(2,d/2,0,{shape:"circle",w:1.4,h:1.4,name:pol?"-":""})],
      body:{w:dia, h:dia, shape: square ? "rect" : "circle"},
      polar:pol,
      kicad:(pol?"Capacitor_THT:CP_Radial_D":"Capacitor_THT:C_Radial_D")+dia.toFixed(1)+"mm_P"+d.toFixed(2)+"mm"
    };
  }
});

Footprints.register({
  id:"ecap_smd", name:"Electrolytic cap (SMD, round)", prefix:"C",
  params:[{key:"dia",label:"Diameter mm",type:"select",def:"6.3",options:["4.0","5.0","6.3","8.0","10.0"]},
          {key:"polarized",label:"Polarized",type:"bool",def:true}],
  gen(p){
    const d = parseFloat(p.dia);
    // gull-wing pads reach OUTWARD (radially, along X): long axis = w, short axis = h
    const padL = d*0.495, padW = 1.2;   // pad length 10% shorter (was d*0.55)
    const px = d/2 - padL*0.1;           // nudged another 10% of padL outward
    const pol = !!p.polarized;
    return {
      label:"E-cap D"+p.dia,
      pins:[_pin(1,-px,0,{w:padL,h:padW,name:pol?"+":""}), _pin(2,px,0,{w:padL,h:padW,name:pol?"-":""})],
      body:{w:d, h:d, shape:"circle"},
      polar:pol,
      kicad:"Capacitor_SMD:CP_Elec_"+p.dia+"x"+(d*0.8).toFixed(1)
    };
  }
});
