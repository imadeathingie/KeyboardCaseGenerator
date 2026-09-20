import './style.css';
import {
  buildBaseplateFromAny, buildInsertsFromAny, buildPlankFromAny,
  buildShellFromAny, buildWallsFromAny, findNamedEntry, isAssembly,
  mergeMeshes, resolveKeylist, transformMesh, wallStyle,
} from './core/core';
import type { AssemblyEntry, Catalog, Entry, Mesh, Vec3 } from './core/types';
import { subtractAll, unionAll } from './core/csg';
import {
  buildCutout, solidsFor, type CutoutSpec, type CutoutTarget,
} from './core/cutouts';
import { downloadJSON, downloadSTL } from './stl';
import { debounce } from './ui/dom';
import { FormEditor } from './ui/form';
import { RenderMode, Viewer } from './viewer';

type Category = 'plate' | 'inserts' | 'walls' | 'baseplate' | 'plank';

interface PartStyle { label: string; color: number; alpha: number }

const DEFAULT_STYLE: Record<Category, PartStyle> = {
  plate: { label: 'Plate + case', color: 0xb9c2cb, alpha: 1 },
  inserts: { label: 'Insert bosses', color: 0xf0b542, alpha: 1 },
  walls: { label: 'Wall frame', color: 0x8d99a7, alpha: 1 },
  baseplate: { label: 'Baseplate', color: 0x5f6a78, alpha: 1 },
  plank: { label: 'Plank', color: 0xa9793f, alpha: 1 },
};

/** Cutout previews are negative space, so they start hidden and see-through. */
const CUTOUT_STYLE: PartStyle = { label: 'Cutout', color: 0xc4562f, alpha: 0.45 };

/**
 * Colours live in the board JSON under `part_colors`, keyed by part group, as
 * CSS hex — `#rrggbb`, or `#rrggbbaa` to carry opacity. A cutout may also set
 * its own `color`, which wins over `part_colors.cutout`.
 */
function parseColor(text: unknown): { color: number; alpha: number } | null {
  if (typeof text !== 'string') return null;
  const m = text.trim().replace(/^#/, '');
  const hex = m.length === 3 ? m.split('').map(c => c + c).join('') : m;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null;
  return {
    color: parseInt(hex.slice(0, 6), 16),
    alpha: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function formatColor(color: number, alpha: number): string {
  const rgb = `#${color.toString(16).padStart(6, '0')}`;
  if (alpha >= 1) return rgb;
  return rgb + Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16).padStart(2, '0');
}

/** Resolve one group's style against a board's `part_colors`. */
function styleFrom(
  colors: Record<string, string> | undefined, group: string, base: PartStyle,
): PartStyle {
  const key = group.startsWith('cutout:') ? 'cutout' : group;
  const c = parseColor(colors?.[group]) ?? parseColor(colors?.[key]);
  return c ? { ...base, color: c.color, alpha: c.alpha } : base;
}

interface BuiltPart {
  id: string;         // e.g. "plate" or "plate:1"
  /** Visibility and styling are per group, so assembly copies share one row. */
  group: string;
  /** Style as resolved from the board's part_colors at build time. */
  style: PartStyle;
  /** Preview of a negative solid: shown for placement, never exported. */
  preview?: boolean;
  mesh: Mesh;
}

// ------------------------------------------------------------------- DOM

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const sampleSelect = $<HTMLSelectElement>('sample-select');
const entrySelect = $<HTMLSelectElement>('entry-select');
const entryRow = $<HTMLElement>('entry-row');
const addEntryBtn = $<HTMLButtonElement>('add-entry');
const fileInput = $<HTMLInputElement>('file-input');
const openFileBtn = $<HTMLButtonElement>('open-file');
const newBoardBtn = $<HTMLButtonElement>('new-board');
const editor = $<HTMLTextAreaElement>('editor');
const buildBtn = $<HTMLButtonElement>('build');
const errorBox = $<HTMLElement>('error-box');
const partsBox = $<HTMLElement>('parts');
const modeSelect = $<HTMLSelectElement>('render-mode');
const frameBtn = $<HTMLButtonElement>('frame');
const exportStlBtn = $<HTMLButtonElement>('export-stl');
const exportJsonBtn = $<HTMLButtonElement>('export-json');
const statusBox = $<HTMLElement>('status');
const tabsBar = $<HTMLElement>('tabs');
const formPanel = $<HTMLElement>('panel-form');
const jsonPanel = $<HTMLElement>('panel-json');

const viewer = new Viewer($('viewport'));

// ----------------------------------------------------------------- form submit
const FORM_ID = "AttycIpoS_b8";
const BASE_URL = "https://forms.oniccah.com";

let currentToken: string | null = null;

// -------------------------------------------------------------- app state

let catalog: Catalog | null = null;
let entryIndex = 0;
let builtParts: BuiltPart[] = [];
/** Groups the user has hidden. Anything absent is shown, except previews. */
const hiddenGroups = new Set<string>();
const isShown = (p: BuiltPart) =>
  !hiddenGroups.has(p.group) && (!p.preview || shownPreviews.has(p.group));
/** Cutout previews are opt-in. */
const shownPreviews = new Set<string>();
let firstBuild = true;

function entries(): Entry[] {
  if (catalog === null) return [];
  return Array.isArray(catalog) ? catalog : [catalog];
}

function currentEntry(): Entry | null {
  return entries()[entryIndex] ?? null;
}

// ------------------------------------------------------------------ build

/** Non-fatal problems from the current build, shown once it finishes. */
let warnings: string[] = [];

/** Build every part for one (non-assembly) board entry. */
function buildBoardParts(
  entry: Entry, suffix = '', inherited?: Record<string, string>,
): BuiltPart[] {
  const kl = resolveKeylist(entry);
  const parts: BuiltPart[] = [];
  // A board's own colours win over any the assembly handed down.
  const colors = { ...(inherited ?? {}), ...(kl.part_colors ?? {}) };
  const st = (group: string, base: PartStyle) => styleFrom(colors, group, base);

  // Additions are unioned in first, then cutouts are subtracted — so a cutout
  // can bore straight through a collar the additions put there.
  const specs = (kl.cutouts ?? []) as CutoutSpec[];
  const adds = (kl.additions ?? []) as CutoutSpec[];
  const shape = (mesh: Mesh, target: CutoutTarget): Mesh => {
    let out = mesh;
    if (adds.length > 0) {
      try {
        out = unionAll([out, ...solidsFor(adds, target)]);
      } catch (e) {
        warnings.push(`Addition on ${target} skipped: ${(e as Error).message}`);
      }
    }
    if (specs.length > 0) {
      try {
        out = subtractAll(out, solidsFor(specs, target));
      } catch (e) {
        warnings.push(`Cutout on ${target} skipped: ${(e as Error).message}`);
      }
    }
    return out;
  };
  const cut = shape;

  parts.push({
    id: `plate${suffix}`, group: 'plate', style: st('plate', DEFAULT_STYLE.plate),
    mesh: cut(buildShellFromAny(entry), 'plate'),
  });

  const inserts = buildInsertsFromAny(entry);
  if (inserts.vertices.length > 0) {
    parts.push({
      id: `inserts${suffix}`, group: 'inserts', style: st('inserts', DEFAULT_STYLE.inserts),
      mesh: inserts,
    });
  }

  const style = wallStyle(kl);
  if (style === 'lip') {
    // The board IS the bottom of the case, so there is no baseplate. The plank
    // is stock to be machined rather than a part of the keyboard, so cutouts
    // and additions aimed at the case are not applied to it.
    try {
      parts.push({
        id: `plank${suffix}`, group: 'plank', style: st('plank', DEFAULT_STYLE.plank),
        mesh: buildPlankFromAny(entry),
      });
    } catch (e) {
      warnings.push(`Plank skipped: ${(e as Error).message}`);
    }
  } else if (style === 'skirt') {
    // Fused-skirt case: the plate carries its own walls; the separate frame
    // doesn't apply, but a matching baseplate does.
    parts.push({
      id: `baseplate${suffix}`, group: 'baseplate', style: st('baseplate', DEFAULT_STYLE.baseplate),
      mesh: cut(buildBaseplateFromAny(entry), 'baseplate'),
    });
  } else {
    parts.push({
      id: `walls${suffix}`, group: 'walls', style: st('walls', DEFAULT_STYLE.walls),
      mesh: cut(buildWallsFromAny(entry), 'walls'),
    });
    // The frame is open at the bottom: close it with a baseplate on the same
    // footprint, so showing both and exporting gives one closed case. A board
    // whose footprint will not triangulate still gets its plate and frame —
    // losing the whole model over the cover would be a poor trade.
    if ((kl.baseplate_thickness ?? 2) > 0) {
      try {
        parts.push({
          id: `baseplate${suffix}`, group: 'baseplate',
          style: st('baseplate', DEFAULT_STYLE.baseplate),
          mesh: cut(buildBaseplateFromAny(entry), 'baseplate'),
        });
      } catch (e) {
        warnings.push(`Baseplate skipped: ${(e as Error).message}`);
      }
    }
  }
  // One preview solid per cutout, so each can be shown and placed in 3D.
  specs.forEach((spec, i) => {
    try {
      parts.push({
        id: `cutout${i}${suffix}`,
        group: `cutout:${i}`,
        style: {
          ...styleFrom(
            { ...colors, ...(spec.color ? { [`cutout:${i}`]: spec.color } : {}) },
            `cutout:${i}`, CUTOUT_STYLE),
          label: spec.name ?? `Cutout ${i + 1}`,
        },
        preview: true,
        mesh: buildCutout(spec),
      });
    } catch { /* a bad spec already warned when it was subtracted */ }
  });

  return parts;
}

/** Build an assembly: each item is a named board, placed by pos/rot/mirror. */
function buildAssemblyParts(entry: AssemblyEntry): BuiltPart[] {
  const parts: BuiltPart[] = [];
  const items = entry.items ?? [];
  let resolvedAny = false;
  items.forEach((item, idx) => {
    const board = findNamedEntry(item.name ?? '', catalog!);
    if (board === null) return;
    resolvedAny = true;
    const pos = (item.pos ?? [0, 0, 0]) as Vec3;
    const rot = (item.rot ?? [0, 0, 0]) as Vec3;
    const mirror = (item.mirror ?? [0, 0, 0]) as [number, number, number];
    const inherited = (resolveKeylist(entry as Entry).part_colors
      ?? (entry as Record<string, unknown>)['part_colors']) as
      Record<string, string> | undefined;
    for (const p of buildBoardParts(board, `:${idx}`, inherited)) {
      parts.push({ ...p, mesh: transformMesh(p.mesh, pos, rot, mirror) });
    }
  });
  if (!resolvedAny) {
    throw new Error('assembly: none of the item names matched a board ' +
      'entry in this file');
  }
  return parts;
}

async function fetchToken(): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/f/${FORM_ID}/token`, {
        headers: {
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        throw new Error("Failed to obtain form token.");
    }

    const data = await response.json();
    return data.token;
}

// Call this once when the page loads.
export async function initializeForm() {
    currentToken = await fetchToken();
}

export async function submitForm(formData: object) {
    if (!currentToken) {
        currentToken = await fetchToken();
        return;
    }

    // Save the current token because we'll replace it afterwards.
    const token = currentToken;
    const response = await fetch(`${BASE_URL}/f/${FORM_ID}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({
            token,
            items: formData
        })
    });

    // Always fetch a fresh token after this attempt because
    // tokens are single-use.
    currentToken = await fetchToken();

    const result = await response.json();

    if (!response.ok) {
        throw new Error(result.error ?? "Form submission failed.");
    }

    return result;
}

/**
 * Build the meshes for the selected entry and show them. The parsed document
 * is the source of truth: the tabs edit it in place and the JSON tab is a
 * serialised view of it (see syncEditor / applyEditorText).
 */
function build(manual = false) {
  clearError();
  warnings = [];

  const entry = currentEntry();
  if (entry === null) {
    showError('The file contains no entries.');
    return;
  }

  const t0 = performance.now();
  try {
    builtParts = isAssembly(entry)
      ? buildAssemblyParts(entry)
      : buildBoardParts(entry);
  } catch (e) {
    showError((e as Error).message);
    return;
  }
  const buildMs = performance.now() - t0;

  const keep = new Set(builtParts.map(p => p.id));
  viewer.removePartsExcept(keep);
  for (const p of builtParts) {
    viewer.setPart(p.id, p.mesh,
      { color: p.style.color, opacity: p.style.alpha });
  }
  applyVisibility();
  renderPartToggles();
  renderStatus(buildMs);
  if (warnings.length > 0) showError(warnings.join('\n'));

  if (firstBuild) {
    viewer.frameAll();
    firstBuild = false;
  }
  if (manual && catalog !== null) {
    submitForm(catalog as object);
  }
}

const scheduleBuild = debounce(() => build(), 150);

/** Mirror the document into the JSON tab (never while it is being typed in). */
function syncEditor() {
  if (document.activeElement === editor) return;
  editor.value = catalog === null ? '' : JSON.stringify(catalog, null, 2);
}

/** Adopt a freshly parsed document: refresh the pickers, tabs and model. */
function setCatalog(next: Catalog, opts: { reframe?: boolean; reset?: boolean } = {}) {
  catalog = next;
  if (opts.reset) entryIndex = 0;
  if (opts.reframe) firstBuild = true;
  refreshEntrySelect();
  syncEditor();
  form.refresh();
  build();
}

/** Parse the JSON tab and adopt it, leaving the text exactly as typed. */
function applyEditorText(): boolean {
  let parsed: Catalog;
  try {
    parsed = JSON.parse(editor.value);
  } catch (e) {
    showError(`JSON parse error: ${(e as Error).message}`);
    return false;
  }
  clearError();
  catalog = parsed;
  refreshEntrySelect();
  form.refresh();
  build();
  return true;
}

function showError(msg: string) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

// ------------------------------------------------------------- form editor

const form = new FormEditor(tabsBar, formPanel, jsonPanel, {
  entry: () => currentEntry(),
  catalog: () => catalog,
  changed: () => {
    clearError();
    syncEditor();
    refreshEntrySelect();
    scheduleBuild();
  },
});

// -------------------------------------------------------------- entry list

function refreshEntrySelect() {
  const list = entries();
  const prev = String(entryIndex);
  entrySelect.innerHTML = '';
  list.forEach((e, i) => {
    const opt = document.createElement('option');
    const name = (e as Record<string, unknown>)['name'] ?? `entry ${i}`;
    opt.value = String(i);
    opt.textContent = isAssembly(e) ? `${name} (assembly)` : String(name);
    entrySelect.appendChild(opt);
  });
  entryRow.hidden = list.length === 0;
  if (Number(prev) < list.length) entrySelect.value = prev || '0';
  entryIndex = Number(entrySelect.value) || 0;
}

entrySelect.addEventListener('change', () => {
  entryIndex = Number(entrySelect.value) || 0;
  firstBuild = true; // reframe on a different board
  form.refresh();
  build();
});

/** Append a fresh board to the current file and switch to it. */
addEntryBtn.addEventListener('click', () => {
  const list = entries();
  const board = { name: `board ${list.length + 1}`, width: 6, height: 4 };
  catalog = [...list, board] as Catalog;
  entryIndex = list.length;
  firstBuild = true;
  refreshEntrySelect();
  entrySelect.value = String(entryIndex);
  entryIndex = Number(entrySelect.value) || 0;
  syncEditor();
  form.refresh();
  build();
});

newBoardBtn.addEventListener('click', () => {
  sampleSelect.value = '';
  setCatalog({ name: 'New board', width: 6, height: 4 } as Catalog,
    { reframe: true, reset: true });
});

// ------------------------------------------------------------ part toggles

/** One row per group, in build order. */
function groupsPresent(): BuiltPart[] {
  const seen = new Set<string>();
  const out: BuiltPart[] = [];
  for (const p of builtParts) {
    if (seen.has(p.group)) continue;
    seen.add(p.group);
    out.push(p);
  }
  return out;
}

function applyVisibility() {
  for (const p of builtParts) viewer.setVisible(p.id, isShown(p));
}

function renderPartToggles() {
  partsBox.innerHTML = '';

  /** Write a group's colour into the selected entry's part_colors. */
  const writeColor = (group: string, color: number, alpha: number) => {
    const entry = currentEntry() as Record<string, unknown> | null;
    if (entry === null) return;
    const key = group.startsWith('cutout:') ? group : group;
    const table = (entry['part_colors'] as Record<string, string> | undefined) ?? {};
    table[key] = formatColor(color, alpha);
    entry['part_colors'] = table;
    syncEditor();
    restyleGroup(group, color, alpha);
  };

  for (const part of groupsPresent()) {
    const group = part.group;
    const st = part.style;

    // The row is NOT a label. Only the checkbox and its name are, so clicking
    // the colour well or the slider cannot toggle visibility. Wrapping the
    // whole row and cancelling the click on those controls instead is what
    // stopped the colour picker opening at all: preventDefault on an
    // <input type="color"> click IS the thing that suppresses the picker.
    const row = document.createElement('div');
    row.className = 'part-toggle';

    const vis = document.createElement('label');
    vis.className = 'part-vis';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = part.preview
      ? shownPreviews.has(group)
      : !hiddenGroups.has(group);
    input.addEventListener('change', () => {
      const set = part.preview ? shownPreviews : hiddenGroups;
      const on = part.preview ? input.checked : !input.checked;
      if (on) set.add(group); else set.delete(group);
      applyVisibility();
      renderStatus();
    });

    const text = document.createElement('span');
    text.className = 'part-name';
    text.textContent = st.label;
    vis.append(input, text);

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'swatch-input';
    swatch.value = `#${st.color.toString(16).padStart(6, '0')}`;
    swatch.title = `Colour of ${st.label}`;
    swatch.addEventListener('input', () => {
      writeColor(group, parseInt(swatch.value.slice(1), 16),
        Number(alphaSlider.value));
    });

    const alphaSlider = document.createElement('input');
    alphaSlider.type = 'range';
    alphaSlider.className = 'alpha-slider';
    alphaSlider.min = '0.05';
    alphaSlider.max = '1';
    alphaSlider.step = '0.05';
    alphaSlider.value = String(st.alpha);
    alphaSlider.title = `Opacity of ${st.label}`;
    alphaSlider.addEventListener('input', () => {
      writeColor(group, parseInt(swatch.value.slice(1), 16),
        Number(alphaSlider.value));
    });

    row.append(vis, swatch, alphaSlider);
    partsBox.appendChild(row);
  }

  const entry = currentEntry() as Record<string, unknown> | null;
  if (entry && entry['part_colors']) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ff-add';
    reset.textContent = 'Reset colours';
    reset.addEventListener('click', () => {
      delete entry['part_colors'];
      syncEditor();
      for (const p of builtParts) {
        const base = p.group.startsWith('cutout:')
          ? { ...CUTOUT_STYLE, label: p.style.label }
          : DEFAULT_STYLE[p.group as Category];
        if (!base) continue;
        p.style = { ...base, label: p.style.label };
        viewer.setPartStyle(p.id, p.style.color, p.style.alpha);
      }
      renderPartToggles();
    });
    partsBox.appendChild(reset);
  }
}

/** Push a colour to every part in a group, and remember it on them. */
function restyleGroup(group: string, color: number, alpha: number) {
  for (const p of builtParts) {
    if (p.group !== group) continue;
    p.style = { ...p.style, color, alpha };
    viewer.setPartStyle(p.id, color, alpha);
  }
}

// ---------------------------------------------------------------- status

/** What the model actually consists of: previews are negative space. */
function visibleMeshes(): Mesh[] {
  return builtParts.filter(p => isShown(p) && !p.preview).map(p => p.mesh);
}

function renderStatus(buildMs?: number) {
  const entry = currentEntry();
  if (entry === null) { statusBox.textContent = ''; return; }

  let keys = 0;
  try {
    if (isAssembly(entry)) {
      for (const item of entry.items ?? []) {
        const board = findNamedEntry(item.name ?? '', catalog!);
        if (board) keys += resolveKeylist(board).keylist.length;
      }
    } else {
      keys = resolveKeylist(entry).keylist.length;
    }
  } catch { /* status only */ }

  let verts = 0, tris = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let nonManifold = 0;

  for (const m of visibleMeshes()) {
    verts += m.vertices.length;
    for (const f of m.faces) tris += Math.max(0, f.length - 2);
    for (const [x, y, z] of m.vertices) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const edgeCount = new Map<string, number>();
    for (const f of m.faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const k = a < b ? `${a},${b}` : `${b},${a}`;
        edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      }
    }
    for (const c of edgeCount.values()) if (c !== 2) nonManifold++;
  }

  const dims = verts > 0
    ? `${(maxX - minX).toFixed(1)} × ${(maxY - minY).toFixed(1)} × ${(maxZ - minZ).toFixed(1)} mm`
    : '—';
  const water = verts === 0 ? '—'
    : nonManifold === 0 ? 'watertight ✓' : `${nonManifold} open edges ✗`;

  const cells = [
    `keys ${keys}`,
    `verts ${verts}`,
    `tris ${tris}`,
    dims,
    water,
  ];
  if (buildMs !== undefined) cells.push(`built in ${buildMs.toFixed(0)} ms`);
  statusBox.innerHTML = cells.map(c => `<span>${c}</span>`).join('');
  statusBox.classList.toggle('bad', verts > 0 && nonManifold > 0);
}

// --------------------------------------------------------------- samples

interface SampleInfo { id: string; name: string; file: string; }

async function loadSamples() {
  try {
    const res = await fetch('samples/manifest.json');
    if (!res.ok) throw new Error(String(res.status));
    const manifest: SampleInfo[] = await res.json();
    for (const s of manifest) {
      const opt = document.createElement('option');
      opt.value = s.file;
      opt.textContent = s.name;
      sampleSelect.appendChild(opt);
    }
    if (manifest.length > 0) {
      sampleSelect.value = manifest[0].file;
      await loadSample(manifest[0].file);
    }
  } catch {
    showError('Could not load the sample list (samples/manifest.json). ' +
      'Open a JSON file instead, or paste one into the editor.');
  } finally {
    await initializeForm();
  }
}

async function loadSample(file: string) {
  try {
    const res = await fetch(`samples/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    setCatalog(JSON.parse(text) as Catalog, { reframe: true, reset: true });
  } catch (e) {
    showError(`Could not load sample '${file}': ${(e as Error).message}`);
  }
}

sampleSelect.addEventListener('change', () => {
  if (sampleSelect.value) void loadSample(sampleSelect.value);
});

// ------------------------------------------------------------- local file

openFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  const text = await f.text();
  sampleSelect.value = '';
  fileInput.value = '';
  try {
    setCatalog(JSON.parse(text) as Catalog, { reframe: true, reset: true });
  } catch (e) {
    // Keep the unparseable text in the JSON tab so it can be fixed by hand.
    editor.value = text;
    showError(`JSON parse error: ${(e as Error).message}`);
  }
});

// ---------------------------------------------------------------- actions

buildBtn.addEventListener('click', () => {
  if (form.activeTab === 'json' && !applyEditorText()) return;
  build(true);
});

// Typing in the JSON tab flows back into the form, once the text parses.
const scheduleEditorApply = debounce(() => applyEditorText(), 400);
editor.addEventListener('input', () => scheduleEditorApply());
editor.addEventListener('blur', () => syncEditor());
editor.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (applyEditorText()) build(true);
  }
});

modeSelect.addEventListener('change', () => {
  const mode = {
    solid: RenderMode.Solid,
    edges: RenderMode.SolidWithEdges,
    wireframe: RenderMode.Wireframe,
  }[modeSelect.value] ?? RenderMode.SolidWithEdges;
  viewer.setRenderMode(mode);
});

frameBtn.addEventListener('click', () => viewer.frameAll());

exportStlBtn.addEventListener('click', () => {
  const meshes = visibleMeshes();
  if (meshes.length === 0) {
    showError('Nothing visible to export — turn on at least one part.');
    return;
  }
  const entry = currentEntry() as Record<string, unknown> | null;
  const name = String(entry?.['name'] ?? 'keyboard');
  downloadSTL(mergeMeshes(meshes), `${name}.stl`);
});

exportJsonBtn.addEventListener('click', () => {
  if (catalog === null) {
    showError('Nothing to export yet.');
    return;
  }
  const entry = currentEntry() as Record<string, unknown> | null;
  downloadJSON(catalog, String(entry?.['name'] ?? 'keyboard'));
});

// ------------------------------------------------------------------- boot

form.refresh();
void loadSamples();
