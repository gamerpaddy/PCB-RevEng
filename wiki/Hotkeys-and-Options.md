# Hotkeys and Options

## Default hotkeys

These are the default keys. Single key shortcuts can be changed in the hotkey editor.

Tools

- S: Select and move
- C: Place component
- W: Draw trace
- V: Place via
- K: Cut a trace into two
- G: Align an image layer
- M: Measure a distance

View

- Mouse wheel: zoom at the cursor
- Space and drag, or middle mouse drag: pan
- F: flip the view front to back
- Z or Home: zoom to fit
- H: toggle the coverage mask
- X: toggle the X-ray overlay
- Plus and minus: zoom in and out from the center
- 1 to 9 and 0: switch the view to image layer 1 to 10
- Shift with a number: layers 11 to 20

Editing

- R: rotate 90 degrees, or Shift with R for 15 degrees
- B: flip the selected component to the other side
- L: lock or unlock the selected component
- D: cycle the active draw side
- N: name the net of the selection
- Delete or Backspace: delete the selection
- Escape: cancel the current action or clear the selection
- Enter: finish a trace
- Double click a pad, via or trace: name its net
- Double click a component: quick edit its reference and value

Project

- Ctrl and S: save the project file
- Ctrl and O: open a project file
- Ctrl and E: export a netlist
- Ctrl and Z: undo
- Ctrl and Y: redo
- Ctrl and D: duplicate the selected component
- The question mark key: open the help overlay

## Changing the hotkeys

Click the keyboard button in the top bar, between Options and the help button, to open the hotkey editor.

1. Click the key shown next to an action.
2. Press the new key. Press Escape to cancel.

If the key was already used by another action, it is taken from that action, which becomes unbound, and a message tells you. The Ctrl shortcuts, Escape, Enter, Space and the number keys are fixed and cannot be changed. Click **Reset to defaults** to restore every key.

## The help overlay

Click the **?** button in the top bar to open the help overlay. It lists the current hotkeys and a short workflow summary, and it has the **Load sample project** button. The list always reflects your current key bindings.

## Options

Click **Options** in the top bar to open the settings. The settings are:

- Copper layers: how many copper layers the board has. Adding inner layers adds them to the side selectors.
- Via size and Trace width: the display size of all vias and the display width of all traces.
- Components: show parts on both sides, or only the side you are viewing.
- Traces: show traces on all sides, or only the active side.
- Reference text: the size of the component labels.
- Overlap check: warn when a moved pad lands on copper of another net.
- Big merge warning: warn before joining two nets that each have more than three pads.
- History length: how many actions the undo timeline keeps.
- Units: millimetres or mils.
- Keys 1 to 0: whether the number keys switch the view to a layer or toggle the layer visibility.
