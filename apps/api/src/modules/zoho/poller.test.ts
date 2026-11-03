import { describe, expect, it } from 'vitest';
import { criteriaValue } from './client.js';
import { dealsToQueue } from './poller.js';

describe('dealsToQueue (polling selection)', () => {
  const deals = [
    { id: '1', Modified_Time: '2026-10-15T06:00:00+05:30' },
    { id: '2', Modified_Time: '2026-10-15T07:00:00+05:30' },
    { id: '3', Modified_Time: '2026-10-15T08:00:00+05:30' },
  ];

  it('queues ready deals that have no quote yet', () => {
    expect(dealsToQueue(deals, new Set(['2']), new Map())).toEqual(['1', '3']);
  });

  it('does not re-read a deal already attempted at the same Modified_Time (AI quota guard)', () => {
    const attempted = new Map([['1', '2026-10-15T06:00:00+05:30']]);
    expect(dealsToQueue(deals, new Set(), attempted)).toEqual(['2', '3']);
  });

  it('retries a previously skipped deal once it has been edited in Zoho', () => {
    const attempted = new Map([['1', '2026-10-14T09:00:00+05:30']]);
    expect(dealsToQueue(deals, new Set(['2', '3']), attempted)).toEqual(['1']);
  });
});

describe('criteriaValue (Zoho search escaping)', () => {
  it('escapes the characters that are search-criteria syntax', () => {
    expect(criteriaValue('Proposal/Price Quote')).toBe('Proposal/Price Quote');
    expect(criteriaValue('Quote (ready), now')).toBe('Quote \\(ready\\)\\, now');
  });
});
