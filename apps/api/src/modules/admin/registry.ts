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
    fields: [f('key', 'string', true), f('label', 'string', true), f('value', 'decimal', true), f('unit')],
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
    fields: [f('name', 'string', true), f('rate', 'decimal')],
    listFields: ['name', 'rate'],
  },

  // ── LED ──
  {
    resource: 'led-products', model: 'ledProduct', label: 'LED Products', group: 'LED',
    titleField: 'model', searchFields: ['model', 'vendor', 'cabinetType'],
    fields: [
      f('vendor'), f('model', 'string', true), f('serviceCategory'), f('moduleWMm', 'int'),
      f('moduleHMm', 'int'), f('minCabinetWMm', 'int'), f('minCabinetHMm', 'int'), f('cabinetDepthMm', 'int'),
      f('cabinetType'), f('pixelPitchH', 'decimal'), f('pixelPitchV', 'decimal'), f('brightnessNits', 'int'),
      f('powerMaxW', 'int'), f('powerAvgW', 'int'), f('kgPerSqm', 'decimal'), f('costPerSqmUsd', 'decimal'),
      f('modulePrice', 'decimal'), f('volumetricModifier', 'decimal'), f('includesReceivers', 'boolean'),
      f('gobIncluded', 'boolean'), f('packIncluded', 'boolean'), f('serviceAccess'),
      f('upgradeOptions', 'text'), f('mechanicalOptions', 'text'),
    ],
    listFields: ['vendor', 'model', 'pixelPitchH', 'brightnessNits', 'costPerSqmUsd', 'cabinetType'],
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
    fields: [f('name', 'string', true), f('type'), f('maxPorts', 'int'), f('maxWidth', 'int'), f('price', 'decimal', true)],
    listFields: ['name', 'type', 'maxPorts', 'price'],
  },
  {
    resource: 'led-peripherals', model: 'ledPeripheral', label: 'LED Peripherals', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true)],
    listFields: ['name', 'price'],
  },
  {
    resource: 'gob-options', model: 'gobOption', label: 'GOB Options', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true)],
    listFields: ['name', 'price'],
  },
  {
    resource: 'trim-options', model: 'trimOption', label: 'Trim Options', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('widthMultiplier', 'decimal', true), f('heightMultiplier', 'decimal', true)],
    listFields: ['name', 'widthMultiplier', 'heightMultiplier'],
  },
  {
    resource: 'hanging-bars', model: 'hangingBarOption', label: 'Hanging Bars', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('widthMultiplier', 'decimal', true)],
    listFields: ['name', 'widthMultiplier'],
  },
  {
    resource: 'frames', model: 'frame', label: 'Frames', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true), f('backcoverCost', 'decimal'), f('installHours', 'decimal')],
    listFields: ['name', 'price', 'installHours'],
  },
  {
    resource: 'engineering-options', model: 'engineeringOption', label: 'Engineering Options', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('price', 'decimal', true)],
    listFields: ['name', 'price'],
  },
  {
    resource: 'install-methods', model: 'installMethod', label: 'Install Methods', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('wallRequirement', 'text'), f('powerDataNote', 'text')],
    listFields: ['name'],
  },
  {
    resource: 'access-equipment', model: 'accessEquipment', label: 'Access Equipment', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('dayRate', 'decimal', true)],
    listFields: ['name', 'dayRate'],
  },
  {
    resource: 'warranties', model: 'warrantyOption', label: 'Warranties', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true), f('years', 'int', true)],
    listFields: ['name', 'years'],
  },
  {
    resource: 'service-hours', model: 'serviceHoursOption', label: 'Service Hours', group: 'LED',
    titleField: 'name', searchFields: ['name'],
    fields: [f('name', 'string', true)],
    listFields: ['name'],
  },
  {
    resource: 'screen-ratios', model: 'screenRatio', label: 'Screen Ratios', group: 'LED',
    titleField: 'ratioLabel', searchFields: ['ratioLabel'],
    fields: [f('minValue', 'decimal', true), f('maxValue', 'decimal', true), f('ratioLabel', 'string', true)],
    listFields: ['minValue', 'maxValue', 'ratioLabel'],
  },

  // ── Displays & hardware ──
  {
    resource: 'display-catalog', model: 'displayCatalog', label: 'Display Catalog', group: 'Displays & Hardware',
    titleField: 'model', searchFields: ['model', 'category', 'description'],
    fields: [
      f('category', 'string', true), f('subcategory'), f('sizeInch', 'decimal'), f('model', 'string', true),
      f('description', 'text'), f('usd', 'decimal'), f('listAud', 'decimal'), f('freight', 'decimal'),
      f('totalCost', 'decimal'), f('margin', 'decimal'), f('sell', 'decimal'),
    ],
    listFields: ['category', 'sizeInch', 'model', 'listAud', 'sell'],
  },
  {
    resource: 'import-catalog', model: 'importCatalog', label: 'Import Catalog (Philips)', group: 'Displays & Hardware',
    titleField: 'model', searchFields: ['model', 'series', 'description'],
    fields: [
      f('brand', 'string', true), f('series'), f('sizeInch'), f('model', 'string', true),
      f('description', 'text'), f('cost', 'decimal'), f('sell', 'decimal'), f('partNumber'),
    ],
    listFields: ['brand', 'series', 'sizeInch', 'model', 'cost', 'sell'],
  },
  {
    resource: 'mediaplayers', model: 'mediaplayer', label: 'Mediaplayers', group: 'Displays & Hardware',
    titleField: 'name', searchFields: ['name', 'description'],
    fields: [f('name', 'string', true), f('description', 'text'), f('cost', 'decimal', true)],
    listFields: ['name', 'cost'],
  },
  {
    resource: 'peripherals', model: 'peripheral', label: 'Peripherals', group: 'Displays & Hardware',
    titleField: 'name', searchFields: ['name', 'description'],
    fields: [f('name', 'string', true), f('description', 'text'), f('cost', 'decimal', true), f('sourceUrl')],
    listFields: ['name', 'cost'],
  },
  {
    resource: 'manufactured-products', model: 'manufacturedProduct', label: 'Manufactured Products', group: 'Displays & Hardware',
    titleField: 'type', searchFields: ['type', 'sizeInch'],
    fields: [f('type', 'string', true), f('sizeInch'), f('brightness', 'int'), f('cost', 'decimal'), f('sell', 'decimal')],
    listFields: ['type', 'sizeInch', 'brightness', 'sell'],
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
    fields: [f('activity', 'string', true), f('cost', 'decimal', true), f('sell', 'decimal', true), f('ratio', 'decimal')],
    listFields: ['activity', 'cost', 'sell'],
  },
  {
    resource: 'audio-products', model: 'audioProduct', label: 'Audio Products', group: 'Add-ons',
    titleField: 'name', searchFields: ['name', 'category'],
    fields: [f('category', 'string', true), f('name', 'string', true), f('sourceUrl'), f('cost', 'decimal'), f('sell', 'decimal')],
    listFields: ['category', 'name', 'cost', 'sell'],
  },
  {
    resource: 'music-services', model: 'musicService', label: 'Music Services', group: 'Add-ons',
    titleField: 'name', searchFields: ['name', 'category'],
    fields: [f('category', 'string', true), f('name', 'string', true), f('cost', 'decimal'), f('sell', 'decimal'), f('sqmMin', 'int'), f('sqmMax', 'int')],
    listFields: ['category', 'name', 'cost', 'sell'],
  },
  {
    resource: 'hypervsn-products', model: 'hypervsnProduct', label: 'Hypervsn Products', group: 'Add-ons',
    titleField: 'name', searchFields: ['name', 'category'],
    fields: [f('category', 'string', true), f('name', 'string', true), f('sellAud', 'decimal'), f('resellerAud', 'decimal'), f('sellNzd', 'decimal'), f('resellerNzd', 'decimal')],
    listFields: ['category', 'name', 'sellAud', 'sellNzd'],
  },

  // ── Clients ──
  {
    resource: 'clients', model: 'client', label: 'Clients', group: 'Clients',
    titleField: 'name', searchFields: ['name', 'marginNote'],
    fields: [
      f('name', 'string', true), f('marginNote', 'text'), f('ledScreenNote', 'text'), f('gobNote', 'text'),
      f('mediaplayerNote', 'text'), f('ratioNote', 'text'), f('defaultMargin', 'decimal'),
    ],
    listFields: ['name', 'marginNote'],
  },
];

export const TABLE_BY_RESOURCE = new Map(TABLES.map((t) => [t.resource, t]));
