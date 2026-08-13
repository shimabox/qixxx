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
import { TICK_RATE } from '../config';

/**
 * Slider ranges per docs/plan.md §12.4's "調整項目（初期セット）" list.
 * wispCount/wispSpeedMultiplier/emberCount's upper bounds were widened
 * (2026-07-07 feedback, docs/plan.md §6 M11 orchestration follow-up) so the
 * panel can push well past normal per-stage values for stress-testing —
 * core (Game.setWispCount/setEmberCount) only ever floors at 0, it has no
 * upper clamp of its own, so these panel-side maxes are the only limit.
 *
 * wispCount/wispSpeedMultiplier/emberCount/requiredOccupancyPercent's upper
 * bounds were widened again to 3x their stage-10 (STAGE_MAX_DIFFICULTY)
 * values (2026-07-11 feedback: wispCount 10->30, wispSpeedMultiplier
 * 5.0->15.0, emberCount 10->30, requiredOccupancyPercent 90->99 — 99 rather
 * than a literal 3x270 since occupancy is a percentage and 100% is the
 * logical ceiling). The other fields (emberMoveTicks, emberSpawnIntervalSec,
 * emberBranchChaseProbability) are left as-is: they're already at or past
 * their logical ceiling (1 tick/cell is the fastest possible move rate, 0-1
 * is branch-chase probability's full range) so widening them further has no
 * effect. Pushing wispSpeedMultiplier this high requires Wisp.tryStep
 * (src/core/enemy.ts) to sweep-check the whole move segment rather than
 * just the destination cell, or a fast Wisp could tunnel clean through a
 * one-cell-wide BORDER/CLAIMED wall in a single tick — see that method's
 * doc comment.
 */
const RANGES = {
  wispCount: { min: 0, max: 30, step: 1 },
  wispSpeedMultiplier: { min: 0.25, max: 15.0, step: 0.05 },
  emberCount: { min: 0, max: 30, step: 1 },
  emberMoveTicks: { min: 1, max: 10, step: 1 },
  emberSpawnIntervalSec: { min: 1, max: 60, step: 1 },
  emberBranchChaseProbability: { min: 0, max: 1, step: 0.05 },
  requiredOccupancyPercent: { min: 10, max: 99, step: 1 },
  // Time limit (docs/plans/2026-08-13-time-limit-mode), in seconds: mainly
  // for pulling the run's time budget way down (e.g. 5s) so a tester can
  // reach TIME UP! without waiting out the real 300s (5min) default — the
  // upper end (10min) is there for symmetry/tuning but isn't the primary
  // use case. 5s step keeps the slider's range of motion manageable at
  // either end.
  timeLimitSec: { min: 5, max: 600, step: 5 },
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
 *
 * `timeLimitTicks` (docs/plans/2026-08-13-time-limit-mode P3 review fix) is
 * threaded in as its own parameter, separately from `params`
 * (EffectiveDebugParams) — the run's time budget is a GameSession-level
 * concern (GameSession.getTimeLimitTicks()), not one of Game's own
 * EffectiveDebugParams, exactly like the time-limit slider itself (see
 * buildPanel()'s `timeLimit` row) — but it still needs to end up in this
 * same EXPORT payload, under the exact `TIME_LIMIT_TICKS` name, so the
 * existing EXPORT-JSON -> config.ts tuning workflow picks it up like every
 * other slider here.
 */
function buildExportPayload(params: EffectiveDebugParams, timeLimitTicks: number): Record<string, unknown> {
  return {
    WISP_COUNT: params.wispCount,
    WISP_SPEED_MULTIPLIER: params.wispSpeedMultiplier,
    EMBER_COUNT: params.emberCount,
    EMBER_MOVE_TICKS: params.emberMoveTicks,
    EMBER_SPAWN_INTERVAL_SEC: params.emberSpawnIntervalSec,
    EMBER_BRANCH_CHASE_PROBABILITY: params.emberBranchChaseProbability,
    DEFAULT_REQUIRED_OCCUPANCY: params.requiredOccupancy,
    TIME_LIMIT_TICKS: timeLimitTicks,
    _notes: {
      WISP_COUNT:
        'Number of Wisps this stage. config.ts has no single constant for this — docs/plan.md §12.7 defines it as the stage number itself (stage n = n Wisps), capped at STAGE_MAX_DIFFICULTY.',
      WISP_SPEED_MULTIPLIER:
        'Effective multiplier on WISP_SPEED for the current stage. config.ts has no single constant for this — docs/plan.md §12.7 linearly interpolates it from 1.0 (stage 1) to WISP_SPEED_MULTIPLIER_MAX (stage STAGE_MAX_DIFFICULTY).',
      EMBER_COUNT:
        'Current live Ember count. Embers spawn dynamically in pairs (see EMBER_SPAWN_INTERVAL_SEC), capped by the stage-dependent maxConcurrentEmbers (docs/plan.md §12.7: EMBER_MAX_CONCURRENT_STAGE1 at stage 1 up to EMBER_MAX_CONCURRENT_MAX at stage STAGE_MAX_DIFFICULTY) rather than a fixed config constant.',
      DEFAULT_REQUIRED_OCCUPANCY:
        'Effective required occupancy for the current stage. config.ts has no single constant for this — docs/plan.md §12.7 linearly interpolates it from DEFAULT_REQUIRED_OCCUPANCY (stage 1) up to REQUIRED_OCCUPANCY_MAX (stage STAGE_MAX_DIFFICULTY).',
      TIME_LIMIT_TICKS:
        "The run's current effective time budget, in ticks (60 tick = 1s at TICK_RATE) — matches config.ts's TIME_LIMIT_TICKS constant exactly (name and unit), unlike this payload's other stage-dependent keys. Reflects the time-limit slider above, whether or not it's been touched from its config.ts default.",
    },
  };
}

/**
 * Handle returned by initDebugPanel() for a caller to re-sync the panel's
 * sliders if it ever swaps the `GameSession` instance the `getSession`
 * getter passed to initDebugPanel() resolves to (P2 user-review fix,
 * 2026-08-11 — see initDebugPanel()'s doc comment for the full rationale).
 * No current caller does this (main.ts builds `session` once in init() and
 * never reconstructs it), so `refresh` currently goes unused, but the hook
 * stays correct for free if session-swapping is ever reintroduced.
 */
export interface DebugPanelHandle {
  /**
   * Re-syncs every slider's displayed value (and readout text) from
   * whatever `getSession()` currently returns. Would need to be called
   * right after a caller swaps the session `getSession()` resolves to, for
   * a new GameSession instance — the panel's own slider *actions* already
   * always affect whatever `getSession()` currently returns (see
   * initDebugPanel()'s doc comment), but the displayed positions would
   * otherwise still show the previous session's last values until the
   * player touches a slider again. Currently unused, since no caller swaps
   * sessions today.
   */
  refresh: () => void;
}

/**
 * Mounts the debug panel into the page: a "DEBUG" badge/toggle in the HUD
 * row (docs/plan.md §6 M10: "パネル表示中は HUD などに「DEBUG」表示を出す")
 * and a floating, collapsible control panel with one slider per tunable,
 * plus RESET/EXPORT.
 *
 * Takes a `getSession` *getter*, not a `GameSession` instance directly (P2
 * user-review fix, 2026-08-11). At the time, main.ts could swap its own
 * `session` module variable out for a brand-new GameSession mid-page-load
 * (the since-removed DAILY-challenge feature's Title button, plus `?seed=`
 * / falling back to a fresh normal run — see commit 58f2f3a, which dropped
 * that swapping machinery entirely). A plain `session: GameSession`
 * parameter here would have closed over whichever instance existed at
 * `?debug` load time and kept operating on it forever — every slider drag
 * after a swap would silently apply to (and read
 * `hasActiveDebugOverrides()` from) a discarded session, never reaching the
 * real, currently-playing one, and — because the *real* session's
 * `hasActiveDebugOverrides()` would then always read false — never
 * suppressing high-score persistence the way active overrides are supposed
 * to. Calling `getSession()` fresh every time instead means every panel
 * action always targets whatever session is actually live right now.
 *
 * That session-swapping no longer happens today — main.ts now constructs
 * `session` exactly once in init() and never reconstructs it — so the
 * getter is currently equivalent to a plain captured reference. It's kept
 * as a getter anyway since it's harmless either way and stays correct for
 * free should session-swapping ever be reintroduced.
 */
export function initDebugPanel(getSession: () => GameSession, hudRow: HTMLElement): DebugPanelHandle {
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
  const { panel, sync } = buildPanel(getSession, () => setOpen(false));
  hudRow.appendChild(badge);
  document.body.appendChild(panel);
  setOpen(true);

  // Position tracking (P3 review fix, docs/plans/2026-08-13-time-limit-mode:
  // user-measured overlap at both 1280x720 and 880x700 — panel top 36-39px
  // vs. the actual HUD row bottom at 54px). The panel used to be positioned
  // once, synchronously, right here — using hudRow's rect from *before* the
  // badge above was even appended to it (which can itself grow hudRow, e.g.
  // by pushing a borderline single-line HUD into stacked/3-line mode) and
  // before main.ts's own post-mount fitCanvasToViewport() re-run (see
  // main.ts's init(), right after this function's caller) had a chance to
  // relay it out again. A ResizeObserver on hudRow — firing only when its
  // box actually changes, never every frame — keeps `panel.style.top` (and
  // its `maxHeight`, which depends on the same value) correct through that
  // followup layout pass and through every later resize/orientationchange or
  // single/stacked HUD mode flip, without polling.
  const repositionPanel = (): void => {
    const top = hudRow.getBoundingClientRect().bottom + 8;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `calc(100vh - ${top + 8}px)`;
  };
  repositionPanel(); // best-effort immediate placement — the observer below catches any layout pass this misses
  new ResizeObserver(repositionPanel).observe(hudRow);

  return { refresh: sync };
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

function buildPanel(
  getSession: () => GameSession,
  onClose: () => void
): { panel: HTMLDivElement; sync: () => void } {
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.style.position = 'fixed';
  // `top`/`maxHeight` are deliberately left unset here — they depend on
  // hudRow's on-screen bottom edge, which isn't stable yet at build time
  // (docs/plans/2026-08-13-time-limit-mode P3 review fix); initDebugPanel()
  // sets both, and keeps them in sync afterward, via its repositionPanel().
  panel.style.right = '8px';
  panel.style.zIndex = '1000';
  panel.style.width = '260px';
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

  // Reads from `getSession()` fresh every call (not a captured `session`)
  // so a session swap would be picked up automatically if one were ever
  // reintroduced — see initDebugPanel()'s doc comment. Exported as this
  // panel's `sync` (DebugPanelHandle.refresh(), currently unused since no
  // caller swaps sessions today — see that interface's doc comment), for a
  // future caller to invoke right after swapping sessions so the sliders'
  // *displayed* values would catch up to the new session's own (fresh,
  // override-free) defaults immediately, rather than silently showing the
  // discarded session's last values until the player happens to touch a
  // slider again.
  const syncFromEffectiveParams = (): void => {
    const params = getSession().getEffectiveDebugParams();
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
      getSession().applyDebugOverrides({
        [field.overrideKey]: field.fromSlider(sliderValue),
      } as Partial<DebugOverrides>);
      readout.textContent = field.format(field.fromSlider(sliderValue));
    });
    rows.set(field.key, { input, readout });
    panel.appendChild(row);
  }

  // Time limit (docs/plans/2026-08-13-time-limit-mode): a session-level
  // concern (GameSession.setDebugTimeLimitTicks()), not one of Game's own
  // EffectiveDebugParams — kept out of the FIELDS/rows machinery above
  // (which is keyed off EffectiveDebugParams) and wired up directly instead.
  // Displayed/entered in whole seconds; converted to/from ticks (TICK_RATE)
  // at the boundary.
  const timeLimit = buildRawSliderRow(
    'Time limit (s)',
    RANGES.timeLimitSec,
    (v) => `${v}s`,
    (sliderValueSec) => {
      getSession().setDebugTimeLimitTicks(sliderValueSec * TICK_RATE);
      timeLimit.readout.textContent = `${sliderValueSec}s`;
    }
  );
  // Stable id (docs/plans/2026-08-13-time-limit-mode) so E2E coverage can
  // locate this specific slider directly — the other FIELDS-driven sliders
  // above have no id of their own (nothing has previously needed to target
  // one individually), but this one's the E2E suite's fastest real-time path
  // to a TIME UP! gameover (shrinking the budget down from its 5s minimum).
  timeLimit.input.id = 'debug-time-limit-input';
  panel.appendChild(timeLimit.row);

  const syncTimeLimitRow = (): void => {
    const seconds = Math.round(getSession().getTimeLimitTicks() / TICK_RATE);
    timeLimit.input.value = String(seconds);
    timeLimit.readout.textContent = `${seconds}s`;
  };

  const syncAll = (): void => {
    syncFromEffectiveParams();
    syncTimeLimitRow();
  };

  syncAll();

  const buttonRow = document.createElement('div');
  buttonRow.style.display = 'flex';
  buttonRow.style.gap = '6px';
  buttonRow.style.marginTop = '8px';

  const resetButton = buildButton('RESET', () => {
    getSession().resetDebugOverrides();
    syncAll();
    exportOutput.value = '';
  });
  const exportButton = buildButton('EXPORT', () => {
    const session = getSession();
    const payload = buildExportPayload(session.getEffectiveDebugParams(), session.getTimeLimitTicks());
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

  return { panel, sync: syncAll };
}

function buildSliderRow(
  field: SliderField,
  onChange: (sliderValue: number) => void
): { row: HTMLDivElement; input: HTMLInputElement; readout: HTMLSpanElement } {
  return buildRawSliderRow(field.label, field.range, (v) => field.format(field.fromSlider(v)), onChange);
}

/**
 * Lower-level slider-row builder underlying buildSliderRow() above, taking a
 * plain label/range/format instead of a `SliderField` — used directly by the
 * time-limit slider (docs/plans/2026-08-13-time-limit-mode), which has no
 * `EffectiveDebugParams` key to key a `SliderField` off (it's a session-level
 * concern, see buildPanel()'s `timeLimit` row).
 */
function buildRawSliderRow(
  label: string,
  range: { min: number; max: number; step: number },
  format: (sliderValue: number) => string,
  onChange: (sliderValue: number) => void
): { row: HTMLDivElement; input: HTMLInputElement; readout: HTMLSpanElement } {
  const row = document.createElement('div');
  row.style.marginBottom = '6px';

  const labelRow = document.createElement('div');
  labelRow.style.display = 'flex';
  labelRow.style.justifyContent = 'space-between';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const readout = document.createElement('span');
  readout.style.color = '#00ff41';
  labelRow.appendChild(labelEl);
  labelRow.appendChild(readout);
  row.appendChild(labelRow);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.style.width = '100%';
  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = format(value);
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
