# Viewing the Board

These controls change how the board is shown without changing the design.

## Panning and zooming

- Turn the mouse wheel to zoom in and out at the cursor.
- Hold the Space bar and drag, or drag with the middle mouse button, to pan.
- Press the zoom to fit key, or the Home key, to frame the whole board.
- Press the plus and minus keys to zoom in and out from the center.

## Flipping the view

Click **Flip view** in the top bar, or press its key, to look at the board from the back. The view mirrors so the back side reads correctly. The bottom strip shows BACK VIEW while flipped. Click again to return to the front.

## The X-ray overlay

Click **X-ray** in the top bar, or press its key, to see the copper and components from both sides at the same time. Copper on the side you are not drawing on is shown dimmed so you can tell the sides apart. This works whether or not you have a separate X-ray photo. If you do have an X-ray photo layer it is shown as well. Drawing still happens on the side chosen in the Draw on dropdown.

**X-ray turns on by itself when you view an X-ray photo.** If you switch the view to a layer whose side is X-ray, the overlay switches on for you, and switches back off when you leave that layer again. If you had turned X-ray on by hand it stays on and is left alone.

## Split view — front and back side by side

Click **Split**, or press **Y**, to cut the canvas into two halves that share one camera: the left half shows the front, the right half shows the back. The same board area lines up in both halves, so a pad in the left half sits directly across from the same pad in the right half. This makes it easy to follow a connection from one side to the other.

- A faint second cursor shows where your pointer is in the other half, so you always know which feature you are pointing at on the opposite side.
- The number keys choose what each half shows. Press **1 to 9 and 0** to set the **left** half to that image layer, and hold **Shift** with a number to set the **right** half. Each half can also be set from the small layer dropdown at its top.
- The **Draw on** dropdown sets the copper side of whichever half your cursor is in, so you can draw and select in either half.

Click **Split** or press **Y** again to return to the single view.

## Ratsnest — show what connects to what

Click **Ratsnest** to draw thin dashed "airwires" that show the logical connections of a net, no matter which layer the copper is on. The button cycles through three states, and its label shows which one is active:

- **Ratsnest: Net** draws a tidy tree linking every pad and via on a net. Hover or select a net to show just that one; otherwise every net is drawn faintly so the whole board's connectivity reads at a glance.
- **Ratsnest: Star** draws spokes from a single pad to every other pad it connects to. Just **hover a pad** to light up its connections, or select a pad to keep them shown. This answers "what does this pin go to". Vias are not drawn as spokes in this mode, only pads.
- **Off** hides the airwires.

## Hide traces

Click **Hide traces** to hide every drawn trace so you can read the bare photo, pads and vias underneath. While hidden, traces are also non-selectable, so you cannot grab one by accident. Click again to bring them back.

## Viewing without a photo

Press the **^** key (the caret key, top left on many keyboards) to switch the view to a plain black background with no photo, which is handy for reading just the copper and pads you have drawn. Press a number key to bring a photo back. In split view, plain **^** blanks the left half and **Shift + ^** blanks the right half.

## Following the draw side with the photo

Pressing the cycle draw side key (**D**) steps the active copper side through Front, Back and any inner layers. Hold **Shift + D** to also switch the shown photo to match the side you are now drawing on; if that side has no photo the view goes black.

## The coverage mask

Click **Mask** in the top bar, or press its key, to tint the areas of the board that do not have a component placed yet. This is a quick way to spot parts you have missed. Click again to turn it off.

## Fading everything except the selected net

When you select or hover a net, the rest of the board fades so the net you care about stands out. How far the rest fades is set by **Non-sel. opacity** in the **Options** dialog — a lower value fades the rest more.

## Showing only the active side

In the **Options** dialog you can choose whether components and traces on the side you are not viewing are shown or hidden.

- Components: viewed side only, or both sides. When set to viewed side only, parts on the far side are hidden but their through hole pads and vias still show. Surface mount pads only ever show on their own side.
- Traces: active side only, or all sides.

## Layer visibility and opacity

In the Image layers list on the left, use the eye button to hide a layer and the slider to change its opacity. The number keys switch the view between layers, or toggle their visibility, depending on the setting in Options.
