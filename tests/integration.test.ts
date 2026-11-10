import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {runMigrations} from '../src/main/db/migrations'
import {runMigrations as oldPlanning} from './fixtures/migrations-planning-v12'
import {runMigrations as oldStudy} from './fixtures/migrations-study-v12'
import {getDb} from '../src/main/db/database'
import * as tasks from '../src/main/db/taskDao'
import * as planning from '../src/main/planning/service'
import {at} from '../src/main/planning/engine'
import {getSettings,setSettings} from '../src/main/db/settingsDao'
import {ocrSettings} from '../src/main/study/ocr'
import {getDocument} from '../src/main/study/documents'
import {listForAgent} from '../src/main/study/reader'
import {parseTimetable} from '../src/shared/timetable'
type Test=(name:string,fn:()=>unknown|Promise<unknown>)=>Promise<void>
function columns(db:Database.Database,table:string):string[]{return(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(r=>r.name)}
function preserve(db:Database.Database):void{
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(r=>r.name)
  const before=tables.map(table=>({table,cols:columns(db,table),rows:db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()}))
  runMigrations(db);runMigrations(db);assert.equal(db.pragma('user_version',{simple:true}),15)
  for(const b of before)assert.deepEqual(db.prepare(`SELECT ${b.cols.map(c=>`"${c}"`).join(',')} FROM ${b.table} ORDER BY rowid`).all(),b.rows,`迁移不能改变旧表${b.table}的值`)
  for(const table of ['calendar_exceptions','statistics_meta','attention_settings','study_documents','study_pages'])assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))
  assert.ok(columns(db,'agent_runs').includes('question_json'));assert.ok(columns(db,'study_documents').includes('ocr_state'));assert.ok(columns(db,'completion_events').includes('stats_tracked'))
}
export async function integrationTests(test:Test):Promise<void>{
  await test('双方真实v12旧结构升级到统一v15，所有原表原字段逐行保留',()=>{
    for(const migrate of [oldPlanning,oldStudy]){
      const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrate(db)
      db.prepare("INSERT INTO tasks(id,content,status,created_at,updated_at) VALUES(1,'保留的旧任务','pending',?,?)").run('2030-01-07T00:00:00Z','2030-01-07T00:00:00Z')
      db.prepare("INSERT INTO agent_runs(id,goal,status,created_at,updated_at) VALUES('legacy-run','保留会话','completed',?,?)").run('2030-01-07','2030-01-07')
      if(migrate===oldStudy){
        db.prepare("INSERT INTO study_documents(id,path,name,ext,size_bytes,content_hash,created_at,updated_at) VALUES('d','fixture.pdf','教材','pdf',100,'hash','2030-01-07','2030-01-07')").run()
        db.prepare("INSERT INTO study_pages(doc_id,page_no,text,source,engine,created_at) VALUES('d',1,'已付费识别的文字','ocr','fixture','2030-01-07')").run()
        db.prepare('UPDATE agent_runs SET question_json=?').run(JSON.stringify({text:'考哪些？',options:['全部','部分']}))
      }
      preserve(db);db.close()
    }
  })
  await test('学习分支v10/v11与规划分支v10/v11各自正确补齐缺失的另一套结构',()=>{
    for(const family of ['study','planning'])for(const version of [10,11]){
      const db=new Database(':memory:');(family==='study'?oldStudy:oldPlanning)(db)
      if(family==='study'){
        db.exec('ALTER TABLE agent_runs DROP COLUMN question_json')
        if(version===10)db.exec('DROP TABLE study_ocr_runs; DROP TABLE study_pages; ALTER TABLE study_documents DROP COLUMN ocr_state')
      }else{
        db.exec('DROP TABLE attention_attempts; DROP TABLE attention_jobs; DROP TABLE attention_messages; DROP TABLE attention_events; DROP TABLE attention_desktop_batches; DROP TABLE attention_mutes; DROP TABLE attention_state; DROP TABLE attention_settings')
        if(version===10){
          db.exec('DROP TRIGGER task_event_created; DROP TRIGGER task_event_updated; DROP TABLE day_plan_items; DROP TABLE day_plan_snapshots; DROP TABLE task_events; DROP TABLE audit_context; DROP TABLE statistics_meta')
          for(const c of ['stats_tracked','stats_valid','stats_day','stats_timezone','deadline_at','deadline_confirmed'])db.exec(`ALTER TABLE completion_events DROP COLUMN ${c}`)
        }
      }
      db.pragma(`user_version=${version}`);preserve(db);db.close()
    }
  })
  await test('高于统一版本的数据库拒绝降级打开',()=>{const db=new Database(':memory:');db.pragma('user_version=99');assert.throws(()=>runMigrations(db),/更新版本/);assert.equal(db.pragma('user_version',{simple:true}),99);db.close()})
  const db=getDb(),date='2030-01-07',next='2030-01-08',now=at(date,420),ids:number[]=[]
  function reset():void{db.exec('DELETE FROM day_plan_items; DELETE FROM day_plan_snapshots; DELETE FROM task_dependencies; DELETE FROM plan_blocks; DELETE FROM calendar_exceptions; DELETE FROM calendar_courses; DELETE FROM day_overrides; DELETE FROM plan_previews;');ids.forEach(id=>tasks.deleteTask(id));planning.saveSettings({startMin:480,endMin:1200,dailyMaxMin:240,breakMin:15})}
  function task(name:string,duration=60):number{const t=tasks.createTask({content:name});ids.push(t.id);tasks.applyAnalysis(t.id,{summary:name,importance:3,urgency:3,category:'学习',tags:[],estimateMin:duration,dueAt:null},'none');tasks.updateTask({id:t.id,deadlineAt:null});return t.id}
  await test('手动排期复用临时占用/轻量日，保存也记录账本和冻结基线',()=>{
    reset();const id=task('手动约束',90);planning.saveDayOverride({date,mode:'light',dailyMaxMin:null,startMin:null,endMin:null,note:''})
    planning.saveException({kind:'busy',date,courseId:null,name:'面试',startMin:480,endMin:600})
    const slots=planning.manualSlots(id,date,date,now);assert.ok(slots.days[0].candidates.every(c=>c.start>=at(date,600)));planning.saveBlockAt(id,at(date,600),at(date,690),now)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM day_plan_items WHERE date=?').get(date) as {n:number}).n,1)
    assert.ok(db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='plan_created'").get(id))
    const second=task('轻量放不下',60);assert.ok(planning.manualSlots(second,date,date,now).days[0].candidates.every(c=>!c.fits));assert.throws(()=>planning.saveBlockAt(second,at(date,720),at(date,780),now),/容量/)
  })
  await test('手动排期不能绕开前置和未选择后续的已有安排',()=>{
    reset();const a=task('先读'),b=task('再练');planning.saveDependency(b,a);assert.match(planning.manualSlots(b,date,date,now).days[0].note!,/前置/);assert.throws(()=>planning.saveBlockAt(b,at(date,480),at(date,540),now),/前置/)
    planning.saveBlockAt(a,at(date,480),at(date,540),now);planning.saveBlockAt(b,at(date,600),at(date,660),now)
    assert.throws(()=>planning.saveBlockAt(a,at(next,480),at(next,540),now),/前置/)
    assert.equal(planning.listBlocks().find(p=>p.taskId===a)!.start,at(date,480))
  })
  await test('手动移动锁定/已经开始的安排被拒绝；未锁定旧块可释放选择',()=>{
    reset();const id=task('保护原块');const b=planning.saveBlockAt(id,at(date,480),at(date,540),now);assert.ok(planning.manualSlots(id,date,date,now).days[0].candidates.some(c=>c.start===at(date,480)))
    planning.lockBlock(b.id,true);assert.match(planning.manualSlots(id,date,date,now).days[0].note!,/锁定/);assert.throws(()=>planning.saveBlockAt(id,at(date,600),at(date,660),now),/锁定/)
    planning.lockBlock(b.id,false);assert.throws(()=>planning.saveBlockAt(id,at(date,600),at(date,660),at(date,490)),/开始/)
  })
  await test('手动跨窗口改期返回旧块并保留用户主动推迟原因',()=>{
    reset();const id=task('跨窗口');planning.saveBlockAt(id,at(date,480),at(date,540),now)
    assert.equal(planning.manualSlots(id,next,next,now).previous.length,1)
    planning.saveBlockAt(id,at(next,480),at(next,540),now,{reason:'user_postpone',note:'用户明确'})
    assert.ok(db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND kind='postponed' AND reason='user_postpone'").get(id))
  })
  await test('手动排期审计失败时原安排与统计基线一并保留',()=>{
    reset();const id=task('手动回滚');planning.saveBlockAt(id,at(date,480),at(date,540),now)
    db.exec("CREATE TRIGGER fail_integrated_manual BEFORE INSERT ON task_events WHEN NEW.kind='rescheduled' BEGIN SELECT RAISE(ABORT,'rollback'); END")
    try{assert.throws(()=>planning.saveBlockAt(id,at(next,480),at(next,540),now),/rollback/);assert.equal(planning.listBlocks()[0].start,at(date,480));assert.equal((db.prepare('SELECT COUNT(*) AS n FROM day_plan_snapshots').get() as {n:number}).n,1)}finally{db.exec('DROP TRIGGER fail_integrated_manual')}
  })
  await test('批量课表导入也不能压住已经保存的任务',()=>{
    reset();const id=task('批量保护');planning.saveBlockAt(id,at(date,480),at(date,540),now)
    assert.throws(()=>planning.importCourses([{name:'冲突课程',weekday:1,startMin:480,endMin:540,fromDate:date,toDate:next}]),/冲突/);assert.equal(planning.listCourses().length,0)
  })
  await test('课表非法分钟不能静默滚入下一小时',()=>{assert.equal(parseTimetable('数分, 周一, 08:99-10:00',date,next).rows.length,0);assert.equal(parseTimetable('数分, 周一, 23:00-24:00',date,next).rows.length,1)})
  await test('OCR模型单独保存，不改变规划模型，空值兼容沿用',()=>{
    const before=getSettings();setSettings({aiModel:'planning-test',ocrModel:'vision-test'});assert.equal(ocrSettings().aiModel,'vision-test');assert.equal(getSettings().aiModel,'planning-test');setSettings({ocrModel:''});assert.equal(ocrSettings().aiModel,'planning-test');setSettings(before)
  })
  await test('不连续识别页按真实页段返回，续传从首个缺页开始',()=>{
    const doc='integration-gap';db.prepare("INSERT INTO study_documents(id,path,name,ext,size_bytes,content_hash,page_count,char_count,status,ocr_state,created_at,updated_at) VALUES(?,?,'缺页教材','pdf',100,'hash',5,20,'parsed','done','2030-01-07','2030-01-07')").run(doc,'synthetic-gap.pdf')
    for(const n of [2,4])db.prepare("INSERT INTO study_pages(doc_id,page_no,text,source,created_at) VALUES(?,?,'正文','ocr','2030-01-07')").run(doc,n)
    assert.equal(getDocument(doc)!.firstMissingPage,1);const view=listForAgent().find(d=>d.docId===doc)!;assert.deepEqual(view.readablePageRanges,[{from:2,to:2},{from:4,to:4}]);assert.doesNotMatch(view.hint,/前 2 页/)
    db.prepare('DELETE FROM study_documents WHERE id=?').run(doc)
  })
  reset()
}
