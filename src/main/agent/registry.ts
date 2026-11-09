import type { ToolDefinition } from './model'
import type { ToolContext, ToolResult } from './contracts'
import type { PendingChange } from '@shared/agent'
import {row as runRow} from './store'
import type {PlanAuditInput} from '@shared/statistics'
export interface SceneDefinition { id: string; title: string; instructions: string; tools: string[]; confirmationKinds: string[] }
export interface ToolRegistration { definition: ToolDefinition; effect: 'read' | 'draft' | 'propose' | 'respond'; execute: (args: Record<string, unknown>, context: ToolContext) => ToolResult }
export interface ConfirmationHandler { apply: (runId: string, pending: PendingChange, planAudit?:PlanAuditInput) => { message: string; details: unknown } }
const tools = new Map<string, ToolRegistration>(), scenes = new Map<string, SceneDefinition>(), confirmations = new Map<string, ConfirmationHandler>()
function supported(schema:Record<string,unknown>,depth=0):void{
  const keys=['type','properties','required','additionalProperties','enum','minimum','maximum','minLength','maxLength','items','minItems','maxItems','uniqueItems','description','title','default','examples']
  if(!schema||depth>8||Object.keys(schema).some(k=>!keys.includes(k)))throw new Error('工具使用了协议v1不支持的Schema约束。')
  const types=Array.isArray(schema.type)?schema.type:[schema.type]
  if(types.some(t=>!['object','array','string','integer','number','boolean','null'].includes(String(t))))throw new Error('Schema类型无效。')
  if(types.includes('object')){
    if(schema.additionalProperties!==false||!schema.properties)throw new Error('对象工具参数必须显式限制额外字段。')
    Object.values(schema.properties as Record<string,Record<string,unknown>>).forEach(s=>supported(s,depth+1))
  }
  if(types.includes('array'))supported(schema.items as Record<string,unknown>,depth+1)
}
export function registerTool(tool: ToolRegistration): void {
  const name = tool.definition.function.name
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || tools.has(name)) throw new Error(`工具名称无效或重复：${name}`)
  supported(tool.definition.function.parameters)
  tools.set(name, tool)
}
export function registerScene(scene: SceneDefinition): void {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(scene.id) || scenes.has(scene.id) || scene.tools.some(n => !tools.has(n)) || new Set(scene.tools).size!==scene.tools.length || scene.confirmationKinds.some(k=>!confirmations.has(k))) throw new Error('场景名称重复或包含未注册工具/确认类型。')
  scenes.set(scene.id, scene)
}
export function getScene(id: string): SceneDefinition { const s = scenes.get(id); if (!s) throw new Error('场景未注册。'); return s }
export function definitionsForScene(id: string): ToolDefinition[] { return getScene(id).tools.map(n => tools.get(n)!.definition) }
export function registerConfirmation(kind: string, handler: ConfirmationHandler): void {
  if (confirmations.has(kind)) throw new Error('确认处理器重复。')
  confirmations.set(kind, handler)
}
export function confirmationKind(p: PendingChange): string { return 'type' in p ? p.type : 'priority' }
export function applyConfirmation(scene: string, runId: string, p: PendingChange, planAudit?:PlanAuditInput): { message: string; details: unknown } {
  const kind = confirmationKind(p), handler = confirmations.get(kind)
  if (!getScene(scene).confirmationKinds.includes(kind) || !handler) throw new Error('当前场景不允许该确认操作。')
  return handler.apply(runId, p, planAudit)
}
// 支持本仓库工具使用的JSON Schema子集，完整业务约束仍由领域服务校验。
function valid(value: unknown, schema: Record<string, unknown>, depth = 0): boolean {
  if (depth > 8) return false
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (!types.includes(type) && !(types.includes('integer') && typeof value === 'number' && Number.isSafeInteger(value))) return false
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) return false
  if (typeof value === 'number' && (!Number.isFinite(value) || value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity))) return false
  if (typeof value === 'string' && (value.length < Number(schema.minLength ?? 0) || value.length > Number(schema.maxLength ?? 12000))) return false
  if (Array.isArray(value)) return value.length >= Number(schema.minItems ?? 0) && value.length <= Number(schema.maxItems ?? 60) &&
    (!schema.uniqueItems || new Set(value.map(v => JSON.stringify(v))).size === value.length) && value.every(v => valid(v, schema.items as Record<string, unknown>, depth + 1))
  if (type === 'object') {
    const obj = value as Record<string, unknown>, properties = schema.properties as Record<string, Record<string, unknown>>
    if (!obj || !properties || (schema.required as string[] ?? []).some(k => !Object.hasOwn(obj, k))) return false
    return Object.entries(obj).every(([k, v]) => Object.hasOwn(properties, k) ? valid(v, properties[k], depth + 1) : schema.additionalProperties !== false)
  }
  return true
}
export function executeSceneTool(scene: string, name: string, raw: string, context: ToolContext): ToolResult {
  const tool = tools.get(name)
  if (!tool) return { ok: false, errorCode: 'UNKNOWN_TOOL', message: '工具未注册。' }
  if (!getScene(scene).tools.includes(name)) return { ok: false, errorCode: 'TOOL_NOT_ALLOWED', message: '当前场景不允许此工具。' }
  try { if(!context.runId||runRow(context.runId).scene!==scene)throw new Error() }
  catch {return {ok:false,errorCode:'INVALID_CONTEXT',message:'运行身份与场景不一致。'}}
  let args: Record<string, unknown>
  try { if (raw.length > 16000) throw new Error(); args = JSON.parse(raw); if (!valid(args, tool.definition.function.parameters)) throw new Error() }
  catch { return { ok: false, errorCode: 'INVALID_ARGUMENTS', message: '参数类型、范围或字段不符合工具协议。' } }
  try {
    const result = tool.execute(args, context)
    if (result.pending && !getScene(scene).confirmationKinds.includes(confirmationKind(result.pending))) throw new Error('工具产生了当前场景不允许的确认请求。')
    return result
  } catch (e) { return { ok: false, errorCode: 'TOOL_ERROR', message: e instanceof Error ? e.message : '工具执行失败。' } }
}
