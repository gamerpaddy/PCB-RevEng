# Checking and Exporting

When the board is wired up, check it for loose ends and then export the result.

## Running the design check

Click the **Check** button next to the Nets title in the left panel. A report opens listing:

- Pads that have no net assigned. Click **Show on board** to jump to the first one.
- Pins whose net does not match a trace that touches them. Each mismatch has two fix buttons: one makes the pin take the trace net, the other makes the trace take the pin net.

Pads marked as no connect are left out of the report. When everything is clean the report says so.

## Exporting a netlist

Click **Export Netlist** in the top bar, or press Ctrl and E. The export box opens with a format dropdown and a preview.

The formats are:

- KiCad netlist, a .net file you import in Pcbnew through File then Import Netlist.
- KiCad schematic, a .kicad_sch file you open in Eeschema. Each part becomes a box symbol and the connections are carried by labels.
- CSV, a table with one row per pin.
- JSON, a structured file of the components and nets.

Pick a format and the preview updates. Then:

- Click **Copy** to copy the preview to the clipboard.
- Click **Download** to save it as a file.
- Click **Close** to leave without exporting.

## Saving the project file

Exporting a netlist does not save your project. To keep an editable copy, click **Save** in the top bar to download a project file. See [[Saving and Loading|Saving-and-Loading]].
