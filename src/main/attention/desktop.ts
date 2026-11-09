import {Notification,type BrowserWindow} from 'electron'
import {ATTENTION_IPC} from '@shared/attention'
import {desktopResult,type desktopBatch} from './service'
export function sendAttentionDesktop(batch:NonNullable<ReturnType<typeof desktopBatch>>,getWindow:()=>BrowserWindow|null):void{
  if(!Notification.isSupported()){desktopResult(batch.id,'failed');return}
  const notice=new Notification({title:`随手计划 · ${batch.messages.length}条时间提醒`,
    body:batch.messages.slice(0,3).map(m=>m.title.slice(0,60)).join('；')+(batch.messages.length>3?' 等，点击查看今日消息。':'，点击查看今日消息。'),silent:true})
  notice.on('show',()=>desktopResult(batch.id,'shown'))
  notice.on('failed',()=>desktopResult(batch.id,'failed'))
  notice.on('click',()=>{const win=getWindow();if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();win.webContents.send(ATTENTION_IPC.navigate,batch.messages[0].id)}})
  notice.show()
}
