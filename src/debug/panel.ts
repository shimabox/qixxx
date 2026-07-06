// Dev-only debug tuning panel (docs/plan.md §6 M10 / §12.4). Loaded via a
// dynamic `import()` gated by `import.meta.env.DEV && ?debug` in main.ts, so
// Vite tree-shakes this entire module (and everything it imports that isn't
// already pulled in elsewhere) out of production builds — nothing in here
// ever ships to players. It's the one place in the codebase allowed to sit
// between DOM and `src/core/`: it only ever talks to GameSession's plain
// data-in/data-out debug API (applyDebugOverrides/resetDebugOverrides/
// getEffectiveDebugParams), so `src/core/` itself stays exactly as DOM-free
// as it was before M10.
import { GameSession } from '../core/session';
import type { DebugOverrides, EffectiveDebugParams } from '../core/game';

/**
 * Slider ranges per docs/plan.md §12.4's "調整項目（初期セット）" list.
 * wispCount/wispSpeedMultiplier/emberCount's upper bounds were widened
 * (2026-07-07 feedback, docs/plan.md §6 M11 orchestration follow-up) so the
 * panel can push well past normal per-stage values for stress-testing —
 * core (Game.setWispCount/setEmberCount) only ever floors at 0, it has no
 * upper clamp of its own, so these panel-side maxes are the only limit.
 */
const RANGES = {
  wispCount: { min: 0, max: 10, step: 1 },
  wispSpeedMultiplier: { min: 0.25, max: 5.0, step: 0.05 },
  emberCount: { min: 0, max: 10, step: 1 },
  emberMoveTicks: { min: 1, max: 10, step: 1 },
  emberSpawnIntervalSec: { min: 1, max: 60, step: 1 },
  emberBranchChaseProbability: { min: 0, max: 1, step: 0.05 },
  requiredOccupancyPercent: { min: 10, max: 90, step: 1 },
} as const;

interface SliderField {
  key: keyof EffectiveDebugParams;
  label: string;
  range: { min: number; max: number; step: number };
  /** Converts the effective param value (game units) to the slider's own displayed/stepped units. */
  toSlider: (value: number) => number;
  /** Converts a slider value back into the game-unit value passed to applyDebugOverrides. */
  fromSlider: (value: number) => number;
  /** Overrides object key this field writes to (differs from `key` only for requiredOccupancy's %-vs-fraction split). */
  overrideKey: keyof DebugOverrides;
  format: (value: number) => string;
}

const FIELDS: SliderField[] = [
  {
    key: 'wispCount',
    overrideKey: 'wispCount',
    label: 'Wisp count',
    range: RANGES.wispCount,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => String(v),
  },
  {
    key: 'wispSpeedMultiplier',
    overrideKey: 'wispSpeedMultiplier',
    label: 'Wisp speed x',
    range: RANGES.wispSpeedMultiplier,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'emberCount',
    overrideKey: 'emberCount',
    label: 'Ember count',
    range: RANGES.emberCount,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => String(v),
  },
  {
    key: 'emberMoveTicks',
    overrideKey: 'emberMoveTicks',
    label: 'Ember move ticks',
    range: RANGES.emberMoveTicks,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => String(v),
  },
  {
    key: 'emberSpawnIntervalSec',
    overrideKey: 'emberSpawnIntervalSec',
    label: 'Ember spawn interval (s)',
    range: RANGES.emberSpawnIntervalSec,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => `${v}s`,
  },
  {
    key: 'emberBranchChaseProbability',
    overrideKey: 'emberBranchChaseProbability',
    label: 'Branch-chase probability',
    range: RANGES.emberBranchChaseProbability,
    toSlider: (v) => v,
    fromSlider: (v) => v,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'requiredOccupancy',
    overrideKey: 'requiredOccupancy',
    label: 'Required occupancy',
    range: RANGES.requiredOccupancyPercent,
    toSlider: (v) => Math.round(v * 100),
    fromSlider: (v) => v / 100,
    format: (v) => `${Math.round(v * 100)}%`,
  },
];

/**
 * config.ts constant names the EXPORT JSON keys map to (docs/plan.md §6 M10
 * / §12.4: "JSON のキーは config.ts の定数名と一致させる"). Fields with no
 * single 1:1 config constant (stage-dependent counts, dynamic Ember count)
 * use the closest/most-descriptive name plus a `_notes` explanation instead,
 * exactly as the plan permits ("対応する config 定数名か注記付きキー").
 */
function buildExportPayload(params: EffectiveDebugParams): Record<string, unknown> {
  return {
    WISP_COUNT: params.wispCount,
    WISP_SPEED_MULTIPLIER: params.wispSpeedMultiplier,
    EMBER_COUNT: params.emberCount,
    EMBER_MOVE_TICKS: params.emberMoveTicks,
    EMBER_SPAWN_INTERVAL_SEC: params.emberSpawnIntervalSec,
    EMBER_BRANCH_CHASE_PROBABILITY: params.emberBranchChaseProbability,
    DEFAULT_REQUIRED_OCCUPANCY: params.requiredOccupancy,
    _notes: {
      WISP_COUNT:
        'Number of Wisps this stage. config.ts has no single constant for this — stage 1-2 always spawn 1; stage 3+ uses STAGE3_WISP_COUNT.',
      WISP_SPEED_MULTIPLIER:
        'Effective multiplier on WISP_SPEED for the current stage. Nearest config constants: STAGE2_WISP_SPEED_MULTIPLIER (stage 2) / STAGE3_WISP_SPEED_MULTIPLIER_BASE + WISP_SPEED_MULTIPLIER_STEP (stage 3+), capped at WISP_SPEED_MULTIPLIER_MAX.',
      EMBER_COUNT:
        'Current live Ember count. Embers spawn dynamically in pairs (see EMBER_SPAWN_INTERVAL_SEC) rather than from a fixed config constant.',
      DEFAULT_REQUIRED_OCCUPANCY:
        'Effective required occupancy for the current stage. config.ts applies this value to stage 1-2; stage 3+ escalates it via REQUIRED_OCCUPANCY_STEP up to REQUIRED_OCCUPANCY_MAX.',
    },
  };
}

/**
 * Mounts the debug panel into the page: a "DEBUG" badge/toggle in the HUD
 * row (docs/plan.md §6 M10: "パネル表示中は HUD などに「DEBUG」表示を出す")
 * and a floating, collapsible control panel with one slider per tunable,
 * plus RESET/EXPORT.
 */
export function initDebugPanel(session: GameSession, hudRow: HTMLElement): void {
  // Positioned below the HUD row (rather than a fixed pixel guess) so the
  // floating panel never covers the "DEBUG" badge or the MUTE button that
  // also live in the HUD row, regardless of how tall it renders at a given
  // viewport width (docs/plan.md's HUD row height is itself responsive,
  // see main.ts's fitCanvasToViewport()).
  const panelTop = hudRow.getBoundingClientRect().bottom + 8;

  // Collapsible (2026-07-07 feedback: the panel sat on top of the field and
  // got in the way of actually playing). The badge itself doubles as the
  // open/close toggle — one click re-opens a collapsed panel just as easily
  // as it collapses an open one — and the panel also gets its own "x" for
  // closing without reaching back up for the (smaller) badge. Purely a
  // display toggle: collapsing never touches applyDebugOverrides/
  // resetDebugOverrides, so whatever overrides are already active keep
  // affecting the game while the panel is hidden. Open/closed state is
  // in-memory only (no product need for it to survive a reload) and always
  // starts open.
  let isOpen = true;
  const setOpen = (open: boolean): void => {
    isOpen = open;
    panel.style.display = isOpen ? 'block' : 'none';
    badge.textContent = `DEBUG ${isOpen ? '▾' : '▸'}`; // open / closed caret
  };

  const badge = buildDebugBadge(() => setOpen(!isOpen));
  const panel = buildPanel(session, panelTop, () => setOpen(false));
  hudRow.appendChild(badge);
  document.body.appendChild(panel);
  setOpen(true);
}

function buildDebugBadge(onToggle: () => void): HTMLButtonElement {
  const badge = document.createElement('button');
  badge.id = 'debug-badge';
  badge.type = 'button';
  badge.title = 'Toggle the debug panel';
  badge.style.flex = '0 0 auto';
  badge.style.font = 'bold 11px monospace';
  badge.style.color = '#0a0e27';
  badge.style.background = '#ffe066';
  badge.style.border = 'none';
  badge.style.padding = '2px 6px';
  badge.style.borderRadius = '3px';
  badge.style.pointerEvents = 'auto';
  badge.style.cursor = 'pointer';
  badge.style.userSelect = 'none';
  badge.addEventListener('click', onToggle);
  return badge;
}

function buildPanel(session: GameSession, top: number, onClose: () => void): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.style.position = 'fixed';
  panel.style.top = `${top}px`;
  panel.style.right = '8px';
  panel.style.zIndex = '1000';
  panel.style.width = '260px';
  panel.style.maxHeight = `calc(100vh - ${top + 8}px)`;
  panel.style.overflowY = 'auto';
  panel.style.background = 'rgba(10, 14, 39, 0.92)';
  panel.style.border = '1px solid #ffe066';
  panel.style.borderRadius = '6px';
  panel.style.padding = '10px';
  panel.style.font = '11px monospace';
  panel.style.color = '#ffffff';
  panel.style.pointerEvents = 'auto';
  panel.style.userSelect = 'none';

  const titleRow = document.createElement('div');
  titleRow.style.display = 'flex';
  titleRow.style.alignItems = 'center';
  titleRow.style.justifyContent = 'space-between';
  titleRow.style.marginBottom = '8px';

  const title = document.createElement('span');
  title.textContent = 'DEBUG PANEL (dev only)';
  title.style.fontWeight = 'bold';
  title.style.color = '#ffe066';
  titleRow.appendChild(title);

  // Closes the panel without touching any override (docs/plan.md §6 M11
  // orchestration follow-up: "閉じてもオーバーライドの効果は維持される") —
  // re-opening is one click on the HUD badge (see initDebugPanel).
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.title = 'Close (overrides stay active)';
  closeButton.style.flex = '0 0 auto';
  closeButton.style.font = 'bold 13px monospace';
  closeButton.style.color = '#ffe066';
  closeButton.style.background = 'transparent';
  closeButton.style.border = 'none';
  closeButton.style.cursor = 'pointer';
  closeButton.style.lineHeight = '1';
  closeButton.style.padding = '0 2px';
  closeButton.addEventListener('click', onClose);
  titleRow.appendChild(closeButton);

  panel.appendChild(titleRow);

  const rows = new Map<keyof EffectiveDebugParams, { input: HTMLInputElement; readout: HTMLSpanElement }>();

  const syncFromEffectiveParams = (): void => {
    const params = session.getEffectiveDebugParams();
    for (const field of FIELDS) {
      const row = rows.get(field.key);
      if (!row) continue;
      const sliderValue = field.toSlider(params[field.key]);
      row.input.value = String(sliderValue);
      row.readout.textContent = field.format(params[field.key]);
    }
  };

  for (const field of FIELDS) {
    const { row, input, readout } = buildSliderRow(field, (sliderValue) => {
      session.applyDebugOverrides({ [field.overrideKey]: field.fromSlider(sliderValue) } as Partial<DebugOverrides>);
      readout.textContent = field.format(field.fromSlider(sliderValue));
    });
    rows.set(field.key, { input, readout });
    panel.appendChild(row);
  }

  syncFromEffectiveParams();

  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '6px';
  buttonRow.style.marginTop = '8px';

  const resetButton = buildButton('RESET', () => {
    session.resetDebugOverrides();
    syncFromEffectiveParams();
    exportOutput.value = '';
  });
  const exportButton = buildButton('EXPORT', () => {
    const payload = buildExportPayload(session.getEffectiveDebugParams());
    const json = JSON.stringify(payload, null, 2);
    exportOutput.value = json;
    void copyToClipboard(json);
  });
  buttonRow.appendChild(resetButton);
  buttonRow.appendChild(exportButton);
  panel.appendChild(buttonRow);

  const exportOutput = document.createElement('textarea');
  exportOutput.id = 'debug-export-output';
  exportOutput.readOnly = true;
  exportOutput.placeholder = 'EXPORT JSON appears here (also copied to clipboard)';
  exportOutput.style.width = '100%';
  exportOutput.style.marginTop = '8px';
  exportOutput.style.height = '160px';
  exportOutput.style.background = 'rgba(0, 0, 0, 0.5)';
  exportOutput.style.color = '#00ff41';
  exportOutput.style.border = '1px solid rgba(255, 255, 255, 0.2)';
  exportOutput.style.font = '10px monospace';
  exportOutput.style.boxSizing = 'border-box';
  exportOutput.style.resize = 'vertical';
  panel.appendChild(exportOutput);

  return panel;
}

function buildSliderRow(
  field: SliderField,
  onChange: (sliderValue: number) => void
): { row: HTMLDivElement; input: HTMLInputElement; readout: HTMLSpanElement } {
  const row = document.createElement('div');
  row.style.marginBottom = '6px';

  const labelRow = document.createElement('div');
  labelRow.style.display = 'flex';
  labelRow.style.justifyContent = 'space-between';
  const label = document.createElement('span');
  label.textContent = field.label;
  const readout = document.createElement('span');
  readout.style.color = '#00ff41';
  labelRow.appendChild(label);
  labelRow.appendChild(readout);
  row.appendChild(labelRow);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(field.range.min);
  input.max = String(field.range.max);
  input.step = String(field.range.step);
  input.style.width = '100%';
  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = field.format(field.fromSlider(value));
    onChange(value);
  });
  row.appendChild(input);

  return { row, input, readout };
}

function buildButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.style.flex = '1 1 auto';
  button.style.font = 'bold 11px monospace';
  button.style.color = '#ffe066';
  button.style.background = 'rgba(10, 14, 39, 0.7)';
  button.style.border = '1px solid #ffe066';
  button.style.borderRadius = '4px';
  button.style.padding = '4px 6px';
  button.style.cursor = 'pointer';
  button.addEventListener('click', onClick);
  return button;
}

/** Best-effort clipboard copy — silently no-ops if the Clipboard API is unavailable (e.g. insecure context). */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort only — the JSON is still visible in the textarea for manual copy.
  }
}
