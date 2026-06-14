# Tips and Troubleshooting

## Tips for clean results

- Photograph the board straight on with even light. Straighter photos are easier to align and the deskew step has less to correct.
- Deskew the base photo first, then align every other photo to it. Deskew is only offered on the first layer for this reason.
- Lower the opacity of the top layer while aligning so you can see both photos at once.
- Calibrate the scale early, using a known distance such as the 2.54 millimetre header pitch, so footprints are the right size from the start.
- Name power and ground nets as you go. They are protected and keep their colour, which makes the board easier to read.
- Use the coverage mask now and then to spot parts you have not placed yet.
- Run the Check button before exporting and clear every item it lists.

## A surface mount pad will not connect across layers

This is by design. A surface mount, rectangular pad is copper on its own side only. It does not join a trace or pad on another layer even if they overlap in the photo. Only through hole, round pads and vias bridge the layers. If you need a cross layer connection, place a via, or use a through hole pad.

## Naming one pad changed copper I did not expect

Naming a pad or trace spreads only to the copper that is actually wired to it. If two pieces of copper share a name but are not connected, naming one does not touch the other. If something unexpected changed, it was connected through a trace or via. Use the Cut tool to separate copper that should not be joined.

## The X-ray button does nothing useful

X-ray shows both sides at once and dims the side you are not drawing on. If your board is simple or you are zoomed in on one area the effect can be subtle. It does not need a separate X-ray photo to work.

## My work disappeared after reloading

Your work is saved inside this browser. It can be lost if you clear the browser data, use private browsing, or open the page in a different browser or on a different computer. For a portable backup, click **Save** to download a project file, and use **Open** to bring it back.

## The footprint search or the sample project does not load

These rely on data files that sit next to the page. When you open the page as a local file the program loads them through bundled script files, so keep those files together. If you moved the page on its own, copy the whole folder.

## I cannot place a component on top of another

Components are not allowed to stack on the same spot on the same side. Move the existing part first, or place the new one nearby and drag it into position.

## Resetting everything

Click **New** in the top bar to clear the board and the saved session. The next reload starts fresh and the welcome box appears again.
