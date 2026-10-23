// 本地验证：用假的 settings 服务跑一遍真实 apply()。
//
// 这版插件不碰任何冻结对象，唯一动作是 settings.mutate('llm-pi-ai', op)。
// 覆盖：路径算对、幂等、找不到目标时给出可读原因、开关关闭时不写、
// 修订号冲突后重试、mutate 报错不崩、未注入 commands 不崩、/context 渲染。
//
// 用法：node plugins/dsh-context-dial/test-apply.mjs

import { apply, Config } from './index.js'
import { planWrite } from './plan.js'

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`) }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** 造一份 llm-pi-ai 设置快照。 */
function makeValue(contextWindow = 262144) {
  return {
    providers: {
      'dsh-local': {
        baseURL: 'http://127.0.0.1:8080/v1',
        models: [{ id: 'Qwen3.8-27B', contextWindow, maxTokens: 24576 }],
      },
      'deepseek-account': {
        baseURL: 'https://api.deepseek.com',
        models: [{ id: 'deepseek-flash', contextWindow: 262144 }],
      },
    },
  }
}

/** 造一个假的 ctx（settings / logger / commands）。 */
function makeCtx({ value = makeValue(), mutateError = null, conflictOnce = false } = {}) {
  let revision = 3
  const calls = []
  const logs = []
  const registered = []
  let conflicts = conflictOnce ? 1 : 0

  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision, value }],
    mutate: async (ns, ops, expected) => {
      calls.push({ ns, ops, expected })
      if (conflicts > 0) { conflicts -= 1; throw new Error('SettingsConflictError: revision 3 != 4') }
      if (mutateError) throw mutateError
      const node = ops[0].path.slice(1, -1).reduce((acc, key) => acc[key], value.providers)
      node[ops[0].path.at(-1)] = ops[0].value
      revision += 1
    },
  }

  return {
    settings,
    logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]) },
    commands: { register: (d) => { registered.push(d); return () => {} } },
    _value: value,
    _calls: calls,
    _logs: logs,
    _registered: registered,
  }
}

/** 等 apply() 里那个 void run() 的微任务跑完。 */
const settle = () => new Promise((r) => setTimeout(r, 0))

console.log('\n## 1. Config 默认值')
{
  const d = Config({})
  console.log('   ', JSON.stringify(d))
  ok(d.enabled === true, 'enabled 默认 true')
  ok(d.provider === 'dsh-local', 'provider 默认 dsh-local')
  ok(d.model === '', 'model 默认为空')
  ok(d.contextWindow === 0, 'contextWindow 默认 0（不写入）')
}

console.log('\n## 2. 正常写入：路径与值都正确')
{
  const ctx = makeCtx()
  apply(ctx, { enabled: true, provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 })
  await settle()

  ok(ctx._calls.length === 1, `mutate 被调用 ${ctx._calls.length} 次`)
  const call = ctx._calls[0]
  ok(call?.ns === 'llm-pi-ai', `命名空间 = ${call?.ns}`)
  ok(JSON.stringify(call?.ops[0]?.path) === JSON.stringify(['providers', 'dsh-local', 'models', 0, 'contextWindow']),
    `路径 = ${JSON.stringify(call?.ops[0]?.path)}`)
  ok(call?.ops[0]?.value === 98304, `写入值 = ${call?.ops[0]?.value}`)
  ok(call?.expected === 3, `带上修订号 = ${call?.expected}`)
  ok(ctx._value.providers['dsh-local'].models[0].contextWindow === 98304, '快照里已变成 98304')
  ok(ctx._logs.some(([lvl, m]) => lvl === 'info' && m.includes('applied')), '记录了 applied')
}

console.log('\n## 3. 幂等：已经是目标值时不写')
{
  const ctx = makeCtx({ value: makeValue(98304) })
  apply(ctx, { provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 })
  await settle()
  ok(ctx._calls.length === 0, `没有产生写入（实际 ${ctx._calls.length} 次）`)
  ok(ctx._logs.some(([lvl, m]) => lvl === 'info' && m.includes('unchanged')), '记录为 unchanged')
}

console.log('\n## 4. 找不到 provider / model 时给出可读原因')
{
  const ctx = makeCtx()
  apply(ctx, { provider: 'nope', model: 'Qwen3.8-27B', contextWindow: 98304 })
  await settle()
  ok(ctx._calls.length === 0, '没有写入')
  const warn = ctx._logs.find(([lvl]) => lvl === 'warn')?.[1] ?? ''
  console.log(`    ${warn}`)
  ok(warn.includes('nope'), '日志指出 provider 不存在')

  const ctx2 = makeCtx()
  apply(ctx2, { provider: 'dsh-local', model: 'typo-model', contextWindow: 98304 })
  await settle()
  const warn2 = ctx2._logs.find(([lvl]) => lvl === 'warn')?.[1] ?? ''
  console.log(`    ${warn2}`)
  ok(warn2.includes('typo-model') && warn2.includes('Qwen3.8-27B'), '日志列出了现有模型名')
}

console.log('\n## 5. 不写入的情形：开关关闭 / 目标为 0 / 参数缺失')
{
  for (const [label, cfg] of [
    ['enabled=false', { enabled: false, provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 }],
    ['contextWindow=0', { provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 0 }],
    ['缺 model', { provider: 'dsh-local', contextWindow: 98304 }],
  ]) {
    const ctx = makeCtx()
    apply(ctx, cfg)
    await settle()
    ok(ctx._calls.length === 0, `${label}：没有写入`)
  }
}

console.log('\n## 6. 修订号冲突：重读后重试成功')
{
  const ctx = makeCtx({ conflictOnce: true })
  apply(ctx, { provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 })
  await settle()
  ok(ctx._calls.length === 2, `mutate 被调用 ${ctx._calls.length} 次（一次冲突 + 一次重试）`)
  ok(ctx._value.providers['dsh-local'].models[0].contextWindow === 98304, '重试后写入成功')
  ok(ctx._logs.some(([lvl, m]) => lvl === 'info' && m.includes('applied')), '记录为 applied')
}

console.log('\n## 7. mutate 抛其它错误：不崩，记为 failed 并保留原因')
{
  const ctx = makeCtx({ mutateError: new Error('Config field "providers" is not volatile') })
  let threw = null
  try {
    apply(ctx, { provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 })
    await settle()
  } catch (e) { threw = e }
  ok(threw === null, 'apply 不抛错')
  const warn = ctx._logs.find(([lvl]) => lvl === 'warn')?.[1] ?? ''
  console.log(`    ${warn}`)
  ok(warn.includes('not volatile'), '把真实原因原样记进日志')
}

console.log('\n## 8. 未注入 commands 时不得崩（cordis 代理会抛）')
{
  const ctx = makeCtx()
  const guarded = new Proxy(ctx, {
    get(target, prop, receiver) {
      if (prop === 'commands') throw new Error('cannot get property "commands" without inject')
      return Reflect.get(target, prop, receiver)
    },
  })
  let threw = null
  try {
    apply(guarded, { provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 })
    await settle()
  } catch (e) { threw = e }
  ok(threw === null, 'apply 不抛错', threw?.message)
  ok(ctx._value.providers['dsh-local'].models[0].contextWindow === 98304, '写入仍然完成')
}

console.log('\n## 9. /context 渲染')
{
  const ctx = makeCtx({ value: makeValue(262144) })
  apply(ctx, { provider: 'dsh-local', model: 'Qwen3.8-27B', contextWindow: 98304 })
  await settle()
  ok(ctx._registered.length === 1, '/context 已注册')
  const out = ctx._registered[0].handler().text
  console.log('--- /context ---')
  console.log(out.split('\n').map((l) => `    ${l}`).join('\n'))
  console.log('---------------')
  ok(out.includes('dsh-local/Qwen3.8-27B'), '显示目标')
  ok(out.includes('98,304'), '显示当前值（startup 已写入）')
  ok(out.includes('已与目标一致'), '明确告知已生效')
}

console.log('\n## 10. planWrite 纯函数：下标按模型 id 定位，不写死 0')
{
  const value = {
    providers: {
      p: { models: [{ id: 'a', contextWindow: 100 }, { id: 'b', contextWindow: 200 }] },
    },
  }
  const plan = planWrite(value, 'p', 'b', 999)
  ok(plan.ok === true, 'b 能被找到')
  ok(plan.modelIndex === 1, `下标 = ${plan.modelIndex}（不是 0）`)
  ok(plan.current === 200, `原值 = ${plan.current}`)
  ok(plan.op[0].path[3] === 1, 'op 路径用的是真实下标')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
