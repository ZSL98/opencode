from __future__ import annotations

import csv
import os
import sys

import matplotlib.pyplot as plt


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "experiments", "output")
CSV = os.path.join(OUT, "ttft_profile_summary.csv")


def load(path: str):
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if int(row["success_count"]) == 0:
                continue
            rows.append(
                {
                    "model": row["model"],
                    "target_input_tokens": int(row["target_input_tokens"]),
                    "avg_ttft_ms": float(row["avg_ttft_ms"]),
                    "avg_decode_ms": float(row["avg_decode_ms"]),
                }
            )
    return rows


def draw(rows: list[dict], key: str, name: str, ylabel: str):
    plt.figure(figsize=(10, 6))
    models = sorted({row["model"] for row in rows})

    for model in models:
        data = sorted((row for row in rows if row["model"] == model), key=lambda row: row["target_input_tokens"])
        xs = [row["target_input_tokens"] for row in data]
        ys = [row[key] for row in data]
        plt.plot(xs, ys, marker="o", linewidth=2, label=model)

    plt.xlabel("Input tokens")
    plt.ylabel(ylabel)
    plt.title(name)
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()
    path = os.path.join(OUT, f"{key}.png")
    plt.savefig(path, dpi=200)
    plt.close()
    return path


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else CSV
    rows = load(path)
    if not rows:
        raise SystemExit("no successful rows found in csv")

    os.makedirs(OUT, exist_ok=True)
    ttft = draw(rows, "avg_ttft_ms", "TTFT vs Input Length", "Average TTFT (ms)")
    decode = draw(rows, "avg_decode_ms", "Decode vs Input Length", "Average Decode (ms)")
    print(f"TTFT plot: {ttft}")
    print(f"Decode plot: {decode}")


if __name__ == "__main__":
    main()
