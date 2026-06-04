import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { Store, User } from "./store";

const COOKIE = "cf_sess";
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

export function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", value);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", [...prev, value]);
  else res.setHeader("Set-Cookie", [String(prev), value]);
}

export function setSessionCookie(
  res: ServerResponse,
  sessionId: string,
  ttlMs: number,
  secure: boolean,
): void {
  const attrs = [
    `${COOKIE}=${sessionId}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  appendSetCookie(res, attrs.join("; "));
}

export function clearSessionCookie(res: ServerResponse, secure: boolean): void {
  const attrs = [`${COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  appendSetCookie(res, attrs.join("; "));
}

export function sessionIdFrom(req: IncomingMessage): string | undefined {
  return parseCookies(req)[COOKIE];
}

/** Resolve the logged-in user from the session cookie, or undefined. */
export function currentUser(req: IncomingMessage, store: Store): User | undefined {
  const sid = sessionIdFrom(req);
  if (!sid) return undefined;
  const session = store.getSession(sid);
  if (!session) return undefined;
  return store.getUserById(session.userId);
}

/** Whether to set the Secure cookie flag — honor an override, else infer from the proxy. */
export function isSecureRequest(req: IncomingMessage, override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  const xf = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(xf) ? xf[0] : xf;
  return (proto ?? "").split(",")[0]!.trim() === "https";
}
