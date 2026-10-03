-- A fingerprint binds an approval to a proposal's immutable facts. It is not
-- a global identity: two valid proposals may intentionally have the same facts.
DROP INDEX IF EXISTS "PurchaseProposal_proposalFingerprint_key";
