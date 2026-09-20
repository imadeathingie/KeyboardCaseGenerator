/**
 * Constructive solid geometry: subtract one closed mesh from another.
 *
 * BSP-tree boolean, the classic csg.js formulation. Each solid becomes a set of
 * polygons; each tree is clipped against the other, coplanar faces are resolved
 * by the tree that owns them, and the survivors are reassembled.
 *
 * Everything is triangulated on the way in. The wall sweep emits quads that are
 * not planar (four points on a twisting surface), and a plane-based boolean
 * misclassifies those badly — a triangle always lies in its own plane.
 */

import type { Mesh, Vec3 } from './types';

const EPS = 1e-5;

/**
 * Spatial hash for a grid cell. Colliding cells only lengthen a candidate list,
 * which the distance test throws out anyway — and this replaces template-string
 * keys that were millions of throwaway allocations per boolean.
 */
const cellHash = (x: number, y: number, z: number) =>
  ((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

interface Plane { n: Vec3; w: number }
interface Poly { verts: Vec3[]; plane: Plane }

function planeOf(a: Vec3, b: Vec3, c: Vec3): Plane | null {
  const n = cross(sub(b, a), sub(c, a));
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-12) return null;            // degenerate triangle
  const u: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
  return { n: u, w: dot(u, a) };
}

const flip = (p: Poly): Poly => ({
  verts: [...p.verts].reverse(),
  plane: { n: [-p.plane.n[0], -p.plane.n[1], -p.plane.n[2]], w: -p.plane.w },
});

/** Split `poly` by `plane`, appending the pieces to the four buckets. */
function splitPoly(
  plane: Plane, poly: Poly,
  coplanarFront: Poly[], coplanarBack: Poly[], front: Poly[], back: Poly[],
): void {
  const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

  let polyType = 0;
  const types: number[] = [];
  for (const v of poly.verts) {
    const t = dot(plane.n, v) - plane.w;
    const type = t < -EPS ? BACK : t > EPS ? FRONT : COPLANAR;
    polyType |= type;
    types.push(type);
  }

  if (polyType === COPLANAR) {
    (dot(plane.n, poly.plane.n) > 0 ? coplanarFront : coplanarBack).push(poly);
    return;
  }
  if (polyType === FRONT) { front.push(poly); return; }
  if (polyType === BACK) { back.push(poly); return; }

  const f: Vec3[] = [], b: Vec3[] = [];
  const n = poly.verts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ti = types[i], tj = types[j];
    const vi = poly.verts[i], vj = poly.verts[j];
    if (ti !== BACK) f.push(vi);
    if (ti !== FRONT) b.push(vi);
    if ((ti | tj) === SPANNING) {
      const t = (plane.w - dot(plane.n, vi)) / dot(plane.n, sub(vj, vi));
      const v = lerp(vi, vj, t);
      f.push(v);
      b.push(v);
    }
  }
  if (f.length >= 3) front.push({ verts: f, plane: poly.plane });
  if (b.length >= 3) back.push({ verts: b, plane: poly.plane });
}

class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polys: Poly[] = [];

  constructor(polys?: Poly[]) {
    if (polys && polys.length) this.build(polys);
  }

  invert(): void {
    this.polys = this.polys.map(flip);
    if (this.plane) {
      this.plane = {
        n: [-this.plane.n[0], -this.plane.n[1], -this.plane.n[2]],
        w: -this.plane.w,
      };
    }
    this.front?.invert();
    this.back?.invert();
    const t = this.front; this.front = this.back; this.back = t;
  }

  /** Drop the parts of `polys` that fall inside this solid. */
  clipPolys(polys: Poly[]): Poly[] {
    if (!this.plane) return polys.slice();
    let front: Poly[] = [], back: Poly[] = [];
    for (const p of polys) splitPoly(this.plane, p, front, back, front, back);
    if (this.front) front = this.front.clipPolys(front);
    back = this.back ? this.back.clipPolys(back) : [];
    return front.concat(back);
  }

  clipTo(other: Node): void {
    this.polys = other.clipPolys(this.polys);
    this.front?.clipTo(other);
    this.back?.clipTo(other);
  }

  allPolys(): Poly[] {
    return this.polys
      .concat(this.front ? this.front.allPolys() : [])
      .concat(this.back ? this.back.allPolys() : []);
  }

  build(polys: Poly[]): void {
    if (!polys.length) return;
    if (!this.plane) this.plane = polys[0].plane;
    const front: Poly[] = [], back: Poly[] = [];
    for (const p of polys) {
      splitPoly(this.plane, p, this.polys, this.polys, front, back);
    }
    if (front.length) (this.front ??= new Node()).build(front);
    if (back.length) (this.back ??= new Node()).build(back);
  }
}

/** Mesh -> triangle polygons, dropping degenerates. */
function toPolys(m: Mesh): Poly[] {
  const out: Poly[] = [];
  for (const f of m.faces) {
    for (let i = 1; i + 1 < f.length; i++) {
      const a = m.vertices[f[0]], b = m.vertices[f[i]], c = m.vertices[f[i + 1]];
      const plane = planeOf(a, b, c);
      if (plane) out.push({ verts: [a, b, c], plane });
    }
  }
  return out;
}

/** Polygons -> mesh, welding vertices that land on the same point. */
function toMesh(polys: Poly[]): Mesh {
  const vertices: Vec3[] = [];
  const index = new Map<string, number>();
  const key = (p: Vec3) =>
    `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
  const vid = (p: Vec3) => {
    const k = key(p);
    let i = index.get(k);
    if (i === undefined) { i = vertices.length; index.set(k, i); vertices.push(p); }
    return i;
  };

  const faces: number[][] = [];
  for (const p of polys) {
    const ids: number[] = [];
    for (const v of p.verts) {
      const i = vid(v);
      if (ids.length === 0 || ids[ids.length - 1] !== i) ids.push(i);
    }
    if (ids.length > 2 && ids[0] === ids[ids.length - 1]) ids.pop();
    if (ids.length >= 3) faces.push(ids);
  }
  return { vertices, faces };
}


/**
 * Merge vertices that are the same point to within `eps`.
 *
 * The splitter works to EPS, so it happily emits two copies of a corner a few
 * parts in a million apart — one from each of the planes that produced it. They
 * are one point geometrically, but as distinct indices they turn the edge
 * between them into a zero-length sliver shared by three faces, which reads as
 * non-manifold. Collapsing them first also stops a dead twin from being welded
 * into a nearby edge as a bogus T-junction.
 */
function mergeCoincident(mesh: Mesh, eps: number): Mesh {
  const { vertices, faces } = mesh;
  const cell = Math.max(eps, 1e-9);
  const grid = new Map<number, number[]>();
  const remap = new Array<number>(vertices.length);
  const kept: Vec3[] = [];
  const eps2 = eps * eps;

  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const gx = Math.floor(v[0] / cell), gy = Math.floor(v[1] / cell);
    const gz = Math.floor(v[2] / cell);
    let hit = -1;
    for (let dx = -1; dx <= 1 && hit < 0; dx++) {
      for (let dy = -1; dy <= 1 && hit < 0; dy++) {
        for (let dz = -1; dz <= 1 && hit < 0; dz++) {
          const bucket = grid.get(cellHash(gx + dx, gy + dy, gz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            const p = kept[j];
            const ax = p[0] - v[0], ay = p[1] - v[1], az = p[2] - v[2];
            if (ax * ax + ay * ay + az * az <= eps2) { hit = j; break; }
          }
        }
      }
    }
    if (hit >= 0) { remap[i] = hit; continue; }
    const id = kept.length;
    kept.push(v);
    remap[i] = id;
    const k = cellHash(gx, gy, gz);
    const bucket = grid.get(k);
    if (bucket) bucket.push(id); else grid.set(k, [id]);
  }

  if (kept.length === vertices.length) return mesh;

  const out: number[][] = [];
  for (const f of faces) {
    const ids: number[] = [];
    for (const vi of f) {
      const id = remap[vi];
      if (ids.length === 0 || ids[ids.length - 1] !== id) ids.push(id);
    }
    while (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    if (ids.length >= 3) out.push(ids);
  }
  return { vertices: kept, faces: out };
}

/**
 * Drop faces with no width.
 *
 * Coplanar handling in the BSP can emit the same collinear sliver twice. Each
 * copy carries the same three edges, so the pair pushes those edges to four
 * uses and the mesh reads as non-manifold even though the surface either side
 * of them is sound. A face whose vertices all sit within `eps` of one line
 * encloses nothing and bounds nothing, so it can simply go.
 *
 * Width is 2 x area / longest edge: the distance the face spans away from its
 * own longest side.
 */
function dropSlivers(mesh: Mesh, eps: number): Mesh {
  const { vertices, faces } = mesh;
  const out: number[][] = [];
  for (const f of faces) {
    const vs = f.map(i => vertices[i]);
    let area2 = 0;
    for (let i = 2; i < vs.length; i++) {
      const u = sub(vs[i - 1], vs[0]), w = sub(vs[i], vs[0]);
      const c = cross(u, w);
      area2 += Math.hypot(c[0], c[1], c[2]);
    }
    let longest = 0;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i], b = vs[(i + 1) % vs.length];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (d > longest) longest = d;
    }
    if (longest <= 0 || area2 / longest <= eps) continue;
    out.push(f);
  }
  return out.length === faces.length ? mesh : { vertices, faces: out };
}

/**
 * Split a pinched face into the loops it is really made of.
 *
 * Remapping vertices can land the same index in two separate places on one
 * face, which makes it a bowtie: it still bounds the right area, but the edges
 * either side of the pinch get counted against a vertex that is topologically
 * two places at once, and the mesh reads as non-manifold there. Cutting the
 * loop at each repeat recovers the sub-loops, which together tile exactly what
 * the original covered.
 *
 * [A,Z,B,C,Z,D] is two loops meeting at Z: [Z,B,C] and [A,Z,D].
 */
function unpinch(seq: number[]): number[][] {
  const loops: number[][] = [];
  const stack: number[] = [];
  const pos = new Map<number, number>();

  for (const id of seq) {
    const p = pos.get(id);
    if (p === undefined) {
      pos.set(id, stack.length);
      stack.push(id);
      continue;
    }
    const loop = stack.splice(p + 1);
    for (const v of loop) pos.delete(v);
    loop.unshift(id);
    if (loop.length >= 3) loops.push(loop);
  }

  while (stack.length > 1 && stack[0] === stack[stack.length - 1]) stack.pop();
  if (stack.length >= 3) loops.push(stack);
  return loops;
}

/** Apply `unpinch` across a mesh, dropping anything left with under 3 corners. */
function unpinchFaces(mesh: Mesh): Mesh {
  const out: number[][] = [];
  let changed = false;
  for (const f of mesh.faces) {
    const loops = unpinch(f);
    if (loops.length !== 1 || loops[0].length !== f.length) changed = true;
    for (const l of loops) out.push(l);
  }
  return changed ? { vertices: mesh.vertices, faces: out } : mesh;
}

/**
 * Walk the grid cells a segment actually passes through (Amanatides & Woo).
 *
 * The obvious thing is to scan every cell in the segment's bounding box, but
 * that is the cube of what a segment touches, and a case carries edges at wildly
 * different scales: one small cutout drags the cell size down to its own facets
 * while the wall still has edges tens of millimetres long. Those long edges then
 * sweep thousands of empty cells each. Measured on one board: 4.5M cell visits
 * for the box scan against 0.23M for the walk.
 */
function walkCells(
  a: Vec3, b: Vec3, cell: number, visit: (x: number, y: number, z: number) => void,
): void {
  let cx = Math.floor(a[0] / cell), cy = Math.floor(a[1] / cell), cz = Math.floor(a[2] / cell);
  const ex = Math.floor(b[0] / cell), ey = Math.floor(b[1] / cell), ez = Math.floor(b[2] / cell);
  visit(cx, cy, cz);
  if (cx === ex && cy === ey && cz === ez) return;

  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? cell / Math.abs(dx) : Infinity;
  const tdy = dy !== 0 ? cell / Math.abs(dy) : Infinity;
  const tdz = dz !== 0 ? cell / Math.abs(dz) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? (cx + 1) * cell - a[0] : a[0] - cx * cell) / Math.abs(dx) : Infinity;
  let ty = dy !== 0 ? (dy > 0 ? (cy + 1) * cell - a[1] : a[1] - cy * cell) / Math.abs(dy) : Infinity;
  let tz = dz !== 0 ? (dz > 0 ? (cz + 1) * cell - a[2] : a[2] - cz * cell) / Math.abs(dz) : Infinity;

  // A DDA takes exactly one step per cell boundary crossed, so the Manhattan
  // distance between the end cells bounds the loop however the maths rounds.
  const limit = Math.abs(ex - cx) + Math.abs(ey - cy) + Math.abs(ez - cz);
  for (let step = 0; step < limit; step++) {
    if (tx <= ty && tx <= tz) { if (tx > 1) return; cx += sx; tx += tdx; }
    else if (ty <= tz) { if (ty > 1) return; cy += sy; ty += tdy; }
    else { if (tz > 1) return; cz += sz; tz += tdz; }
    visit(cx, cy, cz);
    if (cx === ex && cy === ey && cz === ez) return;
  }
}

/**
 * Close T-junctions.
 *
 * The BSP splits polygons wherever a plane crosses them, so a vertex often ends
 * up sitting partway along a neighbouring polygon's edge without being part of
 * it. The result encloses the right volume but is not edge-manifold, which the
 * app reports as open edges and some slicers dislike. Re-insert each such
 * vertex into the edge it lies on.
 */
function weldTJunctions(input: Mesh, eps = EPS): Mesh {
  if (input.vertices.length === 0) return input;
  const mesh = dropSlivers(unpinchFaces(mergeCoincident(input, eps)), eps);
  const { vertices, faces } = mesh;

  // Cell size from a TYPICAL edge. Sizing it from the longest edge puts every
  // vertex in one bucket and the scan degenerates to O(vertices x edges).
  const lens: number[] = [];
  for (const f of faces) {
    for (let i = 0; i < f.length; i++) {
      const a = vertices[f[i]], b = vertices[f[(i + 1) % f.length]];
      lens.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
  }
  if (lens.length === 0) return mesh;
  lens.sort((x, y) => x - y);
  const cell = Math.max(lens[Math.floor(lens.length / 2)], 1e-6);

  const hash = cellHash;
  const grid = new Map<number, number[]>();
  const put = (k: number, i: number) => {
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  };

  // A vertex is filed under its own cell and under any neighbour whose boundary
  // it sits within eps of. That is what lets a lookup walk the segment's own
  // cells and no halo: anything within eps of the segment is within eps of a
  // cell the segment crosses, so it has been filed there too.
  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const cx = Math.floor(v[0] / cell), cy = Math.floor(v[1] / cell), cz = Math.floor(v[2] / cell);
    const xs = [cx], ys = [cy], zs = [cz];
    if (v[0] - cx * cell < eps) xs.push(cx - 1);
    else if ((cx + 1) * cell - v[0] < eps) xs.push(cx + 1);
    if (v[1] - cy * cell < eps) ys.push(cy - 1);
    else if ((cy + 1) * cell - v[1] < eps) ys.push(cy + 1);
    if (v[2] - cz * cell < eps) zs.push(cz - 1);
    else if ((cz + 1) * cell - v[2] < eps) zs.push(cz + 1);
    for (const x of xs) for (const y of ys) for (const z of zs) put(hash(x, y, z), i);
  }

  // Every interior edge is walked by both of the faces that share it, so the
  // gather runs once per undirected edge and is handed back reversed to the
  // face coming the other way. The per-face filtering stays per face.
  const seen = new Set<number>();
  const stride = vertices.length;
  const cache = new Map<number, number[]>();
  const gather = (ia: number, ib: number): number[] => {
    const a = vertices[ia], b = vertices[ib];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len2 = dx * dx + dy * dy + dz * dz;
    if (len2 <= 0) return [];
    seen.clear();
    const on: { t: number; i: number }[] = [];
    walkCells(a, b, cell, (gx, gy, gz) => {
      const bucket = grid.get(hash(gx, gy, gz));
      if (!bucket) return;
      for (const vi of bucket) {
        if (vi === ia || vi === ib || seen.has(vi)) continue;
        seen.add(vi);
        const p = vertices[vi];
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy + (p[2] - a[2]) * dz) / len2;
        if (t <= eps || t >= 1 - eps) continue;
        const qx = a[0] + dx * t - p[0];
        const qy = a[1] + dy * t - p[1];
        const qz = a[2] + dz * t - p[2];
        if (qx * qx + qy * qy + qz * qz > eps * eps) continue;
        on.push({ t, i: vi });
      }
    });
    on.sort((p, q) => p.t - q.t);
    return on.map(o => o.i);
  };
  const onEdge = (ia: number, ib: number): number[] => {
    const fwd = ia < ib;
    const k = fwd ? ia * stride + ib : ib * stride + ia;
    let hit = cache.get(k);
    if (hit === undefined) {
      hit = fwd ? gather(ia, ib) : gather(ib, ia);
      cache.set(k, hit);
    }
    if (hit.length === 0) return hit;
    return fwd ? hit : [...hit].reverse();
  };

  const out: number[][] = [];
  for (const f of faces) {
    // A T-junction is a vertex from a DIFFERENT face. A face's own corners are
    // never candidates: on a sliver triangle a corner can sit within eps of the
    // opposite edge, and re-inserting it there pinches the face into a bowtie.
    const own = new Set(f);
    const ids: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const ia = f[i], ib = f[(i + 1) % f.length];
      ids.push(ia);
      for (const vi of onEdge(ia, ib)) if (!own.has(vi)) ids.push(vi);
    }
    if (ids.length >= 3) out.push(ids);
  }
  // The insertion above can pinch a face all over again: a vertex sitting near
  // where two of its edges meet qualifies for both, and is needed on both to
  // stay manifold with either neighbour. Keep both, then split the loop.
  return unpinchFaces({ vertices, faces: out });
}

function badEdges(m: Mesh): Set<number> {
  const stride = m.vertices.length;
  const count = new Map<number, number>();
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = a < b ? a * stride + b : b * stride + a;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const bad = new Set<number>();
  for (const [k, n] of count) if (n !== 2) bad.add(k);
  return bad;
}

/**
 * Close the seams a boolean leaves behind.
 *
 * Where a tool's face is exactly coplanar with the target's, the two planes are
 * nearly parallel to the edge they meet on and the intersection is badly
 * conditioned: the same corner comes out of two different splits tens of
 * microns apart. Those copies are one point, but they are far enough apart that
 * merging everything at that distance would fuse features that should stay
 * distinct - it makes matters worse, not better, across the board.
 *
 * So merge selectively. Only vertices already sitting on a broken edge are
 * candidates, sound regions are never touched, and the ladder starts tight and
 * loosens only as far as it must. A pass is kept only if it actually reduced
 * the number of broken edges, which makes the repair non-regressive by
 * construction: the worst it can do is nothing.
 */
function repairSeams(mesh: Mesh, tries = 4): Mesh {
  const ladder = [EPS, 1e-4, 1e-3];
  let best = mesh;
  let bad = badEdges(best);

  for (let pass = 0; pass < tries && bad.size > 0; pass++) {
    const stride = best.vertices.length;
    const ids = new Set<number>();
    for (const k of bad) {
      ids.add(Math.floor(k / stride));
      ids.add(k % stride);
    }

    let improved = false;
    for (const tol of ladder) {
      const merged = mergeSubset(best, ids, tol);
      if (merged === best) continue;
      // Fusing duplicates cannot create a T-junction, so the loop skips the
      // global scan and only tidies what the merge disturbed. That check is
      // linear in the faces; a full weld is not, and on a 15k-face case it cost
      // ten seconds a pass to arrive at the same answer.
      const candidate = dropSlivers(unpinchFaces(merged), EPS);
      const after = badEdges(candidate);
      if (after.size >= bad.size) continue;
      best = candidate;
      bad = after;
      improved = true;
      break;
    }
    if (!improved) break;
  }

  // One full weld at the end, in case fusing a duplicate left a neighbour
  // sitting mid-edge. Kept only if it helps, the same rule as every pass above.
  if (best !== mesh) {
    const welded = weldTJunctions(best);
    if (badEdges(welded).size < bad.size) best = welded;
  }
  return best;
}

/**
 * Merge coincident vertices, but only among `ids`. Returns `mesh` unchanged if
 * nothing was close enough to fuse.
 */
function mergeSubset(mesh: Mesh, ids: Set<number>, eps: number): Mesh {
  const { vertices, faces } = mesh;
  const list = [...ids].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  const eps2 = eps * eps;

  for (let i = 0; i < list.length; i++) {
    const a = vertices[list[i]];
    if (remap.has(list[i])) continue;
    for (let j = i + 1; j < list.length; j++) {
      if (remap.has(list[j])) continue;
      const b = vertices[list[j]];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      if (dx * dx + dy * dy + dz * dz <= eps2) remap.set(list[j], list[i]);
    }
  }
  if (remap.size === 0) return mesh;

  const out: number[][] = [];
  for (const f of faces) {
    const seq: number[] = [];
    for (const vi of f) {
      const id = remap.get(vi) ?? vi;
      if (seq.length === 0 || seq[seq.length - 1] !== id) seq.push(id);
    }
    while (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq.pop();
    if (seq.length >= 3) out.push(seq);
  }
  return { vertices, faces: out };
}

/**
 * `target` minus `tool`. Both must be closed; the result is the part of
 * `target` outside `tool`, capped with the inward-facing surface of `tool`.
 */
function subtractOnce(target: Mesh, tool: Mesh, pad: number): Mesh {
  if (target.faces.length === 0 || tool.faces.length === 0) return target;

  // Only the faces near the tool can be affected, and a cutout is small next to
  // a case. Passing the whole wall through the BSP costs seconds; passing the
  // few faces around the opening costs milliseconds, and the rest of the mesh
  // comes through untouched. The weld pass afterwards stitches the seam.
  const { near, far } = splitByBounds(target, tool, pad);
  if (near.length === 0) return target;   // tool misses the target entirely

  const a = new Node(toPolys({ vertices: target.vertices, faces: near }));
  const b = new Node(toPolys(tool));

  a.invert();
  a.clipTo(b);
  b.clipTo(a);
  b.invert();
  b.clipTo(a);
  b.invert();
  a.build(b.allPolys());
  a.invert();

  // Re-attach the untouched remainder, then stitch.
  const cutPolys = a.allPolys();
  appendFaces(cutPolys, target, far);
  return weldTJunctions(toMesh(cutPolys));
}

/** Faces of `target` whose bounds touch `tool`'s, and the rest. */
function splitByBounds(
  target: Mesh, tool: Mesh, pad: number,
): { near: number[][]; far: number[][] } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const v of tool.vertices) {
    for (let k = 0; k < 3; k++) {
      if (v[k] < lo[k]) lo[k] = v[k];
      if (v[k] > hi[k]) hi[k] = v[k];
    }
  }
  const near: number[][] = [], far: number[][] = [];
  for (const f of target.faces) {
    let touches = true;
    for (let k = 0; k < 3 && touches; k++) {
      let fLo = Infinity, fHi = -Infinity;
      for (const vi of f) {
        const c = target.vertices[vi][k];
        if (c < fLo) fLo = c;
        if (c > fHi) fHi = c;
      }
      if (fHi < lo[k] - pad || fLo > hi[k] + pad) touches = false;
    }
    (touches ? near : far).push(f);
  }
  return { near, far };
}

/** Add `faces` of `mesh` to a polygon list, as triangles. */
function appendFaces(polys: Poly[], mesh: Mesh, faces: number[][]): void {
  for (const f of faces) {
    for (let i = 1; i + 1 < f.length; i++) {
      const a = mesh.vertices[f[0]];
      const b = mesh.vertices[f[i]];
      const c = mesh.vertices[f[i + 1]];
      const plane = planeOf(a, b, c);
      if (plane) polys.push({ verts: [a, b, c], plane });
    }
  }
}

/**
 * `a` OR `b`, as one closed solid with the shared interior resolved.
 *
 * Worth doing before subtracting overlapping tools rather than subtracting them
 * one after another. Sequentially, the second tool has to clip its faces
 * against the cavity the first already opened, and faces lying exactly on that
 * cavity boundary are ambiguous — some survive as interior faces inside empty space.
 * Unioning first leaves a single boundary and one unambiguous subtraction.
 */
function unionOnce(a: Mesh, b: Mesh, pad: number): Mesh {
  if (a.faces.length === 0) return b;
  if (b.faces.length === 0) return a;

  // Classify against the WHOLE of `a`, but only rebuild the faces near `b`.
  //
  // Feeding all of `a` through the tree and back fragments every polygon
  // against each of the tool's ~100 planes: one small collar took a 1178-vertex
  // plate to 15143 vertices and 4.5 seconds. Clipping `b` needs the full tree
  // though — a tree of only the nearby faces is not a closed solid, so
  // inside/outside comes out wrong and the seam tears (52 open edges when tried
  // that way). So: full tree for classification, near faces for reconstruction,
  // far faces passed through untouched.
  const full = new Node(toPolys(a));
  const { near, far } = splitByBounds(a, b, pad);

  const naNear = new Node(toPolys({ vertices: a.vertices, faces: near }));
  const nb = new Node(toPolys(b));

  naNear.clipTo(nb);
  nb.clipTo(full);
  nb.invert();
  nb.clipTo(full);
  nb.invert();

  const polys = naNear.allPolys();
  for (const p of nb.allPolys()) polys.push(p);
  appendFaces(polys, a, far);
  return weldTJunctions(toMesh(polys));
}

/** Union a list of solids into one. */
export function unionAll(meshes: Mesh[]): Mesh {
  if (meshes.length === 0) return { vertices: [], faces: [] };
  let out = meshes[0];
  for (let i = 1; i < meshes.length; i++) out = unionMesh(out, meshes[i]);
  return out;
}

/** Subtract several tools in turn. */
export function subtractAll(target: Mesh, tools: Mesh[]): Mesh {
  let out = target;
  for (const t of tools) out = subtractMesh(out, t);
  return out;
}

/** Every edge shared by exactly two faces. */
function isClosed(m: Mesh): boolean {
  const stride = m.vertices.length;
  const count = new Map<number, number>();
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = a < b ? a * stride + b : b * stride + a;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  for (const n of count.values()) if (n !== 2) return false;
  return true;
}

/**
 * Only the faces near the tool go through the boolean; the rest pass through
 * untouched. How near is a trade: a tight margin is much faster and yields a
 * far smaller mesh, but the seam between rebuilt and untouched faces sometimes
 * fails to close. So try tight, check, and widen only if it actually broke —
 * on one collar-plus-port that is 4 open edges and 2.7s against watertight and
 * 7s, and most edits never need the wide pass at all.
 */
const PAD_TIGHT = 1e-3;
const PAD_WIDE = 3;

function retrying(run: (pad: number) => Mesh): Mesh {
  const tight = run(PAD_TIGHT);
  if (isClosed(tight)) return tight;

  // Seam repair before widening: it is far cheaper than a second boolean, and
  // when it closes the mesh the wide pass is skipped altogether.
  const patched = repairSeams(tight);
  if (isClosed(patched)) return patched;

  const wide = repairSeams(run(PAD_WIDE));
  return isClosed(wide) ? wide : patched;
}

/** `target` minus `tool`. */
export function subtractMesh(target: Mesh, tool: Mesh): Mesh {
  return retrying(pad => subtractOnce(target, tool, pad));
}

/**
 * `a` OR `b`, as one closed solid.
 *
 * Always uses the wide margin. A union feeds whatever comes next — usually a
 * cutout boring through the very shape just added — and a tight union leaves a
 * seam close enough to the tool that the following subtraction cannot close it,
 * whatever margin THAT uses. Unions are also far rarer than cutouts, so the
 * extra cost lands on few edits.
 */
export function unionMesh(a: Mesh, b: Mesh): Mesh {
  const wide = unionOnce(a, b, PAD_WIDE);
  if (isClosed(wide)) return wide;
  const patched = repairSeams(wide);
  if (isClosed(patched)) return patched;
  const tight = repairSeams(unionOnce(a, b, PAD_TIGHT));
  return isClosed(tight) ? tight : patched;
}
