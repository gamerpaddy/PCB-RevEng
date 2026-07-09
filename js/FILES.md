# js/ file map

Vanilla JS, no build. Every file is a classic `<script>` tag in `index.html` — all
top-level `function`, `const`, `let` become window globals. Load order matters only for
top-level `const` cross-file references (function bodies resolve at call time).

Cache-buster: bump `?v=` in `index.html` when editing a file so the browser reloads it.

## Root modules

| File | Purpose |
|---|---|
| `state.js` | State singleton, undo/redo stack, net registry (create/get/rename/merge/prune), ref-designator allocator, `nextId`, `SIDE_LABELS`, layer registry. Load first. |
| `main.js` | App bootstrap: wires the canvas, toolbar, keyboard, file drop, autosave, resize, hash routing. |
| `keymap.js` | Hotkey bindings + `Keys` down-state tracker; user rebindings persist to localStorage. |
| `resolver.js` | KiCad footprint-name → generated-footprint mapping used on import. |
| `netlist.js` | KiCad netlist / EESchema / .cmp import + export to KiCad netlist. |
| `eagle.js` | EAGLE `.brd` importer (nets, traces, vias, free footprints). |
| `gencad.js` | GENCAD `.cad` importer (huge boards, layerSetup fidelity). |
| `gerber.js` | Gerber layer import (silkscreen etc. as image layers). |
| `imagetiles.js` | Tiled image renderer for big scanned board photos. |
| `layerstack.js` | Layer stack editor: reorder, add/remove copper layers, colour, side. |
| `align.js` | Layer alignment tool (drag/rotate/scale, 4-point skew fit, 2-line deskew). |
| `autosave.js` | Autosave to localStorage every N s + startup restore. |
| `fpdialog.js` | Footprint-picker dialog (search, param editors, kicad-name lookup). |
| `kicadsearch.js` | KiCad-library fuzzy footprint search backing `fpdialog`. |
| `footprints.js` | Registry entry point + polar-mark params for generated footprints. |

## `footprints/` — generated footprint families

| File | Covers |
|---|---|
| `core.js` | Shared pad/pin builders, footprint-registry helpers. |
| `passives.js` | Chip resistors/caps/inductors, tantalum, MELF. |
| `discrete.js` | SOT/SOD/TO packages, diodes, transistors. |
| `connectors.js` | Pin headers, IDC, USB, JST, RJ45, screw terminals. |
| `ics.js` | SOIC, TSSOP, QFP, QFN, BGA (parameterised). |
| `misc.js` | Test points, mounting holes, jumpers, sticky-note-like pads. |

## `tools/` — pointer-driven editing (all globals; `Tools` state singleton in core.js)

| File | Exports |
|---|---|
| `core.js` | `Tools` object, `TOOL_HINTS`, `setTool`, pointer routing (`onPointerDown/Move/Up`, `handleDrag`), edge auto-scroll, `canvasPoint`, `updatePane`. Load first. |
| `select.js` | `selectDown`, `onDoubleClick`, trace-vertex insert/remove, `objNetId`, `assignNetToObject/Connected`, `applyNetRename`, `promptNetName`, `duplicateSelection`, `checkMoveOverlaps` (post-move DRC dialog). |
| `trace.js` | `traceDown`/`finishTrace`/`completeTrace`, `weldOrCreateTrace`, `mergeIntersectingTraces`, `traceConnectedCluster` / `connectedCluster` (flood-fill), `disconnectTrace`, `applyAttach`, `detachAnchor`, `connectVertToSnap`, `weldTraceAnchor`, `cancelTrace`. |
| `via.js` | `viaDown`, `handleViaDrop` (fold stacked + reconcile nets), `viaAttachedTraces`, `anchorTracesUnderVia`, `pruneCollinearAnchors`, `viaLandedNet`, `firstViaOverlap`, `foldViaInto`, `promptNetMerge`. |
| `checker.js` | `runChecker` (unnetted / mismatches / shorts), trace bbox helpers, `autoConnectPins` (adopt net under freshly-placed part). |
| `ops.js` | `componentDown` (place part), `measureDown`/`finishMeasure`, `noteDown`, `deleteSelection`, `rotateSelection`, `flipSelectionSide`, `cutDown` + `splitNetByConnectivity`, freestyle pins (`addFreePin`/`removeFreePin`), visual pad editor (`padSetSize`/`padSetPos`/`enterPadEdit`/`padResetOverride`/`ensureFreePin`), lock helpers. |

## `ui/` — panels, inspectors, dialogs (all attach to `UI` singleton)

| File | Exports |
|---|---|
| `core.js` | `UI` object + selection state (`sel`, `pinSel`, `traceSel`), status bar (`setStatusTool/Pos/Hint/Pad`, `toast`, `warn`), unit prefs, edge-scroll prefs, side-option HTML builders, `rebuildSideSelect`, `UI.select`, `bindLive`, `fmtLen`, `MM_PER_MIL`. Load first. |
| `layers.js` | Layer panel: list, side switch, visibility, active-layer chip, `UI.refreshLayerList`. |
| `nets.js` | Net-list panel: filter, hover, click-to-highlight, protected/hidden badges. |
| `parts.js` | Parts-list panel (BOM-like): filter, group, click-to-locate, ref-prefix stats. |
| `inspector.js` | Right-side inspector — pinned component/via/trace/note editors (mm/mil dual inputs, trace resistance calc `traceResistanceMilliOhm`, polarity toggle `compIsPolarized`, resistor-code helpers, `escAttr`). |
| `dialogs.js` | Export dialog (KiCad, image, JSON), BOM editor, right-click context menu, net-name popup, `openNetMergeDialog`/`openMultiMergeDialog`/`openNetScopeDialog`, checker results, selective-undo history, post-move overlap dialog. |
| `misc.js` | Quick edit (dblclick component), hotkey hints/help pane, hotkey editor / capture. |

## `view/` — geometry, hit-testing, rendering (all attach to `View` singleton)

| File | Exports |
|---|---|
| `core.js` | `View` object, `blinkNet`, `viewInit`, `viewResize`, `worldToScreen`/`screenToWorld`, `effDrawSide`, `paneSideOf`, `zoomAt`, `zoomToFit`, layer transform helpers (`layerEffScale`, `layerLinear`). Load first. |
| `geom.js` | Component/pad geometry: `pinWorldPos`, `compFootprint`, mm↔world, `padCornersWorld`, `pinEdgeDist`, `pinOBB`/`obbOverlap`/`padsOverlap`, `segOBB`, `padHitsSeg`, `compRadius`, `pointInComp`. |
| `hittest.js` | `hitTest` (topmost object under cursor), `snapToConductor`, segment math (`distToSeg`, `projectOnSeg`, `segsIntersect`, `minSegDist`), `tracesOverlap`, `tracesTouch`. |
| `render.js` | `requestRender` (rAF-coalesced), `render`, per-pane orchestration, visibility (`activeSide`, `effXray`, `compBodyVisible`, `traceVisible`, `viaVisible`), `drawWorld` main pass, crop/pad-edit/measure overlays, second-cursor mirror in split view. |
| `draw.js` | Color/highlight (`currentHighlightNet`, `netColor`, `focusAlpha`), `drawTrace`/`pathTrace`, `drawVia` (blind/buried arm rendering, `computeLabViaSet`, `viaArmCount`), `drawComponent` (bodies + pads + refs), align-tool banner and 4-point overlay, `captureAlignThumb`. |
| `overlays.js` | Ratsnest (`netNodes`, `mstEdges`, star-mode, hover-cap), coverage-mask tint (`renderMask`), sticky-note bubbles (`drawNotes`, `drawNoteBubble`, `roundRect`, `noteColor`). |

## Load order (see `index.html`)

`state → footprints/* → imagetiles → view/* → layerstack → tools/* → align → keymap →
resolver → netlist → eagle → gencad → gerber → ui/* → kicadsearch → fpdialog →
autosave → main`

Within a folder, `core.js` must load before its siblings (defines the singleton the
others attach to).
