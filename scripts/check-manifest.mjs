/**
 * Guard the three names that must agree for a bundle to mount and render:
 * the package name, the inserted patch row, and the Client module id.
 *
 * Also checks the files the runtime and the README depend on. Runs in CI and
 * locally (`node scripts/check-manifest.mjs`).
 */
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFile(join(root, name), 'utf8')
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const pkg = JSON.parse(await read('package.json'))
const patch = await read('cordis.patch.yml')
const client = await read('client.js')

check(pkg.name === 'dsh-plugin-proxy-toggle', `unexpected package name: ${pkg.name}`)
check(pkg.type === 'module', 'package.json must set "type": "module"')
check(pkg.license === 'MIT', 'license must be MIT')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json must declare dsh.bundle.patch')
check(pkg.dsh?.client?.platform === 'web', 'package.json must declare the web client platform')
check(Boolean(pkg.exports?.['.']), 'exports must include "."')
check(Boolean(pkg.exports?.['./client']), 'exports must include "./client"')
check(patch.includes(`name: '${pkg.name}'`), 'cordis.patch.yml must insert the package name')
check(client.includes(`id: '${pkg.name}'`), 'client.js module id must equal the package name')
check(Array.isArray(pkg.files) && pkg.files.includes('index.js') && pkg.files.includes('client.js'), 'files must ship the runtime')

for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'LICENSE', 'README.md', 'docs/settings-page.png', 'docs/sidebar-on.png']) {
  try {
    await access(join(root, file), constants.R_OK)
  } catch {
    failures.push(`missing file: ${file}`)
  }
}

for (const file of ['locale/en.json', 'locale/zh.json']) {
  try {
    JSON.parse(await read(file))
  } catch {
    failures.push(`${file} is not valid JSON`)
  }
}

if (failures.length > 0) {
  console.error('manifest checks failed:')
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('manifest checks passed')
