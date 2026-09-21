#!/usr/bin/env bash
# gemini-cli を明示的なモデル降格ループで実行する。
#
# 背景: google-github-actions/run-gemini-cli@v0 は gemini_model 入力
# （実体は GEMINI_MODEL 環境変数、内部的に -m 相当の強制指定）を渡すと、
# headless 実行では settings.json の modelChains.default による
# in-process 降格が発火しない（実測: CI で RPD 枯渇時に降格ゼロ・exit 1、
# ローカル再現で chain 先頭 404 でも降格ゼロ）。-m を渡さない場合は router が
# custom chain 自体を無視して自律選択するため、どちらの経路でも in-process
# chain には頼れない。よってモデル降格は workflow 側のこのループが担う。
#
# 使い方:
#   run-review.sh <models_file> <prompt_file> <settings_template> \
#                  <artifact_dir> <api_key>
#
# settings_template は {{MODEL}} プレースホルダを含む JSON テンプレート。
# 各段でモデル名を埋め込み .gemini/settings.json として書き出す。
set -uo pipefail

MODELS_FILE="$1"
PROMPT_FILE="$2"
SETTINGS_TEMPLATE="$3"
ARTIFACT_DIR="$4"
API_KEY="$5"

mkdir -p "$ARTIFACT_DIR"
SUMMARY_FILE="${ARTIFACT_DIR}/summary.txt"
: > "$SUMMARY_FILE"

# TPM/RPM（分あたり）超過: 同じモデルのまま 60 秒待って 1 回だけ再試行する。
# 同じ入力で下位モデルに移っても再発する類の枯渇ではなく、時間経過で解消する。
is_rate_window_error() {
  grep -qE 'free_tier_input_token_count|rateLimitExceeded.*(minute|per minute)|RESOURCE_EXHAUSTED.*(minute|RPM)' "$1" "$2" 2>/dev/null
}

# RPD（日次）枯渇・404（モデル未提供）・503（一時的な過負荷）: 同じモデルへの
# 再試行に意味が無く、別モデル（= 別クォータ）へ進む。
is_next_model_error() {
  grep -qE 'free_tier_requests|RESOURCE_EXHAUSTED.*(day|daily|RPD)|"code":\s*404|NOT_FOUND|"code":\s*503|UNAVAILABLE' "$1" "$2" 2>/dev/null
}

classify_failure() {
  local out="$1" err="$2"
  if is_rate_window_error "$out" "$err"; then
    echo "rate_window"
  elif is_next_model_error "$out" "$err"; then
    echo "next_model"
  else
    echo "unclassified"
  fi
}

run_attempt() {
  local model="$1" attempt_dir="$2"
  mkdir -p "$attempt_dir"
  sed "s/{{MODEL}}/${model}/g" "$SETTINGS_TEMPLATE" > .gemini/settings.json

  GEMINI_API_KEY="$API_KEY" GOOGLE_API_KEY="$API_KEY" GEMINI_MODEL="$model" \
    gemini --yolo --prompt "$(cat "$PROMPT_FILE")" --output-format json \
    > "${attempt_dir}/stdout.log" 2> "${attempt_dir}/stderr.log"
  return $?
}

mkdir -p .gemini
models=()
while IFS= read -r line; do
  line="${line%%#*}"
  line="$(echo "$line" | xargs)"
  [ -n "$line" ] && models+=("$line")
done < "$MODELS_FILE"

if [ "${#models[@]}" -eq 0 ]; then
  echo "no models configured in ${MODELS_FILE}" | tee -a "$SUMMARY_FILE"
  exit 1
fi

for model in "${models[@]}"; do
  attempt_dir="${ARTIFACT_DIR}/${model}"
  echo "=== attempt: model=${model} ===" | tee -a "$SUMMARY_FILE"

  if run_attempt "$model" "$attempt_dir"; then
    echo "success: model=${model}" | tee -a "$SUMMARY_FILE"
    cp "${attempt_dir}/stdout.log" "${ARTIFACT_DIR}/stdout.log"
    cp "${attempt_dir}/stderr.log" "${ARTIFACT_DIR}/stderr.log"
    exit 0
  fi

  reason=$(classify_failure "${attempt_dir}/stdout.log" "${attempt_dir}/stderr.log")
  echo "failed: model=${model} reason=${reason}" | tee -a "$SUMMARY_FILE"

  # 前段の失敗と同じ分の TPM/RPM 窓のまま次を叩くと同じ枯渇が即座に再発しうる。
  # 次のモデルへ進む場合も、同モデル再試行の場合も 60 秒待って別の窓に入れる。
  sleep 60

  if [ "$reason" = "rate_window" ]; then
    retry_dir="${attempt_dir}-retry"
    echo "retrying once: model=${model}" | tee -a "$SUMMARY_FILE"
    if run_attempt "$model" "$retry_dir"; then
      echo "success: model=${model} (retry)" | tee -a "$SUMMARY_FILE"
      cp "${retry_dir}/stdout.log" "${ARTIFACT_DIR}/stdout.log"
      cp "${retry_dir}/stderr.log" "${ARTIFACT_DIR}/stderr.log"
      exit 0
    fi
    retry_reason=$(classify_failure "${retry_dir}/stdout.log" "${retry_dir}/stderr.log")
    echo "failed: model=${model} reason=${retry_reason} (retry)" | tee -a "$SUMMARY_FILE"
    sleep 60
  fi
  # rate_window 以外（next_model / unclassified）は同モデル再試行の意味が薄い
  # ため、分類に関わらずここで次のモデルへ進む（unclassified は fail-open）。
done

echo "all models exhausted" | tee -a "$SUMMARY_FILE"
cp "${ARTIFACT_DIR}/${models[-1]}/stdout.log" "${ARTIFACT_DIR}/stdout.log" 2>/dev/null || true
cp "${ARTIFACT_DIR}/${models[-1]}/stderr.log" "${ARTIFACT_DIR}/stderr.log" 2>/dev/null || true
exit 1
