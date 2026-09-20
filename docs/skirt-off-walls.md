# Skirt-off wall frame: baseplate support, and the plate/wall interference

Notes for porting back to the Blender/Python original
([BlenderKeyboardGenerator](https://github.com/imadeathingie/BlenderKeyboardGenerator)).
Two separate topics:

1. **Landed** — the baseplate now builds in wall-frame mode as well as skirt
   mode. Ready to port.
2. **Landed** — the wall recess is now measured from the plate's outer face
   instead of its underside point, which removes ~75% of the plate/wall
   interference on boards with rotated keys. Ready to port.
3. **Landed** — the support ledge now follows the plate's real underside
   instead of one station's extrapolated plane. Ready to port.
4. **Landed** — the recess datum is pushed out past the plate's underside where
   that bulges beyond the outer face. Ready to port.
5. **Sample data** — wall-frame parameters added to the boards that lacked
   them; `staggered-6x5` now builds a clean frame with zero plate/wall
   interference.

---

## 1. Baseplate in wall-frame mode (landed)

Previously `buildBaseplate` / `build_baseplate` only worked with a fused skirt:
its footprint came from `skirtOuterRings`, which raises if `skirt` is false. So
a skirt-off board got a wall frame that was open at the bottom.

### The change

The wall sweep already walks every outer perimeter vertex and builds a 6-point
cross-section there. That per-vertex data is now factored out (`wallLoopFrames`)
so two callers share it:

```
WallFrame per perimeter vertex:
  b   = p - u * thickness        # plate underside point (p = top point,
                                 #   u = per-vertex offset normal)
  n   = outward XY normal        # from outwardNormalsXY
  rim = p.z + flange_z
  undersideZ(x, y)               # the underside plane through b
```

`buildWalls` consumes those frames; the geometry it emits is unchanged
(verified — see below). The new consumer is:

```
wallOuterRings(data):
    for each outer perimeter loop:
        ring = [ (b.x + n.x * flange_offset, b.y + n.y * flange_offset)
                 for each frame ]
```

That is exactly ring point 0 of the wall cross-section (`outer_bottom`) with
its z dropped, i.e. the polygon the frame's bottom face stands on at
`wall_base_z`.

`buildBaseplate` then picks its footprint by mode:

```
if skirt:  rings = skirtOuterRings(data)   # flared skirt outline
else:      rings = wallOuterRings(data)    # wall frame's outer face
```

Everything downstream (downward extrusion by `baseplate_thickness`,
triangulation with holes, cap winding) is unchanged.

### One extra rule for the wall-frame path

Screw clearance holes are admitted by testing whether the **whole circle**
lands inside the outline, not just its centre:

```
circle = circlePts(wx, wy, clearance_d / 2, segments)
fits   = all(pointInPoly(q, ring) for q in circle)   # wall frame
       = pointInPoly((wx, wy), ring)                 # skirt (unchanged)
```

Why: the skirt flares outward, so its footprint clears the bosses. The wall
frame hugs the plate edge, so a boss near the perimeter can produce a circle
that *crosses* the outline; cutting it leaves a self-intersecting polygon and
ear clipping fails outright. Observed on a test board with a boss at key 2,4:
centre inside, 9 of 32 circle points outside, `could not triangulate the
outline`.

The skirt path deliberately keeps the centre-only test so skirted boards stay
bit-identical to the Python core. **When porting, apply the strict test only to
the wall-frame branch** unless you also want to change skirt output.

### Verification performed

- `scripts/verify.ts` on a flat board and a tilted test board, before and after
  the `wallLoopFrames` refactor: identical vertex counts, bbox and checksum
  (`walls: verts=252 … checksum=-2939.607`). The refactor moved no geometry.
- New baseplate: watertight (0 non-manifold edges), spans `wall_base_z - t ..
  wall_base_z`, and every wall `outer_bottom` vertex has a matching baseplate
  top vertex (48/48 and 42/42) — so the frame lands flush and the two merge
  into one closed solid.

---

## 2. Plate/wall interference (investigated, NOT fixed)

### The defect

On skirt-off boards whose perimeter keys are **rotated**, the key plate and the
wall frame interpenetrate. Measured with a vertex-in-solid test (4-direction
ray parity) plus point-triangle penetration depth, with a 0.05 mm tolerance so
that the plate resting on the ledge is not counted as interference.

`Staggered_6x5`, skirt off:

| `vertical_edges` | plate → walls | walls → plate |
| --- | --- | --- |
| `true` | 7 verts, max 0.767 mm (keys 5,4 · 6,4) | 10 verts, max 0.627 mm (2,0 · 6,4 · 5,3 · 5,4 · 3,0 · 4,4) |
| `false` | 1 vert, max 0.135 mm (key 6,4) | 12 verts, max 0.830 mm (2,0 · 4,4 · 3,0 · …) |

Clean on boards that do not rotate their keys (`1.8x5`, `2.6x4_4`, `3.6x4_4`,
`4.6x4_4`). Present on `5/6/7/8.6x4_4`.

Driver isolated by ablation on `Staggered_6x5`:

| variant | plate → walls | walls → plate |
| --- | --- | --- |
| all `*_rot_algo` = 0 (height stagger kept) | clear | clear |
| tilt kept, `z_rot_algo` = 0 | 1.050 mm | 1.139 mm |
| `z_rot_algo` kept, tilt = 0 | clear | 0.388 mm |

So **tilt (`x_rot_algo` / `y_rot_algo`) is the dominant driver**; in-plane
rotation contributes little; key height does not matter.

### Where it actually is

Wall vertices are emitted in 6-point rings, so `index % 6` names the offending
corner. Counting penetrating vertices by corner:

| board / mode | penetrating wall corners |
| --- | --- |
| `Staggered_6x5` `true` | `ledge_inner`=10, `inner_top`=4, `ledge_top`=1 |
| `Staggered_6x5` `false` | `ledge_inner`=38, `ledge_top`=4, `inner_top`=4 |
| tilted test board `true` | `ledge_inner`=10, `inner_top`=1 |

And on the other side, the plate vertices inside the walls are mostly
**underside** vertices, not top-surface ones (6 vs 1, 13 vs 1).

**The dominant term is the ledge, not the recess wall.** Ring points 3 and 4
(`ledge_top`, `ledge_inner`) are placed on the perimeter station's underside
*plane*, extrapolated inward by `plate_lip`:

```
atLedge(offset):
    x = b.x + n.x * offset
    y = b.y + n.y * offset
    return (x, y, undersideZ(x, y))     # plane through b, normal u
```

The plate's underside is **faceted** — every key cell carries its own normal —
so extrapolating one station's plane inward by `plate_lip` (default 1.5 mm)
puts the ledge above the neighbouring facet's actual underside, and the ledge
rises into the plate. The error scales with the tilt difference between
adjacent cells, which is exactly what the ablation shows.

Note also that `staggered-6x5.json` ships **`plate_gap: 0`** — zero designed
clearance — so on that board any mismatch at all becomes interference.

### Measure at face level, not vertex level

A vertex-in-solid probe badly under-reports this defect: it found 17 offending
vertices on `Staggered_6x5` where an edge-vs-face test finds **95 crossings**.
The wall face slices across the plate's corner *between* vertices, with no
vertex of either mesh inside the other. Use an edge/face test:

> for every edge of each mesh, against every triangle of the other, count
> transversal crossings — strictly through the face interior, strictly between
> the edge endpoints. Resting contact is coplanar and produces no transversal
> crossing, so it is excluded by construction rather than by a tolerance.

---

## 3. The recess datum (landed)

### The change

All cross-section offsets used to run from `b = p - u*thickness`, the plate's
underside point. On a tilted key `b` slides sideways from the top point by
`u_xy * thickness` — 1.5–2 mm at 20–30° with a 4 mm plate — so the recess was
offset from a line the plate's face does not follow, and the wall cut through
the plate.

The datum is now a point on the plate's **outer face**:

```
dTop   = (p.xy - b.xy) · n
useTop = vertical_edges or dTop > 0
datum  = p.xy   if useTop else b.xy
```

With vertical edges the plate's outer face *is* the vertical surface through
the top perimeter point, so that is the datum outright. With sloped edges the
face runs `p -> b` and the recess must clear both ends, so the outermost along
`n` wins. `undersideZ` is unchanged — the ledge still rides the real underside
plane, which stays anchored at `b`.

Note this is the top perimeter point **itself**, not `b` projected outward
along `n` by `dTop`. That projection was tried first and is *twice as bad* as
doing nothing (95 → 188 crossings): it keeps the tangential error while adding
a radial shift. The distinction matters.

### Result (face-level crossings, `vertical_edges: true`)

| board | before | after |
| --- | --- | --- |
| `Staggered_6x5` | 95 | **24** |
| tilted test board | 87 | **24** |
| `1.8x5`, `2.6x4_4` (no rotation) | 0 | 0 |

Keys 5,4 and 6,4 — 34 crossings each, the worst on the board — go to **zero**.
On the vertex probe, plate-into-wall goes from 7 vertices (max 0.767 mm) to
completely clear.

`vertical_edges: false` is roughly neutral (wall-into-plate 12 → 8 vertices,
plate-into-wall 1 → 2); the datum only ever moves outward there, so the recess
cannot get tighter.

### Also tried: mitre scaling — do NOT port

`outwardNormalsXY` returns the *unit bisector* of the two adjacent edge
normals, so offsetting a vertex by `d` along it lands only `d·cos θ` from each
edge; the textbook correction is `d/cos θ` with a mitre limit. Implemented and
measured, it is **neutral at best**: 74 → 69 crossings at `plate_gap` 0.5,
44 → 42 at 1.0, no change at 0.25 or 1.5, and *worse* (18 → 24) once the datum
fix is in. Not worth the complexity. Note it can do nothing at all on
`staggered-6x5` as shipped, because that board sets `plate_gap: 0` and
`0 × mitre = 0`.

---

## 4. The support ledge (landed)

### The defect

Ring points 3 and 4 (`ledge_top`, `ledge_inner`) used to sit on the perimeter
station's underside *plane*, extrapolated inward by `plate_lip`:

```
atLedge(offset):
    x, y = datum + n * offset
    return (x, y, planeZ(x, y))     # plane through b, normal u
```

The plate's underside is **faceted** — every key cell has its own normal — so
that plane is only a local tangent. Extrapolated `plate_lip` (1.5 mm default)
inward it drifts off the real surface. Measured against the plate's actual
underside on `Staggered_6x5`:

| ledge point | height relative to real underside |
| --- | --- |
| `ledge_top` (ring 3) | −0.901 … −0.000, never above |
| `ledge_inner` (ring 4) | −1.166 … **+1.496**, above at 4 stations |

Positive = ledge inside the plate. The four offending stations were at keys
0,3 / 2,0 / 3,0 / 4,4 — exactly the keys in the residual crossing list, so the
correlation is not in doubt. Sweeping `plate_lip` confirms it scales: 0.1 → 64
crossings, 1.5 → 95, 3.0 → 116. `flange_offset` is irrelevant (0.5 → 107,
8 → 95). A flat board reads −0.000 everywhere.

Note the defect cuts both ways: −0.901 mm means the plate is *unsupported* by
almost a millimetre at other stations.

### The change

Each ledge station sits on the plate's real underside:

```
z[i] = min(planeZ(x, y), undersideSampleZ(x, y))
       # planeZ alone where the point is not over the plate at all, which is
       # the normal case for ledge_top out in the plate_gap
```

`undersideSampleZ` locates (x, y) in the plate's underside triangles —
rebuilt exactly as `buildShell` builds them: every vertex pushed down its own
offset normal, then the perimeter squared up when `vertical_edges` is set —
and interpolates barycentrically, taking the highest sheet.

### Result (face-level crossings, `vertical_edges: true`)

| board | before section 3 | + datum fix | + ledge fix |
| --- | --- | --- | --- |
| `Staggered_6x5` | 95 | 24 | **12** |
| test board | 87 | 24 | **12** |
| `5.6x4_4` … `8.6x4_4` | — | 50 | **35** |
| `1.8x5`, `2.6x4_4`, `3.6x4_4`, `4.6x4_4` | 0 | 0 | **0** |

`ledge_inner` no longer rises above the underside anywhere (max +1.496 →
0.000) and the ledge still supports: worst gap −1.166 mm, unchanged.

### Rejected variants — do not port

**Correcting the between-station bow.** The straight edge joining two ledge
stations can still bow up through a dipping underside, measured at +0.44 mm
(staggered) and +0.55 mm (test board). Two schemes for pulling it down were
implemented and both removed:

- *Drop each station to the minimum underside along its adjacent segments.*
  Reaches zero crossings on the staggered and test boards, but where
  neighbouring stations differ in height it gouges the ledge up to **6.9 mm**
  below the plate. No longer a support.
- *Drop each station by the measured bow*, shared between the two ends of a
  segment in proportion to how much each lifts the edge there (a bow at
  parameter `t` needs `drop_i·(1−t) + drop_j·t ≥ bow`). Much gentler, but still
  costs up to **0.66 mm** of unnecessary drop — a visible notch at the
  1,0 / 2,0 corner of the staggered sample, where sitting on the underside
  alone leaves the ledge exactly flush (`gap −0.00`). And it does not pay for
  itself: the staggered board goes from 12 crossings to 16. Charging the full
  bow to both ends instead of sharing it is blunter still: 40 crossings on the
  `6x4_4` family against 32 shared, 35 with no pass at all.

Raising the sample count per segment from 8 to 48 changes nothing, so none of
this is a sampling-density artefact.

### Ledge clearance

The ledge sits `LEDGE_CLEARANCE` = **0.05 mm** below the underside rather than
exactly on it. Placed flush, the two surfaces are coincident, so the swept
ledge grazes in and out of the plate by a few hundredths of a millimetre
wherever the underside curves between samples — geometrically an intersection,
and coincident faces are what slicers handle worst. 0.05 mm is well under one
layer height, so the plate still seats.

This is the one change that moves flat-board geometry: `1.8x5` walls go from
checksum 1576.800 to 1569.600, exactly 48 ledge points × 0.05 mm.

### Extra ledge stations (landed)

`subdivideForLedge` bisects a perimeter segment while its ledge still bows
through the plate, letting each new station sit on the underside like any
other. It runs in `wallLoopFrames`, so the baseplate inherits the same frame
list and stays flush; inserting on a straight run is harmless because the
recess and outer faces stay on the same lines.

The bow is sampled at three offsets across the ledge — outer edge, middle,
inner edge — not just at the two edges. The quad is bilinear, so it can bulge
through the plate in the middle while both edges stay clear; adding the middle
sample cut the worst overlap span on `Staggered_6x5` from 3.441 mm to 0.595 mm.

Station counts: `Staggered_6x5` 42 → 44, `5.6x4_4` 44 → 62.

A cautionary note on measurement: this was briefly removed as "inert" because
with the unqualified bulge (section 6) inflating the wall away from the plate,
the split predicate never fired and every metric was identical with and
without it. Once the wall was corrected to follow the plate, the bow reappeared
and the subdivision started earning its place. A change that looks like a no-op
may only be one because something else is broken.

---

## 5. The `6x4_4` family's 35 crossings — accounted for

Broken down by wall band and key, they are three separate things, none of them
a new defect:

**4 × `outer_face` — board configuration.** These boards set `"skirt": true`
and define no wall-frame parameters at all, so with the skirt forced off
`flange_offset` defaults to **0**: the frame's outer face lands exactly on the
plate's outer face and there is no wall material outboard of the plate. They
disappear entirely at `flange_offset >= 1`. Nothing to fix in the code; the
boards simply were not authored for wall-frame mode.

**3 × `recess_inner` at key 6,4 — the underside bulging past the outer face.**
Fixed; see section 6. All three were mid-span (t = 0.43, 0.60, 0.68 along one
perimeter segment) at z = 5.0–5.4, the plate's underside level.

**The remaining ~28** are the same between-station ledge bow as the other
boards, worse here (+0.781mm against staggered's +0.44mm) because the thumb
cluster puts long perimeter segments between strongly rotated keys.

### Mitre scaling: rejected three times, then adopted with a hard cap

`outwardNormalsXY` returns the unit bisector of the two adjacent edge normals,
so an offset of `d` lands only `d·cos θ` from each edge; the textbook fix is
`d/cos θ` with a mitre limit. Measured three times against earlier states of the
code and rejected each time — it never removed the hits it was aimed at and cost
crossings elsewhere:

| variant | `5.6x4_4` | `recess_inner @ 6,4` | staggered |
| --- | --- | --- | --- |
| none | 31 | 3 | 12 |
| mitre on all offsets | 33 | 4 | 12 |
| mitre on the recess offset only | 37 | 3 | 12 |

It was eventually adopted, **capped at 1.18**, once the riser in section 8 showed
what it is actually for. Uncapped it remains harmful: the `6x4_4` family goes
9 → 21 crossings and the fit opens from 0.60 mm to 0.87 mm. The cap is enough
for a riser and little else.

The lesson repeated throughout this file: a correction that measures useless
against broken geometry may be exactly right once the geometry is fixed.
Re-measure old rejections after each change.

---

## 6. The recess datum vs the underside bulge (landed)

### The defect

`vertical_edges` squares up the bottom vertices that lie ON the perimeter, so
the plate's outer face is vertical. But every neighbouring **interior** vertex
is still pushed down its own offset normal, which slides it sideways by
`|u_xy| * thickness` — about 1.2 mm on a key tilted 12°/8° with a 5 mm plate.
Where that pushes one past the perimeter, the plate's underside bulges out
through the recess, and the recess, built from the perimeter polygon, cannot
see it.

Measured on `5.6x4_4`: exactly one underside vertex outside the recess
polygon, at key 6,4, out by 0.072 mm at z = 5.15 — matching the three
`recess_inner` crossing heights (5.03–5.39) precisely.

### The change

After choosing the datum (section 3), push it out past whatever the local
underside actually reaches:

```
for j adjacent to vi:                       # adjacency from the top faces
    if (top[j].xy - datum) · n > 0: continue   # QUALIFYING TEST - see below
    bulge = max(bulge, (bot[j].xy - datum) · n)
if bulge > 0: datum += n * bulge
```

This only ever moves the datum **outward**, so it cannot tighten the fit.

**The qualifying test is essential.** A vertex only counts as a bulge if its
TOP sits at or inside this station's face and its underside has been pushed
outboard of it. Without it, "adjacent" means any vertex sharing a polygon —
including the far end of a connector spanning a whole key pitch — and
projecting another perimeter station onto this station's normal at a convex
corner reads as **14 mm** of bulge. Shipped briefly without the test, it blew
the top edge of every tilted board out to 7.61 mm instead of `flange_offset`
3 mm: the wall visibly stopped following the plate.

Note the crossing count does not catch this — a wall standing well clear of the
plate has *zero* crossings, so the defect scored perfectly. Always check the
footprint as well: the wall's bounding box should sit about `flange_offset`
outside the plate's on every side.

### The recess follows the plate's profile, not its widest point

Applying the bulge to the whole recess face makes it a vertical plane standing
at the plate's widest point. The plate is widest at the *underside* on a tilted
key, so that leaves a gap at the top — measured at 1.25 mm against a
`plate_gap` of 0.60 at key 7,4 of `8.6x4_4`, and visible in the viewport.

So the frame carries `bulge` rather than baking it into the datum, and the
cross-section opens out between the rim and the ledge:

```
ring 2  inner_top    at plate_gap                      # rim: tight to the top
ring 3  ledge_top    at plate_gap + bulge              # underside: clears it
ring 4  ledge_inner  at plate_gap + bulge - plate_lip
ring 5  inner_bottom at plate_gap + bulge - plate_lip
```

The outer face (rings 0 and 1) stays on the un-bulged datum, so the wall's
outside — and the baseplate footprint derived from it — follows the plate's top
outline.

Result: recess-to-plate distance is a uniform **0.60 mm** at every station on
both `8.6x4_4` and `staggered-6x5` (median 0.58–0.60, worst 0.60), and the
`6x4_4` family's crossings drop 27 → 23 as a side effect.

**Measure the gap, not just the overlap.** `edgeCross` counts intersections and
says nothing about a recess that is too loose; a separate probe taking each
recess vertex's distance to the plate's side faces is what caught this.

### Result (face-level crossings, `vertical_edges: true`)

| board | § 3 datum | + § 4 ledge | + § 6 bulge |
| --- | --- | --- | --- |
| `Staggered_6x5` | 24 | 12 | **2** |
| test board | 24 | 12 | **2** |
| `5.6x4_4` (flange_offset 3) | 50 | 31 | **26** |

Zero underside vertices remain outside the recess. The gain is much larger than
the three `recess_inner` hits it targeted, because moving the datum out also
carries the ledge outward onto underside it can sit on cleanly.

---

## 7. Wall parameters in the samples

The samples were authored for skirt mode, so several had no wall-frame
parameters at all and fell back to `flange_offset: 0` — a frame with no
material outboard of the plate. `staggered-6x5.json` additionally had
`plate_gap: 0` (a zero-clearance fit) and `vertical_edges: false`.

Added to `staggered-6x5.json` and every `[2-8].6x4_4.json`:

```json
"vertical_edges": true,
"flange_offset": 3,
"flange_z": 0,
"plate_lip": 1.5,
"plate_gap": 0.6,
"wall_base_z": 0
```

`plate_gap: 0.6` is what takes `Staggered_6x5` to **zero** crossings; 0.55 and
below still leave 2 at key 5,4. It is a loose-ish fit, but the alternative is a
frame the plate cannot drop into.

**These additions do not change skirt output at all** — `buildWalls` is never
called with a fused skirt, and `buildShell` forces `vertical_edges` true when
the skirt is on. Re-verified: every sample's shell/inserts/baseplate checksums
are unchanged (`Staggered_6x5` shell `-14307.598`, inserts `-32029.163`,
baseplate `-27323.210`).

### Where the samples stand in wall-frame mode

| board | crossings | worst overlap |
| --- | --- | --- |
| `staggered-6x5`, `1.8x5`, `2.6x4_4`, `3.6x4_4`, `4.6x4_4` | **0** | — |
| `5/6/7/8.6x4_4` | 21 | 0.121 mm (median 0.060) |

The `6x4_4` residual is well under one layer height. See section 8 for the
trade that sets it.

Three things to check on any change here, because each is blind to the others:

| check | probe | expected |
| --- | --- | --- |
| interference | edge-vs-face crossings | 0, or small spans |
| **fit** | recess vertex to plate side face | ≈ `plate_gap` everywhere |
| **footprint** | wall bbox vs plate bbox | ≈ `flange_offset` on every side |

Fit is a uniform 0.60 mm on `staggered-6x5` and `8.6x4_4`. Footprint is 2.1–3.0
mm against a `flange_offset` of 3 (under 3 only where the edge is tilted, which
is expected); `1.8x5` sits at its own `plate_gap` 0.25 since it sets no flange.

The remaining hits are all `ledge_top` / `inner_lower` pairs at the top row
(keys 1,0 · 2,0 · 3,0 · 4,0), overlap spans max 0.476 mm / median 0.219 mm.

They are **not** the between-station bow — that is fixed (the ledge surface is
below the plate everywhere it is sampled: `above=0`, worst quad interior
−0.008 mm). They sit at x = 10.3, 29.4, 48.4, 65.9, 85.0, which is midway
between consecutive top-row keys, and at `t ≈ 0` or `1` along a segment, i.e.
AT stations rather than between them.

Cause: that row steps 18 → 16 → 14 → 11 → 14 → 16 in z, so the plate's
underside at each junction is a steep, near-vertical connecting facet, which a
downward-ray height field cannot represent.

Two changes in section 8 cut this to 21 crossings at 0.121 mm.

---

## 8. The 1,0 / 2,0 riser (landed)

Where two adjacent keys are offset in **y**, the perimeter between them runs as
a near-vertical "riser" in plan. On `staggered-6x5` keys 1,0 (y −10) and 2,0
(y −2) give an 8 mm riser at x = 29.35, and the plate cut through the wall
there by 0.595 mm.

### Sample across the ledge, not just at its offset

The outer ledge point sits out in the `plate_gap`, where there is no plate
overhead, so `undersideSampleZ` returns null and the station's tangent plane is
all that constrains it — and that plane rides above the real underside just
inside the boundary. `ledgeHeights` now takes the lowest underside found
anywhere across the ledge's own radial span, binding it to geometry that
actually exists. This alone took the `6x4_4` family from 23 crossings to 9.

### Mitre, capped at 1.18

Both ends of the riser carry the same bisector normal, (−0.64, 0.77), against
the riser's own outward normal of (−0.98, 0.19): `cos θ` = 0.773, so the recess
was offset by only 0.773 × `plate_gap` and the plate cut through it.

A capped mitre (see above) fixes it. The cap matters enormously — this is a
severity trade, not a count trade:

| cap | staggered | `5.6x4_4` | fit |
| --- | --- | --- | --- |
| none (1.00) | 4 @ **0.595 mm** | 9 @ 0.028 mm | 0.60 mm |
| **1.18 (shipped)** | **0** | 21 @ 0.121 mm | 0.71 mm |
| uncapped (4.00) | 0 | 21 @ 0.121 mm | 0.87 mm |

Shipping 1.18 trades a 0.595 mm overlap on `staggered-6x5` — visible, and well
over a layer height — for 0.121 mm overlaps on the `6x4_4` family and 0.11 mm of
extra clearance. Reading counts alone would reject this trade; reading spans
accepts it. **If the `6x4_4` boards ever matter more than `staggered-6x5`,
setting the floor to 0.97 gives 5 @ 0.050 mm there and a 0.62 mm fit, at the
cost of 4 @ 0.118 mm on staggered** — every overlap tiny, none of them zero.

---

## 9. The skirt profile shapes the wall frame too (landed)

The fused skirt flares outward on its way down per `skirt_profile` /
`skirt_angle` / `skirt_flare`; the separate wall frame was a plain vertical face
at `flange_offset`. It now uses the same profile, so a board's shaping describes
the case whichever wall method is selected.

### The change

`wallOuterProfile` returns the outer face as (offset, z) pairs running rim to
base, using exactly the fused skirt's accumulation:

```
d = flange_offset          # the frame's face at the rim, not skirt_flange
z = rim
for each profile segment:
    dz = frac * (rim - wall_base_z)
    d += out   if the segment sets one, else dz * tan(angle)
    z -= dz    (the last segment lands exactly on wall_base_z)
```

The cross-section is that profile bottom-to-rim, then the four inner points, so
its size is now `skirtProfile(...).length + 5` rather than a fixed 6 — exported
as `wallRingSize` for tooling that walks the wall mesh station by station. With
no profile set, `skirtProfile` yields one zero-angle segment, giving two points
at the same offset: the plain vertical face as before, unchanged.

`wallOuterRings` takes the profile's **bottom** offset, so the baseplate matches
the foot the frame actually stands on.

### Result

`staggered-6x5` (15-step profile) now flares 9.2–11.9 mm beyond the plate at the
base instead of a flat 3.0; `8.6x4_4` flares 7.2–8.8 mm. `5.6x4_4`, which sets
no profile, stays at exactly 3.00 on every side. Interference and fit are
untouched — the profile only shapes the outer face.

### Collinear points in the baseplate outline

Subdividing places inserted stations exactly on the line joining their
neighbours (that is the point of `lerpFrame` — see below), so on a straight run
they are exactly collinear. Collinear points yield zero-area ears that the
triangulator cannot clip, and `5.6x4_4` and `6.6x4_4` failed to build a
baseplate at all. `dropCollinear` removes them from the outline; they carry no
shape information, so the polygon is geometrically identical, and every wall
foot vertex still sits at distance 0.000000 from the baseplate outline on all
nine boards.

### lerpFrame must not renormalise

An inserted station interpolates the normal **already scaled by its mitre**, and
carries mitre 1. Normalising the interpolated normal instead makes the offset
longer than a straight interpolation, so the station bulges off the line joining
its neighbours — harmless at a convex corner, but at a reflex one it pushes the
outer ring across itself and the baseplate fails to triangulate. Interpolating
the scaled normal makes every offset point the exact interpolation of the
neighbouring stations' corresponding points, at any offset, so subdividing adds
vertices along the swept surfaces without moving them.

---

## 10. Wide lips: the ledge across its width (landed)

Reported on a board with `plate_lip: 5`, `hole_size: 14.7`, `key_1u: 19.05`: the
wall frame near the 1,0 / 2,0 corner looked nothing like the plate's underside.
Measured — 67 crossings, worst overlap **9.63 mm**, ledge quad interior 3.27 mm
*inside* the plate while all four of its corners were within 0.15 mm.

Three separate causes, all specific to a wide lip.

### The ledge is now subdivided across its width

It used to be a single quad from `plate_gap` to `plate_gap - plate_lip`. A quad
is bilinear, so a wide one cannot follow an underside that changes across it.
At `plate_lip` 1.5 the error was tenths of a millimetre; at 5 it was 3.27 mm.

The ledge is now `ledgeStepCount(plate_lip)` steps of about `LEDGE_STEP` = 1 mm,
each sitting on the underside sampled at its own offset, so the ring size is
`skirtProfile(...).length + ledgeStepCount(...) + 4`. Exported as `wallRingSize`
and `wallLedgeSteps` for tooling. At `plate_lip` 1.5 this yields 2 steps, so
existing boards gain one mid-ledge point.

### The lip is clamped to the plate that is actually there

The decisive one. With a 14.7 mm cutout in a 19.05 mm cell there is only

```
max((key_1u - 3) / 2, hole_size / 2 + switch_border) - hole_size / 2
  = 8.85 - 7.35 = 1.50 mm
```

of border between the cell edge and the switch cutout, so `plate_lip: 5` put
the ledge **3.5 mm inside the cutouts**, where there is no plate to follow and
nothing to support. Sampling inward now reads null (out in the `plate_gap`),
then real (the border), then null again (the cutout); the ledge stops at the end
of that first solid run, per station. Crossings 62 → 18, worst overlap
3.69 mm → 0.403 mm.

Note this makes the ledge width vary per station, which is correct — it follows
however much plate is there.

### Missing samples use the nearest real one

Where a sample finds no plate overhead it now takes the nearest real sample
rather than the station's tangent plane, which had been extrapolating the ledge
off into space.

### Result on the reported board

| metric | before | after |
| --- | --- | --- |
| crossings | 67 | **18** |
| worst overlap | 9.632 mm | **0.403 mm** |
| median overlap | 1.092 mm | 0.403 mm (single span) |
| ledge quad interior | +3.270 mm | +0.696 mm |
| fit | 0.30 mm | 0.30 mm |

Ledge-to-underside gaps now run −0.01 to −0.09 mm over most of the perimeter,
i.e. the intended `LEDGE_CLEARANCE`. `5/6/7/8.6x4_4` improved 21 → 20 as a side
effect; every other board is unchanged, and all remain watertight and flush.

**A wide `plate_lip` is still worth questioning in board design**: on this board
anything past 1.5 mm has no plate to sit under, and a lip that far in would
foul the switch. The generator now clamps instead of producing nonsense, but it
cannot invent material.

### Also corrected: lowest sheet, not highest

`undersideSampleZ` took the *highest* sheet where several cover the same (x, y).
Where the underside folds over itself in plan, the plate has material above each
sheet, so a ledge rising from below must clear the **lowest**. This made no
difference on any current sample — no board folds that way — but the old rule
was wrong and would bury the ledge under a fold.

Re-measure with the edge/face probe, not a vertex probe — see section 2.

## Parity impact

The section 3 and section 4 changes both **alter skirt-off wall geometry**, so
`scripts/verify.py` and `scripts/verify.ts` will disagree on the `walls` line
for any board with tilted perimeter keys until the same changes are ported.
Flat boards (`1.8x5`, `2.6x4_4`, `3.6x4_4`, `4.6x4_4`) are unaffected and were
re-verified byte-identical (`walls: verts=288 … checksum=1576.800`): with a
level plate `u_xy = 0`, so `p.xy == b.xy` and the datum is unchanged, and the
underside sample equals the tangent plane so the ledge does not move either.

Skirt boards are **not** affected at all: `buildWalls` is never called with a
fused skirt. Re-verified — `Staggered_6x5` shell / inserts / baseplate
checksums are identical to before this work.

Section 1 additionally builds a baseplate for skirt-off boards that the Python
core does not build; `scripts/verify.ts` was deliberately left reporting
`walls` only for those boards, so the `diff py.out ts.out` workflow in the
README keeps working.

## 11. The lip wall style (landed)

A third case style, `"wall_style": "lip"`, for a keyboard set into a wooden
plank rather than a printed case. `wall_style` is authoritative and takes
`skirt` / `frame` / `lip`; with it unset the old `skirt` boolean still decides,
so every board written before this keeps its meaning and the Python core needs
no migration for existing files.

### The shape

The plate hangs from a lip whose top face is flush with the plank's surface.
Walking the outer surface from the plate's top edge:

| ring | offset | z |
| --- | --- | --- |
| 0 | `skirt_flange` | `lip_z + lip_thickness` |
| 1 | `skirt_flange + wall_thickness + lip_width` | `lip_z + lip_thickness` |
| 2 | same | `lip_z` |
| 3 | `skirt_flange + wall_thickness` | `lip_z` |
| 4… | profile, accumulating outward | down to the plate's underside |

then straight onto the plate's bottom perimeter — nothing hangs below the plate,
so `rimRing` is set to the plate's own bottom vertex and the inner column is a
single entry, which makes `stitchColumns` emit nothing.

### Why it cannot be a skirt_profile recipe

The profile's fractions are of **each vertex's own drop**. The lip has to land
on one flat machined shoulder, so its z is absolute, and the run from the plate
to it is therefore a different length at every station. Worse, it is not always
the same direction: on a tented board the lip can be above the plate at one end
of the board and below it at the other.

The first band carries that reversal without a special case. Where the lip is
higher it is the inside of a rim standing around the plate; where the plate is
higher it is the plate's own exposed side. Same quad, same winding — the normal
follows the z ordering, which is exactly how the surface flips. No branch, and
`lip_z` is free to cross the plate.

### The plank

Built directly, not by subtracting a pocket solid with CSG: a pocket cut that
way opens flush with the plank's top face, and a tool face exactly coplanar with
a target face is the one case the boolean handles badly (README, Known issues).
Extruding the ring levels and capping them is exact and costs nothing.

Two levels: the rebate from the surface down to `lip_z`, then a straight prism
right through the board, sized to clear the wall wherever it reaches furthest.
A wall that reaches out past the lip's outer edge is refused — that shape can
neither be dropped in nor routed.

### Only the clearance is mitred

Both the case and the recess offset their rings along per-vertex outward
normals, as the skirt already does. Offsetting a corner vertex by `c` along its
bisector leaves the faces either side of it just `c·cos(half-angle)` apart, so a
90° corner kept only 0.71 of the requested gap (measured: 0.222 against a
requested 0.3). Scaling by `1/cos` restores it.

The correction is applied to the clearance **alone**, not to the whole offset:
the case's own rings stay unmitred, so the recess still parallels the wall it
has to accept, and because the correction rides on a small quantity the same
`1/max(cos, 0.85)` cap the wall frame uses barely comes into play. After the
change the minimum gap is exactly `pocket_clearance` and corners run to 1.18×.

### Parity

The Python core has no lip style, so `scripts/verify.ts` reports `plank` for
these boards and `walls` / `baseplate` for every other, exactly as before. No
existing checksum moved.

### The profile shapes the INNER face (corrected)

First cut applied the profile to the wall's outer face, running from the lip
down to the plate. Two things were wrong with that.

The inner face — the one a key cap has to clear — was left as a plain band from
the plate's edge out to `skirt_flange`, so no profile a board set changed key
clearance at all. And with the run walked from the lip to the plate, a negative
angle pulled inward over the whole drop: on the reported board (`lip_z` 15,
`skirt_angle` -30) the wall reached **-3.11mm**, i.e. its outer face was inside
the plate's own edge.

Now the profile drives the inner face, walked from the plate towards the lip,
and the outer face is that same section carried out by `wall_thickness` — which
is what `constant_thickness_walls` asks for anyway. Positive is outward.

The outward component is taken from `|dz|`, not the signed rise. A board whose
plate crosses the lip plane travels up to reach the lip at one end and down at
the other, and a signed angle would open the well out at one end while cutting
into the plate at the other.

### Sizing the hole: keep the bearing-face ring

`lipWallReach` skips the lip's own rings, since the rebate is cut for those. It
must skip exactly three of the four — the lip's inner face, its top and its
outer edge. The fourth, where the bearing face meets the wall, is the **wall's
outer face at the shoulder**, and on a board whose plate rises above the lip it
is the widest the wall ever gets. Skipping it too undersized the hole by a whole
`wall_thickness`, and the case pushed through the shoulder: six plank edges
through the case, all at exactly `z = lip_z`.
