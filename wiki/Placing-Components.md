# Placing Components

A component is a footprint with a reference, a value and a set of pins. You pick a footprint, set its details, then click the board to drop it.

## Opening the footprint picker

Click the **Comp** tool in the top bar, or press its shortcut. The footprint selector opens.

You can close the picker without placing anything by clicking **Cancel** or by clicking the dark area outside the box.

## Choosing a footprint

- The left column lists the footprint categories, such as chip resistors and capacitors, diodes, transistors, headers, DIP and SOIC packages, and a freestyle footprint for custom shapes.
- Click a category to select it. The first nine categories also have number key shortcuts shown on the buttons; press 1 through 9, or hold Shift or Ctrl for the later ones.
- The middle column shows the footprint settings and a live preview with a grid. Change settings such as the pin count or size and the preview updates.

## Filling in the details

The right column has four fields.

- **Reference** is the part name such as R1 or U3. Leave it blank to have it numbered for you, increasing each time you place a part.
- **Value** is the printed value such as 10k or ATmega328.
- **Part name** is the manufacturer part, such as LM358.
- **KiCad footprint** is the footprint library name used in the export.

### The value resolver

If a resistor is marked with a code rather than a value, click the small Greek omega button next to the Value field. The resolver opens.

- Type a surface mount code such as 103, 4R7, 01C, 5m or R005 into the SMD code box and the value is shown. Milliohm codes such as 5m and R005 are shown in milliohms.
- Or pick the colour bands of a through hole resistor from the dropdowns.
- Click **Use value** to drop the result into the Value field.

### The KiCad footprint search

Click in the KiCad footprint field and start typing. A list of matching KiCad footprint names drops down below the field. Click one to fill it in. This list comes from a large library of standard footprints, so you do not have to remember the exact name.

## Placing the part

1. Click **Place (click on board)**. The picker closes and a preview of the footprint follows your cursor.
2. Before you click, you can press the rotate key to turn it, and the flip side key to move it to the other side of the board. The hint at the bottom reminds you of these keys.
3. Click the board where the part belongs.

The part is dropped and selected, and its details appear in the Inspector on the right. To place another of the same type, just click again; the reference number increases automatically.

To stop placing, press Escape, or right click twice quickly.

## Resistors, capacitors and inductors in one category

The two pad chip category can be a resistor, a capacitor or an inductor depending on how you click.

- A plain click places a resistor (R).
- Shift and click places a capacitor (C).
- Ctrl and click places an inductor (L).

The reminder is shown in the dialog and in the bottom hint.

## Building a custom part with the freestyle footprint

Choose the freestyle footprint when no standard shape fits.

1. Place the part on the board.
2. With the part selected, look in the Inspector for the **+ Add pins** button and click it.
3. Click the board wherever a pad should be. Each click adds a numbered pad.
4. Press Escape or click the Done button when finished.

In the Inspector pin table you can set each pad to round through hole or rectangular surface mount, and set its size. You can also right click a single pad to switch its type or remove it.

## Marking polarity

For polarized parts such as electrolytic capacitors and diodes, the Inspector shows a Polarized tick that adds a plus marker by pin one. You can also right click a part and choose to make it polarized or not.
