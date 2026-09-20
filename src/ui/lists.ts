/**
 * Repeating-row editors for the array-valued parts of a board definition:
 * ignored/wide keys, links, inserts, the skirt profile and assembly items.
 */

import { el, num } from './dom';
import { cellInput, iconButton, type Notify, type Target } from './controls';
import { INSERT_FIELDS, type Field } from './schema';

// ---------------------------------------------------------------- helpers

/** "0,4 1,4" / "0,4; 1,4" -> [[0,4],[1,4]] */
export function parseCells(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const m of text.matchAll(/(-?\d+)\s*,\s*(-?\d+)/g)) {
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

export const formatCells = (list: [number, number][] | undefined): string =>
  (list ?? []).map(k => `${k[0]},${k[1]}`).join('  ');

/** "1,3,br" -> [1, 3, "br"]; "2,4" -> [2, 4]; "" -> undefined */
function parseAnchor(text: string): (number | string)[] | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const parts = t.split(',').map(s => s.trim());
  if (parts.length < 2) return undefined;
  const cr = [Number(parts[0]), Number(parts[1])];
  return parts[2] ? [...cr, parts[2]] : cr;
}

const formatAnchor = (v: unknown): string =>
  Array.isArray(v) ? v.join(',') : '';

function listShell(
  title: string, note: string | null, addLabel: string, onAdd: () => void,
): { box: HTMLElement; rows: HTMLElement } {
  const rows = el('div', { class: 'ff-rows' });
  const box = el('section', { class: 'ff-group' },
    el('div', { class: 'ff-grouphead' },
      el('h3', {}, title),
      el('button', { type: 'button', class: 'ff-add', onclick: onAdd }, addLabel)),
    note ? el('p', { class: 'ff-note' }, note) : null,
    rows);
  return { box, rows };
}

function emptyNote(text: string): HTMLElement {
  return el('p', { class: 'ff-empty' }, text);
}

// --------------------------------------------------------------- ignored

export function ignoredEditor(def: Target, notify: Notify): HTMLElement {
  const list = (def['ignored_keys'] as [number, number][] | undefined) ?? [];
  const input = el('input', {
    type: 'text', class: 'ff-wide',
    placeholder: 'e.g. 0,4  1,4  6,0',
    value: formatCells(list),
    onchange: () => {
      const parsed = parseCells(input.value);
      if (parsed.length === 0) delete def['ignored_keys'];
      else def['ignored_keys'] = parsed;
      notify(true);
    },
  });
  return el('section', { class: 'ff-group' },
    el('h3', {}, 'Ignored keys'),
    el('p', { class: 'ff-note' },
      'Cells left out of the layout — click them in the map above, or list ' +
      'them here as col,row pairs.'),
    input);
}

// ---------------------------------------------------------------- u_diff

export function uDiffEditor(def: Target, notify: Notify): HTMLElement {
  const groups = (def['u_diff'] as Record<string, unknown>[] | undefined) ?? [];

  const push = () => {
    def['u_diff'] = [...groups, { keys: [], u_width: 2, u_height: 1 }];
    notify(true);
  };
  const { box, rows } = listShell('Wide & tall keys',
    'Each group gives its listed cells a new size in u. A negative width ' +
    'grows the key to the left instead of the right.', '+ group', push);

  if (groups.length === 0) rows.append(emptyNote('Every key is 1u × 1u.'));

  groups.forEach((g, i) => {
    const keysInput = el('input', {
      type: 'text', class: 'ff-wide', placeholder: 'col,row  col,row',
      value: formatCells(g['keys'] as [number, number][] | undefined),
      onchange: () => { g['keys'] = parseCells(keysInput.value); notify(true); },
    });
    rows.append(el('div', { class: 'ff-card' },
      el('div', { class: 'ff-cardhead' },
        el('span', {}, `group ${i + 1}`),
        iconButton('✕', 'Remove this group', () => {
          groups.splice(i, 1);
          if (groups.length === 0) delete def['u_diff'];
          notify(true);
        })),
      el('label', { class: 'ff-cellwrap ff-grow' }, el('span', {}, 'keys'), keysInput),
      el('div', { class: 'ff-cells' },
        cellInput(g, { key: 'u_width', label: 'u width', type: 'number', def: 1, step: 0.25 }, notify),
        cellInput(g, { key: 'u_height', label: 'u height', type: 'number', def: 1, step: 0.25 }, notify))));
  });
  return box;
}

// ----------------------------------------------------------- linked_keys

const LINK_SIDES: { key: string; label: string }[] = [
  { key: 'l', label: 'left' }, { key: 'r', label: 'right' },
  { key: 't', label: 'top' }, { key: 'b', label: 'bottom' },
];

export function linkedEditor(def: Target, notify: Notify): HTMLElement {
  const groups = (def['linked_keys'] as Record<string, unknown>[] | undefined) ?? [];

  const push = () => {
    def['linked_keys'] = [...groups, {}];
    notify(true);
  };
  const { box, rows } = listShell('Linked keys',
    'Explicit joins between keys the grid would not connect. Give each side ' +
    'as col,row — add a corner (tl, bl, br, tr) to anchor the seam.',
    '+ link', push);

  if (groups.length === 0) rows.append(emptyNote('No extra links.'));

  groups.forEach((g, i) => {
    const card = el('div', { class: 'ff-card' },
      el('div', { class: 'ff-cardhead' },
        el('span', {}, `link ${i + 1}`),
        iconButton('✕', 'Remove this link', () => {
          groups.splice(i, 1);
          if (groups.length === 0) delete def['linked_keys'];
          notify(true);
        })));
    const cells = el('div', { class: 'ff-cells' });
    for (const side of LINK_SIDES) {
      const input = el('input', {
        type: 'text', class: 'ff-cell', placeholder: 'col,row[,corner]',
        value: formatAnchor(g[side.key]),
        onchange: () => {
          const v = parseAnchor(input.value);
          if (v === undefined) delete g[side.key];
          else g[side.key] = v;
          notify(true);
        },
      });
      cells.append(el('label', { class: 'ff-cellwrap' },
        el('span', {}, side.label), input));
    }
    card.append(cells);
    rows.append(card);
  });
  return box;
}

// --------------------------------------------------------------- inserts

const PRIMARY = new Set(['col', 'row', 'x', 'y', 'rot', 'od', 'id']);

export function insertsEditor(
  def: Target, notify: Notify, selected: { col: number; row: number } | null,
): HTMLElement {
  const list = (def['inserts'] as Record<string, unknown>[] | undefined) ?? [];

  const push = () => {
    def['inserts'] = [...list, {
      col: selected?.col ?? 0, row: selected?.row ?? 0,
      x: 0, y: 0, od: 8, id: 4, rot: 0,
    }];
    notify(true);
  };
  const { box, rows } = listShell('Threaded inserts',
    'Each boss is placed relative to one key. Click a key in the map to aim ' +
    '“+ insert” at it.', '+ insert', push);

  if (list.length === 0) rows.append(emptyNote('No inserts — no bosses or screw holes.'));

  list.forEach((ins, i) => {
    const head = el('div', { class: 'ff-cardhead' },
      el('span', {}, `insert ${i + 1} @ ${ins['col'] ?? 0},${ins['row'] ?? 0}`),
      iconButton('⧉', 'Duplicate this insert', () => {
        def['inserts'] = [...list.slice(0, i + 1), { ...ins }, ...list.slice(i + 1)];
        notify(true);
      }),
      iconButton('✕', 'Remove this insert', () => {
        list.splice(i, 1);
        if (list.length === 0) delete def['inserts'];
        notify(true);
      }));

    const main = el('div', { class: 'ff-cells' });
    const extra = el('div', { class: 'ff-cells' });
    for (const f of INSERT_FIELDS as Field[]) {
      (PRIMARY.has(f.key) ? main : extra).append(cellInput(ins, f, notify));
    }
    rows.append(el('div', { class: 'ff-card' }, head, main,
      el('details', { class: 'ff-more' },
        el('summary', {}, 'boss shape & hole'), extra)));
  });
  return box;
}

// --------------------------------------------------------- skirt profile

export function skirtProfileEditor(def: Target, notify: Notify): HTMLElement {
  const steps = (def['skirt_profile'] as Record<string, unknown>[] | undefined) ?? [];

  const push = () => {
    def['skirt_profile'] = [...steps, { fraction: 0.25, angle: 0 }];
    notify(true);
  };
  const { box, rows } = listShell('Stepped skirt profile',
    'Overrides the single angle/flare above. Each step takes a fraction of ' +
    'the wall height at some angle; a step with fraction 0 and an “out” ' +
    'value is a horizontal shelf.', '+ step', push);

  // Generator: fills the list with a fanned set of steps.
  const gen = el('div', { class: 'ff-cells ff-gen' },
    cellInput(def, { key: 'skirt_steps', label: 'steps', type: 'number', def: 8, step: 1 }, notify),
    cellInput(def, { key: 'skirt_angle', label: 'start °', type: 'number', def: 30, step: 1 }, notify),
    cellInput(def, { key: 'skirt_angle_end', label: 'end °', type: 'number', def: 0, step: 1 }, notify),
    cellInput(def, { key: 'skirt_step_out', label: 'step out', type: 'number', def: 0.5, step: 0.1 }, notify),
    el('button', {
      type: 'button', class: 'ff-add',
      onclick: () => {
        const n = Math.max(1, Math.round(num(def['skirt_steps'], 8)));
        const a0 = num(def['skirt_angle'], 30);
        const a1 = num(def['skirt_angle_end'], 0);
        const out = num(def['skirt_step_out'], 0);
        const built: Record<string, number>[] = [];
        for (let i = 0; i < n; i++) {
          const t = n === 1 ? 0 : i / (n - 1);
          built.push({ fraction: 1 / n, angle: a0 + (a1 - a0) * t });
          if (out !== 0 && i < n - 1) built.push({ fraction: 0, out });
        }
        def['skirt_profile'] = built;
        notify(true);
      },
    }, 'Generate'));
  box.insertBefore(gen, rows);

  if (steps.length === 0) {
    rows.append(emptyNote('Empty — the skirt uses the single angle/flare above.'));
  }

  steps.forEach((s, i) => {
    rows.append(el('div', { class: 'ff-card ff-cardrow' },
      el('span', { class: 'ff-idx' }, String(i + 1)),
      cellInput(s, { key: 'fraction', label: 'fraction', type: 'number', def: 0, step: 0.05 }, notify),
      cellInput(s, { key: 'angle', label: 'angle °', type: 'number', def: 0, step: 1 }, notify),
      cellInput(s, { key: 'out', label: 'out mm', type: 'number', def: 0, step: 0.1 }, notify),
      iconButton('✕', 'Remove this step', () => {
        steps.splice(i, 1);
        if (steps.length === 0) delete def['skirt_profile'];
        notify(true);
      })));
  });
  return box;
}

// -------------------------------------------------------- assembly items

export function assemblyEditor(
  entry: Target, boardNames: string[], notify: Notify,
): HTMLElement {
  const items = (entry['items'] as Record<string, unknown>[] | undefined) ?? [];

  const push = () => {
    entry['items'] = [...items, { name: boardNames[0] ?? '', pos: [0, 0, 0], rot: [0, 0, 0] }];
    notify(true);
  };
  const { box, rows } = listShell('Assembly items',
    'Each item places one board from this file: mirrored, then rotated, then ' +
    'moved.', '+ item', push);

  if (items.length === 0) rows.append(emptyNote('No items — nothing to place.'));

  items.forEach((item, i) => {
    const nameSel = el('select', {
      class: 'ff-cell',
      onchange: () => { item['name'] = nameSel.value; notify(true); },
    });
    const known = new Set(boardNames);
    const current = String(item['name'] ?? '');
    if (current && !known.has(current)) boardNames = [current, ...boardNames];
    for (const n of boardNames) nameSel.append(el('option', { value: n }, n));
    nameSel.value = current;

    const vec = (key: string, labels: string[], step: number) => {
      const arr = (item[key] as number[] | undefined) ?? [0, 0, 0];
      item[key] = arr;
      const cells = labels.map((lab, axis) => {
        const input = el('input', {
          type: 'number', class: 'ff-cell', step,
          value: String(arr[axis] ?? 0),
          oninput: () => { arr[axis] = Number(input.value || 0); notify(); },
        });
        return el('label', { class: 'ff-cellwrap' }, el('span', {}, lab), input);
      });
      return el('div', { class: 'ff-cells' }, ...cells);
    };

    const mirror = (item['mirror'] as number[] | undefined) ?? [0, 0, 0];
    const mirrorRow = el('div', { class: 'ff-cells' },
      ...['x', 'y', 'z'].map((ax, axis) => {
        const boxIn = el('input', {
          type: 'checkbox', checked: Number(mirror[axis]) === 1,
          onchange: () => {
            mirror[axis] = boxIn.checked ? 1 : 0;
            if (mirror.some(m => m === 1)) item['mirror'] = mirror;
            else delete item['mirror'];
            notify(true);
          },
        });
        return el('label', { class: 'ff-check' }, boxIn, el('span', {}, `mirror ${ax}`));
      }));

    rows.append(el('div', { class: 'ff-card' },
      el('div', { class: 'ff-cardhead' },
        el('span', {}, `item ${i + 1}`),
        iconButton('✕', 'Remove this item', () => {
          items.splice(i, 1);
          entry['items'] = items;
          notify(true);
        })),
      el('label', { class: 'ff-cellwrap ff-grow' }, el('span', {}, 'board'), nameSel),
      el('span', { class: 'ff-sublabel' }, 'position (mm)'),
      vec('pos', ['x', 'y', 'z'], 1),
      el('span', { class: 'ff-sublabel' }, 'rotation (°)'),
      vec('rot', ['x', 'y', 'z'], 1),
      mirrorRow));
  });
  return box;
}

// --------------------------------------------------------------- cutouts

const CUT_TARGETS: { key: string; label: string }[] = [
  { key: 'plate', label: 'plate' },
  { key: 'walls', label: 'walls' },
  { key: 'baseplate', label: 'baseplate' },
];

const SHAPE_FIELDS: Record<string, Field[]> = {
  cylinder: [
    { key: 'r', label: 'radius', type: 'number', def: 1.65, step: 0.05, unit: 'mm' },
    { key: 'h', label: 'length', type: 'number', def: 20, step: 1, unit: 'mm' },
    { key: 'segments', label: 'segments', type: 'number', def: 32, step: 1 },
  ],
  sphere: [
    { key: 'r', label: 'radius', type: 'number', def: 2, step: 0.05, unit: 'mm' },
    { key: 'segments', label: 'segments', type: 'number', def: 24, step: 1 },
  ],
  box: [],
};

/** x/y/z triple stored as an array on `obj[key]`. */
function vecCells(
  obj: Target, key: string, label: string, def: number[], step: number,
  notify: Notify,
): HTMLElement {
  const arr = (obj[key] as number[] | undefined) ?? [...def];
  obj[key] = arr;
  const cells = ['x', 'y', 'z'].map((ax, i) => {
    const input = el('input', {
      type: 'number', class: 'ff-cell', step,
      value: String(arr[i] ?? 0),
      oninput: () => { arr[i] = Number(input.value || 0); notify(); },
    });
    return el('label', { class: 'ff-cellwrap' }, el('span', {}, `${label} ${ax}`), input);
  });
  return el('div', { class: 'ff-cells' }, ...cells);
}

export interface ShapeListLabels {
  key: string;
  title: string;
  note: string;
  addLabel: string;
  empty: string;
  itemName: string;
}

export const CUTOUT_LABELS: ShapeListLabels = {
  key: 'cutouts',
  title: 'Cutouts',
  note: 'Negative shapes subtracted from the case — a USB opening, a TRRS ' +
    'hole. Two offset cylinders hulled give the elongated slot a USB-C socket ' +
    'needs. Give pieces the same hull group to hull just those together: one ' +
    'group for a pan head, another for the shank under it.',
  addLabel: '+ cutout',
  empty: 'No cutouts.',
  itemName: 'cutout',
};

export const ADDITION_LABELS: ShapeListLabels = {
  key: 'additions',
  title: 'Additions',
  note: 'Solid shapes merged into the case — a collar around a port, a boss, ' +
    'a stiffening rib. Built exactly like cutouts, and added before cutouts ' +
    'are subtracted, so a cutout can bore straight through one.',
  addLabel: '+ addition',
  empty: 'No additions.',
  itemName: 'addition',
};

export function cutoutsEditor(
  def: Target, notify: Notify,
  selected: number | null = null,
  onSelect: (i: number) => void = () => {},
  labels: ShapeListLabels = CUTOUT_LABELS,
): HTMLElement {
  const list = (def[labels.key] as Record<string, unknown>[] | undefined) ?? [];

  const push = () => {
    def[labels.key] = [...list, {
      name: `${labels.itemName} ${list.length + 1}`,
      parts: [
        { shape: 'cylinder', r: 1.65, h: 20, segments: 32, pos: [-2.4, 0, 0] },
        { shape: 'cylinder', r: 1.65, h: 20, segments: 32, pos: [2.4, 0, 0] },
      ],
      rot: [90, 0, 0],
      pos: [0, 0, 8],
      targets: ['plate', 'walls', 'baseplate'],
    }];
    notify(true);
  };
  const { box, rows } = listShell(labels.title, labels.note, labels.addLabel, push);

  if (list.length === 0) rows.append(emptyNote(labels.empty));

  list.forEach((c, i) => {
    const parts = (c['parts'] as Record<string, unknown>[] | undefined) ?? [];
    c['parts'] = parts;

    const head = el('div', { class: 'ff-cardhead' },
      el('span', {}, String(c['name'] ?? `${labels.itemName} ${i + 1}`)),
      iconButton('⧉', 'Duplicate', () => {
        def[labels.key] = [...list.slice(0, i + 1),
          JSON.parse(JSON.stringify(c)), ...list.slice(i + 1)];
        notify(true);
      }),
      iconButton('✕', `Remove this ${labels.itemName}`, () => {
        list.splice(i, 1);
        if (list.length === 0) delete def[labels.key];
        notify(true);
      }));

    const nameInput = el('input', {
      type: 'text', class: 'ff-cell', placeholder: 'name',
      value: String(c['name'] ?? ''),
      oninput: () => { c['name'] = nameInput.value; notify(); },
    });

    // targets
    const chosen = new Set((c['targets'] as string[] | undefined) ?? CUT_TARGETS.map(t => t.key));
    const targetRow = el('div', { class: 'ff-cells' },
      ...CUT_TARGETS.map(t => {
        const cb = el('input', {
          type: 'checkbox', checked: chosen.has(t.key),
          onchange: () => {
            if (cb.checked) chosen.add(t.key); else chosen.delete(t.key);
            c['targets'] = [...chosen];
            notify(true);
          },
        });
        return el('label', { class: 'ff-check' }, cb, el('span', {}, t.label));
      }));

    const hullBox = el('input', {
      type: 'checkbox',
      checked: c['hull'] === undefined ? parts.length > 1 : c['hull'] === true,
      onchange: () => { c['hull'] = hullBox.checked; notify(true); },
    });

    const card = el('div', {
      class: 'ff-card' + (i === selected ? ' is-sel' : ''),
      // Clicking the card selects it for the placement map, but NOT when the
      // click was aimed at a control. A checkbox toggles and bubbles its click
      // before firing `change`, so re-rendering here would tear the checkbox
      // out of the DOM and its change handler would never run — the box
      // appeared to refuse to clear.
      onclick: (ev: Event) => {
        const t = ev.target as HTMLElement | null;
        if (t?.closest('input, select, textarea, button, label')) return;
        onSelect(i);
      },
    }, head,
      el('label', { class: 'ff-cellwrap ff-grow' }, el('span', {}, 'name'), nameInput),
      el('span', { class: 'ff-sublabel' },
        labels.key === 'cutouts' ? 'cuts into' : 'merges into'), targetRow,
      el('span', { class: 'ff-sublabel' }, 'position (mm)'),
      vecCells(c, 'pos', 'pos', [0, 0, 0], 0.5, notify),
      el('span', { class: 'ff-sublabel' }, 'rotation (°)'),
      vecCells(c, 'rot', 'rot', [0, 0, 0], 5, notify),
      el('label', { class: 'ff-check' }, hullBox,
        el('span', {}, 'hull ungrouped pieces together')));

    // pieces
    const partRows = el('div', { class: 'ff-rows' });
    parts.forEach((pt, pi) => {
      const shape = String(pt['shape'] ?? 'cylinder');
      const sel = el('select', {
        class: 'ff-cell',
        onchange: () => { pt['shape'] = sel.value; notify(true); },
      });
      for (const s of ['cylinder', 'box', 'sphere']) {
        sel.append(el('option', { value: s }, s));
      }
      sel.value = shape;

      const dims = el('div', { class: 'ff-cells' });
      if (shape === 'box') {
        dims.append(vecCells(pt, 'size', 'size', [3, 3, 20], 0.5, notify));
      } else {
        for (const f of SHAPE_FIELDS[shape] ?? []) dims.append(cellInput(pt, f, notify));
      }

      const groupInput = el('input', {
        type: 'text', class: 'ff-cell', placeholder: '(none)',
        value: String(pt['group'] ?? ''),
        oninput: () => {
          if (groupInput.value.trim() === '') delete pt['group'];
          else pt['group'] = groupInput.value.trim();
          notify();
        },
      });

      partRows.append(el('div', { class: 'ff-card' },
        el('div', { class: 'ff-cardhead' },
          el('span', {}, `piece ${pi + 1}`),
          iconButton('✕', 'Remove this piece', () => {
            parts.splice(pi, 1);
            notify(true);
          })),
        el('div', { class: 'ff-cells' },
          el('label', { class: 'ff-cellwrap ff-grow' }, el('span', {}, 'shape'), sel),
          el('label', { class: 'ff-cellwrap' },
            el('span', {}, 'hull group'), groupInput)),
        dims,
        vecCells(pt, 'pos', 'offset', [0, 0, 0], 0.5, notify)));
    });

    card.append(
      el('div', { class: 'ff-grouphead' },
        el('span', { class: 'ff-sublabel' }, 'pieces'),
        el('button', {
          type: 'button', class: 'ff-add',
          onclick: () => {
            parts.push({ shape: 'cylinder', r: 1.65, h: 20, segments: 32, pos: [0, 0, 0] });
            notify(true);
          },
        }, '+ piece')),
      partRows);
    rows.append(card);
  });
  return box;
}
