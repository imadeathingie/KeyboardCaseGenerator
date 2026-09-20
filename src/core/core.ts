/**
 * Faithful TypeScript port of the plugin's core.py — pure geometry, no
 * rendering dependency. Takes a keylist (or keyboard definition) and returns
 * explicit meshes:
 *
 *   vertices : [x, y, z][]
 *   faces    : number[][]   (indices into vertices, CCW viewed from outside)
 *
 * Builders: buildShell (plate, optionally with fused skirt walls),
 * buildWalls (separate recess frame), buildBaseplate, buildInserts,
 * plus transformMesh / assembly helpers.
 */

import { generateKeylist, isKeyboardDef } from './keylistGen';
import type {
  AssemblyEntry, Catalog, Entry, Face, KeyEntry, Keylist, Mesh,
  ResolvedInsert, Vec2, Vec3,
} from './types';

// ------------------------------------------------------------------ helpers

const rad = (d: number) => (d * Math.PI) / 180;

/**
 * Rotate p by Euler angles (degrees), OpenSCAD rotate([rx,ry,rz]) order:
 * Z first, then Y, then X.
 */
export function rotXYZ(p: Vec3, rxDeg: number, ryDeg: number, rzDeg: number): Vec3 {
  let [x, y, z] = p;
  const rz = rad(rzDeg), ry = rad(ryDeg), rx = rad(rxDeg);
  // Z
  [x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
  // Y
  [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
  // X
  [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
  return [x, y, z];
}

/** Key local frame -> world: rotate by key rotation, translate by key pos. */
function place(pLocal: Vec3, key: KeyEntry): Vec3 {
  const r = key.rotation;
  const [px, py, pz] = rotXYZ(pLocal, r.x, r.y, r.z);
  return [px + key.pos.x, py + key.pos.y, pz + key.pos.z];
}

/**
 * Inverse of rotXYZ. rotXYZ applies Z, then Y, then X; to undo it we apply the
 * inverse rotations in reverse order: X, then Y, then Z.
 */
function unrotXYZ(p: Vec3, rxDeg: number, ryDeg: number, rzDeg: number): Vec3 {
  let [x, y, z] = p;
  const rz = rad(rzDeg), ry = rad(ryDeg), rx = rad(rxDeg);
  // X^-1
  [y, z] = [y * Math.cos(rx) + z * Math.sin(rx), -y * Math.sin(rx) + z * Math.cos(rx)];
  // Y^-1
  [x, z] = [x * Math.cos(ry) - z * Math.sin(ry), x * Math.sin(ry) + z * Math.cos(ry)];
  // Z^-1
  [x, y] = [x * Math.cos(rz) + y * Math.sin(rz), -x * Math.sin(rz) + y * Math.cos(rz)];
  return [x, y, z];
}

/**
 * Inverse of place: bring a WORLD point into a key's local frame (undo the
 * translate, then the rotation). In that frame the switch cutout is the
 * axis-aligned square [-hole/2, hole/2] at z=0, which is what lets us test
 * whether a face crosses the hole accounting for the key's rotation.
 */
function unplace(pWorld: Vec3, key: KeyEntry): Vec3 {
  const w: Vec3 = [pWorld[0] - key.pos.x, pWorld[1] - key.pos.y, pWorld[2] - key.pos.z];
  const r = key.rotation;
  return unrotXYZ(w, r.x, r.y, r.z);
}

function norm(a: Vec3): Vec3 {
  const m = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (m < 1e-12) return [0, 0, 0];
  return [a[0] / m, a[1] / m, a[2] / m];
}

/** Newell's method polygon normal (magnitude = 2x area — area-weights sums). */
function faceNormal(pts: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0, z0] = pts[i];
    const [x1, y1, z1] = pts[(i + 1) % n];
    nx += (y0 - y1) * (z0 + z1);
    ny += (z0 - z1) * (x0 + x1);
    nz += (x0 - x1) * (y0 + y1);
  }
  return [nx, ny, nz];
}

// -------------------------------------------------------------- TopSurface

/**
 * Accumulates the keyboard's TOP surface as one connected mesh with a shared,
 * welded vertex pool, accumulating area-weighted normals per vertex so the
 * bottom can be offset a uniform thickness perpendicular to the top.
 */
export class TopSurface {
  private inv: number;
  private remap = new Map<string, number>();
  points: Vec3[] = [];
  normals: [number, number, number][] = [];
  faces: Face[] = [];
  /** Per welded vertex: override normal for the constant-thickness offset. */
  offsetNormal = new Map<number, Vec3>();

  constructor(weldTol = 1e-4) {
    this.inv = 1 / weldTol;
  }

  private key(p: Vec3): string {
    return `${Math.round(p[0] * this.inv)},${Math.round(p[1] * this.inv)},${Math.round(p[2] * this.inv)}`;
  }

  vert(p: Vec3): number {
    const k = this.key(p);
    let idx = this.remap.get(k);
    if (idx === undefined) {
      idx = this.points.length;
      this.remap.set(k, idx);
      this.points.push(p);
      this.normals.push([0, 0, 0]);
    }
    return idx;
  }

  /** Add a top face given world points (CCW from above). */
  face(worldPts: Vec3[]): Face | null {
    const idxs = worldPts.map(p => this.vert(p));
    if (new Set(idxs).size < 3) return null; // degenerate after welding
    const nrm = faceNormal(worldPts);
    for (const i of idxs) {
      this.normals[i][0] += nrm[0];
      this.normals[i][1] += nrm[1];
      this.normals[i][2] += nrm[2];
    }
    this.faces.push(idxs);
    return idxs;
  }

  unitNormals(): Vec3[] {
    return this.normals.map(n => {
      const u = norm([n[0], n[1], n[2]]);
      return (u[0] === 0 && u[1] === 0 && u[2] === 0) ? [0, 0, 1] : u;
    });
  }
}

// ------------------------------------------------------------ key geometry

function cellHalfExtents(
  key: KeyEntry, key1u: number, holeSize = 14.5, switchBorder = 1.5,
): [number, number] {
  const u = key.u_width ?? 1;
  const h = key.u_height ?? 1;
  const hw = Math.max((u * key1u - 3) / 2, holeSize / 2 + switchBorder);
  const hh = Math.max((h * key1u - 3) / 2, holeSize / 2 + switchBorder);
  return [hw, hh];
}

/** Outer cell ring (4 pts) in local frame, at local z=0: tl, bl, br, tr. */
function cellRing(
  key: KeyEntry, key1u: number, holeSize = 14.5, switchBorder = 1.5,
): Vec3[] {
  const [hw, hh] = cellHalfExtents(key, key1u, holeSize, switchBorder);
  return [[-hw, hh, 0], [-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0]];
}

/** Inner switch-cutout ring (4 pts) in local frame, at local z=0. */
function holeRing(_key: KeyEntry, _key1u: number, holeSize: number): Vec3[] {
  const u = holeSize / 2;
  return [[-u, u, 0], [-u, -u, 0], [u, -u, 0], [u, u, 0]];
}

type CornerName = 'tl' | 'bl' | 'br' | 'tr';
type Corners = Record<CornerName, Vec3>;

/** The key's four top corners in world space, keyed by name. */
function keyEdgesWorld(
  key: KeyEntry, key1u: number, holeSize = 14.5, switchBorder = 1.5,
): Corners {
  const [tl, bl, br, tr] = cellRing(key, key1u, holeSize, switchBorder)
    .map(p => place(p, key));
  return { tl, bl, br, tr };
}

// -------------------------------------------------------- links/neighbours

type CR = string; // "col,row"
const crKey = (c: number, r: number): CR => `${c},${r}`;
const pairKey = (a: CR, b: CR): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

type Side = 'l' | 'r' | 't' | 'b';
const SIDES: Side[] = ['l', 'r', 't', 'b'];
const OPP: Record<Side, Side> = { l: 'r', r: 'l', t: 'b', b: 't' };

interface LinkTarget { cr: CR; corner: CornerName | null; }

/** This key's explicit links as {side: {cr, corner|null}}. */
function linkedTargets(key: KeyEntry): Partial<Record<Side, LinkTarget>> {
  const out: Partial<Record<Side, LinkTarget>> = {};
  const lk = key.linked_keys ?? {};
  for (const side of SIDES) {
    const v = lk[side];
    if (v == null) continue;
    if (v.length >= 3) {
      out[side] = {
        cr: crKey(Number(v[0]), Number(v[1])),
        corner: String(v[2]) as CornerName,
      };
    } else {
      out[side] = { cr: crKey(Number(v[0]), Number(v[1])), corner: null };
    }
  }
  return out;
}

/**
 * Explicit links as canonical unordered CR pairs. With fullEdgeOnly, links
 * that name a corner on either endpoint are excluded.
 */
function explicitLinkPairs(keys: KeyEntry[], fullEdgeOnly = false): Set<string> {
  const pairHasCorner = new Map<string, boolean>();
  for (const k of keys) {
    const a = crKey(k.col, k.row);
    for (const side of SIDES) {
      const t = linkedTargets(k)[side];
      if (!t) continue;
      const pr = pairKey(a, t.cr);
      pairHasCorner.set(pr, (pairHasCorner.get(pr) ?? false) || t.corner !== null);
    }
  }
  if (!fullEdgeOnly) return new Set(pairHasCorner.keys());
  const out = new Set<string>();
  for (const [pr, hasC] of pairHasCorner) if (!hasC) out.add(pr);
  return out;
}

/**
 * Determine this key's neighbours on each side (grid adjacency + explicit
 * links); full-edge links suppress the cardinal grid bridge on their side.
 */
function findNeighbours(
  key: KeyEntry, keysByCr: Map<CR, KeyEntry>,
): Partial<Record<Side, KeyEntry[]>> {
  const { col, row } = key;
  const neighs: Partial<Record<Side, KeyEntry[]>> = {};
  const grid: Record<Side, CR> = {
    l: crKey(col - 1, row),
    r: crKey(col + 1, row),
    t: crKey(col, row - 1),
    b: crKey(col, row + 1),
  };
  const myLinks = linkedTargets(key);

  for (const side of SIDES) {
    const cr = grid[side];
    if (!keysByCr.has(cr)) continue;
    // A FULL-EDGE link on this side claims the whole edge — the cardinal
    // grid neighbour yields. A CORNER link takes only one corner, so the
    // cardinal neighbour is kept.
    const ml = myLinks[side];
    if (ml && ml.corner === null) continue;
    // Reciprocal: if the grid neighbour full-edge-links back, yield too.
    const neigh = keysByCr.get(cr)!;
    const nl = linkedTargets(neigh)[OPP[side]];
    if (nl && nl.corner === null) continue;
    (neighs[side] ??= []).push(neigh);
  }

  // Explicit links add to (don't replace) neighbours on their side.
  for (const side of SIDES) {
    const t = myLinks[side];
    if (t && keysByCr.has(t.cr)) (neighs[side] ??= []).push(keysByCr.get(t.cr)!);
  }
  return neighs;
}

/** Which corner pairs face across each side (this-key edge, neighbour edge). */
const FACING: Record<Side, [[CornerName, CornerName], [CornerName, CornerName]]> = {
  r: [['tr', 'br'], ['tl', 'bl']],
  l: [['bl', 'tl'], ['br', 'tr']],
  b: [['br', 'bl'], ['tr', 'tl']],
  t: [['tl', 'tr'], ['bl', 'br']],
};

function degenerate(p: Vec3, q: Vec3, tol = 1e-6): boolean {
  return Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol &&
    Math.abs(p[2] - q[2]) < tol;
}

/** XY footprint scale of a small top polygon (area x avg |z|). */
function polygonScale(top: Vec3[]): number {
  const n = top.length;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = top[i];
    const [x1, y1] = top[(i + 1) % n];
    area2 += x0 * y1 - x1 * y0;
  }
  const area = Math.abs(area2) * 0.5;
  const avgH = top.reduce((s, p) => s + p[2], 0) / n;
  return area * Math.abs(avgH);
}

/**
 * Corner patches sealing the gap at every grid junction where 3-4 key cells
 * meet. Blocks whose diagonal is an explicit link in `linkPairs` are skipped.
 */
function diagonalCornerPatches(
  keysByCr: Map<CR, KeyEntry>, key1u: number, linkPairs: Set<string>,
  holeSize = 14.5, switchBorder = 1.5,
): Vec3[][] {
  if (keysByCr.size === 0) return [];

  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (const k of keysByCr.values()) {
    minC = Math.min(minC, k.col); maxC = Math.max(maxC, k.col);
    minR = Math.min(minR, k.row); maxR = Math.max(maxR, k.row);
  }

  const patches: Vec3[][] = [];
  const order = ['A', 'C', 'D', 'B'] as const;
  const cornerName: Record<string, CornerName> = { A: 'br', B: 'bl', D: 'tl', C: 'tr' };

  for (let c = minC; c <= maxC; c++) {
    for (let r = minR; r <= maxR; r++) {
      const block: Record<string, CR> = {
        A: crKey(c, r), B: crKey(c + 1, r),
        C: crKey(c, r + 1), D: crKey(c + 1, r + 1),
      };
      // Yield to an explicit link on either diagonal of this block.
      if (linkPairs.has(pairKey(block['A'], block['D'])) ||
          linkPairs.has(pairKey(block['B'], block['C']))) continue;

      const present = new Map<string, KeyEntry>();
      for (const name of Object.keys(block)) {
        const k = keysByCr.get(block[name]);
        if (k) present.set(name, k);
      }
      if (present.size < 3) continue;

      const pts: Vec3[] = [];
      for (const name of order) {
        const key = present.get(name);
        if (key) {
          const corners = keyEdgesWorld(key, key1u, holeSize, switchBorder);
          pts.push(corners[cornerName[name]]);
        }
      }
      if (pts.length < 3) continue;

      // A patch is only meaningful when it SEALS the small notch left between
      // the surrounding edge bridges — this function's whole premise is a
      // block whose keys' corners "nearly meet". The A->C->D->B corner order
      // assumes that too: with the cells near their nominal grid slots the
      // polygon comes out CCW viewed from above, the winding every top face
      // uses.
      //
      // When a key is displaced well away from its grid slot and rotated (an
      // offset thumb key, say), the shared corner between two bridges can
      // bulge OUTWARD instead of leaving a notch. What we would emit is then
      // not a gap filler at all: it lays a chord across the OUTSIDE of the
      // boundary and folds back over the neighbouring bridges, leaving a stray
      // flap of material with an inverted (downward) normal. The junction is
      // already closed by the bridges meeting at that shared corner, so the
      // right answer is to emit nothing and let the perimeter run around it.
      //
      // Require BOTH symptoms before dropping a patch:
      //   * inverted   — the corner order came out backwards, so the corners
      //                  are not arranged around a notch, and
      //   * non-local  — the corners span more than one key pitch, so this
      //                  block is not a real junction at all.
      // A patch can legitimately come out inverted while still sealing a
      // genuine, tight notch (steeply tilted keys do this); those stay, and
      // the shared-diagonal repair in flipFacesOffHoles tidies them up. Only a
      // patch that is backwards AND stretched across a non-junction is
      // discarded.
      let span = 0;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i][0] - pts[j][0];
          const dy = pts[i][1] - pts[j][1];
          span = Math.max(span, Math.sqrt(dx * dx + dy * dy));
        }
      }
      if (faceNormal(pts)[2] <= 0 && span > key1u) continue;

      patches.push(pts);
    }
  }
  return patches;
}

// --------------------------------------------------------------- resolvers

export function resolveKeylist(data: Entry): Keylist {
  if (isKeyboardDef(data)) return generateKeylist(data);
  return data as Keylist;
}

export function isAssembly(data: unknown): data is AssemblyEntry {
  return typeof data === 'object' && data !== null && !Array.isArray(data) &&
    'items' in (data as Record<string, unknown>);
}

/** Resolve a board referenced by name from the catalog (assemblies skipped). */
export function findNamedEntry(name: string, catalog: Catalog): Entry | null {
  const entries = Array.isArray(catalog) ? catalog : [catalog];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || isAssembly(entry)) continue;
    if ((entry as Record<string, unknown>)['name'] === name) return entry;
  }
  return null;
}

/** Place a mesh in an assembly: mirror -> rotate -> translate. */
export function transformMesh(
  mesh: Mesh,
  pos: Vec3 = [0, 0, 0],
  rot: Vec3 = [0, 0, 0],
  mirror: [number, number, number] = [0, 0, 0],
): Mesh {
  const sx = mirror[0] ? -1 : 1;
  const sy = mirror[1] ? -1 : 1;
  const sz = mirror[2] ? -1 : 1;
  const reflected = sx * sy * sz < 0;

  const vertices: Vec3[] = mesh.vertices.map(([x, y, z]) => {
    const p = rotXYZ([x * sx, y * sy, z * sz], rot[0], rot[1], rot[2]);
    return [p[0] + pos[0], p[1] + pos[1], p[2] + pos[2]];
  });
  const faces = reflected
    ? mesh.faces.map(f => [...f].reverse())
    : mesh.faces.map(f => [...f]);
  return { vertices, faces };
}

// ------------------------------------------------------------- top surface

interface TopBuild { top: TopSurface; holeVertIds: Set<number>; }

/**
 * Build the connected TOP surface of the plate (key annuli + bridges +
 * corner patches). Shared by buildShell and buildWalls so plate and walls
 * reference identical perimeter geometry.
 */
function buildTopSurface(keylistData: Keylist): TopBuild {
  const data = resolveKeylist(keylistData);
  const key1u = data.key_1u ?? 19.05;
  const holeSize = data.hole_size ?? 14.5;
  const switchBorder = data.switch_border ?? 1.5;
  const keys = data.keylist ?? [];
  const keysByCr = new Map<CR, KeyEntry>(keys.map(k => [crKey(k.col, k.row), k]));

  const top = new TopSurface();
  const holeVertIds = new Set<number>();

  const keyPlaneNormal = (key: KeyEntry): Vec3 => {
    const o = place([0, 0, 0], key);
    const z = place([0, 0, 1], key);
    return norm([z[0] - o[0], z[1] - o[1], z[2] - o[2]]);
  };

  const cellTopWorld = (key: KeyEntry) =>
    cellRing(key, key1u, holeSize, switchBorder).map(p => place(p, key));
  const holeTopWorld = (key: KeyEntry) =>
    holeRing(key, key1u, holeSize).map(p => place(p, key));

  // --- 1) Key tops: annulus (outer cell ring minus inner hole ring) ---
  for (const key of keys) {
    const outer = cellTopWorld(key);
    const inner = holeTopWorld(key);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      top.face([outer[i], outer[j], inner[j], inner[i]]);
    }
    const kn = keyPlaneNormal(key);
    for (const p of outer) top.offsetNormal.set(top.vert(p), kn);
    for (const p of inner) holeVertIds.add(top.vert(p));
  }

  // --- 2) Bridge tops between adjacent keys ---
  const linkPairs = explicitLinkPairs(keys);

  interface Rel {
    key: KeyEntry; neigh: KeyEntry; side: Side;
    corner: CornerName | null; isLink: boolean;
  }
  const rels = new Map<string, Rel>();
  for (const key of keys) {
    const thisCr = crKey(key.col, key.row);
    const myLinks = linkedTargets(key);
    const neighsBySide = findNeighbours(key, keysByCr);
    for (const side of SIDES) {
      for (const neigh of neighsBySide[side] ?? []) {
        const neighCr = crKey(neigh.col, neigh.row);
        const pair = pairKey(thisCr, neighCr);
        let corner: CornerName | null = null;
        let isLink = false;
        const ml = myLinks[side];
        if (ml && ml.cr === neighCr) {
          isLink = true;
          corner = ml.corner;
        }
        // Prefer a link record (carries corner) over a plain grid one.
        const existing = rels.get(pair);
        if (!existing || (isLink && existing.corner === null && !existing.isLink)) {
          rels.set(pair, { key, neigh, side, corner, isLink });
        }
      }
    }
  }
  void linkPairs; // parity with Python (collected there before rels)

  for (const { key, neigh, side, corner } of rels.values()) {
    const thisCorners = keyEdgesWorld(key, key1u, holeSize, switchBorder);
    const neighCorners = keyEdgesWorld(neigh, key1u, holeSize, switchBorder);
    const [[a0, a1], [n0, n1]] = FACING[side];

    if (corner === null) {
      // Full facing edge -> full facing edge.
      const pA0 = thisCorners[a0], pA1 = thisCorners[a1];
      const pN0 = neighCorners[n0], pN1 = neighCorners[n1];
      if (degenerate(pA0, pN0) && degenerate(pA1, pN1)) continue;
      const bridgeTop = [pA0, pA1, pN1, pN0];
      if (polygonScale(bridgeTop.map(p => [p[0], p[1], 1] as Vec3)) < 1) continue;
      top.face(bridgeTop);
    } else {
      // Single named corner of THIS key -> neighbour's full facing edge.
      const pc = thisCorners[corner];
      const pN0 = neighCorners[n0];
      const pN1 = neighCorners[n1];
      const tri = [pc, pN1, pN0];
      if (polygonScale(tri.map(p => [p[0], p[1], 1] as Vec3)) >= 0.1) {
        top.face(tri);
      }
    }
  }

  // --- 3) Corner patches where 3-4 keys meet ---
  const yieldPairs = explicitLinkPairs(keys, true);
  for (const patchTop of diagonalCornerPatches(
      keysByCr, key1u, yieldPairs, holeSize, switchBorder)) {
    if (polygonScale(patchTop.map(p => [p[0], p[1], 1] as Vec3)) < 0.1) continue;
    top.face(patchTop);
  }

  // Repair any junction triangles that ended up draped over a switch cutout
  // (e.g. a linked-key bridge meeting a corner patch on a rotated key) by
  // flipping the shared diagonal off the hole.
  flipFacesOffHoles(top, keys, key1u, holeSize, data.thickness ?? 5.0);

  // Split any warped polygon into explicit triangles, so the top surface, the
  // offset underside built from it and every downstream exporter all agree on
  // how it is divided. Runs last, after the repair above has had its say.
  triangulateNonplanarFaces(top);

  return { top, holeVertIds };
}

// -------------------------------------------------------------- wall style

export type WallStyle = 'skirt' | 'frame' | 'lip';

/**
 * Which case the board wants.
 *
 * `wall_style` is authoritative; without it the legacy `skirt` boolean still
 * decides, so every board written before this existed keeps its meaning.
 */
export function wallStyle(data: Keylist): WallStyle {
  const raw = data.wall_style;
  if (raw !== undefined && raw !== null && String(raw) !== '') {
    const s = String(raw).toLowerCase();
    if (s === 'skirt' || s === 'frame' || s === 'lip') return s;
    throw new Error(`wall_style: expected "skirt", "frame" or "lip", got "${raw}"`);
  }
  return (data.skirt ?? false) ? 'skirt' : 'frame';
}

/** Lip-style dimensions, resolved and checked once. */
export interface LipSpec {
  /** Inward face of the wall, offset from the plate's edge. */
  flange: number;
  /** Wall thickness — the wall stands outside the plate edge by this much. */
  wall: number;
  /** Absolute z of the lip's bearing (under) face - the rebate shoulder. */
  z: number;
  /** How far the lip projects past the skirt. */
  width: number;
  /** The lip's vertical thickness. Its top is the plank's surface. */
  thickness: number;
}

export function lipSpec(data: Keylist): LipSpec {
  const spec: LipSpec = {
    flange: Number(data.skirt_flange ?? 0) || 0,
    wall: Number(data.wall_thickness ?? 2) || 0,
    z: Number(data.lip_z ?? 0) || 0,
    width: Number(data.lip_width ?? 3) || 0,
    thickness: Number(data.lip_thickness ?? 2) || 0,
  };
  if (spec.width <= 0) {
    throw new Error('lip_width must be greater than 0 — the lip has to have ' +
      'something to bear on.');
  }
  if (spec.thickness <= 0) throw new Error('lip_thickness must be greater than 0');
  if (spec.wall <= 0) {
    throw new Error('wall_thickness must be greater than 0 in the lip style — ' +
      'it is what gives the rim around the plate its substance.');
  }
  return spec;
}

/** Inner and outer offsets of the lip-style wall, and the lip's outer edge. */
export function lipOffsets(lip: LipSpec) {
  const inner = lip.flange;
  const outer = inner + lip.wall;
  return { inner, outer, lipOuter: outer + lip.width };
}

/**
 * The lip cross-section at one perimeter station, as (outward offset, z) pairs
 * in the order the surface is walked: up the inside of the wall from the
 * plate's top edge, over the lip, and back down the outside to the plate's
 * underside.
 *
 * The case is a plate hung from a lip. The lip is pinned to an absolute height
 * — its top face IS the plank's surface — while the plate is wherever its own
 * z, tent and pitch put it. So the wall has to travel from the plate to the lip
 * and the length of that run differs at every station; its direction does too,
 * since with a tilted plate the lip can be above the plate at one end of the
 * board and below it at the other. That is why this is a mode and not a
 * `skirt_profile` recipe — a profile alone cannot pin one end of the run to a
 * flat machined shoulder while the other end follows the plate.
 *
 * The profile shapes the INNER face, walked from the plate towards the lip, so
 * a positive angle opens the well out as it rises and leaves room for the keys
 * to splay. The outer face is that same profile carried out by
 * `wall_thickness`, so the wall is of a piece whatever the profile does.
 */
function lipRings(
  lip: LipSpec, segs: SkirtSeg[], ztop: number, zbot: number,
): Vec2[] {
  const lipTop = lip.z + lip.thickness;
  const wt = lip.wall;

  // Inner face, from the plate's top edge to the bearing height. `rise` is
  // signed: negative simply means the lip sits below the plate here, and the
  // wall descends to meet it.
  const rise = lip.z - ztop;
  const innerPts: Vec2[] = [[lip.flange, ztop]];
  let d = lip.flange;
  let z = ztop;
  for (let si = 0; si < segs.length; si++) {
    const s = segs[si];
    const dz = s.frac * rise;
    // The outward component is taken from the DISTANCE travelled, not the
    // signed rise. The run reverses direction along a board whose plate
    // crosses the lip plane, and an angle that opened the well out on one side
    // would pull the wall into the plate on the other. Positive is outward
    // wherever the wall happens to be going.
    d += s.out !== null ? s.out : Math.abs(dz) * Math.tan(rad(s.angle!));
    z += dz;
    if (si === segs.length - 1) z = lip.z;   // land exactly on the shoulder
    innerPts.push([d, z]);
  }

  const iLip = d;
  const oLip = iLip + wt;
  const rings: Vec2[] = [...innerPts];
  rings.push([iLip, lipTop]);        // up the inside of the lip
  rings.push([oLip + lip.width, lipTop]);  // across its top, flush with the plank
  rings.push([oLip + lip.width, lip.z]);   // down its outer edge
  rings.push([oLip, lip.z]);               // back in along the bearing face
  // The outer face is the inner one carried out by the wall thickness, walked
  // back down. innerPts' last entry is already covered by the bearing face.
  for (let i = innerPts.length - 2; i >= 0; i--) {
    rings.push([innerPts[i][0] + wt, innerPts[i][1]]);
  }
  rings.push([lip.flange + wt, zbot]);     // straight past the plate's thickness
  return rings;
}

/** How many rings `lipRings` produces, which is the same at every station. */
function lipRingCount(segs: SkirtSeg[]): number {
  return 2 * segs.length + 6;
}

/**
 * How far the wall reaches out at or below the bearing face — what the hole
 * through the board has to clear.
 *
 * Anything above `lip_z` is either the lip itself, which the rebate is cut for,
 * or wall standing proud of the plank where the plate is higher than the lip.
 * Neither has to pass through the hole.
 */
function lipWallReach(lip: LipSpec, segs: SkirtSeg[], rings: Vec2[]): number {
  const s = segs.length;
  let max = 0;
  for (let i = 0; i < rings.length; i++) {
    // Three of the lip's rings are skipped rather than filtered by height: its
    // outer corners sit exactly ON the shoulder, and counting them would make
    // the hole as wide as the rebate and leave nothing to bear on. The fourth,
    // where the bearing face meets the wall, is KEPT — that is the wall's own
    // outer face at the shoulder, and on a board whose plate rises above the
    // lip it is the widest the wall ever gets. Dropping it undersized the hole
    // by a whole wall thickness and the case pushed through the shoulder.
    if (i >= s + 1 && i <= s + 3) continue;
    const [d, z] = rings[i];
    if (z > lip.z + 1e-9) continue;   // standing proud of the plank
    if (d > max) max = d;
  }
  return max;
}

/** The lip's outer edge at this station — what the rebate has to clear. */
function lipRebateReach(rings: Vec2[]): number {
  let max = 0;
  for (const [d] of rings) if (d > max) max = d;
  return max;
}

/** The closest the wall comes to the plate's edge; negative means it cuts in. */
function lipMinOffset(rings: Vec2[]): number {
  let min = Infinity;
  for (const [d] of rings) if (d < min) min = d;
  return min;
}

// ------------------------------------------------------------ skirt profile

interface SkirtSeg { frac: number; angle: number | null; out: number | null; }

/**
 * Normalise the skirt's outer cross-section into segments walked
 * top-to-bottom (see core.py _skirt_profile for the JSON format).
 */
function skirtProfile(keylistData: Keylist): SkirtSeg[] {
  let prof = keylistData.skirt_profile;
  if (!prof || prof.length === 0) {
    const mode = String(keylistData.skirt_mode ?? 'angle').toLowerCase();
    prof = mode === 'flare'
      ? [{ fraction: 1, out: keylistData.skirt_flare ?? 0 }]
      : [{ fraction: 1, angle: keylistData.skirt_angle ?? 0 }];
  }

  const segs: SkirtSeg[] = prof.map(s => ({
    frac: Number(s.fraction ?? 0),
    angle: 'angle' in s && s.angle !== undefined ? Number(s.angle) : null,
    out: 'out' in s && s.out !== undefined ? Number(s.out) : null,
  }));

  const total = segs.reduce((s, x) => s + x.frac, 0);
  if (total <= 1e-9) {
    throw new Error("skirt_profile: fractions sum to zero — at least one " +
      "segment must have a non-zero 'fraction'");
  }
  for (const s of segs) {
    s.frac /= total;
    if (s.out === null && s.angle === null) s.angle = 0;
    if (s.frac === 0 && s.out === null) {
      throw new Error("skirt_profile: a zero-fraction (horizontal) step " +
        "must specify 'out'");
    }
  }
  return segs;
}

// ------------------------------------------------------ 2D polygon helpers

function signedArea(pts: Vec2[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

function triArea2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segsProperlyCross(p: Vec2, q: Vec2, r: Vec2, s: Vec2): boolean {
  const d1 = triArea2(r, s, p);
  const d2 = triArea2(r, s, q);
  const d3 = triArea2(p, q, r);
  const d4 = triArea2(p, q, s);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  const [x, y] = p;
  let inside = false;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    if ((y0 > y) !== (y1 > y)) {
      const xin = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
      if (x < xin) inside = !inside;
    }
  }
  return inside;
}

/**
 * True if two 2D polygons overlap (a vertex of one inside the other, or any
 * pair of edges crossing).
 */
function polysOverlap(A: Vec2[], B: Vec2[]): boolean {
  for (const p of A) if (pointInPoly(p, B)) return true;
  for (const p of B) if (pointInPoly(p, A)) return true;
  const na = A.length, nb = B.length;
  for (let i = 0; i < na; i++) {
    for (let j = 0; j < nb; j++) {
      if (segsProperlyCross(A[i], A[(i + 1) % na], B[j], B[(j + 1) % nb])) return true;
    }
  }
  return false;
}

/**
 * Repair corner/bridge triangles that drape across a neighbouring switch
 * cutout.
 *
 * At a junction between keys — most visibly where a `linked_keys` bridge meets
 * a diagonal corner patch — the small gap is sealed by two triangles forming a
 * quad. Those triangles come from separate builders (the bridge in
 * buildTopSurface, the patch in diagonalCornerPatches) that each only know
 * three of the quad's four corners, so they can only share ONE diagonal. When
 * that diagonal is the wrong one, both triangles fan out over an adjacent key's
 * switch hole. Neither builder can pick the other diagonal alone (it needs the
 * fourth vertex), so we fix it here on the assembled surface: find such a
 * shared edge and flip it to the opposite diagonal when that lifts every
 * triangle clear of the holes.
 *
 * The hole test runs in each KEY'S OWN rotated frame — the cutout is only a
 * clean axis-aligned square there. The crossing only appears once keys are
 * tilted, so a flat top-down / XY test would both miss real crossings and flag
 * false ones on angled keys.
 */
/**
 * Replace every NON-PLANAR polygon in the surface with explicit triangles.
 *
 * A warped quad does not define a surface on its own: it has to be split along
 * one of its two diagonals, and which one is chosen changes the shape.
 * buildShell emits the underside as the same loops with REVERSED winding, so a
 * consumer that fan-triangulates from the first vertex (three.js, an STL
 * writer, Blender) splits the top quad [a,b,c,d] on a-c but the reversed
 * bottom [d,c,b,a] on d-b — the OPPOSITE diagonal. The two surfaces then are
 * not parallel, and wherever a quad's warp approaches the plate thickness they
 * cross: the underside pierces up through the top, leaving a visible sliver of
 * inverted surface. Bridges between keys that differ a lot in tilt and height
 * (an offset, rotated thumb key) warp the most and hit this first.
 *
 * Splitting here, once, removes the ambiguity for everyone downstream: top,
 * underside and any exporter all use the same diagonal. We take the shorter
 * diagonal, which keeps the two triangles closest to the intended surface.
 *
 * Only the face list is rewritten. The accumulated vertex normals are left
 * exactly as the original polygons set them, so unitNormals() — and with it
 * the constant-thickness bottom offset — is completely unaffected. The
 * boundary is untouched too: the four original edges each still appear once
 * and the new diagonal appears twice (interior), so perimeter loops, walls and
 * skirts are unchanged. Planar faces are left alone, since for those the
 * diagonal makes no difference to the surface.
 */
function triangulateNonplanarFaces(top: TopSurface, tol = 1e-9): void {
  const out: Face[] = [];
  const P = top.points;

  for (const f of top.faces) {
    if (f.length < 4) { out.push(f); continue; }

    const pts = f.map(i => P[i]);
    const nrm = norm(faceNormal(pts));
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[2], 0) / pts.length;
    let warp = 0;
    for (const p of pts) {
      const dz = Math.abs((p[0] - cx) * nrm[0] + (p[1] - cy) * nrm[1] +
                          (p[2] - cz) * nrm[2]);
      if (dz > warp) warp = dz;
    }
    if (warp <= tol) { out.push(f); continue; }

    if (f.length === 4) {
      const [a, b, c, d] = f;
      const d2 = (i: number, j: number) => {
        const pi = P[i], pj = P[j];
        return (pi[0] - pj[0]) ** 2 + (pi[1] - pj[1]) ** 2 + (pi[2] - pj[2]) ** 2;
      };
      if (d2(a, c) <= d2(b, d)) { out.push([a, b, c]); out.push([a, c, d]); }
      else { out.push([b, c, d]); out.push([b, d, a]); }
    } else {
      for (let k = 1; k < f.length - 1; k++) out.push([f[0], f[k], f[k + 1]]);
    }
  }

  top.faces = out;
}

function flipFacesOffHoles(
  top: TopSurface, keys: KeyEntry[], key1u: number,
  holeSize: number, thickness: number,
): void {
  if (keys.length === 0) return;

  const half = holeSize / 2;
  const holeSq: Vec2[] = [[-half, half], [-half, -half], [half, -half], [half, half]];
  const kinfo: [Vec3, KeyEntry][] =
    keys.map(k => [[k.pos.x, k.pos.y, k.pos.z], k]);
  const ztol = thickness + 1;
  const reach2 = (1.3 * key1u) ** 2;

  const overHole = (triWorld: Vec3[]): boolean => {
    const cx = (triWorld[0][0] + triWorld[1][0] + triWorld[2][0]) / 3;
    const cy = (triWorld[0][1] + triWorld[1][1] + triWorld[2][1]) / 3;
    for (const [pos, k] of kinfo) {
      if ((cx - pos[0]) ** 2 + (cy - pos[1]) ** 2 > reach2) continue;
      const loc = triWorld.map(p => unplace(p, k));
      // Only faces sitting in this key's plane can occlude its cutout.
      if (Math.abs((loc[0][2] + loc[1][2] + loc[2][2]) / 3) > ztol) continue;
      if (polysOverlap(loc.map(p => [p[0], p[1]] as Vec2), holeSq)) return true;
    }
    return false;
  };

  const P = top.points;
  const faces = top.faces;

  // Map every triangle edge to (faceIndex, oppositeVertex).
  const edgeFaces = new Map<string, [number, number][]>();
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    if (f.length !== 3) continue;
    const [a, b, c] = f;
    for (const [u, v, w] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      const k = edgeKey(u, v);
      const lst = edgeFaces.get(k);
      if (lst) lst.push([fi, w]);
      else edgeFaces.set(k, [[fi, w]]);
    }
  }

  const flipped = new Set<number>();
  const changes = new Map<number, Face>();
  for (const [edge, lst] of edgeFaces) {
    if (lst.length !== 2) continue;
    const [[fi1, w1], [fi2, w2]] = lst;
    if (flipped.has(fi1) || flipped.has(fi2)) continue;
    const [u, v] = edge.split(',').map(Number);
    const a = w1, b = w2;              // the two off-diagonal tips
    if (a === b || edgeFaces.has(edgeKey(a, b))) continue; // dup / non-manifold

    const cur1: Vec3[] = [P[u], P[v], P[a]];
    const cur2: Vec3[] = [P[u], P[v], P[b]];
    if (!(overHole(cur1) || overHole(cur2))) continue;     // current split fine

    const new1: Vec3[] = [P[a], P[b], P[u]];
    const new2: Vec3[] = [P[a], P[b], P[v]];
    if (overHole(new1) || overHole(new2)) continue;        // flip wouldn't help

    // Keep the surface orientation: match each new triangle's normal to the
    // two originals' combined normal.
    const n1 = faceNormal(faces[fi1].map(i => P[i]));
    const n2 = faceNormal(faces[fi2].map(i => P[i]));
    const ref: Vec3 = [n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]];

    const oriented = (triIdx: Face, triWorld: Vec3[]): Face => {
      const nrm = faceNormal(triWorld);
      if (nrm[0] * ref[0] + nrm[1] * ref[1] + nrm[2] * ref[2] < 0) {
        return [triIdx[0], triIdx[2], triIdx[1]];
      }
      return triIdx;
    };

    changes.set(fi1, oriented([a, b, u], new1));
    changes.set(fi2, oriented([a, b, v], new2));
    flipped.add(fi1);
    flipped.add(fi2);
  }

  if (changes.size === 0) return;

  // Apply. Update accumulated vertex normals incrementally (remove the old face
  // contribution, add the new) so untouched vertices stay bit-identical.
  for (const [fi, newf] of changes) {
    const oldf = faces[fi];
    const on = faceNormal(oldf.map(i => P[i]));
    for (const i of oldf) {
      top.normals[i][0] -= on[0];
      top.normals[i][1] -= on[1];
      top.normals[i][2] -= on[2];
    }
    const nn = faceNormal(newf.map(i => P[i]));
    for (const i of newf) {
      top.normals[i][0] += nn[0];
      top.normals[i][1] += nn[1];
      top.normals[i][2] += nn[2];
    }
    faces[fi] = newf;
  }
}

const coincident = (a: Vec2, b: Vec2, eps = 1e-9) =>
  Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = triArea2(p, a, b);
  const d2 = triArea2(p, b, c);
  const d3 = triArea2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Ear-clip a simple polygon (concave OK, no holes). CCW index triples. */
function earClip(pts: Vec2[]): [number, number, number][] {
  const n = pts.length;
  if (n < 3) return [];

  let idx = Array.from({ length: n }, (_, i) => i);
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    area2 += pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1];
  }
  if (area2 < 0) idx.reverse();

  const tris: [number, number, number][] = [];
  let guard = 0;
  const limit = 10 * n * n + 100;
  while (idx.length > 2 && guard < limit) {
    guard++;
    let clipped = false;
    const m = idx.length;
    for (let k = 0; k < m; k++) {
      const i0 = idx[(k - 1 + m) % m], i1 = idx[k], i2 = idx[(k + 1) % m];
      const a = pts[i0], b = pts[i1], c = pts[i2];
      if (triArea2(a, b, c) <= 1e-12) continue; // reflex/degenerate corner
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = pts[j];
        if (coincident(p, a) || coincident(p, b) || coincident(p, c)) continue;
        if (pointInTri(p, a, b, c)) { ok = false; break; }
      }
      if (ok) {
        tris.push([i0, i1, i2]);
        idx.splice(k, 1);
        clipped = true;
        break;
      }
    }
    if (!clipped) break;
  }

  if (idx.length > 2) {
    throw new Error('baseplate: could not triangulate the outline ' +
      '(is it self-intersecting?)');
  }
  return tris;
}

/**
 * Merge HOLES into an OUTER polygon by cutting a zero-width bridge to each,
 * producing one simple polygon for ear clipping.
 */
function bridgeHoles(outer: Vec2[], holes: Vec2[][]): Vec2[] {
  let poly = [...outer];
  if (signedArea(poly) < 0) poly.reverse();

  const sortedHoles = [...holes].sort(
    (h1, h2) => Math.max(...h2.map(p => p[0])) - Math.max(...h1.map(p => p[0])),
  );
  for (const hole of sortedHoles) {
    const h = [...hole];
    if (signedArea(h) > 0) h.reverse(); // holes traverse CW

    // Bridge from the hole's right-most vertex.
    let mi = 0;
    for (let i = 1; i < h.length; i++) if (h[i][0] > h[mi][0]) mi = i;
    const M = h[mi];

    let best: number | null = null;
    let bestD: number | null = null;
    const n = poly.length;
    for (let pi = 0; pi < n; pi++) {
      const P = poly[pi];
      let ok = true;
      for (let j = 0; j < n; j++) {
        const a = poly[j], b = poly[(j + 1) % n];
        if (j === pi || (j + 1) % n === pi) continue;
        if (segsProperlyCross(M, P, a, b)) { ok = false; break; }
      }
      if (ok) {
        for (let j = 0; j < h.length; j++) {
          const a = h[j], b = h[(j + 1) % h.length];
          if (j === mi || (j + 1) % h.length === mi) continue;
          if (segsProperlyCross(M, P, a, b)) { ok = false; break; }
        }
      }
      if (ok) {
        const mid: Vec2 = [(M[0] + P[0]) / 2, (M[1] + P[1]) / 2];
        if (!pointInPoly(mid, poly)) ok = false;
        else if (pointInPoly(mid, h)) ok = false;
      }
      if (ok) {
        const d = (M[0] - P[0]) ** 2 + (M[1] - P[1]) ** 2;
        if (bestD === null || d < bestD) { best = pi; bestD = d; }
      }
    }

    if (best === null) {
      throw new Error('insert hole could not be bridged to the outline ' +
        '(is it outside the baseplate, or overlapping?)');
    }

    // Splice: ...P, hole[mi..end], hole[0..mi], P...
    poly = [
      ...poly.slice(0, best + 1),
      ...h.slice(mi), ...h.slice(0, mi + 1),
      ...poly.slice(best),
    ];
  }
  return poly;
}

function triangulateWithHoles(
  outer: Vec2[], holes: Vec2[][],
): { points: Vec2[]; tris: [number, number, number][] } {
  if (holes.length === 0) {
    const pts = [...outer];
    return { points: pts, tris: earClip(pts) };
  }
  const merged = bridgeHoles(outer, holes);
  return { points: merged, tris: earClip(merged) };
}

/** CCW circle as (x, y) points. */
function circlePts(cx: number, cy: number, r: number, segments = 32): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

function cross2(o: Vec2, a: Vec2, b: Vec2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Andrew monotonic chain convex hull. CCW, first point not repeated. */
function convexHull(points: Vec2[]): Vec2[] {
  // De-dup exactly and sort lexicographically (matches sorted(set(points))).
  const seen = new Set<string>();
  const pts: Vec2[] = [];
  for (const p of points) {
    const k = `${p[0]},${p[1]}`;
    if (!seen.has(k)) { seen.add(k); pts.push(p); }
  }
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  if (pts.length <= 1) return pts;

  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 &&
        cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 &&
        cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// -------------------------------------------------------- perimeter chains

const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Extract the OUTER perimeter of a built TopSurface as ordered vertex-index
 * loops (boundary edges not lying entirely on a switch-cutout rim).
 */
function perimeterLoops(top: TopSurface, holeVertIds: Set<number>): number[][] {
  const edgeCount = new Map<string, number>();
  for (const f of top.faces) {
    const m = f.length;
    for (let i = 0; i < m; i++) {
      const e = edgeKey(f[i], f[(i + 1) % m]);
      edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
    }
  }

  const perimEdges: [number, number][] = [];
  for (const [e, cnt] of edgeCount) {
    if (cnt !== 1) continue;
    const [a, b] = e.split(',').map(Number);
    if (holeVertIds.has(a) && holeVertIds.has(b)) continue; // switch hole rim
    perimEdges.push([a, b]);
  }

  const adj = new Map<number, number[]>();
  for (const [a, b] of perimEdges) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }

  const unused = new Set(perimEdges.map(([a, b]) => edgeKey(a, b)));
  const edgeByKey = new Map(perimEdges.map(([a, b]) => [edgeKey(a, b), [a, b] as [number, number]]));
  const loops: number[][] = [];
  while (unused.size > 0) {
    const startKey = unused.values().next().value as string;
    const [a, b] = edgeByKey.get(startKey)!;
    const loop = [a, b];
    unused.delete(startKey);
    for (;;) {
      const cur = loop[loop.length - 1];
      let nxt: number | null = null;
      for (const cand of adj.get(cur) ?? []) {
        const e = edgeKey(cur, cand);
        if (unused.has(e)) { nxt = cand; unused.delete(e); break; }
      }
      if (nxt === null) break;
      if (nxt === loop[0]) break; // closed
      loop.push(nxt);
    }
    loops.push(loop);
  }
  return loops;
}

/**
 * For an ordered perimeter loop, return [loop forced CCW, unit outward XY
 * normal per loop vertex].
 */
function outwardNormalsXY(
  points: Vec3[], loopIn: number[],
): [number[], Vec2[]] {
  let loop = loopIn;
  const n = loop.length;
  let pts = loop.map(i => points[i]);

  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    area2 += x0 * y1 - x1 * y0;
  }
  if (area2 < 0) {
    loop = [...loop].reverse();
    pts = loop.map(i => points[i]);
  }

  const edgeOut = (p: Vec3, q: Vec3): Vec2 => {
    const dx = q[0] - p[0], dy = q[1] - p[1];
    // Right of travel for CCW loop = outward: (dy, -dx)
    const ox = dy, oy = -dx;
    const m = Math.sqrt(ox * ox + oy * oy);
    return m > 1e-12 ? [ox / m, oy / m] : [0, 0];
  };

  const normals: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prevP = pts[(i - 1 + n) % n];
    const curP = pts[i];
    const nextP = pts[(i + 1) % n];
    const e0 = edgeOut(prevP, curP);
    const e1 = edgeOut(curP, nextP);
    const ox = e0[0] + e1[0], oy = e0[1] + e1[1];
    const m = Math.sqrt(ox * ox + oy * oy);
    normals.push(m > 1e-12 ? [ox / m, oy / m] : e1);
  }
  return [loop, normals];
}

// ------------------------------------------------------------- buildShell

/**
 * Stitch two vertical vertex columns (bottom -> top ordered indices) into a
 * watertight triangle strip; the columns may have different point counts.
 */
function stitchColumns(
  faces: Face[], vertices: Vec3[], colA: number[], colB: number[],
): void {
  let ia = 0, ib = 0;
  const za = colA.map(i => vertices[i][2]);
  const zb = colB.map(i => vertices[i][2]);
  const na = colA.length, nb = colB.length;
  while (ia < na - 1 || ib < nb - 1) {
    const canA = ia < na - 1;
    const canB = ib < nb - 1;
    if (canA && (!canB || za[ia + 1] <= zb[ib + 1])) {
      faces.push([colB[ib], colA[ia], colA[ia + 1]]);
      ia++;
    } else {
      faces.push([colB[ib], colA[ia], colB[ib + 1]]);
      ib++;
    }
  }
}

/**
 * Build a constant-thickness SHELL of the key plate: top follows the tilted
 * switch planes, bottom is a uniform-thickness perpendicular offset, switch
 * cutouts pass through perpendicular to the top. With `skirt: true` the
 * plate grows fused walls sweeping down to `wall_base_z`. Returns one
 * closed manifold.
 */
/**
 * Apply the whole-plate tent/pitch tilt to a built TopSurface, compute the
 * constant-thickness offset bottom, and lift the result so the plate clears the
 * base plane. Mutates `top` in place and returns the bottom points.
 *
 * Shared by buildShell and skirtOuterRings so the case and the baseplate are
 * derived from the SAME tilted, lifted perimeter. Previously only buildShell
 * tilted the plate, so with a non-zero tent_angle/pitch_angle the baseplate was
 * generated from the UNTILTED perimeter and no longer lined up with the case it
 * is supposed to close (the skirt's outward flare was wrong too, since it
 * scales with each vertex's height above the base).
 *
 * With no tilt requested this is exactly the original bottom-offset step, so
 * untilted boards are unaffected.
 */
function tiltAndOffset(data: Keylist, top: TopSurface): Vec3[] {
  const thickness = data.thickness ?? 5;
  const tentAngle = Number(data.tent_angle ?? 0) || 0;
  const pitchAngle = Number(data.pitch_angle ?? 0) || 0;
  const tilted = Boolean(tentAngle || pitchAngle);

  if (tilted) {
    const pts = top.points;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const tilt = (p: Vec3): Vec3 => {
      const q = rotXYZ([p[0] - cx, p[1] - cy, p[2]], pitchAngle, tentAngle, 0);
      return [q[0] + cx, q[1] + cy, q[2]];
    };
    top.points = pts.map(tilt);
    // Rotate accumulated face normals and per-vertex offset normals the same
    // way, so the bottom still drops perpendicular to the (now tilted) top.
    top.normals = top.normals.map(nz =>
      rotXYZ([nz[0], nz[1], nz[2]], pitchAngle, tentAngle, 0) as [number, number, number]);
    const rotated = new Map<number, Vec3>();
    for (const [vi, nrm] of top.offsetNormal) {
      rotated.set(vi, rotXYZ(nrm, pitchAngle, tentAngle, 0));
    }
    top.offsetNormal = rotated;
  }

  // --- Offset bottom ------------------------------------------------------
  const unit = top.unitNormals();
  const override = top.offsetNormal;
  const botPts: Vec3[] = [];
  for (let vi = 0; vi < top.points.length; vi++) {
    const p = top.points[vi];
    const u = override.get(vi) ?? unit[vi];
    botPts.push([
      p[0] - u[0] * thickness,
      p[1] - u[1] * thickness,
      p[2] - u[2] * thickness,
    ]);
  }

  // Lift the tilted plate so its lowest point clears the base.
  if (tilted) {
    const baseZ0 = Number(data.wall_base_z ?? 0);
    const minClear = Number(data.plate_min_wall ?? 1);
    // Loop rather than Math.min(...arr): the spread would blow the argument
    // limit on large boards.
    let minZ = Infinity;
    for (const p of top.points) if (p[2] < minZ) minZ = p[2];
    for (const p of botPts) if (p[2] < minZ) minZ = p[2];
    if (minZ < baseZ0 + minClear) {
      const dz = baseZ0 + minClear - minZ;
      top.points = top.points.map(p => [p[0], p[1], p[2] + dz] as Vec3);
      for (let i = 0; i < botPts.length; i++) {
        botPts[i] = [botPts[i][0], botPts[i][1], botPts[i][2] + dz];
      }
    }
  }

  return botPts;
}

export function buildShell(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const style = wallStyle(data);
  let verticalEdges = data.vertical_edges ?? true;
  // A fused skirt REQUIRES an aligned (vertical) perimeter, and the lip style
  // hangs its walls off that same perimeter.
  if (style === 'skirt' || style === 'lip') verticalEdges = true;

  const { top, holeVertIds } = buildTopSurface(data);

  // --- Tent/pitch tilt, offset bottom and clearance lift. Done in
  //     tiltAndOffset so skirtOuterRings (the baseplate) can apply exactly the
  //     same transform and stay aligned with the case. ---
  const botPts = tiltAndOffset(data, top);
  let topPts = [...top.points];

  // --- Vertical outer perimeter (move each outer BOTTOM vertex below its
  //     TOP vertex) so the plate drops straight into a wall recess. -----
  if (verticalEdges) {
    for (const lp of perimeterLoops(top, holeVertIds)) {
      for (const vi of lp) {
        const [tx, ty] = topPts[vi];
        const bz = botPts[vi][2];
        botPts[vi] = [tx, ty, bz];
      }
    }
  }

  // Assemble the final shell mesh.
  const vertices: Vec3[] = [...topPts, ...botPts];
  const n = topPts.length;
  const faces: Face[] = [];

  // --- Optional fused SKIRT walls ----------------------------------------
  // The lip style sweeps walls off the same perimeter; only the cross-section
  // differs, so everything downstream treats the two alike.
  const skirt = style === 'skirt' || style === 'lip';
  const lip = style === 'lip' ? lipSpec(data) : null;
  const wallThickness = data.wall_thickness ?? 2;
  const skirtFlange = data.skirt_flange ?? 0;
  const baseZ = data.wall_base_z ?? 0;
  const constantThickness = data.constant_thickness_walls ?? false;

  // Outward XY normals for the OUTER perimeter loop(s) only.
  const skirtNormals = new Map<number, Vec2>();
  if (skirt) {
    const loops = perimeterLoops(top, holeVertIds);
    if (loops.length > 0) {
      const bboxArea = (lp: number[]) => {
        const xs = lp.map(v => topPts[v][0]);
        const ys = lp.map(v => topPts[v][1]);
        return (Math.max(...xs) - Math.min(...xs)) *
          (Math.max(...ys) - Math.min(...ys));
      };
      const areas = loops.map(bboxArea);
      const amax = Math.max(...areas);
      for (let li = 0; li < loops.length; li++) {
        if (areas[li] < 0.5 * amax) continue; // interior hole: no skirt
        const [olp, nrms] = outwardNormalsXY(topPts, loops[li]);
        for (let i = 0; i < olp.length; i++) skirtNormals.set(olp[i], nrms[i]);
      }
    }
  }

  // Intermediate rings per perimeter vertex (see core.py for the diagram).
  const segs = skirt ? skirtProfile(data) : [];
  // The lip's run to the plate is a different length at every station, so its
  // section is worked out per vertex; only the count is fixed.
  const ringCount = lip === null ? segs.length + 1 : lipRingCount(segs);
  const rings: Map<number, number>[] =
    Array.from({ length: ringCount }, () => new Map());
  const rimRing = new Map<number, number>();
  const innerCols = new Map<number, number[]>();

  for (const [vi, [nx, ny]] of skirtNormals) {
    const p = topPts[vi];
    const ztop = p[2];
    const drop = ztop - baseZ;

    const ringDz: Vec2[] = [];
    if (lip !== null) {
      // No check on where the lip falls against the plate: it is free to sit
      // above the plate at one station and below it at the next, which is the
      // point of pinning it to an absolute height on a tilted board.
      const section = lipRings(lip, segs, ztop, vertices[vi + n][2]);
      const minD = lipMinOffset(section);
      if (minD < -1e-9) {
        throw new Error(
          `the wall cuts ${(-minD).toFixed(2)}mm inside the plate's own edge ` +
          `here. skirt_angle is measured from the plate towards the lip, so a ` +
          'negative angle draws the wall in over the whole run — use a positive ' +
          'angle to open the well out and leave room for the keys.');
      }
      for (let ri = 0; ri < section.length; ri++) {
        const [d, z] = section[ri];
        rings[ri].set(vi, vertices.length);
        vertices.push([p[0] + nx * d, p[1] + ny * d, z]);
        ringDz.push([d, z]);
      }
    } else {
      let d = skirtFlange;
      let z = ztop;
      rings[0].set(vi, vertices.length);
      vertices.push([p[0] + nx * d, p[1] + ny * d, z]);
      ringDz.push([d, z]);

      for (let si = 0; si < segs.length; si++) {
        const s = segs[si];
        const dz = s.frac * drop;
        const out = s.out !== null ? s.out : dz * Math.tan(rad(s.angle!));
        d += out;
        z -= dz;
        if (si === segs.length - 1) z = baseZ; // land exactly on base_z
        rings[si + 1].set(vi, vertices.length);
        vertices.push([p[0] + nx * d, p[1] + ny * d, z]);
        ringDz.push([d, z]);
      }
    }

    if (lip !== null) {
      // Nothing hangs below the plate in this style, so the last ring closes
      // straight onto the plate's own bottom perimeter: the band between them
      // is the wall's underside, and the inner column has nowhere left to go.
      rimRing.set(vi, vi + n);
      innerCols.set(vi, [vi + n]);
      continue;
    }

    rimRing.set(vi, vertices.length);
    const dBottom = ringDz[ringDz.length - 1][0];
    const di = dBottom - wallThickness;
    vertices.push([p[0] + nx * di, p[1] + ny * di, baseZ]);

    // Inner-face column (bottom -> top).
    const col = [rimRing.get(vi)!];
    if (constantThickness) {
      const zbot = vertices[vi + n][2]; // plate underside z at this vertex

      // Smooth constant-thickness inner wall via Minkowski EROSION: the
      // inner face is the lower envelope of radius-wt disks centred on a
      // dense sampling of the outer polyline.
      const wt = wallThickness;
      const opts: Vec2[] = [];
      for (let i = 0; i < ringDz.length - 1; i++) {
        const [d0, z0] = ringDz[i];
        const [d1, z1] = ringDz[i + 1];
        const segLen = Math.hypot(d1 - d0, z1 - z0);
        const steps = Math.max(1, Math.floor(segLen / 0.15));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          opts.push([d0 + (d1 - d0) * t, z0 + (z1 - z0) * t]);
        }
      }

      const span = zbot - baseZ;
      if (span > 1e-6) {
        const nz = Math.max(2, Math.floor(span / 0.4));
        for (let zi = 1; zi < nz; zi++) {
          const zc = baseZ + (span * zi) / nz;
          let best: number | null = null;
          for (const [pd, pz] of opts) {
            const dz = zc - pz;
            if (-wt < dz && dz < wt) {
              const left = pd - Math.sqrt(wt * wt - dz * dz);
              if (best === null || left < best) best = left;
            }
          }
          if (best === null) continue;
          const dIn = Math.max(best, 0);
          const idx = vertices.length;
          vertices.push([p[0] + nx * dIn, p[1] + ny * dIn, zc]);
          col.push(idx);
        }
      }
    }
    col.push(vi + n); // P4, plate bottom perimeter
    innerCols.set(vi, col);
  }

  // Top faces keep CCW-from-above winding; bottoms are shifted + reversed.
  for (const f of top.faces) {
    faces.push([...f]);
    faces.push(f.map(i => i + n).reverse());
  }

  // Boundary walls: stitch each boundary edge (used by exactly one top face)
  // down, keeping the edge's directed orientation for outward winding.
  const edgeCount = new Map<string, number>();
  const directed = new Map<string, [number, number]>();
  for (const f of top.faces) {
    const m = f.length;
    for (let i = 0; i < m; i++) {
      const a = f[i], b = f[(i + 1) % m];
      const e = edgeKey(a, b);
      edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
      directed.set(e, [a, b]);
    }
  }

  for (const [e, cnt] of edgeCount) {
    if (cnt !== 1) continue; // interior edge -> no wall
    const [a, b] = directed.get(e)!;
    if (skirt && rimRing.has(a) && rimRing.has(b)) {
      // Skirt strip: P0 -> flange -> profile segments -> flat rim -> back up
      // the inner face to the plate's bottom perimeter (P4).
      faces.push([b, a, rings[0].get(a)!, rings[0].get(b)!]);
      for (let i = 0; i < rings.length - 1; i++) {
        faces.push([
          rings[i].get(b)!, rings[i].get(a)!,
          rings[i + 1].get(a)!, rings[i + 1].get(b)!,
        ]);
      }
      const last = rings[rings.length - 1];
      faces.push([last.get(b)!, last.get(a)!, rimRing.get(a)!, rimRing.get(b)!]);
      stitchColumns(faces, vertices, innerCols.get(a)!, innerCols.get(b)!);
    } else {
      // Ordinary vertical band (switch-cutout rims, interior holes, and the
      // whole perimeter when the skirt is off).
      faces.push([b, a, a + n, b + n]);
    }
  }

  return { vertices, faces };
}

export function buildShellFromAny(data: Entry): Mesh {
  return buildShell(resolveKeylist(data));
}

// ------------------------------------------------------------- buildWalls

/**
 * Build the perimeter WALLS as a separate object: a recess frame the plate
 * drops into. One closed manifold per outer perimeter loop.
 */
/**
 * One perimeter vertex's sweep frame: the plate's underside point there, the
 * outward XY normal, the rim height, and the underside plane through it.
 */
interface WallFrame {
  /**
   * Datum every cross-section offset is measured from: a point on the plate's
   * OUTER FACE. Not the underside point b — see wallLoopFrames.
   */
  bx: number; by: number;
  nx: number; ny: number;
  /**
   * How far the plate's UNDERSIDE reaches past the outer face here. The plate
   * is widest at the bottom on a tilted key, so the recess opens out by this
   * much between the rim and the ledge rather than standing vertically at the
   * widest point — which would leave a visible gap at the top of the plate.
   */
  bulge: number;
  mitre: number;
  rim: number;
  /** This station's tangent plane to the plate underside. */
  planeZ: (x: number, y: number) => number;
  /** The plate's real underside at (x, y), or null if not over the plate. */
  sampleZ: (x: number, y: number) => number | null;
}

/**
 * The plate's underside as triangles, rebuilt the way buildShell builds it:
 * each vertex pushed down its own offset normal, then the perimeter squared up
 * when vertical_edges is set. Used to sit the support ledge on the surface the
 * plate actually presents rather than on one station's extrapolated plane.
 */
function plateUndersidePoints(
  data: Keylist, top: TopSurface, holeVertIds: Set<number>, verticalEdges: boolean,
): Vec3[] {
  const thickness = data.thickness ?? 5;
  const unit = top.unitNormals();
  const override = top.offsetNormal;

  const bot: Vec3[] = top.points.map((p, vi) => {
    const u = override.get(vi) ?? unit[vi];
    return [p[0] - u[0] * thickness, p[1] - u[1] * thickness, p[2] - u[2] * thickness];
  });
  if (verticalEdges) {
    for (const lp of perimeterLoops(top, holeVertIds)) {
      for (const vi of lp) bot[vi] = [top.points[vi][0], top.points[vi][1], bot[vi][2]];
    }
  }
  return bot;
}

function undersideTrisFrom(top: TopSurface, bot: Vec3[]): Vec3[][] {
  const tris: Vec3[][] = [];
  for (const f of top.faces) {
    for (let i = 1; i + 1 < f.length; i++) {
      tris.push([bot[f[0]], bot[f[i]], bot[f[i + 1]]]);
    }
  }
  return tris;
}

/**
 * Sit the ledge this far under the plate rather than exactly on it. Placing it
 * flush leaves the two surfaces coincident, so the swept ledge grazes in and
 * out of the plate by a few hundredths of a millimetre wherever the underside
 * curves between samples — geometrically an intersection, and coincident faces
 * are the kind of thing slicers handle badly. Well under one layer height, so
 * the plate still seats on the ledge.
 */
const LEDGE_CLEARANCE = 0.05;

/**
 * Target spacing of ledge points across the ledge's width, in mm.
 *
 * The ledge used to be one quad spanning plate_gap to plate_gap - plate_lip.
 * A quad is bilinear, so a wide one cannot follow a plate whose underside
 * changes across it: at plate_lip 5 the interior sat 3.27mm INSIDE the plate
 * while all four corners were within 0.15mm. Splitting the span into steps of
 * about this size lets the ledge track the underside across its width.
 */
const LEDGE_STEP = 1.0;

/** Ledge points across the width: one per LEDGE_STEP, at least two. */
function ledgeStepCount(plateLip: number): number {
  return Math.max(1, Math.ceil(Math.abs(plateLip) / LEDGE_STEP));
}

/**
 * Extra wall stations where the ledge needs them.
 *
 * The ledge is swept as a straight edge between consecutive stations, so where
 * the plate's underside dips between two of them the edge bows up through it.
 * Moving the existing stations down to compensate was tried and rejected — it
 * gouges the ledge without reducing crossings (see docs/skirt-off-walls.md).
 * The spacing is the real problem, so add stations: bisect a segment while its
 * ledge edge still bows, and let each new station sit on the underside like any
 * other.
 *
 * Inserting on a straight run is harmless — the recess and outer faces stay on
 * the same lines — and the baseplate is built from these same frames, so its
 * footprint follows automatically.
 */
function subdivideForLedge(
  frames: WallFrame[], inner: number, ledgeIn: number,
): WallFrame[] {
  const TOL = 0.02;      // mm of bow worth splitting for
  const MAX_DEPTH = 4;   // up to 15 extra stations per segment
  const SEG = 8;         // bow samples per test

  const lerpFrame = (a: WallFrame, b: WallFrame, t: number): WallFrame => {
    // Interpolate the normal ALREADY SCALED by its mitre, and carry mitre 1.
    // Normalising it instead makes the offset longer than a straight
    // interpolation, so the inserted station bulges off the line joining its
    // neighbours — harmless at a convex corner, but at a reflex one it pushes
    // the outer ring across itself and the baseplate then fails to
    // triangulate. This way every offset point is the exact interpolation of
    // the neighbouring stations' corresponding points, at any offset, so
    // subdividing adds vertices along the swept surfaces without moving them.
    const ax = a.nx * a.mitre, ay = a.ny * a.mitre;
    const bx2 = b.nx * b.mitre, by2 = b.ny * b.mitre;
    return {
      bx: a.bx + (b.bx - a.bx) * t,
      by: a.by + (b.by - a.by) * t,
      nx: ax + (bx2 - ax) * t,
      ny: ay + (by2 - ay) * t,
      bulge: a.bulge + (b.bulge - a.bulge) * t,
      mitre: 1,
      rim: a.rim + (b.rim - a.rim) * t,
      planeZ: (x, y) => a.planeZ(x, y) + (b.planeZ(x, y) - a.planeZ(x, y)) * t,
      sampleZ: a.sampleZ,
    };
  };

  // Must match ledgeHeights in buildWalls, or this is testing an edge the
  // builder will not produce.
  const ledgeZ = (f: WallFrame, base: number) => {
    const off = (base + f.bulge) * f.mitre;
    const x = f.bx + f.nx * off, y = f.by + f.ny * off;
    const r = f.sampleZ(x, y);
    const p = f.planeZ(x, y);
    return r === null ? p : Math.min(p, r - LEDGE_CLEARANCE);
  };

  /** How far the ledge edge a->b rises above the underside, at one offset. */
  const bowOf = (a: WallFrame, b: WallFrame, off: number) => {
    const za = ledgeZ(a, off), zb = ledgeZ(b, off);
    const ax = a.bx + a.nx * (off + a.bulge) * a.mitre, ay = a.by + a.ny * (off + a.bulge) * a.mitre;
    const bx = b.bx + b.nx * (off + b.bulge) * b.mitre, by = b.by + b.ny * (off + b.bulge) * b.mitre;
    let worst = 0;
    for (let s = 1; s < SEG; s++) {
      const t = s / SEG;
      const r = a.sampleZ(ax + (bx - ax) * t, ay + (by - ay) * t);
      if (r === null) continue;
      const bow = za + (zb - za) * t - r;
      if (bow > worst) worst = bow;
    }
    return worst;
  };

  const out: WallFrame[] = [];
  const n = frames.length;

  const refine = (
    a: WallFrame, b: WallFrame, tLo: number, tHi: number, depth: number,
  ) => {
    if (depth >= MAX_DEPTH) return;
    const fa = tLo === 0 ? a : lerpFrame(a, b, tLo);
    const fb = tHi === 1 ? b : lerpFrame(a, b, tHi);
    // Test across the ledge, not just along its two edges: the quad is
    // bilinear, so it can bulge through the plate in the middle while both
    // edges stay clear.
    const mid = (inner + ledgeIn) / 2;
    if (bowOf(fa, fb, inner) <= TOL && bowOf(fa, fb, mid) <= TOL &&
        bowOf(fa, fb, ledgeIn) <= TOL) return;
    const tm = (tLo + tHi) / 2;
    refine(a, b, tLo, tm, depth + 1);
    out.push(lerpFrame(a, b, tm));
    refine(a, b, tm, tHi, depth + 1);
  };

  for (let i = 0; i < n; i++) {
    out.push(frames[i]);
    refine(frames[i], frames[(i + 1) % n], 0, 1, 0);
  }
  return out;
}

/** vertex -> the vertices sharing a face with it, from the top surface. */
function vertexNeighbours(top: TopSurface): Map<number, Set<number>> {
  const nbr = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let s = nbr.get(a);
    if (s === undefined) { s = new Set(); nbr.set(a, s); }
    s.add(b);
  };
  for (const f of top.faces) {
    for (let i = 0; i < f.length; i++) {
      for (let j = 0; j < f.length; j++) if (i !== j) link(f[i], f[j]);
    }
  }
  return nbr;
}

/**
 * Height of the plate's underside directly above (x, y), or null when that
 * point is not over the plate at all (the ledge's outer edge usually sits out
 * in the plate_gap). Barycentric point-in-triangle on the XY projection.
 */
function undersideSampleZ(x: number, y: number, tris: Vec3[][]): number | null {
  let best: number | null = null;
  for (const t of tris) {
    const [a, b, c] = t;
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const w0 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    if (w0 < -1e-9 || w0 > 1 + 1e-9) continue;
    const w1 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    if (w1 < -1e-9 || w1 > 1 + 1e-9) continue;
    const w2 = 1 - w0 - w1;
    if (w2 < -1e-9 || w2 > 1 + 1e-9) continue;
    const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
    // LOWEST sheet wins. Where the underside folds over itself in plan — the
    // riser between two cells offset in y, for instance — several sheets cover
    // the same (x, y) and the plate has material above each of them. A ledge
    // rising from below has to clear the lowest of them; clearing only the
    // highest leaves it buried in the plate under the fold.
    if (best === null || z < best) best = z;
  }
  return best;
}

/**
 * The OUTER perimeter loop(s), resolved to the frames the wall cross-section
 * is swept along. Shared by buildWalls and wallOuterRings so the frame and the
 * baseplate that closes it are derived from the same perimeter.
 */
function wallLoopFrames(keylistData: Keylist): WallFrame[][] {
  const data = resolveKeylist(keylistData);
  const thickness = data.thickness ?? 5;
  const flangeZ = (data.flange_z ?? 0) || 0;
  // Resolved exactly as buildShell resolves it, so the frame is built around
  // the outer face the shell actually produced.
  const verticalEdges = (data.skirt ?? false) ? true : (data.vertical_edges ?? true);
  // The ledge offsets, needed here so extra stations land where the ledge
  // requires them and the baseplate inherits the same frame list.
  const plateGap = data.plate_gap ?? 0.25;
  const plateLip = data.plate_lip ?? 1.5;

  const { top, holeVertIds } = buildTopSurface(data);
  let loops = perimeterLoops(top, holeVertIds);

  // Keep only OUTER perimeter loop(s); skip interior holes.
  const loopBboxArea = (lp: number[]) => {
    const xs = lp.map(v => top.points[v][0]);
    const ys = lp.map(v => top.points[v][1]);
    return (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys));
  };
  if (loops.length > 0) {
    const areas = loops.map(loopBboxArea);
    const amax = Math.max(...areas);
    loops = loops.filter((_, i) => areas[i] >= 0.5 * amax);
  }

  const override = top.offsetNormal;
  const unit = top.unitNormals();
  const botPts = plateUndersidePoints(data, top, holeVertIds, verticalEdges);
  const underTris = undersideTrisFrom(top, botPts);
  const neighbours = vertexNeighbours(top);

  const out: WallFrame[][] = [];
  for (const rawLoop of loops) {
    const [loop, normals] = outwardNormalsXY(top.points, rawLoop);
    if (loop.length < 3) continue;

    const frames: WallFrame[] = [];
    for (let i = 0; i < loop.length; i++) {
      const vi = loop[i];
      const p = top.points[vi];
      const [nx, ny] = normals[i];
      const u = override.get(vi) ?? unit[vi];

      // The plate's true underside point at this perimeter vertex.
      const bx = p[0] - u[0] * thickness;
      const by = p[1] - u[1] * thickness;
      const bz = p[2] - u[2] * thickness;

      const uz = Math.abs(u[2]) > 1e-6 ? u[2] : 1e-6;

      // Datum: a point on the plate's OUTER FACE.
      //
      // This used to be the underside point b. On a tilted key b slides
      // sideways from the top point by u_xy*thickness (~1.5-2mm at 20-30 deg
      // and 4mm plate), so a recess measured from b was offset from a line the
      // plate's face does not follow, and the wall cut through the plate — 34
      // face crossings each at the two rotated keys of the staggered sample.
      //
      // With vertical edges the plate's outer face IS the vertical surface
      // through the top perimeter point, so that is the datum. With sloped
      // edges the face runs top -> b, and the recess has to clear both ends,
      // so the outermost of the two along n wins.
      const dTop = (p[0] - bx) * nx + (p[1] - by) * ny;
      const useTop = verticalEdges || dTop > 0;
      // Mitre. nx,ny is the unit bisector of the two adjacent edge normals, so
      // an offset of d along it lands only d*cos(theta) from each EDGE. At the
      // 1,0 / 2,0 riser of the staggered sample both ends of the riser carry
      // the same bisector, (-0.64, 0.77) against the riser's own normal of
      // (-0.98, 0.19), so the recess was offset by 0.773*plate_gap and the
      // plate cut through it.
      //
      // Capped hard at 1.18. Full correction (1/cos) fixes that riser but is
      // far too aggressive at the sharp corners of a thumb cluster, where it
      // pushes the recess out until the fit goes loose and NEW overlaps appear:
      // uncapped costs the 6x4_4 family 9 -> 21 crossings and opens the gap
      // from 0.60 to 0.87mm. This cap is enough for the riser and little else.
      const nxt = top.points[loop[(i + 1) % loop.length]];
      const ex = nxt[1] - p[1], ey = -(nxt[0] - p[0]);
      const em = Math.hypot(ex, ey);
      const cosT = em > 1e-12 ? (nx * ex + ny * ey) / em : 1;
      const mitre = 1 / Math.max(cosT, 0.85);
      let dx = useTop ? p[0] : bx;
      let dy = useTop ? p[1] : by;

      // The outer face is not always the outermost thing about the plate.
      // vertical_edges squares up the bottom vertices ON the perimeter, but
      // every neighbouring INTERIOR vertex is still pushed down its own offset
      // normal, which slides it sideways by |u_xy|*thickness — ~1.2mm on a key
      // tilted 12°/8° with a 5mm plate. Where that pushes one past the
      // perimeter, the underside bulges out through the recess, which is built
      // from the perimeter polygon and cannot see it. Take the datum out to
      // whatever the local underside actually reaches; this only ever moves
      // outward, so it cannot tighten the fit anywhere.
      let bulge = 0;
      const local = neighbours.get(vi);
      if (local !== undefined) {
        for (const j of local) {
          const q = botPts[j];
          // Only a vertex whose TOP sits at or inside this station's face can
          // be a bulge. Without that test, a face-neighbour is any vertex
          // sharing a polygon — including the far side of a connector spanning
          // a whole key pitch — and projecting another perimeter station onto
          // this normal at a convex corner reads as 14mm of "bulge".
          const tTop = (top.points[j][0] - dx) * nx + (top.points[j][1] - dy) * ny;
          if (tTop > 1e-9) continue;
          const d = (q[0] - dx) * nx + (q[1] - dy) * ny;
          if (d > bulge) bulge = d;
        }
      }
      frames.push({
        bx: dx,
        by: dy,
        nx, ny,
        bulge,
        mitre,
        rim: p[2] + flangeZ,
        planeZ: (x: number, y: number) =>
          bz - (u[0] * (x - bx) + u[1] * (y - by)) / uz,
        sampleZ: (x: number, y: number) => undersideSampleZ(x, y, underTris),
      });
    }
    out.push(subdivideForLedge(frames, plateGap, plateGap - plateLip));
  }
  return out;
}

/**
 * The wall frame's OUTER face profile at one station, as (offset, z) pairs
 * running rim -> base.
 *
 * Same shaping the fused skirt uses, so a board's `skirt_profile` /
 * `skirt_angle` / `skirt_flare` describes the case whichever wall method is
 * selected. It starts at `flange_offset` (the frame's face at the rim) and
 * flares outward on the way down. With no profile set, skirtProfile yields a
 * single zero-angle segment, so this is two points at the same offset — the
 * plain vertical face the frame had before.
 */
function wallOuterProfile(
  f: WallFrame, flangeOffset: number, baseZ: number, segs: SkirtSeg[],
): [number, number][] {
  const drop = f.rim - baseZ;
  const out: [number, number][] = [[flangeOffset, f.rim]];
  let d = flangeOffset;
  let z = f.rim;
  for (let si = 0; si < segs.length; si++) {
    const sg = segs[si];
    const dz = sg.frac * drop;
    d += sg.out !== null ? sg.out : dz * Math.tan(rad(sg.angle!));
    z -= dz;
    if (si === segs.length - 1) z = baseZ;   // land exactly on wall_base_z
    out.push([d, z]);
  }
  return out;
}

/**
 * Points in one wall cross-section: the outer profile (one per segment, plus
 * the rim) then inner_top, ledge_top, ledge_inner, inner_bottom. Exported so
 * tooling can walk the wall mesh, which is emitted station by station.
 */
export function wallLedgeSteps(data: Entry): number {
  return ledgeStepCount(resolveKeylist(data).plate_lip ?? 1.5);
}

export function wallRingSize(data: Entry): number {
  const kl = resolveKeylist(data);
  return skirtProfile(kl).length + ledgeStepCount(kl.plate_lip ?? 1.5) + 4;
}

export function buildWalls(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const flangeOffset = (data.flange_offset ?? 0) || 0;
  const plateLip = data.plate_lip ?? 1.5;
  const baseZ = data.wall_base_z ?? 0;
  const plateGap = data.plate_gap ?? 0.25;

  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const addVert = (p: Vec3) => { vertices.push(p); return vertices.length - 1; };

  const inner = plateGap;              // recess wall, gap beyond plate edge
  const ledgeIn = plateGap - plateLip; // ledge inner edge
  const segs = skirtProfile(data);     // shapes the outer face, as for a skirt

  for (const frames of wallLoopFrames(data)) {
    const nLoop = frames.length;
    const xyAt = (f: WallFrame, off: number): [number, number] =>
      [f.bx + f.nx * (off + f.bulge) * f.mitre,
       f.by + f.ny * (off + f.bulge) * f.mitre];

    /**
     * Ledge heights along one offset: each station sits on the plate's real
     * underside. The station's own tangent plane drifts off a faceted
     * underside — measured +1.5mm ABOVE it, i.e. digging into the plate, at
     * the 1,0 / 2,0 corner of the staggered sample — so take the lower of the
     * two, falling back to the plane where the point is not over the plate at
     * all (the normal case for the ledge's outer edge, out in the plate_gap).
     *
     * The straight edge BETWEEN two stations can still bow up through a
     * dipping underside (+0.44mm measured). Lowering the stations to pull that
     * edge down was tried and removed: it costs up to 0.66mm of unnecessary
     * drop — a visible notch in the ledge, at that same corner where this
     * leaves it exactly flush — and it does not pay for itself, taking the
     * staggered sample from 12 crossings to 16. See docs/skirt-off-walls.md.
     */
    // Ledge points across the width. Each takes the lowest real underside in
    // its own neighbourhood, so both quads it borders stay under the plate.
    //
    // Where a sample finds no plate overhead it uses the NEAREST REAL SAMPLE
    // rather than the station's tangent plane. A wide lip reaches under the
    // switch cutouts — plate_lip 5 with a 14.7mm hole in a 19.05mm cell leaves
    // only 1.5mm of border, so the ledge sits 3.5mm inside the cutout — and
    // over a cutout there is nothing to sample. Extrapolating the tangent
    // plane there sent the ledge wandering; continuing at the height of the
    // surrounding plate keeps it flat and sane.
    const K = ledgeStepCount(plateLip);
    // Per station: the ledge offsets, and the height at each.
    const ledgeOffsAt: number[][] = [];
    const ledgeZs: number[][] =
      Array.from({ length: K + 1 }, () => new Array<number>(frames.length));

    frames.forEach((f, i) => {
      const SCAN = 32;
      const off: number[] = [];
      const real: (number | null)[] = [];
      for (let sIdx = 0; sIdx <= SCAN; sIdx++) {
        const o = inner + (ledgeIn - inner) * (sIdx / SCAN);
        const [x, y] = xyAt(f, o);
        off.push(o);
        real.push(f.sampleZ(x, y));
      }

      // Clamp the lip to the plate that is actually there. Walking inward the
      // samples read null (out in the plate_gap), then real (the plate's
      // border), then null again once past it — into a switch cutout, or off a
      // narrow neck. plate_lip 5 with a 14.7mm hole in a 19.05mm cell leaves
      // only 1.5mm of border, so the ledge would sit 3.5mm inside the cutout
      // with no plate to follow and nothing to support. Stop at the end of the
      // first solid run instead: a ledge only means anything under plate.
      let firstValid = -1, lastValid = -1;
      for (let sIdx = 0; sIdx <= SCAN; sIdx++) {
        if (real[sIdx] !== null) {
          if (firstValid < 0) firstValid = sIdx;
          lastValid = sIdx;
        } else if (firstValid >= 0) break;
      }
      const limit = lastValid >= 0 ? off[lastValid] : ledgeIn;

      const offs = Array.from({ length: K + 1 },
        (_, k) => inner + (limit - inner) * (k / K));
      ledgeOffsAt.push(offs);

      const heightAt = (o: number, lo: number, hi: number): number => {
        const a = Math.min(lo, hi), b = Math.max(lo, hi);
        let best: number | null = null;
        for (let sIdx = 0; sIdx <= SCAN; sIdx++) {
          const r = real[sIdx];
          if (r === null || off[sIdx] < a - 1e-9 || off[sIdx] > b + 1e-9) continue;
          if (best === null || r < best) best = r;
        }
        if (best === null) {          // nearest real sample anywhere on the run
          let nearest = Infinity;
          for (let sIdx = 0; sIdx <= SCAN; sIdx++) {
            const r = real[sIdx];
            if (r === null) continue;
            const d = Math.abs(off[sIdx] - o);
            if (d < nearest) { nearest = d; best = r; }
          }
        }
        const [x0, y0] = xyAt(f, o);
        const plane = f.planeZ(x0, y0);
        return best === null ? plane : Math.min(plane, best - LEDGE_CLEARANCE);
      };

      for (let k = 0; k <= K; k++) {
        ledgeZs[k][i] = heightAt(offs[k],
          offs[Math.max(k - 1, 0)], offs[Math.min(k + 1, K)]);
      }
    });

    // One cross-section ring per station; see wallRingSize for the layout.
    const rings: number[][] = [];
    frames.forEach((f, i) => {
      const at = (offset: number, z: number): Vec3 =>
        [f.bx + f.nx * offset * f.mitre, f.by + f.ny * offset * f.mitre, z];

      // Outer face bottom -> rim, following the skirt profile, then the recess.
      // The recess opens from plate_gap at the rim to plate_gap + bulge at the
      // ledge, so it tracks the plate's profile instead of standing vertically
      // at its widest point.
      const prof = wallOuterProfile(f, flangeOffset, baseZ, segs);
      const ring: Vec3[] = [];
      for (let k = prof.length - 1; k >= 0; k--) ring.push(at(prof[k][0], prof[k][1]));
      ring.push(at(inner, f.rim));                    // inner_top
      const offs = ledgeOffsAt[i];
      for (let k = 0; k <= K; k++) {                   // ledge, outer -> inner
        ring.push(at(offs[k] + f.bulge, ledgeZs[k][i]));
      }
      ring.push(at(offs[K] + f.bulge, baseZ));         // inner_bottom
      rings.push(ring.map(addVert));
    });

    const m = rings[0].length;
    for (let i = 0; i < nLoop; i++) {
      const a = rings[i];
      const b = rings[(i + 1) % nLoop];
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        faces.push([a[k], b[k], b[k2], a[k2]]);
      }
    }
    // No end caps — the closed loop sweep forms a complete solid frame.
  }

  return { vertices, faces };
}

/**
 * The wall frame's OUTER footprint at wall_base_z, CCW (x, y) lists — the loop
 * the frame's bottom face stands on, so a baseplate built from it meets the
 * walls exactly. The wall-frame counterpart of skirtOuterRings.
 */
function wallOuterRings(keylistData: Keylist): Vec2[][] {
  const data = resolveKeylist(keylistData);
  const flangeOffset = (data.flange_offset ?? 0) || 0;
  const baseZ = data.wall_base_z ?? 0;
  const segs = skirtProfile(data);
  // The bottom of the flared profile, so the baseplate matches the foot the
  // frame actually stands on rather than its offset at the rim.
  return wallLoopFrames(data).map(frames => {
    const ring = frames.map(f => {
      const prof = wallOuterProfile(f, flangeOffset, baseZ, segs);
      const d = prof[prof.length - 1][0] * f.mitre;
      return [f.bx + f.nx * d, f.by + f.ny * d] as Vec2;
    });
    return dropCollinear(ring);
  });
}

export function buildWallsFromAny(data: Entry): Mesh {
  return buildWalls(resolveKeylist(data));
}

// --------------------------------------------------------------- inserts

/** Resolve every threaded-insert holder to world coords and parameters. */
export function insertPositions(keylistData: Keylist): ResolvedInsert[] {
  const data = resolveKeylist(keylistData);
  const defaultClear = data.insert_clearance_d ?? 3;
  const out: ResolvedInsert[] = [];
  for (const key of data.keylist ?? []) {
    const ins = key.insert ?? {};
    if (ins['x'] == null || ins['y'] == null) continue;
    const u = key.u_width ?? 1;
    const h = key.u_height ?? 1;
    out.push({
      x: key.pos.x + Number(ins['x']) * u,
      y: key.pos.y + Number(ins['y']) * h,
      id: Number(ins['id'] ?? 4),
      od: Number(ins['od'] ?? 8),
      height: Number(ins['height'] ?? 4.2),
      rot: Number(ins['rot'] ?? 0) || 0,
      hole_x: Number(ins['hole_x'] ?? 0) || 0,
      hole_y: Number(ins['hole_y'] ?? 0) || 0,
      clearance_d: Number(ins['clearance_d'] ?? defaultClear),
      leg_0: Number(ins['leg_0'] ?? 5),
      leg_1: Number(ins['leg_1'] ?? 7),
      leg_2: Number(ins['leg_2'] ?? 5),
      col: key.col, row: key.row,
    });
  }
  return out;
}

/** Circle polygon centred on origin, CCW. */
function circlePoints(r: number, segments = 64): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    pts.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  return pts;
}

/** Cross-section of a threaded-insert holder: the three-leg "wishbone". */
function insertBossOutline(ins: ResolvedInsert, segments = 64): Vec2[] {
  const r = ins.od / 2;
  const left: Vec2 = [-r, ins.leg_0];
  const topPt: Vec2 = [0, ins.leg_1];
  const right: Vec2 = [r, ins.leg_2];

  const circle = circlePoints(r, segments);
  const leftHull = convexHull([...circle, left, topPt]);
  const rightHull = convexHull([...circle, right, topPt]);
  const result = convexHull([...leftHull, ...rightHull]);
  if (signedArea(result) < 0) result.reverse();
  return result;
}

/**
 * Build the threaded-insert holders: for each insert, a wishbone prism with
 * a Ø`id` press-fit hole, standing on the base plane and rising `height` mm.
 */
export function buildInserts(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const baseZ = data.wall_base_z ?? 0;
  const segments = Math.floor(data.insert_hole_segments ?? 32);

  const vertices: Vec3[] = [];
  const faces: Face[] = [];

  for (const ins of insertPositions(data)) {
    const outline = insertBossOutline(ins, segments);
    if (outline.length < 3) continue;

    // Hole centre offset, clamped inside the disc.
    const rid = ins.id / 2;
    const rDisc = ins.od / 2;
    let hx = ins.hole_x, hy = ins.hole_y;
    const hd = Math.hypot(hx, hy);
    const maxHd = Math.max(0, rDisc - rid - 0.01);
    if (hd > maxHd && hd > 1e-9) {
      hx = (hx / hd) * maxHd;
      hy = (hy / hd) * maxHd;
    }
    const hole = circlePts(hx, hy, rid, segments);

    const a = rad(ins.rot);
    const ca = Math.cos(a), sa = Math.sin(a);
    const placeXY = (p: Vec2): Vec2 =>
      [ins.x + p[0] * ca - p[1] * sa, ins.y + p[0] * sa + p[1] * ca];

    const outlineW = outline.map(placeXY);
    let holeW: Vec2[] | null = hole.map(placeXY);
    if (signedArea(outlineW) < 0) outlineW.reverse();

    let merged: Vec2[];
    let tris: [number, number, number][];
    // If the hole isn't strictly inside the holder outline, drop it.
    if (!holeW.every(p => pointInPoly(p, outlineW))) {
      ({ points: merged, tris } = triangulateWithHoles(outlineW, []));
      holeW = null;
    } else {
      ({ points: merged, tris } = triangulateWithHoles(outlineW, [holeW]));
    }
    const z0 = baseZ, z1 = baseZ + ins.height;

    const topI = new Map<string, number>();
    const botI = new Map<string, number>();
    const key6 = (p: Vec2) =>
      `${Math.round(p[0] * 1e6) / 1e6},${Math.round(p[1] * 1e6) / 1e6}`;
    const vt = (p: Vec2) => {
      const k = key6(p);
      let i = topI.get(k);
      if (i === undefined) { i = vertices.length; topI.set(k, i); vertices.push([p[0], p[1], z1]); }
      return i;
    };
    const vb = (p: Vec2) => {
      const k = key6(p);
      let i = botI.get(k);
      if (i === undefined) { i = vertices.length; botI.set(k, i); vertices.push([p[0], p[1], z0]); }
      return i;
    };

    for (const [i, j, k] of tris) { // top cap, +Z
      faces.push([vt(merged[i]), vt(merged[j]), vt(merged[k])]);
    }
    for (const [i, j, k] of tris) { // bottom cap, -Z
      faces.push([vb(merged[k]), vb(merged[j]), vb(merged[i])]);
    }

    const mOut = outlineW.length; // outer wall
    for (let i = 0; i < mOut; i++) {
      const j = (i + 1) % mOut;
      faces.push([vt(outlineW[i]), vb(outlineW[i]), vb(outlineW[j]), vt(outlineW[j])]);
    }

    if (holeW !== null) {
      const hw = [...holeW]; // hole wall, facing the hole
      if (signedArea(hw) > 0) hw.reverse();
      const mH = hw.length;
      for (let i = 0; i < mH; i++) {
        const j = (i + 1) % mH;
        faces.push([vt(hw[i]), vb(hw[i]), vb(hw[j]), vt(hw[j])]);
      }
    }
  }

  return { vertices, faces };
}

export function buildInsertsFromAny(data: Entry): Mesh {
  return buildInserts(resolveKeylist(data));
}

// ------------------------------------------------------------- baseplate

/**
 * The skirt's OUTER footprint polygon(s) at wall_base_z, CCW (x, y) lists —
 * one per outer perimeter loop. Shares the sweep maths with buildShell.
 */
function skirtOuterRings(keylistData: Keylist): Vec2[][] {
  const data = resolveKeylist(keylistData);
  if (!(data.skirt ?? false)) {
    throw new Error('baseplate requires the fused-skirt wall method ' +
      '(set "skirt": true)');
  }

  const baseZ = data.wall_base_z ?? 0;
  const flange = data.skirt_flange ?? 0;
  const segs = skirtProfile(data);

  const { top, holeVertIds } = buildTopSurface(data);

  // Apply the SAME whole-plate tent/pitch tilt and clearance lift that
  // buildShell applies, so the baseplate outline is taken from the tilted
  // perimeter the case actually lands on. Without this the baseplate is built
  // from the untilted plate and does not line up with the case, and the skirt
  // flare below is wrong as well because it scales with each vertex's height
  // above the base plane. The skirt forces an aligned (vertical) perimeter, so
  // each perimeter vertex's XY is its bottom-offset XY.
  tiltAndOffset(data, top);
  const pts = [...top.points];

  const loops = perimeterLoops(top, holeVertIds);
  if (loops.length === 0) return [];

  const bboxArea = (lp: number[]) => {
    const xs = lp.map(v => pts[v][0]);
    const ys = lp.map(v => pts[v][1]);
    return (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys));
  };
  const areas = loops.map(bboxArea);
  const amax = Math.max(...areas);

  const rings: Vec2[][] = [];
  for (let li = 0; li < loops.length; li++) {
    if (areas[li] < 0.5 * amax) continue; // interior hole
    const [olp, nrms] = outwardNormalsXY(pts, loops[li]);
    const ring: Vec2[] = [];
    for (let i = 0; i < olp.length; i++) {
      const p = pts[olp[i]];
      const [nx, ny] = nrms[i];
      const drop = p[2] - baseZ;
      let d = flange;
      for (const s of segs) {
        const dz = s.frac * drop;
        d += s.out !== null ? s.out : dz * Math.tan(rad(s.angle!));
      }
      ring.push([p[0] + nx * d, p[1] + ny * d]);
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Drop points that lie on the straight line through their neighbours.
 *
 * Stations added by subdivideForLedge sit exactly on the segment joining their
 * neighbours — that is the point of it, so the ledge gains detail without the
 * swept surfaces moving. On a straight run that makes them exactly collinear,
 * which yields zero-area ears that the triangulator cannot clip, and the
 * baseplate then fails to build. They carry no shape information, so the
 * outline drops them; the polygon is geometrically identical.
 */
function dropCollinear(ring: Vec2[], tol = 1e-7): Vec2[] {
  const n = ring.length;
  if (n < 4) return ring;
  const keep: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const scale = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (scale > 1e-12 && Math.abs(cross) / scale < tol) continue;
    keep.push(b);
  }
  return keep.length >= 3 ? keep : ring;
}

/**
 * The footprint the baseplate closes, whichever wall method is in use: the
 * fused skirt's flared outline, or the wall frame's outer face.
 *
 * `strictHoles` asks for the whole clearance circle to land inside the
 * outline, not just its centre. The wall frame hugs the plate edge, so a boss
 * placed near the perimeter can produce a circle that CROSSES the outline —
 * cutting that leaves a self-intersecting polygon that cannot be triangulated,
 * and the baseplate fails to build. The skirt's flare pushes its footprint
 * well clear of the bosses, so it keeps the original centre-only test and
 * stays bit-identical to the Python core.
 */
function baseplateFootprint(
  data: Keylist,
): { rings: Vec2[][]; strictHoles: boolean } {
  return (data.skirt ?? false)
    ? { rings: skirtOuterRings(data), strictHoles: false }
    : { rings: wallOuterRings(data), strictHoles: true };
}

/**
 * Build the BASEPLATE: a flat bottom cover matching the case's outer footprint
 * at wall_base_z, extruded DOWNWARD by baseplate_thickness, with screw
 * clearance holes coaxial with each insert.
 *
 * With a fused skirt it follows the skirt's flared outline; with the separate
 * wall frame it follows the frame's outer face, so the frame's bottom lands
 * flush on it and the two merge into one solid on export.
 */
export function buildBaseplate(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  const t = data.baseplate_thickness ?? 2;
  const baseZ = data.wall_base_z ?? 0;
  if (t <= 0) throw new Error('baseplate_thickness must be > 0');

  const inserts = insertPositions(data);
  const segments = Math.floor(data.insert_hole_segments ?? 32);

  const vertices: Vec3[] = [];
  const faces: Face[] = [];

  const { rings, strictHoles } = baseplateFootprint(data);

  for (const ring of rings) {
    const nRing = ring.length;
    if (nRing < 3) continue;

    // Screw clearance holes for inserts that fall inside this ring.
    const holes: Vec2[][] = [];
    for (const ins of inserts) {
      if (ins.clearance_d <= 0) continue;
      const a = rad(ins.rot);
      const ca = Math.cos(a), sa = Math.sin(a);
      const wx = ins.x + ins.hole_x * ca - ins.hole_y * sa;
      const wy = ins.y + ins.hole_x * sa + ins.hole_y * ca;
      const circle = circlePts(wx, wy, ins.clearance_d / 2, segments);
      const fits = strictHoles
        ? circle.every(p => pointInPoly(p, ring))
        : pointInPoly([wx, wy], ring);
      if (fits) holes.push(circle);
    }

    const { points: merged, tris } = triangulateWithHoles(ring, holes);

    const topI = new Map<string, number>();
    const botI = new Map<string, number>();
    const key6 = (p: Vec2) =>
      `${Math.round(p[0] * 1e6) / 1e6},${Math.round(p[1] * 1e6) / 1e6}`;
    const vt = (p: Vec2) => {
      const k = key6(p);
      let i = topI.get(k);
      if (i === undefined) { i = vertices.length; topI.set(k, i); vertices.push([p[0], p[1], baseZ]); }
      return i;
    };
    const vb = (p: Vec2) => {
      const k = key6(p);
      let i = botI.get(k);
      if (i === undefined) { i = vertices.length; botI.set(k, i); vertices.push([p[0], p[1], baseZ - t]); }
      return i;
    };

    // Top cap: CCW -> +Z (the case rests on this face). Bottom cap: -Z.
    for (const [i, j, k] of tris) {
      faces.push([vt(merged[i]), vt(merged[j]), vt(merged[k])]);
    }
    for (const [i, j, k] of tris) {
      faces.push([vb(merged[k]), vb(merged[j]), vb(merged[i])]);
    }

    // Outer side wall, outward-facing for the CCW ring.
    for (let i = 0; i < nRing; i++) {
      const j = (i + 1) % nRing;
      faces.push([vt(ring[i]), vb(ring[i]), vb(ring[j]), vt(ring[j])]);
    }

    // Hole walls: traverse CW so normals point into the hole.
    for (const hole of holes) {
      const hw = [...hole];
      if (signedArea(hw) > 0) hw.reverse();
      const mH = hw.length;
      for (let i = 0; i < mH; i++) {
        const j = (i + 1) % mH;
        faces.push([vt(hw[i]), vb(hw[i]), vb(hw[j]), vt(hw[j])]);
      }
    }
  }

  return { vertices, faces };
}

export function buildBaseplateFromAny(data: Entry): Mesh {
  return buildBaseplate(resolveKeylist(data));
}

/** One lip-style station: where the wall starts, and its inner-face section. */
export interface LipStation {
  /** The plate's perimeter point here. */
  x: number; y: number;
  /** Outward XY normal. */
  nx: number; ny: number;
  /** Plate top and underside at this station. */
  ztop: number; zbot: number;
  /** Inner face as (outward offset, z), from the plate's edge to the lip. */
  inner: Vec2[];
}

/**
 * The lip-style wall, station by station, for measuring against.
 *
 * Exposed so a caller can ask the question that matters when a plate is hung in
 * a well — does a key cap that overhangs the plate's edge still clear the wall
 * beside it? — without having to re-derive the sweep.
 */
export function lipWallStations(keylistData: Keylist): LipStation[] {
  const data = resolveKeylist(keylistData);
  if (wallStyle(data) !== 'lip') return [];
  const lip = lipSpec(data);
  const segs = skirtProfile(data);

  const { top, holeVertIds } = buildTopSurface(data);
  const botPts = tiltAndOffset(data, top);
  const pts = [...top.points];
  const loops = perimeterLoops(top, holeVertIds);
  if (loops.length === 0) return [];

  const bboxArea = (lp: number[]) => {
    const xs = lp.map(v => pts[v][0]);
    const ys = lp.map(v => pts[v][1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };
  const areas = loops.map(bboxArea);
  const amax = Math.max(...areas);

  const out: LipStation[] = [];
  for (let li = 0; li < loops.length; li++) {
    if (areas[li] < 0.5 * amax) continue;
    const [olp, nrms] = outwardNormalsXY(pts, loops[li]);
    for (let i = 0; i < olp.length; i++) {
      const vi = olp[i];
      const p = pts[vi];
      const rings = lipRings(lip, segs, p[2], botPts[vi][2]);
      out.push({
        x: p[0], y: p[1], nx: nrms[i][0], ny: nrms[i][1],
        ztop: p[2], zbot: botPts[vi][2],
        inner: rings.slice(0, segs.length + 1),
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ plank

/** The case outline at the two levels a lip-style pocket needs, per loop. */
interface PocketRings {
  /** Wall above the shoulder: the lip's outline, plus clearance. */
  lip: Vec2[];
  /** Wall below the shoulder: the skirt's outline, plus clearance. */
  skirt: Vec2[];
}

/**
 * Pocket outlines, taken from the same tilted perimeter the case is swept from
 * so the recess parallels the walls that drop into it.
 *
 * Each ring is offset along the per-vertex outward normal, exactly as the skirt
 * offsets its own rings. A true polygon offset would part company with the case
 * at corners; matching the method keeps the gap equal to `clearance` all the
 * way round, which is what a fit needs.
 */
function lipPocketRings(
  data: Keylist, lip: LipSpec, clearance: number, segs: SkirtSeg[],
): { rings: PocketRings[]; reach: number; rebate: number } {
  const { top, holeVertIds } = buildTopSurface(data);
  const botPts = tiltAndOffset(data, top);
  const pts = [...top.points];

  // Both rings come from the same section the case is swept from, station by
  // station: the rebate clears the lip's outer edge, the hole below it clears
  // the wall wherever it reaches furthest at or under the shoulder. Below the
  // shoulder the hole is a straight prism, so it routs in one pass with an
  // ordinary straight bit.
  const section = (vi: number) =>
    lipRings(lip, segs, pts[vi][2], botPts[vi][2]);
  let reach = 0, rebate = 0;
  for (let vi = 0; vi < pts.length; vi++) {
    const sec = section(vi);
    reach = Math.max(reach, lipWallReach(lip, segs, sec));
    rebate = Math.max(rebate, lipRebateReach(sec));
  }

  const loops = perimeterLoops(top, holeVertIds);
  if (loops.length === 0) return { rings: [], reach, rebate };

  const bboxArea = (lp: number[]) => {
    const xs = lp.map(v => pts[v][0]);
    const ys = lp.map(v => pts[v][1]);
    return (Math.max(...xs) - Math.min(...xs)) *
      (Math.max(...ys) - Math.min(...ys));
  };
  const areas = loops.map(bboxArea);
  const amax = Math.max(...areas);

  const rings: PocketRings[] = [];
  for (let li = 0; li < loops.length; li++) {
    if (areas[li] < 0.5 * amax) continue;   // interior hole: no pocket
    const [olp, nrms] = outwardNormalsXY(pts, loops[li]);
    const lipRing: Vec2[] = [];
    const skirtRing: Vec2[] = [];
    for (let i = 0; i < olp.length; i++) {
      const p = pts[olp[i]];
      const [nx, ny] = nrms[i];

      // Only the CLEARANCE is mitred, not the whole offset. Pushing a corner
      // vertex out by c along its bisector leaves the faces either side of it
      // just c*cos(half-angle) apart, so a 90-degree corner keeps 0.71 of the
      // gap asked for. Scaling by 1/cos restores it. The case's own rings are
      // deliberately left unmitred, so the pocket still parallels the wall it
      // has to accept — and because the correction rides on c alone, the same
      // cap the wall frame uses barely comes into play.
      const nxt = pts[olp[(i + 1) % olp.length]];
      const ex = nxt[1] - p[1], ey = -(nxt[0] - p[0]);
      const em = Math.hypot(ex, ey);
      const cosT = em > 1e-12 ? (nx * ex + ny * ey) / em : 1;
      const gap = clearance / Math.max(cosT, 0.85);

      const sec = section(olp[i]);
      const dSkirt = lipWallReach(lip, segs, sec) + gap;
      const dLip = lipRebateReach(sec) + gap;
      skirtRing.push([p[0] + nx * dSkirt, p[1] + ny * dSkirt]);
      lipRing.push([p[0] + nx * dLip, p[1] + ny * dLip]);
    }
    rings.push({ lip: lipRing, skirt: skirtRing });
  }
  return { rings, reach, rebate };
}

/**
 * The plank: a rectangular board with the rebated recess already taken out.
 *
 * Built directly rather than by subtracting a pocket solid. A pocket cut with
 * CSG would open flush with the plank's top face, and a tool face exactly
 * coplanar with a target face is the one case the boolean handles badly (see
 * Known issues in the README). Extruding the two ring levels and capping them
 * is also exact and costs nothing.
 *
 * Two levels, top to bottom: the rebate the lip drops into, down to the
 * shoulder it bears on, and then a hole straight through the board for the
 * case to hang in. The board's top face IS the top of the lip, so the keyboard
 * finishes flush with the wood.
 */
export function buildPlank(keylistData: Keylist): Mesh {
  const data = resolveKeylist(keylistData);
  if (wallStyle(data) !== 'lip') {
    throw new Error('the plank belongs to the lip wall style — set ' +
      '"wall_style": "lip"');
  }
  const lip = lipSpec(data);
  const segs = skirtProfile(data);
  const clearance = Number(data.pocket_clearance ?? 0.3) || 0;
  const { rings, reach, rebate } = lipPocketRings(data, lip, clearance, segs);
  if (rings.length === 0) return { vertices: [], faces: [] };

  // A wall that reaches out further below the shoulder than the lip does above
  // it cannot pass through the rebate it has to drop into.
  if (reach > rebate + 1e-9) {
    throw new Error(
      `the wall reaches out to ${reach.toFixed(2)} below the shoulder, past ` +
      `the lip's own outer edge at ${rebate.toFixed(2)}, so the case cannot ` +
      'drop into its own rebate. Reduce skirt_angle, or widen the lip.');
  }

  // The lip finishes flush, so the board's surface IS the top of the lip.
  const topZ = lip.z + lip.thickness;
  const thickness = Number(data.plank_thickness ?? 18) || 0;
  if (thickness <= lip.thickness + 1e-9) {
    throw new Error(
      `plank_thickness (${thickness}) must be greater than lip_thickness ` +
      `(${lip.thickness}) — the rebate alone takes the whole board, leaving ` +
      'no shoulder to bear on.');
  }
  const botZ = topZ - thickness;

  // --- Board outline ------------------------------------------------------
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) {
    for (const [x, y] of r.lip) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const size = data.plank_size;
  if (Array.isArray(size) && size.length >= 2) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const sx = Number(size[0]) / 2, sy = Number(size[1]) / 2;
    if (!(sx > 0 && sy > 0)) throw new Error('plank_size must be two positive numbers');
    x0 = cx - sx; x1 = cx + sx; y0 = cy - sy; y1 = cy + sy;
  } else {
    const margin = Number(data.plank_margin ?? 20) || 0;
    x0 -= margin; x1 += margin; y0 -= margin; y1 += margin;
  }
  const rect: Vec2[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];   // CCW

  // --- Assembly -----------------------------------------------------------
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const index = new Map<string, number>();
  const v = (p: Vec2, z: number) => {
    const k = `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)},${Math.round(z * 1e6)}`;
    let i = index.get(k);
    if (i === undefined) { i = vertices.length; index.set(k, i); vertices.push([p[0], p[1], z]); }
    return i;
  };
  /** A ring walled between two heights, facing into the pocket it encloses. */
  const pocketWall = (ring: Vec2[], zHi: number, zLo: number) => {
    const w = signedArea(ring) > 0 ? [...ring].reverse() : [...ring];
    for (let i = 0; i < w.length; i++) {
      const j = (i + 1) % w.length;
      faces.push([v(w[i], zHi), v(w[i], zLo), v(w[j], zLo), v(w[j], zHi)]);
    }
  };

  // Top face: the board, with each pocket mouth as a hole.
  const lipHoles = rings.map(r => r.lip);
  const topCap = triangulateWithHoles(rect, lipHoles);
  for (const [i, j, k] of topCap.tris) {
    faces.push([v(topCap.points[i], topZ), v(topCap.points[j], topZ), v(topCap.points[k], topZ)]);
  }

  // Underside: the hole goes right through, so it is open here too.
  const botCap = triangulateWithHoles(rect, rings.map(r => r.skirt));
  for (const [i, j, k] of botCap.tris) {
    faces.push([v(botCap.points[k], botZ), v(botCap.points[j], botZ), v(botCap.points[i], botZ)]);
  }

  // Outer edges of the board.
  for (let i = 0; i < rect.length; i++) {
    const j = (i + 1) % rect.length;
    faces.push([v(rect[i], topZ), v(rect[i], botZ), v(rect[j], botZ), v(rect[j], topZ)]);
  }

  for (const r of rings) {
    pocketWall(r.lip, topZ, lip.z);          // rebate, down to the shoulder
    // The shoulder: the flat the lip lands on, facing up.
    for (let i = 0; i < r.lip.length; i++) {
      const j = (i + 1) % r.lip.length;
      faces.push([v(r.lip[i], lip.z), v(r.lip[j], lip.z),
        v(r.skirt[j], lip.z), v(r.skirt[i], lip.z)]);
    }
    pocketWall(r.skirt, lip.z, botZ);        // and straight through the board
  }

  return { vertices, faces };
}

export function buildPlankFromAny(data: Entry): Mesh {
  return buildPlank(resolveKeylist(data));
}

// ------------------------------------------------------------ mesh utility

/** Merge meshes into one (concatenating with re-indexed faces). */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  for (const m of meshes) {
    const off = vertices.length;
    vertices.push(...m.vertices);
    for (const f of m.faces) faces.push(f.map(i => i + off));
  }
  return { vertices, faces };
}
