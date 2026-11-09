import {reactive,readonly} from 'vue'
import type {AttentionState} from '@shared/attention'
const state=reactive<{data:AttentionState|null;error:string;requestedId:string|null;navigation:number}>({data:null,error:'',requestedId:null,navigation:0})
let sequence=0
export async function refreshAttention():Promise<void>{const serial=++sequence;try{const data=await window.api.attentionState();if(serial===sequence){state.data=data;state.error=''}}catch(e){if(serial===sequence)state.error=String(e)}}
export function requestAttention(id:string):void{state.requestedId=id;state.navigation++}
export function startAttentionListener():()=>void{
  void refreshAttention();const off=window.api.onAttentionChanged(()=>void refreshAttention()),offTask=window.api.onTaskChanged(()=>void refreshAttention()),offNav=window.api.onAttentionNavigate(requestAttention)
  const timer=setInterval(()=>void refreshAttention(),30000)
  return()=>{off();offTask();offNav();clearInterval(timer)}
}
export const attentionStore=readonly(state)
