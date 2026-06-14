# Working with Nets

A net is a group of pads, vias and traces that are all connected together. Naming your nets, especially power and ground, makes the exported netlist much easier to read.

## The net list

The bottom of the left panel lists every net that has at least one connection. Each row shows a colour swatch, the net name, and the number of pads on it. The number in the panel title is the total count of nets.

## Searching the net list

Type in the **Search nets** box just above the list to filter it. Only nets whose name contains your text are shown, and the count updates to show how many match. Clear the box to see them all again.

## Naming a net

There are several ways to name a net.

- Double click a pad, a via or a trace on the board. A naming box appears. Type a name, pick one of the quick buttons, then confirm. The quick buttons cover common power and ground names plus the nets already in your project. The first nine quick buttons have number key shortcuts.
- Select a pad, via or trace and type into the Net field in the Inspector.
- Right click a pad, via or trace and choose **Set net**.

## Renaming a net from the list

Double click a net in the list to rename it. Protected power and ground nets cannot be renamed.

## Net colours

Click the colour swatch on a net row to choose a new colour for that net. Power and ground nets have fixed conventional colours.

## Focusing on one net

Click a net row once to highlight that net and dim everything else, which helps you trace it across the board. Click it again to clear the highlight.

## Protected power and ground nets

Common rails such as GND, VCC, VDD, plus 3V3, plus 5V and similar are protected. They keep their name, they keep their conventional colour, and they are never silently merged into another net. If you try to join two different protected nets the program refuses and tells you.

## How renaming spreads

When you name a pad or trace, only the copper actually connected to it takes the new name. Other pads that happened to share the old name but are not wired to this one keep their own name. Remember that surface mount pads only connect to copper on their own side, so naming a surface mount pad does not reach copper on another layer.

## No connect pins

If a pin is meant to be left unconnected, mark it as no connect so the checker does not warn about it. Right click the pad and choose the no connect option, or tick the NC box for that pin in the Inspector pin table.
