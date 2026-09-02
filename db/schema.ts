export const JOB_DATABASE_MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS jobs (
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
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS candidates (
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
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_created_at
       ON jobs(created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_active_status
       ON jobs(status)
       WHERE status NOT IN ('completed', 'failed')`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_prompt_id
       ON candidates(prompt_id)
       WHERE prompt_id IS NOT NULL`,
    ],
  },
  {
    version: 2,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN selected_candidate_index INTEGER
       CHECK (selected_candidate_index BETWEEN 1 AND 4)`,
    ],
  },
  {
    version: 3,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN seed_mode TEXT NOT NULL DEFAULT 'random'
       CHECK (seed_mode IN ('random', 'base', 'fixed'))`,
    ],
  },
  {
    version: 4,
    statements: [
      `UPDATE jobs
       SET seed_mode = 'base'
       WHERE requested_seed IS NOT NULL
         AND seed_mode = 'random'`,
    ],
  },
  {
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS project_clips (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_job_id TEXT NOT NULL,
        source_candidate_index INTEGER NOT NULL CHECK (source_candidate_index BETWEEN 1 AND 4),
        position INTEGER NOT NULL CHECK (position >= 0),
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_job_id, source_candidate_index)
          REFERENCES candidates(job_id, candidate_index)
          ON DELETE RESTRICT
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_project_clips_project_position
       ON project_clips(project_id, position)`,
    ],
  },
  {
    version: 6,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN media_state TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE jobs
       ADD COLUMN reference_roles TEXT NOT NULL DEFAULT 'AUTO'`,
      `ALTER TABLE jobs
       ADD COLUMN keyframe_positions TEXT NOT NULL DEFAULT 'AUTO'`,
      `ALTER TABLE jobs
       ADD COLUMN source_video_audio TEXT NOT NULL DEFAULT 'AUTO'
       CHECK (source_video_audio IN ('AUTO', 'IGNORE', 'REFERENCE', 'REUSE'))`,
    ],
  },
  {
    version: 7,
    statements: [
      `CREATE TABLE IF NOT EXISTS creative_assets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('character', 'object')),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        generation_prompt TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK (status IN ('draft', 'ready', 'generating', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS creative_generations (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        seed TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('prepared', 'queued', 'running', 'ready', 'failed')),
        prompt_id TEXT,
        queue_number INTEGER,
        api_prompt_json TEXT NOT NULL,
        filename_prefix TEXT NOT NULL,
        output_filename TEXT,
        output_subfolder TEXT,
        output_type TEXT,
        output_format TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS creative_asset_references (
        id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
        generation_id TEXT REFERENCES creative_generations(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK (role IN ('primary', 'face', 'full_body', 'front', 'side', 'back', 'detail', 'style', 'other')),
        position INTEGER NOT NULL CHECK (position >= 0),
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('upload', 'generated')),
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_creative_assets_kind_updated
       ON creative_assets(kind, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_creative_references_asset_position
       ON creative_asset_references(asset_id, position)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_references_generation
       ON creative_asset_references(generation_id)
       WHERE generation_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_creative_generations_asset_created
       ON creative_generations(asset_id, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_generations_prompt_id
       ON creative_generations(prompt_id)
       WHERE prompt_id IS NOT NULL`,
    ],
  },
  {
    version: 8,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`,
      `ALTER TABLE jobs
       ADD COLUMN source_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL`,
      `ALTER TABLE jobs
       ADD COLUMN mute_diegetic INTEGER NOT NULL DEFAULT 0
       CHECK (mute_diegetic IN (0, 1))`,
      `ALTER TABLE jobs
       ADD COLUMN mute_non_diegetic INTEGER NOT NULL DEFAULT 0
       CHECK (mute_non_diegetic IN (0, 1))`,
      `CREATE TABLE IF NOT EXISTS project_timelines (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        external_audio_file TEXT,
        external_audio_name TEXT,
        original_audio_gain REAL NOT NULL DEFAULT 1.0
          CHECK (original_audio_gain BETWEEN 0.0 AND 2.0),
        external_audio_gain REAL NOT NULL DEFAULT 1.0
          CHECK (external_audio_gain BETWEEN 0.0 AND 2.0),
        external_audio_loop INTEGER NOT NULL DEFAULT 0
          CHECK (external_audio_loop IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_project_timelines_project_updated
       ON project_timelines(project_id, updated_at DESC)`,
      `INSERT INTO project_timelines(id, project_id, name, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), id, 'Montaggio principale', created_at, updated_at
       FROM projects
       WHERE NOT EXISTS (
         SELECT 1 FROM project_timelines
         WHERE project_timelines.project_id = projects.id
       )`,
      `ALTER TABLE project_clips
       ADD COLUMN timeline_id TEXT REFERENCES project_timelines(id) ON DELETE CASCADE`,
      `ALTER TABLE project_clips
       ADD COLUMN trim_start REAL NOT NULL DEFAULT 0.0 CHECK (trim_start >= 0.0)`,
      `ALTER TABLE project_clips
       ADD COLUMN trim_end REAL CHECK (trim_end IS NULL OR trim_end > 0.0)`,
      `ALTER TABLE project_clips
       ADD COLUMN volume REAL NOT NULL DEFAULT 1.0 CHECK (volume BETWEEN 0.0 AND 2.0)`,
      `UPDATE project_clips
       SET timeline_id = (
         SELECT project_timelines.id
         FROM project_timelines
         WHERE project_timelines.project_id = project_clips.project_id
         ORDER BY project_timelines.created_at
         LIMIT 1
       )
       WHERE timeline_id IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_project_clips_timeline_position
       ON project_clips(timeline_id, position)`,
      `UPDATE jobs
       SET project_id = (
         SELECT project_clips.project_id
         FROM project_clips
         WHERE project_clips.source_job_id = jobs.id
         ORDER BY project_clips.created_at
         LIMIT 1
       )
       WHERE project_id IS NULL
         AND EXISTS (
           SELECT 1 FROM project_clips
           WHERE project_clips.source_job_id = jobs.id
         )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_project_created
       ON jobs(project_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_source_job
       ON jobs(source_job_id)`,
    ],
  },
  {
    version: 9,
    statements: [
      `UPDATE jobs
       SET project_id = (SELECT id FROM projects ORDER BY created_at LIMIT 1),
           updated_at = updated_at
       WHERE project_id IS NULL
         AND (SELECT COUNT(*) FROM projects) = 1`,
    ],
  },
  {
    version: 10,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN quality_mode TEXT NOT NULL DEFAULT 'fast'
       CHECK (quality_mode IN ('fast', 'min', 'med', 'max'))`,
      `ALTER TABLE jobs
       ADD COLUMN turbo_enabled INTEGER NOT NULL DEFAULT 1
       CHECK (turbo_enabled IN (0, 1))`,
    ],
  },
  {
    version: 11,
    statements: [
      `CREATE TABLE IF NOT EXISTS candidate_variants (
        id TEXT PRIMARY KEY,
        source_job_id TEXT NOT NULL,
        source_candidate_index INTEGER NOT NULL CHECK (source_candidate_index BETWEEN 1 AND 4),
        kind TEXT NOT NULL CHECK (kind IN ('face', 'upscale', 'face_upscale')),
        stage TEXT NOT NULL CHECK (stage IN ('face', 'upscale')),
        status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'queued', 'rendering', 'ready', 'failed')),
        prompt_id TEXT,
        queue_number INTEGER,
        api_prompt_json TEXT NOT NULL,
        filename_prefix TEXT NOT NULL,
        output_filename TEXT,
        output_subfolder TEXT,
        output_type TEXT,
        output_format TEXT,
        intermediate_filename TEXT,
        intermediate_subfolder TEXT,
        intermediate_type TEXT,
        intermediate_format TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_job_id, source_candidate_index)
          REFERENCES candidates(job_id, candidate_index)
          ON DELETE CASCADE
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_variants_source
       ON candidate_variants(source_job_id, source_candidate_index, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_variants_prompt_id
       ON candidate_variants(prompt_id)
       WHERE prompt_id IS NOT NULL`,
      `ALTER TABLE project_clips
       ADD COLUMN source_variant_id TEXT REFERENCES candidate_variants(id) ON DELETE SET NULL`,
      `CREATE INDEX IF NOT EXISTS idx_project_clips_variant
       ON project_clips(source_variant_id)
       WHERE source_variant_id IS NOT NULL`,
    ],
  },
  {
    version: 12,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN engine_profile TEXT NOT NULL DEFAULT 'standard'
       CHECK (engine_profile IN ('standard', 'fast'))`,
      `ALTER TABLE jobs
       ADD COLUMN pdd_file TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_engine_profile_created
      ON jobs(engine_profile, created_at DESC)`,
    ],
  },
  {
    version: 13,
    statements: [
      `CREATE TABLE IF NOT EXISTS admin_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
       ON admin_sessions(expires_at)`,
    ],
  },
  {
    version: 14,
    statements: [
      `ALTER TABLE candidates ADD COLUMN error TEXT`,
    ],
  },
  {
    version: 15,
    statements: [
      `CREATE TABLE IF NOT EXISTS image_jobs (
        id TEXT PRIMARY KEY,
        origin_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        mode TEXT NOT NULL CHECK (mode IN ('generate', 'edit')),
        prompt TEXT NOT NULL,
        candidate_count INTEGER NOT NULL CHECK (candidate_count BETWEEN 1 AND 4),
        aspect_format TEXT NOT NULL,
        width INTEGER NOT NULL CHECK (width BETWEEN 64 AND 4096 AND width % 16 = 0),
        height INTEGER NOT NULL CHECK (height BETWEEN 64 AND 4096 AND height % 16 = 0),
        seed_mode TEXT NOT NULL CHECK (seed_mode IN ('random', 'base', 'fixed')),
        requested_seed TEXT,
        selected_candidate_index INTEGER CHECK (selected_candidate_index BETWEEN 1 AND 4),
        status TEXT NOT NULL CHECK (
          status IN ('prepared', 'queued', 'running', 'ready', 'partial', 'failed', 'cancelled')
        ),
        engine_snapshot_json TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS image_candidates (
        job_id TEXT NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
        candidate_index INTEGER NOT NULL CHECK (candidate_index BETWEEN 1 AND 4),
        seed TEXT NOT NULL,
        filename_prefix TEXT NOT NULL,
        prompt_id TEXT,
        queue_number INTEGER,
        status TEXT NOT NULL CHECK (
          status IN ('prepared', 'submitted', 'queued', 'running', 'ready', 'failed', 'cancelled')
        ),
        api_prompt_json TEXT NOT NULL,
        output_filename TEXT,
        output_subfolder TEXT,
        output_type TEXT CHECK (output_type IS NULL OR output_type IN ('input', 'output', 'temp')),
        output_format TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, candidate_index)
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS image_job_references (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES image_jobs(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),
        role TEXT NOT NULL DEFAULT 'other'
          CHECK (role IN ('base', 'subject', 'style', 'pose', 'background', 'other')),
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE (job_id, position)
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS project_image_links (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        image_job_id TEXT NOT NULL,
        image_candidate_index INTEGER NOT NULL CHECK (image_candidate_index BETWEEN 1 AND 4),
        tag TEXT NOT NULL DEFAULT 'untagged'
          CHECK (tag IN ('untagged', 'character', 'object', 'background')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, image_job_id, image_candidate_index),
        FOREIGN KEY (image_job_id, image_candidate_index)
          REFERENCES image_candidates(job_id, candidate_index)
          ON DELETE CASCADE
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_image_jobs_origin_created
       ON image_jobs(origin_project_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_image_jobs_status
       ON image_jobs(status)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_image_candidates_prompt_id
       ON image_candidates(prompt_id)
       WHERE prompt_id IS NOT NULL`,
      `CREATE INDEX IF NOT EXISTS idx_image_references_job_position
       ON image_job_references(job_id, position)`,
      `CREATE INDEX IF NOT EXISTS idx_project_image_links_project_updated
       ON project_image_links(project_id, updated_at DESC)`,
    ],
  },
  {
    version: 16,
    statements: [
      `ALTER TABLE candidate_variants
       ADD COLUMN source_variant_id TEXT
       REFERENCES candidate_variants(id) ON DELETE SET NULL`,
      `ALTER TABLE candidate_variants
       ADD COLUMN target_megapixels INTEGER
       CHECK (target_megapixels IS NULL OR target_megapixels IN (1, 2))`,
      `UPDATE candidate_variants
       SET target_megapixels = 1
       WHERE kind IN ('upscale', 'face_upscale')`,
      `CREATE INDEX IF NOT EXISTS idx_candidate_variants_parent
       ON candidate_variants(source_variant_id)
       WHERE source_variant_id IS NOT NULL`,
    ],
  },
  {
    version: 17,
    statements: [
      `CREATE TABLE IF NOT EXISTS external_media (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('picture', 'video', 'audio')),
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        source_key TEXT NOT NULL UNIQUE,
        size INTEGER,
        duration REAL,
        has_audio INTEGER NOT NULL DEFAULT 0 CHECK (has_audio IN (0, 1)),
        width INTEGER,
        height INTEGER,
        origin_project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_external_media_updated
       ON external_media(updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_external_media_project_updated
       ON external_media(origin_project_id, updated_at DESC)`,
    ],
  },
  {
    version: 18,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_threads (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES chat_threads(project_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        action_json TEXT,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_project_created
       ON chat_messages(project_id, created_at)`,
    ],
  },
  {
    version: 19,
    statements: [
      `ALTER TABLE chat_threads
       ADD COLUMN memory_summary TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE chat_threads
       ADD COLUMN memory_sequence INTEGER NOT NULL DEFAULT 0
      CHECK (memory_sequence >= 0)`,
    ],
  },
  {
    version: 20,
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        title_is_auto INTEGER NOT NULL DEFAULT 1 CHECK (title_is_auto IN (0, 1)),
        memory_summary TEXT NOT NULL DEFAULT '',
        memory_sequence INTEGER NOT NULL DEFAULT 0 CHECK (memory_sequence >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `INSERT INTO chat_conversations(
         id, project_id, title, title_is_auto, memory_summary, memory_sequence, created_at, updated_at
       )
       SELECT project_id, project_id, 'Chat principale', 0,
              memory_summary, memory_sequence, created_at, updated_at
       FROM chat_threads
       WHERE NOT EXISTS (
         SELECT 1 FROM chat_conversations
         WHERE chat_conversations.project_id = chat_threads.project_id
       )`,
      `ALTER TABLE chat_messages
       ADD COLUMN conversation_id TEXT
       REFERENCES chat_conversations(id) ON DELETE CASCADE`,
      `UPDATE chat_messages
       SET conversation_id = project_id
       WHERE conversation_id IS NULL`,
      `CREATE INDEX IF NOT EXISTS idx_chat_conversations_project_updated
       ON chat_conversations(project_id, updated_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
       ON chat_messages(conversation_id, created_at)`,
    ],
  },
  {
    version: 21,
    statements: [
      `CREATE TABLE IF NOT EXISTS audio_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('tts', 'music')),
        status TEXT NOT NULL CHECK (
          status IN ('prepared', 'queued', 'loading', 'running', 'finalizing', 'ready', 'failed', 'cancelled')
        ),
        prompt TEXT NOT NULL,
        lyrics TEXT NOT NULL DEFAULT '',
        voice TEXT NOT NULL DEFAULT '',
        reference_file TEXT,
        reference_text TEXT NOT NULL DEFAULT '',
        duration_seconds REAL,
        seed TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        prompt_id TEXT,
        queue_number INTEGER,
        progress REAL,
        phase_label TEXT NOT NULL DEFAULT 'Preparazione',
        output_filename TEXT,
        output_subfolder TEXT,
        output_type TEXT CHECK (output_type IN ('input', 'output', 'temp')),
        output_format TEXT,
        external_media_id TEXT REFERENCES external_media(id) ON DELETE SET NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      `CREATE INDEX IF NOT EXISTS idx_audio_jobs_project_created
       ON audio_jobs(project_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audio_jobs_status
       ON audio_jobs(status)`,
    ],
  },
  {
    version: 22,
    statements: [
      `ALTER TABLE candidates ADD COLUMN display_name TEXT`,
      `ALTER TABLE image_candidates ADD COLUMN display_name TEXT`,
    ],
  },
  {
    version: 23,
    statements: [
      `ALTER TABLE jobs
       ADD COLUMN shot_count INTEGER NOT NULL DEFAULT 1
      CHECK (shot_count BETWEEN 1 AND 12)`,
    ],
  },
  {
    version: 24,
    statements: [
      `ALTER TABLE jobs ADD COLUMN inpaint_target TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE jobs ADD COLUMN inpaint_mask_grow INTEGER NOT NULL DEFAULT 8
       CHECK (inpaint_mask_grow BETWEEN 0 AND 96)`,
      `ALTER TABLE jobs ADD COLUMN inpaint_start_seconds REAL NOT NULL DEFAULT 0
       CHECK (inpaint_start_seconds BETWEEN 0 AND 180)`,
      `ALTER TABLE jobs ADD COLUMN inpaint_end_seconds REAL NOT NULL DEFAULT 0
       CHECK (inpaint_end_seconds BETWEEN 0 AND 180)`,
    ],
  },
  {
    // Version 24 briefly belonged to the reverted Bernini experiment. Existing
    // databases may therefore report it as applied without the H3 inpaint
    // columns. JobRepository repairs the schema by inspecting PRAGMA table_info;
    // this marker records that compatibility repair for upgraded installs.
    version: 25,
    statements: [],
  },
  {
    version: 26,
    statements: [
      `ALTER TABLE jobs ADD COLUMN video_engine TEXT NOT NULL DEFAULT 'h3'
       CHECK (video_engine IN ('h3', 'ltx25'))`,
    ],
  },
  {
    version: 27,
    statements: [
      `ALTER TABLE jobs ADD COLUMN ltx_profile_json TEXT`,
    ],
  },
  {
    version: 28,
    statements: [
      `ALTER TABLE projects ADD COLUMN chat_system_prompt TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE chat_conversations ADD COLUMN system_prompt_enabled INTEGER NOT NULL DEFAULT 1
       CHECK (system_prompt_enabled IN (0, 1))`,
    ],
  },
  {
    version: 29,
    statements: [
      `ALTER TABLE project_clips ADD COLUMN crop_x REAL NOT NULL DEFAULT 0
       CHECK (crop_x BETWEEN 0 AND 1)`,
      `ALTER TABLE project_clips ADD COLUMN crop_y REAL NOT NULL DEFAULT 0
       CHECK (crop_y BETWEEN 0 AND 1)`,
      `ALTER TABLE project_clips ADD COLUMN crop_zoom REAL NOT NULL DEFAULT 1
       CHECK (crop_zoom BETWEEN 0.1 AND 1)`,
      `CREATE TABLE timeline_audio_tracks (
        id TEXT PRIMARY KEY,
        timeline_id TEXT NOT NULL REFERENCES project_timelines(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
        file TEXT NOT NULL,
        name TEXT NOT NULL,
        source_duration REAL CHECK (source_duration IS NULL OR source_duration > 0),
        start_time REAL NOT NULL DEFAULT 0 CHECK (start_time >= 0),
        trim_start REAL NOT NULL DEFAULT 0 CHECK (trim_start >= 0),
        trim_end REAL CHECK (trim_end IS NULL OR trim_end > 0),
        gain REAL NOT NULL DEFAULT 1 CHECK (gain BETWEEN 0 AND 2),
        muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
        solo INTEGER NOT NULL DEFAULT 0 CHECK (solo IN (0, 1)),
        loop INTEGER NOT NULL DEFAULT 0 CHECK (loop IN (0, 1)),
        fade_in REAL NOT NULL DEFAULT 0 CHECK (fade_in >= 0),
        fade_out REAL NOT NULL DEFAULT 0 CHECK (fade_out >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(timeline_id, position)
      ) STRICT`,
      `CREATE INDEX idx_timeline_audio_tracks_timeline_position
       ON timeline_audio_tracks(timeline_id, position)`,
      `CREATE INDEX idx_timeline_audio_tracks_file
       ON timeline_audio_tracks(file)`,
      `INSERT INTO timeline_audio_tracks(
         id, timeline_id, position, file, name, source_duration, start_time,
         trim_start, trim_end, gain, muted, solo, loop, fade_in, fade_out,
         created_at, updated_at
       )
       SELECT lower(hex(randomblob(16))), id, 0, external_audio_file,
              COALESCE(external_audio_name, 'Traccia audio 1'), NULL, 0,
              0, NULL, external_audio_gain, 0, 0, external_audio_loop, 0, 0,
              created_at, updated_at
       FROM project_timelines
       WHERE external_audio_file IS NOT NULL`,
    ],
  },
] as const;
