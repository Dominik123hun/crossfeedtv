import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { DEFAULT_OVERLAY_SETTINGS, type OverlaySettings } from "./types";
import { randomId } from "./util";

/**
 * Persistence for the multi-tenant SaaS layer (users, their connected channels,
 * overlay tokens, sessions).
 *
 * This is a small, dependency-free JSON file store with atomic writes — fine for
 * a single-instance deployment. It's hidden behind the `Store` interface so it
 * can be swapped for Postgres/SQLite without touching the rest of the app.
 *
 * For more users / row-level durability, set STORE_DRIVER=sqlite to use the
 * node:sqlite-backed implementation in store-sqlite.ts (same interface; imports
 * this file's data on first run). TODO(scale): for multi-instance hosting,
 * point the Store at a networked DB (Postgres/Turso).
 */

export interface UserChannels {
  twitch?: string;
  kick?: string;
  x?: string;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  channels: UserChannels;
  /** Bearer token embedded in the user's unique overlay URL. */
  token: string;
  /** Overlay appearance settings. */
  settings: OverlaySettings;
  /** Whether the email address has been confirmed via a verification link. */
  emailVerified: boolean;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

/** Single-use, expiring tokens for email verification and password reset. */
export type TokenKind = "verify" | "reset";
export interface AuthToken {
  token: string;
  userId: string;
  kind: TokenKind;
  expiresAt: number;
}

export interface Store {
  createUser(email: string, passwordHash: string, salt: string): User;
  getUserByEmail(email: string): User | undefined;
  getUserById(id: string): User | undefined;
  getUserByToken(token: string): User | undefined;
  updateChannels(id: string, channels: UserChannels): User | undefined;
  updateSettings(id: string, settings: OverlaySettings): User | undefined;
  rotateToken(id: string): User | undefined;
  setEmailVerified(id: string, verified: boolean): User | undefined;
  updatePassword(id: string, passwordHash: string, salt: string): User | undefined;
  deleteUser(id: string): void;
  createSession(userId: string, ttlMs: number): Session;
  getSession(id: string): Session | undefined;
  deleteSession(id: string): void;
  /** Invalidate every session for a user (e.g. after a password reset). */
  deleteSessionsForUser(userId: string): void;
  /** Mint a single-use, expiring token (verification / reset). */
  createToken(userId: string, kind: TokenKind, ttlMs: number): AuthToken;
  /** Redeem a token: returns the userId once (then deletes it); undefined if invalid/expired/wrong kind. */
  useToken(token: string, kind: TokenKind): string | undefined;
}

interface DBShape {
  users: Record<string, User>;
  sessions: Record<string, Session>;
  tokens: Record<string, AuthToken>;
}

function freshToken(): string {
  return randomBytes(24).toString("hex"); // 48 hex chars
}

export function createStore(dataDir: string): Store {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "crossfeed-db.json");
  const db = load(file);

  const byEmail = new Map<string, string>();
  const byToken = new Map<string, string>();
  for (const user of Object.values(db.users)) {
    byEmail.set(user.email, user.id);
    byToken.set(user.token, user.id);
  }

  function persist(): void {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, file); // atomic on the same filesystem
  }

  function uniqueToken(): string {
    let t = freshToken();
    while (byToken.has(t)) t = freshToken();
    return t;
  }

  return {
    createUser(email, passwordHash, salt) {
      const id = randomId();
      const token = uniqueToken();
      const user: User = {
        id,
        email,
        passwordHash,
        salt,
        createdAt: Date.now(),
        channels: {},
        token,
        settings: { ...DEFAULT_OVERLAY_SETTINGS },
        emailVerified: false,
      };
      db.users[id] = user;
      byEmail.set(email, id);
      byToken.set(token, id);
      persist();
      return user;
    },

    getUserByEmail(email) {
      const id = byEmail.get(email);
      return id ? db.users[id] : undefined;
    },

    getUserById(id) {
      return db.users[id];
    },

    getUserByToken(token) {
      const id = byToken.get(token);
      return id ? db.users[id] : undefined;
    },

    updateChannels(id, channels) {
      const user = db.users[id];
      if (!user) return undefined;
      user.channels = { twitch: channels.twitch, kick: channels.kick, x: channels.x };
      persist();
      return user;
    },

    updateSettings(id, settings) {
      const user = db.users[id];
      if (!user) return undefined;
      user.settings = settings;
      persist();
      return user;
    },

    rotateToken(id) {
      const user = db.users[id];
      if (!user) return undefined;
      byToken.delete(user.token);
      user.token = uniqueToken();
      byToken.set(user.token, id);
      persist();
      return user;
    },

    setEmailVerified(id, verified) {
      const user = db.users[id];
      if (!user) return undefined;
      user.emailVerified = verified;
      persist();
      return user;
    },

    updatePassword(id, passwordHash, salt) {
      const user = db.users[id];
      if (!user) return undefined;
      user.passwordHash = passwordHash;
      user.salt = salt;
      persist();
      return user;
    },

    deleteUser(id) {
      const user = db.users[id];
      if (!user) return;
      byEmail.delete(user.email);
      byToken.delete(user.token);
      delete db.users[id];
      for (const session of Object.values(db.sessions)) {
        if (session.userId === id) delete db.sessions[session.id];
      }
      for (const t of Object.values(db.tokens)) {
        if (t.userId === id) delete db.tokens[t.token];
      }
      persist();
    },

    createSession(userId, ttlMs) {
      const id = randomBytes(24).toString("hex");
      const session: Session = { id, userId, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
      db.sessions[id] = session;
      persist();
      return session;
    },

    getSession(id) {
      const session = db.sessions[id];
      if (!session) return undefined;
      if (session.expiresAt < Date.now()) {
        delete db.sessions[id];
        persist();
        return undefined;
      }
      return session;
    },

    deleteSession(id) {
      if (db.sessions[id]) {
        delete db.sessions[id];
        persist();
      }
    },

    deleteSessionsForUser(userId) {
      let changed = false;
      for (const session of Object.values(db.sessions)) {
        if (session.userId === userId) {
          delete db.sessions[session.id];
          changed = true;
        }
      }
      if (changed) persist();
    },

    createToken(userId, kind, ttlMs) {
      const token = randomBytes(24).toString("hex");
      const entry: AuthToken = { token, userId, kind, expiresAt: Date.now() + ttlMs };
      db.tokens[token] = entry;
      persist();
      return entry;
    },

    useToken(token, kind) {
      const entry = db.tokens[token];
      if (!entry || entry.kind !== kind) return undefined;
      delete db.tokens[token]; // single-use: consume regardless of expiry
      const valid = entry.expiresAt >= Date.now();
      persist();
      return valid ? entry.userId : undefined;
    },
  };
}

function load(file: string): DBShape {
  if (!fs.existsSync(file)) return { users: {}, sessions: {}, tokens: {} };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    logger.child("store").error(`could not read ${file}`, err);
    return { users: {}, sessions: {}, tokens: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DBShape>;
    const users = parsed.users ?? {};
    for (const user of Object.values(users)) {
      // Migrate any user records that predate overlay settings.
      if (!user.settings) user.settings = { ...DEFAULT_OVERLAY_SETTINGS };
      // Grandfather accounts created before email verification existed: treat
      // them as verified so the new login gate never locks them out.
      if (user.emailVerified === undefined) user.emailVerified = true;
    }
    return { users, sessions: parsed.sessions ?? {}, tokens: parsed.tokens ?? {} };
  } catch {
    // The file exists but is corrupt. Do NOT silently start empty (the next write
    // would overwrite it) — preserve a forensic copy first, then start fresh.
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      logger.child("store").error(`corrupt data file; backed up to ${backup} and started fresh`);
    } catch (err) {
      logger.child("store").error(`corrupt data file and could not back it up`, err);
    }
    return { users: {}, sessions: {}, tokens: {} };
  }
}
