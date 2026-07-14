/* ===== ai.js — optional AI Connect: pin/part autofill, footprint maker, sch arrange =====
   All experimental and OFF by default. The API key lives ONLY in localStorage (never in a
   project save file), so sharing a saved board can't leak it. Every feature has its own
   enable checkbox in the 🔬 Experimental dialog. Requests can produce garbage and cost
   money — the dialog warns the user to set provider-side spend limits. */
"use strict";

const AI = {
  LS: {
    provider: "pcbreveng.ai.provider",
    baseurl:  "pcbreveng.ai.baseurl",
    key:      (p) => "pcbreveng.ai.key." + p,
    model:    (p) => "pcbreveng.ai.model." + p,
    en:       (f) => "pcbreveng.ai.en." + f,
  },

  _get(k, d){ try { const v = localStorage.getItem(k); return v == null ? d : v; } catch(e){ return d; } },
  _set(k, v){ try { if (v == null || v === "") localStorage.removeItem(k); else localStorage.setItem(k, v); } catch(e){} },

  provider(){ return AI._get(AI.LS.provider, "anthropic"); },
  key(p){ return AI._get(AI.LS.key(p || AI.provider()), ""); },
  model(p){ return AI._get(AI.LS.model(p || AI.provider()), ""); },
  baseurl(){ return AI._get(AI.LS.baseurl, "http://localhost:1234/v1"); },
  enabled(feature){ return AI._get(AI.LS.en(feature), "off") === "on"; },
  configured(){ const p = AI.provider(); return p === "local" ? !!AI.baseurl() : !!AI.key(p); },

  /* default model per provider when the user hasn't picked one */
  _defaultModel(p){
    return ({
      anthropic:  "claude-sonnet-5",
      openai:     "gpt-4o-mini",
      openrouter: "anthropic/claude-sonnet-5",
      gemini:     "gemini-2.0-flash",
      local:      "local-model",
    })[p] || "";
  },

  /* ---------- in-flight requests + cancellation ----------
     Every network call registers an AbortController so the user can cancel it
     (a floating "AI working… [Cancel]" banner appears while any are live). */
  _ctrls: new Set(),
  _newCtrl(){
    const c = (typeof AbortController !== "undefined") ? new AbortController() : { signal: undefined, abort(){} };
    AI._ctrls.add(c); AI._updateBusy();
    return c;
  },
  _dropCtrl(c){ AI._ctrls.delete(c); AI._updateBusy(); },
  busy(){ return AI._ctrls.size > 0; },
  cancel(){                                   // abort every live request
    for (const c of AI._ctrls){ try { c.abort(); } catch(e){} }
    AI._ctrls.clear(); AI._updateBusy();
  },
  isAbort(err){ return !!err && (err.name === "AbortError" || /abort/i.test(err.message || "")); },

  /* ---------- debug log (request / answer history) ----------
     Ring buffer of recent calls, shown in the Experimental → AI Connect debug panel.
     Kept in memory only (never persisted) — the raw prompt can be large / sensitive. */
  _log: [],
  LOG_CAP: 40,
  _record(e){
    e.time = Date.now();
    AI._log.unshift(e);
    if (AI._log.length > AI.LOG_CAP) AI._log.length = AI.LOG_CAP;
    if (typeof AI._renderLog === "function") AI._renderLog();
  },
  clearLog(){ AI._log.length = 0; if (typeof AI._renderLog === "function") AI._renderLog(); },

  /* ---------- low-level chat call (returns assistant text) ---------- */
  async chat(system, user, opts){
    opts = opts || {};
    const p = AI.provider();
    const model = AI.model(p) || AI._defaultModel(p);
    if (!AI.configured()) throw new Error("No API key set — open 🔬 Experimental → AI Connect");
    const maxTok = opts.maxTokens || 2000;
    const ctrl = AI._newCtrl();
    const t0 = Date.now();
    const entry = { kind: opts.kind || "chat", provider: p, model, system, user, response: null, error: null, ms: 0 };
    try {
      let out;
      if (p === "anthropic"){
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": AI.key(p),
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({ model, max_tokens: maxTok, system,
            messages: [{ role: "user", content: user }] }),
        });
        const j = await AI._json(r);
        out = (j.content || []).map(c => c.text || "").join("");
      } else if (p === "gemini"){
        const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
          encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(AI.key(p));
        const r = await fetch(url, {
          method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: { maxOutputTokens: maxTok },
          }),
        });
        const j = await AI._json(r);
        out = ((j.candidates || [])[0]?.content?.parts || []).map(x => x.text || "").join("");
      } else {
        // openai / openrouter / local — all OpenAI chat/completions compatible
        const base = p === "openai" ? "https://api.openai.com/v1"
                   : p === "openrouter" ? "https://openrouter.ai/api/v1"
                   : (AI.baseurl() || "").replace(/\/$/, "");
        const headers = { "content-type": "application/json" };
        if (AI.key(p)) headers["authorization"] = "Bearer " + AI.key(p);
        if (p === "openrouter"){ headers["HTTP-Referer"] = location.origin; headers["X-Title"] = "PCB RevEng"; }
        const r = await fetch(base + "/chat/completions", {
          method: "POST", headers, signal: ctrl.signal,
          body: JSON.stringify({ model, max_tokens: maxTok,
            messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        });
        const j = await AI._json(r);
        out = ((j.choices || [])[0]?.message?.content) || "";
      }
      entry.response = out;
      return out;
    } catch(err){
      entry.error = AI.isAbort(err) ? "⨯ cancelled" : (err && err.message || String(err));
      throw err;
    } finally {
      entry.ms = Date.now() - t0;
      AI._dropCtrl(ctrl);
      AI._record(entry);
    }
  },

  async _json(r){
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch(e){ j = null; }
    if (!r.ok){
      const msg = (j && (j.error?.message || j.error || j.message)) || txt || ("HTTP " + r.status);
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    return j || {};
  },

  /* strip ```json fences and pull the first JSON object/array out of a reply */
  parseJSON(text){
    if (!text) return null;
    let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    try { return JSON.parse(t); } catch(e){}
    const m = t.match(/[[{][\s\S]*[\]}]/);
    if (m){ try { return JSON.parse(m[0]); } catch(e){} }
    return null;
  },

  /* ---------- model listing ---------- */
  async listModels(){
    const p = AI.provider();
    const ctrl = AI._newCtrl();
    const t0 = Date.now();
    const entry = { kind: "models", provider: p, model: "", system: null, user: "GET /models", response: null, error: null, ms: 0 };
    try {
      let out;
      if (p === "gemini"){
        const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(AI.key(p)), { signal: ctrl.signal });
        const j = await AI._json(r);
        out = (j.models || []).map(m => (m.name || "").replace(/^models\//, "")).filter(Boolean);
      } else if (p === "anthropic"){
        const r = await fetch("https://api.anthropic.com/v1/models", {
          signal: ctrl.signal,
          headers: { "x-api-key": AI.key(p), "anthropic-version": "2023-06-01",
                     "anthropic-dangerous-direct-browser-access": "true" },
        });
        const j = await AI._json(r);
        out = (j.data || []).map(m => m.id).filter(Boolean);
      } else {
        const base = p === "openai" ? "https://api.openai.com/v1"
                   : p === "openrouter" ? "https://openrouter.ai/api/v1"
                   : (AI.baseurl() || "").replace(/\/$/, "");
        const headers = {};
        if (AI.key(p)) headers["authorization"] = "Bearer " + AI.key(p);
        const r = await fetch(base + "/models", { headers, signal: ctrl.signal });
        const j = await AI._json(r);
        out = (j.data || []).map(m => m.id).filter(Boolean).sort();
      }
      entry.response = out.length + " models: " + out.slice(0, 30).join(", ");
      return out;
    } catch(err){
      entry.error = AI.isAbort(err) ? "⨯ cancelled" : (err && err.message || String(err));
      throw err;
    } finally {
      entry.ms = Date.now() - t0;
      AI._dropCtrl(ctrl);
      AI._record(entry);
    }
  },

  /* ---------- feature 1: part / pin autofill ----------
     Given a component's package + value + part number (+ free-text hint), ask the model
     for pin names, a device class, and any BOM notes. Applies pin names by pin number. */
  async autofillPart(comp, hint){
    if (!AI.enabled("autofill")) throw new Error("AI part/pin autofill is disabled (🔬 Experimental)");
    const fp = compFootprint(comp);
    const pins = (fp.pins || comp.pins).map((p, i) => ({ num: (comp.pins[i] || p).num }));
    const sys = "You are an expert electronics engineer helping reverse-engineer a PCB. " +
      "Given a component's package, marking/value, part number and pin count, return ONLY a JSON object " +
      "with keys: \"device\" (short class e.g. 'NPN BJT','N-MOSFET','LDO','MCU','op-amp'), " +
      "\"pins\" (array of {\"num\":<pin number as string>,\"name\":<function name e.g. BASE/COLLECTOR/VCC/GND/GPIO1>}), " +
      "and \"notes\" (one-line extra info for a BOM: manufacturer, description, ratings). " +
      "Use the exact pin numbers given. If unsure, give best-guess and keep names generic. No prose, JSON only.";
    const usr = JSON.stringify({
      ref: comp.ref, package: fp.label || comp.fpId, value: comp.value || "",
      partNumber: comp.part || "", pinCount: pins.length,
      pinNumbers: pins.map(p => p.num), hint: hint || "",
    });
    const reply = await AI.chat(sys, usr, { maxTokens: 1500 });
    const data = AI.parseJSON(reply);
    if (!data) throw new Error("Model reply wasn't valid JSON:\n" + reply.slice(0, 300));
    return data;
  },

  /* ---------- feature 2: footprint maker ----------
     Free-text prompt → a .kicad_mod module string. Very experimental. */
  async makeFootprint(prompt){
    if (!AI.enabled("footprint")) throw new Error("AI footprint maker is disabled (🔬 Experimental)");
    const sys = "You generate KiCad footprints. Output ONLY a valid .kicad_mod S-expression " +
      "(a single (footprint ...) block, modern KiCad 6+ syntax) for the part described. " +
      "Include correctly-numbered pads with realistic sizes/pitch in millimetres, a courtyard, " +
      "silkscreen outline and a reference/value fp_text. Name pads by number; add pad names where a " +
      "connector/IC pin function is known. No markdown, no explanation — the raw S-expression only.";
    const reply = await AI.chat(sys, prompt, { maxTokens: 3000 });
    let t = reply.trim().replace(/^```(?:\w+)?\s*/i, "").replace(/```\s*$/, "").trim();
    const i = t.indexOf("(footprint");
    if (i > 0) t = t.slice(i);
    if (!t.startsWith("(footprint") && !t.startsWith("(module")) throw new Error("Model didn't return a footprint:\n" + reply.slice(0, 300));
    return t;
  },

  /* ---------- feature 3: schematic auto-arrange ----------
     Sends each part's size/pins/type + the netlist; expects {placements:[{ref,x,y,rot}]}
     in schematic mm. Returns that array (caller applies it). */
  async arrangeSchematic(){
    if (!AI.enabled("arrange")) throw new Error("AI schematic auto-arrange is disabled (🔬 Experimental)");
    const geo = (typeof Sch !== "undefined") ? Sch.geo() : schGeometry();
    const parts = [];
    for (const c of State.components){
      const g = geo.get(c.id); if (!g) continue;
      parts.push({ ref: c.ref, value: c.value || "", type: _refType ? _refType(c) : (c.ref||"?")[0],
        w: +g.w.toFixed(1), h: +g.h.toFixed(1),
        pins: c.pins.map(p => ({ num: p.num, name: p.name || "", net: p.netId ? (getNet(p.netId)?.name || "") : "" })) });
    }
    const sys = "You are a schematic layout engine. Place the given parts on a 2D schematic canvas " +
      "(millimetres, +x right, +y down, KiCad-style). Group by function, keep connected pins close, " +
      "put power at top and ground at bottom, avoid overlaps (respect each part's w/h). " +
      "Return ONLY JSON: {\"placements\":[{\"ref\":..,\"x\":..,\"y\":..,\"rot\":0|90|180|270}]}. No prose.";
    const usr = JSON.stringify({ parts });
    const reply = await AI.chat(sys, usr, { maxTokens: 4000 });
    const data = AI.parseJSON(reply);
    if (!data || !Array.isArray(data.placements)) throw new Error("Model reply wasn't valid placement JSON:\n" + reply.slice(0, 300));
    return data.placements;
  },
};

/* ---------- floating "AI working… [Cancel]" banner ---------- */
AI._ensureBusyUI = function(){
  if (document.getElementById("ai-busy")) return;
  const el = document.createElement("div");
  el.id = "ai-busy";
  // popover ("manual") puts the banner in the browser top layer, so its Cancel
  // button stays clickable even above a modal <dialog> (e.g. the footprint selector).
  if ("popover" in el) el.setAttribute("popover", "manual");
  el.style.cssText =
    "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:100000;margin:0;" +
    "display:none;flex-direction:column;align-items:center;gap:4px;padding:8px 14px;background:#1c222b;" +
    "color:#e6ebf1;border:1px solid #3c4856;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.6);" +
    "font-size:13px";
  el.innerHTML = '<div style="display:flex;align-items:center;gap:10px">' +
    '<span class="ai-spin" style="width:13px;height:13px;border:2px solid #4a5766;' +
    'border-top-color:#e0a94a;border-radius:50%;display:inline-block;animation:aiSpin .8s linear infinite"></span>' +
    '<span id="ai-busy-txt">AI working…</span>' +
    '<button id="ai-busy-cancel" style="padding:2px 10px">Cancel</button></div>' +
    '<div style="font-size:11px;color:#8b97a5">See the debug log afterwards in 🔬 Experimental → AI Connect</div>';
  if (!document.getElementById("ai-spin-style")){
    const st = document.createElement("style");
    st.id = "ai-spin-style";
    st.textContent = "@keyframes aiSpin{to{transform:rotate(360deg)}}";
    document.head.appendChild(st);
  }
  document.body.appendChild(el);
  el.querySelector("#ai-busy-cancel").addEventListener("click", () => {
    AI.cancel();
    if (typeof UI !== "undefined" && UI.toast) UI.toast("AI request cancelled");
  });
};

AI._updateBusy = function(){
  AI._ensureBusyUI();
  const el = document.getElementById("ai-busy");
  if (!el) return;
  const n = AI._ctrls.size;
  el.style.display = n ? "flex" : "none";
  const canPop = typeof el.showPopover === "function" && el.hasAttribute("popover");
  if (canPop){
    try {
      const open = el.matches(":popover-open");
      if (n && !open) el.showPopover();
      else if (!n && open) el.hidePopover();
    } catch(e){}
  }
  const txt = document.getElementById("ai-busy-txt");
  if (txt) txt.textContent = n > 1 ? ("AI working… (" + n + " requests)") : "AI working…";
};

/* render the debug log into #ai-debug-list (if the Experimental dialog is built) */
AI._renderLog = function(){
  const box = document.getElementById("ai-debug-list");
  if (!box) return;
  if (!AI._log.length){ box.innerHTML = '<div class="panel-hint">No requests yet.</div>'; return; }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, m => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;" }[m]));
  const clip = (s, n) => { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + " …[" + s.length + " chars]" : s; };
  box.innerHTML = AI._log.map(e => {
    const when = new Date(e.time).toLocaleTimeString();
    const head = esc(e.kind) + " · " + esc(e.provider) + (e.model ? "/" + esc(e.model) : "") +
      " · " + when + " · " + e.ms + "ms";
    const status = e.error ? '<span style="color:#e06b6b">' + esc(e.error) + '</span>'
                           : '<span style="color:#7dc98a">✓ ok</span>';
    const sys = e.system != null ? '<div style="color:#8fa">SYSTEM:</div><pre style="white-space:pre-wrap;margin:2px 0 6px">' + esc(clip(e.system, 1500)) + '</pre>' : '';
    const usr = '<div style="color:#9bd">REQUEST:</div><pre style="white-space:pre-wrap;margin:2px 0 6px">' + esc(clip(e.user, 2500)) + '</pre>';
    const rsp = e.response != null ? '<div style="color:#cda">ANSWER:</div><pre style="white-space:pre-wrap;margin:2px 0 0">' + esc(clip(e.response, 4000)) + '</pre>' : '';
    return '<details style="border:1px solid #333c48;border-radius:5px;padding:6px 8px;margin-bottom:6px;background:#181d25">' +
      '<summary style="cursor:pointer;font-size:12px">' + head + ' — ' + status + '</summary>' +
      '<div style="font-size:11px;margin-top:6px">' + sys + usr + rsp + '</div></details>';
  }).join("");
};

/* ---------- Experimental-dialog wiring ---------- */
function wireAI(){
  AI._ensureBusyUI();
  const prov = $("#ai-provider"), keyIn = $("#ai-key"), baseIn = $("#ai-baseurl"),
        baseRow = $("#ai-baseurl-row"), modelSel = $("#ai-model"),
        status = $("#ai-status");
  if (!prov) return;

  const syncFromStore = () => {
    prov.value = AI.provider();
    keyIn.value = AI.key();
    baseIn.value = AI.baseurl();
    baseRow.style.display = prov.value === "local" ? "" : "none";
    // rebuild model dropdown with the stored pick present
    const cur = AI.model();
    modelSel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = cur; opt.textContent = cur || "— pick / refresh —";
    modelSel.appendChild(opt);
    $("#ai-en-autofill").checked  = AI.enabled("autofill");
    $("#ai-en-footprint").checked = AI.enabled("footprint");
    $("#ai-en-arrange").checked   = AI.enabled("arrange");
    status.textContent = "";
  };

  prov.addEventListener("change", () => { AI._set(AI.LS.provider, prov.value); syncFromStore(); });
  keyIn.addEventListener("change", () => AI._set(AI.LS.key(prov.value), keyIn.value.trim()));
  baseIn.addEventListener("change", () => AI._set(AI.LS.baseurl, baseIn.value.trim()));
  modelSel.addEventListener("change", () => AI._set(AI.LS.model(prov.value), modelSel.value));
  $("#ai-en-autofill").addEventListener("change", e => AI._set(AI.LS.en("autofill"),  e.target.checked ? "on" : "off"));
  $("#ai-en-footprint").addEventListener("change", e => AI._set(AI.LS.en("footprint"), e.target.checked ? "on" : "off"));
  $("#ai-en-arrange").addEventListener("change", e => AI._set(AI.LS.en("arrange"),   e.target.checked ? "on" : "off"));

  $("#ai-refresh").addEventListener("click", async () => {
    AI._set(AI.LS.key(prov.value), keyIn.value.trim());
    AI._set(AI.LS.baseurl, baseIn.value.trim());
    status.textContent = "Fetching models…";
    try {
      const models = await AI.listModels();
      const cur = AI.model();
      modelSel.innerHTML = "";
      for (const m of models){
        const o = document.createElement("option"); o.value = m; o.textContent = m; modelSel.appendChild(o);
      }
      if (cur && !models.includes(cur)){ const o = document.createElement("option"); o.value = cur; o.textContent = cur; modelSel.insertBefore(o, modelSel.firstChild); }
      modelSel.value = cur || AI._defaultModel(prov.value);
      AI._set(AI.LS.model(prov.value), modelSel.value);
      status.textContent = models.length + " models";
    } catch(err){ status.textContent = "⚠ " + err.message; }
  });

  $("#ai-test").addEventListener("click", async () => {
    AI._set(AI.LS.key(prov.value), keyIn.value.trim());
    AI._set(AI.LS.baseurl, baseIn.value.trim());
    status.textContent = "Testing…";
    try {
      const r = await AI.chat("You are a test.", "Reply with exactly: OK", { maxTokens: 20 });
      status.textContent = /ok/i.test(r) ? "✓ Connected" : "Connected (reply: " + r.slice(0, 40) + ")";
    } catch(err){ status.textContent = "⚠ " + err.message; }
  });

  // debug log panel
  const dbgClear = $("#ai-debug-clear"), dbgRefresh = $("#ai-debug-refresh");
  if (dbgClear) dbgClear.addEventListener("click", () => AI.clearLog());
  if (dbgRefresh) dbgRefresh.addEventListener("click", () => AI._renderLog());

  // populate whenever the Experimental dialog opens
  const labBtn = $("#btn-lab");
  if (labBtn) labBtn.addEventListener("click", () => { syncFromStore(); AI._renderLog(); });
  syncFromStore();
  AI._renderLog();
}

window.addEventListener("DOMContentLoaded", wireAI);
