/**
 * Pure LED Selection Tree Evaluator (Phase 1).
 *
 * Implements the 62 decision rules and 24 questions extracted from `tree.json` /
 * `Copy of 2026 V1.0 LED Selection Tree.xlsx`.
 *
 * It uses a 3-pass forward chaining rule evaluation:
 *  - Pass 1: Direct special overrides (Curved, Transparent, Ceiling, Small, etc.) and direct pitch rules
 *  - Pass 2: Fallback/Standard location rules (checking `noneFired` for higher-priority rules)
 *  - Pass 3: Caveats (c66-c76) and GOB requirement (r94) dependent on earlier fired rules
 *
 * Produces structured constraints that directly guide QuoteZen's technical configuration engine.
 */

export type YesNo = 'Yes' | 'No';

export interface LedIntakeAnswers {
  // Global
  environment?: 'Indoor' | 'Outdoor';
  priority?: 'Value' | 'Quality';

  // Indoor
  use?: 'Digital poster or retail display' | 'Directory board' | 'Information display (computer monitor)';
  curved?: YesNo;
  transparent?: YesNo;
  indoorLocation?: 'On a wall' | 'Behind Window' | 'On a fixture' | 'Hanging' | 'On a ceiling';
  smallDimension?: YesNo;
  underOneAndHalfSqm?: YesNo;
  exact169?: YesNo;
  doubleSided?: YesNo;
  directSunlight?: YesNo;
  highAmbientLight?: YesNo;
  canSetBack?: YesNo;
  convexCorner?: YesNo;
  viewingIndoor?: 'Less than 1 metre' | '1 to 2 metres' | '2 to 3 metres' | 'More than 3 metres';
  damageRisk?: YesNo;

  // Outdoor
  outdoorLocation?: 'On wall (Front Service)' | 'On wall (Rear Service)' | 'Freestanding (Rear Service)';
  serviceAccess?: 'Front' | 'Rear';
  viewingOutdoor?: 'Up to 2 metres' | '2 to 3 metres' | '3 to 8 metres' | '8 to 20 metres' | 'More than 20 metres';
  sizeBand?: 'Less than 4 sqm' | '4 to 10 sqm' | 'More than 10 sqm';
  hardToService?: YesNo;
  highAvailability?: YesNo;
  elevatedSun?: YesNo;
  snowIce?: YesNo;
  saltAir?: YesNo;
  photogenic?: YesNo;
}

export interface TreeConstraints {
  /** Recommended product models / families (e.g. ['FLEX'], ['BM', 'WallPad'], ['FS-PRO']). */
  recommendedModelFamilies: string[];
  /** Minimum pixel pitch in mm (when lower bound applies). */
  pitchMinMm?: number;
  /** Maximum pixel pitch in mm (finer than or equal to this is acceptable). */
  pitchMaxMm?: number;
  /** Human-readable pitch guidance (e.g. "P1.2 or P1.5", "P1.8"). */
  pitchLabel?: string;
  /** Whether GOB (Glue-on-Board) protective coating is required. */
  gobRequired: boolean;
  /** High brightness requirement threshold in nits (e.g. 3500 for direct sun, 10000 for elevated sun). */
  minBrightnessNits?: number;
  /** High refresh rate requirement in Hz (e.g. 3840 for photogenic). */
  minRefreshRateHz?: number;
  /** Whether the screen is required to be curved or flexible. */
  curvedRequired?: boolean;
  /** Whether the screen is required to be transparent. */
  transparentRequired?: boolean;
  /** Fired engineering caveats and warning notes (c66-c76). */
  caveats: string[];
  /** Primary recommendation narrative text from the winning product rule. */
  primaryRecommendationText?: string;
  /** All rule IDs that fired in this evaluation. */
  firedRuleIds: string[];
}

export interface AutoDeriveInputs {
  widthMm?: number;
  heightMm?: number;
  outdoorLocation?: string;
  aspectRatioLabel?: string;
}

/**
 * Automatically derives redundant questionnaire fields from geometry & location inputs.
 */
export const deriveAutoAnswers = (
  inputs: AutoDeriveInputs,
  existing: Partial<LedIntakeAnswers> = {},
): Partial<LedIntakeAnswers> => {
  const result: Partial<LedIntakeAnswers> = { ...existing };
  const w = inputs.widthMm;
  const h = inputs.heightMm;

  if (w != null && h != null && w > 0 && h > 0) {
    const areaSqm = (w * h) / 1_000_000;
    result.underOneAndHalfSqm = areaSqm < 1.5 ? 'Yes' : 'No';
    result.smallDimension = (w < 1280 && h < 5000) || (h < 1280 && w < 5000) ? 'Yes' : 'No';
    result.sizeBand = areaSqm < 4 ? 'Less than 4 sqm' : areaSqm <= 10 ? '4 to 10 sqm' : 'More than 10 sqm';
  }

  const outLoc = inputs.outdoorLocation ?? result.outdoorLocation;
  if (outLoc) {
    result.serviceAccess = /rear/i.test(outLoc) ? 'Rear' : 'Front';
  }

  if (inputs.aspectRatioLabel) {
    result.exact169 = inputs.aspectRatioLabel.trim() === '16:9' ? 'Yes' : 'No';
  }

  return result;
};

// ─── Rule Definitions from tree.json with defect fixes ───────────────────────

type Condition =
  | { eq: [keyof LedIntakeAnswers, string] }
  | { ne: [keyof LedIntakeAnswers, string] }
  | { in: [keyof LedIntakeAnswers, string[]] }
  | { all: Condition[] }
  | { any: Condition[] }
  | { fired: string }
  | { noneFired: string[] }
  | { never: true };

interface TreeRule {
  id: string;
  block: 'product' | 'pitch' | 'caveat';
  branch: 'indoor' | 'outdoor' | 'both';
  text: string;
  special?: boolean;
  isDefault?: boolean;
  when: Condition;
  whenFixed?: Condition;
}

export const TREE_RULES: TreeRule[] = [
  // ─── Indoor Product Rules (p37 - p54) ───
  {
    id: 'p37', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'On a wall'] }, { eq: ['priority', 'Value'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM Product or ZonePro WallPad product depending on the best fit for size',
  },
  {
    id: 'p38', block: 'product', branch: 'indoor',
    when: { all: [{ in: ['indoorLocation', ['On a Wall', 'On a wall']] }, { eq: ['priority', 'Quality'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM-Pro Product or ZonePro WallPad Product depending on what is the best fit or value for the desired size (calculate both options)',
  },
  {
    id: 'p39', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['smallDimension', 'Yes'] }, { eq: ['priority', 'Value'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul IF Product',
  },
  {
    id: 'p40', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Value'] }, { eq: ['canSetBack', 'Yes'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM Product or ZonePro WallPad Product depending on what is the best fit or value for the desired size (calculate both options)',
  },
  {
    id: 'p41', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Quality'] }, { eq: ['canSetBack', 'Yes'] }, { eq: ['convexCorner', 'No'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM-Pro Product or ZonePro WallPad Product depending on what is the best fit or value for the desired size (calculate both options)',
  },
  {
    id: 'p42', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Quality'] }, { eq: ['canSetBack', 'Yes'] }, { eq: ['convexCorner', 'Yes'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM Product or ZonePro WallPad Product depending on what is the best fit or value for the desired size (calculate both options)',
  },
  {
    id: 'p43', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Value'] }, { eq: ['canSetBack', 'No'] }, { eq: ['smallDimension', 'No'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    whenFixed: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Value'] }, { eq: ['canSetBack', 'No'] }, { eq: ['smallDimension', 'No'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM Product with the rear option, or the HI option depending on which is the best fit for the size.',
  },
  {
    id: 'p44', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Value'] }, { eq: ['canSetBack', 'No'] }, { eq: ['smallDimension', 'Yes'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul IF Product with the rear option',
  },
  {
    id: 'p45', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { eq: ['priority', 'Quality'] }, { eq: ['canSetBack', 'No'] }, { eq: ['convexCorner', 'No'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFul BM Product with the rear option, or the LEDFUL HI product depending on which is the best fit for the size.',
  },
  {
    id: 'p46', block: 'product', branch: 'indoor',
    when: { all: [{ eq: ['indoorLocation', 'Behind Window'] }, { any: [{ eq: ['priority', 'Quality'] }, { eq: ['priority', 'Value'] }] }, { eq: ['canSetBack', 'No'] }, { eq: ['convexCorner', 'Yes'] }, { noneFired: ['p47', 'p48', 'p49', 'p50', 'p51', 'p52', 'p53', 'p54'] }] },
    text: 'Use the LEDFUL HI product with 90degree corner option.',
  },
  {
    id: 'p47', block: 'product', branch: 'indoor', special: true,
    when: { all: [{ eq: ['curved', 'Yes'] }, { in: ['transparent', ['No', undefined as unknown as string]] }] },
    whenFixed: { all: [{ eq: ['curved', 'Yes'] }, { ne: ['transparent', 'Yes'] }] },
    text: 'Use the LEDFul FLEX product. Check smallest curve is supported R=205 for P2.5, R=305 for P1.8, R=410 for P1.5).',
  },
  {
    id: 'p48', block: 'product', branch: 'indoor', special: true,
    when: { all: [{ eq: ['transparent', 'Yes'] }, { eq: ['priority', 'Quality'] }] },
    text: 'Use the Muxwave Transparent product. If this is too expensive then use the LEDFUL HIS product, or cheapest option is LEDFUL TGC Product',
  },
  {
    id: 'p49', block: 'product', branch: 'indoor', special: true,
    when: { all: [{ eq: ['transparent', 'Yes'] }, { eq: ['priority', 'Value'] }] },
    text: 'Use the LEDFUL TGC Product.',
  },
  {
    id: 'p50', block: 'product', branch: 'indoor', special: true,
    when: { all: [{ eq: ['priority', 'Value'] }, { eq: ['underOneAndHalfSqm', 'Yes'] }, { ne: ['indoorLocation', 'On a ceiling'] }] },
    text: 'Consider using the LEDFUL IF Product configured as a separate cabinet. Wide range of module sizes; can be made with integrated trim and as shallow as 60mm with alternate power supplies - discuss with LEDFul. Alternatively use LEDFUL BM, Zonepro WallPAD, or Zonepro ViewPAD depending on most suitable cabinet size.',
  },
  {
    id: 'p51', block: 'product', branch: 'indoor', special: true,
    when: { all: [{ eq: ['priority', 'Quality'] }, { eq: ['underOneAndHalfSqm', 'Yes'] }, { ne: ['indoorLocation', 'On a ceiling'] }] },
    text: 'Consider using the LEDFUL IF Product configured as a separate cabinet. Wide range of module sizes; can be made with integrated trim and as shallow as 60mm with alternate power supplies - discuss with LEDFul. Alternatively use LEDFUL BM-PRO, Wall-Pro, or U-PRO depending on most suitable cabinet size.',
  },
  {
    id: 'p52', block: 'product', branch: 'indoor', special: true,
    when: { all: [{ eq: ['doubleSided', 'Yes'] }, { eq: ['indoorLocation', 'Hanging'] }] },
    whenFixed: { all: [{ eq: ['doubleSided', 'Yes'] }, { in: ['indoorLocation', ['Hanging', 'On a fixture']] }] },
    text: 'Use LEDFul WallPad product in doublesided mode (53mm deep). Each side can be different brightness if necessary.',
  },
  {
    id: 'p53', block: 'product', branch: 'indoor', special: true,
    when: { eq: ['indoorLocation', 'On a ceiling'] },
    text: 'Use the LEDFul BM-Pro Product or ZonePro WallPad Product depending on what is the best fit or value for the desired size (calculate both options)',
  },
  {
    id: 'p54', block: 'product', branch: 'indoor', special: true,
    when: { eq: ['exact169', 'Yes'] },
    text: 'BM-PRO or Wall-Pro products achieve 16:9 at only specific sizes. If these do not work then consider the LEDFUL U-Pro product which has precisely 16:9 cabinets.',
  },

  // ─── Outdoor Product Rules (p55 - p62) ───
  {
    id: 'p55', block: 'product', branch: 'outdoor',
    when: { all: [{ eq: ['serviceAccess', 'Rear'] }, { eq: ['priority', 'Value'] }, { in: ['sizeBand', ['Less than 4 sqm', '4 to 10 sqm']] }, { noneFired: ['p60', 'p61'] }] },
    text: 'Use LEDFUL OF Product',
  },
  {
    id: 'p56', block: 'product', branch: 'outdoor',
    when: { all: [{ eq: ['priority', 'Value'] }, { in: ['viewingOutdoor', ['3 to 8 metres', '8 to 20 metres', 'More than 20 metres']] }, { in: ['sizeBand', ['Less than 4 sqm', '4 to 10 sqm']] }, { noneFired: ['p55', 'p60', 'p61'] }] },
    text: 'Use LEDFUL FA Product',
  },
  {
    id: 'p57', block: 'product', branch: 'outdoor',
    when: { all: [{ eq: ['priority', 'Quality'] }, { in: ['viewingOutdoor', ['3 to 8 metres', '8 to 20 metres', 'More than 20 metres']] }, { in: ['sizeBand', ['Less than 4 sqm', '4 to 10 sqm', 'More than 10 sqm']] }, { noneFired: ['p55', 'p60', 'p61'] }] },
    text: 'Use LEDFUL FS-PRO Product',
  },
  {
    id: 'p58', block: 'product', branch: 'outdoor', special: true,
    when: { any: [{ eq: ['viewingOutdoor', 'Up to 2 metres'] }, { all: [{ eq: ['viewingOutdoor', '2 to 3 metres'] }, { eq: ['priority', 'Quality'] }] }] },
    text: 'Use LEDFUL FS-PRO Product or discuss with LEDFul viability of OHD product',
  },
  {
    id: 'p59', block: 'product', branch: 'outdoor', special: true,
    when: { all: [{ eq: ['viewingOutdoor', '2 to 3 metres'] }, { eq: ['priority', 'Value'] }] },
    text: 'Use LEDFUL FM or FM-PRO Product depending on size',
  },
  {
    id: 'p60', block: 'product', branch: 'outdoor',
    when: { all: [{ any: [{ eq: ['hardToService', 'Yes'] }, { eq: ['highAvailability', 'Yes'] }, { eq: ['snowIce', 'Yes'] }, { eq: ['saltAir', 'Yes'] }] }, { eq: ['priority', 'Quality'] }, { noneFired: ['p58', 'p59'] }] },
    text: 'Use LEDFUL FS-PRO Product',
  },
  {
    id: 'p61', block: 'product', branch: 'outdoor',
    when: { all: [{ any: [{ eq: ['hardToService', 'Yes'] }, { eq: ['highAvailability', 'Yes'] }, { eq: ['snowIce', 'Yes'] }, { eq: ['saltAir', 'Yes'] }] }, { eq: ['priority', 'Value'] }, { noneFired: ['p58', 'p59'] }] },
    text: 'Use LEDFUL FM or FM-PRO Product depending on size',
  },
  {
    id: 'p62', block: 'product', branch: 'outdoor', isDefault: true,
    when: { noneFired: ['p55', 'p56', 'p57', 'p58', 'p59', 'p60', 'p61'] },
    text: 'Use LEDFUL FM Product',
  },

  // ─── Caveat Rules (c66 - c76) ───
  {
    id: 'c66', block: 'caveat', branch: 'indoor',
    when: { all: [{ eq: ['convexCorner', 'Yes'] }, { ne: ['transparent', 'Yes'] }, { noneFired: ['p46'] }] },
    text: 'WALL-PRO or WALL-PAD products are best for convex corners. If a 320mm based product is necessary use BM rather than BM-Pro as BM-Pro corners are imprecise.',
  },
  {
    id: 'c67', block: 'caveat', branch: 'indoor',
    when: { all: [{ eq: ['canSetBack', 'No'] }, { eq: ['indoorLocation', 'Behind Window'] }, { fired: 'p47' }] },
    text: 'Note: FLEX MUST be front service. If there is insufficient space to access it from the front then an alternative access method (e.g. gate) must be arranged.',
  },
  {
    id: 'c68', block: 'caveat', branch: 'indoor',
    when: { fired: 'p49' },
    text: 'Note: TGC products are typically hung. If this is not from the ceiling ensure you make allowance for a frame.',
  },
  {
    id: 'c69', block: 'caveat', branch: 'indoor',
    when: { all: [{ fired: 'p49' }, { eq: ['doubleSided', 'Yes'] }] },
    text: 'Note: TGC products can not be made double sided and easily maintained. Discuss with LEDFUL on options if this is required.',
  },
  {
    id: 'c70', block: 'caveat', branch: 'outdoor',
    when: { eq: ['highAvailability', 'Yes'] },
    text: 'Consider options with redundant power supplies (Speak to supplier)',
  },
  {
    id: 'c71', block: 'caveat', branch: 'outdoor',
    when: { any: [{ fired: 'p58' }, { fired: 'p57' }, { fired: 'p60' }] },
    text: 'Note: FS-PRO product is Dual Service but maintenance of control cards and power supplies from the front is slow and requires a stable work platform',
  },
  {
    id: 'c72', block: 'caveat', branch: 'outdoor',
    when: { any: [{ fired: 'p59' }, { fired: 'p61' }, { fired: 'p62' }] },
    text: 'Note: FM and FM-PRO products are Dual Service but maintenance of control cards and power supplies from the front is slow and requires a stable work platform.',
  },
  {
    id: 'c73', block: 'caveat', branch: 'outdoor',
    when: { all: [{ eq: ['photogenic', 'Yes'] }, { any: [{ fired: 'p55' }, { fired: 'p56' }] }] },
    text: 'Ensure this is a minimum 3840Hz Refresh screen - check with LEDFUL if uplift is required and cost (typically approx USD56/sqm if not included)',
  },
  {
    id: 'c74', block: 'caveat', branch: 'outdoor',
    when: { all: [{ eq: ['photogenic', 'Yes'] }, { any: [{ fired: 'p57' }, { fired: 'p58' }, { fired: 'p59' }, { fired: 'p60' }, { fired: 'p61' }, { fired: 'p62' }] }] },
    text: 'Ensure this is a minimum 3840Hz Refresh screen - FM-PRO and FS-PRO typically are but double check if this is a particular concern',
  },
  {
    id: 'c75', block: 'caveat', branch: 'outdoor',
    when: { any: [{ eq: ['saltAir', 'Yes'] }, { eq: ['snowIce', 'Yes'] }] },
    text: 'In extreme examples (e.g. beach front, over water, on boats, snow/ice), consider nano-coating as an additional protection. Speak to LEDFul about this option.',
  },
  {
    id: 'c76', block: 'caveat', branch: 'outdoor',
    when: { eq: ['elevatedSun', 'Yes'] },
    text: 'Consider superbright options here (10,000nits) - discuss with LEDFUL.',
  },

  // ─── Pitch & GOB Rules (r79 - r103) ───
  {
    id: 'r79', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['viewingIndoor', 'Less than 1 metre'] }, { ne: ['transparent', 'Yes'] }] },
    text: 'This requires a very high resolution product at P1.2, P0.9 or better',
  },
  {
    id: 'r80', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { eq: ['viewingIndoor', '1 to 2 metres'] }, { eq: ['priority', 'Quality'] }, { ne: ['use', 'Directory board'] }, { ne: ['use', 'Information display (computer monitor)'] }] },
    text: 'This should be a P1.2 or P1.5 LED',
  },
  {
    id: 'r81', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { eq: ['viewingIndoor', '1 to 2 metres'] }, { eq: ['priority', 'Value'] }, { ne: ['use', 'Directory board'] }, { ne: ['use', 'Information display (computer monitor)'] }] },
    text: 'This should be a P1.8 LED',
  },
  {
    id: 'r82', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { eq: ['viewingIndoor', '2 to 3 metres'] }, { eq: ['priority', 'Quality'] }, { ne: ['use', 'Directory board'] }, { ne: ['use', 'Information display (computer monitor)'] }] },
    text: 'This should be a P1.8 LED',
  },
  {
    id: 'r83', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { any: [{ eq: ['viewingIndoor', 'More than 3 metres'] }, { all: [{ eq: ['viewingIndoor', '2 to 3 metres'] }, { eq: ['priority', 'Value'] }] }] }, { ne: ['use', 'Directory board'] }, { ne: ['use', 'Information display (computer monitor)'] }] },
    text: 'This should be a P2.5 LED',
  },
  {
    id: 'r84', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { eq: ['priority', 'Quality'] }, { any: [{ eq: ['use', 'Directory board'] }, { eq: ['use', 'Information display (computer monitor)'] }] }, { eq: ['viewingIndoor', '1 to 2 metres'] }] },
    text: 'This should be a P1.2 or better (P0.9) LED',
  },
  {
    id: 'r85', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { eq: ['priority', 'Value'] }, { any: [{ eq: ['use', 'Directory board'] }, { eq: ['use', 'Information display (computer monitor)'] }] }, { eq: ['viewingIndoor', '1 to 2 metres'] }] },
    text: 'This should be a P1.2 or P1.5 LED',
  },
  {
    id: 'r86', block: 'pitch', branch: 'indoor',
    when: { all: [{ ne: ['transparent', 'Yes'] }, { ne: ['curved', 'Yes'] }, { any: [{ eq: ['use', 'Directory board'] }, { eq: ['use', 'Information display (computer monitor)'] }] }, { any: [{ eq: ['viewingIndoor', '2 to 3 metres'] }, { eq: ['viewingIndoor', 'More than 3 metres'] }] }] },
    text: 'This should be a P1.2 or P1.5 LED',
  },
  {
    id: 'r87', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['transparent', 'Yes'] }, { eq: ['priority', 'Value'] }] },
    text: 'This should be P3.9/7.8',
  },
  {
    id: 'r88', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['transparent', 'Yes'] }, { eq: ['priority', 'Quality'] }] },
    text: 'This should be P2.8/5.6 or P3.9 symmetrical',
  },
  {
    id: 'r89', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['curved', 'Yes'] }, { any: [{ eq: ['viewingIndoor', 'More than 3 metres'] }, { all: [{ eq: ['priority', 'Value'] }, { eq: ['viewingIndoor', '2 to 3 metres'] }] }] }] },
    text: 'This should be P2.5',
  },
  {
    id: 'r90', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['curved', 'Yes'] }, { any: [{ all: [{ eq: ['priority', 'Quality'] }, { eq: ['viewingIndoor', '2 to 3 metres'] }] }, { all: [{ eq: ['priority', 'Value'] }, { eq: ['viewingIndoor', '1 to 2 metres'] }] }] }] },
    text: 'This should be P1.8',
  },
  {
    id: 'r91', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['curved', 'Yes'] }, { any: [{ all: [{ eq: ['priority', 'Quality'] }, { eq: ['viewingIndoor', '1 to 2 metres'] }] }, { all: [{ eq: ['priority', 'Value'] }, { eq: ['viewingIndoor', 'Less than 1 metre'] }] }] }] },
    text: 'This should be P1.5',
  },
  {
    id: 'r92', block: 'pitch', branch: 'indoor',
    when: { all: [{ eq: ['curved', 'Yes'] }, { eq: ['priority', 'Quality'] }, { eq: ['viewingIndoor', 'Less than 1 metre'] }] },
    text: 'This should be P1.2',
  },
  {
    id: 'r93', block: 'pitch', branch: 'indoor',
    when: { any: [{ eq: ['use', 'Directory board'] }, { eq: ['use', 'Information display (computer monitor)'] }] },
    text: 'Ensure resolution is high enough for text rows (minimum 18 pixels per row).',
  },
  {
    id: 'r94', block: 'pitch', branch: 'indoor',
    when: { any: [{ eq: ['damageRisk', 'Yes'] }, { fired: 'r79' }, { fired: 'r80' }, { fired: 'r82' }, { fired: 'r84' }, { fired: 'r85' }, { fired: 'r86' }, { fired: 'r90' }, { fired: 'r91' }, { fired: 'r92' }] },
    text: 'The product should have GOB',
  },
  {
    id: 'r95', block: 'pitch', branch: 'indoor',
    when: { eq: ['directSunlight', 'Yes'] },
    text: 'The product should be a high brightness option (>3500nits)',
  },
  {
    id: 'r96', block: 'pitch', branch: 'indoor',
    when: { all: [{ fired: 'r94' }, { fired: 'r95' }, { any: [{ fired: 'r80' }, { fired: 'r84' }, { fired: 'r85' }, { fired: 'r86' }, { fired: 'r91' }, { fired: 'r92' }] }] },
    text: 'Check with the manufacturer whether there are issues with GOB and highbright screens at this resolution',
  },
  {
    id: 'r97', block: 'pitch', branch: 'indoor',
    when: { eq: ['highAmbientLight', 'Yes'] },
    text: 'Consider the specifics of the location and budget to see if a high brightness option is appropriate.',
  },
  {
    id: 'r98', block: 'pitch', branch: 'indoor',
    when: { all: [{ fired: 'r95' }, { any: [{ fired: 'r79' }, { fired: 'r80' }, { fired: 'r84' }, { fired: 'r85' }, { fired: 'r86' }, { fired: 'r91' }, { fired: 'r92' }] }] },
    text: 'Note: Highbright screens at resolutions better than P1.8 are emerging technology - check with the supplier on possibilities before quoting',
  },
  {
    id: 'r99', block: 'pitch', branch: 'outdoor',
    when: { eq: ['viewingOutdoor', 'Up to 2 metres'] },
    text: 'This should be P1.5 or P1.9 depending on the specific location and application',
  },
  {
    id: 'r100', block: 'pitch', branch: 'outdoor',
    when: { eq: ['viewingOutdoor', '2 to 3 metres'] },
    text: 'This should be around P3',
  },
  {
    id: 'r101', block: 'pitch', branch: 'outdoor',
    when: { eq: ['viewingOutdoor', '3 to 8 metres'] },
    text: 'This should be around P4',
  },
  {
    id: 'r102', block: 'pitch', branch: 'outdoor',
    when: { eq: ['viewingOutdoor', '8 to 20 metres'] },
    text: 'This should be around P6.6',
  },
  {
    id: 'r103', block: 'pitch', branch: 'outdoor',
    when: { eq: ['viewingOutdoor', 'More than 20 metres'] },
    text: 'This should be P10',
  },
];

// ─── Evaluator Engine ────────────────────────────────────────────────────────

const evalCondition = (
  cond: Condition,
  answers: LedIntakeAnswers,
  firedIds: Set<string>,
): boolean => {
  if ('never' in cond) return false;
  if ('eq' in cond) {
    const val = answers[cond.eq[0]];
    return val != null && String(val).toLowerCase() === String(cond.eq[1]).toLowerCase();
  }
  if ('ne' in cond) {
    const val = answers[cond.ne[0]];
    return val == null || String(val).toLowerCase() !== String(cond.ne[1]).toLowerCase();
  }
  if ('in' in cond) {
    const val = answers[cond.in[0]];
    if (val == null) return false;
    return cond.in[1].some((opt) => String(opt).toLowerCase() === String(val).toLowerCase());
  }
  if ('fired' in cond) {
    return firedIds.has(cond.fired);
  }
  if ('noneFired' in cond) {
    return cond.noneFired.every((id) => !firedIds.has(id));
  }
  if ('all' in cond) {
    return cond.all.every((c) => evalCondition(c, answers, firedIds));
  }
  if ('any' in cond) {
    return cond.any.some((c) => evalCondition(c, answers, firedIds));
  }
  return false;
};

const hasRuleDependency = (cond: Condition): boolean => {
  if ('fired' in cond || 'noneFired' in cond) return true;
  if ('all' in cond) return cond.all.some(hasRuleDependency);
  if ('any' in cond) return cond.any.some(hasRuleDependency);
  return false;
};

/**
 * Pure evaluation of the LED Selection Tree.
 *
 * @param answers The user's answers to the questionnaire.
 * @param options.fixDefects Whether to apply workbook defect corrections (default: true).
 */
export const evaluateSelectionTree = (
  answers: LedIntakeAnswers,
  options: { fixDefects?: boolean } = { fixDefects: true },
): TreeConstraints => {
  const fix = options.fixDefects ?? true;
  const firedRuleIds = new Set<string>();

  const isIndoor = answers.environment ? answers.environment.toLowerCase() === 'indoor' : true;
  const isOutdoor = answers.environment ? answers.environment.toLowerCase() === 'outdoor' : false;

  const relevantRules = TREE_RULES.filter((r) => {
    if (r.branch === 'both') return true;
    if (r.branch === 'indoor') return !isOutdoor;
    if (r.branch === 'outdoor') return !isIndoor;
    return true;
  });

  const getCond = (r: TreeRule): Condition => (fix && r.whenFixed ? r.whenFixed : r.when);

  // Pass 1: Direct Rules without dependencies (special product rules, direct pitch rules)
  const pass1 = relevantRules.filter((r) => !hasRuleDependency(getCond(r)));
  for (const rule of pass1) {
    if (evalCondition(getCond(rule), answers, firedRuleIds)) {
      firedRuleIds.add(rule.id);
    }
  }

  // Pass 2: Dependent Product/Pitch rules (e.g. checking noneFired on p47..p54 or noneFired on p55..p61)
  const pass2 = relevantRules.filter((r) => hasRuleDependency(getCond(r)) && r.block === 'product');
  for (const rule of pass2) {
    if (evalCondition(getCond(rule), answers, firedRuleIds)) {
      firedRuleIds.add(rule.id);
    }
  }

  // Pass 3: Dependent Pitch & Caveat rules (checking fired rules)
  const pass3 = relevantRules.filter((r) => hasRuleDependency(getCond(r)) && r.block !== 'product');
  for (const rule of pass3) {
    if (evalCondition(getCond(rule), answers, firedRuleIds)) {
      firedRuleIds.add(rule.id);
    }
  }

  // Map fired rule IDs into structured constraints
  return mapFiredRulesToConstraints(firedRuleIds, relevantRules);
};

// ─── Mapping Fired Rules to Structured Constraints ───────────────────────────

const PRODUCT_FAMILY_MAP: Record<string, string[]> = {
  p37: ['BM', 'WallPad', 'WallPAD'],
  p38: ['BM-PRO', 'BM-Pro', 'WallPad', 'WallPAD', 'Wall-Pro'],
  p39: ['IF'],
  p40: ['BM', 'WallPad', 'WallPAD'],
  p41: ['BM-PRO', 'BM-Pro', 'WallPad', 'WallPAD', 'Wall-Pro'],
  p42: ['BM', 'WallPad', 'WallPAD'],
  p43: ['BM', 'HI'],
  p44: ['IF'],
  p45: ['BM', 'HI'],
  p46: ['HI'],
  p47: ['FLEX'],
  p48: ['Muxwave', 'HIS', 'TGC'],
  p49: ['TGC'],
  p50: ['IF', 'BM', 'WallPAD', 'ViewPAD'],
  p51: ['IF', 'BM-PRO', 'Wall-Pro', 'U-PRO'],
  p52: ['WallPad', 'WallPAD'],
  p53: ['BM-PRO', 'BM-Pro', 'WallPad', 'WallPAD', 'Wall-Pro'],
  p54: ['BM-PRO', 'BM-Pro', 'Wall-Pro', 'U-PRO', 'U-Pro'],
  p55: ['OF'],
  p56: ['FA'],
  p57: ['FS-PRO'],
  p58: ['FS-PRO', 'OHD'],
  p59: ['FM', 'FM-PRO'],
  p60: ['FS-PRO'],
  p61: ['FM', 'FM-PRO'],
  p62: ['FM'],
};

const PITCH_MAP: Record<string, { maxMm: number; minMm?: number; label: string }> = {
  r79: { maxMm: 1.2, label: 'P1.2, P0.9 or better' },
  r80: { maxMm: 1.5, label: 'P1.2 or P1.5' },
  r81: { maxMm: 1.8, label: 'P1.8' },
  r82: { maxMm: 1.8, label: 'P1.8' },
  r83: { maxMm: 2.5, label: 'P2.5' },
  r84: { maxMm: 1.2, label: 'P1.2 or better (P0.9)' },
  r85: { maxMm: 1.5, label: 'P1.2 or P1.5' },
  r86: { maxMm: 1.5, label: 'P1.2 or P1.5' },
  r87: { maxMm: 7.8, label: 'P3.9/7.8' },
  r88: { maxMm: 5.6, label: 'P2.8/5.6 or P3.9' },
  r89: { maxMm: 2.5, label: 'P2.5' },
  r90: { maxMm: 1.8, label: 'P1.8' },
  r91: { maxMm: 1.5, label: 'P1.5' },
  r92: { maxMm: 1.2, label: 'P1.2' },
  r99: { maxMm: 1.9, label: 'P1.5 or P1.9' },
  r100: { maxMm: 3.5, label: 'Around P3' },
  r101: { maxMm: 4.5, label: 'Around P4' },
  r102: { maxMm: 7.0, label: 'Around P6.6' },
  r103: { maxMm: 10.0, label: 'P10' },
};

const mapFiredRulesToConstraints = (
  firedIds: Set<string>,
  rules: TreeRule[],
): TreeConstraints => {
  const families = new Set<string>();
  let pitchMaxMm: number | undefined;
  let pitchMinMm: number | undefined;
  let pitchLabel: string | undefined;
  let primaryRecommendationText: string | undefined;

  for (const id of firedIds) {
    const fams = PRODUCT_FAMILY_MAP[id];
    if (fams) {
      for (const f of fams) families.add(f);
      const rule = rules.find((r) => r.id === id);
      if (rule && !primaryRecommendationText) {
        primaryRecommendationText = rule.text;
      }
    }
    const pitch = PITCH_MAP[id];
    if (pitch) {
      if (pitchMaxMm === undefined || pitch.maxMm < pitchMaxMm) {
        pitchMaxMm = pitch.maxMm;
        pitchLabel = pitch.label;
      }
      if (pitch.minMm !== undefined && (pitchMinMm === undefined || pitch.minMm > pitchMinMm)) {
        pitchMinMm = pitch.minMm;
      }
    }
  }

  const caveats: string[] = [];
  for (const id of firedIds) {
    if (id.startsWith('c') || id === 'r93' || id === 'r96' || id === 'r98') {
      const r = rules.find((rule) => rule.id === id);
      if (r) caveats.push(r.text);
    }
  }

  const gobRequired = firedIds.has('r94');
  let minBrightnessNits: number | undefined;
  if (firedIds.has('c76')) {
    minBrightnessNits = 10000;
  } else if (firedIds.has('r95')) {
    minBrightnessNits = 3500;
  }

  let minRefreshRateHz: number | undefined;
  if (firedIds.has('c73') || firedIds.has('c74')) {
    minRefreshRateHz = 3840;
  }

  const curvedRequired = firedIds.has('p47');
  const transparentRequired = firedIds.has('p48') || firedIds.has('p49');

  return {
    recommendedModelFamilies: Array.from(families),
    pitchMinMm,
    pitchMaxMm,
    pitchLabel,
    gobRequired,
    minBrightnessNits,
    minRefreshRateHz,
    curvedRequired,
    transparentRequired,
    caveats,
    primaryRecommendationText,
    firedRuleIds: Array.from(firedIds),
  };
};
