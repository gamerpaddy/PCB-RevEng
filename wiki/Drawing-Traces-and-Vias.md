# Drawing Traces and Vias

Traces are the copper paths between pads. Vias are the holes that carry a connection from one side of the board to another. You draw traces on the side selected in the Draw on dropdown in the top bar.

## Choosing the side you draw on

The **Draw on** dropdown in the top bar sets the copper side that new traces and components use. It lists Front, Back and any inner layers. You can also press the cycle draw side key to step through the sides. When you click a back image layer the draw side switches to Back for you.

## Drawing a trace

1. Click the **Trace** tool in the top bar.
2. Click a pad, a via, or a point on an existing trace to start. The start point snaps onto the nearest pad or copper.
3. Click along the path of the copper to add corner points.
4. Finish by clicking the destination pad, by pressing Enter, or by double clicking.

If both ends land on pads that already have nets, the program joins those nets. If joining two large nets, it asks first so you do not connect them by mistake. When a trace connects two smaller nets, they are joined right away and a short notice appears at the top of the screen and fades by itself, so you can see it happened without having to click anything. Press Escape to cancel a trace you have started.

When a new trace crosses another trace on the same side, the program offers to join them so the copper stays connected.

## Trace width and the current estimate

Select a trace to see its width in the Inspector, shown in both **millimetres and mils** side by side; type into either box and the other follows. The Inspector also shows an estimate of how much current the trace can carry, worked out from its width, its length and the copper thickness, using the IPC-2221 guideline.

The copper thickness comes from **Options**, where you can set it separately for the outer layers and the inner layers, because inner copper is usually thinner (often 0.5 oz). The estimate is a guide for reading a board, not a substitute for a proper thermal calculation.

## Important: surface mount pads stay on their own side

A surface mount (rectangular) pad is copper on its own side only. A through hole (round) pad and a via reach every layer. This matters when you connect or rename copper: a surface mount pad does not join a trace or pad on a different layer just because they overlap in the photo. Only through hole pads and vias bridge layers.

## Adjusting a trace

Switch to the **Select** tool and click a trace to select it. Small handles appear at its corner points. Drag a handle to move that point. If you drop a handle on a pad, via or another trace, it connects there.

## Placing vias and plated holes

1. Click the **Via** tool in the top bar.
2. Click where the connection changes sides. The via snaps onto nearby copper and takes its net.

The click behaviour is:

- A plain click places a via and reuses the net of the last via, which is handy for stitching a ground pour.
- Shift and click places a fresh via with no reused net.
- Alt and click places a plated through hole, used for mounting and component holes.

Double click a via to name its net.

## Cutting a trace

Use Cut when a single drawn trace should actually be two separate nets.

1. Click the **Cut** tool in the top bar.
2. Click on the trace where it should be split.

A small gap is inserted. If the two halves are not connected anywhere else, they are given separate nets. If they are still joined elsewhere, the net is left unchanged and a message tells you so.

## Right click shortcuts

Right click on a pad, via or trace for a menu with the common actions, such as setting the net, clearing the net, marking a pad as no connect, changing a via type, selecting a whole net, or deleting the item.
