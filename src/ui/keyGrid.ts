/**
 * Top-down schematic of the key grid, drawn as SVG from the same expressions
 * the generator uses. Doubles as the ignored-key picker: cells are clickable,
 * and cells missing from the layout are drawn as dashed ghosts so they can be
 * put back.
 */

import { rotXYZ } from '../core/core';
import { parseAlgo } from '../core/pyexpr';
import type { Entry, KeyboardDef, Keylist, Vec3 } from '../core/types';
import { el } from './dom';

export interface Cell {
  col: number;
  row: number;
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;
  uw: number; uh: number;
  ignored: boolean;
  hasInsert: boolean;
  /** Screen-space outline, y already flipped for SVG. */
  poly: [number, number][];
}

export interface GridOptions {
  /** Clicking a cell toggles it in `ignored_keys`. */
  editable: boolean;
  /** Extra click handler (fires for every cell, ignored ones included). */
  onPick?: (cell: Cell) => void;
  /** Draw insert markers. */
  showInserts?: boolean;
  selected?: { col: number; row: number } | null;
}

const PAD = 10;

function cellHalf(uw: number, uh: number, key1u: number, hole: number, border: number) {
  return [
    Math.max((uw * key1u - 3) / 2, hole / 2 + border),
    Math.max((uh * key1u - 3) / 2, hole / 2 + border),
  ];
}

/** Every grid cell of a definition, including the ignored ones. */
function defCells(def: KeyboardDef): Cell[] {
  const key1u = Number(def.key_1u ?? 19.05);
  const hole = Number(def.hole_size ?? 14.5);
  const border = Number(def.switch_border ?? 1.5);
  const width = Number(def.width ?? 6);
  const height = Number(def.height ?? 4);
  const ignored = new Set((def.ignored_keys ?? []).map(k => `${k[0]},${k[1]}`));
  const inserts = new Set((def.inserts ?? []).map(i => `${i['col']},${i['row']}`));

  const uw = new Map<string, number>();
  const uh = new Map<string, number>();
  for (const u of def.u_diff ?? []) {
    for (const k of u.keys ?? []) {
      if (u.u_width !== undefined) uw.set(`${k[0]},${k[1]}`, Math.abs(u.u_width));
      if (u.u_height !== undefined) uh.set(`${k[0]},${k[1]}`, u.u_height);
    }
  }

  const xa = def.x_algo ?? `x*${key1u}`;
  const ya = def.y_algo ?? `-y*${key1u}`;
  const za = def.z_algo ?? '10';
  const xr = def.x_rot_algo ?? '0';
  const yr = def.y_rot_algo ?? '0';
  const zr = def.z_rot_algo ?? '0';
  const ev = (expr: string, x: number, y: number) =>
    parseAlgo(expr, x, y, 0, width, height, key1u);

  const cells: Cell[] = [];
  for (let c = 0; c < width; c++) {
    for (let r = 0; r < height; r++) {
      const cr = `${c},${r}`;
      const w = uw.get(cr) ?? 1;
      const h = uh.get(cr) ?? 1;
      // u_diff recentres the cell on the widened footprint.
      const cx = w !== 1 ? ev(xa, c + (w - 1) / 2, r) : ev(xa, c, r);
      const cy = h !== 1 ? ev(ya, c, r + (h - 1) / 2) : ev(ya, c, r);
      cells.push({
        col: c, row: r,
        x: cx, y: cy, z: ev(za, c, r),
        rx: ev(xr, c, r), ry: ev(yr, c, r), rz: ev(zr, c, r),
        uw: w, uh: h,
        ignored: ignored.has(cr),
        hasInsert: inserts.has(cr),
        poly: [],
      });
    }
  }
  for (const cell of cells) {
    const [hw, hh] = cellHalf(cell.uw, cell.uh, key1u, hole, border);
    cell.poly = ([[-hw, hh, 0], [-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0]] as Vec3[])
      .map(p => rotXYZ(p, cell.rx, cell.ry, cell.rz))
      .map(p => [p[0] + cell.x, -(p[1] + cell.y)] as [number, number]);
  }
  return cells;
}

/** Cells of an already-expanded keylist (read-only: nothing is "ignored"). */
function keylistCells(kl: Keylist): Cell[] {
  const key1u = Number(kl.key_1u ?? 19.05);
  const hole = Number(kl.hole_size ?? 14.5);
  const border = Number(kl.switch_border ?? 1.5);
  return (kl.keylist ?? []).map(k => {
    const uw = Math.abs(k.u_width ?? 1);
    const uh = k.u_height ?? 1;
    const [hw, hh] = cellHalf(uw, uh, key1u, hole, border);
    const poly = ([[-hw, hh, 0], [-hw, -hh, 0], [hw, -hh, 0], [hw, hh, 0]] as Vec3[])
      .map(p => rotXYZ(p, k.rotation.x, k.rotation.y, k.rotation.z))
      .map(p => [p[0] + k.pos.x, -(p[1] + k.pos.y)] as [number, number]);
    return {
      col: k.col, row: k.row,
      x: k.pos.x, y: k.pos.y, z: k.pos.z,
      rx: k.rotation.x, ry: k.rotation.y, rz: k.rotation.z,
      uw, uh,
      ignored: false,
      hasInsert: k.insert !== undefined && k.insert['x'] !== undefined,
      poly,
    };
  });
}

/** True when the entry is edited through expressions rather than key by key. */
export const isDefinition = (entry: Entry): boolean =>
  typeof entry === 'object' && entry !== null &&
  !('keylist' in entry) && !('items' in entry);

export function cellsOf(entry: Entry): Cell[] {
  if ('keylist' in (entry as object)) return keylistCells(entry as Keylist);
  // A definition with no width/height still generates the 6×4 default grid,
  // so fall through rather than leaning on isKeyboardDef's field sniffing.
  if (isDefinition(entry)) return defCells(entry as KeyboardDef);
  return [];
}

const svgEl = <T extends SVGElement>(tag: string, attrs: Record<string, string | number>): T => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag) as T;
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/** Toggle a cell in the definition's `ignored_keys`. */
function toggleIgnored(def: KeyboardDef, col: number, row: number) {
  const list = (def.ignored_keys ?? []) as [number, number][];
  const at = list.findIndex(k => Number(k[0]) === col && Number(k[1]) === row);
  if (at >= 0) {
    list.splice(at, 1);
    if (list.length === 0) delete def.ignored_keys;
    else def.ignored_keys = list;
  } else {
    def.ignored_keys = [...list, [col, row]];
  }
}

/**
 * Draw the grid into `host`. Returns the number of live keys, or -1 when the
 * entry could not be evaluated (a bad expression, say).
 */
export function renderKeyGrid(
  host: HTMLElement, entry: Entry, opts: GridOptions, notify: () => void,
): { keys: number; error: string | null } {
  host.textContent = '';

  let cells: Cell[];
  try {
    cells = cellsOf(entry);
  } catch (e) {
    host.append(el('p', { class: 'ff-note ff-bad' },
      `Layout preview unavailable: ${(e as Error).message}`));
    return { keys: -1, error: (e as Error).message };
  }
  if (cells.length === 0) {
    host.append(el('p', { class: 'ff-note' }, 'No keys in this entry yet.'));
    return { keys: 0, error: null };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cells) {
    for (const [px, py] of c.poly) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    }
  }
  const live = cells.filter(c => !c.ignored);
  const zs = live.map(c => c.z);
  const zMin = Math.min(...zs, 0), zMax = Math.max(...zs, 0);

  const w = maxX - minX + PAD * 2;
  const h = maxY - minY + PAD * 2;
  const svg = svgEl<SVGSVGElement>('svg', {
    class: 'keygrid',
    viewBox: `${minX - PAD} ${minY - PAD} ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
  });

  for (const c of cells) {
    const g = svgEl<SVGGElement>('g', {
      class: 'kg-cell' + (c.ignored ? ' kg-off' : '') +
        (opts.selected && opts.selected.col === c.col && opts.selected.row === c.row
          ? ' kg-sel' : ''),
      tabindex: opts.editable ? 0 : -1,
    });
    // Height ramp: low keys pale, high keys saturated.
    const t = zMax > zMin ? (c.z - zMin) / (zMax - zMin) : 0.5;
    // Ghosts still need a painted fill, or clicking inside one misses it and
    // the key can never be brought back.
    const poly = svgEl('polygon', {
      points: c.poly.map(p => p.join(',')).join(' '),
      fill: c.ignored
        ? 'rgba(43, 38, 32, 0.05)'
        : `hsl(${38 - t * 26} 62% ${88 - t * 26}%)`,
    });
    g.append(poly);
    const cx = c.poly.reduce((a, p) => a + p[0], 0) / c.poly.length;
    const cy = c.poly.reduce((a, p) => a + p[1], 0) / c.poly.length;
    const label = svgEl('text', {
      x: cx, y: cy + 2.2, 'text-anchor': 'middle', class: 'kg-label',
    });
    label.textContent = `${c.col},${c.row}`;
    g.append(label);
    if (opts.showInserts && c.hasInsert) {
      g.append(svgEl('circle', { cx, cy: cy - 5, r: 1.6, class: 'kg-ins' }));
    }
    const title = svgEl('title', {});
    title.textContent =
      `col ${c.col}, row ${c.row}\n` +
      `x ${c.x.toFixed(2)}  y ${c.y.toFixed(2)}  z ${c.z.toFixed(2)}\n` +
      `rot ${c.rx.toFixed(1)}° / ${c.ry.toFixed(1)}° / ${c.rz.toFixed(1)}°` +
      (c.uw !== 1 || c.uh !== 1 ? `\n${c.uw}u × ${c.uh}u` : '') +
      (c.ignored ? '\nignored' : '');
    g.append(title);

    const activate = () => {
      if (opts.editable && isDefinition(entry)) {
        toggleIgnored(entry as KeyboardDef, c.col, c.row);
        notify();
      }
      opts.onPick?.(c);
    };
    g.addEventListener('click', activate);
    g.addEventListener('keydown', ev => {
      const k = (ev as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') { ev.preventDefault(); activate(); }
    });
    svg.append(g);
  }

  // Insert markers sit above the cells so they stay readable.
  if (opts.showInserts) {
    for (const ins of insertMarkers(entry)) {
      svg.append(svgEl('circle', {
        cx: ins.x, cy: -ins.y, r: Math.max(ins.od / 2, 1.5), class: 'kg-boss',
      }));
    }
  }

  host.append(svg);
  return { keys: live.length, error: null };
}

/** Insert boss centres in the same 2D frame as the cells. */
function insertMarkers(entry: Entry): { x: number; y: number; od: number }[] {
  const cells = new Map<string, Cell>();
  try {
    for (const c of cellsOf(entry)) cells.set(`${c.col},${c.row}`, c);
  } catch { return []; }
  const rec = entry as Record<string, unknown>;
  const list = (rec['inserts'] as Record<string, number>[] | undefined) ?? [];
  const out: { x: number; y: number; od: number }[] = [];
  for (const ins of list) {
    const cell = cells.get(`${ins['col']},${ins['row']}`);
    if (!cell || cell.ignored) continue;
    out.push({
      x: cell.x + Number(ins['x'] ?? 0) * cell.uw,
      y: cell.y + Number(ins['y'] ?? 0) * cell.uh,
      od: Number(ins['od'] ?? 8),
    });
  }
  return out;
}

// ------------------------------------------------------------- cutout map

export interface CutoutMapOptions {
  /** Index of the cutout being edited, or null. */
  selected: number | null;
  onSelect: (index: number) => void;
  /** Board coordinates picked on the map, for the selected cutout. */
  onPlace: (x: number, y: number) => void;
}

/** 2D convex hull (monotone chain), for a cutout's top-down footprint. */
export function hullXY(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (src: [number, number][]) => {
    const out: [number, number][] = [];
    for (const q of src) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
      out.push(q);
    }
    out.pop();
    return out;
  };
  return [...half(p), ...half([...p].reverse())];
}

/**
 * Top-down map for placing cutouts: the key cells for context, each cutout's
 * footprint over them, click to select one and click again to move it.
 *
 * Only x and y are editable here — z, rotation and the shape itself stay in the
 * card below, since a plan view cannot show them.
 */
export function renderCutoutMap(
  host: HTMLElement,
  entry: Entry,
  footprints: { index: number; name: string; pts: [number, number][] }[],
  opts: CutoutMapOptions,
): void {
  host.textContent = '';

  let cells: Cell[];
  try {
    cells = cellsOf(entry);
  } catch (e) {
    host.append(el('p', { class: 'ff-note ff-bad' },
      `Map unavailable: ${(e as Error).message}`));
    return;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const c of cells) for (const [px, py] of c.poly) grow(px, py);
  for (const f of footprints) for (const [px, py] of f.pts) grow(px, -py);
  if (!Number.isFinite(minX)) { grow(-10, -10); grow(10, 10); }

  const w = maxX - minX + PAD * 2;
  const h = maxY - minY + PAD * 2;
  const svg = svgEl<SVGSVGElement>('svg', {
    class: 'keygrid cutoutmap',
    viewBox: `${minX - PAD} ${minY - PAD} ${w} ${h}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
  });

  for (const c of cells) {
    if (c.ignored) continue;
    svg.append(svgEl('polygon', {
      points: c.poly.map(p => p.join(',')).join(' '),
      class: 'cm-cell',
    }));
  }

  for (const f of footprints) {
    const g = svgEl<SVGGElement>('g', {
      class: 'cm-cut' + (f.index === opts.selected ? ' is-sel' : ''),
      tabindex: 0,
    });
    g.append(svgEl('polygon', {
      points: f.pts.map(p => `${p[0]},${-p[1]}`).join(' '),
    }));
    const title = svgEl('title', {});
    title.textContent = f.name;
    g.append(title);
    g.addEventListener('click', ev => { ev.stopPropagation(); opts.onSelect(f.index); });
    svg.append(g);
  }

  // Click anywhere else moves the selected cutout there.
  svg.addEventListener('click', ev => {
    if (opts.selected === null) return;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
    opts.onPlace(pt.x, -pt.y);
  });

  host.append(svg);
}
