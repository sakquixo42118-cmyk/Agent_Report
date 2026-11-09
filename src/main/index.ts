import { app, BrowserWindow, shell, powerMonitor } from 'electron'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { registerIpcHandlers } from './ipc'
import { closeDb } from './db/database'
import { onAppStart } from './ai/analyzer'
import { startWorker, stopWorker } from './feedback/worker'
import {startAttention,stopAttention,wakeAttention} from './attention/worker'

// win32 通知必设
app.setAppUserModelId('com.personal.plan')
// 新版与0.1用户数据分开，测试可指定临时目录，不迁移/覆盖原库。
const agentDataPath = process.env.SUISHOU_DATA_DIR || path.join(app.getPath('appData'), 'suishou-plan-agent')
mkdirSync(agentDataPath, { recursive: true })
app.setPath('userData', agentDataPath)

let mainWindow: BrowserWindow | null = null
const ownsInstance=app.requestSingleInstanceLock()
if(!ownsInstance)app.quit()
app.on('second-instance',()=>{
  if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus()}
  wakeAttention()
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 860,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: '随手计划 · Agent',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })
  mainWindow.on('focus',wakeAttention)

  // 外部链接走系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if(!ownsInstance)return
  registerIpcHandlers(() => mainWindow)
  createWindow()
  startWorker()
  startAttention()
  powerMonitor.on('resume',wakeAttention)
  // 启动钩子：恢复中断的收件箱分析 + 每日重评
  onAppStart()
  // 第二阶段只通过试排/确认保存执行块，不在启动时改写任务日期。

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopWorker()
  stopAttention()
  closeDb()
})
