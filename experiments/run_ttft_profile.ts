import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = Bun.fileURLToPath(new URL("..", import.meta.url))
const pkg = path.join(root, "packages", "opencode")
const out = path.join(root, "experiments", "output")

const models = ["local/MiniMax-M2.5", "local/GLM-5", "local/GLM-4.5-Air"]
const targets = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000]
const repeat = 10

function run(model: string) {
  const proc = spawnSync(
    "bun",
    [
      "run",
      "script/ttft-experiment.ts",
      "--mode",
      "profiling",
      "--model",
      model,
      "--repeat",
      String(repeat),
      "--json",
      ...targets.map(String),
    ],
    {
      cwd: pkg,
      encoding: "utf8",
      env: process.env,
    },
  )

  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || `experiment failed for ${model}`)
  }

  return JSON.parse(proc.stdout) as {
    target_input_tokens: number
    repeated_lines: number
    mode: string
    run: number
    ok: boolean
    input_tokens?: number
    ttft_ms?: number
    decode_ms?: number
    cache_hit_pct?: number
    error?: unknown
    status?: number
    stderr?: string
  }[]
}

function mean(vals: number[]) {
  if (!vals.length) return ""
  return (vals.reduce((sum, item) => sum + item, 0) / vals.length).toFixed(2)
}

mkdirSync(out, { recursive: true })

const raw: Record<string, unknown> = {}
const rows: Record<string, string | number>[] = []

for (const model of models) {
  const data = run(model)
  raw[model] = data

  for (const target of targets) {
    const items = data.filter((item) => item.target_input_tokens === target)
    const ok = items.filter((item) => item.ok)
    rows.push({
      model,
      target_input_tokens: target,
      repeat,
      success_count: ok.length,
      failure_count: items.length - ok.length,
      avg_input_tokens: mean(ok.flatMap((item) => (typeof item.input_tokens === "number" ? [item.input_tokens] : []))),
      avg_ttft_ms: mean(ok.flatMap((item) => (typeof item.ttft_ms === "number" ? [item.ttft_ms] : []))),
      avg_decode_ms: mean(ok.flatMap((item) => (typeof item.decode_ms === "number" ? [item.decode_ms] : []))),
      avg_cache_hit_pct: mean(
        ok.flatMap((item) => (typeof item.cache_hit_pct === "number" ? [item.cache_hit_pct] : [])),
      ),
    })
  }
}

const cols = [
  "model",
  "target_input_tokens",
  "repeat",
  "success_count",
  "failure_count",
  "avg_input_tokens",
  "avg_ttft_ms",
  "avg_decode_ms",
  "avg_cache_hit_pct",
] as const

const csv = [
  cols.join(","),
  ...rows.map((row) => cols.map((col) => JSON.stringify(row[col] ?? "")).join(",")),
].join("\n")

const csvPath = path.join(out, "ttft_profile_summary.csv")
const rawPath = path.join(out, "ttft_profile_raw.json")

writeFileSync(csvPath, csv)
writeFileSync(rawPath, JSON.stringify(raw, null, 2))

const head = `| ${cols.join(" | ")} |`
const sep = `| ${cols.map(() => "---").join(" | ")} |`
const body = rows.map((row) => `| ${cols.map((col) => String(row[col] ?? "")).join(" | ")} |`).join("\n")

console.log(head)
console.log(sep)
console.log(body)
console.log("")
console.log(`CSV: ${csvPath}`)
console.log(`RAW: ${rawPath}`)
