/**
 * Declarative description of the keyboard-definition JSON, used to build the
 * form GUI. Every field here maps to one key in a board entry; `def` is the
 * value the core assumes when the key is absent, so a blank control means
 * "leave it out of the JSON".
 */

export type FieldType = 'number' | 'text' | 'bool' | 'select' | 'expr';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  /** Value the generator uses when the key is absent (shown as placeholder). */
  def?: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  /** Render a slider next to the number box (needs min/max). */
  slider?: boolean;
  options?: { value: string; label: string }[];
  unit?: string;
  hint?: string;
}

export interface Group {
  title: string;
  note?: string;
  fields: Field[];
}

// --------------------------------------------------------------- board tab

export const BOARD_GROUPS: Group[] = [
  {
    title: 'Identity',
    fields: [
      { key: 'name', label: 'Name', type: 'text', def: 'default',
        hint: 'Used for the STL filename and by assembly items.' },
    ],
  },
  {
    title: 'Grid',
    note: 'The key matrix before ignored cells are removed.',
    fields: [
      { key: 'width', label: 'Columns', type: 'number', def: 6, min: 1, max: 40, step: 1 },
      { key: 'height', label: 'Rows', type: 'number', def: 4, min: 1, max: 40, step: 1 },
    ],
  },
  {
    title: 'Switch plate',
    fields: [
      { key: 'key_1u', label: '1u pitch', type: 'number', def: 19.05, step: 0.05, unit: 'mm' },
      { key: 'hole_size', label: 'Switch hole', type: 'number', def: 14.5, step: 0.1, unit: 'mm' },
      { key: 'thickness', label: 'Plate thickness', type: 'number', def: 5, step: 0.1, unit: 'mm' },
      { key: 'switch_border', label: 'Switch border', type: 'number', def: 1.5, step: 0.1, unit: 'mm',
        hint: 'Minimum material around the cutout; sets the smallest cell.' },
    ],
  },
  {
    title: 'Tilt',
    note: 'Applied to the finished plate before the walls are grown.',
    fields: [
      { key: 'tent_angle', label: 'Tent', type: 'number', def: 0, min: -45, max: 45, step: 0.5,
        slider: true, unit: '°' },
      { key: 'pitch_angle', label: 'Pitch', type: 'number', def: 0, min: -45, max: 45, step: 0.5,
        slider: true, unit: '°' },
    ],
  },
];

// -------------------------------------------------------------- layout tab

export const ALGO_FIELDS: Field[] = [
  { key: 'x_algo', label: 'x', type: 'expr', def: 'x*key_1u' },
  { key: 'y_algo', label: 'y', type: 'expr', def: '-y*key_1u' },
  { key: 'z_algo', label: 'z', type: 'expr', def: '10' },
  { key: 'x_rot_algo', label: 'rot x', type: 'expr', def: '0' },
  { key: 'y_rot_algo', label: 'rot y', type: 'expr', def: '0' },
  { key: 'z_rot_algo', label: 'rot z', type: 'expr', def: '0' },
];

// ---------------------------------------------------------------- case tab

export const SKIRT_GROUPS: Group[] = [
  {
    title: 'Wall style',
    note: 'Skirt is a unibody case; frame is a separate surround the plate ' +
      'drops into; lip rests the plate in a rebated pocket in a plank.',
    fields: [
      { key: 'wall_style', label: 'Style', type: 'select', def: 'skirt',
        options: [
          { value: 'skirt', label: 'fused skirt' },
          { value: 'frame', label: 'wall frame' },
          { value: 'lip', label: 'lip in a plank' },
        ],
        hint: 'Left unset, the old Skirt checkbox below still decides.' },
    ],
  },
  {
    title: 'Fused skirt',
    note: 'Skirt on builds a unibody case: the plate carries its own walls ' +
      'and gets a matching baseplate.',
    fields: [
      { key: 'skirt', label: 'Skirt (unibody case)', type: 'bool', def: false },
      { key: 'wall_thickness', label: 'Wall thickness', type: 'number', def: 2, step: 0.1, unit: 'mm' },
      { key: 'skirt_flange', label: 'Skirt flange', type: 'number', def: 0, step: 0.1, unit: 'mm',
        hint: 'Flat lip at the bottom of the skirt, where it meets the baseplate.' },
      { key: 'constant_thickness_walls', label: 'Constant-thickness walls', type: 'bool', def: false,
        hint: 'Erode a parallel inner wall instead of one sloped inner panel.' },
    ],
  },
  {
    title: 'Skirt profile',
    note: 'Angle mode uses one straight flare; flare mode pushes straight out. ' +
      'A stepped profile below overrides both.',
    fields: [
      { key: 'skirt_mode', label: 'Mode', type: 'select', def: 'angle',
        options: [{ value: 'angle', label: 'angle' }, { value: 'flare', label: 'flare' }] },
      { key: 'skirt_angle', label: 'Skirt angle', type: 'number', def: 0, min: -60, max: 60,
        step: 0.5, slider: true, unit: '°' },
      { key: 'skirt_flare', label: 'Skirt flare', type: 'number', def: 0, step: 0.1, unit: 'mm' },
    ],
  },
  {
    title: 'Base',
    fields: [
      { key: 'wall_base_z', label: 'Wall base z', type: 'number', def: 0, step: 0.5, unit: 'mm',
        hint: 'Height the walls run down to — the build plate for a unibody case.' },
      { key: 'plate_min_wall', label: 'Min wall', type: 'number', def: 1, step: 0.1, unit: 'mm' },
    ],
  },
];

export const LIP_GROUPS: Group[] = [
  {
    title: 'Lip',
    note: 'The plate hangs from a lip whose top face is flush with the plank. ' +
      'The lip is pinned to an absolute height, so on a tilted plate the wall ' +
      'travels up to reach it at one end of the board and down at the other. ' +
      'The skirt profile shapes that run.',
    fields: [
      { key: 'lip_z', label: 'Lip z', type: 'number', def: 0, step: 0.5, unit: 'mm',
        hint: 'Height of the bearing face — the rebate shoulder it rests on.' },
      { key: 'lip_width', label: 'Lip width', type: 'number', def: 3, min: 0.1,
        step: 0.1, unit: 'mm', hint: 'How far the lip projects past the wall.' },
      { key: 'lip_thickness', label: 'Lip thickness', type: 'number', def: 2, min: 0.1,
        step: 0.1, unit: 'mm' },
      { key: 'pocket_clearance', label: 'Pocket clearance', type: 'number', def: 0.3,
        min: 0, step: 0.05, unit: 'mm',
        hint: 'Gap between the case and the routed pocket, all the way round.' },
    ],
  },
  {
    title: 'Plank',
    note: 'The board the recess is cut into. Its top face is the top of the ' +
      'lip, so the keyboard finishes flush with the wood; below the shoulder ' +
      'the hole goes right through.',
    fields: [
      { key: 'plank_thickness', label: 'Plank thickness', type: 'number', def: 18,
        min: 0.1, step: 0.5, unit: 'mm',
        hint: 'Must exceed the lip thickness, or there is no shoulder.' },
      { key: 'plank_margin', label: 'Plank margin', type: 'number', def: 20, step: 1,
        unit: 'mm', hint: 'Board overhang past the recess, when no size is set.' },
    ],
  },
];

export const FRAME_GROUPS: Group[] = [
  {
    title: 'Wall frame',
    note: 'Used when the skirt is off: the case is a separate frame the plate ' +
      'drops into.',
    fields: [
      { key: 'vertical_edges', label: 'Vertical edges', type: 'bool', def: true },
      { key: 'flange_offset', label: 'Flange offset', type: 'number', def: 0, step: 0.1, unit: 'mm' },
      { key: 'flange_z', label: 'Flange z', type: 'number', def: 0, step: 0.1, unit: 'mm' },
      { key: 'plate_lip', label: 'Plate lip', type: 'number', def: 1.5, step: 0.1, unit: 'mm' },
      { key: 'plate_gap', label: 'Plate gap', type: 'number', def: 0.25, step: 0.05, unit: 'mm',
        hint: 'Clearance between the plate edge and the frame.' },
    ],
  },
];

// ------------------------------------------------------------- inserts tab

export const INSERT_GROUPS: Group[] = [
  {
    title: 'Screw holes',
    note: 'Cut through the baseplate, coaxial with each boss. A hole is only ' +
      'cut where the whole circle lands inside the baseplate.',
    fields: [
      { key: 'insert_clearance_d', label: 'Clearance ⌀', type: 'number', def: 3, step: 0.1, unit: 'mm',
        hint: 'Default screw-hole diameter through the baseplate.' },
      { key: 'insert_hole_segments', label: 'Hole segments', type: 'number', def: 32, min: 6,
        max: 128, step: 1 },
    ],
  },
];

// ------------------------------------------------------- baseplate (case tab)

export const BASEPLATE_GROUPS: Group[] = [
  {
    title: 'Baseplate',
    note: 'A flat cover on the case footprint, extruded down from the wall ' +
      'base. It closes the fused skirt and the separate wall frame alike — ' +
      'set 0 for no baseplate.',
    fields: [
      { key: 'baseplate_thickness', label: 'Thickness', type: 'number', def: 2,
        min: 0, step: 0.1, unit: 'mm' },
    ],
  },
];

/** Per-insert columns, in the order they appear in a row. */
export const INSERT_FIELDS: Field[] = [
  { key: 'col', label: 'col', type: 'number', def: 0, step: 1 },
  { key: 'row', label: 'row', type: 'number', def: 0, step: 1 },
  { key: 'x', label: 'x', type: 'number', def: 0, step: 0.5, unit: 'mm' },
  { key: 'y', label: 'y', type: 'number', def: 0, step: 0.5, unit: 'mm' },
  { key: 'rot', label: 'rot', type: 'number', def: 0, step: 5, unit: '°' },
  { key: 'od', label: 'boss ⌀', type: 'number', def: 8, step: 0.1, unit: 'mm' },
  { key: 'id', label: 'insert ⌀', type: 'number', def: 4, step: 0.1, unit: 'mm' },
  { key: 'height', label: 'height', type: 'number', def: 4.2, step: 0.1, unit: 'mm' },
  { key: 'hole_x', label: 'hole x', type: 'number', def: 0, step: 0.5, unit: 'mm' },
  { key: 'hole_y', label: 'hole y', type: 'number', def: 0, step: 0.5, unit: 'mm' },
  { key: 'leg_0', label: 'leg 0', type: 'number', def: 5, step: 0.5, unit: 'mm' },
  { key: 'leg_1', label: 'leg 1', type: 'number', def: 7, step: 0.5, unit: 'mm' },
  { key: 'leg_2', label: 'leg 2', type: 'number', def: 5, step: 0.5, unit: 'mm' },
  { key: 'clearance_d', label: 'clear ⌀', type: 'number', def: 3, step: 0.1, unit: 'mm' },
];
