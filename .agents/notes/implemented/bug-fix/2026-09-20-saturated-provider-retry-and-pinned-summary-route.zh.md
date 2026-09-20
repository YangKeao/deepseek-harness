# Agent Note: 重试已饱和的提供方并固定摘要路由

Status: implemented

[English](2026-09-20-saturated-provider-retry-and-pinned-summary-route.md) | 中文

## 问题

当操作者在会话中途从 100 万 token 的路由切到 27.2 万 token 的路由时，两个彼此独立的缺陷让这个长会话变得无法恢复。两者在持久日志里都以 `CONTEXT_WINDOW_EXCEEDED` 出现，因此操作者把它们读成了同一个容量问题。

ChatGPT/Codex 后端用一句既没有 HTTP 状态码、也没有 `429`、也没有传输层措辞的话来卸载负载：`Codex error: Our servers are currently overloaded. Please try again later.`。`classifyPiAiError` 的任何模式都没有匹配到它，于是返回了终态的 `PI_AI_ERROR`，而没有任何默认重试策略接受这个 code。失败因此是终态的，操作者只能手动重试。对该部署持久日志的普查发现：这句话在多个会话中共出现 21 次，而全部会话里只有 6 条 `llm/retry` 记录，且全部是 `TRANSPORT`——这句措辞从未产生过一次被排定的重试。

摘要在原先的实现里继承会话自身的路由。`basic-compaction` 会重放被遮蔽区间、加上系统提示词和全部工具 schema，然后请**同一条**路由去压缩它。当某条路由的真实容量已经低于会话大小时，它无法摘要那个必须由自己来解决的溢出：摘要请求以同样的上下文错误失败，没有任何摘要被提交，而 `maxOverflowRetries` 会重复这一失败。观测到的会话在 27.2 万窗口下达到了 37.086 万输入 token；连续八次压缩尝试都以 `pi-ai detected context overflow for model "gpt-6-astra"` 失败（包含一次显式 `/compact`），操作者只能靠切回更大的路由才恢复。会话日志显示，从首次溢出到那次切换之间没有任何已提交的摘要，这正是它在实践中变成无界循环、而不只是开销偏高的原因。

## 决策

### 饱和措辞归类为可重试的服务端失败

`classifyPiAiError` 把卸载负载与单模型容量的措辞映射到 `SERVER`，即默认重试策略本就接受的既有暂时性 code：

```
/\b(?:overloaded|at\s+capacity|temporarily\s+unavailable|service\s+unavailable)\b/i
```

该判断位于上下文溢出、配额、限流和请求体被拒的判断之后，位于通用 5xx 与超时判断之前。因此，当网关在溢出响应上附带饱和措辞时，上下文溢出仍然优先；而饱和措辞也不必被归因到它自己并未携带的状态码上。该分类覆盖观测到的那句话、后端 `Selected model is at capacity.` 这种变体，以及以文本形式到达适配器的 `503`/`service unavailable` 惯用说法。

这只是**在既有 code 内部**放宽分类，而不是新增 code，因此暂时性 code 分类及其策略后果保持不变：`SERVER` 在默认 normal 策略下仍以同样的有界退避可重试；希望区别对待饱和的部署，仍可在 provider profile 上配置 `retryPolicy.retryableCodes`。[有界恢复决策](../architecture/2026-06-21-bounded-llm-request-recovery.zh.md)现已把这句措辞记为该 code 的一条适配器映射。

### 摘要被固定到 DeepSeek 路由

每个会压缩的随附 preset 现在都在其 `compaction-basic` 行上设置 `summarizationProvider: deepseek-official` 与 `summarizationModel: deepseek-flash`。摘要请求会复用会话的系统提示词、工具和被遮蔽消息，因此它需要的余量严格多于那个已经溢出的会话。DeepSeek 的 100 万 token 路由独立于会话自身所用路由提供这份余量，从而移除了死锁：压缩现在可以解决发生在更小提供方上的溢出。

这一对字段设置在 preset 组合处，而不是作为插件默认值。`summarizationProvider`/`summarizationModel` 保持其文档化的空默认——省略这一对仍然意味着「最近一次已路由的目标，其次 `AgentOptions`」——因此 `dsh-compaction-basic` 仍与具体部署无关；而未配置任何 DeepSeek 路由的部署会在摘要调用处以既有的可操作错误显式失败，而不是静默继承一条无法完成摘要的路由。每行旁边的注释说明：若要改用其他摘要路由，必须成对替换这两个字段。

`standard` 与 `cordis` preset 以及 `ptc` preset 携带相同的两个字段；`minimal` preset 不挂载压缩行。

## 测试

`packages/llm/llm-pi-ai/tests/convert.spec.ts` 以提供方措辞表固定了饱和分类，并固定了上下文溢出相对饱和措辞的优先级。`packages/preset/agent-presets/tests/` 覆盖了被修改 preset 的随附根发现、组合清单和挂载健康检查。

## 考虑过的替代方案

- **把 `PI_AI_ERROR` 加入默认可重试 code。** 已否决，因为这会让每一种未被分类的 pi-ai 失败都可重试，包括这个兜底 code 存在的意义正是要指名的那些真正终态的失败。对措辞做分类，才能保留分类体系在暂时性与终态之间的区分。
- **新增专用 `OVERLOADED` code。** 已否决，因为这是第二次引入词汇表条目，却没有任何消费方会与 `SERVER` 有不同行为；操作者需要的策略决策是「重试它」，而这由 `SERVER` 负责。
- **在 `dsh-compaction-basic` 内部默认摘要目标。** 已否决，因为一个与部署无关的插件不应默认点名某个部署的提供方；这个部署的选择属于随附 preset。
- **只降低小路由的 `thresholdRatio` 而不固定摘要方。** 已否决作为主要方案：更低的阈值让死锁更不易发生但并非不可能，因为摘要方仍要重放一段必须塞进同一路由的前缀。两者是互补的，且按模型覆盖阈值的能力仍然可用。
- **在继承路由失败后再用备用路由重试摘要。** 暂时否决，因为这是对区间事务的更大改动；固定路由已经消除了该失效模式，且不需要第二套摘要策略；显式字段对操作者来说也比一个隐形的兜底更容易推理。

## 后果

已饱和的提供方现在付出有界的等待，而不是一个终态回合；这次重试会以 `llm/retry` 持久出现，带有其 code、延迟和策略键。代价是饱和措辞仍是一种文本模式：在故障期间发明新措辞的提供方在被加入措辞表之前仍是终态，这与恢复边界对上下文溢出已经承担的分类维护风险相同。

现在压缩可以在任意路由上解决溢出，因为摘要方不再受该路由容量约束。代价是摘要离开了会话的提供方：它的 KV 缓存前缀不再被复用，因此每次摘要都要在摘要路由上支付完整输入价格；而未配置 `deepseek-official` 路由的部署会让摘要调用失败，而不是继承一条路由。观测会话的每次摘要花费 8 万到 16.2 万输入 token，因此额外支出由会话大小而不是压缩次数决定。

固定摘要方并没有消除那个让模型切换变得危险的底层压力策略限制：token 计量的字符启发式仍然低估 CJK 文本与 JSON，因此切换到更小窗口的路由时，仍可能在压力触发之前就越过上限。分类器修复为随之而来的重试设定了边界，固定摘要方修复了溢出，但压力触发点仍然是近似的。
