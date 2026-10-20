/**
 * reviewSync.service.ts — on-chain review ↔ Supabase reconciliation.
 *
 * Responsibilities:
 *   - Ingest on-chain review events and reconcile them with off-chain DB rows
 *   - Detect mismatches (rating/comment diverge), missing DB reviews,
 *     orphaned on-chain reviews, and duplicates
 *   - Queue problematic reviews in `review_repair_queue` for admin repair
 *   - Preserve immutable on-chain references (on_chain_id, on_chain_timestamp,
 *     on_chain_tx_hash, on_chain_ledger) — these are never overwritten by
 *     off-chain moderation
 *   - Maintain off-chain moderation projections separately from chain data
 *     so moderation visibility changes never rewrite the on-chain record
 *
 * # On-chain vs off-chain field mapping
 *
 *   On-chain (Soroban Review struct)     Off-chain (reviews table)
 *   ─────────────────────────────────    ──────────────────────────
 *   id        (u64)                  →   on_chain_id    (BIGINT, immutable)
 *   reviewee  (Address)              →   target_id       (UUID, via wallet lookup)
 *   reviewer  (Address)              →   reviewer_id     (UUID, via wallet lookup)
 *   rating    (u32)                  →   original_rating (SMALLINT, immutable)
 *   comment   (String)               →   original_comment (TEXT, immutable)
 *   timestamp (u64)                  →   on_chain_timestamp (BIGINT, immutable)
 *
 *   Moderation-only fields (never on-chain):
 *     moderation_status, moderation_state, visibility, moderation_explanation,
 *     moderation_policy_version, moderation_policy_code, appeal_*
 *
 * The `comment` and `rating` columns in the reviews table are the
 * *displayed* values — they may be adjusted by moderation (e.g. hidden).
 * The `original_comment` and `original_rating` columns are immutable
 * snapshots of what was submitted on-chain and are never modified.
 */

import {
  REVIEW_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  STELLAR_RPC_URL,
  NETWORK,
  assertNetworkConfigured,
  isNetworkMismatch,
} from '@/blockchain/config.js';
import { ReviewClient } from '@/blockchain/reviewClient.js';
import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';
import type { Review as ChainReview } from '@/blockchain/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReconciliationStatus =
  | 'none'
  | 'pending'
  | 'matched'
  | 'mismatched'
  | 'missing'
  | 'orphaned';

export type RepairIssueType = 'mismatched' | 'missing' | 'orphaned' | 'duplicate';
export type RepairStatus = 'open' | 'in_progress' | 'resolved' | 'wont_fix';

export interface ReviewRepairTask {
  id: string;
  review_id: string | null;
  on_chain_id: number | null;
  issue_type: RepairIssueType;
  details: Record<string, unknown>;
  status: RepairStatus;
  assigned_to: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DBReview {
  id: string;
  on_chain_id: number | null;
  rating: number;
  comment: string | null;
  original_rating: number | null;
  original_comment: string | null;
  reviewer_id: string;
  target_id: string;
  reconciliation_status: ReconciliationStatus;
  on_chain_timestamp: number | null;
  on_chain_tx_hash: string | null;
  on_chain_ledger: number | null;
}

// ─── Confirmation tracking ───────────────────────────────────────────────────

export type ChainConfirmationStatus =
  | 'not_found'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'unresolved';

export interface ChainConfirmationResult {
  status: ChainConfirmationStatus;
  txHash: string;
  network: string;
  ledger?: number;
  error?: string;
}

/** Bounded polling defaults for confirmation tracking. */
const CONFIRMATION_POLL_INITIAL_MS = 1_000;
const CONFIRMATION_POLL_MAX_MS = 8_000;
const CONFIRMATION_POLL_DEADLINE_MS = 60_000;

// ─── Client builder ──────────────────────────────────────────────────────────

/**
 * Build a review client, refusing to proceed when the configured network is
 * missing or when the caller's expected network does not match the server's.
 */
function buildReviewClient(expectedNetwork?: string): ReviewClient {
  assertNetworkConfigured();
  if (expectedNetwork && isNetworkMismatch(expectedNetwork)) {
    throw new Error(
      `Network mismatch: request targets "${expectedNetwork}" but backend is configured for "${NETWORK}".`,
    );
  }
  return new ReviewClient(REVIEW_CONTRACT_ID, STELLAR_RPC_URL, NETWORK_PASSPHRASE);
}

// ─── Core reconciliation ─────────────────────────────────────────────────────

/**
 * Reconcile a single off-chain review with its on-chain counterpart.
 *
 * Steps:
 *   1. If the review has no `on_chain_id`, skip it (not yet submitted on-chain).
 *   2. Read the on-chain review by its ID.
 *   3. Compare on-chain rating/comment with the immutable original_* snapshots.
 *   4. If they match, set reconciliation_status = 'matched'.
 *   5. If they diverge, set reconciliation_status = 'mismatched' and queue for repair.
 *   6. If the on-chain read fails (review not found), set 'missing' and queue.
 *
 * @param reviewId - UUID of the off-chain review row
 */
export async function reconcileReview(
  reviewId: string,
  expectedNetwork?: string,
): Promise<ServiceResponse<{ status: ReconciliationStatus }>> {
  if (!REVIEW_CONTRACT_ID) {
    return { success: false, error: 'REVIEW_CONTRACT_ID is not configured' };
  }
  if (expectedNetwork && isNetworkMismatch(expectedNetwork)) {
    return {
      success: false,
      error: `Network mismatch: review was submitted on "${expectedNetwork}" but backend is configured for "${NETWORK}".`,
    };
  }

  // Fetch the DB review row
  const { data: dbRow, error: fetchError } = await supabase
    .from('reviews')
    .select('id, on_chain_id, rating, comment, original_rating, original_comment, reviewer_id, target_id, reconciliation_status, on_chain_timestamp, on_chain_tx_hash, on_chain_ledger')
    .eq('id', reviewId)
    .single();

  if (fetchError || !dbRow) {
    return { success: false, error: 'Review not found' };
  }

  const review = dbRow as DBReview;

  // No on-chain ID — review hasn't been submitted to the chain yet.
  if (!review.on_chain_id) {
    return { success: true, data: { status: 'none' } };
  }

  let client: ReviewClient;
  try {
    client = buildReviewClient(expectedNetwork);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  let chainReview: ChainReview;
  try {
    chainReview = await client.getReview(BigInt(review.on_chain_id));
  } catch (err) {
    // On-chain review not found — mark as missing and queue for repair.
    const message = (err as Error).message;
    if (message.includes('not found') || message.includes('404')) {
      await updateReviewReconciliation(reviewId, 'missing');
      await queueRepair({
        reviewId,
        onChainId: review.on_chain_id,
        issueType: 'missing',
        details: {
          message: 'On-chain review not found',
          dbRating: review.rating,
          onChainId: review.on_chain_id,
        },
      });
      return { success: true, data: { status: 'missing' } };
    }
    // Transient error — leave status as-is for retry.
    console.error(`[reviewSync] Error reading on-chain review ${review.on_chain_id}:`, message);
    return { success: false, error: message };
  }

  // Compare on-chain data with immutable original snapshots.
  const onChainRating = chainReview.rating;
  const dbOriginalRating = review.original_rating ?? review.rating;
  const dbOriginalComment = review.original_comment ?? review.comment ?? '';

  const ratingMatches = onChainRating === dbOriginalRating;
  const commentMatches = chainReview.comment === dbOriginalComment;

  if (ratingMatches && commentMatches) {
    // Update the immutable on-chain reference fields if not already set.
    const updatePayload: Record<string, unknown> = {
      reconciliation_status: 'matched',
      reconciled_at: new Date().toISOString(),
    };

    // Store the immutable on-chain timestamp if not already present.
    if (review.on_chain_timestamp === null) {
      updatePayload.on_chain_timestamp = Number(chainReview.timestamp);
    }

    await supabase.from('reviews').update(updatePayload).eq('id', reviewId);
    return { success: true, data: { status: 'matched' } };
  }

  // Mismatch detected — queue for repair.
  const mismatchDetails: Record<string, unknown> = {
    onChainRating: onChainRating,
    dbOriginalRating,
    dbDisplayedRating: review.rating,
    onChainComment: chainReview.comment,
    dbOriginalComment,
    ratingMatches,
    commentMatches,
  };

  await updateReviewReconciliation(reviewId, 'mismatched');
  await queueRepair({
    reviewId,
    onChainId: review.on_chain_id,
    issueType: 'mismatched',
    details: mismatchDetails,
  });

  console.warn(
    `[reviewSync] Mismatch detected for review ${reviewId} (on_chain_id=${review.on_chain_id}):`,
    mismatchDetails,
  );

  return { success: true, data: { status: 'mismatched' } };
}

/**
 * Detect orphaned on-chain reviews — reviews that exist on-chain but have no
 * corresponding off-chain DB row.
 *
 * Iterates from on-chain ID 1 to the current review count and checks whether
 * each has a matching DB row.  Orphans are queued for repair.
 *
 * @returns Counts of matched, orphaned, and errored reviews.
 */
export async function detectOrphanedReviews(): Promise<ServiceResponse<{
  matched: number;
  orphaned: number;
  errors: number;
}>> {
  if (!REVIEW_CONTRACT_ID) {
    return { success: false, error: 'REVIEW_CONTRACT_ID is not configured' };
  }

  let client: ReviewClient;
  try {
    client = buildReviewClient();
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  let totalCount: bigint;
  try {
    totalCount = await client.reviewCount();
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  let matched = 0;
  let orphaned = 0;
  let errors = 0;

  for (let i = 1n; i <= totalCount; i++) {
    const onChainId = Number(i);

    // Check if a DB review exists with this on_chain_id.
    const { data: dbReview, error } = await supabase
      .from('reviews')
      .select('id, reconciliation_status')
      .eq('on_chain_id', onChainId)
      .maybeSingle();

    if (error) {
      errors++;
      continue;
    }

    if (!dbReview) {
      // Orphan detected — on-chain review has no DB counterpart.
      // Check if we've already queued this orphan.
      const { data: existing } = await supabase
        .from('review_repair_queue')
        .select('id')
        .eq('on_chain_id', onChainId)
        .eq('issue_type', 'orphaned')
        .neq('status', 'resolved')
        .maybeSingle();

      if (!existing) {
        await queueRepair({
          reviewId: null,
          onChainId,
          issueType: 'orphaned',
          details: { message: 'On-chain review has no off-chain counterpart', onChainId },
        });
      }
      orphaned++;
    } else {
      matched++;
    }
  }

  return { success: true, data: { matched, orphaned, errors } };
}

/**
 * Detect duplicate on-chain IDs — multiple DB reviews pointing to the same
 * on_chain_id.  This should never happen but can occur due to bugs or
 * race conditions.
 */
export async function detectDuplicateOnChainIds(): Promise<ServiceResponse<{
  duplicates: number;
}>> {
  const { data, error } = await supabase
    .from('reviews')
    .select('on_chain_id')
    .not('on_chain_id', 'is', null);

  if (error) return { success: false, error: error.message };

  const rows = (data ?? []) as { on_chain_id: number }[];
  const counts = new Map<number, number>();
  for (const row of rows) {
    counts.set(row.on_chain_id, (counts.get(row.on_chain_id) ?? 0) + 1);
  }

  let duplicates = 0;
  for (const [onChainId, count] of counts) {
    if (count > 1) {
      duplicates++;
      await queueRepair({
        reviewId: null,
        onChainId,
        issueType: 'duplicate',
        details: { message: `${count} DB reviews point to the same on_chain_id`, onChainId, count },
      });
    }
  }

  return { success: true, data: { duplicates } };
}

/**
 * Reconcile all reviews that need attention (status = pending, mismatched, missing).
 *
 * @returns Counts of reconciled and failed reviews.
 */
export async function reconcileAllReviews(): Promise<ServiceResponse<{
  reconciled: number;
  failed: number;
  statuses: Record<ReconciliationStatus, number>;
}>> {
  if (!REVIEW_CONTRACT_ID) {
    return { success: false, error: 'REVIEW_CONTRACT_ID is not configured' };
  }

  // Fetch all reviews with an on_chain_id that need reconciliation.
  const { data: reviews, error } = await supabase
    .from('reviews')
    .select('id')
    .not('on_chain_id', 'is', null)
    .in('reconciliation_status', ['pending', 'mismatched', 'missing']);

  if (error) return { success: false, error: error.message };

  let reconciled = 0;
  let failed = 0;
  const statuses: Record<string, number> = {};

  for (const row of (reviews ?? []) as { id: string }[]) {
    try {
      const result = await reconcileReview(row.id);
      if (result.success) {
        reconciled++;
        const status = result.data!.status;
        statuses[status] = (statuses[status] ?? 0) + 1;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }

  return {
    success: true,
    data: {
      reconciled,
      failed,
      statuses: statuses as Record<ReconciliationStatus, number>,
    },
  };
}

// ─── Repair queue management ─────────────────────────────────────────────────

/**
 * Queue a review repair task.  Idempotent — if an open task already exists
 * for the same review and issue type, it is not duplicated.
 */
async function queueRepair(params: {
  reviewId: string | null;
  onChainId: number | null;
  issueType: RepairIssueType;
  details: Record<string, unknown>;
}): Promise<void> {
  // Check for existing open task for the same review + issue type.
  let query = supabase
    .from('review_repair_queue')
    .select('id')
    .eq('issue_type', params.issueType)
    .in('status', ['open', 'in_progress']);

  if (params.reviewId) {
    query = query.eq('review_id', params.reviewId);
  } else {
    query = query.is('review_id', null);
  }

  if (params.onChainId !== null) {
    query = query.eq('on_chain_id', params.onChainId);
  }

  const { data: existing } = await query.maybeSingle();

  if (existing) {
    // Already queued — update the details with the latest findings.
    await supabase
      .from('review_repair_queue')
      .update({ details: params.details })
      .eq('id', existing.id);
    return;
  }

  await supabase.from('review_repair_queue').insert({
    review_id: params.reviewId,
    on_chain_id: params.onChainId,
    issue_type: params.issueType,
    details: params.details,
    status: 'open',
  });
}

/**
 * Update a review's reconciliation status.
 */
async function updateReviewReconciliation(
  reviewId: string,
  status: ReconciliationStatus,
): Promise<void> {
  await supabase
    .from('reviews')
    .update({
      reconciliation_status: status,
      reconciled_at: status === 'matched' ? new Date().toISOString() : null,
    })
    .eq('id', reviewId);
}

/**
 * List repair queue tasks, optionally filtered by status.
 * Admin-only.
 */
export async function getReviewRepairQueue(
  status?: RepairStatus,
): Promise<ServiceResponse<ReviewRepairTask[]>> {
  let query = supabase
    .from('review_repair_queue')
    .select('*')
    .order('created_at', { ascending: true });

  if (status) {
    query = query.eq('status', status);
  } else {
    // Default: show open + in_progress tasks only.
    query = query.in('status', ['open', 'in_progress']);
  }

  const { data, error } = await query;

  if (error) return { success: false, error: error.message };
  return { success: true, data: (data ?? []) as ReviewRepairTask[] };
}

/**
 * Assign a repair task to a moderator.
 */
export async function assignRepairTask(
  taskId: string,
  moderatorId: string,
): Promise<ServiceResponse<ReviewRepairTask>> {
  const { data, error } = await supabase
    .from('review_repair_queue')
    .update({ assigned_to: moderatorId, status: 'in_progress' })
    .eq('id', taskId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!data) return { success: false, error: 'Repair task not found' };

  return { success: true, data: data as ReviewRepairTask };
}

/**
 * Resolve a repair task.  Records the resolution note and auditor.
 *
 * If the review's reconciliation_status is mismatched/missing/orphaned, this
 * also sets it to 'matched' (or 'none' for orphans) to clear the alert.
 *
 * @param taskId        - UUID of the repair queue task
 * @param resolverId    - UUID of the admin resolving the task
 * @param resolutionNote - Explanation of how the issue was resolved
 * @param wontFix        - If true, mark as wont_fix instead of resolved
 */
export async function resolveRepairTask(
  taskId: string,
  resolverId: string,
  resolutionNote: string,
  wontFix = false,
): Promise<ServiceResponse<ReviewRepairTask>> {
  const finalStatus = wontFix ? 'wont_fix' : 'resolved';

  const { data: task, error } = await supabase
    .from('review_repair_queue')
    .update({
      status: finalStatus,
      resolution_note: resolutionNote,
      resolved_by: resolverId,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  if (!task) return { success: false, error: 'Repair task not found' };

  const repairTask = task as ReviewRepairTask;

  // If the task was associated with a DB review, clear the reconciliation alert.
  if (repairTask.review_id) {
    const clearStatus: ReconciliationStatus =
      repairTask.issue_type === 'orphaned' ? 'none' : 'matched';
    await updateReviewReconciliation(repairTask.review_id, clearStatus);
  }

  // Audit log the resolution.
  const { record } = await import('./auditLog.service.js');
  await record(resolverId, 'review_repair.resolve', 'review_repair_queue', taskId, {
    issueType: repairTask.issue_type,
    resolutionNote,
    wontFix,
  });

  return { success: true, data: repairTask };
}

/**
 * Record the on-chain submission metadata after a review is submitted to the
 * Soroban contract.  Stores the immutable chain references.
 *
 * This should be called after the on-chain transaction is confirmed.
 *
 * @param reviewId    - UUID of the off-chain review
 * @param onChainId    - On-chain review ID returned by the contract
 * @param txHash       - Transaction hash of the submit_review transaction
 * @param ledger       - Ledger sequence at which the transaction was included
 * @param timestamp    - On-chain timestamp (Unix seconds from the review struct)
 */
export async function recordOnChainSubmission(
  reviewId: string,
  onChainId: number,
  txHash?: string,
  ledger?: number,
  timestamp?: number,
  expectedNetwork?: string,
): Promise<ServiceResponse<void>> {
  if (expectedNetwork && isNetworkMismatch(expectedNetwork)) {
    return {
      success: false,
      error: `Network mismatch: submission targets "${expectedNetwork}" but backend is configured for "${NETWORK}".`,
    };
  }

  const updatePayload: Record<string, unknown> = {
    on_chain_id: onChainId,
    reconciliation_status: 'pending',
    on_chain_network: NETWORK,
  };

  // Immutable chain references — only set if provided and not already set.
  if (txHash) updatePayload.on_chain_tx_hash = txHash;
  if (ledger !== undefined) updatePayload.on_chain_ledger = ledger;
  if (timestamp !== undefined) updatePayload.on_chain_timestamp = timestamp;

  const { error } = await supabase
    .from('reviews')
    .update(updatePayload)
    .eq('id', reviewId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Track the confirmation status of a submitted review transaction.
 *
 * Uses bounded exponential-backoff polling against the RPC.  Distinguishes
 * not-found, pending, failed, and confirmed outcomes.  When the polling
 * deadline is exceeded the transaction is reported as `unresolved` (never as
 * a final failure) so reconciliation can resolve it later.
 *
 * The DB update is idempotent: a transaction already marked confirmed is not
 * re-applied, and a later poll cannot downgrade a confirmed status.
 *
 * @param reviewId       - UUID of the off-chain review
 * @param txHash         - Transaction hash returned by broadcast
 * @param expectedNetwork - Network the transaction was broadcast on
 */
export async function trackReviewConfirmation(
  reviewId: string,
  txHash: string,
  expectedNetwork?: string,
): Promise<ServiceResponse<ChainConfirmationResult>> {
  if (expectedNetwork && isNetworkMismatch(expectedNetwork)) {
    return {
      success: false,
      error: `Network mismatch: transaction was broadcast on "${expectedNetwork}" but backend is configured for "${NETWORK}".`,
    };
  }

  // Persist the hash + network immediately so reconciliation can find it even
  // if this process dies mid-poll.
  const { error: persistError } = await supabase
    .from('reviews')
    .update({
      on_chain_tx_hash: txHash,
      on_chain_network: NETWORK,
      reconciliation_status: 'pending',
    })
    .eq('id', reviewId);

  if (persistError) return { success: false, error: persistError.message };

  let client: ReviewClient;
  try {
    client = buildReviewClient(expectedNetwork);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  const deadline = Date.now() + CONFIRMATION_POLL_DEADLINE_MS;
  let delay = CONFIRMATION_POLL_INITIAL_MS;
  let lastStatus: ChainConfirmationStatus = 'not_found';

  while (Date.now() < deadline) {
    try {
      const tx = await client.getTransaction(txHash);
      if (tx) {
        if (tx.status === 'SUCCESS') {
          await applyConfirmedStatus(reviewId, txHash, tx.ledger);
          return {
            success: true,
            data: { status: 'confirmed', txHash, network: NETWORK, ledger: tx.ledger },
          };
        }
        if (tx.status === 'FAILED') {
          await applyFailedStatus(reviewId, txHash);
          return {
            success: true,
            data: { status: 'failed', txHash, network: NETWORK, error: 'Transaction failed on-chain' },
          };
        }
        lastStatus = 'pending';
      } else {
        lastStatus = 'not_found';
      }
    } catch (err) {
      // Transient RPC error — keep polling until the deadline.
      console.warn(`[reviewSync] Confirmation poll error for ${txHash}:`, (err as Error).message);
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, CONFIRMATION_POLL_MAX_MS);
  }

  // Deadline exceeded — hand off to reconciliation without implying failure.
  return {
    success: true,
    data: {
      status: 'unresolved',
      txHash,
      network: NETWORK,
      error: `Confirmation not observed within deadline (last status: ${lastStatus}); queued for reconciliation.`,
    },
  };
}

/**
 * Idempotently mark a review transaction as confirmed.  Only transitions from
 * a non-confirmed state; repeated calls are no-ops.
 */
async function applyConfirmedStatus(
  reviewId: string,
  txHash: string,
  ledger?: number,
): Promise<void> {
  const { data: existing } = await supabase
    .from('reviews')
    .select('reconciliation_status, on_chain_ledger')
    .eq('id', reviewId)
    .maybeSingle();

  if (!existing) return;
  if (existing.reconciliation_status === 'matched') return;

  const updatePayload: Record<string, unknown> = {
    reconciliation_status: 'matched',
    reconciled_at: new Date().toISOString(),
    on_chain_tx_hash: txHash,
    on_chain_network: NETWORK,
  };
  if (ledger !== undefined && existing.on_chain_ledger === null) {
    updatePayload.on_chain_ledger = ledger;
  }

  await supabase.from('reviews').update(updatePayload).eq('id', reviewId);
}

/**
 * Idempotently mark a review transaction as failed on-chain.
 */
async function applyFailedStatus(reviewId: string, txHash: string): Promise<void> {
  const { data: existing } = await supabase
    .from('reviews')
    .select('reconciliation_status')
    .eq('id', reviewId)
    .maybeSingle();

  if (!existing) return;
  if (existing.reconciliation_status === 'matched') return;

  await supabase
    .from('reviews')
    .update({
      reconciliation_status: 'mismatched',
      on_chain_tx_hash: txHash,
      on_chain_network: NETWORK,
    })
    .eq('id', reviewId);
}
