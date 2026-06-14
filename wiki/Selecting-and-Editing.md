# Selecting and Editing

The Select tool is the default tool. Use it to pick items, move them, and change their details in the Inspector.

## Selecting

With the **Select** tool active, click an item to select it. The Inspector on the right then shows its details. Click an empty area or press Escape to clear the selection.

- Click a component to select the whole part.
- Click a single pad to select just that pin.
- Click a via or a trace to select it.

## Moving

Drag a selected component or via to move it. Drag a trace corner handle to reshape a trace. A component that is move locked will not move; unlock it first.

## Multiple selection

- Hold Shift and click pads to select several pads at once. The Inspector then offers one Net field that applies to all of them.
- Hold Shift and click a trace to select every trace on its net.
- Hold Ctrl and click traces to add or remove single segments from a selection.

## The Inspector for a component

When a component is selected the Inspector shows:

- Move and edit locks.
- Reference, Value, Part name and KiCad footprint fields. These update as you type.
- Side, Rotation and Scale.
- A Polarized tick for parts that support it.
- Buttons to change the footprint, duplicate, and delete.
- A pin table listing each pin with its name, net and a no connect box. For freestyle parts the table also sets each pad type and size.

The Value field resolves codes when you leave it; for example a bare resistor code becomes a tidy value, while a value already written with a unit is kept as is. The small omega button next to the field opens the value resolver.

## Locking

A component can be locked so it is not changed by accident. There are two locks.

- Move lock stops it being dragged, rotated or flipped.
- Edit lock stops its fields and pins being changed and stops it being deleted.

Tick the locks in the Inspector, or right click the component and choose lock or unlock, or press the lock key to toggle the move lock.

## Quick edit

Double click a component to open a small box for just its reference and value. Type the new values and confirm. This is the fastest way to label many parts.

## Rotating, flipping, duplicating and deleting

- Press the rotate key to turn the selected part by 90 degrees, or hold Shift for 15 degrees.
- Press the flip side key to move it to the other side of the board.
- Press Ctrl and D, or use the Duplicate button, to make a copy with the next free reference.
- Press Delete or Backspace, or use the Delete button, to remove the selection.

You can also reach rotate, flip, duplicate, lock and delete by right clicking a component.

## Undo and history

- Click the undo and redo arrows in the top bar, or press Ctrl and Z to undo and Ctrl and Y to redo.
- Click the clock button in the top bar to open the undo timeline. Each past action has an **Undo this** button that reverts only what that action changed, leaving later edits to other items in place.
