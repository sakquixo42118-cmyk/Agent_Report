<script setup lang="ts">
import {ref,computed} from 'vue'
import type {PlanningSnapshot,CalendarExceptionInput} from '@shared/planning'
import {tasksStore} from '../stores/tasks'
import {clock,minute} from '../lib/planningTime'
import DayOverrideEditor from './DayOverrideEditor.vue'
const api=window.api
const props=defineProps<{data:PlanningSnapshot;date:string}>(),emit=defineEmits<{changed:[]}>()
const date=ref(props.date),kind=ref<CalendarExceptionInput['kind']>('busy'),courseId=ref<number|null>(null),name=ref(''),start=ref('14:00'),end=ref('15:00')
const taskId=ref<number|null>(null),prerequisiteId=ref<number|null>(null),busy=ref(false),error=ref(''),notice=ref('')
const pending=computed(()=>tasksStore.tasks.filter(t=>t.status==='pending'))
const prerequisites=computed(()=>tasksStore.tasks.filter(t=>['pending','done'].includes(t.status)&&t.id!==taskId.value))
async function act(fn:()=>Promise<unknown>,message:string):Promise<void>{if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await fn();notice.value=message;emit('changed')}catch(e){error.value=String(e)}finally{busy.value=false}}
async function addException():Promise<void>{await act(()=>api.calendarExceptionSave({kind:kind.value,date:date.value,courseId:kind.value==='busy'?null:courseId.value,name:name.value,startMin:minute(start.value),endMin:minute(end.value)},props.data.version),'日期例外已保存。')}
function label(kind:string):string{return kind==='cancel_course'?'停课':kind==='makeup_course'?'补课':'临时占用'}
</script>
<template>
  <details class="constraints-panel" open><summary>单日设置、临时日程与前置任务</summary>
    <DayOverrideEditor :data="data" :date="props.date" @changed="emit('changed')" />
    <hr /><h4>停课 / 补课 / 临时占用</h4><p>停课只取消该日的一次常规课程。补课作为另一条单日记录添加；调课时分别添加停课和补课，两个保存结果都需核对。</p>
    <form @submit.prevent="addException"><label>类型<select v-model="kind"><option value="busy">临时占用</option><option value="cancel_course">停课</option><option value="makeup_course">补课</option></select></label><label>日期<input v-model="date" type="date" required /></label>
      <label v-if="kind!=='busy'">课程<select v-model="courseId" required><option :value="null" disabled>选择课程</option><option v-for="c in data.courses" :key="c.id" :value="c.id">{{ c.name }} · 周{{ c.weekday }} {{ clock(c.startMin) }}</option></select></label>
      <label v-else>名称<input v-model="name" maxlength="80" placeholder="例如：社团面试" required /></label>
      <template v-if="kind!=='cancel_course'"><label>开始<input v-model="start" type="time" required /></label><label>结束<input v-model="end" type="time" required /></label></template><button :disabled="busy">添加日期例外</button>
    </form>
    <div v-for="e in data.exceptions.filter(e=>e.date>=data.startDate&&e.date<=data.endDate)" :key="e.id" class="row"><span>{{ e.date }} · {{ label(e.kind) }} · {{ e.name }} {{ clock(e.startMin) }}—{{ clock(e.endMin) }}</span><button :disabled="busy" @click="act(()=>api.calendarExceptionDelete(e.id,data.version),'例外已移除；停课移除后恢复常规课程。')">移除例外</button></div>
    <hr /><h4>任务前置关系</h4><p>明确指定“后续任务必须在前置任务之后做”。同批试排按先后顺序安排；只选后续项时，前置项须已完成或已有可用执行块。</p>
    <form @submit.prevent="act(()=>api.dependencySave(taskId!,prerequisiteId!,data.version),'前置关系已保存。')"><label>后续任务<select v-model="taskId" required><option :value="null" disabled>选择待办</option><option v-for="t in pending" :key="t.id" :value="t.id">#{{ t.id }} {{ t.summary||t.content }}</option></select></label><label>先完成<select v-model="prerequisiteId" required><option :value="null" disabled>选择前置任务</option><option v-for="t in prerequisites" :key="t.id" :value="t.id">#{{ t.id }} {{ t.summary||t.content }}{{ t.status==='done'?'（已完成）':'' }}</option></select></label><button :disabled="busy||!taskId||!prerequisiteId">添加前置关系</button></form>
    <div v-for="d in data.dependencies.filter(d=>d.taskStatus!=='archived')" :key="`${d.taskId}:${d.prerequisiteId}`" class="row"><span>#{{ d.prerequisiteId }} {{ d.prerequisiteTitle }} → #{{ d.taskId }} {{ d.title }} <small>{{ d.prerequisiteStatus==='done'?'前置已完成':'前置未完成' }}</small></span><button :disabled="busy" @click="act(()=>api.dependencyDelete(d.taskId,d.prerequisiteId,data.version),'前置关系已移除。')">移除关系</button></div>
    <p v-if="error" role="alert" class="error">{{ error }} <button @click="emit('changed')">刷新数据</button></p><p v-if="notice" role="status">{{ notice }}</p>
  </details>
</template>
<style scoped>
.constraints-panel{padding:16px;margin:16px 0;background:var(--panel);border:1px solid var(--border);border-radius:12px}.constraints-panel summary{cursor:pointer;font-weight:600}.constraints-panel h4{font-size:14px;margin:14px 0 6px}.constraints-panel p{font-size:12px;color:var(--text-2);line-height:1.7}.constraints-panel form{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:12px 0}.constraints-panel label{display:grid;gap:5px;font-size:12px}.constraints-panel input,.constraints-panel select{padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text);max-width:280px}.constraints-panel button{padding:8px 10px;background:var(--primary);color:white;border-radius:7px;font-size:12px;cursor:pointer}.constraints-panel button:disabled{opacity:.5}.row{display:flex;gap:10px;justify-content:space-between;align-items:center;font-size:12px;padding:8px 0;border-top:1px solid var(--border)}.row span{overflow-wrap:anywhere}.row small{color:var(--text-3)}hr{border:0;border-top:1px solid var(--border);margin:18px 0}.constraints-panel p.error{color:#b13c26}
</style>
