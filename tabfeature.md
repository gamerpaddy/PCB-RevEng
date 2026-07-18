# Multi-PCB pages (board tabs) — feature log

## Goal
Projects with several PCBs joined by connectors/cables. Each PCB = a "page" with its
own image layers, components, vias, traces, notes, schematic sheet. Nets are GLOBAL
across pages, so a connector on page 1 can carry the same net as one on page 2.
Bottom tab row switches pages in both the Visual and Schematic editors.
Off-page connector links: mark two (or more) connectors as the same physical
connection → nets merge pin-by-pin, and the inspector shows "go to page" jump buttons.

## Architecture (chosen: alias/repoint)
- `State.boards = [{id, name, layerCount, layers, components, vias, traces, notes, schWires, schLabels}]`
  plus `State.boardIdx`. The classic top-level `State.components` / `State.layers` / …
  are the SAME array references as the active board's — switching a page just repoints
  the aliases. All view/tools/ui code keeps working untouched on the active page.
- Global (project-wide): nets, bomColumns, refCounters, _id, pxPerMm, copperOz, viaR…
  Per-board scalar: `layerCount` (each PCB has its own stackup).
- state.js lookup/net/ref functions scan ALL boards (getComp/getVia/getTrace/getLayer/
  getNote, netMembers, netPinCount, pruneNets, mergeNets, refExists) so cross-page nets
  never get pruned/miss members and refs stay unique project-wide.
- New file `js/boards.js` — `Boards` global: bottom tab strip (#board-tabs), page
  add/rename/delete/switch, per-page camera memory, connector link UI.

## Serialization
- `serializeProject()` → version 2: `boards:[…]` + `boardIdx` (layers with bytes live
  inside each board). `loadProject` accepts v2 AND legacy flat files (wrapped into one
  board via `normalizeBoards()`).
- Undo `snapshot()` also boards-based; legacy snapshots (restored autosave_undo from an
  older session) are wrapped on the fly. Snapshot stores boardIdx → undo jumps back to
  the page where the edit happened. diffSnapshots/selectiveUndo flatten collections
  across boards (ids are globally unique).
- Page add/remove/rename are NOT undoable (like layer membership); delete confirms.
- autosave: serializeLight strips dataURLs inside each board; serializeImages covers
  all boards' layers; restore merges images back per board.

## Multiplayer
- Full-state LWW sync ships the boards array (mpCoreString/mpApplyCore boards-aware).
  Each peer keeps their OWN active page (matched by board id after an apply).
- mpHostViolation rights-diff flattens across boards.
- Cursors/live drags carry `bid` (active board id); remote cursors are hidden unless
  you're on the same page. Drag stream applies by global id lookup, so edits on other
  pages land correctly even while you're not looking at them.

## Connector links (off-page)
- `State.xlinks` = project-global link records `{id, a:compId, b:compId, map}` (v2:
  replaced the old comp.xlink group id; old saves auto-migrate in Boards.migrateLinks).
  `map` = `[[pinNumA,pinNumB],…]` or null (= all pins matched by number). A part can
  carry any number of links — e.g. a 4-pin connector linking pins 1,2 to a connector
  on page 2 and pins 3,4 (as its pins 1,2) to page 3 = two records with partial maps.
- Link dialog: live search box (ref/value/part/page, word-AND), pin field
  ("all" | "1,2" | "1→3, 2→4", validated against both parts' pin numbers).
- Inspector "Off-page links": one row per link (partner ref · page · pin label),
  per-link Go jump + per-link ✕ unlink, Sync nets (honours each link's map).
- Records ride in serialize/snapshot/undo/multiplayer like nets (top-level, global);
  stale records (deleted part/page) pruned lazily via Boards.pruneLinks.
- Pin-net merges go through mergeNets / releasePinWireNets (invariant preserved).

## Annotations (2026-07-18)
- Schematic: linked connectors draw a dashed line to the nearest sheet edge ("to
  infinity") with an edge chevron + "page · ref (pins)" label per link
  (schDrawOffPage). Clicking the chevron/label jumps to that page.
- Visual editor: linked parts get a floating "▶ page · ref" tag above them
  (drawXlinkArrows in view/overlays.js), hidden when zoomed out (part < 7 screen px
  radius); clicking the tag jumps (intercept in tools/core.js onPointerDown,
  hit rects in View._xlinkHits / Sch._xlinkHits).

## Cross-page visibility (2026-07-18)
- BOM (pane + CSV export) and parts CSV cover ALL pages; a "Pages" column appears in
  multi-page projects (bomGroups g.pages). Nets tab members span all pages, with a
  "Pages" column (multi-page nets highlighted); its focus buttons switch to the
  owning page first (ntGotoPage), and pad reassign deletes attachments from the
  owning board's arrays (ntDropFrom respects the active-page-alias invariant).
- Projects tab stats/count now read the v2 boards form ("2 PCBs · N parts · …");
  share/zip-images walk per-board layers.

## Scope notes / limitations (v1)
- KiCad netlist / schematic / EAGLE exports, checker, ratsnest run on the ACTIVE page
  (nets themselves are global).
- EAGLE/GENCAD import resets the project into page 1 (unchanged).
- Schematic pages mirror board pages 1:1 automatically (Sch reads the aliases).

## Progress
- [x] Plan
- [x] state.js: boards model, global scans, snapshot/undo, serialize/load/reset
- [x] js/boards.js: tab strip + page ops + camera memory
- [x] schematic pane shows the same strip (EditorTabs hook)
- [x] connector link UI + net merge + jump buttons (inspector injection)
- [x] autosave (light/images/restore)
- [x] multiplayer (core, rights diff, cursor bid, image sync)
- [x] index.html script tag + cache-buster bumps, style.css
- [x] test with dev server (see Testing below)

## Testing (2026-07-17, console-eval driven, all green, zero console errors)
- new page / rename / switch (tab clicks) / delete; per-page camera memory; selections cleared — OK
- objects on page 2 invisible on page 1 and vice versa; schematic mirrors pages — OK
- cross-page net survives pruneNets while its members are on the inactive page — OK
- global getComp/refExists across pages — OK
- per-page layerCount retained across switches — OK
- save → load round-trip v2 (boards, xlink, shared nets, boardIdx) — OK
- legacy v1 load (sample project, 53 parts + 3 image layers → wrapped into 1 page) — OK
- undo of a page-2 edit performed while viewing page 1 restores it and jumps to page 2 — OK
- selectiveUndo across pages (object-level restore, same semantics as before) — OK
- link J2→J1 across pages: shared xlink group, pin-1 nets merged; inspector section +
  Link dialog (lists only other-page parts) + Go jump (switches page, selects) — OK
- autosave: light JSON carries boards (bytes stripped per board), images stored, full
  page-reload restores 2 pages incl. decoded images — OK
- multiplayer (function-level, no live P2P): mpCoreString has boards / no boardIdx / no
  image bytes; mpApplyCore keeps the local page by board id and keeps local bitmaps;
  mpHostViolation flags cross-page object edits; cursor msgs carry `bid` — OK
- resetProject (New) → back to a single "PCB 1" page — OK
- tab right-click context menu (Boards.tabMenu via UI.showContextMenu): Switch (inactive
  tabs only) / Rename… / Delete page… (danger, only when >1 page); delete moved out of
  the raw right-click — menu is the extension point for future per-page actions
  (duplicate, move left/right, merge, per-page export) — OK

## Bugs found & fixed during implementation
- Editor code reassigns `State.traces = State.traces.filter(…)` etc. in ~30 places,
  which would detach the alias from the board record → boardsSyncScalars() now adopts
  the top-level arrays back into the active board and runs at every boards-reading
  entry point (allOf/boardOf/setActiveBoard/snapshot/serialize/selectiveUndo).
- releasePinWireNets only scans the ACTIVE page's schWires → Boards.syncLinkNets uses
  its own all-pages variant when joining nets on the other board.
- selectiveUndo restores whole objects: a later edit to the SAME object is lost when
  reverting an earlier one — pre-existing semantics, unchanged (documented here).
