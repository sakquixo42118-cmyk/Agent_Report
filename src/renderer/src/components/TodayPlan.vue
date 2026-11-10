<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import type { PlanningSnapshot } from '@shared/planning'
import { localDay } from '../lib/planningTime'
import DayOverrideEditor from './DayOverrideEditor.vue'
const data = ref<PlanningSnapshot | null>(null), error = ref('')
let unsubscribe: (() => void) | undefined, timer: ReturnType<typeof setInterval> | undefined
async function refresh(): Promise<void> {
  try { data.value = await window.api.planningRead(localDay(), localDay()); error.value = '' }
  catch (e) { error.value = String(e) }
}
const time = (v: number): string => new Date(v).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
onMounted(() => { void refresh(); unsubscribe = window.api.onTaskChanged(() => void refresh()); timer = setInterval(() => void refresh(), 60000) })
onUnmounted(() => { unsubscribe?.(); if (timer) clearInterval(timer) })
</script>
<template>
  <section class="today-plan"><h3>当天执行安排</h3>
    <p v-if="data">{{ data.effectiveDays[0]?.mode==='light'?'今日轻量':'今日正常' }} · 任务上限{{ data.effectiveDays[0]?.settings.dailyMaxMin }}分钟</p>
    <details v-if="data" class="today-settings"><summary>调整今日状态与容量</summary><DayOverrideEditor :data="data" :date="localDay()" @changed="refresh" /></details>
    <p v-if="error" role="alert">{{ error }}</p>
    <div v-if="data?.occupied.length" class="day-strip">
      <article v-for="(b,i) in [...data.occupied].sort((a,b)=>a.start-b.start)" :key="i" :class="b.kind">
        <time>{{ time(b.start) }}—{{ time(b.end) }}</time><strong>{{ b.title }}</strong><span>{{ b.kind === 'course' ? '课程 / 固定占用' : b.kind==='busy' ? '临时占用' : b.locked ? '已锁定执行时段' : '执行时段' }}</span>
      </article>
    </div>
    <p v-else>今天还没有课程或执行安排。到“日程”录入课表并挑空档，或让“助理”试排。</p>
  </section>
</template>
<style scoped>
.today-settings{margin:10px 0;font-size:12px}.today-settings summary{cursor:pointer;color:var(--primary)}.day-strip article.busy{border-color:#9760c0;background:#f4edfb}
.today-plan{background:var(--panel);padding:15px;border:1px solid var(--border);border-radius:12px;margin-bottom:18px}.today-plan h3{font-size:15px;margin-bottom:10px}.today-plan p{font-size:13px;color:var(--text-3)}.day-strip{display:flex;gap:10px;overflow-x:auto;padding-bottom:5px}.day-strip article{flex:0 0 180px;padding:10px;border-radius:8px;display:grid;gap:6px;border-left:4px solid var(--primary);background:var(--primary-light)}.day-strip article.course{border-color:#b38c42;background:#fcf4e5}.day-strip time,.day-strip span{font-size:12px}.day-strip strong{font-size:14px}.day-strip span{color:var(--text-3)}
</style>
