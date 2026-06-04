import { randomUUID } from "crypto";

export function randomId(): string {
  return randomUUID();
}

/** Validate a CSS hex color of the form #rgb or #rrggbb. */
export function isValidHexColor(value: string | undefined): value is string {
  return !!value && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/**
 * Deterministic fallback color for users who have not set a chat color.
 * Mirrors Twitch's behavior of assigning a stable color from a fixed palette.
 */
const FALLBACK_COLORS = [
  "#FF4500",
  "#1E90FF",
  "#00FF7F",
  "#FF69B4",
  "#9ACD32",
  "#FF7F50",
  "#5F9EA0",
  "#DAA520",
  "#8A2BE2",
  "#2E8B57",
  "#D2691E",
  "#00CED1",
  "#FF1493",
  "#7FFF00",
  "#B22222",
];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
}

/** Parse a millisecond timestamp tag, falling back to now. */
export function parseTimestamp(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}
