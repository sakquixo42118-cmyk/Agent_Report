<script setup lang="ts">
import {PLAN_REASON_LABELS,type PlanAuditInput,type PlanChangeReason} from '@shared/statistics'
defineProps<{modelValue:PlanAuditInput}>()
const emit=defineEmits<{'update:modelValue':[value:PlanAuditInput]}>()
</script>
<template>
  <div class="plan-reason"><label>本次改期原因<select :value="modelValue.reason" @change="emit('update:modelValue',{...modelValue,reason:($event.target as HTMLSelectElement).value as PlanChangeReason})"><option v-for="(label,key) in PLAN_REASON_LABELS" :key="key" :value="key">{{ label }}</option></select></label><label>补充说明（可选）<input :value="modelValue.note" maxlength="200" @input="emit('update:modelValue',{...modelValue,note:($event.target as HTMLInputElement).value})" /></label><small>只有选择“我主动推迟”且执行开始时间后移，才计入主动延期；未说明的改期单独记录。</small></div>
</template>
<style scoped>
.plan-reason{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--panel)}.plan-reason label{display:grid;gap:5px;font-size:12px}.plan-reason select,.plan-reason input{border:1px solid var(--border);border-radius:5px;padding:6px;background:var(--panel);color:var(--text)}.plan-reason small{flex-basis:100%;font-size:11px;color:var(--text-3)}
</style>
