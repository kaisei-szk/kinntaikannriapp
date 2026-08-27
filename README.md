# アルバイト勤怠管理アプリ

タブレット1台で完結する打刻アプリ。詳細な要件は [勤怠管理アプリ_要件定義.md](./勤怠管理アプリ_要件定義.md) を参照。

- サーバー: Node.js (>=22.5) + Express。DB は Node 標準の `node:sqlite`（ネイティブビルド不要）
- 依存パッケージ: `express` `express-session` `bcryptjs` のみ（すべて Pure JS）
- 顔写真は撮影の演出のみで、画像は一切保存しません

## 1. Mac での開発・動作確認

```bash
npm install
npm run set-admin-password   # 管理画面パスワードのハッシュを生成
```

表示された `ADMIN_PASSWORD_HASH=...` を `.env` にコピーします（`.env.example` を `.env` にコピーして編集）。

```bash
cp .env.example .env
# .env を編集して ADMIN_PASSWORD_HASH を設定
npm start
```

`http://localhost:3000` を開くと打刻画面、`http://localhost:3000/admin/` で管理画面にアクセスできます。

## 2. タブレット (Termux) へのデプロイ

1. Termux / Termux:Boot を F-Droid からインストール
2. Termux でパッケージを準備し、リポジトリを取得
   ```bash
   pkg update && pkg install nodejs-lts git
   git clone <このリポジトリのURL>
   cd <リポジトリ>
   npm install
   npm run set-admin-password
   cp .env.example .env   # ADMIN_PASSWORD_HASH を設定
   npm start
   ```
3. Chrome で `http://localhost:3000` を開き、「ホーム画面に追加」でアイコン化
4. Android 設定で「画面固定（アプリ固定）」を ON にしてキオスク運用にする
5. Termux をバッテリー最適化の対象外に設定

### 自動起動 (Termux:Boot)

`~/.termux/boot/start-kintai.sh` を作成し実行権限を付与:

```bash
#!/data/data/com.termux/files/usr/bin/sh
cd ~/<リポジトリ>
npm start >> ~/kintai.log 2>&1 &
```

## 3. バックアップ

DB は `data/kintai.sqlite3` の1ファイルのみ。週1回程度、USBメモリ等へコピーしてください。
管理画面のCSVエクスポートも簡易バックアップとして利用できます。

## ディレクトリ構成

```
server/          Express サーバー・API・DB
public/          打刻画面（トップ）
public/admin/    管理画面
data/            SQLite DB（gitignore 対象）
scripts/         管理者パスワード設定スクリプト
```
