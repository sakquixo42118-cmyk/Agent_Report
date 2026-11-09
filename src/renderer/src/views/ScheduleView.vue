<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { PlanningSnapshot, PlanPreview, PlanBlock } from '@shared/planning'
import { tasksStore } from '../stores/tasks'
import { localDay, plusDays, clock, minute, formatTime } from '../lib/planningTime'
import PlanPreviewCard from '../components/PlanPreviewCard.vue'
import PlanningConstraintsEditor from '../components/PlanningConstraintsEditor.vue'
import PlanReasonEditor from '../components/PlanReasonEditor.vue'
import type {PlanAuditInput} from '@shared/statistics'
const audit=ref<PlanAuditInput>({reason:'unspecified',note:''})
const hasMoves=computed(()=>preview.value?.blocks.some(b=>preview.value!.previous.some(p=>p.taskId===b.taskId&&(p.start!==b.start||p.end!==b.end))))
const api = window.api
const startDate = ref(localDay()), endDate = computed(() => plusDays(startDate.value, 6))
const data = ref<PlanningSnapshot | null>(null), error = ref(''), notice = ref(''), busy = ref(false), preview = ref<PlanPreview | null>(null)
const selected = ref<number[]>([])
const windowStart = ref('08:00'), windowEnd = ref('22:00'), dailyMax = ref(240), breakMin = ref(10)
const courseName = ref(''), weekday = ref(1), courseStart = ref('09:00'), courseEnd = ref('10:40'), courseFrom = ref(localDay()), courseTo = ref(plusDays(localDay(), 112))
const pending = computed(() => tasksStore.tasks.filter(t => t.status === 'pending'))
const dates = computed(() => Array.from({ length: 7 }, (_, i) => plusDays(startDate.value, i)))
const gridStart=computed(()=>Math.min(data.value?.settings.startMin??480,...(data.value?.effectiveDays.map(d=>d.settings.startMin)??[]),...(data.value?.occupied.map(b=>new Date(b.start).getHours()*60+new Date(b.start).getMinutes())??[])))
const gridEnd=computed(()=>Math.max(data.value?.settings.endMin??1320,...(data.value?.effectiveDays.map(d=>d.settings.endMin)??[]),...(data.value?.occupied.map(b=>localDay(new Date(b.start))!==localDay(new Date(b.end))?1440:new Date(b.end).getHours()*60+new Date(b.end).getMinutes())??[])))
const ticks = computed(() => {
  const start = gridStart.value, end = gridEnd.value
  return Array.from({ length: Math.floor((end - start) / 120) + 1 }, (_, i) => ({ label: clock(start + i * 120), top: `${i * 120 / (end - start) * 100}%` }))
})
let removeListener: (() => void) | undefined
async function refresh(resetSettings = false): Promise<void> {
  try {
    data.value = await window.api.planningRead(startDate.value, endDate.value)
    if (resetSettings) { const s = data.value.settings; windowStart.value = clock(s.startMin); windowEnd.value = clock(s.endMin); dailyMax.value = s.dailyMaxMin; breakMin.value = s.breakMin }
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
async function action(fn: () => Promise<unknown>, success: string): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''; notice.value = ''
  try { await fn(); notice.value = success; await refresh() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
async function addCourse(): Promise<void> {
  await action(() => window.api.courseSave({ name: courseName.value, weekday: weekday.value, startMin: minute(courseStart.value), endMin: minute(courseEnd.value), fromDate: courseFrom.value, toDate: courseTo.value }), '课程已保存。')
  if (!error.value) courseName.value = ''
}
async function trial(): Promise<void> {
  await action(async () => { preview.value = await window.api.planningPreview([...selected.value], startDate.value, endDate.value);audit.value={reason:'unspecified',note:''} }, '试排完成，请核对预览后保存。')
}
async function commit(): Promise<void> {
  if (!preview.value) return
  const id = preview.value.id
  await action(async () => { await window.api.planningCommit(id,hasMoves.value?{reason:audit.value.reason,note:audit.value.note}:undefined); preview.value = null }, '计划已保存，截止时间未变。')
}
function style(b: { start: number; end: number }): Record<string, string> {
  const a = new Date(b.start), z = new Date(b.end), from = gridStart.value, to = gridEnd.value
  const start = a.getHours() * 60 + a.getMinutes(), end = localDay(z) !== localDay(a) ? 1440 : z.getHours() * 60 + z.getMinutes()
  return { top: `${Math.max(0, start - from) / (to - from) * 100}%`, height: `${Math.max(1, Math.min(end, to) - Math.max(start, from)) / (to - from) * 100}%` }
}
function shownOnDate(date: string): PlanningSnapshot['occupied'] {
  return data.value?.occupied.filter(b => localDay(new Date(b.start)) === date) ?? []
}
async function lock(b: PlanBlock): Promise<void> { await action(() => window.api.planningLock(b.id!, !b.locked), '锁定状态已更新。') }
onMounted(() => { void refresh(true); removeListener = window.api.onTaskChanged(() => void refresh()) })
onUnmounted(() => removeListener?.())
</script>
<template>
  <div class="planning-view">
    <header class="heading"><h2>课表与执行计划</h2><label>查看起始日 <input v-model="startDate" type="date" @change="refresh()" /></label></header>
    <p class="intro">课程占用与执行安排同屏查看。任务截止是提交期限，执行块表示准备何时做，二者独立保存。</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <details class="panel" open><summary>可安排时间与课表录入</summary>
      <form class="fields" @submit.prevent="action(() => api.planningSettings({startMin:minute(windowStart),endMin:minute(windowEnd),dailyMaxMin:dailyMax,breakMin}), '作息窗口已保存。')">
        <label>每天开始<input v-model="windowStart" type="time" required /></label><label>每天结束<input v-model="windowEnd" type="time" required /></label>
        <label>每日任务上限/分钟<input v-model.number="dailyMax" type="number" min="15" max="1440" required /></label><label>任务间休息/分钟<input v-model.number="breakMin" type="number" min="0" max="120" required /></label>
        <button :disabled="busy">保存作息</button>
      </form>
      <form class="fields" @submit.prevent="addCourse">
        <label>课程/固定事件<input v-model="courseName" placeholder="例如：数学分析" maxlength="80" required /></label>
        <label>星期<select v-model.number="weekday"><option v-for="(name,i) in ['一','二','三','四','五','六','日']" :key="i" :value="i+1">周{{ name }}</option></select></label>
        <label>开始<input v-model="courseStart" type="time" required /></label><label>结束<input v-model="courseEnd" type="time" required /></label>
        <label>生效起日<input v-model="courseFrom" type="date" required /></label><label>生效止日<input v-model="courseTo" type="date" required /></label>
        <button :disabled="busy">添加课程</button>
      </form>
      <ul class="courses"><li v-for="c in data?.courses" :key="c.id"><span>{{ c.name }} · 周{{ ['一','二','三','四','五','六','日'][c.weekday-1] }} {{ clock(c.startMin) }}—{{ clock(c.endMin) }} · {{ c.fromDate }}至{{ c.toDate }}</span><button :disabled="busy" @click="action(() => api.courseDelete(c.id), '课程已移除。')">移除课程</button></li></ul>
    </details>
    <PlanningConstraintsEditor v-if="data" :data="data" :date="startDate" @changed="refresh()" />
    <div class="week-scroll"><div class="week-grid"><div v-for="date in dates" :key="date" class="day-col"><header>{{ date.slice(5) }} 周{{ ['日','一','二','三','四','五','六'][new Date(date+'T12:00:00').getDay()] }}</header>
      <small class="day-capacity">{{ data?.effectiveDays.find(d=>d.date===date)?.mode==='light'?'轻量':'正常' }} · {{ data?.effectiveDays.find(d=>d.date===date)?.settings.dailyMaxMin??dailyMax }}分钟</small>
      <div class="day-track"><span v-for="tick in ticks" :key="tick.label" class="hour-tick" :style="{top:tick.top}">{{ tick.label }}</span>
        <article v-for="(b,i) in shownOnDate(date)" :key="i" :style="style(b)" :class="b.kind" :title="`${b.title} ${formatTime(b.start)}—${formatTime(b.end)}`"><strong>{{ b.title }}</strong><small>{{ formatTime(b.start).split(' ').at(-1) }}—{{ formatTime(b.end).split(' ').at(-1) }}</small></article>
      </div>
    </div></div></div>
    <section class="panel"><h3>试排任务</h3><p>选择任务后，将在上方这7天内寻找连续空档。旧日期/候选期限先到任务的“时间设置”核对。也可直接在今日助理提出要求。</p>
      <div class="choices"><label v-for="t in pending" :key="t.id"><input v-model="selected" type="checkbox" :value="t.id" />{{ t.summary || t.content }} · {{ t.estimateMin }}分钟 <small v-if="!t.deadlineConfirmed">日期待确认</small></label></div>
      <button :disabled="busy || !selected.length" @click="trial">按课表试排（{{ selected.length }}项）</button>
      <div v-if="preview" class="trial-result"><PlanPreviewCard :preview="preview" /><PlanReasonEditor v-if="hasMoves" v-model="audit" /><button :disabled="busy || !preview.blocks.length" @click="commit">确认保存这份计划</button><button class="secondary" @click="preview=null">放弃预览</button></div>
    </section>
    <section class="panel"><h3>已保存执行时段</h3><p v-if="!data?.blocks.length">尚无执行安排。</p>
      <div v-for="b in data?.blocks" :key="b.id" class="saved-block"><div><strong>{{ b.title }}</strong><p>{{ formatTime(b.start) }} — {{ formatTime(b.end) }}</p></div><button :disabled="busy" @click="lock(b)">{{ b.locked ? '解锁' : '锁定' }}</button><button class="secondary" :disabled="busy" @click="action(() => api.planningRemove(b.id!), '执行安排已移除，任务及截止保留。')">移除安排</button></div>
    </section>
  </div>
</template>
<style scoped>
.day-capacity{display:block;text-align:center;padding:5px;background:var(--bg);font-size:10px;color:var(--text-2)}.day-track article.busy{background:#f0e7fa;color:#6a3c91;border-color:#9a68c7}
.heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.heading h2{font-size:20px}.heading label,.intro{font-size:13px;color:var(--text-2)}.panel{padding:16px;margin:16px 0;background:var(--panel);border:1px solid var(--border);border-radius:12px}.panel h3{font-size:15px}.panel>p{font-size:13px;color:var(--text-3);line-height:1.7}.panel summary{cursor:pointer;font-weight:600}.fields{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin:15px 0}.fields label{display:grid;gap:5px;font-size:12px}.fields input,.fields select,.heading input{padding:7px;border:1px solid var(--border);border-radius:6px;color:var(--text);background:var(--panel)}.fields input[type=number]{width:115px}button{padding:8px 11px;background:var(--primary);color:white;border-radius:7px;cursor:pointer;font-size:12px}button:disabled{opacity:.5;cursor:default}.secondary{background:var(--bg);color:var(--text-2);border:1px solid var(--border);margin-left:8px}.courses{list-style:none;padding:0}.courses li{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--border);font-size:12px}.courses button{background:var(--bg);color:var(--text-2)}.week-scroll{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.week-grid{display:grid;grid-template-columns:repeat(7,minmax(105px,1fr));min-width:770px}.day-col{border-right:1px solid var(--border)}.day-col>header{text-align:center;font-size:12px;padding:12px;background:var(--bg)}.day-track{height:430px;position:relative;background:var(--panel)}.hour-tick{position:absolute;left:0;right:0;border-top:1px solid var(--border);color:var(--text-3);font-size:9px;padding-left:3px;pointer-events:none}.day-track article{position:absolute;left:5%;width:90%;overflow:hidden;padding:4px;border-radius:5px;border-left:3px solid var(--primary);background:#e8efff;color:#254f9d;box-sizing:border-box}.day-track article.course{background:#fbefcf;color:#74571b;border-color:#c59e43}.day-track strong,.day-track small{display:block;font-size:11px;overflow-wrap:anywhere}.choices{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}.choices label{font-size:13px;padding:9px;background:var(--bg);border-radius:7px}.choices input{margin-right:7px}.choices small{color:#94651d}.trial-result{margin-top:15px;padding-top:12px;border-top:1px solid var(--border)}.saved-block{display:flex;align-items:center;gap:8px;border-top:1px solid var(--border);padding:12px 0}.saved-block>div{flex:1}.saved-block p{font-size:12px;color:var(--text-3);margin:5px 0}.error{color:#b13c26;background:#fff0e9;padding:10px;border-radius:8px}.notice{color:#286345;background:#eaf6ee;padding:10px;border-radius:8px}
</style>
