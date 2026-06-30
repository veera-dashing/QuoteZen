import { prisma } from '@quotezen/db';
import type { ReviewDecision, ReviewStage } from '@quotezen/shared';
import { recordAudit } from '../../services/audit.js';
import { AppError } from '../../errors.js';
import { getQuote, type Actor } from './service.js';
import { quoteInclude } from './repository.js';

/**
 * Two-stage Review & Approval (T1 / BR-001, FR-102–110).
 *
 * The platform's core rule: no quotation issues without human review. Review is split into a
 * technical stage then a commercial stage. Each decision is recorded against the SPECIFIC revision
 * it was made on (`lockVersion`); rows are immutable and never deleted, so the approval history is
 * preserved across revisions (FR-110). The hard gate on issuing lives in `changeStatus` (BR-001).
 */

export interface ReviewRow {
  id: string;
  stage: ReviewStage;
  decision: ReviewDecision;
  lockVersion: number;
  comment: string | null;
  reviewer: { id: string; name: string } | null;
  createdAt: string;
}

/** Whether BOTH stages have an `approved` review against this exact revision (BR-001 gate). */
export interface ReviewGate {
  technicalApproved: boolean;
  commercialApproved: boolean;
  bothApproved: boolean;
  /** The revision (lockVersion) the gate was evaluated for. */
  lockVersion: number;
}

const STAGE_NEXT: Record<ReviewStage, 'technical_review' | 'commercial_review' | 'approved'> = {
  technical: 'commercial_review',
  commercial: 'approved',
};

/**
 * Has the quote got an `approved` review at `stage` for revision `lockVersion`? An approval only
 * counts for the revision it was signed off on — editing the quote bumps lockVersion, so prior
 * approvals no longer satisfy the gate (the quote must be re-reviewed). FR-110.
 */
export const reviewGateFor = async (quoteId: bigint, lockVersion: number): Promise<ReviewGate> => {
  const approved = await prisma.quoteReview.findMany({
    where: { quoteId, lockVersion, decision: 'approved' },
    select: { stage: true },
  });
  const stages = new Set(approved.map((r) => r.stage));
  const technicalApproved = stages.has('technical');
  const commercialApproved = stages.has('commercial');
  return {
    technicalApproved,
    commercialApproved,
    bothApproved: technicalApproved && commercialApproved,
    lockVersion,
  };
};

/** Full, immutable review history for a quote (most recent first). */
export const listReviews = async (quoteId: bigint): Promise<ReviewRow[]> => {
  await getQuote(quoteId); // 404 if missing
  const rows = await prisma.quoteReview.findMany({
    where: { quoteId },
    orderBy: { createdAt: 'desc' },
    include: { reviewer: { select: { id: true, name: true } } },
  });
  return rows.map((r) => ({
    id: r.id.toString(),
    stage: r.stage as ReviewStage,
    decision: r.decision as ReviewDecision,
    lockVersion: r.lockVersion,
    comment: r.comment,
    reviewer: r.reviewer ? { id: r.reviewer.id.toString(), name: r.reviewer.name } : null,
    createdAt: r.createdAt.toISOString(),
  }));
};

/**
 * Record a review decision and advance/kick-back the workflow (T1):
 *  - technical + approved  → status `commercial_review`
 *  - commercial + approved → status `approved`
 *  - either + rejected     → kicked back to `in_review` (so it re-enters the review pipeline)
 *
 * The decision captures the CURRENT `lockVersion` (the revision being signed off). The review row,
 * the status change, and the audit entry all commit in one transaction. Reviews are never deleted.
 */
export const recordReview = async (
  actor: Actor,
  quoteId: bigint,
  stage: ReviewStage,
  decision: ReviewDecision,
  comment?: string,
) => {
  const quote = await getQuote(quoteId);
  const lockVersion = quote.lockVersion;

  const nextStatus = decision === 'approved' ? STAGE_NEXT[stage] : 'in_review';

  return prisma.$transaction(async (tx) => {
    const review = await tx.quoteReview.create({
      data: {
        quoteId,
        lockVersion,
        stage,
        decision,
        reviewerId: actor.id,
        comment: comment ?? null,
      },
    });

    // Advance/kick-back the status. Deliberately do NOT bump lockVersion: it is the CONTENT/revision
    // token, and both stage approvals must land on the SAME revision to satisfy the BR-001 gate.
    // Only genuine content edits (PATCH) bump it — which correctly re-arms the gate (FR-110).
    const updated = await tx.quote.update({
      where: { id: quoteId },
      data: { status: nextStatus, updatedById: actor.id },
      include: quoteInclude,
    });

    await recordAudit(tx, {
      quoteId,
      userId: actor.id,
      action: 'status_change',
      entityTable: 'quote_reviews',
      entityId: review.id,
      changes: [
        { field: `review:${stage}`, oldValue: null, newValue: decision },
        { field: 'status', oldValue: quote.status, newValue: nextStatus },
        ...(comment ? [{ field: `review:${stage}:comment`, oldValue: null, newValue: comment }] : []),
        { field: 'review_revision', oldValue: null, newValue: `v${lockVersion}` },
      ],
    });

    return updated;
  });
};

/**
 * BR-001 hard gate: throw unless BOTH a technical AND a commercial `approved` review exist for the
 * quote's CURRENT revision. Admins MAY NOT bypass this — human review is absolute. Used by
 * `changeStatus` when transitioning to `issued`.
 */
export const assertIssueReviews = async (quoteId: bigint, lockVersion: number): Promise<void> => {
  const gate = await reviewGateFor(quoteId, lockVersion);
  if (gate.bothApproved) return;
  const missing: string[] = [];
  if (!gate.technicalApproved) missing.push('technical');
  if (!gate.commercialApproved) missing.push('commercial');
  throw new AppError(
    'conflict',
    `Cannot issue: BR-001 requires human review and approval. Missing ${missing.join(' and ')} review approval for the current revision (v${lockVersion}). This cannot be bypassed.`,
    { missing, lockVersion },
  );
};
