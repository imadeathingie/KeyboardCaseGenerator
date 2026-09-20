/**
 * The tabbed board editor. Every control writes straight into the parsed
 * document object; the host re-serialises it into the JSON tab and rebuilds
 * the model, so the form and the raw JSON are always the same thing seen two
 * ways.
 */

import { isAssembly } from '../core/core';
import { buildCutout, type CutoutSpec } from '../core/cutouts';
import type { Catalog, Entry } from '../core/types';
import { fieldRow, groupBlocks, type Notify, type Target } from './controls';
import { clear, el } from './dom';
import { hullXY, isDefinition, renderCutoutMap, renderKeyGrid } from './keyGrid';
import {
  ADDITION_LABELS, assemblyEditor, CUTOUT_LABELS, cutoutsEditor, ignoredEditor,
  insertsEditor, linkedEditor, skirtProfileEditor, uDiffEditor,
  type ShapeListLabels,
} from './lists';
import {
  ALGO_FIELDS, BASEPLATE_GROUPS, BOARD_GROUPS, FRAME_GROUPS, INSERT_GROUPS,
  LIP_GROUPS, SKIRT_GROUPS,
} from './schema';

export type TabId = 'board' | 'layout' | 'case' | 'cutouts' | 'additions'
  | 'inserts' | 'assembly' | 'json';

const TAB_LABELS: Record<TabId, string> = {
  board: 'Board',
  layout: 'Layout',
  case: 'Case',
  cutouts: 'Cutouts',
  additions: 'Additions',
  inserts: 'Inserts',
  assembly: 'Assembly',
  json: 'JSON',
};

export interface FormHost {
  /** The entry currently selected in the entry picker. */
  entry(): Entry | null;
  /** The whole parsed document (for assembly board names). */
  catalog(): Catalog | null;
  /** A control changed the document: re-serialise and rebuild. */
  changed(): void;
}

export class FormEditor {
  private tabsBar: HTMLElement;
  private body: HTMLElement;
  private jsonPanel: HTMLElement;
  private active: TabId = 'board';
  private selected: { col: number; row: number } | null = null;
  /** Selected row per shape list, keyed by its JSON key. */
  private selectedShape = new Map<string, number>();
  private gridHosts: { host: HTMLElement; editable: boolean; inserts: boolean }[] = [];

  constructor(
    tabsBar: HTMLElement,
    body: HTMLElement,
    jsonPanel: HTMLElement,
    private host: FormHost,
  ) {
    this.tabsBar = tabsBar;
    this.body = body;
    this.jsonPanel = jsonPanel;
  }

  /** Rebuild tab bar and panel — call when the selected entry changes. */
  refresh(): void {
    const tabs = this.tabsFor(this.host.entry());
    if (!tabs.includes(this.active)) this.active = tabs[0];
    this.renderTabs(tabs);
    this.renderPanel();
  }

  /** Re-draw only the key map (positions move as expressions are typed). */
  refreshGrids(): void {
    const entry = this.host.entry();
    if (entry === null) return;
    for (const g of this.gridHosts) {
      renderKeyGrid(g.host, entry,
        { editable: g.editable, showInserts: g.inserts, selected: this.selected,
          onPick: c => this.pick(c.col, c.row) },
        () => this.notify(true));
    }
  }

  get activeTab(): TabId { return this.active; }

  // ------------------------------------------------------------- internals

  private notify: Notify = (immediate = false) => {
    this.host.changed();
    if (immediate) this.renderPanel();
    else this.refreshGrids();
  };

  private pick(col: number, row: number) {
    this.selected = { col, row };
    this.refreshGrids();
    const readout = this.body.querySelector('.kg-readout');
    if (readout) readout.textContent = `selected ${col},${row}`;
  }

  private tabsFor(entry: Entry | null): TabId[] {
    if (entry === null) return ['json'];
    if (isAssembly(entry)) return ['assembly', 'json'];
    return ['board', 'layout', 'case', 'cutouts', 'additions', 'inserts', 'json'];
  }

  private renderTabs(tabs: TabId[]) {
    clear(this.tabsBar);
    for (const id of tabs) {
      this.tabsBar.append(el('button', {
        type: 'button',
        class: 'tab' + (id === this.active ? ' is-active' : ''),
        role: 'tab',
        'aria-selected': String(id === this.active),
        onclick: () => {
          this.active = id;
          this.renderTabs(tabs);
          this.renderPanel();
        },
      }, TAB_LABELS[id]));
    }
  }

  private renderPanel() {
    const entry = this.host.entry();
    this.gridHosts = [];

    // Structural edits (adding a row, clicking a key) redraw the whole panel;
    // holding the scroll position keeps the control under the cursor put.
    const scroller = this.body.parentElement;
    const scrollTop = scroller?.scrollTop ?? 0;

    this.jsonPanel.hidden = this.active !== 'json';
    this.body.hidden = this.active === 'json';
    if (this.active === 'json') { clear(this.body); return; }

    clear(this.body);
    if (entry === null) return;
    const target = entry as Target;

    switch (this.active) {
      case 'board': this.renderBoard(target); break;
      case 'layout': this.renderLayout(target); break;
      case 'case': this.renderCase(target); break;
      case 'cutouts': this.renderShapes(target, CUTOUT_LABELS); break;
      case 'additions': this.renderShapes(target, ADDITION_LABELS); break;
      case 'inserts': this.renderInserts(target); break;
      case 'assembly': this.renderAssembly(target); break;
      default: break;
    }
    if (scroller) scroller.scrollTop = scrollTop;
  }

  private renderBoard(target: Target) {
    const isDef = isDefinition(target as Entry);
    const groups = isDef
      ? BOARD_GROUPS
      : BOARD_GROUPS.filter(g => g.title !== 'Grid');
    if (!isDef) {
      this.body.append(el('p', { class: 'ff-note ff-flag' },
        'This entry is an expanded keylist: its keys are listed explicitly, ' +
        'so the grid size and layout expressions do not apply.'));
    }
    this.body.append(groups.length
      ? groupBlocks(target, groups, this.notify)
      : document.createDocumentFragment());
  }

  private renderLayout(target: Target) {
    const editable = isDefinition(target as Entry);

    const gridBox = el('section', { class: 'ff-group' },
      el('div', { class: 'ff-grouphead' },
        el('h3', {}, 'Key map'),
        el('span', { class: 'kg-readout' },
          this.selected ? `selected ${this.selected.col},${this.selected.row}` : '')),
      el('p', { class: 'ff-note' }, editable
        ? 'Top-down view, shaded by key height. Click a key to drop it from ' +
          'the layout, click a ghost to bring it back.'
        : 'Top-down view of the keys in this keylist.'));
    const gridHost = el('div', { class: 'kg-host' });
    gridBox.append(gridHost);
    this.body.append(gridBox);
    this.gridHosts.push({ host: gridHost, editable, inserts: true });

    if (editable) {
      const algoBox = el('section', { class: 'ff-group' },
        el('h3', {}, 'Position expressions'),
        el('p', { class: 'ff-note' },
          'Python-syntax expressions in x (column), y (row), key_1u, width ' +
          'and height. abs, min, max, floor, ceil, round and ' +
          '“a if cond else b” are available.'));
      const grid = el('div', { class: 'ff-grid ff-algos' });
      for (const f of ALGO_FIELDS) {
        grid.append(fieldRow(target, f, this.notify));
      }
      algoBox.append(grid);
      this.body.append(algoBox);
      this.body.append(ignoredEditor(target, this.notify));
      this.body.append(uDiffEditor(target, this.notify));
      this.body.append(linkedEditor(target, this.notify));
    }
    this.refreshGrids();
  }

  private renderCase(target: Target) {
    this.body.append(groupBlocks(target, SKIRT_GROUPS, this.notify));
    this.body.append(skirtProfileEditor(target, this.notify));
    this.body.append(groupBlocks(target, LIP_GROUPS, this.notify));
    this.body.append(groupBlocks(target, FRAME_GROUPS, this.notify));
    this.body.append(groupBlocks(target, BASEPLATE_GROUPS, this.notify));
  }

  /** Cutouts and additions: same editor, same placement map, different key. */
  private renderShapes(target: Target, labels: ShapeListLabels) {
    const list = (target[labels.key] as Record<string, unknown>[] | undefined) ?? [];
    let selected = this.selectedShape.get(labels.key) ?? null;
    if (selected !== null && selected >= list.length) selected = null;
    if (selected === null && list.length) selected = 0;
    if (selected === null) this.selectedShape.delete(labels.key);
    else this.selectedShape.set(labels.key, selected);

    const box = el('section', { class: 'ff-group' },
      el('div', { class: 'ff-grouphead' },
        el('h3', {}, 'Placement'),
        el('span', { class: 'kg-readout' }, selected === null
          ? '' : `moving ${String(list[selected]?.['name'] ?? selected + 1)}`)),
      el('p', { class: 'ff-note' },
        'Plan view. Click a shape to select it, then click anywhere to move it ' +
        'there. Height, rotation and shape stay in the card below — a plan view ' +
        'cannot show them.'));
    const mapHost = el('div', { class: 'kg-host' });
    box.append(mapHost);
    this.body.append(box);

    const footprints = list.map((c, i) => ({
      index: i,
      name: String(c['name'] ?? `${labels.itemName} ${i + 1}`),
      pts: cutoutFootprint(c),
    })).filter(f => f.pts.length >= 3);

    renderCutoutMap(mapHost, target as Entry, footprints, {
      selected,
      onSelect: i => { this.selectedShape.set(labels.key, i); this.renderPanel(); },
      onPlace: (x, y) => {
        const c = selected === null ? null : list[selected];
        if (!c) return;
        const pos = (c['pos'] as number[] | undefined) ?? [0, 0, 0];
        c['pos'] = [Number(x.toFixed(2)), Number(y.toFixed(2)), pos[2] ?? 0];
        this.notify(true);
      },
    });

    this.body.append(cutoutsEditor(target, this.notify, selected,
      i => { this.selectedShape.set(labels.key, i); this.renderPanel(); }, labels));
  }

  private renderInserts(target: Target) {
    const gridBox = el('section', { class: 'ff-group' },
      el('div', { class: 'ff-grouphead' },
        el('h3', {}, 'Boss placement'),
        el('span', { class: 'kg-readout' },
          this.selected ? `selected ${this.selected.col},${this.selected.row}` : '')),
      el('p', { class: 'ff-note' },
        'Dots mark each boss. Click a key to select it, then add an insert ' +
        'anchored there.'));
    const gridHost = el('div', { class: 'kg-host' });
    gridBox.append(gridHost);
    this.body.append(gridBox);
    this.gridHosts.push({ host: gridHost, editable: false, inserts: true });

    this.body.append(insertsEditor(target, this.notify, this.selected));
    this.body.append(groupBlocks(target, INSERT_GROUPS, this.notify));
    this.refreshGrids();
  }

  private renderAssembly(target: Target) {
    const cat = this.host.catalog();
    const list = cat === null ? [] : (Array.isArray(cat) ? cat : [cat]);
    const names = list
      .filter(e => typeof e === 'object' && e !== null && !isAssembly(e))
      .map(e => String((e as Record<string, unknown>)['name'] ?? ''))
      .filter(n => n !== '');

    this.body.append(groupBlocks(target, [{
      title: 'Identity',
      fields: [{ key: 'name', label: 'Name', type: 'text', def: 'assembly' }],
    }], this.notify));
    this.body.append(assemblyEditor(target, names, this.notify));
  }
}

/**
 * A cutout's top-down outline, for the placement map. Built from the real tool
 * solid so what you drag is what gets subtracted; a bad spec just draws
 * nothing rather than breaking the panel.
 */
function cutoutFootprint(spec: Record<string, unknown>): [number, number][] {
  try {
    const mesh = buildCutout(spec as unknown as CutoutSpec);
    return hullXY(mesh.vertices.map(v => [v[0], v[1]] as [number, number]));
  } catch {
    return [];
  }
}
