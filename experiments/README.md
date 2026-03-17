# OpenCode Server Experiment Guide

This guide explains how to run `opencode` from source on a server, configure the environment, execute TTFT profiling experiments, and generate plots.

## 1. Install Bun

If Bun is not installed yet:

```bash
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version
```

If your server is behind a corporate proxy or custom CA, make sure `bun install` already works before continuing.

## 2. Get the source

```bash
git clone https://github.com/ZSL98/opencode.git
cd opencode
git checkout codex/metrics-request-timing
git pull
```

Install dependencies:

```bash
cd packages/opencode
bun install
cd ../..
```

## 2.1 Optional: create an `opencode` wrapper

If the server does not already have an `opencode` command, create a small wrapper script so you can invoke the source build like a normal CLI.

Create a wrapper in `~/.local/bin`:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/opencode <<'EOF'
#!/usr/bin/env bash
exec bun run --cwd /path/to/opencode/packages/opencode --conditions=browser src/index.ts "$@"
EOF
chmod +x ~/.local/bin/opencode
```

Add it to `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

To make that persistent:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Verify:

```bash
which opencode
opencode --version
```

If you do not want a wrapper, you can always run OpenCode directly from source:

```bash
cd /path/to/opencode/packages/opencode
bun run --conditions=browser src/index.ts run --format json "hello"
```

## 3. Configure OpenCode

Create or update `~/.config/opencode/opencode.json`.

Example for a local OpenAI-compatible backend:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "share": "disabled",
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "local",
      "options": {
        "baseURL": "http://YOUR_HOST:YOUR_PORT",
        "apiKey": "sk-xxx",
        "timeout": 15000,
        "chunkTimeout": 30000
      },
      "models": {
        "MiniMax-M2.5": {
          "name": "MiniMax-M2.5",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "GLM-5": {
          "name": "GLM-5",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        },
        "GLM-4.5-Air": {
          "name": "GLM-4.5-Air",
          "limit": {
            "context": 200000,
            "output": 64000
          }
        }
      }
    }
  }
}
```

## 4. Recommended environment variables

The source build is easier to run on a server if you pin these variables:

```bash
export OPENCODE_MODELS_PATH="$HOME/.cache/opencode/models.json"
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
export OPENCODE_DISABLE_PROJECT_CONFIG=1
```

What they do:

- `OPENCODE_MODELS_PATH`: points OpenCode to a local `models.json` cache
- `OPENCODE_DISABLE_MODELS_FETCH=1`: prevents runtime fetches to `models.dev`
- `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`: avoids default plugin installation during experiments
- `OPENCODE_DISABLE_PROJECT_CONFIG=1`: ignores repo-local `.opencode` config and dependency installs

If you do not already have `models.json`, download it once on a machine that can reach `models.dev`:

```bash
mkdir -p "$HOME/.cache/opencode"
curl -fsSL https://models.dev/api.json -o "$HOME/.cache/opencode/models.json"
```

## 5. Sanity check the source build

Run a single request from source:

```bash
cd /path/to/opencode/packages/opencode
bun run --conditions=browser src/index.ts run --format json "hello"
```

Or, after replacing your wrapper, simply:

```bash
opencode run --format json "hello"
```

If it hangs, add logs:

```bash
opencode --print-logs --log-level DEBUG run --format json "hello"
tail -120 ~/.local/share/opencode/log/dev.log
```

## 6. Run the TTFT profiling experiment

The profiling scripts live in `experiments/`.

Main batch runner:

- `experiments/run_ttft_profile.ts`

This runs:

- 3 models:
  - `local/MiniMax-M2.5`
  - `local/GLM-5`
  - `local/GLM-4.5-Air`
- 7 input sizes:
  - `1k, 2k, 5k, 10k, 20k, 50k, 100k`
- `repeat=3`

It prints progress for each `(model, target)` pair and writes results incrementally, so you can safely resume after interruption.

Run it from repo root:

```bash
cd /path/to/opencode
bun experiments/run_ttft_profile.ts
```

Progress output looks like:

```text
[start] model=local/MiniMax-M2.5 target=1000 repeat=3
[done 1/21] model=local/MiniMax-M2.5 target=1000 success=3/3 failure=0/3 avg_input_tokens=... avg_ttft_ms=... avg_decode_ms=... avg_cache_hit_pct=...
```

Output files:

- `experiments/output/ttft_profile_summary.csv`
- `experiments/output/ttft_profile_raw.json`

The summary CSV is append-safe in practice because the script rewrites it after every finished row and skips completed `(model, target)` pairs on rerun.

## 7. Plot the results

Plot script:

- `experiments/plot_ttft_profile.py`

Install plotting dependency if needed:

```bash
python3 -m pip install matplotlib
```

Generate plots:

```bash
cd /path/to/opencode
python3 experiments/plot_ttft_profile.py
```

Generated images:

- `experiments/output/avg_ttft_ms.png`
- `experiments/output/avg_decode_ms.png`

If you want to point it at a specific CSV:

```bash
python3 experiments/plot_ttft_profile.py experiments/output/ttft_profile_summary.csv
```

## 8. Minimal server session

A typical full session looks like:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
export OPENCODE_MODELS_PATH="$HOME/.cache/opencode/models.json"
export OPENCODE_DISABLE_MODELS_FETCH=1
export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
export OPENCODE_DISABLE_PROJECT_CONFIG=1

cd /path/to/opencode
git checkout codex/metrics-request-timing
git pull
cd packages/opencode
bun install
cd ../..

bun experiments/run_ttft_profile.ts
python3 -m pip install matplotlib
python3 experiments/plot_ttft_profile.py
```
