import type Database from 'better-sqlite3'
export const LATEST_SCHEMA_VERSION = 12

/** 简单版本迁移：user_version 存版本号，逐版本执行 DDL */
export function runMigrations(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        content       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'inbox',
        category      TEXT NOT NULL DEFAULT '其他',
        tags          TEXT NOT NULL DEFAULT '[]',
        importance    INTEGER NOT NULL DEFAULT 3,
        urgency       INTEGER NOT NULL DEFAULT 3,
        estimate_min  INTEGER NOT NULL DEFAULT 30,
        due_at        TEXT,
        due_notified  INTEGER NOT NULL DEFAULT 0,
        snooze_count  INTEGER NOT NULL DEFAULT 0,
        ai_status     TEXT NOT NULL DEFAULT 'pending',
        ai_raw        TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        completed_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at) WHERE due_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    db.pragma('user_version = 1')
  }

  if (version < 2) {
    // v0.2: AI 关键信息提炼（长文本任务的一句话摘要）
    db.exec(`ALTER TABLE tasks ADD COLUMN summary TEXT`)
    db.pragma('user_version = 2')
  }

  if (version < 3) {
    // v0.3: 手动纠正锁定（用户调过的重要性/紧急度，AI 重评不覆盖）
    db.exec(`ALTER TABLE tasks ADD COLUMN manual_locked INTEGER NOT NULL DEFAULT 0`)
    db.pragma('user_version = 3')
  }

  if (version < 4) {
    // v0.4: 项目链条（批量导入的任务成组，推迟上游自动顺延下游）
    db.exec(`
      ALTER TABLE tasks ADD COLUMN project_id TEXT;
      ALTER TABLE tasks ADD COLUMN chain_order INTEGER;
      ALTER TABLE tasks ADD COLUMN chain_total INTEGER;
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id) WHERE project_id IS NOT NULL;
    `)
    db.pragma('user_version = 4')
  }

  if (version < 5) {
    // v0.5: 范围计划（"第 1 周（10/19–10/25）"类：只有范围没有具体天，调度器智能分配）
    db.exec(`
      ALTER TABLE tasks ADD COLUMN range_start TEXT;
      ALTER TABLE tasks ADD COLUMN range_end TEXT;
    `)
    db.pragma('user_version = 5')
  }
  if (version < 6) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL,
          messages_json TEXT NOT NULL DEFAULT '[]', pending_json TEXT,
          turns INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE agent_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id),
          kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX idx_agent_events_run ON agent_events(run_id, id);
        CREATE TABLE agent_actions (
          run_id TEXT NOT NULL REFERENCES agent_runs(id), action_key TEXT NOT NULL,
          result_json TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY (run_id, action_key)
        );
      `)
      db.pragma('user_version = 6')
    })()
  }
  if (version < 7) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN deadline_at TEXT;
        ALTER TABLE tasks ADD COLUMN deadline_confirmed INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE tasks ADD COLUMN deadline_source TEXT NOT NULL DEFAULT 'none';
        UPDATE tasks SET deadline_confirmed=0,deadline_source='legacy_unconfirmed' WHERE due_at IS NOT NULL;
        CREATE TABLE calendar_courses (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          weekday INTEGER NOT NULL CHECK(weekday BETWEEN 1 AND 7),
          start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
          from_date TEXT NOT NULL, to_date TEXT NOT NULL,
          CHECK(start_min>=0 AND end_min<=1440 AND start_min<end_min), CHECK(from_date<=to_date)
        );
        CREATE TABLE planning_settings (
          id INTEGER PRIMARY KEY CHECK(id=1), start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
          daily_max_min INTEGER NOT NULL, break_min INTEGER NOT NULL
        );
        INSERT INTO planning_settings VALUES(1,480,1320,240,10);
        CREATE TABLE plan_blocks (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id),
          start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
          reason TEXT NOT NULL, created_at TEXT NOT NULL, CHECK(start_at<end_at), UNIQUE(task_id)
        );
        CREATE TABLE plan_previews (
          id TEXT PRIMARY KEY, run_id TEXT, json TEXT NOT NULL, committed_json TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE planning_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `)
      db.pragma('user_version = 7')
    })()
  }
  if (version < 8) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN base_estimate_min INTEGER NOT NULL DEFAULT 30;
        ALTER TABLE tasks ADD COLUMN estimate_group TEXT NOT NULL DEFAULT '';
        ALTER TABLE tasks ADD COLUMN estimate_source TEXT NOT NULL DEFAULT 'initial';
        ALTER TABLE tasks ADD COLUMN completion_seq INTEGER NOT NULL DEFAULT 0;
        UPDATE tasks SET base_estimate_min=estimate_min,estimate_source='legacy';
        CREATE TABLE memory_facts (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          source TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, expires_at TEXT, updated_at TEXT NOT NULL,
          UNIQUE(scope,key)
        );
        CREATE TABLE profile_settings(id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, calibration_enabled INTEGER NOT NULL);
        INSERT INTO profile_settings VALUES(1,1,1);
        CREATE TABLE completion_events (
          id TEXT PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id), cycle INTEGER NOT NULL,
          title TEXT NOT NULL, group_key TEXT NOT NULL, estimate_source TEXT NOT NULL,
          base_min INTEGER NOT NULL, planned_min INTEGER NOT NULL, had_plan INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
          valid INTEGER NOT NULL DEFAULT 1, UNIQUE(task_id,cycle)
        );
        CREATE TABLE completion_feedback (
          event_id TEXT PRIMARY KEY REFERENCES completion_events(id), actual_min INTEGER,
          difficulty TEXT NOT NULL, interrupted INTEGER NOT NULL, scope_changed INTEGER NOT NULL,
          note TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE completion_jobs (
          event_id TEXT PRIMARY KEY REFERENCES completion_events(id), status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
          lease_until INTEGER NOT NULL DEFAULT 0, token TEXT, last_attempt_at TEXT, trace_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE followup_messages (
          id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES completion_events(id),
          question TEXT NOT NULL, fields_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
          is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
        );
        CREATE INDEX idx_completion_jobs_status ON completion_jobs(status,retry_at);
        CREATE INDEX idx_followup_state ON followup_messages(state,is_read);
      `)
      db.pragma('user_version = 8')
    })()
  }
  if (version < 9) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE agent_runs ADD COLUMN scene TEXT NOT NULL DEFAULT 'planning';
        CREATE TABLE task_sources (
          run_id TEXT PRIMARY KEY REFERENCES agent_runs(id), kind TEXT NOT NULL,
          raw_text TEXT NOT NULL, evidence_ref TEXT NOT NULL
        );
        CREATE TABLE task_drafts (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
          version INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'editing', items_json TEXT NOT NULL,
          created_ids_json TEXT NOT NULL DEFAULT '[]', handoff_run_id TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE task_draft_links (
          task_id INTEGER NOT NULL UNIQUE REFERENCES tasks(id), draft_id TEXT NOT NULL REFERENCES task_drafts(id),
          item_id TEXT NOT NULL, source_ref TEXT NOT NULL, UNIQUE(draft_id,item_id)
        );
        CREATE TABLE task_draft_revisions (
          draft_id TEXT NOT NULL REFERENCES task_drafts(id), version INTEGER NOT NULL,
          items_json TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(draft_id,version)
        );
        CREATE TABLE review_proposals (
          provider TEXT NOT NULL, proposal_key TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES agent_runs(id),
          PRIMARY KEY(provider,proposal_key)
        );
      `)
      db.pragma('user_version = 9')
    })()
  }
  if (version < 10) {
    // v10: 学习资料解析与考点分析（文件只记路径引用，不复制、不存全文）
    db.transaction(() => {
      db.exec(`
        CREATE TABLE study_documents (
          id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL,
          ext TEXT NOT NULL CHECK(ext IN ('pdf','docx','txt','md')),
          size_bytes INTEGER NOT NULL, content_hash TEXT NOT NULL,
          page_count INTEGER NOT NULL DEFAULT 0, char_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','parsed','failed')),
          parser TEXT NOT NULL DEFAULT '', outline_confidence REAL NOT NULL DEFAULT 0,
          last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(path, content_hash)
        );
        CREATE TABLE study_chapters (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id TEXT NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL, level INTEGER NOT NULL DEFAULT 1 CHECK(level BETWEEN 1 AND 4),
          title TEXT NOT NULL, start_page INTEGER NOT NULL, end_page INTEGER NOT NULL,
          confidence REAL NOT NULL DEFAULT 0 CHECK(confidence BETWEEN 0 AND 1),
          selected INTEGER NOT NULL DEFAULT 1,
          UNIQUE(doc_id, ordinal), CHECK(start_page >= 1 AND start_page <= end_page)
        );
        CREATE TABLE study_goals (
          doc_id TEXT PRIMARY KEY REFERENCES study_documents(id) ON DELETE CASCADE,
          exam_date TEXT, self_level TEXT CHECK(self_level IN ('weak','normal','strong')),
          target TEXT CHECK(target IN ('pass','good','excellent')),
          daily_min INTEGER CHECK(daily_min BETWEEN 15 AND 720),
          weekdays_json TEXT NOT NULL DEFAULT '[]',
          daypart TEXT CHECK(daypart IN ('morning','afternoon','evening','any')),
          assumptions_json TEXT NOT NULL DEFAULT '[]',
          confirmed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE study_topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          doc_id TEXT NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
          chapter_id INTEGER NOT NULL REFERENCES study_chapters(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL, name TEXT NOT NULL,
          importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 5),
          difficulty INTEGER NOT NULL CHECK(difficulty BETWEEN 1 AND 5),
          exam_likelihood INTEGER NOT NULL CHECK(exam_likelihood BETWEEN 1 AND 5),
          estimate_min INTEGER NOT NULL CHECK(estimate_min BETWEEN 10 AND 480),
          evidence_page INTEGER, evidence_quote TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL, UNIQUE(chapter_id, ordinal)
        );
        CREATE TABLE study_analyses (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
          chapter_ids_json TEXT NOT NULL, prompt_version TEXT NOT NULL, model TEXT NOT NULL,
          max_calls INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running'
            CHECK(status IN ('running','done','partial','failed','cancelled')),
          error TEXT, created_at TEXT NOT NULL, finished_at TEXT
        );
        CREATE TABLE study_analysis_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          analysis_id TEXT NOT NULL REFERENCES study_analyses(id) ON DELETE CASCADE,
          chapter_id INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK(status IN ('ok','invalid','error')),
          request_chars INTEGER NOT NULL DEFAULT 0, response_chars INTEGER NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL,
          UNIQUE(analysis_id, chapter_id, attempt)
        );
        CREATE INDEX idx_study_topics_doc ON study_topics(doc_id, chapter_id, ordinal);
        CREATE INDEX idx_study_calls_analysis ON study_analysis_calls(analysis_id);
      `)
      db.pragma('user_version = 10')
    })()
  }
  if (version < 11) {
    // v11: 扫描件识别（逐页渲染 + 视觉模型转录），识别结果落库以便复用，避免重复付费
    db.transaction(() => {
      db.exec(`
        ALTER TABLE study_documents ADD COLUMN ocr_state TEXT NOT NULL DEFAULT 'none';
        CREATE TABLE study_pages (
          doc_id TEXT NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
          page_no INTEGER NOT NULL CHECK(page_no >= 1),
          text TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL CHECK(source IN ('text','ocr')),
          engine TEXT NOT NULL DEFAULT '',
          ink_ratio REAL NOT NULL DEFAULT 0,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          PRIMARY KEY(doc_id, page_no)
        );
        CREATE TABLE study_ocr_runs (
          id TEXT PRIMARY KEY,
          doc_id TEXT NOT NULL REFERENCES study_documents(id) ON DELETE CASCADE,
          from_page INTEGER NOT NULL, to_page INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','partial','failed','cancelled')),
          model TEXT NOT NULL DEFAULT '', prompt_version TEXT NOT NULL DEFAULT '',
          total_pages INTEGER NOT NULL DEFAULT 0, done_pages INTEGER NOT NULL DEFAULT 0,
          error TEXT, created_at TEXT NOT NULL, finished_at TEXT
        );
        CREATE INDEX idx_study_pages_doc ON study_pages(doc_id, page_no);
        CREATE INDEX idx_study_ocr_runs_doc ON study_ocr_runs(doc_id, created_at);
      `)
        db.pragma('user_version = 11')
    })()
  }
  if (version < 12) {
    // v12: 助理提问的候选答复（只在 waiting_user 期间有效，发消息或结束即清空）
    db.exec(`ALTER TABLE agent_runs ADD COLUMN question_json TEXT`)
    db.pragma('user_version = 12')
  }
}
