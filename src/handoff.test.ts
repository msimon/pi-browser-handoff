import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertRestoreKey,
  captureCookies,
  looksLikeLoginUrl,
  openCmuxPane,
  seedRestoreKey,
  verifyRestoreKey,
  type Exec,
  type ExecResult,
} from "./handoff.ts";

type Call = { command: string; args: string[] };

function fakeExec(respond: (c: Call) => Partial<ExecResult> | void): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args) => {
    const call = { command, args };
    calls.push(call);
    return { stdout: "", stderr: "", code: 0, ...(respond(call) ?? {}) };
  };
  return { exec, calls };
}

test("assertRestoreKey accepts simple keys and rejects anything shell- or path-like", () => {
  for (const k of ["notion", "handoff-test", "a_b1"]) assertRestoreKey(k);
  for (const k of ["", "-x", "a/b", "../x", "a b", "x".repeat(65)]) {
    assert.throws(() => assertRestoreKey(k), /restoreKey/);
  }
});

test("looksLikeLoginUrl", () => {
  assert.ok(looksLikeLoginUrl("https://app.notion.com/login"));
  assert.ok(looksLikeLoginUrl("https://github.com/login?return_to=x"));
  assert.ok(looksLikeLoginUrl("https://accounts.google.com/o/oauth2"));
  assert.ok(looksLikeLoginUrl("https://example.com/auth/callback"));
  assert.ok(!looksLikeLoginUrl("https://app.notion.com/p/Daily-Standup-3b12"));
  assert.ok(!looksLikeLoginUrl("https://example.com/author/jane"));
  assert.ok(!looksLikeLoginUrl("not a url"));
});

test("openCmuxPane parses the surface", async () => {
  const { exec, calls } = fakeExec(() => ({ stdout: "OK surface=surface:42 pane=pane:7 placement=split\n" }));
  assert.equal(await openCmuxPane(exec, "https://x.com"), "surface:42");
  assert.deepEqual(calls[0]?.args, ["browser", "open-split", "https://x.com", "--focus", "true"]);
});

test("captureCookies keeps only the requested domains and deletes the dump", async () => {
  let dumpPath = "";
  const { exec } = fakeExec(({ args }) => {
    dumpPath = args[4] ?? "";
    writeFileSync(
      dumpPath,
      JSON.stringify({
        cookies: [
          { domain: ".notion.com", name: "token_v2", value: "s1" },
          { domain: ".brex.com", name: "session", value: "s2" },
        ],
      }),
    );
  });
  const cookies = await captureCookies(exec, "surface:1", ["notion.com"]);
  assert.deepEqual(
    cookies.map((c) => c.name),
    ["token_v2"],
  );
  assert.ok(dumpPath.startsWith("/"), "cmux needs an absolute path");
  assert.ok(!existsSync(dumpPath), "the full dump must be deleted");
});

test("captureCookies deletes the dump even when parsing fails", async () => {
  let dumpPath = "";
  const { exec } = fakeExec(({ args }) => {
    dumpPath = args[4] ?? "";
    writeFileSync(dumpPath, "{ not json");
  });
  await assert.rejects(captureCookies(exec, "surface:1", ["notion.com"]));
  assert.ok(!existsSync(dumpPath));
});

test("seedRestoreKey loads the state file with --restore=<key>, closes to save, and deletes the file", async () => {
  let statePath = "";
  let mode = 0;
  let content = "";
  const { exec, calls } = fakeExec(({ args }) => {
    const i = args.indexOf("--state");
    if (i >= 0) {
      statePath = args[i + 1] ?? "";
      mode = statSync(statePath).mode & 0o777;
      content = readFileSync(statePath, "utf8");
    }
  });
  await seedRestoreKey(exec, "notion", { cookies: [], origins: [] }, "https://app.notion.com");
  const abArgs = calls.map((c) => c.args.join(" "));
  assert.deepEqual(abArgs, [
    "--session notion close",
    `--session notion --restore=notion --state ${statePath} open https://app.notion.com`,
    "--session notion wait 5000",
    "--session notion close",
  ]);
  assert.equal(mode, 0o600);
  assert.deepEqual(JSON.parse(content), { cookies: [], origins: [] });
  assert.ok(!existsSync(statePath));
});

function verifyExec(page: object) {
  return fakeExec(({ args }) => (args.includes("eval") ? { stdout: JSON.stringify(JSON.stringify(page)) + "\n" } : {}));
}

test("verifyRestoreKey passes on a signed-in page and never saves", async () => {
  const { exec, calls } = verifyExec({ url: "https://app.notion.com/p/x", title: "X", chars: 900, signedIn: null, signedOut: false });
  const v = await verifyRestoreKey(exec, "notion", "https://app.notion.com", { signedOutText: "Log in" });
  assert.deepEqual(v, { verified: true, url: "https://app.notion.com/p/x", title: "X" });
  assert.ok(calls.some((c) => c.args.join(" ").includes("--restore=notion --restore-save never open")));
  assert.equal(calls.at(-1)?.args.join(" "), "--session notion close");
});

test("verifyRestoreKey fails on a login redirect or signed-out text", async () => {
  const a = await verifyRestoreKey(
    verifyExec({ url: "https://app.notion.com/login", title: "", chars: 10, signedIn: null, signedOut: null }).exec,
    "notion",
    "https://app.notion.com",
    {},
  );
  assert.equal(a.verified, false);
  assert.match(a.reason ?? "", /login page/);

  const b = await verifyRestoreKey(
    verifyExec({ url: "https://x.com/", title: "", chars: 10, signedIn: null, signedOut: true }).exec,
    "k",
    "https://x.com",
    { signedOutText: "Sign in" },
  );
  assert.match(b.reason ?? "", /Sign in/);
});

test("a failing command surfaces its exit code", async () => {
  const { exec } = fakeExec(() => ({ code: 1, stderr: "boom" }));
  await assert.rejects(openCmuxPane(exec, "https://x.com"), /exit 1.*boom/);
});
