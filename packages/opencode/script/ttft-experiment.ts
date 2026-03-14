import { spawnSync } from "node:child_process"

const root = new URL("..", import.meta.url)
const base = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu\n"

function args() {
  const vals = process.argv.slice(2)
  const out = {
    model: undefined as string | undefined,
    targets: [] as number[],
    json: false,
  }

  for (let i = 0; i < vals.length; i++) {
    const val = vals[i]
    if (val === "--json") {
      out.json = true
      continue
    }
    if (val === "--model") {
      out.model = vals[++i]
      continue
    }
    out.targets.push(Number(val))
  }

  if (out.targets.length === 0) {
    out.targets = [10_000, 20_000, 50_000, 100_000, 200_000, 500_000]
  }

  return out
}

function make(lines: number) {
  return "Reply with exactly OK. Do not use tools.\n\nContext follows:\n" + base.repeat(lines)
}

function pct(read: number, total: number) {
  if (!total) return 0
  return Number(((read / total) * 100).toFixed(1))
}

function parse(text: string) {
  const rows = text
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const fin = rows.find((row) => row.type === "step_finish")
  if (!fin) {
    const err = rows.find((row) => row.type === "error")
    return {
      ok: false,
      error: err?.error ?? "missing step_finish",
    }
  }

  const total = fin.part.tokens.total ?? 0
  const read = fin.part.tokens.cache.read ?? 0
  return {
    ok: true,
    sessionID: fin.sessionID as string,
    messageID: fin.part.messageID as string,
    input_tokens: fin.part.tokens.input as number,
    output_tokens: fin.part.tokens.output as number,
    total_tokens: total as number,
    cache_read: read as number,
    cache_write: (fin.part.tokens.cache.write ?? 0) as number,
    cache_hit_pct: pct(read, total),
    ttft_ms: fin.part.timing?.text?.ttft as number | undefined,
    decode_ms: fin.part.timing?.text?.decode as number | undefined,
    chunks: fin.part.timing?.text?.chunks as number | undefined,
  }
}

function run(msg: string, model?: string, sessionID?: string) {
  const cmd = [process.execPath, "run", "--conditions=browser", "./src/index.ts", "run", "--format", "json"]
  if (model) cmd.push("--model", model)
  if (sessionID) cmd.push("--session", sessionID)
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd: Bun.fileURLToPath(root),
    input: msg,
    encoding: "utf8",
    env: process.env,
  })
  const out = proc.stdout ?? ""
  const err = proc.stderr ?? ""

  if (proc.status !== 0) {
    return {
      ok: false,
      status: proc.status,
      stderr: err || out,
    }
  }

  return parse(out)
}

function print(rows: Record<string, unknown>[]) {
  const cols = [
    "target_input_tokens",
    "mode",
    "ok",
    "input_tokens",
    "cache_hit_pct",
    "cache_read",
    "ttft_ms",
    "decode_ms",
    "chunks",
    "status",
  ] as const
  const head = cols.join("\t")
  const body = rows.map((row) => cols.map((col) => String(row[col] ?? "")).join("\t")).join("\n")
  console.log(head)
  console.log(body)
}

const input = args()
const rows: Record<string, unknown>[] = []

for (const target of input.targets) {
  const lines = Math.ceil(target / 17)
  const msg = make(lines)
  const cold = run(msg, input.model)
  rows.push({
    target_input_tokens: target,
    repeated_lines: lines,
    mode: "cold",
    ...cold,
  })
  if (!cold.ok || !("sessionID" in cold)) continue

  const warm = run(msg, input.model, cold.sessionID)
  rows.push({
    target_input_tokens: target,
    repeated_lines: lines,
    mode: "warm",
    ...warm,
  })
}

if (!input.json) print(rows)
console.log(JSON.stringify(rows, null, 2))
