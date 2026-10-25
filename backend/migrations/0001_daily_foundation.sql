-- Local-only D1 schema for the daily challenge foundation.
--
-- No direct identifiers are stored. `actor_id` is an opaque 128-bit id the browser mints and
-- keeps in its own storage: the server never derives it from an IP, so a run follows the browser
-- rather than a network address. It is not authentication — anyone can present any id — so treat
-- it as a pseudonymous client handle, not an account. The request IP is used for one thing only,
-- a rate-limit bucket keyed by `ip_hash`, an HMAC of the IP under a server secret; the raw IP is
-- never stored or logged. Tokens and nonces are stored only as SHA-256 digests. No raw IP, name,
-- email or geo data is persisted.

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
  -- The opaque client id the run is bound to. Not an IP, not a hash of one.
  actor_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  assisted INTEGER NOT NULL CHECK (assisted IN (0, 1)),
  ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  submission_id TEXT,
  -- An assisted run is never ranked. Enforced here as well as in the handler.
  CHECK (assisted = 0 OR ranked = 0)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  league_id TEXT NOT NULL REFERENCES leagues(id),
  actor_id TEXT NOT NULL,
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
  engine TEXT NOT NULL,
  -- An assisted submission is never ranked, regardless of what the handler computes.
  CHECK (assisted = 0 OR ranked = 0)
);

CREATE INDEX IF NOT EXISTS submissions_board
  ON submissions (league_id, ranked, verified, score DESC, submitted_at ASC, id ASC);
-- The leaderboard shows one row per actor (their best), so the dedupe needs actor_id per league.
CREATE INDEX IF NOT EXISTS submissions_actor_best
  ON submissions (league_id, actor_id, ranked, verified, assisted, score DESC, submitted_at ASC, id ASC);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key_hash TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idempotency_expiry ON idempotency_keys (expires_at);

-- One row per (run, trace) whose replay reached the end of the round, so a repeated submission of
-- the same trace reuses the server's own result instead of replaying the round again. The row is
-- only ever written after a successful replay, and it stores the replay's output, never a claim.
CREATE TABLE IF NOT EXISTS replay_cache (
  run_id TEXT NOT NULL,
  trace_hash TEXT NOT NULL,
  league_id TEXT NOT NULL,
  ruleset_version INTEGER NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0),
  peak_mass REAL NOT NULL,
  ticks INTEGER NOT NULL,
  trace_steps INTEGER NOT NULL,
  duration_s REAL NOT NULL,
  winner_id TEXT,
  replay_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, trace_hash)
);

CREATE INDEX IF NOT EXISTS replay_cache_created ON replay_cache (created_at);

-- Abuse limits only. `ip_hash` is an HMAC of the request IP under ACTOR_HASH_KEY: the raw address
-- is never stored, and this table is the only place a network address influences anything.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, ip_hash, window_start)
);

CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits (window_start);
