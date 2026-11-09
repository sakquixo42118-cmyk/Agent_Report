// 两类后台工作共用一个模型席位；用户主动对话可中断它，网络始终在事务之外。
let owner:string|null=null,controller:AbortController|null=null
export function acquireBackground(name:string,signal:AbortController):boolean{
  if(owner)return false;owner=name;controller=signal;return true
}
export function releaseBackground(name:string):void{if(owner===name){owner=null;controller=null}}
export function interruptBackground():void{controller?.abort('foreground')}
export function backgroundOccupied():boolean{return owner!==null}
