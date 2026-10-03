import { createHash } from "node:crypto";

export interface ProposalFingerprintInput {
  userId: string;
  mandateId: string;
  mandateVersionId: string;
  productSnapshotId: string;
  quantity: number;
  subtotal: bigint;
  shipping: bigint;
  tax: bigint;
  total: bigint;
  currency: string;
}

export function proposalFingerprint(input: ProposalFingerprintInput): string {
  const canonical = JSON.stringify({
    currency: input.currency,
    mandateId: input.mandateId,
    mandateVersionId: input.mandateVersionId,
    productSnapshotId: input.productSnapshotId,
    quantity: input.quantity,
    shipping: input.shipping.toString(),
    subtotal: input.subtotal.toString(),
    tax: input.tax.toString(),
    total: input.total.toString(),
    userId: input.userId,
  });

  return createHash("sha256").update(canonical).digest("hex");
}
