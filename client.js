/**
 * dsh-context-dial — browser half.
 *
 * Bundle format: window.__ModuleLoader__.load({ id, factory(require) }) —— 由 DSH
 * Web 外壳提供 CJS shim 与预注册模块（react）。没有构建步骤，所以不用 JSX，
 * 全部 React.createElement。
 *
 * 数据层直接打 DSH 自己的 HTTP 设置接口（与 qq-bridge 同一套协议）：
 *
 *   POST /api/settings/describe  { type:'client-request', rpcId, method, payload:{ args:{} } }
 *   POST /api/settings/update    { ..., payload:{ args:{ ns, patch } } }
 *   响应：{ type:'server-response', rpcId, result:{ ok:true, value } | { ok:false, error } }
 *
 * 卡片只改**本插件自己的**命名空间（`context-dial`），不碰 `llm-pi-ai`。
 * 真正把值写进 provider 的是 host 半在启动时做的事 —— 所以卡片上明确写着「重启生效」。
 *
 * 挂载点：插件页的 `plugins.row.config` 键位槽，key 为 `<包名>#<patch 行 id>`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-dial',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const PKG = 'dsh-context-dial'
    const ROW_ID = 'context-dial'
    const NS = 'context-dial'
    const TARGET_NS = 'llm-pi-ai'

    let rpcSeq = 0

    /** 发一次 client-request；失败抛 Error（由调用方显示在卡片里）。 */
    async function rpc(method, args) {
      rpcSeq += 1
      const rpcId = `${PKG}-${Date.now()}-${rpcSeq}`
      const response = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload: { args: args ?? {} },
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const full = await response.json()
      if (!full || full.type !== 'server-response') throw new Error('响应格式不对')
      if (!full.result) throw new Error('响应缺少 result')
      if (!full.result.ok) {
        const { code, message } = full.result.error ?? {}
        throw new Error(`${code ?? 'error'}: ${message ?? '未知错误'}`)
      }
      return full.result.value
    }

    /** 读设置，返回按 ns 索引的表。 */
    async function readAll() {
      const rows = await rpc('settings/describe', {})
      const map = new Map()
      if (Array.isArray(rows)) for (const row of rows) map.set(row.ns, row)
      return map
    }

    const S = {
      card: { border: '1px solid var(--border-color, #d0d7de)', borderRadius: 8, padding: 16, marginTop: 8 },
      title: { fontSize: 15, fontWeight: 600, marginBottom: 4 },
      sub: { fontSize: 12, opacity: 0.7, marginBottom: 14 },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
      label: { width: 140, fontSize: 13 },
      input: {
        flex: 1, maxWidth: 420, padding: '6px 8px', fontSize: 13, borderRadius: 6,
        border: '1px solid var(--border-color, #d0d7de)', background: 'transparent', color: 'inherit',
      },
      btn: {
        padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid var(--border-color, #d0d7de)', background: 'transparent', color: 'inherit',
      },
      btnPrimary: {
        padding: '6px 14px', fontSize: 13, borderRadius: 6, cursor: 'pointer',
        border: '1px solid #2da44e', background: '#2da44e', color: '#fff',
      },
      note: { fontSize: 12, opacity: 0.75, marginTop: 12, lineHeight: 1.6 },
      ok: { fontSize: 12, color: '#2da44e', marginTop: 10 },
      err: { fontSize: 12, color: '#cf222e', marginTop: 10, whiteSpace: 'pre-wrap' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
    }

    function Field(props) {
      return h('div', { style: S.row },
        h('div', { style: S.label }, props.label),
        h('input', {
          style: S.input,
          value: props.value,
          placeholder: props.placeholder ?? '',
          onChange: (e) => props.onChange(e.target.value),
        }))
    }

    function Card() {
      const [loading, setLoading] = React.useState(true)
      const [saving, setSaving] = React.useState(false)
      const [draft, setDraft] = React.useState({ enabled: true, provider: 'dsh-local', model: '', contextWindow: 0 })
      const [effective, setEffective] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [error, setError] = React.useState(null)

      const load = React.useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
          const map = await readAll()
          const mine = map.get(NS)
          if (mine?.value) {
            setDraft({
              enabled: mine.value.enabled !== false,
              provider: mine.value.provider ?? 'dsh-local',
              model: mine.value.model ?? '',
              contextWindow: Number(mine.value.contextWindow) || 0,
            })
          }
          // 顺带读一下当前真实生效的窗口，给用户一个参照。
          const target = map.get(TARGET_NS)?.value
          const provider = target?.providers?.[mine?.value?.provider ?? 'dsh-local']
          const model = (provider?.models ?? []).find((m) => m?.id === (mine?.value?.model ?? ''))
          setEffective(model ? model.contextWindow : null)
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      const save = async () => {
        setSaving(true)
        setError(null)
        setMessage(null)
        try {
          const patch = {
            enabled: Boolean(draft.enabled),
            provider: String(draft.provider ?? '').trim(),
            model: String(draft.model ?? '').trim(),
            contextWindow: Math.max(0, Math.floor(Number(draft.contextWindow) || 0)),
          }
          await rpc('settings/update', { ns: NS, patch })
          setMessage('已保存。重启 DSH 后由插件写入 provider 配置并生效。')
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setSaving(false)
        }
      }

      if (loading) return h('div', { style: S.card }, h('div', { style: S.sub }, '读取设置…'))

      return h('div', { style: S.card },
        h('div', { style: S.title }, '上下文窗口'),
        h('div', { style: S.sub }, '填好参数保存，重启 DSH 后生效。插件只改「声明的窗口」，不会扩大模型实际能力。'),

        h('div', { style: S.row },
          h('div', { style: S.label }, '启用'),
          h('input', {
            type: 'checkbox',
            checked: Boolean(draft.enabled),
            onChange: (e) => setDraft({ ...draft, enabled: e.target.checked }),
          })),

        h(Field, {
          label: 'provider',
          value: draft.provider,
          placeholder: 'dsh-local',
          onChange: (v) => setDraft({ ...draft, provider: v }),
        }),

        h(Field, {
          label: '模型 id',
          value: draft.model,
          placeholder: 'Qwen3.8-27B-abliterated.Q3_K_M',
          onChange: (v) => setDraft({ ...draft, model: v }),
        }),

        h('div', { style: S.row },
          h('div', { style: S.label }, '上下文窗口（token）'),
          h('input', {
            style: S.input,
            value: String(draft.contextWindow ?? 0),
            inputMode: 'numeric',
            onChange: (e) => setDraft({ ...draft, contextWindow: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 }),
          })),

        h('div', { style: S.row },
          h('button', { style: saving ? S.btn : S.btnPrimary, disabled: saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', { style: S.btn, disabled: saving, onClick: () => void load() }, '重新读取')),

        effective !== null
          ? h('div', { style: S.note },
            '当前 provider 里生效的窗口：',
            h('span', { style: S.mono }, Number(effective).toLocaleString('en-US')),
            '（重启后才会变成你填的值）')
          : null,

        message ? h('div', { style: S.ok }, message) : null,
        error ? h('div', { style: S.err }, `失败：${error}`) : null,

        h('div', { style: S.note },
          '模型 id 必须与 provider 配置里的 models[].id 完全一致；填错时启动日志会列出所有可用 id。'),
      )
    }

    exports.inject = ['slots']

    exports.apply = function apply(ctx) {
      const slots = ctx && ctx.slots
      if (!slots) return
      try {
        console.info(`[context-dial] client half applied; registering ${PKG}#${ROW_ID}`)
        ctx.effect(() => slots.inject('plugins.row.config', () => slots.register({
          name: 'plugins.row.config',
          key: `${PKG}#${ROW_ID}`,
        }, () => h(Card))), 'context-dial: card')
      } catch (err) {
        console.error('[context-dial] card registration failed:', err)
      }
    }

    return module.exports
  },
})
