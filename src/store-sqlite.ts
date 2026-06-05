import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./logger";
import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from "./types";
import { randomId } from "./util";
import type { Session, Store, User, UserChannels } from "./store";

/**
 * SQLite-backed implementation of the same `Store` interface as the JSON store.
 *
 * Uses Node's built-in `node:sqlite` (no native add-on to compile, works on the
 * Alpine runtime image). Compared to the JSON store this gives row-level writes
 * (no full-file rewrite per change) and real durability via WAL — a better fit
 * once there are more than a handful of users. Selected with `STORE_DRIVER=sqlite`.
 *
 * On first open it imports an existing `crossfeed-db.json` (the JSON store's
 * file) if present, so switching backends keeps existing accounts. The JSON file
 * is left untouched.
 */

const log = logger.child("store");

function freshToken(): string {
  return randomBytes(24).toString("hex"); // 48 hex chars
}

function parseSettings(raw: unknown): OverlaySettings {
  try {
    return { ...DEFAULT_OVERLAY_SETTINGS, ...(JSON.parse(String(raw)) as Partial<OverlaySettings>) };
  } catch {
    return { ...DEFAULT_OVERLAY_SETTINGS };
  }
}

function parseChannels(raw: unknown): UserChannels {
  try {
    const c = JSON.parse(String(raw)) as UserChannels;
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  created_at: number;
  token: string;
  channels: string;
  settings: string;
  email_verified: number;
}

export function createSqliteStore(dataDir: string): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "crossfeed.db");
  const db = new DatabaseSync(file);

  // WAL = durable + concurrent reads while writing; foreign_keys = cascade sessions.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      salt           TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      token          TEXT UNIQUE NOT NULL,
      channels       TEXT NOT NULL DEFAULT '{}',
      settings       TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);

  const stmt = {
    insertUser: db.prepare(
      `INSERT INTO users (id, email, password_hash, salt, created_at, token, channels, settings, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertUserIgnore: db.prepare(
      `INSERT OR IGNORE INTO users (id, email, password_hash, salt, created_at, token, channels, settings, email_verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    byEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    byId: db.prepare("SELECT * FROM users WHERE id = ?"),
    byToken: db.prepare("SELECT * FROM users WHERE token = ?"),
    tokenExists: db.prepare("SELECT 1 FROM users WHERE token = ?"),
    setChannels: db.prepare("UPDATE users SET channels = ? WHERE id = ?"),
    setSettings: db.prepare("UPDATE users SET settings = ? WHERE id = ?"),
    setToken: db.prepare("UPDATE users SET token = ? WHERE id = ?"),
    setVerified: db.prepare("UPDATE users SET email_verified = ? WHERE id = ?"),
    setPassword: db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
    insertSession: db.prepare(
      "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ),
    insertSessionIgnore: db.prepare(
      "INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ),
    getSession: db.prepare("SELECT * FROM sessions WHERE id = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    insertAuthToken: db.prepare(
      "INSERT INTO tokens (token, user_id, kind, expires_at) VALUES (?, ?, ?, ?)",
    ),
    getAuthToken: db.prepare("SELECT * FROM tokens WHERE token = ?"),
    deleteAuthToken: db.prepare("DELETE FROM tokens WHERE token = ?"),
    metaGet: db.prepare("SELECT value FROM meta WHERE key = ?"),
    metaSet: db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"),
    userCount: db.prepare("SELECT COUNT(*) AS c FROM users"),
  };

  function rowToUser(row: UserRow): User {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      salt: row.salt,
      createdAt: Number(row.created_at),
      token: row.token,
      channels: parseChannels(row.channels),
      settings: parseSettings(row.settings),
      emailVerified: !!Number(row.email_verified),
    };
  }

  function uniqueToken(): string {
    let t = freshToken();
    while (stmt.tokenExists.get(t)) t = freshToken();
    return t;
  }

  maybeMigrateFromJson();

  /** One-time import of the legacy JSON store into an empty SQLite DB. */
  function maybeMigrateFromJson(): void {
    try {
      if (stmt.metaGet.get("json_migrated")) return;
      if ((stmt.userCount.get() as { c: number }).c > 0) {
        stmt.metaSet.run("json_migrated", "1");
        return;
      }
      const jsonFile = path.join(dataDir, "crossfeed-db.json");
      if (fs.existsSync(jsonFile)) {
        const db0 = JSON.parse(fs.readFileSync(jsonFile, "utf8")) as {
          users?: Record<string, User>;
          sessions?: Record<string, Session>;
        };
        const users = db0.users ?? {};
        const sessions = db0.sessions ?? {};
        for (const u of Object.values(users)) {
          stmt.insertUserIgnore.run(
            u.id,
            u.email,
            u.passwordHash,
            u.salt,
            Number(u.createdAt) || Date.now(),
            u.token,
            JSON.stringify(u.channels ?? {}),
            JSON.stringify(u.settings ?? DEFAULT_OVERLAY_SETTINGS),
            // Grandfather pre-verification accounts as verified.
            u.emailVerified === false ? 0 : 1,
          );
        }
        for (const s of Object.values(sessions)) {
          stmt.insertSessionIgnore.run(s.id, s.userId, Number(s.createdAt) || Date.now(), Number(s.expiresAt) || 0);
        }
        const n = Object.keys(users).length;
        if (n > 0) log.info(`migrated ${n} user(s) from crossfeed-db.json into SQLite`);
      }
      stmt.metaSet.run("json_migrated", "1");
    } catch (err) {
      // Non-fatal: a failed import must not stop the app from starting.
      log.error("JSON→SQLite migration failed (continuing with an empty SQLite store)", err);
    }
  }

  return {
    createUser(email, passwordHash, salt) {
      const user: User = {
        id: randomId(),
        email,
        passwordHash,
        salt,
        createdAt: Date.now(),
        channels: {},
        token: uniqueToken(),
        settings: { ...DEFAULT_OVERLAY_SETTINGS },
        emailVerified: false,
      };
      stmt.insertUser.run(
        user.id,
        user.email,
        user.passwordHash,
        user.salt,
        user.createdAt,
        user.token,
        JSON.stringify(user.channels),
        JSON.stringify(user.settings),
        0,
      );
      return user;
    },

    getUserByEmail(email) {
      const row = stmt.byEmail.get(email) as UserRow | undefined;
      return row ? rowToUser(row) : undefined;
    },

    getUserById(id) {
      const row = stmt.byId.get(id) as UserRow | undefined;
      return row ? rowToUser(row) : undefined;
    },

    getUserByToken(token) {
      const row = stmt.byToken.get(token) as UserRow | undefined;
      return row ? rowToUser(row) : undefined;
    },

    updateChannels(id, channels) {
      const row = stmt.byId.get(id) as UserRow | undefined;
      if (!row) return undefined;
      // Mirror the JSON store: only persist defined platforms (undefined keys drop).
      const next = JSON.stringify({ twitch: channels.twitch, kick: channels.kick, x: channels.x });
      stmt.setChannels.run(next, id);
      return rowToUser({ ...row, channels: next });
    },

    updateSettings(id, settings) {
      const row = stmt.byId.get(id) as UserRow | undefined;
      if (!row) return undefined;
      const next = JSON.stringify(settings);
      stmt.setSettings.run(next, id);
      return rowToUser({ ...row, settings: next });
    },

    rotateToken(id) {
      const row = stmt.byId.get(id) as UserRow | undefined;
      if (!row) return undefined;
      const token = uniqueToken();
      stmt.setToken.run(token, id);
      return rowToUser({ ...row, token });
    },

    setEmailVerified(id, verified) {
      const row = stmt.byId.get(id) as UserRow | undefined;
      if (!row) return undefined;
      stmt.setVerified.run(verified ? 1 : 0, id);
      return rowToUser({ ...row, email_verified: verified ? 1 : 0 });
    },

    updatePassword(id, passwordHash, salt) {
      const row = stmt.byId.get(id) as UserRow | undefined;
      if (!row) return undefined;
      stmt.setPassword.run(passwordHash, salt, id);
      return rowToUser({ ...row, password_hash: passwordHash, salt });
    },

    deleteUser(id) {
      // Sessions + tokens cascade via their foreign keys.
      stmt.deleteUser.run(id);
    },

    createSession(userId, ttlMs) {
      const session: Session = {
        id: randomBytes(24).toString("hex"),
        userId,
        createdAt: Date.now(),
        expiresAt: Date.now() + ttlMs,
      };
      stmt.insertSession.run(session.id, session.userId, session.createdAt, session.expiresAt);
      return session;
    },

    getSession(id) {
      const row = stmt.getSession.get(id) as
        | { id: string; user_id: string; created_at: number; expires_at: number }
        | undefined;
      if (!row) return undefined;
      if (Number(row.expires_at) < Date.now()) {
        stmt.deleteSession.run(id);
        return undefined;
      }
      return {
        id: row.id,
        userId: row.user_id,
        createdAt: Number(row.created_at),
        expiresAt: Number(row.expires_at),
      };
    },

    deleteSession(id) {
      stmt.deleteSession.run(id);
    },

    deleteSessionsForUser(userId) {
      stmt.deleteUserSessions.run(userId);
    },

    createToken(userId, kind, ttlMs) {
      const token = randomBytes(24).toString("hex");
      const entry = { token, userId, kind, expiresAt: Date.now() + ttlMs };
      stmt.insertAuthToken.run(entry.token, entry.userId, entry.kind, entry.expiresAt);
      return entry;
    },

    useToken(token, kind) {
      const row = stmt.getAuthToken.get(token) as
        | { token: string; user_id: string; kind: string; expires_at: number }
        | undefined;
      if (!row || row.kind !== kind) return undefined;
      stmt.deleteAuthToken.run(token); // single-use
      return Number(row.expires_at) >= Date.now() ? row.user_id : undefined;
    },
  };
}
