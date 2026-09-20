# Keyboard Case Generator (web)

A TypeScript port of the geometry core from
[BlenderKeyboardGenerator](https://github.com/imadeathingie/BlenderKeyboardGenerator),
rendering directly in the browser with three.js. Load a keyboard JSON
(definition or keylist), preview the plate/case, insert bosses and baseplate,
and export a millimetre-scale binary STL for printing. Fully static — no
backend.

## Layout

```
index.html              app shell
src/
  core/pyexpr.ts        sandboxed evaluator for Python-syntax *_algo fields
  core/keylistGen.ts    port of keylist_gen.py (definition -> keylist)
  core/core.ts          port of core.py (shell, skirt, walls, baseplate,
                        insert bosses, assembly transform)
  core/types.ts         shared data shapes
  viewer.ts             three.js viewport (parts registry, hover, fit view)
  stl.ts                binary STL + JSON download
  main.ts               UI wiring
public/samples/         predefined boards + manifest.json
scripts/verify.ts|py    parity harness (see Verification)
```

## Develop / build

```
npm install
npm run dev       # local dev server
npm run build     # static site into dist/
npm run verify    # rebuild the bundled sample and print mesh stats
```

## Verification against the Python original

`scripts/verify.py` (run against the Blender repo's `src/`) and
`scripts/verify.ts` print identical reports — vertex/face/triangle counts,
bounding box, coordinate checksum and a watertightness check — so a plain
`diff` proves parity:

```
python3 scripts/verify.py board.json /path/to/BlenderKeyboardGenerator/src > py.out
npx tsx scripts/verify.ts board.json > ts.out
diff py.out ts.out
```

**Exception:** the skirt-off wall recess is now measured from the plate's outer
face rather than its underside point, to stop the frame cutting into the plate
on boards with tilted keys — so the `walls` line diverges from Python on such
boards until that change is ported. See
[docs/skirt-off-walls.md](docs/skirt-off-walls.md). Flat boards and all
fused-skirt boards are unaffected.

The port currently matches the Python core exactly (to the printed
precision) on: the fused-skirt staggered sample, skirt-off walls, tent/pitch
lift, constant-thickness skirt erosion, `u_diff` wide keys, corner-named
`linked_keys`, inserts and baseplates. Assembly entries (`items`) are
composed at the app layer, mirroring the Blender add-on's
mirror → rotate → translate order.

## Adding sample boards

Drop a JSON file into `public/samples/` and list it in
`public/samples/manifest.json`:

```json
{ "id": "my-board", "name": "My board", "file": "my-board.json" }
```

Samples are fetched at runtime, so adding one needs no rebuild — on the
deployed site you can add files straight into the deployed `samples/`
directory.

## Hosting inside a Jekyll site (GitHub Pages)

The build uses `base: './'`, so `dist/` works from **any** subpath. Two
options:

**Option A — commit the build.** Copy `dist/` into your Jekyll repo as e.g.
`keyboard-generator/`, and add to the front of each copied HTML file nothing —
instead, tell Jekyll not to process the directory in `_config.yml`:

```yaml
include: []
exclude: []
keep_files: [keyboard-generator]
```

or simply place the folder and let Jekyll copy it through (static files pass
through by default; ensure no leading underscore in the folder name). The app
is then live at `https://you.github.io/site/keyboard-generator/`.

**Option B — build in CI.** Keep this project in its own directory (or repo)
and let Actions build both. Example job step sequence for a Jekyll +
generator monorepo:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- run: npm ci && npm run build
  working-directory: keyboard-generator-src
- run: cp -r keyboard-generator-src/dist site/keyboard-generator
- uses: actions/jekyll-build-pages@v1
  with: { source: site, destination: _site }
- uses: actions/upload-pages-artifact@v3
  with: { path: _site }
```

A ready-to-use workflow is in `.github/workflows/deploy-example.yml`.

## JSON quick reference

Everything the Python core reads is honoured; the important fields:

| field | meaning |
| --- | --- |
| `width`, `height` | key grid size |
| `x_algo` … `z_rot_algo` | per-key position/rotation expressions in `x`, `y`, `key_1u` (Python syntax, incl. `a if cond else b`) |
| `ignored_keys` | `[col, row]` cells to skip |
| `linked_keys` | explicit joins, optionally corner-anchored (`[c, r, "br"]`) |
| `u_diff` | wider/taller keys |
| `skirt`, `skirt_profile`, `skirt_angle`, `skirt_flange`, `wall_thickness` | fused case walls |
| `constant_thickness_walls` | erode a parallel inner wall instead of one sloped panel |
| `tent_angle`, `pitch_angle` | tilt the finished plate before walls |
| `inserts`, `insert_clearance_d`, `baseplate_thickness` | heat-set bosses + screw-hole baseplate |
| `vertical_edges`, `flange_offset`, `flange_z`, `plate_lip`, `plate_gap` | separate wall-frame mode (skirt off) |
| `wall_style` | `skirt`, `frame` or `lip` — overrides the `skirt` boolean |
| `lip_z`, `lip_width`, `lip_thickness`, `pocket_clearance` | lip style: the flange and its fit in the pocket |
| `plate_recess`, `plank_top_z`, `plank_thickness`, `plank_margin`, `plank_size` | lip style: the board the pocket is cut into |

`skirt_profile` / `skirt_angle` / `skirt_flare` shape the outer face in **both**
wall modes: with the skirt off the wall frame flares on the way down exactly as
a fused skirt would, starting from `flange_offset` at the rim. A board that sets
no profile gets the plain vertical frame as before.

The baseplate is built in **both** wall modes. With a fused skirt it follows
the skirt's flared outline; with the separate wall frame it follows the frame's
outer face at `wall_base_z`, so the frame's bottom lands flush on it and
showing both parts and exporting gives one closed case. Set
`baseplate_thickness` to 0 for no baseplate.

Porting notes for the Blender/Python original, plus a recorded investigation
into plate/wall interference on boards with tilted keys, are in
[docs/skirt-off-walls.md](docs/skirt-off-walls.md).

In wall-frame mode a screw clearance hole is cut only where the *whole* circle
lands inside the baseplate outline — the frame hugs the plate edge, so a boss
placed near the perimeter would otherwise produce a hole crossing the outline,
which cannot be triangulated. The skirt keeps the original centre-only test, so
skirted boards remain bit-identical to the Python core.

## Lip style: a plate hung in a plank

`"wall_style": "lip"` is for a keyboard set into a wooden board rather than a
printed case. The plate hangs from a **lip** whose top face is flush with the
plank's surface; the lip bears on the **shoulder** of a rebate, and the case
hangs through a hole cut right through the board. The tool generates the plank
alongside the case.

```
   plank ####┌──────────────┐####   ← lip top = plank surface
         ####└───┐      ┌───┘####   ← lip_z: bearing face, on the shoulder
         ####    │      │    ####
         ####     ╲    ╱     ####     wall, shaped by skirt_profile
             ══════╧══╧══════           (draws in on the way down)
                                       plate, hanging
             (hole goes right through)
```

The lip is pinned to an **absolute** height while the plate is wherever its own
`z_algo`, `tent_angle` and `pitch_angle` put it. So the wall has to travel from
the plate to the lip, and that run is a different length at every station — and
not always the same direction: on a tented board the lip can sit above the plate
at one end and below it at the other, leaving the plate proud of the wood there.

`skirt_profile` shapes that run, and it shapes the **inner** face — the surface
a key cap has to clear. The outer face is the same profile carried out by
`wall_thickness`, so the wall is of a piece whatever the profile does.

**`skirt_angle` is measured from the plate towards the lip, and positive is
outward.** A positive angle opens the well out as the wall rises, which is what
gives caps that overhang the plate's edge somewhere to go. The outward component
is taken from the distance travelled, not the signed rise, so the same angle
opens the wall out at both ends of a board whose plate crosses the lip plane. A
negative angle draws the wall in over the whole run and is refused as soon as it
would cut inside the plate's own edge.

That is why this is a mode and not a `skirt_profile` recipe. Profile fractions
are of each vertex's own drop, which cannot pin one end of the run to a flat
machined shoulder while the other end follows a tilted plate.

| field | meaning |
| --- | --- |
| `lip_z` | height of the bearing face — the shoulder is machined to match |
| `lip_width` | how far the lip projects past the wall |
| `lip_thickness` | the lip's thickness; `lip_z + lip_thickness` is the plank's surface |
| `wall_thickness` | the wall stands outside the plate's edge by this much |
| `skirt_flange` | shifts the wall outward from the plate edge (0 = flush) |
| `skirt_profile` etc. | shape the wall between the lip and the plate |
| `pocket_clearance` | gap between case and recess, held evenly all the way round |
| `plank_thickness`, `plank_margin`, `plank_size` | the board itself |

**Key clearance starts at `skirt_flange`, not at the angle.** The profile begins
at the plate's edge, so a cap corner sitting right at the plate's surface only
ever has `skirt_flange` of room however steep the angle. Rotated thumb keys
overhang the plate there, so if a cap fouls the wall, widen `skirt_flange`
first; the angle earns its keep further up.

**The wall must stay inside the lip.** The case has to drop into its own rebate,
so a wall reaching out further below the shoulder than the lip does above it is
refused with an error naming both offsets.

Nothing hangs below the plate in this style: the case is plate, wall and lip,
and the switches sit in the open under the board. There is no baseplate either
— the plank is the bottom. `wall_base_z` does not apply.

The plank's surface is the top of the lip, so it is not a separate setting.
Below the shoulder the hole is a **straight prism** sized to clear the wall
wherever it reaches furthest, so it routs in one pass with an ordinary straight
bit, and it goes right through the board. The plank is stock to be machined
rather than part of the keyboard, so cutouts and additions aimed at the case are
not applied to it.

Clearance is mitred at corners. Pushing a corner vertex out by `c` along its
bisector leaves the faces either side of it only `c·cos(half-angle)` apart, so a
90° corner would keep just 0.71 of the gap asked for; the correction is applied
to the clearance alone, leaving the recess parallel to the wall it has to
accept. Measured on the sample, the minimum gap is exactly `pocket_clearance`
and corners run to 1.18× it — never tighter than asked.

The `lip-in-plank` sample is a 4°-tented board hung in an 18 mm plank.

## Cutouts

Negative solids subtracted from the case — a USB opening, a TRRS jack, a reset
port. The **Cutouts** tab opens with a plan view like the key map: click a
cutout to select it, then click anywhere to move it there. The footprint drawn
is the real tool solid projected downward, so what you place is what gets
subtracted. Height, rotation and the shape itself stay in the card below, since
a plan view cannot show them.

Or write `cutouts` directly:

```json
"cutouts": [
  {
    "name": "usb-c",
    "parts": [
      { "shape": "cylinder", "r": 1.65, "h": 30, "pos": [-2.4, 0, 0] },
      { "shape": "cylinder", "r": 1.65, "h": 30, "pos": [ 2.4, 0, 0] }
    ],
    "rot": [90, 0, 0],
    "pos": [57.15, 10, 8],
    "targets": ["walls"]
  }
]
```

Two offset cylinders, hulled, give the elongated slot a USB-C socket needs —
the same thing you would write as `hull()` of two cylinders in OpenSCAD.

### Hull groups

Give pieces the same `group` and just those are hulled together. Each group
becomes its own solid and all of them are subtracted, so one cutout can carry
several hulled shapes — a counterbored slot for a pan-head screw, say:

```json
"parts": [
  { "shape": "cylinder", "r": 3.5, "h": 4,  "pos": [-2, 0, 12.2], "group": "head"  },
  { "shape": "cylinder", "r": 3.5, "h": 4,  "pos": [ 2, 0, 12.2], "group": "head"  },
  { "shape": "cylinder", "r": 1.6, "h": 40, "pos": [-2, 0, 10],   "group": "shank" },
  { "shape": "cylinder", "r": 1.6, "h": 40, "pos": [ 2, 0, 10],   "group": "shank" }
]
```

Two hulled slots: a wide shallow one for the head, a narrow deep one for the
shank. Groups may overlap freely — a cutout's groups are **unioned into one
solid** before anything is subtracted, so overlaps resolve into a single clean
boundary.

Pieces with no `group` fall back to `hull`: hulled together when true,
subtracted separately when false.

| field | meaning |
| --- | --- |
| `parts` | one or more pieces: `cylinder` (`r`, `h`), `box` (`size`), `sphere` (`r`), each with its own `pos` / `rot` / `segments` / `group` |
| `hull` | hull the *ungrouped* pieces into one solid. Defaults to true when there is more than one and no groups are used |
| `pos`, `rot` | place the finished shape on the board, in board coordinates (mm, degrees) |
| `targets` | which parts to cut: `plate`, `walls`, `baseplate`. Defaults to all three |

A cylinder points along **+Z** before rotation, so `"rot": [90, 0, 0]` aims it
along −Y — into a wall at the top of the board. Make `h` comfortably longer than
the wall is thick so the tool passes right through; anything sticking out into
fresh air costs nothing.

Cutouts are subtracted after each part is built, so they cut the fused skirt, the
separate wall frame and the baseplate alike. The result stays watertight — the
boolean stitches the T-junctions it creates — and a cutout that fails to build is
skipped with a warning rather than taking the model down with it.

Each cutout is unioned into a single solid before subtraction. Subtracting
overlapping pieces one after another is equivalent in exact arithmetic, but each
later pass has to clip its faces against the cavity the earlier ones opened, and
faces lying on that boundary are ambiguous — some survive as stray interior
faces and the model stops being closed. Unioning first avoids that entirely.

## Additions

The positive counterpart to cutouts: solids merged **into** the case — a collar
around a port, a boss, a stiffening rib. Same shapes, same hull groups, same
placement map, in the **Additions** tab or an `additions` array:

```json
"additions": [
  {
    "name": "usb collar",
    "parts": [
      { "shape": "cylinder", "r": 5, "h": 6, "pos": [-3, 0, 0], "group": "c" },
      { "shape": "cylinder", "r": 5, "h": 6, "pos": [ 3, 0, 0], "group": "c" }
    ],
    "pos": [57.15, -10, 12],
    "targets": ["plate"]
  }
]
```

Additions are merged **before** cutouts are subtracted, so a cutout bores
straight through a collar an addition put there — add the boss, then let the
port cut its own hole through both it and the case.

They become part of the solid they merge into, so they are not separate rows in
the Parts panel and they do land in the exported STL.

## Parts panel

Each part gets a row: a visibility checkbox, a colour well, and an opacity
slider. Editing either writes `part_colors` into the board JSON, so a colour
scheme travels with the design:

```json
"part_colors": {
  "plate": "#2e8b57",
  "inserts": "#fff",
  "baseplate": "#5f6a78aa",
  "cutout": "#ff00ff66"
}
```

CSS hex, `#rgb` / `#rrggbb` / `#rrggbbaa` — the fourth byte is opacity, so
`#5f6a78aa` is the default baseplate grey at two-thirds opaque. Any key you
leave out keeps its built-in colour. `cutout` sets the preview colour for every
cutout; a single cutout can override it with its own `"color"`. On an assembly,
`part_colors` on the assembly entry applies to every board it places, and a
board's own `part_colors` wins.

**Reset colours** appears once the entry has a `part_colors` and removes it
again.

Every cutout also gets a row, named after the cutout. Those rows show the
cutout's *solid* as a translucent preview so you can see where it sits in 3D —
useful with the placement map. They start hidden, and because a cutout is
negative space they are excluded from the vertex/triangle readout and from the
exported STL however they are toggled.

Turning a part's opacity down is the quickest way to see inside a closed case —
drop the plate to ~50% and the bosses and baseplate show through it.

## Known issues

**Wall frame vs plate underside at a "riser" corner.** Where two adjacent keys
are offset in Y, the perimeter between them runs as a near-vertical riser in
plan, and the support ledge there does not follow the plate's underside
exactly. Worst measured overlap is ~0.4 mm on the boards tested (down from
9.6 mm — see [docs/skirt-off-walls.md](docs/skirt-off-walls.md) for the whole
investigation). It is small enough to print but is not correct, and it is the
one place the wall visibly disagrees with the plate. Reproduces on
`staggered-6x5` at the 1,0 / 2,0 corner.

The remaining cause is that ledge placement samples the underside as a **height
field** (a downward ray, taking the lowest sheet). A height field cannot
represent the near-vertical connecting facet at a riser, so the ledge clears the
sheets either side of it while still cutting the facet between them. Fixing it
properly means placing the ledge against the plate as a *solid* — nearest point
on the underside mesh, or a containment test — rather than as a height field.

**A cutout face exactly coplanar with a case face leaves open edges.** When a
tool's face lies *in* the same plane as a face of the thing it cuts — a boss
milled flush with the outside of the wall, a pocket whose floor is exactly the
plate underside — both BSP trees emit polygons for that plane and the result
carries several overlapping coplanar patches sharing one edge. The mesh stays
the right shape and the right volume; it is only non-manifold along the seam,
which some slicers reject. Fixing it properly means reworking coplanar handling
in the splitter, so that one plane is resolved by exactly one tree.

Load [`bug-coplanar-faces`](public/samples/bug-coplanar-faces.json) to see it.
Its plate has a flat outer face at y=8.75. Cutout *flush (bug)* is a box whose
+Y face sits exactly in that plane, and leaves 4 open edges; *clear (control)*
is the same box moved 1 mm inboard, and is clean. Pulling a flush feature a
fraction off the face is the workaround.

**A cutout entirely inside the material removes nothing, silently.** A cutout
that breaks no surface — a buried void, a sealed cavity — has no effect at all.
Nothing warns you: no error, no open edges, and the model stays watertight, so
the only symptom is that the cavity is not there. A cutout that pokes out of the
material anywhere, even slightly, cuts correctly.

The cause is the localisation in `subtractOnce`: only target faces whose bounds
come within `pad` of the tool go through the boolean. A fully enclosed tool is
near *no* face of the target, so `near` comes out empty and the early return
treats it as "the tool misses the target entirely" — the one other way `near`
can be empty. The adaptive retry cannot catch it either, because the untouched
result is perfectly closed and so looks like a success. Distinguishing the two
cases (is the tool inside the target, or outside it?) is the fix.

Load [`bug-enclosed-cutout`](public/samples/bug-enclosed-cutout.json) to see it.
Cutout *buried (bug)* is a sphere at mid-slab that should remove 33.5 mm³ and
removes 0.000; *through (control)* cuts the same strip right through and removes
100.244 mm³ as expected.

License: the original project is GPL-3.0; this port should carry the same
license.
