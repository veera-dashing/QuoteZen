/** Mirrors the API's table registry (apps/api/src/modules/admin/registry.ts), served via /admin/_meta. */
export type FieldType = 'string' | 'text' | 'int' | 'decimal' | 'boolean' | 'date' | 'enum';

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: string[];
  /** Numeric bounds from the admin registry (fraction fields such as margin/discount). */
  min?: number;
  lessThan?: number;
  /** Stored as a fraction (0.3) but shown and entered as a percentage (30). */
  percent?: boolean;
}

export interface TableDef {
  resource: string;
  model: string;
  label: string;
  group: string;
  titleField: string;
  fields: FieldDef[];
  listFields: string[];
  searchFields: string[];
  readonly?: boolean;
}

export interface ListResponse<T = Record<string, unknown>> {
  rows: T[];
  total: number;
  take: number;
  skip: number;
}

export type Row = Record<string, unknown>;
