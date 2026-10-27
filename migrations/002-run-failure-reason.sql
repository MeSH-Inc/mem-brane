-- Why a stopped run stopped. The user sees a cause-specific message and the operator
-- can count causes; NULL for runs that completed, were cancelled or are still active.
ALTER TABLE runs ADD COLUMN failure_reason TEXT CHECK(failure_reason IN ('preflight','provider','stalled','deadline','output_limit','shutdown','lease_expired'));
