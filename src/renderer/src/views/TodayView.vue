<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { tasksStore } from '../stores/tasks'
import { computeScore, isOverdue } from '@shared/priority'
import TaskItem from '../components/TaskItem.vue'
import AgentChat from '../components/AgentChat.vue'
import TodayPlan from '../components/TodayPlan.vue'
import FollowupInbox from '../components/FollowupInbox.vue'
import AttentionInbox from '../components/AttentionInbox.vue'

// 60s 重算：截止临近分数上升，视图自动重排
const tick = ref(0)
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => tick.value++, 60_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// 全部未完成任务，按优先级分数降序
const sortedPending = computed(() => {
  void tick.value // 依赖 tick 触发重算
  return tasksStore.tasks
    .filter((t) => t.status === 'pending')
    .slice()
    .sort((a, b) => computeScore(b) - computeScore(a))
})

const overdue = computed(() => sortedPending.value.filter((t) => isOverdue(t)))
const TOP_N = 8
const focusList = computed(() => sortedPending.value.filter((t) => !isOverdue(t)).slice(0, TOP_N))
const laterList = computed(() => sortedPending.value.filter((t) => !isOverdue(t)).slice(TOP_N))

const doneToday = computed(() => {
  const today = new Date().toDateString()
  return tasksStore.tasks.filter((t) => t.status === 'done' && t.completedAt && new Date(t.completedAt).toDateString() === today)
})

const todayLabel = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
</script>

<template>
  <div class="today-view">
    <header class="view-header">
      <h2>今日</h2>
      <span class="date">{{ todayLabel }}</span>
      <span class="count">{{ sortedPending.length }} 项待办 · 聚焦 {{ focusList.length }} 项</span>
    </header>

    <TodayPlan />
    <FollowupInbox />
    <AttentionInbox />
    <AgentChat />

    <div v-if="overdue.length" class="overdue-zone">
      <div class="zone-title">⚠️ 已过期（{{ overdue.length }}）</div>
      <div class="zone-list">
        <TaskItem v-for="t in overdue" :key="t.id" :task="t" />
      </div>
    </div>

    <div v-if="focusList.length" class="zone">
      <div class="zone-title plain">待办优先参考 · 实际执行以当天安排为准</div>
      <div class="zone-list">
        <TaskItem v-for="t in focusList" :key="t.id" :task="t" />
      </div>
    </div>

    <div v-if="laterList.length" class="later-zone">
      <details>
        <summary>稍后再做（{{ laterList.length }}）<span class="later-hint">按优先级自动排序</span></summary>
        <div class="zone-list">
          <TaskItem v-for="t in laterList" :key="t.id" :task="t" />
        </div>
      </details>
    </div>

    <div v-if="doneToday.length" class="done-zone">
      <details>
        <summary>今日已完成 {{ doneToday.length }} 件</summary>
        <div class="zone-list">
          <TaskItem v-for="t in doneToday" :key="t.id" :task="t" />
        </div>
      </details>
    </div>

    <div v-if="!sortedPending.length && !doneToday.length" class="empty">
      <div class="icon">🌱</div>
      <p>今天还没有安排</p>
      <p class="hint">把遇到的事丢到上面的输入框里吧</p>
    </div>
  </div>
</template>

<style scoped>
.view-header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 16px;
}
.view-header h2 {
  font-size: 20px;
}
.date {
  color: var(--text-3);
  font-size: 13px;
}
.count {
  margin-left: auto;
  color: var(--text-2);
  font-size: 13px;
}
.zone {
  margin-bottom: 14px;
}
.zone-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.zone-title {
  color: var(--danger);
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 10px;
}
.zone-title.plain {
  color: var(--text-2);
}
.overdue-zone {
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #ffd7d5;
  background: #fff7f6;
  border-radius: var(--radius);
}
.later-zone,
.done-zone {
  margin-top: 18px;
  color: var(--text-3);
}
.later-zone summary,
.done-zone summary {
  cursor: pointer;
  font-size: 13px;
  padding: 6px 0;
  user-select: none;
}
.later-hint {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 8px;
}
.later-zone .zone-list,
.done-zone .zone-list {
  margin-top: 8px;
}
.done-zone .zone-list {
  opacity: 0.75;
}
.hint {
  font-size: 12px;
  margin-top: 6px;
}
</style>
