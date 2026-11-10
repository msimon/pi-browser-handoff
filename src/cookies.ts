// Pure cookie handling: pick one site's cookies out of a cmux browser state
// dump and convert them to the Playwright storage-state shape that
// `agent-browser --state <file>` loads.
//
// A cmux dump holds every cookie in the browser profile (every site the user
// is signed into), so selection is an allow-list by domain and nothing else
// from the dump survives this module.

/** One cookie as `cmux browser state save` writes it. */
export interface CmuxCookie {
  domain: string;
  name: string;
  value: string;
  path?: string;
  /** Unix seconds; absent or 0 for session cookies. */
  expires?: number | null;
  hostOnly?: boolean;
  httpOnly?: boolean;
  secure?: boolean;
  session_only?: boolean;
}

/** One cookie in Playwright storage-state form. */
export interface StateCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds, or -1 for a session cookie. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax";
}

export interface StorageState {
  cookies: StateCookie[];
  origins: [];
}

/** `".App.Notion.com "` → `"app.notion.com"`. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, "");
}

/**
 * True when `cookieDomain` is one of `domains` or a subdomain of one, so
 * `notion.com` matches `app.notion.com` but not `notnotion.com`.
 */
export function matchesDomain(cookieDomain: string, domains: readonly string[]): boolean {
  const d = normalizeDomain(cookieDomain);
  return domains.some((raw) => {
    const want = normalizeDomain(raw);
    return want !== "" && (d === want || d.endsWith(`.${want}`));
  });
}

export function toStateCookie(c: CmuxCookie): StateCookie {
  const expires = c.session_only || !c.expires || c.expires <= 0 ? -1 : Number(c.expires);
  return {
    name: c.name,
    value: c.value,
    // A host-only cookie is written without the leading dot; a domain cookie keeps it.
    domain: c.hostOnly ? normalizeDomain(c.domain) : c.domain,
    path: c.path || "/",
    expires,
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    // cmux does not record SameSite; Lax is the browser default.
    sameSite: "Lax",
  };
}

export function selectCookies(cookies: readonly CmuxCookie[], domains: readonly string[]): StateCookie[] {
  return cookies.filter((c) => matchesDomain(c.domain, domains)).map(toStateCookie);
}

/** Pull the cookie list out of a parsed cmux dump, failing loudly on a shape change. */
export function cookiesFromCmuxDump(dump: unknown): CmuxCookie[] {
  const cookies = (dump as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) {
    throw new Error("cmux state file has no `cookies` array; the cmux state format may have changed");
  }
  return cookies.filter(
    (c): c is CmuxCookie =>
      typeof c === "object" &&
      c !== null &&
      typeof (c as CmuxCookie).domain === "string" &&
      typeof (c as CmuxCookie).name === "string" &&
      typeof (c as CmuxCookie).value === "string",
  );
}

export interface CookieExpiry {
  name: string;
  domain: string;
  /** ISO date-time, or "session" for a cookie that ends with the browser. */
  expires: string;
}

/**
 * Name, domain and expiry of every matching cookie in a saved session, latest
 * expiry first. Values are never read into the result.
 */
export function expirySummary(
  cookies: readonly { name?: unknown; domain?: unknown; expires?: unknown }[],
  domains: readonly string[],
): CookieExpiry[] {
  const rows: { name: string; domain: string; at: number }[] = [];
  for (const c of cookies) {
    if (typeof c.name !== "string" || typeof c.domain !== "string") continue;
    if (domains.length > 0 && !matchesDomain(c.domain, domains)) continue;
    const at = typeof c.expires === "number" && c.expires > 0 ? c.expires : -1;
    rows.push({ name: c.name, domain: c.domain, at });
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.map((r) => ({
    name: r.name,
    domain: r.domain,
    expires: r.at > 0 ? new Date(r.at * 1000).toISOString() : "session",
  }));
}
