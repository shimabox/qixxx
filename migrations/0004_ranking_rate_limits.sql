CREATE TABLE ranking_rate_limits (
  ip_hash TEXT PRIMARY KEY,
  window_index INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_ranking_rate_limits_window
  ON ranking_rate_limits(window_index);
