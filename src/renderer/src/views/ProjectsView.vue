<script setup lang="ts">
import { computed, ref } from 'vue'
import { tasksStore, tasksActions } from '../stores/tasks'
import TaskItem from '../components/TaskItem.vue'

interface StepDraft {
  content: string
  due: string
}

const expanded = ref<Set<string>>(new Set())
const drafts = ref<Record<string, StepDraft>>({})
const rebalanceHint = ref('')

/** 项目是否含范围任务（显示"重新分配"按钮的条件） */
function hasRange(p: { tasks: { rangeStart: string | null }[] }): boolean {
  return p.tasks.some((t) => t.rangeStart)
}

async function rebalance(projectId: string): Promise<void> {
  const result = await window.api.projectRebalance(projectId)
  rebalanceHint.value = `已重新分配 ${result.assigned} 个任务${result.displaced > 0 ? `，${result.displaced} 个原有任务自动后移` : ''}`
  setTimeout(() => (rebalanceHint.value = ''), 3000)
}

/** 从全局 store 聚合项目组（task:changed 订阅自动刷新） */
const projects = computed(() => {
  const withProject = tasksStore.tasks.filter((t) => t.projectId)
  const byId = new Map<string, typeof withProject>()
  for (const t of withProject) {
    const list = byId.get(t.projectId!) ?? []
    list.push(t)
    byId.set(t.projectId!, list)
  }
  const groups = []
  for (const [projectId, tasks] of byId) {
    const sorted = tasks.slice().sort((a, b) => a.chainOrder - b.chainOrder)
    const withDue = sorted.filter((t) => t.dueAt).map((t) => t.dueAt!).sort()
    groups.push({
      projectId,
      title: sorted[0]?.summary || sorted[0]?.content.slice(0, 16) || '未命名项目',
      tasks: sorted,
      total: sorted.length,
      doneCount: sorted.filter((t) => t.status === 'done').length,
      firstDue: withDue[0] ?? null,
      lastDue: withDue.at(-1) ?? null
    })
  }
  return groups.sort((a, b) => (a.firstDue ?? '9999').localeCompare(b.firstDue ?? '9999'))
})

function toggle(projectId: string): void {
  const s = new Set(expanded.value)
  if (s.has(projectId)) s.delete(projectId)
  else s.add(projectId)
  expanded.value = s
}

function draft(projectId: string): StepDraft {
  if (!drafts.value[projectId]) {
    drafts.value[projectId] = { content: '', due: '' }
  }
  return drafts.value[projectId]
}

async function addStep(projectId: string): Promise<void> {
  const d = draft(projectId)
  if (!d.content.trim()) return
  await window.api.projectAddStep(projectId, d.content.trim(), d.due ? `${d.due}T23:59:00` : null)
  drafts.value[projectId] = { content: '', due: '' }
}

async function move(id: number, dir: 'up' | 'down'): Promise<void> {
  await window.api.projectMoveStep(id, dir)
}

async function removeStep(id: number): Promise<void> {
  await tasksActions.deleteTask(id)
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const pct = (done: number, total: number): number => (total === 0 ? 0 : Math.round((done / total) * 100))
</script>

<template>
  <div class="projects-view">
    <header class="view-header">
      <h2>项目</h2>
      <span class="sub">{{ projects.length }} 个链条 · 点击卡片展开编辑</span>
    </header>

    <div v-if="projects.length" class="project-list">
      <section v-for="p in projects" :key="p.projectId" class="project-card">
        <header class="pc-head" @click="toggle(p.projectId)">
          <span class="pc-icon">🔗</span>
          <div class="pc-title-wrap">
            <div class="pc-title">{{ p.title }}</div>
            <div class="pc-meta">
              {{ p.doneCount }}/{{ p.total }} 完成
              <template v-if="p.firstDue"> · {{ fmtDate(p.firstDue) }}<template v-if="p.lastDue && p.lastDue !== p.firstDue"> ~ {{ fmtDate(p.lastDue) }}</template></template>
            </div>
          </div>
          <div class="pc-progress">
            <div class="bar">
              <div class="fill" :style="{ width: pct(p.doneCount, p.total) + '%' }"></div>
            </div>
            <span class="pct">{{ pct(p.doneCount, p.total) }}%</span>
          </div>
          <span v-if="hasRange(p)" class="pc-meta">在“助理”中试排执行时间</span>
          <span class="chevron" :class="{ open: expanded.has(p.projectId) }">▾</span>
        </header>

        <div v-if="expanded.has(p.projectId)" class="pc-body">
          <div class="steps">
            <div v-for="(t, i) in p.tasks" :key="t.id" class="step">
              <div class="step-aside">
                <span class="step-no" :class="{ done: t.status === 'done' }">{{ i + 1 }}</span>
                <span v-if="i < p.tasks.length - 1" class="step-line" :class="{ done: t.status === 'done' }"></span>
              </div>
              <div class="step-main">
                <TaskItem :task="t" />
              </div>
              <div class="step-ops">
                <button :disabled="i === 0" @click="move(t.id, 'up')" title="上移">↑</button>
                <button :disabled="i === p.tasks.length - 1" @click="move(t.id, 'down')" title="下移">↓</button>
                <button class="danger" @click="removeStep(t.id)" title="移出链条（归档）">✕</button>
              </div>
            </div>
          </div>

          <div class="add-step">
            <input v-model="draft(p.projectId).content" placeholder="新环节内容（如：写 storage.h）" @keydown.enter="addStep(p.projectId)" />
            <input v-model="draft(p.projectId).due" type="date" title="截止日期（可空）" />
            <button class="add-btn" :disabled="!draft(p.projectId).content.trim()" @click="addStep(p.projectId)">＋ 加环节</button>
          </div>
        </div>
      </section>
    </div>

    <div v-else class="empty">
      <div class="icon">🔗</div>
      <p>还没有项目链条</p>
      <p class="hint">顶部「批量计划」粘贴一段多天计划，任务会自动成链；推迟环节时整条链自动顺延</p>
    </div>

    <div v-if="rebalanceHint" class="rebalance-hint">📅 {{ rebalanceHint }}</div>
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
.sub {
  color: var(--text-3);
  font-size: 12px;
}
.project-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.pc-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  user-select: none;
}
.pc-head:hover {
  background: var(--bg);
}
.pc-icon {
  font-size: 16px;
}
.pc-title-wrap {
  flex: 1;
  min-width: 0;
}
.pc-title {
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pc-meta {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.pc-progress {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bar {
  width: 90px;
  height: 6px;
  background: var(--bg);
  border-radius: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--primary);
  border-radius: 3px;
  transition: width 0.3s;
}
.pct {
  font-size: 12px;
  color: var(--text-2);
}
.chevron {
  color: var(--text-3);
  transition: transform 0.2s;
  font-size: 14px;
}
.chevron.open {
  transform: rotate(180deg);
}
.pc-body {
  border-top: 1px solid var(--border);
  padding: 14px 16px;
}
.steps {
  display: flex;
  flex-direction: column;
}
.step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.step-aside {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 22px;
  padding-top: 14px;
}
.step-no {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--primary-light);
  color: var(--primary);
  font-size: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.step-no.done {
  background: var(--success);
  color: #fff;
}
.step-line {
  width: 2px;
  flex: 1;
  min-height: 10px;
  background: var(--border);
  margin-top: 4px;
}
.step-line.done {
  background: var(--success);
}
.step-main {
  flex: 1;
  min-width: 0;
  padding-top: 4px;
}
.step-ops {
  display: flex;
  flex-direction: column;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
  padding-top: 8px;
}
.step:hover .step-ops {
  opacity: 1;
}
.step-ops button {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-2);
  background: var(--panel);
}
.step-ops button:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}
.step-ops button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.step-ops button.danger:hover {
  border-color: var(--danger);
  color: var(--danger);
}
.add-step {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.add-step input {
  font-size: 13px;
  padding: 6px 10px;
}
.add-step input:not([type='date']) {
  flex: 1;
}
.add-btn {
  white-space: nowrap;
  font-size: 13px;
  background: var(--primary);
  color: #fff;
  padding: 6px 14px;
  border-radius: 6px;
}
.add-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.empty {
  text-align: center;
  color: var(--text-3);
  padding: 48px 0;
}
.empty .icon {
  font-size: 40px;
  margin-bottom: 12px;
}
.hint {
  font-size: 12px;
  margin-top: 6px;
}
.rebalance-btn {
  font-size: 12px;
  color: var(--primary);
  border: 1px solid var(--primary);
  padding: 3px 10px;
  border-radius: 6px;
  white-space: nowrap;
  background: transparent;
}
.rebalance-btn:hover {
  background: var(--primary-light);
}
.rebalance-hint {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel);
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 13px;
  padding: 8px 18px;
  border-radius: 8px;
  box-shadow: var(--shadow);
  animation: toast-in 0.2s ease;
  z-index: 10;
}
@keyframes toast-in {
  from { opacity: 0; transform: translate(-50%, 6px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
</style>
