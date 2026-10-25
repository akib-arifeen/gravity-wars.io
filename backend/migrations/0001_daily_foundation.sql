-- Local-only D1 schema for the daily challenge foundation.
--
-- Nothing here identifies a person: actor_hash is an HMAC of the request IP under a server
-- secret, and tokens/nonces are stored only as SHA-256 digests. No raw IP, name, email or client
-- storage id is persisted.

CREATE TABLE IF NOT EXISTS leagues (
  -- "daily:<UTC date>:v<ruleset>" — one row per day and ruleset.
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  ruleset_version INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  arena TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (date, ruleset_version)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  actor_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  assisted INTEGER NOT NULL CHECK (assisted IN (0, 1)),
  ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  submission_id TEXT
);

CREATE INDEX IF NOT EXISTS runs_actor_issued ON runs (actor_hash, issued_at);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  league_id TEXT NOT NULL REFERENCES leagues(id),
  actor_hash TEXT NOT NULL,
  -- The replay's peak mass. This, never the client's claimed number, is the score.
  score INTEGER NOT NULL CHECK (score >= 0),
  claimed_score INTEGER NOT NULL,
  trace_hash TEXT NOT NULL,
  trace_steps INTEGER NOT NULL,
  assisted INTEGER NOT NULL CHECK (assisted IN (0, 1)),
  ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  submitted_at INTEGER NOT NULL,
  replay_ms INTEGER NOT NULL,
  engine TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS submissions_board
  ON submissions (league_id, ranked, verified, score DESC, submitted_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS submissions_actor_submitted ON submissions (actor_hash, submitted_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  actor_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, actor_hash, window_start)
);
