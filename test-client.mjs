// 客户端半的离线结构测试。
//
// 真正的渲染只能在浏览器里看，这里验的是「外壳能不能加载它、卡片有没有注册到
// 正确的槽位、组件首次渲染会不会抛」—— 这三件事如果错了，插件页上根本看不到卡片。
//
// 用法：node plugins/dsh-context-dial/test-client.mjs

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`) }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ---- 假的 React ----
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

// ---- 假的 window / 槽位 ----
let loaded = null
const registered = []
const slots = {
  inject: (name, factory) => {
    injected.push(name)
    const dispose = factory()
    return dispose
  },
  register: (meta, component) => {
    registered.push({ meta, component })
    return () => {}
  },
}
const injected = []

const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { loaded = def } } },
  console,
  fetch: async () => { throw new Error('offline') },
  setTimeout,
  clearTimeout,
}
sandbox.globalThis = sandbox

const code = fs.readFileSync(path.join(HERE, 'client.js'), 'utf8')
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'client.js' })

console.log('\n## 1. 外壳加载')
{
  ok(loaded !== null, '调用了 window.__ModuleLoader__.load')
  ok(loaded?.id === 'dsh-context-dial', `id = ${loaded?.id}`)
  ok(typeof loaded?.factory === 'function', 'factory 是函数')
}

console.log('\n## 2. 模块导出与注入声明')
let mod
{
  mod = loaded.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error(`未知模块 ${name}`)
  })
  ok(typeof mod?.apply === 'function', 'exports.apply 存在')
  ok(JSON.stringify(mod?.inject) === JSON.stringify(['slots']), `inject = ${JSON.stringify(mod?.inject)}`)
}

console.log('\n## 3. 注册到正确的槽位与 key')
{
  const disposers = []
  const ctx = {
    slots,
    effect: (fn, label) => { disposers.push(label); const d = fn(); if (typeof d === 'function') disposers.push(d) },
  }
  mod.apply(ctx)
  ok(injected.includes('plugins.row.config'), `注入了槽位 ${injected.join(', ')}`)
  ok(registered.length === 1, `注册了 ${registered.length} 个卡片`)
  const meta = registered[0]?.meta
  ok(meta?.name === 'plugins.row.config', `槽位名 = ${meta?.name}`)
  ok(meta?.key === 'dsh-context-dial#context-dial', `key = ${meta?.key}`)
  ok(typeof registered[0]?.component === 'function', '组件是个函数')
}

console.log('\n## 4. 首次渲染不抛（loading 分支）')
{
  try {
    // 注册的是 `() => h(Card)` 这层包装：先拿到包裹后的元素，再渲染 Card 本身。
    const wrapperEl = registered[0].component({})
    ok(wrapperEl !== undefined && wrapperEl !== null, '包装层返回了元素')
    ok(typeof wrapperEl.type === 'function', '元素 type 是 Card 组件')

    const cardEl = wrapperEl.type({})
    ok(cardEl?.type === 'div', `Card 根节点 = ${cardEl?.type}`)
  } catch (e) {
    ok(false, '首次渲染不抛', e?.message)
  }
}

console.log('\n## 5. 没有 slots 服务时静默返回')
{
  let threw = null
  try { mod.apply({}) } catch (e) { threw = e }
  ok(threw === null, '不抛错')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
