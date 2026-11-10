import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cookiesFromCmuxDump,
  expirySummary,
  matchesDomain,
  normalizeDomain,
  selectCookies,
  toStateCookie,
  type CmuxCookie,
} from "./cookies.ts";

const cookie = (over: Partial<CmuxCookie>): CmuxCookie => ({
  domain: ".notion.com",
  name: "token_v2",
  value: "v",
  path: "/",
  expires: 1_900_000_000,
  hostOnly: false,
  httpOnly: true,
  secure: true,
  session_only: false,
  ...over,
});

test("normalizeDomain strips dots, case and whitespace", () => {
  assert.equal(normalizeDomain(" .App.Notion.com "), "app.notion.com");
});

test("matchesDomain accepts the domain and its subdomains only", () => {
  const domains = ["notion.com", "notion.so"];
  assert.ok(matchesDomain(".notion.com", domains));
  assert.ok(matchesDomain("app.notion.com", domains));
  assert.ok(matchesDomain("msgstore-002.app.notion.com", domains));
  assert.ok(matchesDomain("www.notion.so", domains));
  assert.ok(!matchesDomain("notnotion.com", domains));
  assert.ok(!matchesDomain("notion.com.evil.io", domains));
  assert.ok(!matchesDomain("github.com", domains));
});

test("matchesDomain never matches an empty domain list or blank entries", () => {
  assert.ok(!matchesDomain("notion.com", []));
  assert.ok(!matchesDomain("notion.com", ["", " . "]));
});

test("toStateCookie keeps the dot for domain cookies and drops it for host-only ones", () => {
  assert.equal(toStateCookie(cookie({ domain: ".notion.com", hostOnly: false })).domain, ".notion.com");
  assert.equal(toStateCookie(cookie({ domain: "app.notion.com", hostOnly: true })).domain, "app.notion.com");
  assert.equal(toStateCookie(cookie({ domain: ".app.notion.com", hostOnly: true })).domain, "app.notion.com");
});

test("toStateCookie maps session cookies to expires -1", () => {
  assert.equal(toStateCookie(cookie({ session_only: true })).expires, -1);
  assert.equal(toStateCookie(cookie({ expires: null })).expires, -1);
  assert.equal(toStateCookie(cookie({ expires: 0 })).expires, -1);
  assert.equal(toStateCookie(cookie({ expires: 1_900_000_000 })).expires, 1_900_000_000);
});

test("toStateCookie fills defaults", () => {
  const c = toStateCookie({ domain: "x.com", name: "a", value: "b" });
  assert.deepEqual(c, {
    name: "a",
    value: "b",
    domain: "x.com",
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  });
});

test("selectCookies drops every other site's cookies", () => {
  const all = [
    cookie({ domain: ".notion.com" }),
    cookie({ domain: "app.notion.com", name: "a", hostOnly: true }),
    cookie({ domain: ".github.com", name: "user_session" }),
    cookie({ domain: ".brex.com", name: "session" }),
  ];
  const picked = selectCookies(all, ["notion.com"]);
  assert.deepEqual(
    picked.map((c) => c.domain),
    [".notion.com", "app.notion.com"],
  );
});

test("selectCookies returns nothing when no cookie matches", () => {
  assert.deepEqual(selectCookies([cookie({ domain: ".github.com" })], ["notion.com"]), []);
});

test("cookiesFromCmuxDump rejects an unexpected shape and skips malformed cookies", () => {
  assert.throws(() => cookiesFromCmuxDump({}), /no `cookies` array/);
  assert.throws(() => cookiesFromCmuxDump(null), /no `cookies` array/);
  const ok = cookiesFromCmuxDump({ cookies: [cookie({}), { domain: 1 }, null, "x"] });
  assert.equal(ok.length, 1);
});

test("expirySummary lists names and expiries, latest first, without values", () => {
  const rows = expirySummary(
    [
      { name: "short", domain: ".notion.com", expires: 1_800_000_000, value: "secret" },
      { name: "long", domain: "app.notion.com", expires: 1_900_000_000, value: "secret" },
      { name: "sess", domain: ".notion.com", expires: -1 },
      { name: "other", domain: ".github.com", expires: 1_950_000_000 },
    ] as { name: string; domain: string; expires: number }[],
    ["notion.com"],
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ["long", "short", "sess"],
  );
  assert.equal(rows[2]?.expires, "session");
  assert.equal(rows[0]?.expires, new Date(1_900_000_000 * 1000).toISOString());
  assert.ok(!JSON.stringify(rows).includes("secret"));
});

test("expirySummary with no domains lists every cookie", () => {
  const rows = expirySummary([{ name: "a", domain: "x.com", expires: 5 }], []);
  assert.equal(rows.length, 1);
});
