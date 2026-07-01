/**
 * Conflict / validation engine (P1-15).
 *
 * Pure, deterministic checks over a configured screen. Returns findings, each tagged with a stable
 * rule code and a severity:
 *   • 'error'          — blocks finalisation (a hard requirement is unmet)
 *   • 'warning'        — advisory; does not block
 *   • 'cannot_evaluate'— a rule needs data not yet entered (never a false error)
 *
 * Business rules win on conflict (defined precedence); callers decide gating from severity.
 */
export type Severity = 'error' | 'warning' | 'cannot_evaluate';

export interface ValidationFinding {
  rule: string;
  severity: Severity;
  message: string;
}

export interface ValidationInput {
  pixelPitchMm?: number | null;
  gobSelected?: boolean;
  /** 'indoor' | 'outdoor' | null */
  environment?: string | null;
  hasBrightnessSensor?: boolean;
  hasMultifunctionCard?: boolean;
  hasHighTempMediaplayer?: boolean;
  totalPixels?: number | null;
  controllerSelected?: boolean;
  controllerMaxPixels?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  frameMaxWidthMm?: number | null;
  frameMaxHeightMm?: number | null;
  /** 'landscape' | 'portrait' | null */
  orientation?: string | null;
  portraitSupported?: boolean;
  isVideoWall?: boolean;
}

const GOB_PITCH_THRESHOLD = 2.5;

export const validateScreen = (input: ValidationInput): ValidationFinding[] => {
  const findings: ValidationFinding[] = [];

  // ── GOB required for fine pitch (< 2.5mm) ──
  if (input.pixelPitchMm === null || input.pixelPitchMm === undefined) {
    findings.push({
      rule: 'GOB_PITCH',
      severity: 'cannot_evaluate',
      message: 'Pixel pitch not yet known — cannot check GOB requirement.',
    });
  } else if (input.pixelPitchMm < GOB_PITCH_THRESHOLD && !input.gobSelected) {
    findings.push({
      rule: 'GOB_REQUIRED',
      severity: 'error',
      message: `Pitch ${input.pixelPitchMm}mm is below ${GOB_PITCH_THRESHOLD}mm — GOB protective coating is required.`,
    });
  }

  // ── Outdoor LED dependencies ──
  if (input.environment === 'outdoor') {
    if (!input.hasBrightnessSensor) {
      findings.push({ rule: 'OUTDOOR_BRIGHTNESS_SENSOR', severity: 'error', message: 'Outdoor screens require a brightness (light) sensor.' });
    }
    if (!input.hasMultifunctionCard) {
      findings.push({ rule: 'OUTDOOR_MULTIFUNCTION_CARD', severity: 'error', message: 'Outdoor screens require a multifunction card.' });
    }
    if (!input.hasHighTempMediaplayer) {
      findings.push({ rule: 'OUTDOOR_HIGH_TEMP_PLAYER', severity: 'error', message: 'Outdoor screens require a high-temperature media player.' });
    }
  }

  // ── Controller vs pixel count ──
  if (input.totalPixels != null && input.controllerMaxPixels != null) {
    if (input.totalPixels > input.controllerMaxPixels) {
      findings.push({
        rule: 'CONTROLLER_PIXELS_EXCEEDED',
        severity: 'error',
        message: `Pixel count (${input.totalPixels}) exceeds controller capacity (${input.controllerMaxPixels}) — select a larger controller or multi-controller.`,
      });
    }
  } else if (input.totalPixels != null && input.controllerSelected === false) {
    findings.push({ rule: 'CONTROLLER_NOT_SELECTED', severity: 'warning', message: 'No controller selected for a screen with a known pixel count.' });
  }

  // ── Frame vs screen dimensions ──
  if (input.widthMm != null && input.frameMaxWidthMm != null && input.widthMm > input.frameMaxWidthMm) {
    findings.push({ rule: 'FRAME_WIDTH_EXCEEDED', severity: 'error', message: `Screen width ${input.widthMm}mm exceeds the frame's maximum ${input.frameMaxWidthMm}mm.` });
  }
  if (input.heightMm != null && input.frameMaxHeightMm != null && input.heightMm > input.frameMaxHeightMm) {
    findings.push({ rule: 'FRAME_HEIGHT_EXCEEDED', severity: 'error', message: `Screen height ${input.heightMm}mm exceeds the frame's maximum ${input.frameMaxHeightMm}mm.` });
  }

  // ── Portrait restriction ──
  if (input.orientation === 'portrait' && input.portraitSupported === false) {
    findings.push({ rule: 'PORTRAIT_NOT_SUPPORTED', severity: 'warning', message: 'Selected product is not recommended for portrait orientation.' });
  }

  // ── Video-wall dependency hint ──
  if (input.isVideoWall && input.environment === 'outdoor' && !input.hasMultifunctionCard) {
    findings.push({ rule: 'VIDEO_WALL_DEPS', severity: 'warning', message: 'Outdoor video wall typically needs multifunction cards across cabinets.' });
  }

  return findings;
};

/** True when no finding blocks finalisation. */
export const canFinalise = (findings: readonly ValidationFinding[]): boolean =>
  !findings.some((f) => f.severity === 'error');

// ─── LCD screen validation (X1) ───────────────────────────────────────────────
/**
 * One persisted LCD line — a subset of `quote_lcd_items`. Only the fields the deterministic rules
 * read are required; everything else is ignored.
 */
export interface LcdValidationItem {
  itemType: 'display' | 'mediaplayer' | 'bracket' | 'install' | 'labour' | 'location_fee' | 'warranty';
  displayId?: string | number | bigint | null;
  /** Snapshotted display model/description text (from `displayCatalog.model`) — drives the built-in-player check. */
  description?: string | null;
}

export interface LcdValidationInput {
  /** 'P' | 'L' | null — matches the persisted LCD orientation. */
  orientation?: string | null;
  items?: LcdValidationItem[];
}

/** Case-insensitive signals that a display has a built-in playback source (no separate mediaplayer needed). */
const BUILTIN_PLAYER_SIGNALS = ['chromecast', 'android', 'built-in', 'built in'];

const hasBuiltInPlayerSignal = (text: string): boolean => {
  const t = text.toLowerCase();
  return BUILTIN_PLAYER_SIGNALS.some((sig) => t.includes(sig));
};

/**
 * Deterministic conflict/validation rules for one persisted LCD screen. Same finding shape,
 * severities and `canFinalise` semantics as the LED engine — partial data never yields a false
 * error (uses `cannot_evaluate` when the needed input is absent).
 */
export const validateLcdScreen = (input: LcdValidationInput): ValidationFinding[] => {
  const findings: ValidationFinding[] = [];
  const items = input.items ?? [];

  // ── Orientation specified (independent of item state) ──
  if (input.orientation == null || input.orientation === '') {
    findings.push({
      rule: 'LCD_NO_ORIENTATION',
      severity: 'warning',
      message: 'Screen orientation not specified.',
    });
  }

  // A display line must reference a real panel (fixed-size LCD).
  const displayItems = items.filter((i) => i.itemType === 'display');
  const displayWithPanel = displayItems.find((i) => i.displayId != null);

  if (items.length === 0) {
    // Nothing to check yet — not an error.
    findings.push({
      rule: 'LCD_DISPLAY_REQUIRED',
      severity: 'cannot_evaluate',
      message: 'No LCD items entered yet — cannot check for a display panel.',
    });
    return findings;
  }

  if (!displayWithPanel) {
    findings.push({
      rule: 'LCD_DISPLAY_REQUIRED',
      severity: 'error',
      message: 'LCD screen has no display panel selected.',
    });
    // Downstream rules assume a display exists; skip them when none is present.
    return findings;
  }

  // ── Mediaplayer / built-in playback source ──
  const hasMediaplayer = items.some((i) => i.itemType === 'mediaplayer');
  if (!hasMediaplayer) {
    const desc = displayWithPanel.description;
    if (desc == null || desc === '') {
      findings.push({
        rule: 'LCD_NO_MEDIAPLAYER',
        severity: 'cannot_evaluate',
        message: 'No mediaplayer selected and the display model is unknown — cannot confirm the playback source.',
      });
    } else if (!hasBuiltInPlayerSignal(desc)) {
      findings.push({
        rule: 'LCD_NO_MEDIAPLAYER',
        severity: 'warning',
        message: 'No mediaplayer selected and the display has no built-in player — confirm playback source.',
      });
    }
  }

  // ── Bracket / mount ──
  const hasBracket = items.some((i) => i.itemType === 'bracket');
  if (!hasBracket) {
    findings.push({
      rule: 'LCD_NO_BRACKET',
      severity: 'warning',
      message: 'No bracket / mount selected — confirm mounting method.',
    });
  }

  return findings;
};
