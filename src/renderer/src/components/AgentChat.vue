<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import type { AgentRun, RunSummary } from '@shared/agent'
import type { StudyDocument } from '@shared/study'
import { groupChatEvents, toolSummary } from '../lib/chatEvents'
import PlanPreviewCard from './PlanPreviewCard.vue'
import TaskDraftEditor from './TaskDraftEditor.vue'
import {agentNavigation,openAgentRun} from '../stores/agentNavigation'
import PlanReasonEditor from './PlanReasonEditor.vue'
import type {PlanAuditInput} from '@shared/statistics'
const planAudit=ref<PlanAuditInput>({reason:'unspecified',note:''})

/** standalone：作为独立板块铺满整个内容区，不再重复页面标题 */
const props = withDefaults(defineProps<{ standalone?: boolean }>(), { standalone: false })
const standalone = computed(() => props.standalone)
const run = ref<AgentRun | null>(null)
const input = ref('')
const busy = ref(false)
const error = ref('')
const history=ref<RunSummary[]>([]),draftDirty=ref(false),fresh=ref(false)
const draftVersion=computed(()=>run.value?.pending&&'type' in run.value.pending&&run.value.pending.type==='task_draft'?run.value.pending.expectedVersion:undefined)
const draftPending=computed(()=>!!run.value?.pending&&'type' in run.value.pending&&run.value.pending.type==='task_draft')
const messageList = ref<HTMLElement | null>(null)
const priority = computed(() => run.value?.pending && !('type' in run.value.pending) ? run.value.pending : null)
const plan = computed(() => run.value?.pending && 'type' in run.value.pending && run.value.pending.type==='plan' ? run.value.pending.preview : null)
const hasPlanMoves=computed(()=>plan.value?.blocks.some(b=>plan.value!.previous.some(p=>p.taskId===b.taskId&&(p.start!==b.start||p.end!==b.end))))
watch(()=>plan.value?.id,()=>{planAudit.value={reason:'unspecified',note:''}})
const memory = computed(() => run.value?.pending && 'type' in run.value.pending && run.value.pending.type==='memory' ? run.value.pending : null)
/** 只有等待回答时才有意义；旧选项在回复后即失效，避免误点过期按钮 */
const questionOptions = computed(() => run.value?.status === 'waiting_user' ? run.value.question?.options ?? [] : [])
watch(() => run.value?.events.length, async () => {
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
})
const statuses = { running: '正在处理', waiting_user: '等待你的回复', awaiting_confirmation: '待确认方案', completed: '本轮结束', cancelled: '已停止', failed: '运行未完成' }
const disabled = computed(() => busy.value || draftDirty.value || run.value?.status === 'running' || (run.value?.status === 'awaiting_confirmation'&&!draftPending.value))
let removeListener: (() => void) | undefined
let removeOcrListener: (() => void) | undefined
async function refresh(): Promise<void> {
  const selection=openSequence
  try {
    history.value=await window.api.agentHistory()
    if(selection!==openSequence)return
    if(fresh.value&&!run.value)return
    const id = run.value?.id
    const result = id ? await window.api.agentGet(id) : await window.api.agentLatest()
    if (selection===openSequence&&(!id || run.value?.id === id)) run.value = result
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
let openSequence=0
async function showRun(id:string):Promise<void>{const serial=++openSequence;try{const r=await window.api.agentGet(id);if(serial===openSequence){run.value=r;fresh.value=false;draftDirty.value=false;error.value=''}}catch(e){error.value=String(e)}}
watch(()=>agentNavigation.revision,()=>{if(agentNavigation.runId)void showRun(agentNavigation.runId)})
function acceptRun(r:AgentRun):void{run.value=r;draftDirty.value=false;openAgentRun(r.id);void refresh()}
async function mockReview():Promise<void>{busy.value=true;try{acceptRun(await window.api.mockReviewStart())}catch(e){error.value=String(e)}finally{busy.value=false}}
const studyBusy = ref(false)
const notice = ref('')
interface OcrTask { docId: string; name: string; pageCount: number; startPage: number }
const ocrQueue = ref<OcrTask[]>([])
const ocrFrom = ref(1)
const ocrTo = ref(1)
const ocrRunning = ref(false)
const ocrDone = ref(0)
const ocrTotal = ref(0)
const ocrMessage = ref('')
const ocrTask = computed<OcrTask | null>(() => ocrQueue.value[0] ?? null)
/** 默认只排前 30 页：整本扫描教材可能上百页，先小步验证效果再放大 */
const OCR_DEFAULT_PAGES = 30
function queueOcr(doc: StudyDocument, startPage = 1): void {
  ocrQueue.value.push({ docId: doc.id, name: doc.name, pageCount: doc.pageCount, startPage })
  if (ocrQueue.value.length === 1) {
    ocrFrom.value = startPage
    ocrTo.value = Math.min(doc.pageCount, startPage + OCR_DEFAULT_PAGES - 1)
  }
}
function resetRange(task: OcrTask | null): void {
  if (!task) return
  ocrFrom.value = task.startPage
  ocrTo.value = Math.min(task.pageCount, task.startPage + OCR_DEFAULT_PAGES - 1)
}
async function pickStudy(): Promise<void> {
  if (studyBusy.value || disabled.value) return
  studyBusy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await window.api.studyPick()
    if (result.canceled) return
    const lines: string[] = []
    for (const doc of result.documents) {
      // 以"有没有抽出文字"为准，而不是只看 ocrState：此前渲染失败留下的空记录状态仍可能是 done
      const pdf = doc.ext === 'pdf' && doc.pageCount > 0
      const noText = pdf && (doc.ocrState === 'needed' || doc.charCount === 0 || (doc.ocrState === 'done' && doc.recognizedPages === 0))
      // 已识别一部分：不能报成"整本已解析"，否则会以为全书可分析
      const partial = pdf && doc.ocrState === 'done' && doc.recognizedPages > 0 && doc.recognizedPages < doc.pageCount
      if (noText) {
        queueOcr(doc)
        lines.push(`《${doc.name}》没有文字层（${doc.pageCount} 页），可在下方识别文字后再分析考点`)
        continue
      }
      if (partial) {
        queueOcr(doc, doc.firstMissingPage ?? 1)
        lines.push(`《${doc.name}》已识别 ${doc.recognizedPages}/${doc.pageCount} 页（${doc.charCount.toLocaleString('zh-CN')} 字），其余页仍无文字，可在下方继续识别`)
        continue
      }
      lines.push(doc.status === 'parsed'
        ? `已解析《${doc.name}》：${doc.pageCount} 页 / ${doc.charCount.toLocaleString('zh-CN')} 字`
        : `《${doc.name}》未能解析：${doc.lastError ?? '未知原因'}`)
    }
    for (const item of result.errors) lines.push(`${item.path}：${item.message}`)
    notice.value = lines.join('\n')
    void refresh()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { studyBusy.value = false }
}
async function startOcr(): Promise<void> {
  const task = ocrTask.value
  if (!task || ocrRunning.value) return
  const from = Math.max(1, Math.floor(Number(ocrFrom.value) || 1))
  const to = Math.min(task.pageCount, Math.floor(Number(ocrTo.value) || task.pageCount))
  if (to < from) { error.value = '结束页不能小于起始页。'; return }
  ocrRunning.value = true; error.value = ''; ocrMessage.value = ''
  ocrDone.value = 0; ocrTotal.value = to - from + 1
  try {
    const res = await window.api.studyOcr(task.docId, from, to)
    const head = res.preview ? `\n开头：${res.preview}…` : ''
    ocrMessage.value = res.document.ocrState === 'failed'
      ? `没有识别出文字：${res.document.lastError ?? '未知原因'}`
      : (res.cancelled
        ? `已取消：本次识别 ${res.recognized} 页，跳过 ${res.skipped} 页已有内容；已完成的部分已保存。`
        : `识别完成：《${res.document.name}》已识别 ${res.document.recognizedPages}/${res.document.pageCount} 页 / ${res.document.charCount.toLocaleString('zh-CN')} 字（本次 ${res.recognized} 页，跳过 ${res.skipped} 页）`) + head
    if (res.document.ocrState !== 'failed' && !res.cancelled && res.recognized > 0 && to < task.pageCount) {
      // 大文件分段识别：保留卡片并把范围推进到下一段，免得每段都要重新选文件
      ocrFrom.value = to + 1
      ocrTo.value = Math.min(task.pageCount, to + OCR_DEFAULT_PAGES)
      ocrMessage.value += `\n还有 ${task.pageCount - to} 页未识别，可继续下一段。`
    } else {
      ocrQueue.value = ocrQueue.value.slice(1)
      resetRange(ocrTask.value)
    }
    void refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { ocrRunning.value = false }
}
function cancelOcr(): void {
  const task = ocrTask.value
  if (task) void window.api.studyOcrCancel(task.docId)
}
function skipOcr(): void {
  ocrQueue.value = ocrQueue.value.slice(1)
  ocrMessage.value = ''
  resetRange(ocrTask.value)
}
async function send(): Promise<void> {
  if (disabled.value || !input.value.trim()) return
  busy.value = true; error.value = ''
  const text = input.value.trim()
  try {
    run.value = run.value ? await window.api.agentSend(run.value.id, text) : await window.api.agentStart(text)
    input.value = ''
    await refresh()
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
/** 点选项等于把该句作为答复发出；输入框仍可自行组织答案 */
async function choose(option: string): Promise<void> {
  if (disabled.value || busy.value) return
  input.value = option
  await send()
}
async function confirm(accepted: boolean): Promise<void> {
  if (!run.value || busy.value) return
  busy.value = true; error.value = ''
  try { run.value = await window.api.agentConfirm(run.value.id, accepted,undefined,hasPlanMoves.value?{reason:planAudit.value.reason,note:planAudit.value.note}:undefined) }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
async function stop(): Promise<void> {
  if (!run.value) return
  try { run.value = await window.api.agentCancel(run.value.id) }
  catch (e) { error.value = String(e) }
}
function newChat(): void { if (!busy.value && !draftDirty.value && run.value?.status !== 'running' && !run.value?.pending) { run.value = null; fresh.value=true; error.value = ''; input.value = '' } }
function toolText(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}
/** 一轮对话常有七八次工具调用，连续记录合并成一条，别把真正的答复挤出视野 */
const rows = computed(() => groupChatEvents(run.value?.events ?? []))
onMounted(() => {
  void (async()=>{if(agentNavigation.runId)await showRun(agentNavigation.runId);await refresh()})()
  removeListener = window.api.onAgentChanged(() => void refresh())
  removeOcrListener = window.api.onStudyOcrProgress((p) => {
    if (p.docId !== ocrTask.value?.docId) return
    ocrDone.value = p.done; ocrTotal.value = p.total
    if (p.message) ocrMessage.value = p.message
  })
})
onUnmounted(() => { removeListener?.(); removeOcrListener?.() })
</script>

<template>
  <section class="agent-chat" :class="{ standalone }" aria-label="助理">
    <header class="chat-head">
      <div><h3 v-if="!standalone">助理</h3><span>{{ run ? statuses[run.status] : standalone ? '新对话，或从最近记录继续' : '查任务、讨论安排、调整轻重缓急' }}</span></div>
      <button class="small" :disabled="busy || draftDirty || run?.status === 'running' || !!run?.pending" @click="newChat">新对话</button>
    </header>
    <label class="chat-hint">最近对话 <select :value="run?.id??''" :disabled="busy||draftDirty" @change="openAgentRun(($event.target as HTMLSelectElement).value)"><option value="" disabled>选择最近30次记录</option><option v-for="h in history" :key="h.id" :value="h.id">{{ {planning:'规划',capture:'录入',study_mock:'模拟作业'}[h.scene as 'planning']??h.scene }} · {{ h.goal.slice(0,35) }} · {{ statuses[h.status] }}</option></select></label>
    <div v-if="!run" class="welcome">试试“看看我有哪些未完成任务”，或“把报告的重要度改成4”。有不明确的地方，我会先问你。</div>
    <div v-else ref="messageList" class="messages" aria-live="polite">
      <template v-for="row in rows" :key="row.key">
        <details v-if="row.tools.length" class="tool-event"><summary>{{ toolSummary(row.tools) }}</summary><pre>{{ row.tools.map(e => toolText(e.text)).join('\n\n') }}</pre></details>
        <div v-else class="message" :class="row.event!.kind"><span class="speaker">{{ row.event!.kind === 'user' ? '你' : row.event!.kind === 'status' ? '运行提示' : '助理' }}</span><p>{{ row.event!.text }}</p></div>
      </template>
      <div v-if="run.status === 'running'" class="working">正在查看信息… <button class="small" @click="stop">停止</button></div>
    </div>
    <div v-if="questionOptions.length" class="quick-replies" role="group" aria-label="可选回复">
      <span class="quick-hint">点选一个直接回复，也可以在下面自己写</span>
      <button v-for="option in questionOptions" :key="option" class="quick-option" type="button" :disabled="disabled || busy" @click="choose(option)">{{ option }}</button>
    </div>
    <TaskDraftEditor v-if="run?.draftId && run.draftState!=='discarded' && run.status!=='running'" :key="run.draftId" :draft-id="run.draftId" :version="draftVersion" @dirty="draftDirty=$event" @run="acceptRun" />
    <div v-if="run?.pending && !draftPending" class="proposal">
      <template v-if="memory"><strong>确认记忆：{{ memory.fact.scope }} / {{ memory.fact.key }}</strong><p v-if="memory.before">原值：{{ memory.before.value }}</p><p>新值：{{ memory.fact.value }}</p><p>{{ memory.fact.expiresAt ? '有效至 '+new Date(memory.fact.expiresAt).toLocaleString('zh-CN') : '长期有效，可在个人记忆中移除' }}</p></template>
      <PlanPreviewCard v-if="plan" :preview="plan" />
      <PlanReasonEditor v-if="hasPlanMoves" v-model="planAudit" />
      <template v-if="priority"><strong>调整「{{ priority.title }}」</strong>
      <p>重要度 {{ priority.before.importance }} → {{ priority.after.importance }}　紧急度 {{ priority.before.urgency }} → {{ priority.after.urgency }}</p>
      <p>{{ priority.reason }}</p></template>
      <div class="proposal-actions"><button class="primary" :disabled="busy" @click="confirm(true)">{{ memory ? '确认保存记忆' : plan ? '确认保存计划' : '确认调整' }}</button><button class="small" :disabled="busy" @click="confirm(false)">放弃</button></div>
    </div>
    <p v-if="notice" class="chat-note">{{ notice }}</p>
    <section v-if="ocrTask" class="ocr-card" aria-live="polite">
      <p class="ocr-head">《{{ ocrTask.name }}》共 {{ ocrTask.pageCount }} 页<template v-if="ocrFrom > 1">，已有 {{ ocrFrom - 1 }} 页有文字</template>，其余页没有文字层，识别后才能分析</p>
      <div class="ocr-range">
        <label>第 <input v-model.number="ocrFrom" type="number" min="1" :max="ocrTask.pageCount" :disabled="ocrRunning" aria-label="起始页"> 页到第
          <input v-model.number="ocrTo" type="number" min="1" :max="ocrTask.pageCount" :disabled="ocrRunning" aria-label="结束页"> 页</label>
        <span class="ocr-hint">逐页调用模型；已识别过的页会自动跳过，不重复花费</span>
      </div>
      <div v-if="ocrRunning" class="ocr-progress">
        <progress :value="ocrDone" :max="Math.max(ocrTotal,1)"></progress>
        <span>{{ ocrDone }} / {{ ocrTotal }} 页</span>
      </div>
      <p v-if="ocrMessage" class="ocr-message">{{ ocrMessage }}</p>
      <div class="ocr-actions">
        <button class="primary" type="button" :disabled="ocrRunning || disabled" @click="startOcr">{{ ocrRunning ? '识别中…' : '识别文字' }}</button>
        <button v-if="ocrRunning" class="small" type="button" @click="cancelOcr">取消</button>
        <button v-else class="small" type="button" :disabled="disabled" @click="skipOcr">暂不识别</button>
      </div>
    </section>
    <p v-if="error" role="alert" class="chat-error">{{ error }}</p>
    <form class="composer" @submit.prevent="send">
      <button class="small attach" type="button" :disabled="studyBusy || disabled" :title="'选择教材或试卷（PDF / Word / 文本），解析后用于分析考点'" @click="pickStudy">{{ studyBusy ? '解析中…' : '教材/试卷' }}</button>
      <textarea v-model="input" aria-label="给助理发消息" placeholder="说说你需要处理的事…" rows="2" maxlength="2000" :disabled="disabled" @keydown.ctrl.enter.prevent="send"></textarea>
      <button class="primary" type="submit" :disabled="disabled || !input.trim()">发送</button>
    </form>
    <span class="chat-hint">Ctrl + Enter 发送 · 调整前可核对草案</span>
    <details class="chat-hint"><summary>模拟作业模块对接验证</summary><p>使用固定错题证据生成复习草案，确认后可转入规划；不包含真实作业解答或OCR。</p><button class="small" :disabled="busy||draftDirty||run?.status==='running'" @click="mockReview">生成模拟复习草案</button></details>
  </section>
</template>

<style scoped>
.chat-hint select{max-width:100%;padding:5px;margin:5px;border:1px solid var(--border);background:var(--panel);color:var(--text-2);border-radius:6px}summary{cursor:pointer}
.agent-chat{border:1px solid var(--border);background:var(--panel);border-radius:14px;padding:16px;margin-bottom:22px;min-width:0}
.agent-chat.standalone{border:none;background:transparent;border-radius:0;padding:0;margin-bottom:0;display:flex;flex-direction:column}
.agent-chat.standalone .messages{max-height:none;height:calc(100vh - 400px);min-height:260px}
.chat-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.chat-head h3{font-size:16px;margin:0 0 4px}.chat-head span,.chat-hint{font-size:12px;color:var(--text-3)}
.messages{max-height:390px;overflow:auto;padding:12px 2px}.message{padding:10px 12px;background:var(--bg);border-radius:10px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{margin-left:12%;background:var(--primary-light)}.message.status{border-left:3px solid #d89235}.speaker{font-size:11px;color:var(--text-3)}.message p{margin:5px 0 0;line-height:1.7}
.welcome{padding:18px 0;color:var(--text-2);line-height:1.8}.tool-event{font-size:12px;color:var(--text-3);margin:8px}.tool-event summary{cursor:pointer}.tool-event pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto;background:var(--bg);padding:10px}
.proposal{border:1px solid var(--primary);border-radius:10px;padding:12px;margin:10px 0;background:var(--primary-light)}.proposal p{font-size:13px;line-height:1.6;margin:7px 0}.proposal-actions{display:flex;gap:10px}.primary,.small{padding:8px 12px;border-radius:8px;cursor:pointer}.primary{background:var(--primary);color:white}.small{border:1px solid var(--border);color:var(--text-2);background:var(--panel)}button:disabled{opacity:.5;cursor:default}
.quick-replies{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin:10px 0 2px}
.quick-hint{flex:1 0 100%;font-size:12px;color:var(--text-3)}
.quick-option{border:1px solid var(--primary);background:var(--panel);color:var(--text);border-radius:16px;padding:7px 13px;font:inherit;font-size:13px;line-height:1.4;cursor:pointer;text-align:left;overflow-wrap:anywhere}
.quick-option:hover:not(:disabled){background:var(--primary);color:#fff}
.composer{display:flex;gap:10px;align-items:flex-end;margin-top:12px}.composer textarea{flex:1;min-width:0;border:1px solid var(--border);border-radius:9px;padding:10px;background:var(--bg);color:var(--text);font:inherit;resize:vertical}.composer .attach{white-space:nowrap;padding:9px 10px;flex:0 0 auto}.chat-note{font-size:13px;color:var(--text-2);background:var(--bg);border-left:3px solid var(--primary);padding:8px 10px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.ocr-card{border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0;background:var(--panel)}
.ocr-head{font-size:13px;color:var(--text);margin:0 0 8px;overflow-wrap:anywhere}
.ocr-range{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px;color:var(--text-2)}
.ocr-range input{width:64px;border:1px solid var(--border);border-radius:6px;padding:4px 6px;background:var(--bg);color:var(--text);font:inherit}
.ocr-hint{font-size:12px;color:var(--text-3)}
.ocr-progress{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:13px;color:var(--text-2)}
.ocr-progress progress{flex:1;height:8px}
.ocr-message{font-size:13px;color:var(--text-2);margin:10px 0 0;overflow-wrap:anywhere;white-space:pre-wrap}
.ocr-actions{display:flex;gap:10px;margin-top:10px}.chat-hint{display:block;margin-top:7px}.chat-error{color:#b64130;font-size:13px;overflow-wrap:anywhere}.working{color:var(--text-3);font-size:13px}
</style>
