/**
 * Form controls bound straight to a JSON object. A control writes its key on
 * edit and deletes it when emptied, so the document only ever carries the
 * fields the user actually set — defaults stay implicit, as in the samples.
 */

import { el } from './dom';
import type { Field, Group } from './schema';

export type Target = Record<string, unknown>;
export type Notify = (immediate?: boolean) => void;

const placeholderOf = (f: Field): string =>
  f.def === undefined ? '' : `${f.def}${f.unit ?? ''}`;

function labelFor(f: Field, control: HTMLElement, id: string): HTMLElement {
  control.id = id;
  return el('label', { class: 'ff-label', htmlFor: id },
    f.label, f.unit ? el('span', { class: 'ff-unit' }, f.unit) : null);
}

let seq = 0;
const nextId = () => `ff-${++seq}`;

/** One labelled control for `field`, reading and writing `target[field.key]`. */
export function fieldRow(target: Target, f: Field, notify: Notify): HTMLElement {
  const id = nextId();
  const row = el('div', { class: `ff-row ff-${f.type}` });
  const current = target[f.key];

  if (f.type === 'bool') {
    const box = el('input', {
      type: 'checkbox',
      checked: current === undefined ? f.def === true : current === true,
      onchange: () => { target[f.key] = box.checked; notify(true); },
    });
    row.classList.add('ff-checkline');
    row.append(el('label', { class: 'ff-check' }, box,
      el('span', {}, f.label)));
    if (f.hint) row.append(el('p', { class: 'ff-hint' }, f.hint));
    return row;
  }

  if (f.type === 'select') {
    const sel = el('select', {
      onchange: () => {
        if (sel.value === '') delete target[f.key];
        else target[f.key] = sel.value;
        notify(true);
      },
    });
    sel.append(el('option', { value: '' }, `default (${f.def})`));
    for (const o of f.options ?? []) {
      sel.append(el('option', { value: o.value }, o.label));
    }
    sel.value = current === undefined ? '' : String(current);
    row.append(labelFor(f, sel, id), sel);
    if (f.hint) row.append(el('p', { class: 'ff-hint' }, f.hint));
    return row;
  }

  if (f.type === 'expr') {
    const area = el('textarea', {
      class: 'ff-expr',
      rows: 2,
      spellcheck: false,
      placeholder: String(f.def ?? ''),
      value: current === undefined ? '' : String(current),
      oninput: () => {
        if (area.value.trim() === '') delete target[f.key];
        else target[f.key] = area.value;
        notify();
      },
    });
    row.append(labelFor(f, area, id), area);
    if (f.hint) row.append(el('p', { class: 'ff-hint' }, f.hint));
    return row;
  }

  if (f.type === 'text') {
    const input = el('input', {
      type: 'text',
      placeholder: placeholderOf(f),
      value: current === undefined ? '' : String(current),
      oninput: () => {
        if (input.value === '') delete target[f.key];
        else target[f.key] = input.value;
        notify();
      },
    });
    row.append(labelFor(f, input, id), input);
    if (f.hint) row.append(el('p', { class: 'ff-hint' }, f.hint));
    return row;
  }

  // number, optionally paired with a slider
  const input = el('input', {
    type: 'number',
    placeholder: placeholderOf(f),
    min: f.min, max: f.max, step: f.step ?? 'any',
    value: current === undefined ? '' : String(current),
  });
  const slider = f.slider && f.min !== undefined && f.max !== undefined
    ? el('input', {
        type: 'range', class: 'ff-slider',
        min: f.min, max: f.max, step: f.step ?? 1,
        value: String(current === undefined ? (f.def ?? 0) : current),
      })
    : null;

  input.addEventListener('input', () => {
    if (input.value.trim() === '') delete target[f.key];
    else target[f.key] = Number(input.value);
    if (slider && input.value.trim() !== '') slider.value = input.value;
    notify();
  });
  slider?.addEventListener('input', () => {
    target[f.key] = Number(slider.value);
    input.value = slider.value;
    notify();
  });

  row.append(labelFor(f, input, id),
    el('div', { class: 'ff-numwrap' }, input, slider));
  if (f.hint) row.append(el('p', { class: 'ff-hint' }, f.hint));
  return row;
}

/** A titled block of controls. */
export function groupBlock(target: Target, g: Group, notify: Notify): HTMLElement {
  const box = el('section', { class: 'ff-group' },
    el('h3', {}, g.title),
    g.note ? el('p', { class: 'ff-note' }, g.note) : null);
  const grid = el('div', { class: 'ff-grid' });
  for (const f of g.fields) grid.append(fieldRow(target, f, notify));
  box.append(grid);
  return box;
}

export function groupBlocks(
  target: Target, groups: Group[], notify: Notify,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const g of groups) frag.append(groupBlock(target, g, notify));
  return frag;
}

/** Compact inline control used inside repeating list rows. */
export function cellInput(
  target: Target, f: Field, notify: Notify,
): HTMLElement {
  const input = el('input', {
    type: f.type === 'number' ? 'number' : 'text',
    class: 'ff-cell',
    step: f.step ?? 'any',
    placeholder: f.def === undefined ? '' : String(f.def),
    value: target[f.key] === undefined ? '' : String(target[f.key]),
    oninput: () => {
      if (input.value.trim() === '') delete target[f.key];
      else target[f.key] = f.type === 'number' ? Number(input.value) : input.value;
      notify();
    },
  });
  return el('label', { class: 'ff-cellwrap', title: f.label },
    el('span', {}, f.label), input);
}

export function iconButton(
  label: string, title: string, onClick: () => void,
): HTMLButtonElement {
  return el('button', { type: 'button', class: 'ff-icon', title, onclick: onClick },
    label);
}
