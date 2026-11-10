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
    db.transaction(() => {
      db.exec(`
        CREATE TABLE calendar_exceptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, date TEXT NOT NULL,
          course_id INTEGER REFERENCES calendar_courses(id), name TEXT NOT NULL,
          start_min INTEGER NOT NULL, end_min INTEGER NOT NULL,
          UNIQUE(kind,date,course_id)
        );
        CREATE INDEX idx_calendar_exceptions_date ON calendar_exceptions(date);
        CREATE TABLE day_overrides (
          date TEXT PRIMARY KEY, mode TEXT NOT NULL, daily_max_min INTEGER,
          start_min INTEGER, end_min INTEGER, note TEXT NOT NULL
        );
        CREATE TABLE task_dependencies (
          task_id INTEGER NOT NULL REFERENCES tasks(id), prerequisite_id INTEGER NOT NULL REFERENCES tasks(id),
          PRIMARY KEY(task_id,prerequisite_id), CHECK(task_id != prerequisite_id)
        );
        CREATE INDEX idx_dependencies_prerequisite ON task_dependencies(prerequisite_id);
      `)
      db.pragma('user_version = 10')
    })()
  }
  if (version < 11) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE statistics_meta(id INTEGER PRIMARY KEY CHECK(id=1),enabled_at TEXT NOT NULL);
        CREATE TABLE audit_context(id INTEGER PRIMARY KEY CHECK(id=1),actor TEXT NOT NULL,source TEXT NOT NULL,
          reason TEXT NOT NULL,note TEXT NOT NULL,source_ref TEXT);
        INSERT INTO audit_context VALUES(1,'system','system','unspecified','',NULL);
        CREATE TABLE task_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,task_id INTEGER NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,
          actor TEXT NOT NULL,source TEXT NOT NULL,reason TEXT NOT NULL,note TEXT NOT NULL,
          before_json TEXT,after_json TEXT,source_ref TEXT,occurred_at TEXT NOT NULL,local_day TEXT NOT NULL,
          idempotency_key TEXT UNIQUE
        );
        CREATE INDEX idx_task_events_day ON task_events(local_day,kind);
        CREATE INDEX idx_task_events_task ON task_events(task_id,id);
        CREATE INDEX idx_task_events_time ON task_events(occurred_at);
        CREATE TABLE day_plan_snapshots(date TEXT PRIMARY KEY,frozen_at TEXT NOT NULL,method TEXT NOT NULL,time_zone TEXT NOT NULL);
        CREATE TABLE day_plan_items(date TEXT NOT NULL REFERENCES day_plan_snapshots(date),task_id INTEGER NOT NULL REFERENCES tasks(id),
          title TEXT NOT NULL,planned_start INTEGER NOT NULL,planned_end INTEGER NOT NULL,deadline_at TEXT,base_min INTEGER NOT NULL,
          PRIMARY KEY(date,task_id));
        ALTER TABLE completion_events ADD COLUMN stats_tracked INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE completion_events ADD COLUMN stats_valid INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE completion_events ADD COLUMN stats_day TEXT;
        ALTER TABLE completion_events ADD COLUMN stats_timezone TEXT;
        ALTER TABLE completion_events ADD COLUMN deadline_at TEXT;
        ALTER TABLE completion_events ADD COLUMN deadline_confirmed INTEGER;
      `)
      db.prepare('INSERT INTO statistics_meta VALUES(1,?)').run(new Date().toISOString())
      const value = (prefix: string): string => `json_object('title',substr(COALESCE(${prefix}.summary,${prefix}.content),1,500),'status',${prefix}.status,
        'content',substr(${prefix}.content,1,500),'category',${prefix}.category,'tags',${prefix}.tags,'importance',${prefix}.importance,'urgency',${prefix}.urgency,
        'baseMin',${prefix}.base_estimate_min,'estimateMin',${prefix}.estimate_min,'estimateGroup',${prefix}.estimate_group,
        'deadlineAt',${prefix}.deadline_at,'deadlineConfirmed',${prefix}.deadline_confirmed,'rangeStart',${prefix}.range_start,'rangeEnd',${prefix}.range_end)`
      db.exec(`
        CREATE TRIGGER task_event_created AFTER INSERT ON tasks BEGIN
          INSERT INTO task_events(task_id,kind,actor,source,reason,note,before_json,after_json,source_ref,occurred_at,local_day,idempotency_key)
          SELECT NEW.id,'created',actor,source,reason,note,NULL,${value('NEW')},source_ref,NEW.created_at,date(NEW.created_at,'localtime'),'task-created:'||NEW.id FROM audit_context WHERE id=1;
        END;
        CREATE TRIGGER task_event_updated AFTER UPDATE ON tasks
        WHEN OLD.status IS NOT NEW.status OR OLD.content IS NOT NEW.content OR OLD.summary IS NOT NEW.summary OR OLD.category IS NOT NEW.category OR OLD.tags IS NOT NEW.tags
          OR OLD.importance IS NOT NEW.importance OR OLD.urgency IS NOT NEW.urgency OR OLD.base_estimate_min IS NOT NEW.base_estimate_min
          OR OLD.estimate_min IS NOT NEW.estimate_min OR OLD.estimate_group IS NOT NEW.estimate_group
          OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.deadline_confirmed IS NOT NEW.deadline_confirmed
          OR OLD.range_start IS NOT NEW.range_start OR OLD.range_end IS NOT NEW.range_end
        BEGIN
          INSERT INTO task_events(task_id,kind,actor,source,reason,note,before_json,after_json,source_ref,occurred_at,local_day)
          SELECT NEW.id,CASE WHEN NEW.status='archived' THEN 'archived' WHEN NEW.status='done' THEN 'completed'
            WHEN OLD.status='done' THEN 'reopened' ELSE 'updated' END,
            actor,source,reason,note,${value('OLD')},${value('NEW')},source_ref,NEW.updated_at,date(NEW.updated_at,'localtime') FROM audit_context WHERE id=1;
        END;
      `)
      db.pragma('user_version = 11')
    })()
  }
  if(version<12){
    db.transaction(()=>{
      db.exec(`
        CREATE TABLE attention_settings(id INTEGER PRIMARY KEY CHECK(id=1),proactive_enabled INTEGER NOT NULL DEFAULT 1,
          course_enabled INTEGER NOT NULL DEFAULT 1,nudge_enabled INTEGER NOT NULL DEFAULT 1,desktop_enabled INTEGER NOT NULL DEFAULT 0,
          quiet_enabled INTEGER NOT NULL DEFAULT 1,quiet_start_min INTEGER NOT NULL DEFAULT 1320,quiet_end_min INTEGER NOT NULL DEFAULT 480,
          interval_min INTEGER NOT NULL DEFAULT 60,daily_checks INTEGER NOT NULL DEFAULT 3,daily_messages INTEGER NOT NULL DEFAULT 3,
          start_advance_min INTEGER NOT NULL DEFAULT 10,reminder_daily_limit INTEGER NOT NULL DEFAULT 12,version INTEGER NOT NULL DEFAULT 1);
        INSERT INTO attention_settings(id) VALUES(1);
        CREATE TABLE attention_state(id INTEGER PRIMARY KEY CHECK(id=1),enabled_at INTEGER NOT NULL,last_check_at INTEGER NOT NULL DEFAULT 0,last_desktop_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE attention_events(key TEXT PRIMARY KEY,kind TEXT NOT NULL,payload_json TEXT NOT NULL,version TEXT NOT NULL,
          expires_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'new');
        CREATE TABLE attention_jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'pending',event_keys_json TEXT NOT NULL,
          versions_json TEXT NOT NULL,settings_version INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,
          lease_until INTEGER NOT NULL DEFAULT 0,token TEXT,created_at INTEGER NOT NULL,trace_json TEXT NOT NULL DEFAULT '[]');
        CREATE INDEX idx_attention_jobs_status ON attention_jobs(status,retry_at);
        CREATE TABLE attention_attempts(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES attention_jobs(id),
          started_at INTEGER NOT NULL,day TEXT NOT NULL,outcome TEXT NOT NULL DEFAULT 'running');
        CREATE INDEX idx_attention_attempts_day ON attention_attempts(day);
        CREATE TABLE attention_messages(id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'open',is_read INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
          snoozed_until INTEGER,payload_json TEXT NOT NULL,run_id TEXT,desktop_status TEXT NOT NULL DEFAULT 'pending');
        CREATE INDEX idx_attention_messages_state ON attention_messages(state,is_read);
        CREATE TABLE attention_mutes(subject_key TEXT PRIMARY KEY,label TEXT NOT NULL);
        CREATE TABLE attention_desktop_batches(id TEXT PRIMARY KEY,day TEXT NOT NULL,created_at INTEGER NOT NULL,ids_json TEXT NOT NULL,status TEXT NOT NULL);
      `)
      db.prepare('INSERT INTO attention_state(id,enabled_at) VALUES(1,?)').run(Date.now())
      db.pragma('user_version = 12')
    })()
  }
}
