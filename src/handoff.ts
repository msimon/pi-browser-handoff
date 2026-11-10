// The two side-effecting flows: copy a login from a cmux browser pane into a
// named agent-browser restore session, and report on a saved session.
//
// Everything goes through `exec` (pi.exec in production) so no shell is
// involved and no cookie value is ever passed on a command line, printed, or
// returned. Cookie values exist only in two short-lived files, each in its own
// 0700 temp directory that is removed in a `finally`.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cookiesFromCmuxDump, expirySummary, selectCookies, type CookieExpiry, type StorageState } from "./cookies.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

const RESTORE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const SEED_SETTLE_MS = 5_000;
const VERIFY_TIMEOUT_MS = 25_000;
const VERIFY_POLL_MS = 1_500;
/** A page with at least this much text counts as rendered. */
const RENDERED_CHARS = 200;

interface Page {
  url: string;
  title: string;
  chars: number;
  signedIn: boolean | null;
  signedOut: boolean | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
  });
}

export function assertRestoreKey(key: string): void {
  if (!RESTORE_KEY.test(key)) {
    throw new Error(`restoreKey must be 1-64 letters, digits, '-' or '_' (got ${JSON.stringify(key)})`);
  }
}

/** Where agent-browser keeps a `--session <k> --restore <k>` session. */
export function sessionFilePath(key: string): string {
  return join(homedir(), ".agent-browser", "sessions", `${key}-${key}.json`);
}

/** Login-looking URL: a login path, or an accounts./login./auth./sso. host. */
export function looksLikeLoginUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (/^(accounts|login|auth|sso|signin)\./i.test(url.hostname)) return true;
  return /\/(login|log-in|signin|sign-in|sign_in|auth|sso|oauth)(\/|$)/i.test(url.pathname);
}

async function run(exec: Exec, command: string, args: string[], timeout: number, signal?: AbortSignal) {
  const r = await exec(command, args, { timeout, ...(signal ? { signal } : {}) });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ");
    throw new Error(`\`${command} ${args.slice(0, 3).join(" ")} …\` failed (exit ${r.code})${why ? `: ${why}` : ""}`);
  }
  return r.stdout;
}

/** agent-browser for one named session; `--restore=<k>` avoids the key being read as a command. */
function ab(exec: Exec, key: string, args: string[], timeout: number, signal?: AbortSignal) {
  return run(exec, "agent-browser", ["--session", key, ...args], timeout, signal);
}

async function abQuiet(exec: Exec, key: string, args: string[], timeout: number) {
  try {
    await ab(exec, key, args, timeout);
  } catch {
    // close/wait are best-effort
  }
}

// ── cmux ───────────────────────────────────────────────────────────────────

export async function openCmuxPane(exec: Exec, url: string, signal?: AbortSignal): Promise<string> {
  const out = await run(exec, "cmux", ["browser", "open-split", url, "--focus", "true"], 30_000, signal);
  const surface = /surface=(\S+)/.exec(out)?.[1];
  if (!surface) throw new Error(`cmux did not report a surface for the new pane: ${out.trim()}`);
  return surface;
}

export async function closeCmuxPane(exec: Exec, surface: string): Promise<void> {
  try {
    await exec("cmux", ["close-surface", "--surface", surface], { timeout: 10_000 });
  } catch {
    // the user may already have closed it
  }
}

/**
 * Save the pane's browser state, keep only `domains`' cookies, delete the dump.
 * cmux requires an absolute path and writes every cookie in the profile.
 */
export async function captureCookies(exec: Exec, surface: string, domains: string[], signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "browser-handoff-"));
  try {
    const full = join(dir, "cmux-state.json");
    await run(exec, "cmux", ["browser", surface, "state", "save", full], 30_000, signal);
    return selectCookies(cookiesFromCmuxDump(JSON.parse(await readFile(full, "utf8"))), domains);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── agent-browser ──────────────────────────────────────────────────────────

/**
 * Load `state` into the restore key, then close so agent-browser saves it.
 * Verified: `--state` wins over an existing (stale) saved session.
 */
export async function seedRestoreKey(exec: Exec, key: string, state: StorageState, url: string, signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "browser-handoff-"));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, JSON.stringify(state), { mode: 0o600 });
    await abQuiet(exec, key, ["close"], 30_000); // a running session would ignore --state
    await ab(exec, key, [`--restore=${key}`, "--state", file, "open", url], 90_000, signal);
    // Give the site a moment to renew its session cookie before the save on
    // close. Not networkidle: busy apps (Notion) never go idle and it times out.
    await abQuiet(exec, key, ["wait", String(SEED_SETTLE_MS)], 15_000);
    await ab(exec, key, ["close"], 30_000, signal);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface Verification {
  verified: boolean;
  url: string;
  title: string;
  reason?: string;
}

/** Reopen the key headless with only --restore and check it is signed in. */
export async function verifyRestoreKey(
  exec: Exec,
  key: string,
  url: string,
  opts: { signedInText?: string | undefined; signedOutText?: string | undefined },
  signal?: AbortSignal,
): Promise<Verification> {
  await abQuiet(exec, key, ["close"], 30_000);
  try {
    await ab(exec, key, [`--restore=${key}`, "--restore-save", "never", "open", url], 90_000, signal);
    const inText = JSON.stringify(opts.signedInText ?? null);
    const outText = JSON.stringify(opts.signedOutText ?? null);
    const js =
      `(() => { const t = document.body ? document.body.innerText : ""; const i = ${inText}, o = ${outText};` +
      ` return JSON.stringify({ url: location.href, title: document.title, chars: t.length,` +
      ` signedIn: i === null ? null : t.includes(i), signedOut: o === null ? null : t.includes(o) }); })()`;

    // Poll until the page has rendered or shows a verdict, instead of waiting
    // for networkidle (which busy single-page apps never reach).
    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    let page: Page;
    for (;;) {
      let v: unknown = JSON.parse((await ab(exec, key, ["eval", js], 30_000, signal)).trim());
      if (typeof v === "string") v = JSON.parse(v);
      page = v as Page;
      const decided =
        looksLikeLoginUrl(page.url) ||
        page.signedOut === true ||
        page.signedIn === true ||
        (page.chars >= RENDERED_CHARS && page.signedIn === null);
      if (decided || Date.now() >= deadline) break;
      await sleep(VERIFY_POLL_MS, signal);
    }

    let reason: string | undefined;
    if (looksLikeLoginUrl(page.url)) reason = "landed on a login page";
    else if (page.signedOut === true) reason = `page shows ${JSON.stringify(opts.signedOutText)}`;
    else if (page.signedIn === false) reason = `page does not show ${JSON.stringify(opts.signedInText)}`;
    else if (page.chars === 0) reason = "page rendered no text";
    return { verified: reason === undefined, url: page.url, title: page.title, ...(reason ? { reason } : {}) };
  } finally {
    await abQuiet(exec, key, ["close"], 30_000);
  }
}

// ── status ─────────────────────────────────────────────────────────────────

export interface SessionStatus {
  restoreKey: string;
  exists: boolean;
  file: string;
  savedAt?: string;
  cookies: CookieExpiry[];
}

export async function sessionStatus(key: string, domains: string[]): Promise<SessionStatus> {
  const file = sessionFilePath(key);
  let raw: string;
  let savedAt: string;
  try {
    raw = await readFile(file, "utf8");
    savedAt = (await stat(file)).mtime.toISOString();
  } catch {
    return { restoreKey: key, exists: false, file, cookies: [] };
  }
  let cookies: unknown;
  try {
    cookies = (JSON.parse(raw) as { cookies?: unknown }).cookies;
  } catch {
    throw new Error(`${file} is not readable JSON; agent-browser may have changed its session format`);
  }
  if (!Array.isArray(cookies)) throw new Error(`${file} has no cookies array`);
  return { restoreKey: key, exists: true, file, savedAt, cookies: expirySummary(cookies, domains) };
}
