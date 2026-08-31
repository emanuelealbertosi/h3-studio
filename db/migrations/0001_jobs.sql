CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  prompt TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 4),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds IN (5, 10, 15, 20)),
  megapixels REAL NOT NULL CHECK (megapixels IN (0.5, 0.7, 1.0, 1.5, 2.0)),
  generation_mode TEXT NOT NULL,
  aspect_format TEXT NOT NULL,
  requested_seed TEXT,
  model TEXT NOT NULL,
  lora TEXT NOT NULL,
  lora_strength REAL NOT NULL,
  steps INTEGER NOT NULL CHECK (steps BETWEEN 4 AND 30)
) STRICT;

CREATE TABLE IF NOT EXISTS candidates (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_index INTEGER NOT NULL CHECK (candidate_index BETWEEN 1 AND 4),
  seed TEXT NOT NULL,
  filename_prefix TEXT NOT NULL,
  prompt_id TEXT,
  queue_number INTEGER,
  status TEXT NOT NULL,
  api_prompt_json TEXT NOT NULL,
  output_filename TEXT,
  output_subfolder TEXT,
  output_type TEXT,
  output_format TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, candidate_index)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_jobs_created_at
ON jobs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_active_status
ON jobs(status)
WHERE status NOT IN ('completed', 'failed');

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_prompt_id
ON candidates(prompt_id)
WHERE prompt_id IS NOT NULL;
