# PCB RevEng - PCB Reverse-Engineering Workbench

### ▶ TRY IT OUT HERE: https://gamerpaddy.github.io/PCB-RevEng/

A zero-dependency web app for re-tracing electronic PCBs from photos and exporting
a netlist you can import into KiCad (or any EDA that reads KiCad netlists / CSV / JSON).

Plain HTML + CSS + vanilla JS. No build step, no CDN, no server-side code.

## Running

- **Locally:** just open `index.html` in any modern browser (double-click works - no server needed).
- **On a web host:** upload the folder to any static host (nginx, GitHub Pages, S3, …).
- **Dev preview:** any static server, e.g. `python -m http.server 8741`.

Your session **autosaves to the browser** (IndexedDB, images included) - F5 or
closing the tab loses nothing; "New" clears it. Use Save/Open for files you
want to keep or move between machines.

## Workflow

1. **Load photos** - drag & drop front / back / inner-layer images onto the canvas
   (or “+ Add” in the Layers panel). Side is guessed from the filename; back photos
   are auto-mirrored (⇋) so they overlay the front view correctly.
2. **Align** (`G`) - drag the active layer to move, `Shift`+drag to rotate,
   `Alt`+wheel to scale, or use the **Align** button on a layer: click four
   features **on that layer** (each click is numbered and shows a thumbnail of what
   you clicked), then click the four matching positions on the reference - a side
   strip shows the source thumbnails so you know which feature to match next.
   Offset, rotation, scale **and skew** are solved by least squares. Or use the
   **Deskew** button: click two lines that should be parallel & axis-aligned (e.g.
   two board edges) and the image is straightened and perspective-corrected (the
   correction is baked into the layer bitmap). Use the opacity sliders to onion-skin
   layers while aligning. Number keys 1…0 switch the view to a layer
   (Shift = +10), or toggle visibility - pick the behavior in *Board / display*.
3. **Calibrate**  - Click calibrate in the left toolbar, drag along a known dimension (e.g. a 2.54 mm header pitch
   ×10) and enter the real length in mm. Footprints then render at true board scale.
4. **Place components** (`C`) - footprint selector with parametric DIP / SOIC / TSSOP /
   QFP / QFN / SOT-23-323-523-723 / SOT-223 / SOT-89 / DPAK / TO-92 / TO-220 /
   chip R-C / headers / BGA-grid / test points,
   plus a **Freestyle** footprint: place the body anywhere (even off-board) and drop
   its pins one by one with “+ Add pins” in the Inspector; each freestyle pad's type
(THT / SMD) and size are editable per-pin. The selector has a
   quick-search box (type to filter, ↑/↓ to pick, Enter to place), and the **Ω**
   button next to Value decodes SMD resistor codes (103, 01C, 4R7, 4k7…) or
   computes THT color bands.
   Assign reference, value, part name and KiCad footprint; `R` rotates, `B` flips side.
   Pin names and per-pin nets are editable in the Inspector.
5. **Trace** (`W`) - click a pad, follow the copper, click the destination pad.
   Endpoints snap to pads, vias **and existing traces** - start on a trace to branch
   off and keep its net, and traces that cross on the same copper side are joined
   into one net automatically. Pick the copper side in the toolbar (`D` cycles);
   the board's copper layer count (1–12, adds inner layers) and the global
   via/trace display sizes live in the *Board / display* panel. `V` places vias
   to hop sides. `K` is the **Cut** tool: click a trace to sever it - the app
   re-derives connectivity and gives disconnected halves separate nets.
   By default only the active side's traces are shown (vias and pads always are)
   and far-side component bodies are hidden, pads dimmed - both switchable in
   *Board / display*. Selecting a layer (card click, side change, or number key)
   also switches the draw side to match.
6. **Name nets** - double-click any pad/via/trace (or use the Inspector / net panel).
   Hovering or selecting highlights the whole net across the board; `F` flips the
   view to work from the back.
7. **Export** (`Ctrl+E`) - KiCad netlist (`.net`, import via Pcbnew → File → Import
   Netlist), a **KiCad schematic** (`.kicad_sch`, open directly in Eeschema - each
   part becomes a boxed symbol with global-label nets, since Eeschema can't import
   netlists), CSV, or JSON. `Ctrl+S` saves the whole project (including images) as
   one JSON file; reopen it with `Ctrl+O` or drag & drop.

Press `?` in the app for the full hotkey list. All single-key shortcuts are
rebindable via the ⌨ **Hotkey editor** in the top bar (saved in the browser).
Board & display settings live in the ⚙ **Options** menu. Components have separate
**move** and **edit** locks (`L` toggles the move lock); locked parts show a 🔒.
The **Mask** toggle (`H`) darkens board areas that have no components yet (and
tints them red), leaving placed parts bright, so you can see at a glance what's
left to identify on a crowded board.

**Nets & protection.** Power nets (GND, VCC, VDD, VSS, +3V3, +5V…) are *protected
prefabs* (🛡): they can't be renamed and never get silently merged into a signal
net by an accidental crossing - you'll get a warning instead. Renaming a net only
affects the copper actually wired to the object you edit (connectivity is
re-derived), so two unconnected nets that happen to share a name stay independent;
renaming a pin's net follows through to its connected traces. Shift-click pads to
multi-select and assign one net to all of them at once.

**History.** The 🕒 **Undo timeline** lets you revert a single past action without
undoing everything after it - it restores only the objects that action touched.
Length defaults to 25, adjustable in Options. Standard `Ctrl+Z`/`Ctrl+Y` still work;
`Ctrl+D` duplicates the selected component with the next free reference.

**Editing.** Double-click a component for a quick Reference + Value popup (Value
auto-resolves SMD codes). Inspector fields commit as you type - no Enter needed.
Components have independent **move** and **edit** locks. Moving a component warns
you (once the move ends) if a pad now overlaps copper of a different net, offering
to merge or undo - this check is toggleable in Options. Vias can't stack on each
other but may sit inside pads (the via wins when you click an overlapping spot);
components can't stack either.

**More tools & display.** Traces only auto-join on a real crossing or shared
junction - parallel traces running close together are never merged, and a genuine
overlap asks before connecting. Select a trace to get **drag handles** on every
vertex; **shift-click** a trace selects its whole net, **ctrl-click** builds a
multi-segment selection. The **Check** button (Nets panel) lists pads with no net
and pin/trace net mismatches (with one-click reconcile); mark a pin **NC** in the
inspector to exclude it. Clicking a net in the list flashes it 3× on the board.
The footprint preview shows a 1 mm grid; the selector remembers your last category,
parameters and value; far-side parts show only through-hole pads and vias. Options
also controls reference-label size and undo-history length (default 25). The ⊕
button next to any net field generates a fresh unique net name. The whole session
autosaves in the background without the periodic hitch (images are stored once,
not re-encoded every tick). The **undo timeline persists** too, the top-right
shows when it last saved ("saved 2m ago"), and reopening the page shows a brief
"loading saved session" splash while it restores. The **coverage mask** now
clears each part's actual footprint outline plus a small halo (so a wide IDC
connector no longer wipes the whole board). Double-clicking a via (or pad/trace)
opens a net-name popup with quick-select buttons for GND/VCC/… and existing nets;
placing vias reuses the last via's net for stitching (Shift-click for a fresh
one). Radial caps can be **round or square (foil)** with a proper body outline.
Joining two large nets (each >3 pads) asks for confirmation - toggle in Options.

**Sides, selection & units.** Component visibility follows the **active side**
(the layer/draw-side you're working): the far side shows only its through-hole
pads and vias, so a front SMD part doesn't bleed through when you're on the back.
Components are selected by their **actual outline** (body + pads), not a bounding
circle, so a wide connector is only grabbable on its body. Vias and **PTH**
(plated through holes, Alt-click with the via tool) are distinct primitives with
their own size; the via inspector switches between them. Values **auto-resolve**
SMD codes as you type (103→10k, 01C→10k) while R/k/M notation like 220R stays
literal - no apply click. Trace anchors drag freely (no snap). The "connect two
nets" prompt's *No* now abandons the trace instead of connecting it. Measurements,
the position readout and the footprint-preview grid can switch between **mm and
mil** in Options. The footprint library gained MELF, SMD electrolytic, SOD/SMA-C
diodes, screw terminals, JST, MSOP, crystals and mounting holes.

## Files

- `index.html` - app shell, toolbar, dialogs
- `css/style.css` - dark EDA-style theme
- `js/state.js` - data model, nets, undo/redo, project save/load
- `js/footprints/` - parametric footprint library, split by category:
  `core.js` (registry/generator/renderer) + `passives.js`, `discrete.js`,
  `connectors.js`, `ics.js`, `misc.js` - each registers its footprints via
  `Footprints.register(def)`
- `js/view.js` - canvas renderer, pan/zoom/flip, hit testing
- `js/tools.js` - select / place / trace / via / align / measure tools
- `js/keymap.js` - rebindable hotkey system (persisted in localStorage)
- `js/resolver.js` - resistor value resolver (SMD codes, EIA-96, color bands)
- `js/netlist.js` - KiCad / CSV / JSON exporters
- `js/ui.js` - panels, inspector, footprint & export dialogs
- `js/main.js` - event wiring, hotkeys, file I/O
