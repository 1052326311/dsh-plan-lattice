import { readFile } from 'node:fs/promises'

const [, , command, manifestPath] = process.argv

if (command !== 'plan' || manifestPath === undefined) {
  console.error('usage: release-planner plan <manifest>')
  process.exitCode = 1
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  console.log(JSON.stringify({ version: manifest.version, artifacts: manifest.artifacts }))
}
