<script setup lang="ts">
import {ref,computed,watch,onMounted,type DeepReadonly} from 'vue'
import type {AttentionMessage} from '@shared/attention'
type MessageView=DeepReadonly<AttentionMessage>
import {attentionStore,refreshAttention} from '../stores/attention'
import {openAgentRun} from '../stores/agentNavigation'
const opened=ref<string|null>(null),input=ref(''),laterMin=ref(60),busy=ref(false),error=ref('')
const active=computed(()=>attentionStore.data?.messages.filter(m=>m.state==='open')??[])
const sleeping=computed(()=>attentionStore.data?.messages.filter(m=>m.state==='snoozed')??[])
const history=computed(()=>attentionStore.data?.messages.filter(m=>!['open','snoozed'].includes(m.state)).slice(0,12)??[])
const time=(n:number):string=>new Date(n).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})
const label=(m:MessageView):string=>({course_question:'课后事项',nudge:'任务回顾',suggestion:'计划建议',start_reminder:'执行时段提醒',deadline_reminder:'截止提醒'}[m.kind])
function choices(m:MessageView):number[]{return[15,60,120].filter(n=>Date.now()+n*60000<m.expiresAt)}
async function open(id:string):Promise<void>{if(opened.value===id){opened.value=null;return}try{await window.api.attentionAction(id,'read');opened.value=id;error.value='';await refreshAttention();const m=attentionStore.data?.messages.find(m=>m.id===id);if(m&&!choices(m).includes(laterMin.value))laterMin.value=choices(m)[0]??15}catch(e){error.value=String(e)}}
async function act(id:string,kind:'none'|'dismiss'|'later'|'mute'):Promise<void>{busy.value=true;try{await window.api.attentionAction(id,kind,laterMin.value);opened.value=null;await refreshAttention()}catch(e){error.value=String(e)}finally{busy.value=false}}
async function chat(m:MessageView,capture=false):Promise<void>{busy.value=true;error.value='';try{const r=capture?await window.api.attentionCapture(m.id,input.value.trim()):await window.api.attentionDiscuss(m.id);input.value='';await refreshAttention();openAgentRun(r.id)}catch(e){error.value=String(e)}finally{busy.value=false}}
watch(()=>attentionStore.navigation,()=>{if(attentionStore.requestedId)void open(attentionStore.requestedId)})
onMounted(()=>{if(attentionStore.requestedId)void open(attentionStore.requestedId)})
</script>
<template>
  <section class="attention-inbox" aria-label="主动消息与时间提醒"><header><h3>今日消息 <span v-if="attentionStore.data?.unread" class="new">{{ attentionStore.data.unread }}条未读</span></h3><small>可稍后处理，消息不会自动修改任务</small></header>
    <p v-if="!active.length" class="hint">暂时没有新的主动消息或时间提醒。</p>
    <article v-for="m in active" :key="m.id" :class="{unread:!m.read}"><button class="message-body" @click="open(m.id)"><small>{{ label(m) }} · {{ time(m.createdAt) }}</small><strong><i v-if="!m.read"></i>{{ m.title }}</strong><p>{{ m.text }}</p><span>{{ opened===m.id?'收起操作':'查看操作' }}</span></button>
      <div v-if="opened===m.id" class="actions">
        <div class="sources"><span v-for="e in m.evidence" :key="e.key">{{ e.title }}{{ e.end?' · 按课表结束 '+time(e.end):'' }}</span></div>
        <template v-if="m.evidence.some(e=>e.kind==='course')"><button :disabled="busy" @click="act(m.id,'none')">没有新增事项</button><div class="add"><input v-model="input" maxlength="1000" placeholder="有作业或待办？写在这里，交给助理整理…" /><button :disabled="busy||!input.trim()" @click="chat(m,true)">整理成事项草案</button></div></template>
        <button v-if="m.evidence.some(e=>e.taskId)" :disabled="busy" @click="chat(m)">核对状态 / 讨论调整</button>
        <label v-if="choices(m).length">稍后<select v-model.number="laterMin"><option v-for="n in choices(m)" :key="n" :value="n">{{ n }}分钟</option></select><button :disabled="busy" @click="act(m.id,'later')">稍后再看</button></label>
        <button class="subtle" :disabled="busy" @click="act(m.id,'dismiss')">忽略本条</button><button class="subtle" :disabled="busy" @click="act(m.id,'mute')">{{ m.evidence.every(e=>e.kind==='course')?'不再询问这些课程':'不再提醒这些任务' }}</button>
        <small>关闭对象提醒后，可在设置中恢复；任务的自动完成回顾也会遵守此选择。你仍可手动补充反馈。</small>
      </div>
    </article>
    <details v-if="sleeping.length"><summary>稍后查看（{{ sleeping.length }}）</summary><p v-for="m in sleeping" :key="m.id">{{ m.title }} · {{ time(m.snoozedUntil!) }}之后可再次查看</p></details>
    <details v-if="history.length"><summary>最近已处理消息</summary><p v-for="m in history" :key="m.id">{{ label(m) }} · {{ m.title }} · {{ {answered:'已处理',dismissed:'已忽略',cancelled:'事项或来源已变化',expired:'已过期',open:'待处理',snoozed:'稍后'}[m.state] }} <button v-if="m.runId" @click="openAgentRun(m.runId)">打开关联对话</button></p></details>
    <p v-if="attentionStore.data?.quiet" class="hint">当前处于安静时段，暂停新的主动检查与时间提醒。</p>
    <p v-if="error||attentionStore.error" role="alert" class="error">{{ error||attentionStore.error }}</p>
  </section>
</template>
<style scoped>
.attention-inbox{padding:15px;margin:0 0 18px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}h3{font-size:15px;margin:0}.new{font-size:11px;background:#fff0eb;color:#ab422a;border-radius:9px;padding:3px 7px;margin-left:7px}header>small,.hint,details{font-size:12px;color:var(--text-3);line-height:1.7}article{margin-top:10px;padding:11px;border:1px solid var(--border);border-radius:9px}article.unread{background:#f6f9ff;border-color:#b4c8eb}.message-body{width:100%;text-align:left;cursor:pointer;color:var(--text)}.message-body small{display:block;color:var(--text-3);font-size:11px}.message-body strong{display:block;margin-top:6px;font-size:13px}.message-body p{font-size:13px;line-height:1.7;margin:7px 0}.message-body span{color:var(--primary);font-size:12px}i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#dc5140;margin-right:6px}.actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:12px;border-top:1px solid var(--border);padding-top:11px}.actions button{border:1px solid var(--border);background:var(--panel);color:var(--primary);padding:7px 9px;border-radius:6px;font-size:12px;cursor:pointer}.actions button:disabled{opacity:.5}.actions small{font-size:11px;color:var(--text-3);flex-basis:100%}.sources{flex-basis:100%;display:grid;gap:4px;font-size:11px;color:var(--text-3)}.add{display:flex;gap:8px;flex-basis:100%}.add input{flex:1;min-width:80px}input,select{border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:6px;padding:7px;font-size:12px}.actions label{font-size:12px}.actions .subtle{color:var(--text-3)}details{margin-top:12px}summary{cursor:pointer}details button{color:var(--primary);font-size:12px;cursor:pointer}.error{font-size:12px;color:#a43928}
</style>
