#!/data/data/com.termux/files/usr/bin/sh
# タブレット上で勤怠アプリを「止まらない」状態で常駐させるための起動スクリプト。
#
#   - termux-wake-lock で Android の省電力(Doze)による CPU 停止・プロセス凍結を防ぐ
#   - サーバーが落ちても 5 秒後に自動で再起動する
#   - ログが肥大しないよう 5MB を超えたら 1 世代だけ残して切り詰める
#
# 使い方:  sh ~/kinntaikannriapp/scripts/termux-start.sh
# 自動起動: ~/.termux/boot/start-kintai.sh から本スクリプトを呼ぶ
#
# 注意: Android がプロセスグループごと強制終了した場合はこのループ自体も消える。
#       その保険として scripts/termux-guard.sh を termux-job-scheduler に登録すること。

set -u

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
LOG="$HOME/kintai.log"
MAX_LOG_BYTES=5242880

cd "$APP_DIR" || exit 1

# 二重起動を防ぐ(guard スクリプトから呼ばれることがあるため)。
if pgrep -f "node server/index.mjs" >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] すでに起動中のため何もしません" >> "$LOG"
  exit 0
fi

while :; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt "$MAX_LOG_BYTES" ]; then
    mv "$LOG" "$LOG.1"
  fi

  # ウェイクロックは Android 側に解除されることがあるので起動のたびに取り直す。
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
  fi

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 勤怠サーバーを起動します" >> "$LOG"
  node server/index.mjs >> "$LOG" 2>&1
  code=$?
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] サーバーが終了しました (code=$code)。5秒後に再起動します" >> "$LOG"
  sleep 5
done
