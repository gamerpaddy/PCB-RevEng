# PCB RevEng User Guide

PCB RevEng is a workbench that runs in your web browser for reverse engineering printed circuit boards from photographs. You load photos of the front and back of a board, line them up, place component footprints on top, trace the copper, name the connections, and export a netlist you can open in KiCad.

Nothing is installed and nothing is uploaded. Everything runs locally in the browser and your work is saved inside the browser automatically.

## What you can do

- Load front, back and inner layer photos and align them so the pads line up.
- Set the real board scale so footprints are the correct size.
- Place resistors, capacitors, diodes, connectors, ICs and custom parts.
- Draw the copper traces and add vias where the copper changes sides.
- Group everything into nets and name the power and ground rails.
- Follow connections across sides with a split front/back view and ratsnest airwires.
- Pin sticky notes to the board, and estimate how much current a trace can carry.
- Check for unfinished work — including shorts between different nets — and export a KiCad netlist, a KiCad schematic, a CSV or a JSON file.

## Quick start

1. Open the page. On the first run a welcome box appears. Click **Load sample project** to explore a finished board, or **New project** to start your own.
2. To start your own board, drag a photo of the front of the board onto the canvas, then drag a photo of the back.
3. Set the back photo to the Back side and tick Mirror so it lines up with the front.
4. Use **Calibrate** to set the real size, then **Align** to make the back photo sit exactly under the front.
5. Switch to the component tool, place footprints, then use the trace tool to wire them together.
6. Name your nets, run the **Check** button, then click **Export Netlist**.

## Guide pages

- [[Getting Started|Getting-Started]]
- [[Loading and Aligning Photos|Loading-and-Aligning-Photos]]
- [[Setting the Board Scale|Setting-the-Board-Scale]]
- [[Placing Components|Placing-Components]]
- [[Drawing Traces and Vias|Drawing-Traces-and-Vias]]
- [[Working with Nets|Working-with-Nets]]
- [[Selecting and Editing|Selecting-and-Editing]]
- [[Notes and Annotations|Notes-and-Annotations]]
- [[Viewing the Board|Viewing-the-Board]]
- [[Checking and Exporting|Checking-and-Exporting]]
- [[Saving and Loading|Saving-and-Loading]]
- [[Hotkeys and Options|Hotkeys-and-Options]]
- [[Tips and Troubleshooting|Tips-and-Troubleshooting]]

## Where things are on screen

- The top bar holds the project buttons (New, Open, Save, Export Netlist), the tools (Select, Comp, Trace, Via, Cut, Note), the Draw on side selector, the view buttons (Flip view, Mask, Hide traces, X-ray, Split, Ratsnest, 3D), and the undo, history, Options, hotkey and help buttons.
- The left panel lists your image layers at the top and your nets at the bottom.
- The center is the board canvas.
- The right panel is the Inspector, which shows the details of whatever you have selected.
- The strip along the bottom shows the current tool, the cursor position, the zoom level and a hint for what to do next.
