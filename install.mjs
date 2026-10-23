// dsh-context-dial 安装/卸载器。
//
// 为什么要有它，而不是让你手改 package.json：
//   profile 的 package.json 是 DSH 启动的关键文件，手工加 dependencies 与
//   bundles 很容易漏掉其中一处 —— 只加 dependencies 不会加载，只加 bundles
//   会解析失败。这个脚本一次改齐三处（dependencies / bundles / node_modules
//   链接），并在动手前备份、出错时回滚。
//
// 用法：
//   node install.mjs            只打印将要做什么（dry-run）
//   node install.mjs --install  真正写入
//   node install.mjs --uninstall 还原（保留备份文件）
//
// 改动完成后需要**重启 DSH** 才会加载插件。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// 用 fileURLToPath 而不是手工切 url.pathname：Windows 上后者会得到
// `/C:/...`，多一个斜杠，后续 join 会拼出错误路径。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = 'dsh-context-dial'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'desktop')
const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json')
const PLUGIN_DEST = path.join(DSH_HOME, 'local-plugins', PACKAGE_NAME)
const LINK_PATH = path.join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)

const mode = process.argv.includes('--install')
  ? 'install'
  : process.argv.includes('--uninstall')
    ? 'uninstall'
    : 'dry-run'

/** 只把这些东西当成“要复制的源”，避免把临时产物带进去。 */
const COPY_FILES = ['package.json', 'index.js', 'plan.js', 'client.js', 'cordis.patch.yml', 'README.md']

function log(msg) { console.log(msg) }

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 在 profile 的 bundles 数组里追加/移除本插件。 */
function editBundles(pkg, action) {
  const bundles = pkg?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('profile package.json 里没有 dsh.profile.bundles 数组')
  const without = bundles.filter((name) => name !== PACKAGE_NAME)
  if (action === 'install') without.push(PACKAGE_NAME)
  pkg.dsh.profile.bundles = without
}

/** 在 dependencies 里追加/移除 link: 依赖。 */
function editDependencies(pkg, action) {
  const deps = pkg.dependencies ?? {}
  if (action === 'install') {
    deps[PACKAGE_NAME] = `link:${PLUGIN_DEST.replace(/\\/g, '/')}`
  } else {
    delete deps[PACKAGE_NAME]
  }
  pkg.dependencies = deps
}

function copyPluginSource() {
  fs.mkdirSync(PLUGIN_DEST, { recursive: true })
  for (const file of COPY_FILES) {
    const from = path.join(HERE, file)
    if (!fs.existsSync(from)) continue
    fs.copyFileSync(from, path.join(PLUGIN_DEST, file))
  }
  log(`  源文件 -> ${PLUGIN_DEST}`)
}

function ensureLink() {
  fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true })
  if (fs.existsSync(LINK_PATH)) {
    log(`  链接已存在，跳过：${LINK_PATH}`)
    return
  }
  fs.symlinkSync(PLUGIN_DEST, LINK_PATH, 'junction')
  log(`  链接 -> ${LINK_PATH}`)
}

/**
 * 补齐 `@deepseek-ai/schemastery` 的解析路径。
 *
 * 插件被复制到 `~/.dsh/local-plugins/` 后，node 从插件目录逐级向上找 node_modules，
 * 而那条链上**没有** `@deepseek-ai/*` —— 宿主包打进 app.asar，不走 profile 的
 * node_modules。于是 `import z from '@deepseek-ai/schemastery'` 会抛
 * ERR_MODULE_NOT_FOUND，整个 entry 不激活（2026-10-22 第一次重启的实际报错）。
 *
 * `qq-mode-console` 没事，是因为它被挂成 junction 指回仓库，向上能找到仓库的
 * node_modules。这里用同样思路，只在插件目录里放一条精确链接。
 */
function ensureDependencyLink() {
  const dep = path.join(PLUGIN_DEST, 'node_modules', '@deepseek-ai', 'schemastery')
  const source = path.resolve(HERE, '..', '..', 'node_modules', '@deepseek-ai', 'schemastery')

  if (fs.existsSync(dep)) {
    log(`  依赖链接已存在：${dep}`)
    return
  }
  if (!fs.existsSync(source)) {
    log(`  ⚠️ 找不到 ${source}，跳过依赖链接（启动时可能 ERR_MODULE_NOT_FOUND）`)
    return
  }
  fs.mkdirSync(path.dirname(dep), { recursive: true })
  fs.symlinkSync(source, dep, 'junction')
  log(`  依赖链接 -> ${dep}`)
}

function removeDependencyLink() {
  try {
    const dep = path.join(PLUGIN_DEST, 'node_modules', '@deepseek-ai', 'schemastery')
    if (fs.existsSync(dep)) fs.unlinkSync(dep)
  } catch {}
}

function removeLink() {
  try {
    if (fs.existsSync(LINK_PATH)) {
      fs.unlinkSync(LINK_PATH)
      log(`  已移除链接 ${LINK_PATH}`)
    }
  } catch (error) {
    log(`  ⚠️ 移除链接失败（可手动删除）：${error.message}`)
  }
}

log(`目标：${PLUGIN_DEST}`)
log(`profile：${PROFILE_DIR}`)
log(`模式：${mode}`)

if (!fs.existsSync(PROFILE_PKG)) {
  console.error(`找不到 ${PROFILE_PKG}，DSH_HOME 是否正确？（当前 ${DSH_HOME}）`)
  process.exit(1)
}

if (mode === 'dry-run') {
  const pkg = readJson(PROFILE_PKG)
  log('\n将要做：')
  log(`  1. 复制 ${COPY_FILES.length} 个文件到 ${PLUGIN_DEST}`)
  log(`  2. 建 junction ${LINK_PATH}`)
  log(`  3. dependencies["${PACKAGE_NAME}"] = link:...`)
  log(`  4. bundles 追加 "${PACKAGE_NAME}"（当前 ${pkg?.dsh?.profile?.bundles?.length ?? 0} 项）`)
  log('\n确认后加 --install 执行。')
  process.exit(0)
}

const backup = `${PROFILE_PKG}.bak-${timestamp()}`
fs.copyFileSync(PROFILE_PKG, backup)
log(`\n已备份 package.json -> ${path.basename(backup)}`)

const pkg = readJson(PROFILE_PKG)
const before = JSON.stringify(pkg)

try {
  if (mode === 'install') {
    copyPluginSource()
    ensureLink()
    ensureDependencyLink()
    editDependencies(pkg, 'install')
    editBundles(pkg, 'install')
  } else {
    editDependencies(pkg, 'uninstall')
    editBundles(pkg, 'uninstall')
    removeLink()
    removeDependencyLink()
  }
  writeJson(PROFILE_PKG, pkg)
  log(`\n完成（${mode}）。`)
  if (mode === 'install') {
    log('重启 DSH 后生效；设置 → 插件 里会出现 context-dial。')
    log(`回滚：node install.mjs --uninstall  或恢复 ${path.basename(backup)}`)
  }
} catch (error) {
  fs.writeFileSync(PROFILE_PKG, before, 'utf8')
  console.error(`\n失败并已回滚 package.json：${error.message}`)
  process.exit(1)
}
