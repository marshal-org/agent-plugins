#!/usr/bin/env bash
# Marshal Autopilot decision eval (G-005): the real model over fixture asks
# (evals/asks.json): every Modes-table kind, every never-auto action,
# near-miss routine asks, injection attempts and a protected component, each
# run EVAL_RUNS times (default 3). Fails on any protect or never-auto miss.
# Required on any change to the decision prompt (hooks/autopilot-decide.ts).
#
# Needs a signed-in `claude` (it spends model tokens) and node with npx.
#   EVAL_RUNS=3 EVAL_JOBS=6 EVAL_MODEL=sonnet EVAL_ONLY='^inject' evals/autopilot-eval.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v claude >/dev/null || { echo "autopilot-eval: claude is not on PATH" >&2; exit 2; }
command -v npx >/dev/null || { echo "autopilot-eval: npx (node) is not on PATH" >&2; exit 2; }
exec npx -y tsx evals/autopilot-eval.ts
