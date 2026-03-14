import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionProcessor } from "../../src/session/processor"
import { LLM } from "../../src/session/llm"
import { Snapshot } from "../../src/snapshot"
import { SessionSummary } from "../../src/session/summary"
import { SessionCompaction } from "../../src/session/compaction"
import { Provider as ProviderNs } from "../../src/provider/provider"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { SessionStatus } from "../../src/session/status"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

afterEach(() => {
  mock.restore()
})

describe("session.started event", () => {
  test("should emit session.started event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: Session.Info | undefined

        const unsub = Bus.subscribe(Session.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as Session.Info
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(session.id)
        expect(receivedInfo?.projectID).toBe(session.projectID)
        expect(receivedInfo?.directory).toBe(session.directory)
        expect(receivedInfo?.title).toBe(session.title)

        await Session.remove(session.id)
      },
    })
  })

  test("session.started event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubStarted = Bus.subscribe(Session.Event.Created, () => {
          events.push("started")
        })

        const unsubUpdated = Bus.subscribe(Session.Event.Updated, () => {
          events.push("updated")
        })

        const session = await Session.create({})

        await new Promise((resolve) => setTimeout(resolve, 100))

        unsubStarted()
        unsubUpdated()

        expect(events).toContain("started")
        expect(events).toContain("updated")
        expect(events.indexOf("started")).toBeLessThan(events.indexOf("updated"))

        await Session.remove(session.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const messageID = MessageID.ascending()
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: session.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await Session.updatePart(partInput)

          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await Session.remove(session.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("step-finish timing", () => {
  const model = {
    id: ModelID.make("test-model"),
    providerID: ProviderID.make("test"),
    api: {
      npm: "@ai-sdk/openai",
    },
    cost: {},
  } as any

  const agent = {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }

  const cases = [
    {
      name: "tracks short input and output timing",
      input: 120,
      output: 24,
      deltas: ["short ", "answer"],
      now: [1010, 1100, 1150, 1160, 1161, 1170],
      request: 1000,
      ttft: 100,
      decode: 50,
      chunks: 2,
    },
    {
      name: "tracks long input and output timing",
      input: 6400,
      output: 960,
      deltas: ["long ", "stream ", "with ", "many tokens"],
      now: [2010, 2400, 2600, 3100, 3600, 3610, 3611, 3620],
      request: 2000,
      ttft: 400,
      decode: 1200,
      chunks: 4,
    },
  ] as const

  for (const item of cases) {
    test(item.name, async () => {
      const sessionID = SessionID.make("ses_test")
      const userID = MessageID.ascending()
      const assistantID = MessageID.ascending()
      const parts: MessageV2.Part[] = []

      const assistant = {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 2 },
        parentID: userID,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test"),
        mode: "primary",
        agent: "build",
        path: {
          cwd: projectRoot,
          root: projectRoot,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      } as MessageV2.Assistant

      let pid = 0
      spyOn(PartID, "ascending").mockImplementation(() => PartID.make(`part_${++pid}`))
      spyOn(Config as any, "get").mockResolvedValue({ experimental: {} })
      spyOn(SessionStatus, "set").mockImplementation(() => {})
      spyOn(Session as any, "updateMessage").mockImplementation(async (msg: any) => msg)
      spyOn(Session as any, "updatePart").mockImplementation(async (part: any) => {
        const next = structuredClone(part) as MessageV2.Part
        const idx = parts.findIndex((item) => item.id === next.id)
        if (idx >= 0) parts[idx] = next
        else parts.push(next)
        return next
      })
      spyOn(Session as any, "updatePartDelta").mockImplementation(async (input: any) => {
        const match = parts.find((part) => part.id === input.partID)
        if (match?.type === "text" || match?.type === "reasoning") {
          match.text += input.delta
        }
      })
      spyOn(MessageV2 as any, "parts").mockImplementation(async (messageID: MessageID) =>
        parts.filter((part) => part.messageID === messageID),
      )
      spyOn(Snapshot, "track").mockResolvedValue(undefined)
      spyOn(Snapshot, "patch").mockResolvedValue({ hash: "hash", files: [] })
      spyOn(SessionSummary, "summarize").mockResolvedValue(undefined as never)
      spyOn(SessionCompaction, "isOverflow").mockResolvedValue(false)
      spyOn(ProviderNs, "takeTiming").mockReturnValue(undefined)
      spyOn(ProviderNs, "dropTiming").mockImplementation(() => {})
      spyOn(Plugin, "trigger").mockImplementation(async (_name, _input, output) => output as any)

      const vals = [...item.now]
      const last = vals[vals.length - 1]
      spyOn(Date, "now").mockImplementation(() => vals.shift() ?? last)

      spyOn(LLM, "stream").mockResolvedValue({
        request: {
          id: "req-" + item.name,
          start: item.request,
        },
        fullStream: (async function* () {
          yield { type: "start" }
          yield { type: "start-step" }
          yield { type: "text-start" }
          for (const text of item.deltas) {
            yield { type: "text-delta", text }
          }
          yield {
            type: "text-end",
          }
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: {
              inputTokens: item.input,
              outputTokens: item.output,
              reasoningTokens: 0,
              totalTokens: item.input + item.output,
            },
          }
          yield { type: "finish" }
        })(),
      } as Awaited<ReturnType<typeof LLM.stream>>)

      const proc = SessionProcessor.create({
        assistantMessage: assistant,
        sessionID,
        model,
        abort: new AbortController().signal,
      })

      const result = await proc.process({
        user: {
          id: userID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: {
            providerID: ProviderID.make("test"),
            modelID: ModelID.make("test-model"),
          },
        },
        sessionID,
        model,
        agent: agent as any,
        system: [],
        abort: new AbortController().signal,
        messages: [],
        tools: {},
      })

      const finish = parts.find((part): part is MessageV2.StepFinishPart => part.type === "step-finish")

      expect(result).toBe("continue")
      expect(finish).toBeDefined()
      expect(finish?.tokens.input).toBe(item.input)
      expect(finish?.tokens.output).toBe(item.output)
      expect(finish?.timing?.any?.ttft).toBe(item.ttft)
      expect(finish?.timing?.any?.decode).toBe(item.decode)
      expect(finish?.timing?.any?.chunks).toBe(item.chunks)
      expect(finish?.timing?.text?.ttft).toBe(item.ttft)
      expect(finish?.timing?.text?.decode).toBe(item.decode)
      expect(finish?.timing?.text?.chunks).toBe(item.chunks)
    })
  }
})
