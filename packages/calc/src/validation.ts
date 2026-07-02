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
  // ─── AA2: LED selection rules ───────────────────────────────────────────────
  /** The achieved aspect-ratio label of the configured screen (e.g. '16:9'). Null → cannot evaluate. */
  achievedRatioLabel?: string | null;
  /** Client's allowed aspect-ratio labels; empty/undefined → no ratio restriction. */
  allowedRatios?: readonly string[];
  /** The screen PRODUCT's compatibility group (AA2). Null → the controller/bracket checks can't fire. */
  productCompatibilityGroup?: string | null;
  /** Compatibility groups of the selected controller components (nulls dropped). */
  controllerCompatibilityGroups?: readonly string[];
  /** The selected frame/bracket's compatibility group. Null → the bracket check can't fire. */
  frameCompatibilityGroup?: string | null;
  /** Client's preferred fixed pixel pitch (mm); undefined/null → no fixed-pitch check. */
  clientPreferredPitchMm?: number | null;
  /** The aspect ratio the CONTENT is authored for (e.g. '16:9'); null/empty → no content-ratio check. */
  contentRatioLabel?: string | null;
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

  // ── AA2 rule 1: per-customer allowed aspect ratios (advisory) ──
  // Only fires when the client has restricted the allowed set. A stored screen whose achieved ratio
  // isn't in that set is flagged (warning, not error — the estimator may knowingly deviate).
  const allowedRatios = (input.allowedRatios ?? []).map((r) => r.trim()).filter((r) => r.length > 0);
  if (allowedRatios.length > 0 && input.achievedRatioLabel != null && input.achievedRatioLabel !== '') {
    if (!allowedRatios.includes(input.achievedRatioLabel)) {
      findings.push({
        rule: 'RATIO_NOT_ALLOWED',
        severity: 'warning',
        message: `Achieved ratio ${input.achievedRatioLabel} is not in the client's allowed ratios (${allowedRatios.join(', ')}).`,
      });
    }
  }

  // ── AA2 rule 2: component conflict matrix (controller↔screen, bracket↔screen) ──
  // Fires only when BOTH sides carry a compatibility group and they DIFFER. A null on either side →
  // no finding (never a false error on missing data).
  const productGroup = input.productCompatibilityGroup;
  if (productGroup != null && productGroup !== '') {
    const controllerGroups = (input.controllerCompatibilityGroups ?? []).filter((g) => g != null && g !== '');
    for (const cg of controllerGroups) {
      if (cg !== productGroup) {
        findings.push({
          rule: 'CONTROLLER_SCREEN_MISMATCH',
          severity: 'error',
          message: `Controller compatibility group "${cg}" does not match the screen product group "${productGroup}".`,
        });
        break; // one finding is enough — don't repeat per controller
      }
    }
    const frameGroup = input.frameCompatibilityGroup;
    if (frameGroup != null && frameGroup !== '' && frameGroup !== productGroup) {
      findings.push({
        rule: 'BRACKET_SCREEN_MISMATCH',
        severity: 'error',
        message: `Bracket/frame compatibility group "${frameGroup}" does not match the screen product group "${productGroup}".`,
      });
    }
  }

  // ── AA2 rule 3: fixed-pitch-per-customer (advisory) ──
  // Client prefers a specific pixel pitch; flag when the product's pitch differs (small tolerance).
  if (
    input.clientPreferredPitchMm != null &&
    input.pixelPitchMm != null &&
    Math.abs(input.pixelPitchMm - input.clientPreferredPitchMm) > 0.01
  ) {
    findings.push({
      rule: 'PITCH_NOT_CLIENT_PREFERRED',
      severity: 'warning',
      message: `Product pitch ${input.pixelPitchMm}mm differs from the client's preferred pitch ${input.clientPreferredPitchMm}mm.`,
    });
  }

  // ── AA2 rule 4: content ratio vs achieved screen ratio (advisory) ──
  if (
    input.contentRatioLabel != null &&
    input.contentRatioLabel !== '' &&
    input.achievedRatioLabel != null &&
    input.achievedRatioLabel !== '' &&
    input.contentRatioLabel !== input.achievedRatioLabel
  ) {
    findings.push({
      rule: 'CONTENT_RATIO_MISMATCH',
      severity: 'warning',
      message: `Content ratio ${input.contentRatioLabel} does not match the screen's achieved ratio ${input.achievedRatioLabel}.`,
    });
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
  // ─── AA3a: bracket-item constraint data (only meaningful on itemType === 'bracket') ───
  /** Bracket's supported minimum panel size (inches). Null → the sub-range check can't fire. */
  bracketMinSizeIn?: number | null;
  /** Bracket's supported maximum panel size (inches). Null → the sub-range check can't fire. */
  bracketMaxSizeIn?: number | null;
  /** Whether the bracket supports portrait mounting. Null → the portrait-bracket check can't fire. */
  bracketPortraitCapable?: boolean | null;
}

export interface LcdValidationInput {
  /** 'P' | 'L' | null — matches the persisted LCD orientation. */
  orientation?: string | null;
  items?: LcdValidationItem[];
  // ─── AA3a: chosen-display characteristics + screen requirement fields (all nullable) ───
  /** The chosen display's brand (informational; threaded for completeness). */
  displayBrand?: string | null;
  /** Whether the chosen display has a built-in Android player. Null → falls back to the description heuristic. */
  displayBuiltInAndroid?: boolean | null;
  /** The chosen display's physical depth (mm). Null → the depth check can't fire. */
  displayDepthMm?: number | null;
  /** The chosen display's panel size (inches). Null → the bracket sub-range check is skipped. */
  displaySizeIn?: number | null;
  /** Site requirement: the screen must sit within this depth (mm). Null → the depth check can't fire. */
  maxDepthMm?: number | null;
  /** Site requirement: the display must be Android-capable. */
  requiresAndroid?: boolean | null;
  /** Site requirement: a separate PC must be quoted. */
  needsPc?: boolean | null;
  /** Site requirement: a separate hard drive must be quoted. */
  needsHardDrive?: boolean | null;
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

  // ── AA3a rule 1: depth exceeded ──
  // The site imposes a maximum mounting depth and the chosen display is deeper. Both must be known.
  if (
    input.maxDepthMm != null &&
    input.displayDepthMm != null &&
    input.displayDepthMm > input.maxDepthMm
  ) {
    findings.push({
      rule: 'LCD_DEPTH_EXCEEDED',
      severity: 'warning',
      message: `Display depth ${input.displayDepthMm}mm exceeds the site's maximum depth ${input.maxDepthMm}mm.`,
    });
  }

  // ── AA3a rule 2: Android required ──
  // Site requires an Android display but the chosen one is not Android — using the explicit flag first,
  // then falling back to the same built-in-player description heuristic used for the mediaplayer check.
  if (input.requiresAndroid === true) {
    const flaggedAndroid = input.displayBuiltInAndroid === true;
    const desc = displayWithPanel.description;
    const descHintsAndroid = desc != null && desc !== '' && hasBuiltInPlayerSignal(desc);
    if (!flaggedAndroid && !descHintsAndroid) {
      findings.push({
        rule: 'LCD_ANDROID_REQUIRED',
        severity: 'warning',
        message: 'Site requires an Android display but the selected display is not Android-capable.',
      });
    }
  }

  // ── AA3a rule 3: bracket size sub-range / portrait capability ──
  // Only fires per bracket that carries the relevant constraint data (never a false error on missing data).
  const brackets = items.filter((i) => i.itemType === 'bracket');
  const isPortrait = input.orientation === 'P';
  for (const b of brackets) {
    // Panel size outside the bracket's supported range (needs both a display size and a range bound).
    if (input.displaySizeIn != null) {
      const belowMin = b.bracketMinSizeIn != null && input.displaySizeIn < b.bracketMinSizeIn;
      const aboveMax = b.bracketMaxSizeIn != null && input.displaySizeIn > b.bracketMaxSizeIn;
      if (belowMin || aboveMax) {
        const lo = b.bracketMinSizeIn != null ? `${b.bracketMinSizeIn}"` : '—';
        const hi = b.bracketMaxSizeIn != null ? `${b.bracketMaxSizeIn}"` : '—';
        findings.push({
          rule: 'LCD_BRACKET_SUBRANGE',
          severity: 'warning',
          message: `Display size ${input.displaySizeIn}" is outside the bracket's supported range (${lo}–${hi}).`,
        });
        continue; // one finding per bracket is enough — don't also flag portrait for the same row
      }
    }
    // Portrait orientation requested but this bracket doesn't support portrait.
    if (isPortrait && b.bracketPortraitCapable === false) {
      findings.push({
        rule: 'LCD_BRACKET_SUBRANGE',
        severity: 'warning',
        message: 'Screen is portrait but the selected bracket does not support portrait mounting.',
      });
    }
  }

  // ── AA3a rule 4: PC / hard-drive dependency (informational) ──
  if (input.needsPc === true || input.needsHardDrive === true) {
    const deps: string[] = [];
    if (input.needsPc === true) deps.push('a PC');
    if (input.needsHardDrive === true) deps.push('a hard drive');
    findings.push({
      rule: 'LCD_PC_DEPENDENCY',
      severity: 'warning',
      message: `Site requires ${deps.join(' and ')} — ensure it is quoted as a separate line.`,
    });
  }

  return findings;
};
