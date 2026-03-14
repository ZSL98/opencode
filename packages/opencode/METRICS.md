# Metrics

`opencode` writes local request and tool timing logs to `metrics.log` under the runtime log directory.

The built-in metrics plugin lives in [src/plugin/metrics.ts](/Users/zhangshulai/Desktop/code_repo/opencode/packages/opencode/src/plugin/metrics.ts). Request timing is produced in [src/session/processor.ts](/Users/zhangshulai/Desktop/code_repo/opencode/packages/opencode/src/session/processor.ts) and [src/provider/provider.ts](/Users/zhangshulai/Desktop/code_repo/opencode/packages/opencode/src/provider/provider.ts).

## Log Records

The plugin currently writes two LLM-related records and one tool-related record:

- `llm_step`: one record per completed LLM step
- `request_timing`: one record per completed LLM step with timing breakdowns
- `tool_call`: one record per completed or failed tool call

Each line is plain text with `key=value` fields.

## Scope

Metrics are scoped to a single LLM step, not to the entire conversation.

A single user turn may produce multiple LLM steps, for example:

- the model replies directly in one step
- the model calls a tool, then resumes in a second step
- the model loops through several tool calls before finishing

In those cases, `llm_step` and `request_timing` are emitted once per step. This is the intended behavior.

## Core Timing Model

There are three different timing layers:

1. `llm_step_ms`
   The wall-clock duration of the step from `step-start` to `step-finish`.

2. Stream timing
   Timing derived from streamed model output events inside the step.

3. HTTP timing
   Timing derived from the provider fetch/SSE layer for the same request.

`llm_step_ms` is the outer envelope for the step. The stream and HTTP metrics are breakdowns of parts of that step. They do not necessarily sum exactly to `llm_step_ms` because the step may also include framework overhead, event handling, buffering, persistence, or provider-specific behavior outside streamed token delivery.

## `llm_step` Fields

`llm_step` contains step-level duration and token/cost counters:

- `sessionID`: session id
- `messageID`: assistant message id for the step
- `llm_step_ms`: wall-clock step duration from `step-start` to `step-finish`
- `tokens_input`: input tokens billed or reported for the step
- `tokens_output`: output text tokens reported for the step
- `tokens_reasoning`: reasoning tokens reported for the step
- `tokens_total`: total tokens if the provider reports them
- `cache_read`: cache hit tokens reported for the step
- `cache_write`: cache write tokens reported for the step
- `cache_hit_rate_pct`: derived cache hit ratio using `cache_read / (tokens_input + cache_read + cache_write)`
- `cost_usd`: reported step cost in USD

## `request_timing` Fields

`request_timing` contains the same `sessionID`, `messageID`, and `llm_step_ms`, plus timing breakdown fields.

### Stream Timing

Two stream timing scopes are recorded:

- `any`
  Counts the first and last streamed output of either `reasoning-delta` or `text-delta`.

- `text`
  Counts only `text-delta`, which corresponds to user-visible answer text.

This distinction matters because some providers or models emit reasoning before visible text. If reasoning starts early, `any` timing will show a shorter prefill than `text` timing.

### `any` Timing Fields

- `ttft_any_ms`
  Time from request start to the first streamed output of either reasoning or text.

- `decode_any_ms`
  Time from the first streamed output of either reasoning or text to the last streamed output of either reasoning or text.

- `output_any_chunks`
  Count of streamed output chunks across both reasoning and text.

This scope answers: "How long until the model started emitting anything at all?"

### `text` Timing Fields

- `ttft_text_ms`
  Time from request start to the first `text-delta`.

- `decode_text_ms`
  Time from the first `text-delta` to the last `text-delta`.

- `output_text_chunks`
  Count of `text-delta` chunks.

- `tokens_per_sec_text`
  Derived throughput using `tokens_output / (decode_text_ms / 1000)` when both values are available.

This scope answers: "How long until user-visible answer text began, and how long did visible text take to stream?"

### HTTP Timing Fields

HTTP timing is request-scoped and independent of `any` vs `text`.

- `http_wait_ms`
  Time from fetch start until HTTP response headers arrive.

- `http_ttfb_ms`
  Time from fetch start until the first SSE chunk is read.

- `http_stream_ms`
  Time from the first SSE chunk until the last SSE chunk or stream close.

- `http_chunks`
  Number of SSE chunks read from the provider response body.

These values come from the provider transport layer, not from message-part updates.

## Request Start

All request timing metrics use the start time of a single `LLM.stream()` call as the request start.

This is important for multi-step conversations:

- each step gets its own request start
- later steps do not inherit time from earlier steps
- prefill is measured per request, not per assistant message

## Important Differences Between `llm_step_ms`, `ttft`, and `decode`

`llm_step_ms` is the broadest timing. It includes the whole step lifecycle as observed by session processing.

`ttft_any_ms` and `ttft_text_ms` are narrower:

- they begin at request start
- they end at the first streamed output
- they do not include all possible post-processing or persistence work

`decode_any_ms` and `decode_text_ms` are also narrower:

- they measure the stream output phase only
- they do not mean "total step duration"
- they may exclude overhead before first chunk and after last chunk

As a result:

- `llm_step_ms` is usually greater than either decode metric
- `ttft_text_ms` can be greater than `ttft_any_ms`
- `decode_text_ms` can be smaller than `decode_any_ms`

## How To Interpret Reasoning vs Text

Use `any` timing when you want model activity timing.

Examples:

- provider responsiveness
- time until the model starts emitting any output
- performance analysis that should include reasoning streams

Use `text` timing when you want user-visible answer timing.

Examples:

- perceived latency in chat UX
- time until the first visible answer token
- visible answer streaming speed

If a model does not emit reasoning separately:

- `ttft_any_ms` and `ttft_text_ms` will often be the same or very close
- `decode_any_ms` and `decode_text_ms` will often be the same or very close

If a model emits reasoning before visible text:

- `ttft_any_ms` will usually be smaller than `ttft_text_ms`
- `decode_any_ms` will usually be larger than `decode_text_ms`

## Missing Values

Some fields may be absent:

- no visible text was emitted before stop or error
- the provider did not use SSE for the response
- the request failed before the first chunk
- the stream ended before a complete timing pair was available

A missing value means "not observed" rather than zero.

## Error and Retry Behavior

Timing entries are cleaned up when a request errors or exits without a completed step.

This prevents stale timing data from leaking into later requests. It also means failed or aborted requests may not emit a `request_timing` record if the step never reaches `step-finish`.

## Practical Guidance

For latency monitoring:

- use `llm_step_ms` for overall step duration
- use `ttft_text_ms` for user-visible prefill
- use `decode_text_ms` for user-visible streaming duration

For provider transport debugging:

- compare `http_wait_ms` vs `http_ttfb_ms`
- compare `ttft_any_ms` vs `ttft_text_ms`
- inspect `http_chunks`, `output_any_chunks`, and `output_text_chunks`

For models with exposed reasoning:

- treat `any` as model-output timing
- treat `text` as answer-output timing
