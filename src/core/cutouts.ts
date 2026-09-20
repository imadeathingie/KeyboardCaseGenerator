/**
 * Shapes placed on the case: cutouts subtracted from it (a USB opening, a TRRS
 * hole) and additions unioned into it (a collar around a port, a stiffening
 * rib). Both are described the same way and built by the same code.
 *
 * A cutout is one or more primitives, optionally hulled together, then rotated
 * and moved into place. Hulling two offset cylinders gives the elongated slot a
 * USB-C socket wants, which is the shape this is mostly for.
 */

import { rotXYZ } from './core';
import { unionAll } from './csg';
import type { Mesh, Vec3 } from './types';

// ------------------------------------------------------------- primitives

/** Cylinder about +Z, centred on the origin. */
export function cylinderMesh(r: number, h: number, segments = 32): Mesh {
  const n = Math.max(3, Math.floor(segments));
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  const hz = h / 2;
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    vertices.push([r * Math.cos(a), r * Math.sin(a), -hz]);
    vertices.push([r * Math.cos(a), r * Math.sin(a), hz]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i * 2, j * 2, j * 2 + 1, i * 2 + 1]);   // side, outward
  }
  const bottom: number[] = [], top: number[] = [];
  for (let i = 0; i < n; i++) { bottom.push((n - 1 - i) * 2); top.push(i * 2 + 1); }
  faces.push(bottom, top);
  return { vertices, faces };
}

/** Axis-aligned box centred on the origin. */
export function boxMesh(sx: number, sy: number, sz: number): Mesh {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const vertices: Vec3[] = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
  ];
  const faces = [
    [0, 3, 2, 1], [4, 5, 6, 7],           // -Z, +Z
    [0, 1, 5, 4], [2, 3, 7, 6],           // -Y, +Y
    [1, 2, 6, 5], [0, 4, 7, 3],           // +X, -X
  ];
  return { vertices, faces };
}

/** Sphere centred on the origin (UV mesh, triangle fans at the poles). */
export function sphereMesh(r: number, segments = 24): Mesh {
  const n = Math.max(4, Math.floor(segments));
  const rings = Math.max(2, Math.floor(n / 2));
  const vertices: Vec3[] = [[0, 0, r]];                 // north pole
  for (let i = 1; i < rings; i++) {
    const phi = (Math.PI * i) / rings;
    for (let j = 0; j < n; j++) {
      const th = (2 * Math.PI * j) / n;
      vertices.push([
        r * Math.sin(phi) * Math.cos(th),
        r * Math.sin(phi) * Math.sin(th),
        r * Math.cos(phi),
      ]);
    }
  }
  vertices.push([0, 0, -r]);                            // south pole
  const south = vertices.length - 1;
  const at = (i: number, j: number) => 1 + (i - 1) * n + (j % n);

  const faces: number[][] = [];
  for (let j = 0; j < n; j++) faces.push([0, at(1, j), at(1, j + 1)]);
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < n; j++) {
      faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
    }
  }
  for (let j = 0; j < n; j++) faces.push([south, at(rings - 1, j + 1), at(rings - 1, j)]);
  return { vertices, faces };
}

// ------------------------------------------------------------- convex hull

/**
 * Convex hull of a point cloud, as a closed triangle mesh.
 *
 * Incremental: seed a tetrahedron, then for each remaining point delete the
 * faces it can see and rebuild a cone over the horizon.
 */
export function convexHull3D(points: Vec3[]): Mesh {
  const pts = points;
  if (pts.length < 4) throw new Error('hull: need at least 4 points');

  const d2 = (a: Vec3, b: Vec3) =>
    (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 =>
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  // Seed: two extreme points, then the farthest from that line, then from the
  // plane of those three.
  let i0 = 0, i1 = 0, best = -1;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = d2(pts[i], pts[j]);
      if (d > best) { best = d; i0 = i; i1 = j; }
    }
  }
  if (best <= 0) throw new Error('hull: all points coincide');

  let i2 = -1; best = -1;
  for (let i = 0; i < pts.length; i++) {
    const c = cross(sub(pts[i1], pts[i0]), sub(pts[i], pts[i0]));
    const a = dot(c, c);
    if (a > best) { best = a; i2 = i; }
  }
  if (i2 < 0 || best <= 1e-18) throw new Error('hull: points are collinear');

  const nrm = cross(sub(pts[i1], pts[i0]), sub(pts[i2], pts[i0]));
  let i3 = -1; best = 1e-12;
  for (let i = 0; i < pts.length; i++) {
    const v = Math.abs(dot(nrm, sub(pts[i], pts[i0])));
    if (v > best) { best = v; i3 = i; }
  }
  if (i3 < 0) throw new Error('hull: points are coplanar');

  // Faces as index triples, wound so the normal points outward.
  let faces: [number, number, number][] = [];
  const addSeed = (a: number, b: number, c: number, inside: Vec3) => {
    const n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    faces.push(dot(n, sub(inside, pts[a])) > 0 ? [a, c, b] : [a, b, c]);
  };
  const centre: Vec3 = [
    (pts[i0][0] + pts[i1][0] + pts[i2][0] + pts[i3][0]) / 4,
    (pts[i0][1] + pts[i1][1] + pts[i2][1] + pts[i3][1]) / 4,
    (pts[i0][2] + pts[i1][2] + pts[i2][2] + pts[i3][2]) / 4,
  ];
  addSeed(i0, i1, i2, centre);
  addSeed(i0, i1, i3, centre);
  addSeed(i0, i2, i3, centre);
  addSeed(i1, i2, i3, centre);

  const EPS = 1e-9;
  const visible = (f: [number, number, number], p: Vec3) => {
    const n = cross(sub(pts[f[1]], pts[f[0]]), sub(pts[f[2]], pts[f[0]]));
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return dot(n, sub(p, pts[f[0]])) / len > EPS;
  };

  for (let ip = 0; ip < pts.length; ip++) {
    if (ip === i0 || ip === i1 || ip === i2 || ip === i3) continue;
    const p = pts[ip];
    const seen = faces.filter(f => visible(f, p));
    if (seen.length === 0) continue;                 // inside the hull so far

    // Horizon = edges of the visible set used exactly once.
    const count = new Map<string, [number, number]>();
    const uses = new Map<string, number>();
    for (const f of seen) {
      for (let k = 0; k < 3; k++) {
        const a = f[k], b = f[(k + 1) % 3];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
        if (!count.has(key)) count.set(key, [a, b]);
      }
    }
    const seenSet = new Set(seen);
    faces = faces.filter(f => !seenSet.has(f));
    for (const [key, n] of uses) {
      if (n !== 1) continue;                          // interior to the patch
      const [a, b] = count.get(key)!;
      faces.push([a, b, ip]);
    }
  }

  // Reindex to the points actually used.
  const used = new Map<number, number>();
  const vertices: Vec3[] = [];
  const out: number[][] = [];
  for (const f of faces) {
    const ids = f.map(i => {
      let v = used.get(i);
      if (v === undefined) { v = vertices.length; used.set(i, v); vertices.push(pts[i]); }
      return v;
    });
    out.push(ids);
  }
  return { vertices, faces: out };
}

/** Convex hull of several solids: the hull of all their vertices. */
export function hullMeshes(meshes: Mesh[]): Mesh {
  const pts: Vec3[] = [];
  for (const m of meshes) pts.push(...m.vertices);
  return convexHull3D(pts);
}

// ------------------------------------------------------------ definitions

export type CutoutTarget = 'plate' | 'walls' | 'baseplate';

export interface CutoutShape {
  shape: 'cylinder' | 'box' | 'sphere';
  /**
   * Pieces sharing a group name are hulled together into one solid. Lets a
   * single cutout carry, say, a hulled pair for a pan head and a second hulled
   * pair for the shank below it.
   */
  group?: string;
  /** cylinder: radius; sphere: radius */
  r?: number;
  /** cylinder: length along its axis before rotation */
  h?: number;
  /** box: full size */
  size?: Vec3;
  segments?: number;
  /** Placement of this piece within the cutout, before the cutout transform. */
  pos?: Vec3;
  rot?: Vec3;
}

export interface CutoutSpec {
  name?: string;
  /**
   * One or more pieces. Pieces are hulled by their `group`; ungrouped pieces
   * follow `hull` — together into one solid when true, separately when false.
   */
  parts: CutoutShape[];
  hull?: boolean;
  pos?: Vec3;
  rot?: Vec3;
  /** Which parts of the case to cut. Defaults to every part. */
  targets?: CutoutTarget[];
  /** Preview colour, #rrggbb or #rrggbbaa. Overrides part_colors.cutout. */
  color?: string;
}

function placed(s: CutoutShape): Mesh {
  let m: Mesh;
  switch (s.shape) {
    case 'cylinder':
      m = cylinderMesh(s.r ?? 1, s.h ?? 1, s.segments ?? 32); break;
    case 'box':
      m = boxMesh(...(s.size ?? [1, 1, 1])); break;
    case 'sphere':
      m = sphereMesh(s.r ?? 1, s.segments ?? 24); break;
    default:
      throw new Error(`cutout: unknown shape '${String(s.shape)}'`);
  }
  const rot = s.rot ?? [0, 0, 0];
  const pos = s.pos ?? [0, 0, 0];
  return {
    vertices: m.vertices.map(v => {
      const r = rotXYZ(v, rot[0], rot[1], rot[2]);
      return [r[0] + pos[0], r[1] + pos[1], r[2] + pos[2]] as Vec3;
    }),
    faces: m.faces,
  };
}

/**
 * Build a cutout as its separate solids, in board coordinates.
 *
 * They are kept apart rather than merged because they may overlap — a pan head
 * sits on its shank — and subtracting them in turn gives target minus their
 * union, which is what overlapping negatives should mean. Merging overlapping
 * shells into one tool would leave interior faces the boolean treats as
 * boundary.
 */
export function buildCutoutSolids(spec: CutoutSpec): Mesh[] {
  const parts = spec.parts ?? [];
  if (parts.length === 0) throw new Error('cutout: needs at least one part');

  // Bucket by group; ungrouped pieces share one bucket when `hull` asks for it.
  const named = new Map<string, Mesh[]>();
  const loose: Mesh[] = [];
  for (const p of parts) {
    const mesh = placed(p);
    const g = typeof p.group === 'string' ? p.group.trim() : '';
    if (g === '') loose.push(mesh);
    else (named.get(g) ?? named.set(g, []).get(g)!).push(mesh);
  }

  const solids: Mesh[] = [];
  for (const group of named.values()) {
    solids.push(group.length > 1 ? hullMeshes(group) : group[0]);
  }
  if (loose.length > 0) {
    const hullLoose = spec.hull ?? (named.size === 0 && loose.length > 1);
    if (hullLoose && loose.length > 1) solids.push(hullMeshes(loose));
    else solids.push(...loose);
  }

  const rot = spec.rot ?? [0, 0, 0];
  const pos = spec.pos ?? [0, 0, 0];
  return solids.map(m => ({
    vertices: m.vertices.map(v => {
      const r = rotXYZ(v, rot[0], rot[1], rot[2]);
      return [r[0] + pos[0], r[1] + pos[1], r[2] + pos[2]] as Vec3;
    }),
    faces: m.faces,
  }));
}

/**
 * The whole cutout as one mesh. For display and for the placement map only —
 * subtraction uses buildCutoutSolids so overlapping solids behave.
 */
export function buildCutout(spec: CutoutSpec): Mesh {
  const solids = buildCutoutSolids(spec);
  if (solids.length === 1) return solids[0];
  const vertices: Vec3[] = [];
  const faces: number[][] = [];
  for (const m of solids) {
    const off = vertices.length;
    vertices.push(...m.vertices);
    for (const f of m.faces) faces.push(f.map(i => i + off));
  }
  return { vertices, faces };
}

/** Cutouts that apply to one target, as ready-to-subtract solids. */
/**
 * The shapes that apply to one target, each already unioned into a single
 * solid. Used for both cutouts (subtracted) and additions (unioned in).
 *
 * A cutout's hull groups usually overlap — a pan head sits on its shank, an LED
 * slot crosses a connector slot. Subtracting them one after another is right in
 * exact arithmetic, but each later pass has to clip its faces against the
 * cavity the earlier ones opened, and faces lying on that boundary are
 * ambiguous: some survive as stray interior faces, and the result stops being
 * closed. Unioning first gives one unambiguous boundary per cutout.
 */
export function solidsFor(specs: CutoutSpec[], target: CutoutTarget): Mesh[] {
  return specs
    .filter(s => (s.targets ?? ['plate', 'walls', 'baseplate']).includes(target))
    .map(s => {
      const solids = buildCutoutSolids(s);
      return solids.length > 1 ? unionAll(solids) : solids[0];
    });
}
