const crypto = require('crypto');
const { HttpError } = require('./errors');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

function createAuth(db, now = Date.now) {
  const TTL = 12 * 3600 * 1000;
  return {
    login(email, password) {
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
      // same error for unknown user / wrong password
      if (!u || !verifyPassword(String(password || ''), u.password_hash))
        throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid email or password');
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(sha(token), u.id, now() + TTL);
      return { token, user: { id: u.id, name: u.name, email: u.email } };
    },
    userFromToken(token) {
      if (!token) return null;
      return db.prepare(`SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha(token), now()) || null;
    },
  };
}
module.exports = { hashPassword, verifyPassword, createAuth };
