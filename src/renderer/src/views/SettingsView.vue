<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import AttentionSettingsPanel from '../components/AttentionSettingsPanel.vue'

const form = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
const saved = ref(false)

const testing = ref(false)
const testResult = ref<{ ok: boolean; latencyMs?: number; error?: string } | null>(null)

async function testAi(): Promise<void> {
  testing.value = true
  testResult.value = null
  // 先保存当前表单，测试用保存后的配置
  await window.api.settingsSet({
    aiBaseUrl: form.aiBaseUrl,
    aiApiKey: form.aiApiKey,
    aiModel: form.aiModel
  })
  testResult.value = await window.api.settingsTestAi()
  testing.value = false
}

onMounted(async () => {
  const s = await window.api.settingsGet()
  Object.assign(form, s)
})

async function save(): Promise<void> {
  await window.api.settingsSet({aiBaseUrl:form.aiBaseUrl,aiApiKey:form.aiApiKey,aiModel:form.aiModel,lanEnabled:form.lanEnabled,lanPort:form.lanPort})
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}

defineExpose({ save })
</script>

<template>
  <div class="settings-view">
    <header class="view-header">
      <h2>设置</h2>
    </header>

    <section class="panel">
      <h3>AI 分析</h3>
      <p class="desc">配置 OpenAI 兼容接口后，任务将自动判断轻重缓急、提取截止时间。支持 DeepSeek / 智谱 / Kimi / OpenAI 等。</p>
      <div class="form">
        <label>
          <span>Base URL</span>
          <input v-model="form.aiBaseUrl" placeholder="例如 https://api.deepseek.com/v1" />
        </label>
        <label>
          <span>API Key</span>
          <input v-model="form.aiApiKey" type="password" placeholder="sk-..." />
        </label>
        <label>
          <span>模型名</span>
          <input v-model="form.aiModel" placeholder="例如 deepseek-chat" />
        </label>
      </div>
      <div class="test-row">
        <button class="btn" :disabled="testing" @click="testAi">{{ testing ? '测试中…' : '测试连接' }}</button>
        <span v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'err'">
          {{ testResult.ok ? `连接正常 · 延迟 ${testResult.latencyMs}ms` : testResult.error }}
        </span>
      </div>
      <p class="tip">配置并测试通过后，新丢进来的任务会自动 AI 分析；存量任务可在任务卡上点「重试分析」。</p>
    </section>

    <AttentionSettingsPanel />

    <section class="panel">
      <h3>局域网访问（手机）</h3>
      <div class="form">
        <label class="row">
          <input v-model="form.lanEnabled" type="checkbox" />
          <span>允许手机在同一 WiFi 下查看/勾选任务</span>
        </label>
        <label>
          <span>端口</span>
          <input v-model.number="form.lanPort" type="number" min="1024" max="65535" />
        </label>
      </div>
      <p class="tip">手机访问功能将在后续版本上线。</p>
    </section>

    <div class="footer-bar">
      <button class="btn btn-primary" @click="save">{{ saved ? '已保存 ✓' : '保存设置' }}</button>
    </div>
  </div>
</template>

<style scoped>
.view-header {
  margin-bottom: 16px;
}
.view-header h2 {
  font-size: 20px;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 18px 20px;
  margin-bottom: 14px;
  max-width: 560px;
}
.panel h3 {
  font-size: 15px;
  margin-bottom: 8px;
}
.desc {
  color: var(--text-3);
  font-size: 12px;
  margin-bottom: 14px;
  line-height: 1.6;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  color: var(--text-2);
}
.form label.row {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.form input[type='text'],
.form input[type='password'],
.form input[type='number'] {
  width: 100%;
}
.tip {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-3);
}
.test-row {
  margin-top: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.test-row .btn:disabled {
  opacity: 0.6;
  cursor: wait;
}
.test-result {
  font-size: 12px;
}
.test-result.ok {
  color: var(--success);
}
.test-result.err {
  color: var(--danger);
}
.footer-bar {
  max-width: 560px;
  display: flex;
  justify-content: flex-end;
}
</style>
