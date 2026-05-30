# Wimp Node Editor

Browser-based tool for authoring property graph data (`{codeName}.json`) used by the pathfinding API.

Open `node-editor.html` directly in a browser — no build step or server needed.

---

## Setup

Fill in **Property name**, **Code name**, and **ID** in the header before exporting.

Use the **floor bar** at the top to add, duplicate, rename, or renumber floors.
Upload a floor plan image with **Floor BG** to use as a visual reference (not saved to the JSON).

---

## Modes

| Mode | What it does |
|------|--------------|
| **Add** | Click the map to place a node of the selected type |
| **Connect** | Click a node, then click another to toggle their connection |
| **Select** | Click a node on the map or in the list to edit its properties |

Press **Escape** to cancel any in-progress operation.

---

## Placing nodes

Select a type from the dropdown, then click the map. IDs are auto-generated.

**Leaf nodes** (Unit, Amenity, Elevator, Stairs, Escalator) trigger a two-phase flow:
1. The leaf node is placed.
2. The cursor switches to crosshair — place the **stop node** by:
   - Clicking a **corridor line** → stop is inserted between the two endpoint junctions.
   - Clicking a **junction node** → stop is wired to that junction only.
   - Clicking **empty space** → freestanding stop (connect it manually later).

Cross-floor nodes (Elevator, Stairs, Escalator) require a **Shaft ID** in the properties panel to link floor instances.

---

## Editing nodes

In **Select** mode, click any node to open its properties on the right panel. You can rename, change the ID, edit connections, add shaft IDs, and move the node on the map. Click **Save** to apply, or **Delete** to remove the node.

---

## Import / Export

- **Import JSON** — loads an existing property file and populates the editor.
- **Export JSON** — downloads the current state as a property file ready for the API.
