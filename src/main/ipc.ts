import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { IPC, type AppSettings, type Task, type TaskCreateInput, type TaskFilter, type TaskUpdateInput, type BatchCreateResult } from '@shared/types'
import * as taskDao from './db/taskDao'
import type { ChainGroup } from '@shared/types'
import { getSettings, setSettings } from './db/settingsDao'
import { enqueueAnalyze, retryAnalyze, setBroadcastFn } from './ai/analyzer'
import { testConnection, isAiConfigured } from './ai/client'
import type { RebalanceResult } from '@shared/types'
import { AGENT_IPC } from '@shared/agent'
import * as agent from './agent/runner'
import * as agentStore from './agent/store'
import { PLANNING_IPC, type CourseInput, type CalendarExceptionInput, type DayOverride } from '@shared/planning'
import * as planning from './planning/service'
import { PROFILE_IPC, type MemoryInput, type FeedbackInput } from '@shared/profile'
import * as memory from './memory/service'
import * as feedback from './feedback/service'
import { configureWorker, wakeWorker } from './feedback/worker'
import { DRAFT_IPC, type DraftItem } from '@shared/drafts'
import * as drafts from './drafts/service'
import {STATISTICS_IPC,type PlanAuditInput} from '@shared/statistics'
import * as statistics from './statistics/service'
import {ATTENTION_IPC,type AttentionSettings} from '@shared/attention'
import * as attention from './attention/service'
import {configureAttention,wakeAttention} from './attention/worker'
import {sendAttentionDesktop} from './attention/desktop'
import {prepareMessageRun} from './attention/bridge'
import { STUDY_IPC, type StudyDocument, type StudyOcrResult, type StudyPickError, type StudyPickResult } from '@shared/study'
import * as study from './study/documents'
import * as ocr from './study/ocr'

/** 广播任务变化（分析完成/手机端操作后刷新所有视图） */
export function broadcastTaskChanged(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.taskChanged)
  }
}

export function registerIpcHandlers(getWin: () => BrowserWindow | null): void {
  const changed = (): void => broadcastTaskChanged(getWin())
  const attentionChanged=():void=>{const win=getWin();if(win&&!win.isDestroyed())win.webContents.send(ATTENTION_IPC.changed)}
  configureAttention(attentionChanged,agent.isAgentBusy,batch=>sendAttentionDesktop(batch,getWin))
  ipcMain.handle(ATTENTION_IPC.state,()=>attention.attentionState())
  ipcMain.handle(ATTENTION_IPC.settings,(_e,input:AttentionSettings,reminders?:{enabled:boolean;advanceHours:number})=>{attention.savePreferences(input,reminders);attentionChanged();wakeAttention()})
  ipcMain.handle(ATTENTION_IPC.action,(_e,id:string,kind:'read'|'dismiss'|'none'|'later'|'mute',minutes?:number)=>{attention.action(id,kind,minutes);attentionChanged()})
  ipcMain.handle(ATTENTION_IPC.unmute,(_e,key:string)=>{attention.unmute(key);attentionChanged();wakeAttention()})
  ipcMain.handle(ATTENTION_IPC.check,(_e,retry=false)=>{if(typeof retry!=='boolean')throw new Error('检查参数无效。');if(retry)attention.retryFailures();wakeAttention();return attention.attentionState()})
  const fromAttention=(id:string,mode:'capture'|'planning',input?:string):ReturnType<typeof agent.startPreparedRun>=>{
    const runId=prepareMessageRun(id,mode,input)
    const result=agent.startPreparedRun(runId);attentionChanged();return result
  }
  ipcMain.handle(ATTENTION_IPC.capture,(_e,id:string,input:string)=>fromAttention(id,'capture',input))
  ipcMain.handle(ATTENTION_IPC.discuss,(_e,id:string)=>fromAttention(id,'planning'))
  ipcMain.handle(STATISTICS_IPC.read,(_e,date:string)=>statistics.readStatistics(date))
  ipcMain.handle(STATISTICS_IPC.freeze,(_e,date:string)=>{const result=statistics.freezeDay(date);changed();return result})
  const agentChanged = (): void => { changed(); const win=getWin(); if(win&&!win.isDestroyed())win.webContents.send(AGENT_IPC.changed) }
  ipcMain.handle(DRAFT_IPC.capture, (_e, goal: unknown) => agent.startCapture(goal))
  ipcMain.handle(DRAFT_IPC.batch, (_e, raw: unknown) => agent.startBatch(raw))
  ipcMain.handle(DRAFT_IPC.get, (_e, id: string) => drafts.getDraft(id))
  ipcMain.handle(DRAFT_IPC.save, (_e, id: string, version: number, items: DraftItem[]) => { const d=drafts.saveFromUI(id,version,items);agentChanged();return d })
  ipcMain.handle(DRAFT_IPC.add, (_e, id: string, version: number, content: string) => {
    const d=drafts.getDraft(id);if(d.version!==version||agentStore.row(d.runId).status==='running')throw new Error('草案版本已变化或模型正在运行。')
    const next=drafts.addItem(d.runId,{content,estimateMin:30,deadlineMode:'unknown',note:'手动补充候选，耗时请核对。'},'user');agentChanged();return next
  })
  ipcMain.handle(DRAFT_IPC.continuePlan, (_e, id: string) => agent.continueDraftPlan(id))
  ipcMain.handle(DRAFT_IPC.mockReview, () => agent.startMockReview())
  ipcMain.handle(DRAFT_IPC.confirm, (_e,id:string,version:number,accepted:boolean)=>agent.confirmTaskDraft(id,version,accepted))
  const profileChanged = (): void => { const win = getWin(); if (win && !win.isDestroyed()) win.webContents.send(PROFILE_IPC.changed) }
  configureWorker(profileChanged, agent.isAgentBusy)
  ipcMain.handle(PROFILE_IPC.memoryList, () => memory.listFacts())
  ipcMain.handle(PROFILE_IPC.memorySave, (_e, input: MemoryInput, version: number | null) => { const fact = memory.saveFact(input, version); profileChanged(); return fact })
  ipcMain.handle(PROFILE_IPC.memoryRemove, (_e, id: string, version: number) => { memory.removeFact(id, version); profileChanged() })
  ipcMain.handle(PROFILE_IPC.estimate, (_e, id: number) => { const task = taskDao.getTaskById(id); if (!task) throw new Error('任务不存在。'); return memory.durationEstimate(task) })
  ipcMain.handle(PROFILE_IPC.state, () => feedback.profileState())
  ipcMain.handle(PROFILE_IPC.enabled, (_e, enabled: boolean) => { feedback.setEnabled(enabled); profileChanged(); wakeWorker() })
  ipcMain.handle(PROFILE_IPC.calibration, (_e, enabled: boolean) => { feedback.setCalibration(enabled); profileChanged(); changed() })
  ipcMain.handle(PROFILE_IPC.read, (_e, id: string) => { feedback.markRead(id); profileChanged() })
  ipcMain.handle(PROFILE_IPC.dismiss, (_e, id: string) => { feedback.dismiss(id); profileChanged() })
  ipcMain.handle(PROFILE_IPC.completion, (_e, id: number) => feedback.completionForTask(id))
  ipcMain.handle(PROFILE_IPC.feedback, (_e, input: FeedbackInput, messageId?: string) => { feedback.submitFeedback(input, messageId); profileChanged(); changed() })
  ipcMain.handle(PROFILE_IPC.retry, () => { feedback.retryFailed(); wakeWorker(); profileChanged() })
  ipcMain.handle(PLANNING_IPC.read, (_e, start: string, end: string) => planning.snapshot(start, end))
  const checkedVersion = (version: unknown): string => {if(typeof version!=='string'||!/^[a-f0-9]{64}$/.test(version))throw new Error('缺少有效设置版本，请刷新后重试。');return version}
  ipcMain.handle(PLANNING_IPC.exceptionSave, (_e, input: CalendarExceptionInput, version: unknown) => {const id=planning.saveException(input,checkedVersion(version));changed();return id})
  ipcMain.handle(PLANNING_IPC.exceptionDelete, (_e, id: number, version: unknown) => {planning.deleteException(id,checkedVersion(version));changed()})
  ipcMain.handle(PLANNING_IPC.daySave, (_e, input: DayOverride, version: unknown) => {planning.saveDayOverride(input,checkedVersion(version));changed()})
  ipcMain.handle(PLANNING_IPC.dayDelete, (_e, date: string, version: unknown) => {planning.deleteDayOverride(date,checkedVersion(version));changed()})
  ipcMain.handle(PLANNING_IPC.dependencySave, (_e, id: number, prerequisite: number, version: unknown) => {planning.saveDependency(id,prerequisite,checkedVersion(version));changed()})
  ipcMain.handle(PLANNING_IPC.dependencyDelete, (_e, id: number, prerequisite: number, version: unknown) => {planning.deleteDependency(id,prerequisite,checkedVersion(version));changed()})
  ipcMain.handle(PLANNING_IPC.saveCourse, (_e, input) => { planning.saveCourse(input); changed() })
  ipcMain.handle(PLANNING_IPC.importCourses, (_e, rows: CourseInput[]) => { const result = planning.importCourses(rows); changed(); return result })
  ipcMain.handle(PLANNING_IPC.deleteCourse, (_e, id: number) => { planning.deleteCourse(id); changed() })
  ipcMain.handle(PLANNING_IPC.settings, (_e, input) => { planning.saveSettings(input); changed() })
  ipcMain.handle(PLANNING_IPC.preview, (_e, ids: number[], start: string, end: string) => planning.preview(ids, start, end))
  ipcMain.handle(PLANNING_IPC.commit, (_e, id: string, audit?:PlanAuditInput) => { const result = planning.commit(id, null,Date.now(),audit); changed(); return result })
  ipcMain.handle(PLANNING_IPC.freeSlots, (_e, taskId: number, start: string, end: string) => planning.manualSlots(taskId, start, end))
  ipcMain.handle(PLANNING_IPC.saveBlock, (_e, taskId: number, start: number, end: number,audit?:PlanAuditInput) => { const result = planning.saveBlockAt(taskId, start, end,Date.now(),audit); changed(); return result })
  ipcMain.handle(PLANNING_IPC.lock, (_e, id: number, locked: boolean) => { planning.lockBlock(id, locked); changed() })
  ipcMain.handle(PLANNING_IPC.remove, (_e, id: number) => { planning.removeBlock(id); changed() })

  // ===== 学习资料：路径只能由系统对话框产生，其余通道只接收记录编号 =====
  const studyChanged = (): void => { const win = getWin(); if (win && !win.isDestroyed()) win.webContents.send(STUDY_IPC.changed) }
  ipcMain.handle(STUDY_IPC.pick, async (): Promise<StudyPickResult> => {
    const win = getWin()
    const options = {
      title: '选择教材或试卷',
      properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
      filters: [{ name: '可解析的文件', extensions: ['pdf', 'docx', 'txt', 'md'] }]
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return { canceled: true, documents: [], errors: [] }
    const documents: StudyDocument[] = []
    const errors: StudyPickError[] = []
    for (const file of result.filePaths) {
      try {
        const registered = await study.registerFile(file)
        documents.push(await study.parseDocument(registered.id))
      } catch (e) {
        errors.push({ path: file, message: e instanceof Error ? e.message : '添加失败。' })
      }
    }
    studyChanged()
    return { canceled: false, documents, errors }
  })
  ipcMain.handle(STUDY_IPC.list, (): StudyDocument[] => study.listDocuments())
  ipcMain.handle(STUDY_IPC.parse, async (_e, id: string): Promise<StudyDocument> => {
    const doc = await study.parseDocument(id)
    studyChanged()
    return doc
  })
  ipcMain.handle(STUDY_IPC.remove, (_e, id: string) => { study.removeDocument(id); studyChanged() })
  // 扫描件识别：进度按页推送，取消只置标记（已识别的页不会回滚）
  ipcMain.handle(STUDY_IPC.ocr, async (_e, id: string, fromPage?: number, toPage?: number): Promise<StudyOcrResult> => {
    const result = await ocr.ocrDocument(id, {
      fromPage,
      toPage,
      onProgress: (progress) => {
        const win = getWin()
        if (win && !win.isDestroyed()) win.webContents.send(STUDY_IPC.ocrProgress, progress)
      }
    })
    studyChanged()
    return result
  })
  ipcMain.handle(STUDY_IPC.ocrCancel, (_e, id: string) => { ocr.cancelOcr(id) })
  setBroadcastFn(() => broadcastTaskChanged(getWin()))
  agentStore.recoverInterruptedRuns()
  agent.setAgentNotify(() => {
    broadcastTaskChanged(getWin())
    profileChanged()
    const win = getWin()
    if (win && !win.isDestroyed()) win.webContents.send(AGENT_IPC.changed)
  })
  ipcMain.handle(AGENT_IPC.start, (_e, goal: unknown) => agent.startRun(goal))
  ipcMain.handle(AGENT_IPC.send, (_e, id: unknown, message: unknown) => agent.sendMessage(id, message))
  ipcMain.handle(AGENT_IPC.latest, () => agentStore.latestRun())
  ipcMain.handle(AGENT_IPC.get, (_e, id: string) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('对话编号无效。')
    return agentStore.getRun(id)
  })
  ipcMain.handle(AGENT_IPC.confirm, (_e, id: unknown, accepted: unknown, version?:number,audit?:PlanAuditInput) => agent.confirmChange(id, accepted, version,audit))
  ipcMain.handle(AGENT_IPC.history, () => agentStore.runHistory())
  ipcMain.handle(AGENT_IPC.cancel, (_e, id: unknown) => agent.cancelRun(id))

  ipcMain.handle(IPC.taskCreate, (_e, input: TaskCreateInput): Task => {
    const task = taskDao.createTask(input)
    broadcastTaskChanged(getWin())
    enqueueAnalyze(task.id)
    return task
  })

  ipcMain.handle(IPC.taskList, (_e, filter: TaskFilter = {}): Task[] => {
    return taskDao.listTasks(filter)
  })

  ipcMain.handle(IPC.taskUpdate, (_e, input: TaskUpdateInput): Task | null => {
    const task = taskDao.updateTask(input)
    broadcastTaskChanged(getWin())
    return task
  })

  ipcMain.handle(IPC.taskComplete, (_e, id: number, done: boolean): Task | null => {
    const task = taskDao.completeTask(id, done)
    broadcastTaskChanged(getWin())
    profileChanged(); wakeWorker()
    return task
  })

  ipcMain.handle(IPC.taskSnooze, (_e, id: number): { task: Task | null; chained: number } => {
    const result = taskDao.snoozeTask(id)
    broadcastTaskChanged(getWin())
    return { task: result?.task ?? null, chained: result?.chained ?? 0 }
  })

  ipcMain.handle(IPC.taskDelete, (_e, id: number): boolean => {
    const ok = taskDao.deleteTask(id)
    if (ok) broadcastTaskChanged(getWin())
    profileChanged()
    return ok
  })

  ipcMain.handle(IPC.taskRetryAnalyze, (_e, id: number): boolean => {
    retryAnalyze(id)
    return true
  })

  ipcMain.handle(IPC.taskBatchCreate, (): BatchCreateResult => { throw new Error('直接批量创建已停用，请使用batchPreview预览并确认。') })

  ipcMain.handle(IPC.scheduleRebalance, (): RebalanceResult => { throw new Error('旧按天分配已停用，请在助理页或日程中试排。') })

  ipcMain.handle(IPC.projectList, (): taskDao.ProjectGroup[] => taskDao.listProjects())

  ipcMain.handle(IPC.projectAddStep, (_e, projectId: string, content: string, dueAt: string | null): Task | null => {
    const task = taskDao.addChainStep(projectId, content, dueAt)
    broadcastTaskChanged(getWin())
    return task
  })

  ipcMain.handle(IPC.projectMoveStep, (_e, id: number, dir: 'up' | 'down'): boolean => {
    const result = taskDao.moveChainStep(id, dir)
    broadcastTaskChanged(getWin())
    return result !== null
  })

  ipcMain.handle(IPC.chainList, (): ChainGroup[] => taskDao.listChains())

  ipcMain.handle(IPC.chainAppend, (_e, projectId: string, content: string): Task | null => {
    const task = taskDao.appendChainTask(projectId, content)
    if (task) {
      enqueueAnalyze(task.id)
      broadcastTaskChanged(getWin())
    }
    return task
  })

  ipcMain.handle(IPC.chainShift, (_e, projectId: string, days: number): number => {
    throw new Error('旧链条日期平移已停用；请通过新的试排移动执行时间。')
  })

  ipcMain.handle(IPC.chainRemoveTask, (_e, id: number): boolean => {
    const ok = taskDao.removeChainTask(id)
    if (ok) broadcastTaskChanged(getWin())
    return ok
  })

  ipcMain.handle(IPC.projectRebalance, (_e, projectId: string): RebalanceResult => {
    throw new Error('请在助理页查询此项目任务，再试排具体执行时间。')
  })

  ipcMain.handle(IPC.settingsGet, (): AppSettings => getSettings())

  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>): AppSettings => {
    const result = setSettings(patch)
    return result
  })

  ipcMain.handle(IPC.settingsTestAi, async (): Promise<{ ok: boolean; latencyMs?: number; error?: string }> => {
    const settings = getSettings()
    if (!isAiConfigured(settings)) {
      return { ok: false, error: '请先填写 Base URL、API Key 和模型名' }
    }
    try {
      const latencyMs = await testConnection(settings)
      return { ok: true, latencyMs }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
