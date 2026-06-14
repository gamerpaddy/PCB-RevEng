# Getting Started

## Opening the program

Open the page in a web browser. You can also open the local file directly from disk; the sample project and the footprint search are bundled so they work even without a web server.

## First run

The first time you open the program with an empty browser cache, a welcome box appears with two choices.

- Click **New project** to start with a blank board.
- Click **Load sample project** to open a finished example board so you can see how everything fits together.

If you have used the program before, it restores your last session automatically and the welcome box does not appear. To open the sample at any later time, click the **?** button in the top right and then click **Load sample project**. This replaces the current board, so save first if you want to keep it.

## The screen layout

- Top bar: project buttons on the left, then the tools, then the side selector and view buttons, then undo, history, Options, the hotkey editor and the **?** help button.
- Left panel: your image layers at the top, your nets at the bottom.
- Center: the board canvas where you do all the work.
- Right panel: the Inspector, which shows details of the selected item.
- Bottom strip: the current tool, the cursor position, the zoom percentage and a short hint.

## Picking a tool

The tools live in the top bar, in the group that reads Select, Comp, Trace, Via and Cut.

- **Select** moves and edits items.
- **Comp** places a component.
- **Trace** draws copper.
- **Via** places a via or a plated hole.
- **Cut** splits a trace into two.

Click a tool to switch to it. The active tool is highlighted and its hint shows along the bottom. Each tool also has a single key shortcut; hover the button to see it.

## A normal workflow

1. Load the front and back photos and line them up. See [[Loading and Aligning Photos|Loading-and-Aligning-Photos]].
2. Set the real board size with Calibrate. See [[Setting the Board Scale|Setting-the-Board-Scale]].
3. Place components. See [[Placing Components|Placing-Components]].
4. Draw traces and vias. See [[Drawing Traces and Vias|Drawing-Traces-and-Vias]].
5. Name your nets, especially power and ground. See [[Working with Nets|Working-with-Nets]].
6. Run the Check button and fix anything it lists. See [[Checking and Exporting|Checking-and-Exporting]].
7. Export the netlist.

## Saving

Your work is saved inside the browser automatically every few seconds. The text on the far right of the top bar shows when it was last saved. You can also click **Save** to download a project file as a backup. See [[Saving and Loading|Saving-and-Loading]].
