/**
 * 设置路径规划 — 与 DSH 运行时无关的纯函数。
 *
 * 为什么要单独一层：改 `llm-pi-ai` 的 `contextWindow` 是**按路径写**的，路径算错
 * 就会把别的 provider / 别的模型改掉。把「从设置快照里找出该改哪一个下标」这件事
 * 抽成纯函数，就能在普通 node 里离线验证，不必每次都重启 DSH 试。
 *
 * 设置快照的形状（dsh-settings.describe() 里 `llm-pi-ai` 的 value）：
 *
 *   {
 *     providers: {
 *       "dsh-local": {
 *         baseURL: "...",
 *         models: [ { id: "Qwen3...", contextWindow: 262144, ... } ],
 *         ...
 *       }
 *     }
 *   }
 */

/**
 * 在设置快照里找到指定 provider 的配置对象。
 * @param value - describe() 返回的命名空间值。
 * @param providerId - 例如 `dsh-local`。
 * @returns provider 配置对象，或 undefined。
 */
export function findProvider(value, providerId) {
  const providers = value?.providers
  if (!providers || typeof providers !== 'object') return undefined
  if (!providerId) return undefined
  return providers[providerId]
}

/**
 * 在 models 数组里按 id 找下标。
 *
 * 刻意不写死 0：模型顺序由用户的 provider 配置决定，改错下标会静默改到别的模型。
 *
 * @param models - provider.models 数组。
 * @param modelId - 例如 `Qwen3.8-27B-abliterated.Q3_K_M`。
 * @returns 下标，找不到返回 -1。
 */
export function findModelIndex(models, modelId) {
  if (!Array.isArray(models) || !modelId) return -1
  return models.findIndex((m) => m && m.id === modelId)
}

/**
 * 构造 `ctx.settings.mutate()` 需要的 op 列表。
 *
 * @param providerId - provider 键名。
 * @param modelIndex - models 数组下标。
 * @param contextWindow - 目标窗口（正整数）。
 * @returns `[{ op: 'set', path: [...], value: n }]`。
 */
export function buildContextWindowOp(providerId, modelIndex, contextWindow) {
  return [{
    op: 'set',
    path: ['providers', providerId, 'models', modelIndex, 'contextWindow'],
    value: Math.floor(contextWindow),
  }]
}

/**
 * 一次性把「当前状态」解读出来，供日志与 /context 使用。
 *
 * @param value - 设置快照里 `llm-pi-ai` 的值。
 * @param providerId - 目标 provider。
 * @param modelId - 目标模型。
 * @returns `{ ok, reason?, current?, op? }`
 */
export function planWrite(value, providerId, modelId, contextWindow) {
  if (!providerId) return { ok: false, reason: '未配置 provider' }
  if (!modelId) return { ok: false, reason: '未配置 model' }
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    return { ok: false, reason: `contextWindow 必须是正整数（收到 ${contextWindow}）` }
  }

  const provider = findProvider(value, providerId)
  if (provider === undefined) {
    const known = Object.keys(value?.providers ?? {})
    return { ok: false, reason: `设置里没有 provider "${providerId}"（现有：${known.join(', ') || '无'}）` }
  }

  const index = findModelIndex(provider.models, modelId)
  if (index < 0) {
    const known = (provider.models ?? []).map((m) => m?.id).filter(Boolean)
    return { ok: false, reason: `provider "${providerId}" 下没有模型 "${modelId}"（现有：${known.join(', ') || '无'}）` }
  }

  const current = provider.models[index].contextWindow
  return {
    ok: true,
    current,
    same: current === contextWindow,
    op: buildContextWindowOp(providerId, index, contextWindow),
    modelIndex: index,
  }
}
