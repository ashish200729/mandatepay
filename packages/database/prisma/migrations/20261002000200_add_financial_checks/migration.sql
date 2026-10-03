-- The application validates these invariants before writes. These database
-- checks keep direct SQL and future services inside the same USD MVP boundary.
ALTER TABLE "Mandate"
  ADD CONSTRAINT "Mandate_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "Mandate_limits_nonnegative_check" CHECK (
    "autoSpendLimit" >= 0
    AND "transactionLimit" >= 0
    AND ("dailyLimit" IS NULL OR "dailyLimit" >= 0)
    AND ("weeklyLimit" IS NULL OR "weeklyLimit" >= 0)
    AND ("monthlyLimit" IS NULL OR "monthlyLimit" >= 0)
  ),
  ADD CONSTRAINT "Mandate_auto_limit_check" CHECK ("autoSpendLimit" <= "transactionLimit");

ALTER TABLE "MandateVersion"
  ADD CONSTRAINT "MandateVersion_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "MandateVersion_limits_nonnegative_check" CHECK (
    "autoSpendLimit" >= 0
    AND "transactionLimit" >= 0
    AND ("dailyLimit" IS NULL OR "dailyLimit" >= 0)
    AND ("weeklyLimit" IS NULL OR "weeklyLimit" >= 0)
    AND ("monthlyLimit" IS NULL OR "monthlyLimit" >= 0)
  ),
  ADD CONSTRAINT "MandateVersion_auto_limit_check" CHECK ("autoSpendLimit" <= "transactionLimit");

ALTER TABLE "ProductSnapshot"
  ADD CONSTRAINT "ProductSnapshot_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "ProductSnapshot_price_nonnegative_check" CHECK ("price" >= 0);

ALTER TABLE "PurchaseProposal"
  ADD CONSTRAINT "PurchaseProposal_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "PurchaseProposal_quantity_positive_check" CHECK ("quantity" > 0),
  ADD CONSTRAINT "PurchaseProposal_amounts_nonnegative_check" CHECK (
    "subtotal" >= 0 AND "shipping" >= 0 AND "tax" >= 0 AND "total" >= 0
  ),
  ADD CONSTRAINT "PurchaseProposal_total_check" CHECK ("total" = "subtotal" + "shipping" + "tax");

ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "Payment_amount_nonnegative_check" CHECK ("amount" >= 0);

ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "Refund_amount_nonnegative_check" CHECK ("amount" >= 0);

ALTER TABLE "SpendReservation"
  ADD CONSTRAINT "SpendReservation_currency_usd_check" CHECK ("currency" = 'USD'),
  ADD CONSTRAINT "SpendReservation_amount_nonnegative_check" CHECK ("amount" >= 0);
