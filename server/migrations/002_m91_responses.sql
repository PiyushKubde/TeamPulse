-- M91 alert lifecycle: the person's answer and when the alert was closed (columns only; nothing is dropped).
ALTER TABLE alert_deliveries ADD COLUMN task_id TEXT;
ALTER TABLE alert_deliveries ADD COLUMN response_label TEXT;
ALTER TABLE alert_deliveries ADD COLUMN response_effect TEXT;
ALTER TABLE alert_deliveries ADD COLUMN response_note TEXT;
ALTER TABLE alert_deliveries ADD COLUMN responded_by TEXT;
ALTER TABLE alert_deliveries ADD COLUMN responded_at TEXT;
ALTER TABLE alert_deliveries ADD COLUMN closed_at TEXT;
CREATE INDEX alert_deliveries_task ON alert_deliveries(task_id, closed_at);
