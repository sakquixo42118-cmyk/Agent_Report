<script setup lang="ts">
import {ref,onMounted,watch} from 'vue'
import type {AttentionSettings,AttentionState} from '@shared/attention'
import {clock,minute} from '../lib/planningTime'
import {attentionStore} from '../stores/attention'
const state=ref<AttentionState|null>(null),form=ref<AttentionSettings|null>(null),reminders=ref(true),advance=ref(24),from=ref('22:00'),to=ref('08:00'),busy=ref(false),error=ref(''),notice=ref('')
watch(()=>attentionStore.data,value=>{if(value)state.value=JSON.parse(JSON.stringify(value))})
async function load():Promise<void>{try{const s=await window.api.attentionState();state.value=s;form.value={...s.settings};from.value=clock(s.settings.quietStartMin);to.value=clock(s.settings.quietEndMin);reminders.value=s.remindersEnabled;advance.value=s.advanceHours;error.value=''}catch(e){error.value=String(e)}}
async function save():Promise<void>{if(!form.value)return;busy.value=true;error.value='';try{await window.api.attentionSettings({...form.value,quietStartMin:minute(from.value),quietEndMin:minute(to.value)},{enabled:reminders.value,advanceHours:advance.value});await load();notice.value='主动消息与时间提醒设置已保存。'}catch(e){error.value=String(e)}finally{busy.value=false}}
async function check(retry=false):Promise<void>{busy.value=true;try{state.value=await window.api.attentionCheck(retry);notice.value='已请求检查；仅有新证据、非安静时段且未达配额时才调用模型。'}catch(e){error.value=String(e)}finally{busy.value=false}}
async function restore(subject:string):Promise<void>{try{await window.api.attentionUnmute(subject);await load()}catch(e){error.value=String(e)}}
onMounted(()=>void load())
</script>
<template>
  <section class="attention-settings"><h3>主动消息与时间提醒</h3><p>应用运行期间检查，默认只留在今日消息中。关闭窗口会退出应用；新消息不会自动抢走当前输入或打开对话。</p>
    <form v-if="form" @submit.prevent="save"><div class="toggles"><label><input v-model="form.proactiveEnabled" type="checkbox" />启用模型主动检查</label><label><input v-model="form.courseEnabled" type="checkbox" />近期课程结束后按需询问</label><label><input v-model="form.nudgeEnabled" type="checkbox" />任务风险与适度催办</label><label><input v-model="reminders" type="checkbox" />执行开始 / 截止时间提醒</label><label><input v-model="form.desktopEnabled" type="checkbox" />时间提醒同时提交给Windows通知（默认关闭）</label><label><input v-model="form.quietEnabled" type="checkbox" />启用安静时段</label></div>
      <div class="fields"><label>安静开始<input v-model="from" type="time" required /></label><label>安静结束<input v-model="to" type="time" required /></label><label>检查最短间隔/分钟<input v-model.number="form.intervalMin" type="number" min="5" max="360" /></label><label>每日最多模型检查<input v-model.number="form.dailyChecks" type="number" min="1" max="6" /></label><label>每日最多主动消息<input v-model.number="form.dailyMessages" type="number" min="1" max="6" /></label><label>开始前提醒/分钟<input v-model.number="form.startAdvanceMin" type="number" min="1" max="120" /></label><label>截止前提醒/小时<input v-model.number="advance" type="number" min="1" max="72" /></label><label>每日最多时间提醒<input v-model.number="form.reminderDailyLimit" type="number" min="1" max="30" /></label></div>
      <p>主动检查需配置支持工具调用的模型，模型可选择静默。时间提醒不调用模型；完成回顾另有开关，但也遵守安静时段和对象静默选择。可在今日消息中选择稍后、忽略或停止该对象提醒。</p>
      <div class="buttons"><button :disabled="busy">保存主动消息设置</button><button type="button" :disabled="busy" @click="load">重新读取</button><button type="button" :disabled="busy" @click="check()">检查是否有新证据</button><button v-if="state?.failed" type="button" :disabled="busy" @click="check(true)">重试未完成检查</button></div>
    </form>
    <p v-if="state">今日检查 {{ state.checksToday }}/{{ state.settings.dailyChecks }} 次，主动消息 {{ state.messagesToday }}/{{ state.settings.dailyMessages }} 条。{{ state.quiet?'当前为安静时段。':'' }}{{ !state.modelConfigured?'尚未配置模型，仍可使用时间提醒。':'' }}</p>
    <details v-if="state?.muted.length"><summary>已停止提醒的对象</summary><p>恢复后处理后续新事件，不重发已处理的同一课程或目标时间。</p><div v-for="m in state.muted" :key="m.subjectKey" class="muted"><span>{{ m.label }}</span><button @click="restore(m.subjectKey)">恢复提醒</button></div></details>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  </section>
</template>
<style scoped>
.attention-settings{padding:18px 20px;margin-bottom:14px;border:1px solid var(--border);border-radius:12px;background:var(--panel);max-width:760px}.attention-settings h3{font-size:15px;margin:0 0 8px}.attention-settings p{font-size:12px;color:var(--text-3);line-height:1.7}.toggles{display:grid;gap:10px;font-size:13px;margin:14px 0}.toggles label{display:flex;gap:8px;align-items:center}.fields{display:flex;flex-wrap:wrap;gap:12px}.fields label{display:grid;gap:5px;font-size:12px}.fields input{width:130px;padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}.buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.attention-settings button{padding:8px 10px;border-radius:7px;background:var(--primary);color:white;font-size:12px;cursor:pointer}.attention-settings button:disabled{opacity:.5}.attention-settings p.error{color:#a43928}.muted{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px;font-size:12px}summary{font-size:12px;cursor:pointer}
</style>
