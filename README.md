# dsh-context-dial

在 **DSH 插件页**里用一个卡片填参数，**重启 DSH** 后把某个模型的上下文窗口改掉。

## 界面

插件由两半组成，和 `dsh-local-llm-controller` 同样的形态：

| 半 | 文件 | 作用 |
|---|---|---|
| host | `index.js` | 启动时读本插件设置，把值写进 `llm-pi-ai` 的 `providers.*.models[].contextWindow` |
| client | `client.js` | 在「插件 → context-dial → 配置」里渲染一个卡片：填 provider / 模型 id / 窗口 |

卡片通过 DSH 自己的 HTTP 接口读写**本插件**的设置命名空间（`context-dial`）：

```
POST /api/settings/describe   { args: {} }
POST /api/settings/update     { args: { ns: 'context-dial', patch: {...} } }
```

它不直接改 `llm-pi-ai`——那是 host 半在启动时做的事，所以卡片上明确写着「重启生效」。

## 为什么是「写设置」而不是「打补丁」

前两版试着包装 `ctx.llm.resolveModelInfo` 和 `ctx.compaction.config`，在真实 DSH 上双双失败：

```
[context-dial] 窗口接管=失败(实例与原型都不可写（对象被冻结）)
              引擎参数接管=失败(ctx.compaction.config 不可读)
```

原因是设计如此：`ctx.llm` 是 cordis 服务代理，改不动；`ctx.compaction` 活在 preset 的
`isolate` 域里，profile 级插件看不到。

现在只走**公开接口**：`ctx.settings.describe()` 读、`ctx.settings.mutate()` 按路径写
`llm-pi-ai` 里那个模型的 `contextWindow`。不碰任何冻结对象。

## 用法

1. **设置 → 插件 → context-dial**，填四个字段：

| 字段 | 说明 | 示例 |
|---|---|---|
| `enabled` | 总开关 | `true` |
| `provider` | `llm-pi-ai` 里的 provider 键名 | `dsh-local` |
| `model` | 模型 id，必须与 `models[].id` 完全一致 | `Qwen3.8-27B-abliterated.Q3_K_M` |
| `contextWindow` | 要写入的窗口 token 数，`0` = 不写 | `98304` |

2. **重启 DSH**。

3. 启动时插件会把值写进 `llm-pi-ai`，日志里会有一行：

```
[context-dial] applied: dsh-local/Qwen3.8-27B-abliterated.Q3_K_M: 262144 -> 98304（触发：startup）
```

4. 会话里 `/context` 可以看当前值与目标值：

```
上下文窗口 · dsh-local/Qwen3.8-27B-abliterated.Q3_K_M
目标值：98,304
当前生效：98,304（models[0]）
✅ 已与目标一致
```

## 为什么要重启

插件只在 **apply（启动）** 这一刻写设置。原因：改窗口会改变压缩阈值，这属于「会影响
正在进行的会话」的变更；放在启动时做，行为可预测，也不会在聊天中途突然换窗口。

设置页的改动本身会持久化，重启后插件读到新值再写。

## 找不到模型名怎么办

填错会在日志里列出该 provider 下所有可用 id：

```
[context-dial] failed: provider "dsh-local" 下没有模型 "typo"
               （现有：Qwen3.8-27B-abliterated.Q3_K_M）（触发：startup）
```

也可以直接看 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 的
`providers.<id>.models[].id`。

## 已知边界

- **依赖 `@deepseek-ai/schemastery` 能被解析到。** 插件的 host 半在顶层 import 它，
  而 DSH 的宿主包打在 `app.asar` 里、不走 profile 的 `node_modules`。所以安装目录
  的上层必须能找到这个包（`install.mjs` 会尝试从同仓 `node_modules` 建一条链接）。
  否则启动时报 `ERR_MODULE_NOT_FOUND`，整个 entry 不激活。
- **只改「声明窗口」，不扩容。** 设得比 llama-server 的 `-c` 大，请求照样会被 provider
  拒绝。这个插件是用来**对齐**的。
- 依赖 `llm-pi-ai` 的 `providers` 字段在 DSH 里是 `volatile` 的。如果某个版本不是，
  日志会明确写出 `Config field "providers" is not volatile`，此时插件不会生效，也不会
  破坏任何配置。
- 幂等：已经是目标值就不写，不产生多余的文件变更。

## 安装 / 卸载

```bash
node install.mjs            # dry-run
node install.mjs --install  # 写入 profile（会备份 package.json）
node install.mjs --uninstall
```

安装后需要重启 DSH 才会加载插件。

## 自检

```bash
node test-apply.mjs
```

34 项断言，用假 `settings` 服务跑真实 `apply()`：路径正确性、幂等、未知
provider/model 的可读报错、开关与空值不写、修订号冲突重试、mutate 报错不崩、
未注入 `commands` 不崩、`/context` 渲染，以及下标按模型 id 定位（不写死 0）。
