# Agent Note: Retry saturated providers and pin the summarization route

Status: implemented

English | [中文](2026-09-20-saturated-provider-retry-and-pinned-summary-route.zh.md)

## Problem

Two independent defects left a long session unrecoverable when its operator switched from a 1M-token route to a 272k-token route mid-conversation. Both surfaced in the durable log as `CONTEXT_WINDOW_EXCEEDED`, so the operator read them as one capacity problem.

The ChatGPT/Codex backend sheds load with a sentence that carries no HTTP status, no `429`, and no transport word: `Codex error: Our servers are currently overloaded. Please try again later.` `classifyPiAiError` matched none of its patterns and returned the terminal `PI_AI_ERROR` fallback, which no default retry policy accepts. The failure was therefore terminal, and the operator retried by hand. A durable-log survey of the deployment found 21 occurrences of that wording across its sessions against only 6 `llm/retry` records in total, all of them `TRANSPORT`: the wording never produced a single scheduled retry.

Summarization inherited the conversation's own route. `basic-compaction` replays the shadowed region plus the system prompt and every tool schema, then asks the *same* route to condense it. A route whose real capacity is already below the conversation's size cannot summarize the overflow it is meant to resolve: the summary request fails with the same context error, no summary is committed, and `maxOverflowRetries` repeats the failure. In the observed session the conversation reached 370,860 input tokens against a 272,000 window; eight consecutive compaction attempts failed with `pi-ai detected context overflow for model "gpt-6-astra"`, including an explicit `/compact`, and the operator could only recover by switching back to a larger route. The session log shows no committed summary between the first overflow and that switch, which is what makes the loop unbounded in practice rather than merely expensive.

## Decision

### Saturation wording classifies as a retryable server failure

`classifyPiAiError` maps load-shedding and per-model capacity wording to `SERVER`, the existing transient code the default retry policy already accepts:

```
/\b(?:overloaded|at\s+capacity|temporarily\s+unavailable|service\s+unavailable)\b/i
```

The test sits after the context-overflow, quota, rate-limit, and rejected-body tests and before the generic 5xx and timeout tests. Context overflow therefore still wins when a gateway decorates an overflow response with saturation wording, and the wording never has to be attributed to a status code it did not carry. The classification covers the observed sentence, the backend's `Selected model is at capacity.` variant, and the `503`/`service unavailable` idioms that reach the adapter as text.

This broadens classification *within* an existing code rather than adding a code, so the transient-code taxonomy and its policy consequences are unchanged: `SERVER` remains retryable under the default normal policy with the same bounded backoff, and an operator who wants saturation treated differently still configures `retryPolicy.retryableCodes` on the provider profile. The [bounded-recovery decision](../architecture/2026-06-21-bounded-llm-request-recovery.md) now records the wording as one of that code's adapter mappings.

### Summarization is pinned to the DeepSeek route

Every shipped preset that compacts now sets `summarizationProvider: deepseek-official` and `summarizationModel: deepseek-flash` on its `compaction-basic` row. A summary request reuses the conversation's system prompt, tools, and shadowed messages, so it needs strictly more headroom than the conversation that overflowed. DeepSeek's 1M-token route supplies that headroom independently of whichever route the conversation itself uses, which removes the deadlock: compaction can resolve an overflow that happened on a smaller provider.

The pair is set at the preset composition rather than as a plugin default. `summarizationProvider`/`summarizationModel` keep their documented empty default — an omitted pair still means "the latest routed target, then `AgentOptions`" — so `dsh-compaction-basic` stays deployment-neutral and a deployment that names no DeepSeek route fails loudly at the summary call with the existing actionable error instead of silently inheriting a route that cannot summarize. The comment beside each row states that both fields must be replaced together for a different summarization route.

The `standard` and `cordis` presets and the `ptc` preset carry the same two fields; the `minimal` preset mounts no compaction row.

## Testing

`packages/llm/llm-pi-ai/tests/convert.spec.ts` pins the saturation classification as a table of provider wordings and pins overflow precedence over saturation wording. `packages/preset/agent-presets/tests/` covers shipped-root discovery, composition inventory, and mount health for the edited presets.

## Alternatives considered

- **Add `PI_AI_ERROR` to the default retryable codes.** Rejected because it makes every unclassified pi-ai failure retryable, including the genuinely terminal ones the fallback exists to name. Classifying the wording keeps the taxonomy's distinction between transient and terminal.
- **Add a dedicated `OVERLOADED` code.** Rejected as a second vocabulary entry with no consumer that behaves differently from `SERVER`; the policy decision the operator needs is "retry this", which `SERVER` already owns.
- **Default the summarization target inside `dsh-compaction-basic`.** Rejected because a deployment-neutral plugin must not name one deployment's provider by default; the shipped preset is where this deployment's choice belongs.
- **Lower `thresholdRatio` for the small route instead of pinning the summarizer.** Rejected as the primary fix: a lower threshold makes the deadlock less likely but not impossible, because the summarizer still replays a prefix the same route must fit. The two are complementary, and a per-model threshold override remains available.
- **Retry the summary with the fallback route only after the inherited route fails.** Rejected for the moment as a larger change to the region transaction; pinning the route removes the failure mode without a second summarization policy, and an explicit pair is also easier for an operator to reason about than an invisible fallback.

## Consequences

A saturated provider now costs bounded wait instead of a terminal turn, and the retry appears durably as `llm/retry` with its code, delay, and policy key. The cost is that saturation wording stays a text pattern: a provider that invents new wording during an incident is still terminal until its wording is added, which is the same adapter-maintained classification risk the recovery boundary already carries for context overflow.

Compaction can now resolve an overflow on any route, because the summarizer is no longer constrained by that route's capacity. The cost is that summarization leaves the conversation's provider: its KV-cache prefix is no longer reused, so each summary pays full input price on the summarization route, and a deployment without a `deepseek-official` route configured fails its summary call rather than inheriting one. The observed session's summaries cost between 80k and 162k input tokens each, so the extra spend is bounded by conversation size rather than by compaction count.

Pinning does not remove the underlying pressure-policy limitation that made the switch dangerous: the token meter's character heuristic still underprices CJK text and JSON, so a route change into a smaller window can still cross the limit before pressure triggers. The classifier fix bounds the resulting retry, and the pinned summarizer repairs the overflow, but the pressure trigger remains approximate.
