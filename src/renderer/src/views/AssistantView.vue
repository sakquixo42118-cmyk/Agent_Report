<script setup lang="ts">
import AgentChat from '../components/AgentChat.vue'
</script>

<template>
  <div class="assistant-view">
    <header class="view-header">
      <h2>助理</h2>
      <span class="sub">查任务、讨论安排、调整轻重缓急</span>
      <span class="tip">确认前不会创建或修改任务</span>
    </header>

    <AgentChat standalone />
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
  font-size: 13px;
}
.tip {
  margin-left: auto;
  color: var(--text-3);
  font-size: 12px;
}
</style>
