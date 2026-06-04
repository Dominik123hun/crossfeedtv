/**
 * Minimal IRCv3 message parser, sufficient for Twitch's chat protocol.
 *
 * Line shape:
 *   @tag1=val1;tag2=val2 :nick!user@host COMMAND param1 param2 :trailing text
 *
 * Tags and prefix are both optional.
 */

export interface IrcMessage {
  raw: string;
  tags: Record<string, string>;
  prefix?: string;
  nick?: string;
  command: string;
  params: string[];
  /** The trailing parameter (everything after " :"), e.g. the chat text. */
  trailing?: string;
}

/** Unescape an IRCv3 tag value per the spec's escape sequences. */
function unescapeTagValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      const next = value[++i];
      switch (next) {
        case ":":
          out += ";";
          break;
        case "s":
          out += " ";
          break;
        case "\\":
          out += "\\";
          break;
        case "r":
          out += "\r";
          break;
        case "n":
          out += "\n";
          break;
        default:
          out += next ?? "";
      }
    } else {
      out += ch;
    }
  }
  return out;
}

export function parseIrcLine(line: string): IrcMessage {
  let rest = line;
  const tags: Record<string, string> = {};

  // Tags
  if (rest.startsWith("@")) {
    const sp = rest.indexOf(" ");
    const tagStr = sp === -1 ? rest.slice(1) : rest.slice(1, sp);
    rest = sp === -1 ? "" : rest.slice(sp + 1);
    for (const part of tagStr.split(";")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq === -1) {
        tags[part] = "";
      } else {
        tags[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
      }
    }
  }

  // Prefix
  let prefix: string | undefined;
  let nick: string | undefined;
  if (rest.startsWith(":")) {
    const sp = rest.indexOf(" ");
    prefix = sp === -1 ? rest.slice(1) : rest.slice(1, sp);
    rest = sp === -1 ? "" : rest.slice(sp + 1);
    const bang = prefix.indexOf("!");
    nick = bang >= 0 ? prefix.slice(0, bang) : prefix;
  }

  // Command + params + trailing
  let trailing: string | undefined;
  let paramPart = rest;
  const trailingIdx = rest.indexOf(" :");
  if (trailingIdx >= 0) {
    trailing = rest.slice(trailingIdx + 2);
    paramPart = rest.slice(0, trailingIdx);
  }
  const tokens = paramPart.split(" ").filter(Boolean);
  const command = tokens.shift() ?? "";

  return { raw: line, tags, prefix, nick, command, params: tokens, trailing };
}
