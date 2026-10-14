import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { mimeFromFileName, parseExtraction } from './extract.js';

const screen = {
  name: 'Entrance',
  quantity: 1,
  screenType: 'LED',
  environment: 'indoor',
  windowFacing: true,
  widthMm: 2400,
  heightMm: 1350,
  sizeInches: null,
  orientation: 'landscape',
  allowRotation: false,
  pixelPitchMm: null,
  viewingDistanceMinM: 8,
  viewingDistanceMaxM: 10,
  notes: null,
};

const valid = {
  isQuoteRequest: true,
  client: 'Harbour Retail Pty Ltd',
  contactName: null,
  city: 'Perth',
  state: 'WA',
  siteArea: null,
  installDeadlineText: 'before 15 February 2027',
  installDeadlineDate: '2027-02-15',
  budgetAud: 60000,
  screens: [screen],
  missingInfo: [],
  conflicts: [],
};

describe('mimeFromFileName', () => {
  it('maps the formats the AI can read', () => {
    expect(mimeFromFileName('brief.PDF')).toBe('application/pdf');
    expect(mimeFromFileName('site.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeFromFileName('email.txt')).toBe('text/plain');
    expect(mimeFromFileName('wall photo.jpeg')).toBe('image/jpeg');
  });

  it('returns null for formats it cannot read yet (skipped, not sent)', () => {
    expect(mimeFromFileName('schedule.xlsx')).toBeNull();
    expect(mimeFromFileName('plan.dwg')).toBeNull();
    expect(mimeFromFileName('no-extension')).toBeNull();
  });
});

describe('parseExtraction', () => {
  it('accepts a well-formed answer', () => {
    expect(parseExtraction(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects non-JSON text as an upstream error', () => {
    expect(() => parseExtraction('Sure! Here is the data: {')).toThrow(AppError);
  });

  it('rejects a range squeezed into a number field ("8-10")', () => {
    const bad = { ...valid, screens: [{ ...screen, viewingDistanceMinM: '8-10' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(/did not match the intake form/);
  });

  it('rejects values outside the allowed options', () => {
    const bad = { ...valid, screens: [{ ...screen, environment: 'semi-outdoor' }] };
    expect(() => parseExtraction(JSON.stringify(bad))).toThrow(AppError);
  });
});
