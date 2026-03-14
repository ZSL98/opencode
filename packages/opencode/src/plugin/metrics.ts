import type { Plugin as PluginInstance } from "@opencode-ai/plugin"
import { createWriteStream, type WriteStream } from "fs"
import fs from "fs/promises"
import path from "path"
import { Global } from "@/global"

let stream: WriteStream | undefined

async function initStream() {
  if (stream) return
  await fs.mkdir(Global.Path.log, { recursive: true })
  stream = createWriteStream(path.join(Global.Path.log, "metrics.log"), { flags: "a" })
}

function write(level: string, message: string, extra?: Record<string, any>) {
  const prefix = extra
    ? Object.entries(extra)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" ")
    : ""
  const line = [new Date().toISOString().split(".")[0], level, prefix, message].filter(Boolean).join(" ") + "\n"
  stream?.write(line)
}

const log = {
  info: (message: string, extra?: Record<string, any>) => write("INFO ", message, extra),
}

// Per-session state for tracking in-flight metrics
type SessionState = {
  // Per step start times keyed by messageID
  stepStarts: Record<string, number>
  // Per tool-call start times keyed by callID
  toolStarts: Record<string, number>
}

export const MetricsPlugin: PluginInstance = async (_input) => {
  await initStream()
  const sessions: Record<string, SessionState> = {}

  function ensure(sessionID: string): SessionState {
    if (!sessions[sessionID]) {
      sessions[sessionID] = { stepStarts: {}, toolStarts: {} }
    }
    return sessions[sessionID]
  }

  return {
    async event({ event }) {
      const { type, properties } = event as { type: string; properties: any }

      if (type === "session.status") {
        const { sessionID, status } = properties as { sessionID: string; status: { type: string } }
        if (status.type === "idle") {
          delete sessions[sessionID]
        }
        return
      }

      // Track tool call start time
      if (type === "message.part.updated") {
        const part = properties.part as {
          type: string
          sessionID: string
          callID?: string
          state?: { status: string; time?: { start: number } }
        }

        if (part.type === "tool" && part.state?.status === "running" && part.callID) {
          ensure(part.sessionID).toolStarts[part.callID] = part.state.time?.start ?? Date.now()
          return
        }

        if (part.type === "step-start" && "messageID" in part && typeof part.messageID === "string") {
          ensure(part.sessionID).stepStarts[part.messageID] = Date.now()
          return
        }

        if (
          part.type === "tool" &&
          (part.state?.status === "completed" || part.state?.status === "error") &&
          part.callID
        ) {
          const s = sessions[part.sessionID]
          const start = s?.toolStarts[part.callID]
          if (start !== undefined) {
            const tool = (part as any).tool as string
            const end = (part.state as any)?.time?.end ?? Date.now()
            const ms = end - start
            log.info("tool_call", { tool, callID: part.callID, duration_ms: ms })
            delete s.toolStarts[part.callID]
          }
          return
        }

        // LLM step finished: log step duration + token/cache metrics + per-request timing
        if (part.type === "step-finish") {
          const step = part as unknown as {
            type: "step-finish"
            sessionID: string
            messageID: string
            tokens: {
              input: number
              output: number
              reasoning: number
              total?: number
              cache: { read: number; write: number }
            }
            cost: number
            timing?: {
              any?: {
                ttft?: number
                decode?: number
                chunks?: number
              }
              text?: {
                ttft?: number
                decode?: number
                chunks?: number
              }
              http?: {
                wait?: number
                ttfb?: number
                stream?: number
                chunks?: number
              }
            }
          }

          const s = sessions[step.sessionID]
          const start = s?.stepStarts[step.messageID]
          const llmMs = start !== undefined ? Date.now() - start : undefined
          if (s) delete s.stepStarts[step.messageID]

          const { input, output, reasoning, cache, total } = step.tokens
          const cacheHitRate =
            input + cache.read + cache.write > 0
              ? ((cache.read / (input + cache.read + cache.write)) * 100).toFixed(1)
              : null

          log.info("llm_step", {
            sessionID: step.sessionID,
            messageID: step.messageID,
            llm_step_ms: llmMs,
            tokens_input: input,
            tokens_output: output,
            tokens_reasoning: reasoning,
            tokens_total: total,
            cache_read: cache.read,
            cache_write: cache.write,
            cache_hit_rate_pct: cacheHitRate !== null ? `${cacheHitRate}%` : "n/a",
            cost_usd: step.cost.toFixed(6),
          })

          // Log per-request timing breakdown if available
          if (step.timing) {
            const t = step.timing
            log.info("request_timing", {
              sessionID: step.sessionID,
              messageID: step.messageID,
              llm_step_ms: llmMs,
              ttft_any_ms: t.any?.ttft,
              decode_any_ms: t.any?.decode,
              output_any_chunks: t.any?.chunks,
              ttft_text_ms: t.text?.ttft,
              decode_text_ms: t.text?.decode,
              output_text_chunks: t.text?.chunks,
              tokens_per_sec_text:
                t.text?.decode && output > 0 ? (output / (t.text.decode / 1000)).toFixed(1) : undefined,
              http_wait_ms: t.http?.wait,
              http_ttfb_ms: t.http?.ttfb,
              http_stream_ms: t.http?.stream,
              http_chunks: t.http?.chunks,
            })
          }
        }
      }
    },

    "tool.execute.before": async (input, _output) => {
      ensure(input.sessionID).toolStarts[input.callID] = Date.now()
    },

    "tool.execute.after": async (input, output) => {
      const s = sessions[input.sessionID]
      const start = s?.toolStarts[input.callID]
      if (start !== undefined) {
        const ms = Date.now() - start
        log.info("tool_call", {
          tool: input.tool,
          callID: input.callID,
          duration_ms: ms,
          title: output.title,
        })
        // Don't delete here — the part.updated event path may also fire; whichever
        // runs first will log and the second check will find no start time.
        delete s.toolStarts[input.callID]
      }
    },
  }
}
