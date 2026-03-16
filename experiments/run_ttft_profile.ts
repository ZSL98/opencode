import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"

const root = Bun.fileURLToPath(new URL("..", import.meta.url))
const pkg = path.join(root, "packages", "opencode")
const out = path.join(root, "experiments", "output")
const csvPath = path.join(out, "ttft_profile_summary.csv")
const rawPath = path.join(out, "ttft_profile_raw.json")

const models = ["local/MiniMax-M2.5", "local/GLM-5", "local/GLM-4.5-Air"]
const targets = [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000]
const repeat = 3
const total = models.length * targets.length
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

function run(model: string, target: number) {
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
      String(target),
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

function loadRows() {
  if (!existsSync(csvPath)) return []
  const text = readFileSync(csvPath, "utf8").trim()
  if (!text) return []
  const lines = text.split("\n").slice(1).filter(Boolean)
  return lines.map((line) => {
    const vals = line
      .match(/"[^"]*"|[^,]+/g)
      ?.map((item) => item.replace(/^"|"$/g, ""))
    return Object.fromEntries(cols.map((col, i) => [col, vals?.[i] ?? ""])) as Record<string, string | number>
  })
}

function loadRaw() {
  if (!existsSync(rawPath)) return {} as Record<string, unknown>
  return JSON.parse(readFileSync(rawPath, "utf8")) as Record<string, unknown>
}

function save(rows: Record<string, string | number>[], raw: Record<string, unknown>) {
  const csv = [
    cols.join(","),
    ...rows.map((row) => cols.map((col) => JSON.stringify(row[col] ?? "")).join(",")),
  ].join("\n")
  writeFileSync(csvPath, csv)
  writeFileSync(rawPath, JSON.stringify(raw, null, 2))
}

mkdirSync(out, { recursive: true })

const raw = loadRaw()
const rows = loadRows()
const done = new Set(rows.map((row) => `${row.model}:${row.target_input_tokens}`))

for (const model of models) {
  for (const target of targets) {
    const key = `${model}:${target}`
    if (done.has(key)) {
      console.log(`[skip] model=${model} target=${target}`)
      continue
    }
    console.log(`[start] model=${model} target=${target} repeat=${repeat}`)
    const data = run(model, target)
    raw[key] = data
    const items = data.filter((item) => item.target_input_tokens === target)
    const ok = items.filter((item) => item.ok)
    const row = {
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
    }
    rows.push(row)
    done.add(key)
    save(rows, raw)
    console.log(
      `[done ${rows.length}/${total}] model=${model} target=${target} success=${row.success_count}/${repeat} failure=${row.failure_count}/${repeat} avg_input_tokens=${row.avg_input_tokens || "n/a"} avg_ttft_ms=${row.avg_ttft_ms || "n/a"} avg_decode_ms=${row.avg_decode_ms || "n/a"} avg_cache_hit_pct=${row.avg_cache_hit_pct || "n/a"}`,
    )
  }
}

const head = `| ${cols.join(" | ")} |`
const sep = `| ${cols.map(() => "---").join(" | ")} |`
const body = rows.map((row) => `| ${cols.map((col) => String(row[col] ?? "")).join(" | ")} |`).join("\n")

console.log(head)
console.log(sep)
console.log(body)
console.log("")
console.log(`CSV: ${csvPath}`)
console.log(`RAW: ${rawPath}`)
