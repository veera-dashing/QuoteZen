import { describe, expect, it } from 'vitest';
import { quotePdfFileName } from './quote-pdf.js';

describe('quotePdfFileName', () => {
  it('names the attachment by job reference + revision, so each approved revision is kept', () => {
    expect(quotePdfFileName('ZOHO-1455535000000553097', 1)).toBe('Quote-ZOHO-1455535000000553097-rev1.pdf');
    expect(quotePdfFileName('ZOHO-1455535000000553097', 4)).toBe('Quote-ZOHO-1455535000000553097-rev4.pdf');
  });

  it('makes free-text job references safe as a file name', () => {
    expect(quotePdfFileName('2026-041 Accent / Highpoint', 2)).toBe('Quote-2026-041_Accent_Highpoint-rev2.pdf');
  });
});
