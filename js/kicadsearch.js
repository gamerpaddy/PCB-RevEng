/* ===== kicadsearch.js — autocomplete for KiCad footprint fields, backed by
   footprints_kicad.txt (one footprint name per line) ===== */
"use strict";

const KicadFootprints = [];
let _kfLoading = false;

function _kfIngest(text){
  for (const line of text.split(/\r?\n/)){
    const s = line.trim();
    if (s) KicadFootprints.push(s);
  }
}

function loadKicadFootprints(){
  if (_kfLoading || KicadFootprints.length) return;
  // preferred: the bundled footprints_kicad.js (a <script>, so it works on file://
  // where fetch() is blocked by CORS). Fall back to fetching the .txt over http.
  if (typeof window.KICAD_FOOTPRINTS_TEXT === "string"){ _kfIngest(window.KICAD_FOOTPRINTS_TEXT); return; }
  _kfLoading = true;
  const done = () => { _kfLoading = false; };
  fetch("footprints_kicad.txt?v=25")
    .then(r => r.ok ? r.text() : Promise.reject(new Error("fetch " + r.status)))
    .then(text => { _kfIngest(text); done(); })
    .catch(() => {
      // file:// fallback — pull in the JS data file via a script tag
      const s = document.createElement("script");
      s.src = "footprints_kicad.js?v=25";
      s.onload = () => { if (typeof window.KICAD_FOOTPRINTS_TEXT === "string") _kfIngest(window.KICAD_FOOTPRINTS_TEXT); done(); };
      s.onerror = done;
      document.head.appendChild(s);
    });
}

/* the inputs that get autocomplete: the dialog field + the inspector field */
function _kfIsTarget(t){ return !!t && (t.id === "fp-kicad" || t.id === "i-kicad"); }

let _kfBox = null, _kfInput = null, _kfDlg = null;

function _kfStyle(){
  if (document.getElementById("kf-style")) return;
  const st = document.createElement("style");
  st.id = "kf-style";
  st.textContent =
    "#kf-dropdown{z-index:99999;overflow:hidden;background:#1c222b;" +
    "border:1px solid #3c4856;border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.6);font-size:12px}" +
    "#kf-dropdown .kf-item{padding:4px 9px;color:#cdd5df;cursor:pointer;white-space:nowrap}" +
    "#kf-dropdown .kf-item:hover,#kf-dropdown .kf-item.sel{background:#2a3340;color:#fff}";
  document.head.appendChild(st);
}

function _kfHide(){
  // restore the host dialog's clipping we temporarily disabled
  if (_kfDlg){ _kfDlg.style.overflow = ""; _kfDlg = null; }
  if (_kfBox){ _kfBox.remove(); _kfBox = null; }
  _kfInput = null;
  document.removeEventListener("pointerdown", _kfOutside, true);
}
function _kfOutside(e){
  if (_kfBox && !_kfBox.contains(e.target) && e.target !== _kfInput) _kfHide();
}

function _kfShow(input){
  if (!KicadFootprints.length){ loadKicadFootprints(); return; }
  const q = input.value.trim().toLowerCase();
  if (!q){ _kfHide(); return; }
  const matches = [];
  for (const f of KicadFootprints){
    if (f.toLowerCase().includes(q)){ matches.push(f); if (matches.length >= 10) break; }
  }
  if (!matches.length){ _kfHide(); return; }
  _kfStyle();
  if (!_kfBox){
    _kfBox = document.createElement("div");
    _kfBox.id = "kf-dropdown";
    document.addEventListener("pointerdown", _kfOutside, true);
  }
  // A modal <dialog> makes everything outside it inert (un-clickable) and renders
  // in the top layer, so the dropdown must be a DESCENDANT of the dialog to be both
  // interactive and painted above it. But a <dialog>'s UA style is overflow:auto +
  // max-height, which CLIPS the dropdown — so while it's open we switch the host
  // dialog to overflow:visible (its compact content fits fine) and restore on hide.
  const dlg = input.closest("dialog[open]");
  const host = dlg || document.body;
  if (_kfBox.parentNode !== host) host.appendChild(_kfBox);
  if (_kfDlg && _kfDlg !== dlg){ _kfDlg.style.overflow = ""; _kfDlg = null; }
  if (dlg){ _kfDlg = dlg; dlg.style.overflow = "visible"; }
  _kfInput = input;

  // fill items first so we can measure the box height for flip-up placement
  _kfBox.style.width = Math.max(input.getBoundingClientRect().width, 240) + "px";
  _kfBox.innerHTML = "";
  for (const m of matches){
    const d = document.createElement("div");
    d.className = "kf-item";
    d.textContent = m;
    d.addEventListener("mousedown", e => {
      e.preventDefault();
      input.value = m;
      input.dispatchEvent(new Event("input", { bubbles:true }));
      input.dispatchEvent(new Event("change", { bubbles:true }));
      _kfHide();
    });
    _kfBox.appendChild(d);
  }

  // place below the field, or flip above when there isn't room in the viewport
  const ir = input.getBoundingClientRect();
  const bh = _kfBox.offsetHeight;
  const flipUp = (ir.bottom + bh + 6 > window.innerHeight) && (ir.top - bh - 6 > 0);
  const topVp = flipUp ? (ir.top - bh - 2) : (ir.bottom + 2);
  if (dlg){
    const hr = dlg.getBoundingClientRect();
    _kfBox.style.position = "absolute";
    _kfBox.style.left = (ir.left - hr.left) + "px";
    _kfBox.style.top  = (topVp - hr.top) + "px";
  } else {
    _kfBox.style.position = "fixed";
    _kfBox.style.left = ir.left + "px";
    _kfBox.style.top  = topVp + "px";
  }
}

/* called once at startup (replaces the old no-op UI.wireFpSearch) */
UI.wireFpSearch = () => {
  loadKicadFootprints();
  document.addEventListener("input", e => { if (_kfIsTarget(e.target)) _kfShow(e.target); }, true);
  document.addEventListener("focusin", e => { if (_kfIsTarget(e.target) && e.target.value.trim()) _kfShow(e.target); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && _kfBox) _kfHide(); }, true);
};
