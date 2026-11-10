<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import QuickInput from './components/QuickInput.vue'
import TaskItem from './components/TaskItem.vue'
import TodayView from './views/TodayView.vue'
import AssistantView from './views/AssistantView.vue'
import InboxView from './views/InboxView.vue'
import ScheduleView from './views/ScheduleView.vue'
import ProjectsView from './views/ProjectsView.vue'
import AllTasksView from './views/AllTasksView.vue'
import StatsView from './views/StatsView.vue'
import SettingsView from './views/SettingsView.vue'
import MemoryView from './views/MemoryView.vue'
import { feedbackState, startFeedbackListener } from './stores/feedback'
import {attentionStore,startAttentionListener} from './stores/attention'
import { openAgentRun, agentNavigation } from './stores/agentNavigation'
import type {AgentRun} from '@shared/agent'

type ViewName = 'today' | 'assistant' | 'inbox' | 'schedule' | 'projects' | 'all' | 'stats' | 'settings' | 'memory'

const current = ref<ViewName>('today')
let lastOpenedRun:string|null=null
watch(()=>agentNavigation.revision,async()=>{current.value='assistant';if(lastOpenedRun!==agentNavigation.runId){lastOpenedRun=agentNavigation.runId;await nextTick();if(contentPane.value)contentPane.value.scrollTop=0}})
const contentPane = ref<HTMLElement | null>(null)
let offFeedback: (() => void) | undefined
let offAttention:(()=>void)|undefined
const totalUnread=computed(()=>feedbackState.unread+(attentionStore.data?.unread??0))
watch(()=>attentionStore.navigation,async()=>{current.value='today';await nextTick();if(contentPane.value)contentPane.value.scrollTop=0})
onMounted(() => { offFeedback=startFeedbackListener();offAttention=startAttentionListener() }); onUnmounted(() => {offFeedback?.();offAttention?.()})
watch(current, async () => { await nextTick(); if (contentPane.value) contentPane.value.scrollTop = 0 })

const navs = [
  { key: 'today' as ViewName, label: '今日', icon: '☀️' },
  { key: 'assistant' as ViewName, label: '助理', icon: '💬' },
  { key: 'inbox' as ViewName, label: '待确认', icon: '📥' },
  { key: 'schedule' as ViewName, label: '日程', icon: '🗓️' },
  { key: 'projects' as ViewName, label: '项目', icon: '🔗' },
  { key: 'all' as ViewName, label: '全部', icon: '📋' },
  { key: 'stats' as ViewName, label: '统计', icon: '📊' },
  { key: 'memory' as ViewName, label: '个人记忆', icon: '🧩' },
  { key: 'settings' as ViewName, label: '设置', icon: '⚙️' }
]

const viewComponents = {
  today: TodayView,
  assistant: AssistantView,
  inbox: InboxView,
  schedule: ScheduleView,
  projects: ProjectsView,
  all: AllTasksView,
  stats: StatsView,
  settings: SettingsView,
  memory: MemoryView
}

const activeView = computed(() => viewComponents[current.value])

// toast
const toasts = ref<{ id: number; text: string }[]>([])
let toastId = 0
function showToast(text: string): void {
  const id = ++toastId
  toasts.value.push({ id, text })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, 2200)
}

function handleQuickAdd(content: string): void {
  const inboxRouted = current.value === 'inbox'
  if (!inboxRouted) current.value = 'today'
  showToast('已快速记录')
}
function handleOpened(run:AgentRun):void{openAgentRun(run.id);current.value='assistant';showToast('已打开事项整理，确认前不会创建任务')}

provideToast()
function provideToast(): void {
  // 挂到 window 供深层组件使用（骨架阶段最简方案）
}
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="logo">随手计划</div>
      <nav class="nav">
        <button
          v-for="n in navs"
          :key="n.key"
          class="nav-item"
          :class="{ active: current === n.key }"
          @click="current = n.key"
        >
          <span class="nav-icon">{{ n.icon }}</span>
          <span>{{ n.label }}</span>
          <span v-if="n.key==='today' && totalUnread" class="unread-badge" :aria-label="totalUnread+'条未读消息'">{{ totalUnread }}</span>
        </button>
      </nav>
      <div class="sidebar-footer">v0.2 α9 · 答辩补测</div>
    </aside>

    <main class="main">
      <QuickInput @added="handleQuickAdd" @opened="handleOpened" />
      <section ref="contentPane" class="content">
        <component :is="activeView" />
      </section>
    </main>

    <div class="toast-wrap">
      <div v-for="t in toasts" :key="t.id" class="toast">{{ t.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.unread-badge{background:#d74e46;color:white;border-radius:10px;min-width:17px;padding:2px 5px;font-size:10px;text-align:center;margin-left:auto}
.layout {
  display: flex;
  height: 100%;
}
.sidebar {
  width: 180px;
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 16px 10px;
}
.logo {
  font-size: 17px;
  font-weight: 600;
  padding: 4px 10px 18px;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--text-2);
  text-align: left;
  transition: all 0.15s;
}
.nav-item:hover {
  background: var(--bg);
  color: var(--text);
}
.nav-item.active {
  background: var(--primary-light);
  color: var(--primary);
  font-weight: 500;
}
.nav-icon {
  font-size: 15px;
}
.sidebar-footer {
  font-size: 11px;
  color: var(--text-3);
  padding: 10px 12px 0;
}
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.content {
  flex: 1;
  overflow-y: auto;
  padding: 18px 24px 30px;
}
</style>
