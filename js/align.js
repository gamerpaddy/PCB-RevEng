/* ===== align.js — image-layer align (4-point) & 2-line deskew/perspective ===== */
"use strict";

/* ---------------- align tool ---------------- */
function alignDown(w, pt, e){
  // 2-line deskew collection (4 clicks: line1 ×2, line2 ×2)
  if (Tools.deskewPts){
    Tools.deskewPts.push({x:w.x, y:w.y});
    const n = Tools.deskewPts.length;
    if (n === 4) applyLineDeskew(Tools.deskewLayer);
    else UI.setHint(DESKEW_HINTS[n-1] || "");
    requestRender();
    return;
  }

  // The align tool always lets you MOVE the image by dragging. During a 4-point procedure
  // (Tools.alignPts set) a plain CLICK instead drops the next alignment marker. We start a
  // move drag now and, if the pointer never actually moves, place the marker on release
  // (see onPointerUp) — so drag = move and click = marker, both without pressing Esc first.
  const layer = UI.activeLayer();
  if (!layer){ UI.toast("Select an image layer in the Layers panel first"); return; }
  if (layer.locked){ UI.toast("Layer is locked"); return; }
  pushUndo();
  if (e.shiftKey){
    Tools.drag = { kind:"rot-layer", layer, wx:w.x, wy:w.y, lrot:layer.rot,
                   lwarp0: layer.warp ? {...layer.warp} : null, moved:false };
  } else {
    Tools.drag = { kind:"move-layer", layer, wx:w.x, wy:w.y, ltx:layer.tx, lty:layer.ty, moved:false,
                   alignClick: Tools.alignPts ? { x:w.x, y:w.y, thumb: captureAlignThumb(pt) } : null };
  }
}

/* place the next 4-point alignment marker (a click that didn't turn into a drag-move) */
function placeAlignMarker(x, y, thumb){
  if (!Tools.alignPts) return;
  const target = Tools.alignLayer;
  if (!target){ Tools.alignPts = null; return; }
  Tools.alignPts.push({ x, y, thumb });
  if (Tools.alignPts.length === 8) applyPointAlign(target);
  requestRender();
}

/* count placed annotations sitting on a layer's side — re-warping the image would
   leave these where they are and misalign them against the moved photo */
function layerAnnotationCount(layer){
  if (!layer) return 0;
  const side = layer.side;
  let n = 0;
  for (const c of State.components) if (c.side === side) n++;
  for (const t of State.traces)     if (t.side === side) n++;
  return n;
}
/* returns true if it's OK to proceed (no elements, or user accepted the risk) */
function confirmRewarpIfPopulated(layer, action){
  const n = layerAnnotationCount(layer);
  if (!n) return true;
  return confirm(
    "Layer “" + layer.name + "” already has " + n + " element" + (n===1?"":"s") +
    " (components/traces) placed on its side.\n\n" +
    action + " moves the image but NOT those elements, so they may no longer line up.\n\n" +
    "OK = go ahead and risk misalignment\nCancel = abort");
}

function startPointAlign(){
  const layer = UI.activeLayer();
  if (!layer){ UI.toast("Select the layer to align first"); return; }
  if (!confirmRewarpIfPopulated(layer, "Aligning")) return;
  setTool("align");
  Tools.alignPts = [];
  Tools.alignLayer = layer;   // lock the target now; switching active layers mid-procedure won't change it
  Tools.alignReturnId = layer.id; // switch back to this layer once alignment is done
  UI.setHint("STEP 1/2 · 4-point align: click feature 1 of 4 ON layer “" + layer.name + "” (this is the image that will move)");
}

/* least-squares affine mapping src[i] → dst[i]; returns {a,b,c,d,e,f} (canvas convention) or null */
function solveAffine(src, dst){
  let Sxx=0,Sxy=0,Syy=0,Sx=0,Sy=0, n=src.length;
  let Bx=[0,0,0], By=[0,0,0];
  for (let i=0;i<n;i++){
    const {x,y}=src[i], u=dst[i].x, v=dst[i].y;
    Sxx+=x*x; Sxy+=x*y; Syy+=y*y; Sx+=x; Sy+=y;
    Bx[0]+=x*u; Bx[1]+=y*u; Bx[2]+=u;
    By[0]+=x*v; By[1]+=y*v; By[2]+=v;
  }
  const M=[[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,n]];
  const det3=(m)=> m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
               - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
               + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
  const D=det3(M);
  if (Math.abs(D) < 1e-6) return null; // degenerate (collinear points)
  const solve=(B)=>{
    const cols=[0,1,2].map(k=>{
      const Mk=M.map((row,r)=>row.map((v,c)=> c===k ? B[r] : v));
      return det3(Mk)/D;
    });
    return cols;
  };
  const [a,c,e]=solve(Bx);
  const [b,d,f]=solve(By);
  return {a,b,c,d,e,f};
}

function applyPointAlign(layer){
  const pts = Tools.alignPts;
  Tools.alignPts = null;
  Tools.alignLayer = null;
  const mov = pts.slice(0,4), ref = pts.slice(4); // clicked layer's features first, destinations second
  const T = solveAffine(mov, ref);
  if (!T){ UI.toast("Points are collinear / too close — alignment aborted"); UI.setHint(TOOL_HINTS.align); return; }
  pushUndo();
  // compose: layer's linear part gets L·W (skew-capable), centre moves under T
  const W = layerLinear(layer);
  layer.warp = {
    a: T.a*W.a + T.c*W.b,  b: T.b*W.a + T.d*W.b,
    c: T.a*W.c + T.c*W.d,  d: T.b*W.c + T.d*W.d,
  };
  const cx = T.a*layer.tx + T.c*layer.ty + T.e;
  const cy = T.b*layer.tx + T.d*layer.ty + T.f;
  layer.tx = cx; layer.ty = cy;
  // residual error report
  let err = 0;
  for (let i=0;i<4;i++){
    const p = mov[i];
    err = Math.max(err, Math.hypot(T.a*p.x+T.c*p.y+T.e - ref[i].x, T.b*p.x+T.d*p.y+T.f - ref[i].y));
  }
  // jump back to the layer that was aligned (the user had switched to the base layer for step 2)
  if (Tools.alignReturnId != null && getLayer(Tools.alignReturnId)){
    UI.activeLayerId = Tools.alignReturnId;
    UI.setDrawSide(getLayer(Tools.alignReturnId).side);
  }
  Tools.alignReturnId = null;
  UI.refreshLayerList();
  UI.setHint(TOOL_HINTS.align);
  UI.toast("Layer aligned (skew corrected, max residual " + err.toFixed(1) + " px) — back on “" + layer.name + "”");
  requestRender();
}

/* ============ crop: trim an (already-aligned) image to a rectangle ============
   Drag a rectangle in world space around the part to KEEP. The current on-screen
   pixels of the layer — including any alignment warp/rotation/mirror — are baked into
   a new axis-aligned bitmap positioned exactly where the rectangle was, so annotations
   placed on that side stay lined up. Everything outside the rectangle is discarded. */
function startCrop(){
  const layer = UI.activeLayer();
  if (!layer || !layer.img){ UI.toast("Select an image layer in the Layers panel first"); return; }
  if (layer.locked){ UI.toast("Layer is locked"); return; }
  setTool("crop");
  Tools.cropLayer = layer;                 // capture now; setTool cleared it first
  Tools.cropA = Tools.cropB = null;
  UI.setHint("Crop “" + layer.name + "”: drag a box around the part to KEEP · Esc to cancel");
}

function cropDown(w, e){
  if (!Tools.cropLayer){ setTool("select"); return; }
  Tools.cropA = { x:w.x, y:w.y };
  Tools.cropB = { x:w.x, y:w.y };
  Tools.drag = { kind:"crop-rect", moved:false };
}

function applyCrop(){
  const layer = Tools.cropLayer, A = Tools.cropA, B = Tools.cropB;
  Tools.cropA = Tools.cropB = null;
  if (!layer || !layer.img || !A || !B){ setTool("select"); Tools.cropLayer = null; return; }
  const x0 = Math.min(A.x, B.x), y0 = Math.min(A.y, B.y);
  const Wworld = Math.abs(B.x - A.x), Hworld = Math.abs(B.y - A.y);
  if (Wworld < 4 || Hworld < 4){ UI.toast("Crop area too small — try again"); return; }
  // output resolution: match the layer's current image detail (image px per world px),
  // capped so a wildly-zoomed crop can't allocate a monster canvas
  const eff = layerEffScale(layer) || 1;   // world px per source-image px
  let k = 1 / eff;                          // source px per world px
  let outW = Math.round(Wworld * k), outH = Math.round(Hworld * k);
  const MAXDIM = 8192, big = Math.max(outW, outH);
  if (big > MAXDIM){ const f = MAXDIM / big; outW = Math.round(outW*f); outH = Math.round(outH*f); k *= f; }
  outW = Math.max(1, outW); outH = Math.max(1, outH);

  const cnv = document.createElement("canvas");
  cnv.width = outW; cnv.height = outH;
  const cx = cnv.getContext("2d");
  // world → output px, then the layer's own transform (same pipeline as drawWorld)
  cx.setTransform(k, 0, 0, k, -x0*k, -y0*k);
  cx.translate(layer.tx, layer.ty);
  if (layer.warp){
    cx.transform(layer.warp.a, layer.warp.b, layer.warp.c, layer.warp.d, 0, 0);
  } else {
    cx.rotate(layer.rot * Math.PI/180);
    cx.scale(layer.scale * (layer.mirror ? -1 : 1), layer.scale);
  }
  cx.drawImage(layer.img, -layer.img.width/2, -layer.img.height/2);

  pushUndo("crop " + layer.name);
  layer.img = cnv;
  layer.dataURL = cnv.toDataURL("image/jpeg", 0.92);
  layer.url = null;                         // baked pixels are embedded now
  layer.warp = null; layer.rot = 0; layer.mirror = false;   // plain axis-aligned bitmap
  layer.tx = x0 + Wworld/2; layer.ty = y0 + Hworld/2;        // centred on the crop box
  layer.scale = 1 / k;                      // world px per output px → sits exactly where the box was
  layer.tiles = (typeof ImageTiles !== "undefined" && ImageTiles.shouldTile(cnv)) ? ImageTiles.build(cnv) : null;
  if (typeof markImagesDirty === "function") markImagesDirty();
  Tools.cropLayer = null;
  setTool("select");
  UI.refreshLayerList();
  UI.toast("Cropped “" + layer.name + "” to " + outW + "×" + outH + " px");
  requestRender();
}

/* ============ 2-line deskew / perspective straighten ============ */

/* world point -> source-image pixel coords (0..w, 0..h), undoing the layer transform */
function worldToImagePx(l, wx, wy){
  const L = layerLinear(l);                 // {a,b,c,d}
  const det = L.a*L.d - L.b*L.c || 1;
  const ix = ( L.d*(wx-l.tx) - L.c*(wy-l.ty)) / det; // inverse linear → centred coords
  const iy = (-L.b*(wx-l.tx) + L.a*(wy-l.ty)) / det;
  return { x: ix + l.img.width/2, y: iy + l.img.height/2 };
}

/* solve 3x3 affine for ctx.transform from a source triangle to a dest triangle */
function _solve3(rows, rhs){
  const det = rows[0][0]*(rows[1][1]*rows[2][2]-rows[1][2]*rows[2][1])
            - rows[0][1]*(rows[1][0]*rows[2][2]-rows[1][2]*rows[2][0])
            + rows[0][2]*(rows[1][0]*rows[2][1]-rows[1][1]*rows[2][0]);
  if (Math.abs(det) < 1e-9) return null;
  const out = [];
  for (let k=0;k<3;k++){
    const m = rows.map((r,ri)=> r.map((v,ci)=> ci===k ? rhs[ri] : v));
    const d = m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
            - m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
            + m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
    out[k] = d/det;
  }
  return out; // [coeff_x, coeff_y, const]
}

/* solve a 3x3 homography H (h8=1) mapping src[4] -> dst[4]; returns 9 numbers or null */
function solveHomography(src, dst){
  const A = [], b = [];
  for (let i=0;i<4;i++){
    const {x,y} = src[i], {x:u,y:v} = dst[i];
    A.push([x,y,1,0,0,0,-x*u,-y*u]); b.push(u);
    A.push([0,0,0,x,y,1,-x*v,-y*v]); b.push(v);
  }
  // Gaussian elimination on the 8x8 system
  for (let col=0; col<8; col++){
    let piv=col; for (let r=col+1;r<8;r++) if (Math.abs(A[r][col])>Math.abs(A[piv][col])) piv=r;
    if (Math.abs(A[piv][col])<1e-12) return null;
    [A[col],A[piv]]=[A[piv],A[col]]; [b[col],b[piv]]=[b[piv],b[col]];
    for (let r=0;r<8;r++){ if (r===col) continue; const f=A[r][col]/A[col][col];
      for (let cc=col;cc<8;cc++) A[r][cc]-=f*A[col][cc]; b[r]-=f*b[col]; }
  }
  const h=[]; for (let i=0;i<8;i++) h[i]=b[i]/A[i][i]; h[8]=1;
  return h;
}
function _applyH(h, x, y){
  const d = h[6]*x + h[7]*y + h[8];
  return { x:(h[0]*x+h[1]*y+h[2])/d, y:(h[3]*x+h[4]*y+h[5])/d };
}

/* forward piecewise-affine texture map: warp srcImg through H into a new canvas */
function warpImageMesh(srcImg, H, outW, outH){
  const out = document.createElement("canvas");
  out.width = outW; out.height = outH;
  const x = out.getContext("2d");
  const N = 12, iw = srcImg.width, ih = srcImg.height;
  const tri = (s, d) => {
    x.save();
    x.beginPath(); x.moveTo(d[0].x,d[0].y); x.lineTo(d[1].x,d[1].y); x.lineTo(d[2].x,d[2].y); x.closePath(); x.clip();
    const rows=[[s[0],s[1],1],[s[2],s[3],1],[s[4],s[5],1]];
    const ax=_solve3(rows,[d[0].x,d[1].x,d[2].x]);
    const ay=_solve3(rows,[d[0].y,d[1].y,d[2].y]);
    if (ax && ay){ x.transform(ax[0],ay[0],ax[1],ay[1],ax[2],ay[2]); x.drawImage(srcImg,0,0); }
    x.restore();
  };
  for (let gy=0;gy<N;gy++) for (let gx=0;gx<N;gx++){
    const x0=gx/N*iw, y0=gy/N*ih, x1=(gx+1)/N*iw, y1=(gy+1)/N*ih;
    const d00=_applyH(H,x0,y0), d10=_applyH(H,x1,y0), d01=_applyH(H,x0,y1), d11=_applyH(H,x1,y1);
    tri([x0,y0,x1,y0,x0,y1],[d00,d10,d01]);
    tri([x1,y0,x1,y1,x0,y1],[d10,d11,d01]);
  }
  return out;
}

function startLineDeskew(){
  const layer = UI.activeLayer();
  if (!layer || !layer.img){ UI.toast("Select an image layer first"); return; }
  // Deskew bakes a new perspective into the image. Doing it AFTER a layer has been
  // aligned to the base invalidates that alignment, so only the base layer (layer 1)
  // may be deskewed — every other layer should be aligned to it instead.
  if (State.layers[0] !== layer){
    UI.toast("Deskew is only for the base layer (layer 1). Align other layers to it instead.");
    return;
  }
  if (!confirmRewarpIfPopulated(layer, "Deskewing")) return;
  setTool("align");
  Tools.deskewPts = [];
  Tools.deskewLayer = layer;
  UI.setHint("Deskew: click the 2 ends of a line that should be straight (line 1, point 1)");
}

const DESKEW_HINTS = [
  "Deskew - line 1: click the second end",
  "Deskew - line 2 (parallel to line 1): click the first end",
  "Deskew - line 2: click the second end",
  "",
];

function applyLineDeskew(layer){
  const pts = Tools.deskewPts;
  Tools.deskewPts = null; Tools.deskewLayer = null;
  UI.setHint(TOOL_HINTS.align);
  if (!layer || !layer.img || !pts || pts.length < 4) return;
  // clicked world points -> source-image pixels
  const sp = pts.map(p => worldToImagePx(layer, p.x, p.y));
  // average undirected line angle (mod π) via double-angle mean
  const a1 = Math.atan2(sp[1].y-sp[0].y, sp[1].x-sp[0].x);
  const a2 = Math.atan2(sp[3].y-sp[2].y, sp[3].x-sp[2].x);
  const avg = 0.5*Math.atan2(Math.sin(2*a1)+Math.sin(2*a2), Math.cos(2*a1)+Math.cos(2*a2));
  // is the average closer to horizontal or vertical?
  const horizontal = Math.abs(Math.cos(avg)) >= Math.abs(Math.sin(avg));
  const rot = horizontal ? -avg : (Math.PI/2 - avg);
  const cx = (sp[0].x+sp[1].x+sp[2].x+sp[3].x)/4, cy = (sp[0].y+sp[1].y+sp[2].y+sp[3].y)/4;
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const lev = sp.map(p => ({ x: cx + (p.x-cx)*ca - (p.y-cy)*sa, y: cy + (p.x-cx)*sa + (p.y-cy)*ca }));
  // snap each line's perpendicular coordinate to its mean -> truly parallel & axis-aligned
  const dst = lev.map(p => ({x:p.x, y:p.y}));
  if (horizontal){
    const y1=(lev[0].y+lev[1].y)/2, y2=(lev[2].y+lev[3].y)/2;
    dst[0].y=y1; dst[1].y=y1; dst[2].y=y2; dst[3].y=y2;
  } else {
    const x1=(lev[0].x+lev[1].x)/2, x2=(lev[2].x+lev[3].x)/2;
    dst[0].x=x1; dst[1].x=x1; dst[2].x=x2; dst[3].x=x2;
  }
  // fit dst into the original image dimensions (preserve aspect, centre)
  const iw=layer.img.width, ih=layer.img.height;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  // map the FOUR IMAGE CORNERS through the same level+snap-derived homography to get true bounds:
  const Hraw = solveHomography(sp, dst);
  if (!Hraw){ UI.toast("Could not deskew - points are collinear"); return; }
  for (const c of [[0,0],[iw,0],[iw,ih],[0,ih]]){
    const q=_applyH(Hraw,c[0],c[1]);
    minX=Math.min(minX,q.x);maxX=Math.max(maxX,q.x);minY=Math.min(minY,q.y);maxY=Math.max(maxY,q.y);
  }
  const bw=maxX-minX, bh=maxY-minY;
  const s = Math.min(iw/bw, ih/bh) * 0.98;
  const ox = (iw - bw*s)/2 - minX*s, oy = (ih - bh*s)/2 - minY*s;
  // final homography: src px -> output px (fitted)
  const dstFit = dst.map(p => ({x:p.x*s+ox, y:p.y*s+oy}));
  const H = solveHomography(sp, dstFit);
  if (!H){ UI.toast("Could not deskew - points are collinear"); return; }
  pushUndo("deskew " + layer.name);
  const baked = warpImageMesh(layer.img, H, iw, ih);
  const img = new Image();
  img.onload = () => { requestRender(); };
  layer.dataURL = baked.toDataURL("image/jpeg", 0.92);
  img.src = layer.dataURL;
  layer.img = baked;                 // use immediately; img reload keeps dataURL/bitmap in sync
  layer.url = null;                  // baked pixels are now embedded — no longer a hosted link
  // the source changed, so any old LOD pyramid is stale; rebuild it for big bakes
  layer.tiles = (typeof ImageTiles !== "undefined" && ImageTiles.shouldTile(baked))
    ? ImageTiles.build(baked) : null;
  // straighten the layer transform (deskew supersedes prior rotation/skew)
  layer.warp = null; layer.rot = 0;
  layer.scale = layerEffScale(layer);
  if (typeof markImagesDirty === "function") markImagesDirty();
  UI.refreshLayerList();
  UI.toast("Layer deskewed & straightened (" + (horizontal?"horizontal":"vertical") + " lines)");
  requestRender();
}
