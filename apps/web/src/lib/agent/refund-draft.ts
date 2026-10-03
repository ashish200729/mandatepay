import type { RefundDraft } from "./types";

const STORAGE_PREFIX = "mandatepay:refund-review:";
export const REFUND_DRAFT_LIFETIME_MS = 5 * 60 * 1_000;

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readRefundDraft(value: unknown): RefundDraft {
  if (typeof value !== "object" || value === null)
    throw new Error("The refund draft was not valid.");
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.paymentId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(draft.paymentId) ||
    (draft.amountMinor !== null &&
      (typeof draft.amountMinor !== "number" ||
        !Number.isSafeInteger(draft.amountMinor) ||
        draft.amountMinor <= 0)) ||
    typeof draft.reason !== "string" ||
    !draft.reason.trim() ||
    draft.reason.trim().length > 255
  )
    throw new Error("The refund draft was not valid.");
  const reviewUrl = `/orders/${encodeURIComponent(draft.paymentId)}`;
  if (draft.reviewUrl !== undefined && draft.reviewUrl !== reviewUrl)
    throw new Error("The refund review destination was not valid.");
  return {
    paymentId: draft.paymentId,
    amountMinor: draft.amountMinor as number | null,
    reason: draft.reason.trim(),
    reviewUrl,
  };
}

export function saveRefundDraft(
  value: RefundDraft,
  storage: DraftStorage = window.sessionStorage,
  now = Date.now(),
) {
  const draft = readRefundDraft(value);
  storage.setItem(
    `${STORAGE_PREFIX}${draft.paymentId}`,
    JSON.stringify({
      paymentId: draft.paymentId,
      amountMinor: draft.amountMinor,
      reason: draft.reason,
      expiresAt: now + REFUND_DRAFT_LIFETIME_MS,
    }),
  );
}

export function consumeRefundDraft(
  paymentId: string,
  storage?: DraftStorage,
  now = Date.now(),
): RefundDraft | null {
  try {
    const source = storage ?? window.sessionStorage;
    const key = `${STORAGE_PREFIX}${paymentId}`;
    const serialized = source.getItem(key);
    if (serialized === null) return null;
    source.removeItem(key);
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== "object" || value === null) return null;
    const saved = value as Record<string, unknown>;
    if (
      saved.paymentId !== paymentId ||
      typeof saved.expiresAt !== "number" ||
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt <= now ||
      saved.expiresAt > now + REFUND_DRAFT_LIFETIME_MS
    )
      return null;
    return readRefundDraft(saved);
  } catch {
    return null;
  }
}
