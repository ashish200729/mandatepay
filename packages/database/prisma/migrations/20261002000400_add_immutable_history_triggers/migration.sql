CREATE OR REPLACE FUNCTION mandatepay_reject_immutable_history_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable history row cannot be changed: %.%', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_event_immutable_history
BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();

CREATE TRIGGER policy_decision_immutable_history
BEFORE UPDATE OR DELETE ON "PolicyDecision"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();

CREATE TRIGGER mandate_version_immutable_history
BEFORE UPDATE OR DELETE ON "MandateVersion"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();

CREATE TRIGGER mandate_rule_immutable_history
BEFORE UPDATE OR DELETE ON "MandateRule"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();

CREATE TRIGGER product_snapshot_immutable_history
BEFORE UPDATE OR DELETE ON "ProductSnapshot"
FOR EACH ROW EXECUTE FUNCTION mandatepay_reject_immutable_history_change();
