/* ===== imagetiles.js — level-of-detail tile pyramid for very large layer photos =====
   A single gigapixel <img> either won't render at all (browsers refuse textures wider
   than ~16k px and blank the draw) or is ruinously slow to blit every frame. This builds
   a mipmap pyramid of small tile canvases so the renderer draws only the visible tiles at
   a resolution matched to the current zoom:

     · level 0  = the source image itself, drawn in TILE-sized sub-rects, culled to the
                  viewport (used when zoomed in — only a few tiles are on screen)
     · level k  = the source downscaled by 2^k, cut into TILE-sized canvases (used when
                  zoomed out — a handful of small tiles cover the whole board)

   Only UPLOADED images are tiled (we hold their full-res source). Hosted/URL layers are
   left as plain <img> draws. Tiles are runtime-only — never serialized; they're rebuilt
   from the source on load. */
"use strict";

const ImageTiles = {
  TILE: 1024,      // tile edge in source pixels
  MAXDIM: 4096,    // images with a side larger than this get a pyramid; smaller draw plain

  /* worth tiling? */
  shouldTile(img){
    return !!img && Math.max(img.width || 0, img.height || 0) > this.MAXDIM;
  },

  /* build the pyramid from a decoded source (an <img> or a canvas). Returns a descriptor
     stored on layer.tiles, or null if the source is unusable / building failed. */
  build(src){
    const w = src && src.width, h = src && src.height;
    if (!w || !h) return null;
    try {
      const levels = [];
      let f = 2;
      // downscaled levels until the whole level fits in a single tile
      while (Math.ceil(w / f) > this.TILE || Math.ceil(h / f) > this.TILE){
        levels.push(this._buildLevel(src, w, h, f));
        f *= 2;
        if (f > (1 << 20)) break;   // paranoia
      }
      return { w, h, src, levels, tile: this.TILE };
    } catch (e){
      console.warn("ImageTiles.build failed", e);
      return null;
    }
  },

  /* one downscaled level: source shrunk by factor f, cut into TILE-sized canvases */
  _buildLevel(src, w, h, f){
    const lw = Math.max(1, Math.ceil(w / f)), lh = Math.max(1, Math.ceil(h / f));
    const cols = Math.ceil(lw / this.TILE), rows = Math.ceil(lh / this.TILE);
    const tiles = [];
    for (let ty = 0; ty < rows; ty++){
      for (let tx = 0; tx < cols; tx++){
        const dx = tx * this.TILE, dy = ty * this.TILE;
        const tw = Math.min(this.TILE, lw - dx), th = Math.min(this.TILE, lh - dy);
        // source-space region this tile represents
        const sx = dx * f, sy = dy * f;
        const sw = Math.min(w - sx, tw * f), sh = Math.min(h - sy, th * f);
        const cv = document.createElement("canvas");
        cv.width = tw; cv.height = th;
        const c = cv.getContext("2d");
        c.imageSmoothingEnabled = true;
        try { c.drawImage(src, sx, sy, sw, sh, 0, 0, tw, th); } catch (e){ /* skip bad tile */ }
        tiles.push({ cv, sx, sy, sw, sh });   // sx/sy/sw/sh are in SOURCE pixels
      }
    }
    return { f, lw, lh, cols, rows, tiles };
  },

  /* Draw a tiled layer. MUST be called with the layer's local transform already applied
     to ctx (translate(tx,ty) → rotate/scale or warp), exactly where the plain-image path
     would call ctx.drawImage(img, -w/2, -h/2). Tiles are placed in that same image-local,
     source-resolution space, so no extra transform maths is needed for drawing — only for
     culling, which reconstructs the full image→screen matrix from View + layer. */
  draw(ctx, layer){
    const t = layer.tiles;
    if (!t){ // not tiled — plain draw
      const im = layer.img;
      if (im && im.width) ctx.drawImage(im, -im.width / 2, -im.height / 2);
      return;
    }
    const w = t.w, h = t.h, cx = w / 2, cy = h / 2;
    const box = this._visibleImageBox(layer, w, h);
    ctx.imageSmoothingEnabled = true;
    if (!box){ // couldn't invert (degenerate transform) — draw coarsest level whole
      const L = t.levels[t.levels.length - 1];
      if (L) for (const tl of L.tiles) ctx.drawImage(tl.cv, 0, 0, tl.cv.width, tl.cv.height, tl.sx - cx, tl.sy - cy, tl.sw, tl.sh);
      else ctx.drawImage(t.src, -cx, -cy);
      return;
    }

    // choose the level whose 1 source-px ≈ 1 screen-px (or coarser). ppp = screen px per
    // source px; want downscale f ≤ 1/ppp so the tile still has at least screen resolution.
    const ppp = View.zoom * layerEffScale(layer);
    let lvl = null;                      // null = draw from the full-res source
    if (ppp < 0.9 && t.levels.length){
      const maxF = 1 / ppp;
      for (const L of t.levels){ if (L.f <= maxF) lvl = L; else break; }
    }

    if (!lvl){
      // full-res source, tiled + culled to the visible image box
      const TILE = t.tile;
      const x0 = Math.floor(box.minX / TILE) * TILE, y0 = Math.floor(box.minY / TILE) * TILE;
      for (let sy = Math.max(0, y0); sy < Math.min(h, box.maxY); sy += TILE){
        for (let sx = Math.max(0, x0); sx < Math.min(w, box.maxX); sx += TILE){
          const sw = Math.min(TILE, w - sx), sh = Math.min(TILE, h - sy);
          try { ctx.drawImage(t.src, sx, sy, sw, sh, sx - cx, sy - cy, sw, sh); } catch (e){}
        }
      }
    } else {
      for (const tl of lvl.tiles){
        if (tl.sx + tl.sw < box.minX || tl.sx > box.maxX ||
            tl.sy + tl.sh < box.minY || tl.sy > box.maxY) continue;   // off-screen
        ctx.drawImage(tl.cv, 0, 0, tl.cv.width, tl.cv.height, tl.sx - cx, tl.sy - cy, tl.sw, tl.sh);
      }
    }
  },

  /* axis-aligned image-space box currently visible on screen, or null if the layer's
     transform is degenerate. Builds the image→screen affine (S·M plus centring/pan) and
     inverts it to map the four viewport corners back into source-pixel coordinates. */
  _visibleImageBox(layer, w, h){
    const fx = View.flip ? -1 : 1;
    const M = layer.warp ? layer.warp : layerLinear(layer);   // {a,b,c,d}
    const zx = View.zoom * fx, zy = View.zoom;
    // screen = A·p + (bx,by), where A = S·M, p is a source pixel
    const A = { a: zx * M.a, b: zy * M.b, c: zx * M.c, d: zy * M.d };
    const cx = w / 2, cy = h / 2;
    const Px = View.panX + (View._paneDX || 0), Py = View.panY;
    const bx = -(A.a * cx + A.c * cy) + zx * layer.tx + Px;
    const by = -(A.b * cx + A.d * cy) + zy * layer.ty + Py;
    const det = A.a * A.d - A.b * A.c;
    if (!det) return null;
    const ia = A.d / det, ic = -A.c / det, ib = -A.b / det, id = A.a / det;
    const toImg = (sx, sy) => ({ x: ia * (sx - bx) + ic * (sy - by), y: ib * (sx - bx) + id * (sy - by) });
    const W = View.width, H = View.height;
    const pts = [toImg(0, 0), toImg(W, 0), toImg(0, H), toImg(W, H)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts){
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const m = 2 / (View.zoom || 1);   // a hair of margin so edge tiles aren't clipped early
    return { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m };
  },
};
