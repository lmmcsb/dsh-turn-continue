# dsh-turn-continue（会话守护）

根据会话的回合事件自动补发「继续」：正常输出不干预；符合条件的空回合、输出截断或指定模型错误可自动续跑。模型错误导致回合终止时，先选择可用的备用模型，再安排下一轮。

插件不分析任务目标，也不能判断任务是否真正完成。它不覆盖宿主退出、进程崩溃或仍在运行但没有产生事件的请求。

## 行为

| 场景 | 处理 |
| --- | --- |
| 回合有正文或工具调用 | 不按空回合续跑 |
| 没有正文、没有工具调用，思考字符数达到 `minReasoningChars` | 回合结束前用 `steer` 补发「继续」 |
| 宿主报告 `max-tokens` | 用 `followup` 安排下一轮；这是单次输出上限，与账户余额、套餐额度不同 |
| 请求错误码命中 `tripCodes` | 记录实际失败的供应商与模型，达到阈值时打开熔断；保留宿主其他重试处理 |
| 上述模型错误最终导致 `turn/end` | 隔离失败路由，按清单顺序选择健康备用，再安排「继续」 |
| 没有可用备用模型 | 可在原路由上继续尝试；连续第 3 次无法换到可用路由时停止续跑 |
| 用户停止、归档、关闭插件、发送新输入或开始新回合 | 取消旧回合待补发；显式开启 `continueOnAbort` 才允许对用户中断补发 |
| 父任务取消、插件销毁、阻塞或其他非用户中断 | 不自动续跑 |

每轮最多补发 `maxContinuePerTurn` 次；每个会话的十分钟窗口最多 `maxContinuePerSession` 次。任一上限为 0 时不续跑。重复结束事件不会多发，等待补发期间会再次核对配置、会话身份、回合状态和预算。

## 界面

- 每个会话输入框工具行显示「会话守护」指示灯。**开关为全局开关**，影响使用同一状态文件的所有会话；不是当前会话的独立开关。
- 指示灯以宿主确认后的结果为准：绿色为开启，灰色为关闭，黄色为读取或保存失败。多个会话共用一次状态轮询。
- 「设置 → 会话守护」提供续跑策略、数值、备用模型、熔断与恢复、运行状态。修改普通设置后需要点击「保存设置」；总开关单独即时保存。
- 备用模型为两级下拉：先选供应商，再选模型。合并宿主声明、已激活供应商及模型配置中的模型；只有可列出模型的供应商进入选择清单。暂不可枚举的已保存标识仍保留显示，目录读取失败可以重试。
- 「重新读取」会回填已保存的设置。保存或读取期间又输入的新内容会保留为未保存草稿，并给出提示。

## 熔断与探活

模型级与供应商级熔断共同决定路由。启用探活时，冷却到期只允许尝试探测，不直接判定模型已经恢复；探测须有非空内容并以正常或输出截断结束。供应商冷却不会因单个模型提前成功而缩短。

探活发送一个 `ping`，**使用真实模型请求，可能计费**。单路由共用一个探活任务，最小重试间隔为一秒，单次等待受 `probeTimeoutMs` 限制。总开关、探活开关关闭或插件销毁时，会取消定时任务并向在途请求发送取消信号，不采纳迟到结果。底层供应商是否立即停止处理取决于适配器对取消信号的支持。

探活由相关会话共同持有；最后一个相关会话停止、销毁或有新输入时取消该路由的探活。一个会话停止不会中断其他会话仍需要的共享探测。探活成功后解除隔离，主路由恢复选择在后续步骤生效。

## 配置

初始插件配置与 `$DSH_HOME/turn-continue.json` 的保存值合并，后者优先。未设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。同一 `DSH_HOME` 共用状态文件，当前没有按 profile 单独隔离。

保存采用同目录临时文件写完再替换；替换失败保留旧文件并向界面报告错误。已有状态文件损坏或不可读时暂停自动操作；首次安装文件不存在时使用默认值。配置字段校验类型与数值范围，重复备用路由按原顺序去重，最多保留八条。

| 字段 | 默认 | 含义或范围 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `steerText` | `继续` | 补发内容，最多 200 字符 |
| `maxContinuePerTurn` | `3` | 每轮上限，0–20 |
| `maxContinuePerSession` | `30` | 每会话十分钟上限，0–500 |
| `continueOnEmptyTurn` | `true` | 空回合续跑 |
| `continueOnMaxTokens` | `true` | 单次输出截断后续跑 |
| `continueOnModelError` | `true` | 指定模型错误终止后续跑 |
| `continueOnAbort` | `false` | 用户主动中断后是否续跑 |
| `minReasoningChars` | `40` | 空回合思考字符门槛，少于此值不补；0–4000 |
| `continueCooldownMs` | `1200` | 补发前等待毫秒数，0–60000 |
| `notifyContinue` | `false` | 在会话中追加续跑说明 |
| `fallbacks` | `[]` | `[{provider, model}]`，按顺序选择，最多八条 |
| `tripCodes` | 见下文 | 可记入熔断并触发终止恢复的错误码 |
| `modelCircuitThreshold` | `2` | 请求失败计数阈值，1–20；终止恢复直接隔离失败模型 |
| `modelCooldownMs` | `60000` | 模型冷却毫秒数，0–3600000 |
| `platformCircuitThreshold` | `2` | 供应商内熔断模型数量阈值，1–50 |
| `platformCooldownMs` | `120000` | 供应商冷却毫秒数，0–3600000 |
| `burstWindowMs` | `300000` | 请求失败计数窗口，1–3600000 |
| `enableProbe` | `true` | 冷却后探活；关闭时改为按冷却时间恢复 |
| `probeMaxTokens` | `8` | 探活输出上限，1–64 |
| `probeTimeoutMs` | `20000` | 探活等待超时毫秒数，1000–120000 |
| `stripReasoningEffort` | `true` | 切换模型时不继承原推理强度 |
| `notifySwitch` | `true` | 在会话中追加切换说明 |

默认 `tripCodes`：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`QUOTA`、`EMPTY_RESPONSE`。认证、权限、参数错误等未命中错误码不自动续跑。

## 宿主接口与事件

通过宿主统一鉴权，拒绝跨站请求：

- `GET|POST /api/dsh-turn-continue/state`：读取状态；POST `{enabled}` 切换开关。
- `GET|POST /api/dsh-turn-continue/settings`：读取状态；POST `{settings?, fallbacks?, enabled?}` 保存设置。
- `GET /api/dsh-turn-continue/models`：返回 `{ok, providers:[{provider,name,sources,models:[{id,name,sources}]}]}`；`?provider=<id>` 返回指定组。模型目录用于选择，不代表该模型的认证或服务已经实测可用。

事件：`turn-continue/fallback` `{from,to,agentId}`、`turn-continue/circuit-opened` `{provider,model,level}`、`turn-continue/probe` `{provider,model,ok,message?}`。

## 安装

```powershell
dsh plugin --profile <profile> add https://github.com/lmmcsb/dsh-turn-continue/releases/latest/download/dsh-turn-continue.tgz
```

也可以直接从仓库源码装（无需构建，无需 `allowBuilds` 授权）：

```powershell
dsh plugin --profile <profile> add github:lmmcsb/dsh-turn-continue
```

把 `<profile>` 换成你的 profile 名（桌面端是 `desktop`）。装完**需要重启一次 DSH 桌面 App**：桌面端在 host 进程启动那一刻把注入清单快照下来，新装的客户端插件要重启才进页面。

Install from a prebuilt tarball (no build step, no `allowBuilds` approval) with the command above, or from source with `github:lmmcsb/dsh-turn-continue`. Restart the DSH desktop app once afterwards so the client half is injected.

## 兼容边界

本插件使用宿主的 Agent 生命周期、`agents`、`llm`、Webserver 及 Client Slots 接口。`agent/pre-step` 的模型选择已经被捕获；此时 `agent.model.select()` 只影响下一个尚未准备的步骤。本插件在错误回合终止后选择备用，再提交下一轮，不能宣称改写已经冻结的请求或当前重试。

与 `dsh-model-failover` 同时启用会争用模型路由，应只启用一个。与 `@nlflora/dsh-empty-turn-guard` 同时处理空回合会重复补发，应关闭其中一个空回合处理入口。安装、停用或卸载其他插件需要单独操作，本插件不会代为修改。

## 开发验证

要求能运行内置 `node:test` 的 Node.js；使用当前宿主随附的 Node 版本验证。没有新增生产依赖。

```sh
npm test
node --check lib/index.js
node --check lib/client.js
node --check lib/circuit.js
node --check lib/schema.js
```

测试使用临时 `DSH_HOME`、模拟 Agent/事件/时钟及 Client Hook 环境，覆盖停止与开关取消、去重预算、失败路由归因、探活所有权/超时/冷却、设置存储/校验及前端读写竞态。它们不发送真实模型请求，不等同于付费供应商故障演练或浏览器视觉验收。
