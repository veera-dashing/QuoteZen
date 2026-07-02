/**
 * Table registry — one declarative entry per reference/catalog table. It is the single source of
 * truth for:
 *   • the generic CRUD router (which Prisma delegate, which fields are writable/required),
 *   • Zod validation (built from the field types), and
 *   • the admin UI (served via GET /admin/_meta to render columns and forms).
 */
export type FieldType = 'string' | 'text' | 'int' | 'decimal' | 'boolean' | 'date' | 'enum';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Allowed values for `enum` fields. */
  options?: string[];
}

export interface TableDef {
  resource: string; // URL slug
  model: string; // Prisma delegate key
  label: string;
  group: string;
  titleField: string;
  fields: FieldDef[];
  listFields: string[];
  searchFields: string[];
  readonly?: boolean;
}

const cap = (s: string): string =>
  s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();

const f = (name: string, type: FieldType = 'string', required = false, options?: string[]): FieldDef => ({
  name,
  label: cap(name),
  type,
  required,
  options,
});

const TIER = ['low', 'high'];
const SCREEN = ['LCD', 'LED'];
const CLIENT_TIER = ['A', 'A+', 'B', 'C'];
const ANOMALY_SEVERITY = ['block', 'warn'];

/**
 * Shared "deprecated" flag (P1-08.4 / P1-11.4): catalog/lookup rows feeding NEW quotes carry this.
 * Editable so admins can toggle it (un-deprecate) via the generic form. The delete handler also
 * sets it automatically when a hard-delete is blocked by a FK from a saved quote.
 */
const DEPRECATED: FieldDef = f('deprecated', 'boolean');

export const TABLES: TableDef[] = [
  // ── Pricing & currency ──
  {
    resource: 'currencies', model: 'currency', label: 'Currencies', group: 'Pricing & Currency',
    titleField: 'code', searchFields: ['code', 'name'],
    fields: [f('code', 'string', true), f('name')],
    listFields: ['code', 'name'],
  },
  {
    resource: 'settings', model: 'setting', label: 'Settings (markups/margins)', group: 'Pricing & Currency',
    titleField: 'label', searchFields: ['key', 'label'],
    fields: [f('key', 'string', true), f('label', 'string', true), f('value', 'decimal'), f('valueText', 'string'), f('unit')],
    listFields: ['key', 'label', 'value', 'unit'],
  },
  {
    resource: 'seafreight-rates', model: 'seafreightRate', label: 'Seafreight Rates', group: 'Pricing & Currency',
    titleField: 'label', searchFields: ['label'],
    fields: [f('label', 'string', true), f('value', 'decimal', true)],
    listFields: ['label', 'value'],
  },
  {
    resource: 'international-vat', model: 'internationalVat', label: 'International VAT', group: 'Pricing & Currency',
    titleField: 'region', searchFields: ['region'],
    fields: [f('region', 'string', true), f('vatMultiplier', 'decimal', true)],
    listFields: ['region', 'vatMultiplier'],
  },

  // ── Locations & freight ──
  {
    resource: 'locations', model: 'location', label: 'Locations', group: 'Locations & Freight',
    titleField: 'name', searchFields: ['name'],
    fields: [
      f('name', 'string', true), f('freightMultiplier', 'decimal', true), f('freightMin', 'decimal', true),
      f('frameFreight', 'decimal', true), f('trimFreight', 'decimal', true), f('hourlyUplift', 'decimal', true),
    ],
    listFields: ['name', 'freightMultiplier', 'freightMin', 'hourlyUplift'],
  },
  {
    resource: 'freight-options', model: 'freightOption', label: 'Freight Options', group: 'Locations & Freight',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('rate', 'decimal'), DEPRECATED],
    listFields: ['name', 'rate', 'deprecated'],
  },

  // ── LED ──
  {
    resource: 'manufacturers', model: 'manufacturer', label: 'Manufacturers', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('priority', 'int'), f('leadTimeDays', 'int'), DEPRECATED],
    listFields: ['name', 'priority', 'leadTimeDays', 'deprecated'],
  },
  {
    resource: 'led-products', model: 'ledProduct', label: 'LED Products', group: 'LED',
    titleField: 'model', searchFields: ['model', 'vendor', 'cabinetType'],
    fields: [
      // manufacturerId is the normalised manufacturer FK (U0). The generic CRUD has no dedicated
      // `ref` field type, so it is exposed as an int FK (manufacturers.id).
      f('vendor'), f('manufacturerId', 'int'), f('model', 'string', true), f('serviceCategory'), f('moduleWMm', 'int'),
      f('moduleHMm', 'int'), f('minCabinetWMm', 'int'), f('minCabinetHMm', 'int'), f('cabinetDepthMm', 'int'),
      f('cabinetType'), f('pixelPitchH', 'decimal'), f('pixelPitchV', 'decimal'), f('brightnessNits', 'int'),
      // W0: indoor/outdoor suitability (nullable enum). Null → config falls back to a brightness heuristic.
      f('environment', 'enum', false, ['indoor', 'outdoor']),
      f('powerMaxW', 'int'), f('powerAvgW', 'int'), f('kgPerSqm', 'decimal'), f('costPerSqmUsd', 'decimal'),
      f('modulePrice', 'decimal'), f('volumetricModifier', 'decimal'), f('includesReceivers', 'boolean'),
      f('gobIncluded', 'boolean'), f('packIncluded', 'boolean'), f('serviceAccess'),
      // Per-model recommendation priority (lower = preferred) — secondary ranking key in the config engine.
      f('priority', 'int'),
      // AA2 — component compatibility group (matched against controller/frame groups in validation).
      f('compatibilityGroup'),
      f('upgradeOptions', 'text'), f('mechanicalOptions', 'text'), DEPRECATED,
    ],
    listFields: ['vendor', 'model', 'priority', 'pixelPitchH', 'brightnessNits', 'compatibilityGroup', 'costPerSqmUsd', 'cabinetType', 'deprecated'],
  },
  {
    resource: 'led-commentary', model: 'ledCommentary', label: 'LED Commentary', group: 'LED',
    titleField: 'productCode', searchFields: ['productCode', 'serviceCategory', 'commentary'],
    fields: [f('serviceCategory', 'string', true), f('productCode', 'string', true), f('commentary', 'text', true)],
    listFields: ['serviceCategory', 'productCode'],
  },
  {
    resource: 'controllers', model: 'controller', label: 'Controllers', group: 'LED',
    titleField: 'name', searchFields: ['name', 'type'],
    fields: [f('name', 'string', true), f('type'), f('maxPorts', 'int'), f('maxWidth', 'int'), f('price', 'decimal', true), f('compatibilityGroup'), DEPRECATED],
    listFields: ['name', 'type', 'maxPorts', 'price', 'compatibilityGroup', 'deprecated'],
  },
  {
    resource: 'led-peripherals', model: 'ledPeripheral', label: 'LED Peripherals', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true), DEPRECATED],
    listFields: ['name', 'price', 'deprecated'],
  },
  {
    resource: 'gob-options', model: 'gobOption', label: 'GOB Options', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true), DEPRECATED],
    listFields: ['name', 'price', 'deprecated'],
  },
  {
    resource: 'trim-options', model: 'trimOption', label: 'Trim Options', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('widthMultiplier', 'decimal', true), f('heightMultiplier', 'decimal', true), DEPRECATED],
    listFields: ['name', 'widthMultiplier', 'heightMultiplier', 'deprecated'],
  },
  {
    resource: 'hanging-bars', model: 'hangingBarOption', label: 'Hanging Bars', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('widthMultiplier', 'decimal', true), DEPRECATED],
    listFields: ['name', 'widthMultiplier', 'deprecated'],
  },
  {
    resource: 'frames', model: 'frame', label: 'Frames', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true), f('backcoverCost', 'decimal'), f('installHours', 'decimal'), f('compatibilityGroup'), DEPRECATED],
    listFields: ['name', 'price', 'installHours', 'compatibilityGroup', 'deprecated'],
  },
  {
    resource: 'engineering-options', model: 'engineeringOption', label: 'Engineering Options', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true), DEPRECATED],
    listFields: ['name', 'price', 'deprecated'],
  },
  {
    resource: 'install-methods', model: 'installMethod', label: 'Install Methods', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('wallRequirement', 'text'), f('powerDataNote', 'text'), f('defaultHours', 'decimal'), f('hourlyRateCost', 'decimal'), DEPRECATED],
    listFields: ['name', 'defaultHours', 'deprecated'],
  },
  {
    resource: 'access-equipment', model: 'accessEquipment', label: 'Access Equipment', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('dayRate', 'decimal', true), DEPRECATED],
    listFields: ['name', 'dayRate', 'deprecated'],
  },
  {
    resource: 'warranties', model: 'warrantyOption', label: 'Warranties', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('years', 'int', true), f('perYearCost', 'decimal'), DEPRECATED],
    listFields: ['name', 'years', 'perYearCost', 'deprecated'],
  },
  {
    resource: 'service-hours', model: 'serviceHoursOption', label: 'Service Hours', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), DEPRECATED],
    listFields: ['name', 'deprecated'],
  },
  {
    resource: 'screen-ratios', model: 'screenRatio', label: 'Screen Ratios', group: 'LED',
    titleField: 'ratioLabel', searchFields: ['ratioLabel'],
    fields: [f('minValue', 'decimal', true), f('maxValue', 'decimal', true), f('ratioLabel', 'string', true), DEPRECATED],
    listFields: ['minValue', 'maxValue', 'ratioLabel', 'deprecated'],
  },

  // ── Displays & hardware ──
  {
    resource: 'display-catalog', model: 'displayCatalog', label: 'Display Catalog', group: 'Displays & Hardware',
    titleField: 'model', searchFields: ['model', 'category', 'description'],
    fields: [
      f('category', 'string', true), f('subcategory'), f('sizeInch', 'decimal'), f('model', 'string', true),
      f('description', 'text'), f('usd', 'decimal'), f('listAud', 'decimal'), f('freight', 'decimal'),
      f('totalCost', 'decimal'), f('margin', 'decimal'), f('sell', 'decimal'),
      // AA3a — LCD selection-rule inputs (display characteristics + bracket-row range/portrait).
      f('brand'), f('builtInAndroid', 'boolean'), f('depthMm', 'int'),
      f('minSizeIn', 'int'), f('maxSizeIn', 'int'), f('portraitCapable', 'boolean'),
      DEPRECATED,
    ],
    listFields: ['category', 'sizeInch', 'model', 'brand', 'listAud', 'sell', 'deprecated'],
  },
  {
    resource: 'import-catalog', model: 'importCatalog', label: 'Import Catalog (Philips)', group: 'Displays & Hardware',
    titleField: 'model', searchFields: ['model', 'series', 'description'],
    fields: [
      f('brand', 'string', true), f('series'), f('sizeInch'), f('model', 'string', true),
      f('description', 'text'), f('cost', 'decimal'), f('sell', 'decimal'), f('partNumber'), DEPRECATED,
    ],
    listFields: ['brand', 'series', 'sizeInch', 'model', 'cost', 'sell', 'deprecated'],
  },
  {
    resource: 'mediaplayers', model: 'mediaplayer', label: 'Mediaplayers', group: 'Displays & Hardware',
    titleField: 'name', searchFields: ['name', 'description'],
    fields: [f('name', 'string', true), f('description', 'text'), f('cost', 'decimal', true), DEPRECATED],
    listFields: ['name', 'cost', 'deprecated'],
  },
  {
    resource: 'peripherals', model: 'peripheral', label: 'Peripherals', group: 'Displays & Hardware',
    titleField: 'name', searchFields: ['name', 'description'],
    fields: [f('name', 'string', true), f('description', 'text'), f('cost', 'decimal', true), f('sourceUrl'), DEPRECATED],
    listFields: ['name', 'cost', 'deprecated'],
  },
  {
    resource: 'manufactured-products', model: 'manufacturedProduct', label: 'Manufactured Products', group: 'Displays & Hardware',
    titleField: 'type', searchFields: ['type', 'sizeInch'],
    fields: [f('type', 'string', true), f('sizeInch'), f('brightness', 'int'), f('cost', 'decimal'), f('sell', 'decimal'), DEPRECATED],
    listFields: ['type', 'sizeInch', 'brightness', 'sell', 'deprecated'],
  },

  // ── Labour & support ──
  {
    resource: 'installer-rates', model: 'installerRate', label: 'Installer Rates', group: 'Labour & Support',
    titleField: 'region', searchFields: ['region', 'installer', 'location'],
    fields: [
      f('region', 'string', true), f('location'), f('installer'), f('lcd', 'decimal'), f('led', 'decimal'),
      f('bracket', 'decimal'), f('customWorks', 'decimal'), f('permit', 'decimal'), f('disposal', 'decimal'),
      f('eveningWorks', 'decimal'), f('gst', 'decimal'),
    ],
    listFields: ['region', 'installer', 'lcd', 'led', 'bracket'],
  },
  {
    resource: 'licence-components', model: 'licenceComponent', label: 'Licence Components', group: 'Labour & Support',
    titleField: 'component', searchFields: ['component'],
    fields: [
      f('component', 'string', true), f('tier', 'enum', true, TIER), f('screenType', 'enum', true, SCREEN),
      f('value', 'decimal', true),
    ],
    listFields: ['component', 'tier', 'screenType', 'value'],
  },
  {
    resource: 'hardware-support', model: 'hardwareSupportComponent', label: 'Hardware Support', group: 'Labour & Support',
    titleField: 'component', searchFields: ['component'],
    fields: [
      f('component', 'string', true), f('tier', 'enum', true, TIER), f('screenType', 'enum', true, SCREEN),
      f('value', 'decimal', true),
    ],
    listFields: ['component', 'tier', 'screenType', 'value'],
  },
  {
    resource: 'international-support-rates', model: 'internationalSupportRate', label: 'Intl Support Rates', group: 'Labour & Support',
    titleField: 'partner', searchFields: ['partner', 'region', 'rateLabel'],
    fields: [
      f('partner', 'string', true), f('region', 'string', true), f('rateLabel', 'string', true),
      f('localValue', 'decimal'), f('audValue', 'decimal'), f('sellValue', 'decimal'),
    ],
    listFields: ['partner', 'region', 'rateLabel', 'audValue', 'sellValue'],
  },
  {
    resource: 'international-install-rates', model: 'internationalInstallRate', label: 'Intl Install Rates', group: 'Labour & Support',
    titleField: 'partner', searchFields: ['partner', 'region', 'rateLabel'],
    fields: [f('partner', 'string', true), f('region'), f('rateLabel', 'string', true), f('cost', 'decimal', true)],
    listFields: ['partner', 'region', 'rateLabel', 'cost'],
  },

  // ── Add-ons ──
  {
    resource: 'software-activities', model: 'softwareActivity', label: 'Software Activities', group: 'Add-ons',
    titleField: 'activity', searchFields: ['activity'],
    fields: [f('activity', 'string', true), f('cost', 'decimal', true), f('sell', 'decimal', true), f('ratio', 'decimal'), DEPRECATED],
    listFields: ['activity', 'cost', 'sell', 'deprecated'],
  },
  {
    resource: 'audio-products', model: 'audioProduct', label: 'Audio Products', group: 'Add-ons',
    titleField: 'name', searchFields: ['name', 'category'],
    fields: [f('category', 'string', true), f('name', 'string', true), f('sourceUrl'), f('cost', 'decimal'), f('sell', 'decimal'), DEPRECATED],
    listFields: ['category', 'name', 'cost', 'sell', 'deprecated'],
  },
  {
    resource: 'music-services', model: 'musicService', label: 'Music Services', group: 'Add-ons',
    titleField: 'name', searchFields: ['name', 'category'],
    fields: [f('category', 'string', true), f('name', 'string', true), f('cost', 'decimal'), f('sell', 'decimal'), f('sqmMin', 'int'), f('sqmMax', 'int'), DEPRECATED],
    listFields: ['category', 'name', 'cost', 'sell', 'deprecated'],
  },
  {
    resource: 'hypervsn-products', model: 'hypervsnProduct', label: 'Hypervsn Products', group: 'Add-ons',
    titleField: 'name', searchFields: ['name', 'category'],
    fields: [f('category', 'string', true), f('name', 'string', true), f('sellAud', 'decimal'), f('resellerAud', 'decimal'), f('sellNzd', 'decimal'), f('resellerNzd', 'decimal'), DEPRECATED],
    listFields: ['category', 'name', 'sellAud', 'sellNzd', 'deprecated'],
  },

  // ── Clients ──
  {
    resource: 'clients', model: 'client', label: 'Clients', group: 'Clients',
    titleField: 'name', searchFields: ['name', 'marginNote', 'preferredProductFamily'],
    fields: [
      f('name', 'string', true), f('tier', 'enum', false, CLIENT_TIER),
      f('defaultMargin', 'decimal'), f('discountPct', 'decimal'),
      f('preferredProductFamily'),
      f('preferredPitchMm', 'decimal'), f('excludedComponents'),
      f('allowedRatios'),
      f('preferredFreight'), f('rulesNote', 'text'), f('marginNote', 'text'),
      f('ledScreenNote', 'text'), f('gobNote', 'text'), f('mediaplayerNote', 'text'), f('ratioNote', 'text'),
    ],
    listFields: ['name', 'tier', 'defaultMargin', 'preferredProductFamily'],
  },

  // ── Clients: tier-level rule-bearing entities (Z6) ──
  {
    resource: 'client-tiers', model: 'clientTier', label: 'Client Tiers', group: 'Clients',
    titleField: 'name', searchFields: ['name', 'label', 'description'],
    fields: [
      f('name', 'string', true), f('label'), f('description', 'text'),
      f('installStandard'), f('preferredFreight'), f('defaultDiscountPct', 'decimal'),
      DEPRECATED,
    ],
    listFields: ['name', 'preferredFreight', 'defaultDiscountPct'],
  },

  // ── System: anomaly rules (Z1) ──
  {
    resource: 'anomaly-rules', model: 'anomalyRule', label: 'Anomaly Rules', group: 'System',
    titleField: 'label', searchFields: ['key', 'label', 'description'],
    fields: [
      f('key', 'string', true), f('label', 'string', true), f('description', 'text'),
      f('enabled', 'boolean'), f('severity', 'enum', false, ANOMALY_SEVERITY),
      f('paramNum', 'decimal'), f('paramText'),
    ],
    listFields: ['label', 'severity', 'enabled', 'paramNum'],
  },
];

export const TABLE_BY_RESOURCE = new Map(TABLES.map((t) => [t.resource, t]));
