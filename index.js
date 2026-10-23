/**
 * dsh-context-dial — 在设置页里改某个模型的上下文窗口。
 *
 * 为什么是「写设置」而不是「打补丁」
 * ---------------------------------
 * 前两版试图包装 `ctx.llm.resolveModelInfo` 和 `ctx.compaction.config`，在真实 DSH
 * 上双双失败（2026-10-22 日志）：
 *
 *   [context-dial] 窗口接管=失败(实例与原型都不可写（对象被冻结）)
 *                  引擎参数接管=失败(ctx.compaction.config 不可读)
 *
 * 原因是设计如此：`ctx.llm` 是 cordis 服务代理，改不动；`ctx.compaction` 活在 preset
 * 的 `isolate` 域里，profile 级插件看不到。
 *
 * 唯一**公开且活着**的接缝是 `ctx.settings`：`describe()` 读、`mutate()` 按路径写，
 * 写入还会发 `settings/document-updated`。所以改成：
 *
 *   本插件设置 → settings.mutate('llm-pi-ai', [set providers.X.models[i].contextWindow])
 *
 * 适配器下次解析模型信息就读到新窗口，压缩引擎每步现读，阈值随之变化 —— 不用重启，
 * 也不用动任何冻结对象。
 */

import z from '@deepseek-ai/schemastery'
import { planWrite } from './plan.js'

export { buildContextWindowOp, findModelIndex, findProvider, planWrite } from './plan.js'

export const name = 'dsh-context-dial'

/** settings 是唯一真正需要的 seam。 */
export const inject = ['settings']

/** 目标命名空间：local-llm-controller 把 provider 配置存在这里。 */
const TARGET_NS = 'llm-pi-ai'

/**
 * 安全读取一个**未声明注入**的服务。
 *
 * cordis 的代理在读未 inject 的属性时是抛错，不是返回 undefined —— `?.` 挡不住。
 * 2026-10-22 那次「1 entry did not activate」就是这么来的。
 */
function safeService(ctx, name) {
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

/** 设置页字段。带 `volatile` 才能被 settings 写回。 */
export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('总开关。关闭后不再写任何设置。')
    .extra('volatile', true),

  provider: z.string().default('dsh-local')
    .description(`要改的 provider id（${TARGET_NS} 里的键名），例如 dsh-local。`)
    .extra('volatile', true),

  model: z.string().default('')
    .description('要改的模型 id，必须与 provider 配置里的 models[].id 完全一致。')
    .extra('volatile', true),

  contextWindow: z.number().step(1).min(0).default(0)
    .description('要写入的上下文窗口 token 数。0 = 不写入。')
    .extra('volatile', true),
})

/** 读当前配置：优先 ctx.config（热更新后立刻反映），退回装配时的那份。 */
function readConfig(ctx, fallback) {
  try {
    const live = ctx?.config
    if (live && typeof live === 'object') return { ...fallback, ...live }
  } catch {}
  return fallback
}

/** 从 describe() 里取出目标命名空间那一条。 */
function findDescriptor(settings, ns) {
  try {
    const rows = settings.describe()
    return Array.isArray(rows) ? rows.find((row) => row.ns === ns) : undefined
  } catch {
    return undefined
  }
}

/**
 * 把配置推到 `llm-pi-ai`。幂等：目标等于现值就返回 unchanged，避免自我触发。
 *
 * @returns `Promise<{ status: 'applied'|'unchanged'|'skipped'|'failed', detail: string }>`
 */
async function pushWindow(ctx, cfg) {
  if (cfg?.enabled === false) return { status: 'skipped', detail: '总开关关闭' }
  const target = Number(cfg?.contextWindow) || 0
  if (target <= 0) return { status: 'skipped', detail: 'contextWindow 为 0（不写入）' }
  if (!cfg?.provider || !cfg?.model) return { status: 'skipped', detail: 'provider 或 model 未填' }

  const settings = safeService(ctx, 'settings')
  if (!settings?.mutate) return { status: 'failed', detail: '没有 settings 服务' }

  const descriptor = findDescriptor(settings, TARGET_NS)
  if (!descriptor) return { status: 'failed', detail: `设置里找不到命名空间 "${TARGET_NS}"` }

  const plan = planWrite(descriptor.value, cfg.provider, cfg.model, target)
  if (!plan.ok) return { status: 'failed', detail: plan.reason }
  if (plan.same) return { status: 'unchanged', detail: `已经是 ${plan.current}` }

  try {
    await settings.mutate(TARGET_NS, plan.op, descriptor.revision)
    return { status: 'applied', detail: `${cfg.provider}/${cfg.model}: ${plan.current} -> ${target}` }
  } catch (error) {
    const message = String(error?.message ?? error)
    // 修订号冲突（期间别人也写了）就重读一次再试，其它错误直接报出来。
    if (/revision|conflict/i.test(message)) {
      const fresh = findDescriptor(settings, TARGET_NS)
      const retryPlan = fresh ? planWrite(fresh.value, cfg.provider, cfg.model, target) : null
      if (retryPlan?.ok && !retryPlan.same) {
        try {
          await settings.mutate(TARGET_NS, retryPlan.op, fresh.revision)
          return { status: 'applied', detail: `${cfg.provider}/${cfg.model}: ${retryPlan.current} -> ${target}（冲突重试成功）` }
        } catch (retryError) {
          return { status: 'failed', detail: String(retryError?.message ?? retryError) }
        }
      }
      if (retryPlan?.same) return { status: 'unchanged', detail: '冲突重读后已是目标值' }
    }
    return { status: 'failed', detail: message }
  }
}

/** 把一次 push 的结果写进日志（失败用 warn，便于定位）。 */
function logOutcome(ctx, result, reason) {
  const line = `[context-dial] ${result.status}: ${result.detail}（触发：${reason}）`
  try {
    if (result.status === 'failed') ctx.logger?.warn?.(line)
    else ctx.logger?.info?.(line)
  } catch {}
}

/** 组装 /context 正文。 */
function renderContext(ctx, cfg) {
  const settings = safeService(ctx, 'settings')
  const lines = []
  lines.push(`上下文窗口 · ${cfg.provider || '(未设)'}/${cfg.model || '(未设)'}`)
  lines.push(`目标值：${cfg.contextWindow > 0 ? Number(cfg.contextWindow).toLocaleString('en-US') : '未设置'}`)

  if (!settings?.describe) {
    lines.push('设置服务不可用，无法读取当前值')
    return lines.join('\n')
  }

  const descriptor = findDescriptor(settings, TARGET_NS)
  if (!descriptor) return lines.join(`\n找不到命名空间 "${TARGET_NS}"`)

  const provider = descriptor.value?.providers?.[cfg.provider]
  if (!provider) {
    const known = Object.keys(descriptor.value?.providers ?? {})
    lines.push(`provider "${cfg.provider}" 不存在（现有：${known.join(', ') || '无'}）`)
    return lines.join('\n')
  }

  const models = Array.isArray(provider.models) ? provider.models : []
  const index = models.findIndex((m) => m?.id === cfg.model)
  if (index < 0) {
    lines.push(`模型 "${cfg.model}" 不在该 provider 下`)
    lines.push(`现有模型：${models.map((m) => m?.id).filter(Boolean).join(', ') || '无'}`)
    return lines.join('\n')
  }

  const current = models[index].contextWindow
  lines.push(`当前生效：${Number(current).toLocaleString('en-US')}（models[${index}]）`)
  if (cfg.contextWindow > 0 && Number(current) !== Number(cfg.contextWindow)) {
    lines.push('⚠️ 与目标不一致，重启 DSH 后写入')
  } else if (cfg.contextWindow > 0) {
    lines.push('✅ 已与目标一致')
  }
  return lines.join('\n')
}

/**
 * 装配。
 * @param ctx - 插件上下文。
 * @param config - loader 传入的初始配置。
 */
export function apply(ctx, config = {}) {
  const getConfig = () => readConfig(ctx, config)

  // 同一时刻只跑一次，避免 apply 与事件同时触发造成并发写。
  let running = false
  const run = async (reason) => {
    if (running) return
    running = true
    try {
      logOutcome(ctx, await pushWindow(ctx, getConfig()), reason)
    } catch (error) {
      logOutcome(ctx, { status: 'failed', detail: String(error?.message ?? error) }, reason)
    } finally {
      running = false
    }
  }

  // 装配即推一次。本插件的契约是「设置页填参数 → 重启生效」，所以这里不订阅
  // settings 事件：写入发生在启动这一刻，行为可预测，也不会在会话进行中改窗口。
  void run('startup')

  const commands = safeService(ctx, 'commands')
  if (!commands?.register) {
    try { ctx.logger?.warn?.('[context-dial] 无 commands 服务，/context 未注册') } catch {}
    return
  }

  let CommandDefinitionId = (value) => value
  Promise.resolve()
    .then(() => import('@deepseek-ai/dsh-commands/brand'))
    .then((mod) => { if (typeof mod?.CommandDefinitionId === 'function') CommandDefinitionId = mod.CommandDefinitionId })
    .catch(() => {})

  try {
    commands.register({
      definitionId: CommandDefinitionId('dsh-context-dial'),
      name: 'context',
      description: '显示上下文窗口的当前值与目标值',
      handler: () => ({ kind: 'success', text: renderContext(ctx, getConfig()) }),
    })
  } catch (error) {
    try { ctx.logger?.warn?.(`[context-dial] /context 注册失败: ${error?.message ?? error}`) } catch {}
  }
}
