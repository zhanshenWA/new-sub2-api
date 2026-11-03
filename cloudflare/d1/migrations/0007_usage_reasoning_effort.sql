-- Capture the requested effort separately from token usage; old records remain NULL.
ALTER TABLE usage_logs ADD COLUMN reasoning_effort TEXT;
