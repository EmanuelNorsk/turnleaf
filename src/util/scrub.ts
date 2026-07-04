/**
 * Privacy scrubbing for anything that leaves this machine (AI provider
 * prompts, prefilled GitHub issues). Server logs casually contain player
 * UUIDs, IP addresses, and the admin's Windows username in paths — none of
 * which an AI provider or a public issue tracker needs to see.
 */

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g;
// Windows and Unix home paths — keep the tail of the path, drop the username.
const WIN_HOME_RE = /[A-Za-z]:\\Users\\[^\\/\s]+/g;
const UNIX_HOME_RE = /\/(?:home|Users)\/[^/\s]+/g;
// "PlayerName joined the game" / "PlayerName left the game" / auth lines.
const PLAYER_EVENT_RE = /^(.*?(?:INFO|WARN)\]:?\s*)(\S+)( (?:joined|left) the game)/gm;
const LOGIN_RE = /UUID of player (\S+)/g;
// "PlayerName[/1.2.3.4:5555] logged in" — the name before the bracket.
const CONNECT_RE = /^(.*?(?:INFO|WARN)\]:?\s*)([^\s[]+)(\[\/)/gm;

export function scrub(text: string): string {
  return text
    .replace(UUID_RE, "[uuid]")
    .replace(IPV4_RE, (m) => (m.startsWith("127.") || m.startsWith("0.") ? m : "[ip]"))
    .replace(WIN_HOME_RE, "C:\\Users\\[user]")
    .replace(UNIX_HOME_RE, (m) => (m.startsWith("/home") ? "/home/[user]" : "/Users/[user]"))
    .replace(PLAYER_EVENT_RE, "$1[player]$3")
    .replace(CONNECT_RE, "$1[player]$3")
    .replace(LOGIN_RE, "UUID of player [player]");
}
