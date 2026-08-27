import bcrypt from 'bcryptjs';

const failedAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

export async function verifyPassword(password) {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const plain = process.env.ADMIN_PASSWORD;

  if (hash) {
    return bcrypt.compare(password, hash);
  }
  if (plain) {
    return password === plain;
  }
  // No password configured at all - refuse everything and warn loudly in the log.
  return false;
}

export function isLocked(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) return true;
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    failedAttempts.delete(ip);
  }
  return false;
}

export function recordFailure(ip) {
  const entry = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_MS;
    entry.count = 0;
  }
  failedAttempts.set(ip, entry);
}

export function clearFailures(ip) {
  failedAttempts.delete(ip);
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.status(401).json({ error: '認証が必要です' });
}
