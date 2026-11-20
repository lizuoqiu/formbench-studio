# Pico indicator · ForgeCAD study

Independent source for two parts, in millimetres. The bottom shell has a USB opening and four bored posts; the lid includes a locating rim and apertures for two LEDs and one button. Nominal clearance is 0.25 mm per side. These are prototype dimensions, not a board or supplier fit certification. The lid is already in print orientation.

Use the official ForgeCAD 0.13.0 CLI in a personal, non-commercial local workflow, subject to its terms. No ForgeCAD runtime is bundled in this public frontend. From the repository root with the CLI installed:

```sh
forgecad run forge/pico-base.forge.js --details
forgecad export stl forge/pico-base.forge.js --output forge/pico-base.stl
forgecad export stl forge/pico-lid.forge.js --output forge/pico-lid.stl
forgecad export step forge/pico-base.forge.js --output forge/pico-base.step
forgecad export step forge/pico-lid.forge.js --output forge/pico-lid.step
```

For a length change, add `--param Length=72` to **both** part export commands. `Width` applies to both parts; `Height` applies only to the bottom. The CAD model is independent from the OpenSCAD revision in `samples/`: the rim is 1.65 mm thick and the outer post radius is 2.75 mm.
