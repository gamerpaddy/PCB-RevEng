# Loading and Aligning Photos

Each photo of the board is an image layer. You stack the front, back and any inner layer photos and line them up so the same pad sits in the same place on every layer.

## Adding photos

There are three ways to add a photo.

- Drag one or more image files from your computer onto the canvas.
- Click **+ Add** at the top of the left panel, then choose the image files.
- Click **+ URL** to load an image straight from a web address (see below).

Each photo becomes a card in the Image layers list on the left. The program guesses the side from the file name; a name containing back or bottom is set to Back, one containing inner is set to an inner layer, and one containing xray is set to X-ray.

## Loading a photo from a web address

Click **+ URL** and paste the address of an image to load it live from the web instead of from a file. This is handy for quickly pulling in a photo that is already hosted online.

Please read the warning shown in the box: a hosted image is **not** saved inside your project — only the link to it is. The picture is fetched again every time you open the project, so if the link ever changes or goes offline the layer will disappear. Hosted layers are marked with a 🔗 in the layer list. For anything you want to keep, download the image and add it as a file with **+ Add** instead.

## Very large photos

Huge, high-resolution scans (many thousands of pixels across) are handled automatically. When you add a large image file, the program builds it into tiles at several zoom levels and only draws the parts you are looking at, at a detail level that matches your zoom. This keeps even gigapixel-sized photos smooth to pan and zoom, with no setup on your part.

## The layer card

Each layer card has these controls.

- The eye button shows or hides the layer.
- The name is shown in the middle.
- The cross button removes the layer. You are asked to confirm.
- The side dropdown sets which physical side this photo shows: Front, Back, an inner layer, or X-ray.
- The Mirror tick flips the image left to right. Back photos usually need this so they line up with the front.
- The Lock tick stops the layer from being dragged by accident.
- The Align button starts the four point alignment described below.
- The slider at the bottom sets the layer opacity.

Click the body of a card to make that layer the active one. The active layer is the one that align, deskew and dragging act on.

## Setting up front and back

1. Add the front photo. Leave it on Front.
2. Add the back photo. Set its side dropdown to Back. The Mirror tick turns on by itself so the back lines up with the front.
3. Lower the opacity of the top layer with its slider so you can see both photos at once while you line them up.

## Straightening a crooked base photo with Deskew

If your base photo was taken at an angle, use Deskew to remove the perspective and rotation before you align anything else.

1. Select the first layer in the list, which is the base layer.
2. Click **Deskew** at the top of the left panel.
3. Click the two ends of a line on the board that should be perfectly straight, such as a board edge.
4. Click the two ends of a second line that should be parallel to the first.

The photo is straightened and the two lines become level. Deskew is only available on the base layer, the first one in the list. Every other photo is lined up to the base with Align instead, so that deskewing a layer later cannot undo its alignment.

## Lining up a photo with Align

Use Align to make a second photo sit exactly on top of the base. This corrects position, rotation, scale and skew in one step.

1. Select the photo you want to move and click its **Align** button.
2. Click four features on this photo that you can also recognise on the base photo. Spread them out toward the corners for the best result. Good choices are corner pads or mounting holes.
3. The program then asks for the destinations. Switch the view to the base photo, then click the same four features in the same order on the base.

After the fourth destination click the photo snaps into place and a message reports how close the match was. The view returns to the layer you aligned.

## Quick adjustments by hand

With the Align tool active you can also nudge a layer directly.

- Drag the layer to move it.
- Hold Shift and drag to rotate it.
- Hold Alt and turn the mouse wheel to scale it.

Lock a layer once it is positioned so you do not move it by mistake.

## Switching which photo you see

Press the number keys 1 through 9 and 0 to jump the view to image layers 1 through 10. In the Options dialog you can change the number keys to toggle visibility instead of switching the view. In split view the numbers set the left half and Shift with a number sets the right half — see [[Viewing the Board|Viewing-the-Board]].
