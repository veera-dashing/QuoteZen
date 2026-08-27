import PDFDocument from 'pdfkit';
import type { ScreenRatioRow } from '@quotezen/calc';
import type { QuoteWithChildren } from './repository.js';
import { DEFAULT_ASSUMPTIONS, DEFAULT_EXCLUSIONS, DEFAULT_TERMS, buildDescriptions, lcdOrderList, sortedRisks } from './outputs.js';

const money = (v: { toString(): string } | null | undefined, code: string): string =>
  `${code} ${Number(v ?? 0).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;

/**
 * Render a client-facing quote PDF (offline, via pdfkit — no headless browser). Returns the full
 * document as a Buffer so it can be sent in one response.
 */
export const buildQuotePdf = (
  quote: QuoteWithChildren,
  ratios?: readonly ScreenRatioRow[],
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const code = quote.currency?.code ?? 'AUD';
    const L = 50;
    const CONTENT_W = 495;
    const RIGHT_X = 410;
    const RIGHT_W = 135;

    const heading = (t: string) => {
      doc.moveDown(0.6).fontSize(13).fillColor('#111');
      doc.text(t, L, doc.y, { width: CONTENT_W });
      doc.moveDown(0.2);
      doc.x = L;
    };
    const line = (l: string, r: string) => {
      const y = doc.y;
      doc.fontSize(10).fillColor('#333').text(l, L, y, { width: 360 });
      const leftEnd = doc.y;
      doc.text(r, RIGHT_X, y, { width: RIGHT_W, align: 'right' });
      const rightEnd = doc.y;
      doc.x = L;
      doc.y = Math.max(leftEnd, rightEnd);
    };

    // Header
    doc.fontSize(18).fillColor('#111').text('Seen Technology', L, doc.y, { width: CONTENT_W });
    doc.moveDown(0.3).fontSize(16).fillColor('#111').text(`Quote ${quote.jobReference}`);
    doc.fontSize(10).fillColor('#666')
      .text(`Client: ${quote.client?.name ?? '—'}`)
      .text(`Status: ${quote.status}`)
      .text(`Currency: ${code}`);
    if (quote.validUntil) doc.text(`Valid until: ${new Date(quote.validUntil).toLocaleDateString()}`);

    // LED screens — deterministic descriptions (P1-18.1)
    const descriptions = new Map(buildDescriptions(quote, ratios).map((d) => [d.screenId, d.description]));
    if (quote.ledScreens.length > 0) {
      heading('LED screens');
      for (const s of quote.ledScreens) {
        line(descriptions.get(s.id.toString()) ?? s.screenName ?? 'LED screen', money(s.priceTotal, code));
      }
    }
    // LCD screens — deterministic descriptions (tab B2) + order list (tab B56).
    if (quote.lcdScreens.length > 0) {
      heading('LCD displays');
      for (const s of quote.lcdScreens) {
        line(descriptions.get(s.id.toString()) ?? s.screenName ?? 'LCD', money(s.priceTotal, code));
        const order = lcdOrderList(s);
        if (order) doc.fontSize(8).fillColor('#888').text(`Order list: ${order}`, L, doc.y, { width: CONTENT_W });
      }
    }
    // Licences
    if (quote.licences.length > 0) {
      heading('Licences & support (annual)');
      for (const l of quote.licences) {
        line(`${l.screenType} · ${l.tier} · ${l.qty} screen(s)${l.isInteractive ? ' · interactive' : ''}`, '');
      }
    }

    // Totals
    heading('Totals');
    line('Equipment', money(quote.totalEquipment, code));
    line('Services', money(quote.totalServices, code));
    line('Recurring / yr', money(quote.totalRecurring, code));
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor('#111');
    const y = doc.y;
    doc.text('Grand total', L, y, { width: 360 });
    const grandLeftEnd = doc.y;
    doc.text(money(quote.grandTotal, code), RIGHT_X, y, { width: RIGHT_W, align: 'right' });
    doc.x = L;
    doc.y = Math.max(grandLeftEnd, doc.y);

    // Assumptions / exclusions / terms (P1-18.2, BR-090/091)
    // Render the quote's STORED terms grouped by kind, falling back to the DEFAULT_* constants for
    // any group with no stored rows — never a silently-blank section.
    const bullets = (title: string, items: readonly string[]) => {
      heading(title);
      doc.fontSize(9).fillColor('#444');
      for (const it of items) doc.text(`•  ${it}`, L, doc.y, { width: CONTENT_W });
    };
    const storedOf = (kind: string): string[] =>
      quote.terms.filter((t) => t.kind === kind).map((t) => t.text);
    const grouped = (kind: string, fallback: readonly string[]): readonly string[] => {
      const stored = storedOf(kind);
      return stored.length > 0 ? stored : fallback;
    };
    bullets('Assumptions', grouped('assumption', DEFAULT_ASSUMPTIONS));
    bullets('Exclusions', grouped('exclusion', DEFAULT_EXCLUSIONS));
    bullets('Terms & conditions', grouped('term', DEFAULT_TERMS));

    // Manual risks register (T4): grouped/sorted by severity (high → low); high highlighted red.
    const risks = sortedRisks(quote);
    if (risks.length > 0) {
      heading('Risks');
      doc.fontSize(9);
      for (const r of risks) {
        const high = r.severity === 'high';
        doc.fillColor(high ? '#dc2626' : '#444');
        const sev = r.severity.toUpperCase();
        doc.text(`•  [${sev} · ${r.category}] ${r.description}`, L, doc.y, { width: CONTENT_W });
        if (r.mitigation) {
          doc.fillColor('#666').text(`     Mitigation: ${r.mitigation}`, L, doc.y, { width: CONTENT_W });
        }
      }
    }

    doc.moveDown(1.5).fontSize(8).fillColor('#999')
      .text('All prices ex-GST. Generated by QuoteZen.', { align: 'center' });

    doc.end();
  });
