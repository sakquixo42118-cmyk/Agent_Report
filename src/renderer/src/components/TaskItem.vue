<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import type { Task } from '@shared/types'
import { computeScore } from '@shared/priority'
import { tasksActions } from '../stores/tasks'
import { inputDate } from '../lib/planningTime'
import type { CompletionDetail, DurationEstimate } from '@shared/profile'
import CompletionFeedbackEditor from './CompletionFeedbackEditor.vue'

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{ removed: [] }>()
void emit

const done = computed(() => props.task.status === 'done')
const score = computed(() => computeScore(props.task))
const adjustOpen = ref(false)
const timingOpen = ref(false), deadlineInput = ref(''), estimateInput = ref(30), timingBusy = ref(false), timingError = ref('')
const estimateGroup = ref(''), feedbackDetail = ref<CompletionDetail | null>(null), feedbackError = ref(''), personal = ref<DurationEstimate | null>(null)
let offProfile: (() => void) | undefined
async function refreshEstimate(): Promise<void> { try { personal.value = await window.api.durationEstimate(props.task.id) } catch { personal.value=null } }
onMounted(() => { void refreshEstimate(); offProfile=window.api.onProfileChanged(() => void refreshEstimate()) })
onUnmounted(() => offProfile?.())
watch(() => [props.task.baseEstimateMin,props.task.estimateGroup,props.task.estimateSource], () => void refreshEstimate())
async function openFeedback(): Promise<void> {
  if(feedbackDetail.value){feedbackDetail.value=null;return}
  try { const result=await window.api.completionForTask(props.task.id); if(!result?.event.valid)throw new Error('这条旧完成记录没有有效估时快照，暂不能用于个人校准。'); feedbackDetail.value=result; feedbackError.value='' }
  catch(e){feedbackError.value=e instanceof Error?e.message:String(e)}
}
function openTiming(): void {
  timingOpen.value = !timingOpen.value; timingError.value = ''
  deadlineInput.value = inputDate(props.task.deadlineAt || (!props.task.deadlineConfirmed ? props.task.legacyDueAt : null))
  estimateInput.value = props.task.estimateMin
  estimateGroup.value = props.task.estimateGroup
}
async function saveTiming(): Promise<void> {
  timingBusy.value = true; timingError.value = ''
  try {
    if (!Number.isInteger(estimateInput.value) || estimateInput.value < 5 || estimateInput.value > 1440) throw new Error('耗时请填写5—1440分钟。')
    await tasksActions.updateTask({ id: props.task.id, deadlineAt: deadlineInput.value ? new Date(deadlineInput.value).toISOString() : null, estimateMin: estimateInput.value, estimateGroup: estimateGroup.value })
    timingOpen.value = false
  } catch (e) { timingError.value = e instanceof Error ? e.message : String(e) }
  finally { timingBusy.value = false }
}

async function setImportance(n: number): Promise<void> {
  await tasksActions.updateTask({ id: props.task.id, importance: n })
}
async function setUrgency(n: number): Promise<void> {
  await tasksActions.updateTask({ id: props.task.id, urgency: n })
}

const aiStatusLabel = computed(() => {
  if (props.task.aiStatus === 'confirmed') return '草案已确认'
  if (props.task.aiStatus === 'failed') return 'AI 分析失败 · 规则排序'
  if (props.task.aiStatus === 'none') return '规则排序'
  return ''
})

async function retryAnalyze(): Promise<void> {
  await window.api.taskRetryAnalyze(props.task.id)
}

/** 截止时间显示：相对时间 + 颜色 */
const dueInfo = computed(() => {
  if (!props.task.dueAt) return null
  const due = new Date(props.task.dueAt)
  const diffH = (due.getTime() - Date.now()) / 3_600_000
  let cls = 'due-normal'
  let label = ''
  if (diffH < 0) {
    cls = 'due-over'
    label = `已过期 ${formatRel(-diffH)}`
  } else if (diffH < 24) {
    cls = 'due-soon'
    label = `${formatRel(diffH)}后截止`
  } else {
    label = `${formatDate(due)} 截止`
  }
  return { cls, label, date: due }
})

function formatRel(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}分钟`
  if (h < 24) return `${Math.round(h)}小时`
  return `${Math.round(h / 24)}天`
}

function formatDate(d: Date): string {
  const m = d.getMonth() + 1
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${m}月${day}日 ${hh}:${mm}`
}

async function toggle(): Promise<void> {
  try { await tasksActions.completeTask(props.task.id, !done.value); feedbackDetail.value=null; feedbackError.value='' }
  catch(e){feedbackError.value=e instanceof Error?e.message:String(e)}
}

async function remove(): Promise<void> {
  await tasksActions.deleteTask(props.task.id)
}
</script>

<template>
  <div class="task-item" :class="{ done }">
    <button class="check" :class="{ checked: done }" @click="toggle" aria-label="完成">
      <span v-if="done">✓</span>
    </button>

    <div class="body">
      <!-- 有 AI 提炼摘要且与原文不同 → 显示摘要，原文折叠 -->
      <div v-if="task.summary && task.summary !== task.content" class="content">{{ task.summary }}</div>
      <div v-else class="content">{{ task.content }}</div>
      <div v-if="task.summary && task.summary !== task.content" class="origin">
        <details>
          <summary>原文</summary>
          <div class="origin-text">{{ task.content }}</div>
        </details>
      </div>
      <div class="meta">
        <span class="score" :title="`重要性${task.importance} · 紧急度${task.urgency}${task.manualLocked ? ' · 已手动锁定' : ''}`">{{ score }}</span>
        <span v-if="task.chainTotal > 1" class="chain" :title="`项目链条 ${task.chainOrder}/${task.chainTotal}，推迟会自动顺延后续任务`">🔗 {{ task.chainOrder }}/{{ task.chainTotal }}</span>
        <span v-if="task.rangeStart" class="range-badge" title="范围计划任务，由系统按每天负载自动分配日期">📅 自动分配</span>
        <span class="badge cat">{{ task.category }}</span>
        <span v-for="t in task.tags" :key="t" class="tag">{{ t }}</span>
        <span v-if="dueInfo" class="due" :class="dueInfo.cls">{{ dueInfo.label }}</span>
        <span v-if="task.snoozeCount > 0" class="snooze">已推迟{{ task.snoozeCount }}次</span>
        <span v-if="task.manualLocked" class="locked" title="已手动锁定，AI 重评不会覆盖">🔒</span>
      </div>
      <div v-if="adjustOpen" class="adjust">
        <div class="adjust-row">
          <span class="adjust-label">重要</span>
          <button
            v-for="n in [1, 2, 3, 4, 5]"
            :key="`i${n}`"
            class="dot"
            :class="{ on: n <= task.importance }"
            @click="setImportance(n)"
            :title="`重要性 ${n}`"
          >{{ n }}</button>
        </div>
        <div class="adjust-row">
          <span class="adjust-label">紧急</span>
          <button
            v-for="n in [1, 2, 3, 4, 5]"
            :key="`u${n}`"
            class="dot"
            :class="{ on: n <= task.urgency }"
            @click="setUrgency(n)"
            :title="`紧急度 ${n}`"
          >{{ n }}</button>
        </div>
        <span class="adjust-tip">调整后立即生效并锁定（AI 不再覆盖）</span>
      </div>
      <div v-if="task.status === 'inbox'" class="analyzing"><span class="spinner"></span>AI 分析中…</div>
      <div v-else-if="aiStatusLabel" class="ai-note" :class="{ failed: task.aiStatus === 'failed' }">
        {{ aiStatusLabel }}
        <button v-if="task.aiStatus === 'failed'" class="retry-btn" @click="retryAnalyze">重试分析</button>
      </div>
    </div>

    <div class="actions">
      <button v-if="!done" class="act" @click="adjustOpen = !adjustOpen" title="手动调整重要/紧急">调级</button>
      <button v-if="!done" class="act" @click="openTiming" title="设置真正的截止时间和预计耗时">时间设置</button>
      <button v-if="done" class="act" @click="openFeedback">完成反馈</button>
      <button class="act danger" @click="remove" title="删除">删除</button>
    </div>
  </div>
  <div v-if="timingOpen" class="timing-editor">
    <p v-if="!task.deadlineConfirmed">当前日期是旧版记录或自动提取的候选，请核对：这是必须提交的期限，还是只是准备执行的日期？</p>
    <label>截止时间（留空表示无截止）<input v-model="deadlineInput" type="datetime-local" /></label>
    <label>预计耗时（分钟）<input v-model.number="estimateInput" type="number" min="5" max="1440" step="5" /></label>
    <label>估时分组（同类任务一起校准）<input v-model="estimateGroup" maxlength="60" placeholder="例如：数学分析" /></label>
    <span>执行时间到“日程”里自己挑空档，或让“助理”试排；改执行安排不会改此截止。</span>
    <p v-if="timingError" role="alert">{{ timingError }}</p>
    <button class="act" :disabled="timingBusy" @click="saveTiming">确认时间信息</button>
  </div>
  <p v-else-if="!task.deadlineConfirmed" class="time-unconfirmed">日期待确认：请打开“时间设置”，确认真实截止或留空。</p>
  <p v-if="!done && personal?.sampleCount" class="time-unconfirmed">{{ personal.applied ? '个人估时' : '参考估时' }} {{ personal.estimateMin }}分钟 · 原始{{ personal.baseMin }}分钟 · {{ personal.sampleCount }}个有效样本（{{ personal.groupKey }}）</p>
  <p v-if="feedbackError" role="alert" class="time-unconfirmed">{{ feedbackError }}</p>
  <div v-if="feedbackDetail && done" class="feedback-panel"><CompletionFeedbackEditor :detail="feedbackDetail" @saved="feedbackDetail=null" /></div>
</template>

<style scoped>
.feedback-panel{padding:8px 14px;background:var(--primary-light);border-radius:8px;margin-bottom:12px}
.timing-editor{display:flex;flex-wrap:wrap;gap:10px;align-items:end;padding:12px;background:var(--primary-light);border-radius:8px;margin:4px 0 10px}.timing-editor label{display:grid;gap:5px;font-size:12px}.timing-editor input{padding:7px;border:1px solid var(--border);border-radius:5px;background:var(--panel);color:var(--text)}.timing-editor>span,.timing-editor>p{width:100%;font-size:12px;line-height:1.6}.time-unconfirmed{font-size:12px;color:#986620;margin:0 0 10px 12px}
.task-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  transition: all 0.15s;
}
.task-item:hover {
  box-shadow: var(--shadow);
}
.check {
  width: 20px;
  height: 20px;
  min-width: 20px;
  border: 2px solid #c9cdd4;
  border-radius: 50%;
  margin-top: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  transition: all 0.15s;
}
.check:hover {
  border-color: var(--success);
}
.check.checked {
  background: var(--success);
  border-color: var(--success);
}
.body {
  flex: 1;
  min-width: 0;
}
.content {
  font-size: 14px;
  line-height: 1.5;
  word-break: break-all;
}
.done .content {
  color: var(--text-3);
  text-decoration: line-through;
}
.origin {
  margin-top: 4px;
}
.origin summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-3);
  user-select: none;
  width: fit-content;
}
.origin-text {
  font-size: 12px;
  color: var(--text-3);
  background: var(--bg);
  border-radius: 6px;
  padding: 8px 10px;
  margin-top: 6px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  align-items: center;
}
.score {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary);
  background: var(--primary-light);
  padding: 2px 8px;
  border-radius: 10px;
  min-width: 34px;
  text-align: center;
}
.analyzing {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.ai-note {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
}
.ai-note.failed {
  color: var(--warning);
}
.retry-btn {
  margin-left: 8px;
  font-size: 12px;
  color: var(--primary);
  text-decoration: underline;
}
.badge.cat {
  background: var(--bg);
  color: var(--text-2);
}
.tag {
  font-size: 12px;
  color: var(--primary);
  background: var(--primary-light);
  padding: 2px 8px;
  border-radius: 4px;
}
.due {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
}
.due-normal {
  color: var(--text-2);
  background: var(--bg);
}
.due-soon {
  color: var(--warning);
  background: var(--warning-bg);
}
.due-over {
  color: #fff;
  background: var(--danger);
}
.snooze {
  font-size: 12px;
  color: var(--text-3);
}
.locked {
  font-size: 12px;
}
.chain {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg);
  padding: 2px 8px;
  border-radius: 4px;
}
.range-badge {
  font-size: 11px;
  color: var(--primary);
  background: var(--primary-light);
  padding: 2px 8px;
  border-radius: 4px;
}
.chain-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--primary);
  background: var(--primary-light);
  padding: 4px 10px;
  border-radius: 6px;
  width: fit-content;
  animation: toast-in 0.2s ease;
}
.adjust {
  margin-top: 8px;
  background: var(--bg);
  border-radius: 8px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.adjust-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.adjust-label {
  font-size: 12px;
  color: var(--text-2);
  width: 32px;
}
.dot {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
}
.dot.on {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.dot:hover {
  border-color: var(--primary);
}
.adjust-tip {
  font-size: 11px;
  color: var(--text-3);
}
.actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}
.task-item:hover .actions {
  opacity: 1;
}
.act {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 6px;
}
.act.danger:hover {
  color: var(--danger);
}
.done .actions {
  display: none;
}
</style>
