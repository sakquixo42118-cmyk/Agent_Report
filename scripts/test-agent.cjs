const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const output = path.join(root, 'artifacts', 'agent-tests.cjs')
fs.mkdirSync(path.dirname(output), { recursive: true })
require('esbuild').buildSync({ entryPoints: [path.join(root, 'tests', 'agent.test.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'better-sqlite3'],
  alias: { '@shared': path.join(root, 'src', 'shared') }, tsconfig: path.join(root, 'tsconfig.node.json') })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(require('electron'), [output, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit', timeout: 300000 })
if (result.error) console.error(result.error.message)
process.exit(result.status ?? 1)
