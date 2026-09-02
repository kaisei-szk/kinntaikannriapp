#!/data/data/com.termux/files/usr/bin/sh
# 勤怠サーバーの生存確認と復旧を行う見張り役。
#
# Android がプロセスグループごと殺すと termux-start.sh のループも消えるため、
# Android 自身のジョブスケジューラから定期的にこのスクリプトを叩いて復旧させる。
#
# 登録(1回だけ実行。パスは絶対パスで指定すること):
#   termux-job-scheduler --job-id 1 --period-ms 900000 --persisted true \
#     --script /data/data/com.termux/files/home/kinntaikannriapp/scripts/termux-guard.sh
# 確認: termux-job-scheduler --pending
# 解除: termux-job-scheduler --cancel-job 1

set -u

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
LOG="$HOME/kintai.log"

# .env の PORT を読む(未設定なら 3000)。
PORT=$(sed -n 's/^PORT=\([0-9][0-9]*\).*/\1/p' "$APP_DIR/.env" 2>/dev/null | tail -1)
[ -n "${PORT:-}" ] || PORT=3000

alive=0
if command -v curl >/dev/null 2>&1; then
  # 応答が返れば生存。HTTP ステータスは問わない(旧版に /api/health が無くても誤判定しない)。
  if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/api/health"; then
    alive=1
  fi
elif pgrep -f "node server/index.mjs" >/dev/null 2>&1; then
  alive=1
fi

if [ "$alive" = "1" ]; then
  # 生きている間もウェイクロックを取り直しておく。
  command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] [guard] 応答が無いため再起動します (port=$PORT)" >> "$LOG"
pkill -f "node server/index.mjs" 2>/dev/null
sleep 1
nohup sh "$APP_DIR/scripts/termux-start.sh" >/dev/null 2>&1 &
