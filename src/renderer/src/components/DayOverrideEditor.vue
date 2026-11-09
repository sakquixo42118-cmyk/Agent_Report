<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { PlanningSnapshot } from '@shared/planning'
import { clock, minute } from '../lib/planningTime'
const props=defineProps<{data:PlanningSnapshot;date:string}>()
const emit=defineEmits<{changed:[]}>()
const date=ref(props.date),mode=ref<'normal'|'light'>('normal'),capacity=ref<number|string>(''),start=ref(''),end=ref(''),note=ref(''),busy=ref(false),error=ref(''),notice=ref('')
const stored=computed(()=>props.data.dayOverrides.find(o=>o.date===date.value))
function load():void{const o=stored.value;mode.value=o?.mode??'normal';capacity.value=o?.dailyMaxMin??'';start.value=o?.startMin==null?'':clock(o.startMin);end.value=o?.endMin==null?'':clock(o.endMin);note.value=o?.note??'';error.value='';notice.value=''}
watch(()=>props.date,value=>{date.value=value;load()})
watch(date,load);load()
async function save(remove=false):Promise<void>{busy.value=true;error.value='';notice.value='';try{
  if(remove)await window.api.dayOverrideDelete(date.value,props.data.version)
  else await window.api.dayOverrideSave({date:date.value,mode:mode.value,dailyMaxMin:capacity.value===''?null:Number(capacity.value),startMin:start.value?minute(start.value):null,endMin:end.value?minute(end.value):null,note:note.value},props.data.version)
  if(remove){mode.value='normal';capacity.value='';start.value='';end.value='';note.value=''}
  notice.value=remove?'已恢复该日默认设置。':'仅该日设置已保存，其他日期不受影响。';emit('changed')
}catch(e){error.value=String(e)}finally{busy.value=false}}
</script>
<template>
  <div class="day-editor"><h4>当天状态与容量</h4>
    <p>只作用于所选日期。轻量模式默认将每日上限减半并向下取整至15分钟（最低15分钟）；自定义容量优先，填0表示当天不安排任务。</p>
    <form @submit.prevent="save()"><label>日期<input v-model="date" type="date" required /></label><label>状态<select v-model="mode"><option value="normal">正常</option><option value="light">轻量</option></select></label>
      <label>当天上限/分钟<input v-model="capacity" type="number" min="0" max="1440" placeholder="留空按状态计算" /></label>
      <label>当天开始<input v-model="start" type="time" /></label><label>当天结束<input v-model="end" type="time" /></label><label>备注<input v-model="note" maxlength="200" placeholder="例如：今天考试后休息" /></label>
      <button :disabled="busy">保存单日设置</button><button v-if="stored" type="button" :disabled="busy" @click="save(true)">恢复该日默认</button><button type="button" :disabled="busy" @click="load">读取已保存值</button>
    </form><p>时间留空沿用全局作息；当天窗口是明确的可安排范围。已有计划冲突时会拒绝保存，请先调整计划。</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p><p v-if="notice" role="status">{{ notice }}</p>
  </div>
</template>
<style scoped>
.day-editor h4{font-size:14px;margin:5px 0}.day-editor p{font-size:12px;color:var(--text-2);line-height:1.6}.day-editor form{display:flex;flex-wrap:wrap;gap:10px;align-items:end}.day-editor label{display:grid;gap:5px;font-size:12px}.day-editor input,.day-editor select{max-width:180px;padding:7px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}.day-editor button{padding:8px 10px;border-radius:7px;background:var(--primary);color:white;cursor:pointer}.day-editor button:disabled{opacity:.5}.day-editor p.error{color:#b13c26}
</style>
