import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { staffRouter } from './routes/staff.mjs';
import { adminRouter } from './routes/admin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Load .env if present (no extra dependency needed on Node 22+).
const envPath = path.join(rootDir, '.env');
if (fs.existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

if (!process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) {
  console.warn(
    '[警告] 管理画面のパスワードが設定されていません。' +
      ' .env に ADMIN_PASSWORD_HASH (推奨: `npm run set-admin-password` で生成) または ADMIN_PASSWORD を設定してください。' +
      ' 未設定の間は管理画面にログインできません。'
  );
}

function getOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretPath = path.join(rootDir, 'data', '.session-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  if (fs.existsSync(secretPath)) {
    return fs.readFileSync(secretPath, 'utf8').trim();
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  return secret;
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json());
app.use(
  session({
    name: 'kintai.sid',
    secret: getOrCreateSessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000, // 12 hours
    },
  })
);

app.use('/api', staffRouter);
app.use('/api/admin', adminRouter);

app.use(express.static(path.join(rootDir, 'public')));

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// localhost only - this app is never meant to be reachable from outside the tablet.
app.listen(PORT, '127.0.0.1', () => {
  console.log(`勤怠管理アプリ起動: http://localhost:${PORT}`);
});
