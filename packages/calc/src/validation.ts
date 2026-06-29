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
