// @msimon/pi-browser-handoff — hand a website login from the cmux browser to
// headless agent-browser.
//
// The user signs in once in a cmux browser pane (where Google sign-in, 2FA and
// passkeys work), the tool copies only that site's cookies into a named
// agent-browser restore session, and headless runs (scheduled jobs included)
// reuse it with `--session <key> --restore <key>`. Sites that renew their
// session on use stay signed in indefinitely; the rest need another handoff
// when they expire.

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeDomain } from "./cookies.ts";
import {
  assertRestoreKey,
  captureCookies,
  closeCmuxPane,
  openCmuxPane,
  seedRestoreKey,
  sessionStatus,
  verifyRestoreKey,
  type Exec,
} from "./handoff.ts";

const PARAMS = Type.Object({
  action: Type.Union([Type.Literal("login"), Type.Literal("status")], {
    description:
      "login: open a cmux browser pane, wait for the user to sign in, copy that site's cookies into the restore key and verify headless. " +
      "status: report when the restore key was last saved and when its cookies expire.",
  }),
  restoreKey: Type.String({
    description:
      "agent-browser session and restore key to fill or inspect (letters, digits, - and _). " +
      "Headless runs then use `--session <key> --restore <key>`. Reuse the key a skill already uses (e.g. `notion`).",
  }),
  domains: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Base domains whose cookies to copy; subdomains are included (`notion.com` covers `app.notion.com`). " +
        "Required for login. For status, filters the cookie list.",
    }),
  ),
  url: Type.Optional(Type.String({ description: "For login: the page to open for the user to sign in on." })),
  checkUrl: Type.Optional(
    Type.String({
      description: "For login: a page that needs the login, opened headless to verify. Defaults to `url`.",
    }),
  ),
  signedInText: Type.Optional(
    Type.String({ description: "For login: text that only appears when signed in, checked during verification." }),
  ),
  signedOutText: Type.Optional(
    Type.String({ description: 'For login: text that only appears when signed out (e.g. "Log in"), checked during verification.' }),
  ),
});

let loginInProgress = false;

export default function browserHandoff(pi: ExtensionAPI): void {
  const exec: Exec = (command, args, options) => pi.exec(command, args, options);

  pi.registerTool(
    defineTool({
      name: "browser_handoff",
      label: "Browser handoff",
      description:
        "Copy a website login from the cmux browser into a named headless agent-browser session, or report on one. " +
        "action=login opens a cmux browser pane, waits for the user to confirm they signed in, copies only the given domains' cookies " +
        "into the restore key, verifies headless and closes the pane. Cookie values are never returned. " +
        "Needs an interactive pi session running inside cmux.",
      promptSnippet: "browser_handoff: user signs in once in a cmux pane; headless agent_browser reuses that login",
      promptGuidelines: [
        "Use browser_handoff action=login when a site needs the user to sign in for agent_browser automation; never open a headed agent_browser window for the user to sign in.",
        "In a scheduled or non-interactive run, do not call browser_handoff action=login; report that the session expired and that the user should run browser_handoff.",
        "Never read or print cookie or agent-browser session files yourself; browser_handoff action=status reports expiry without values.",
      ],
      parameters: PARAMS,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        assertRestoreKey(params.restoreKey);
        const domains = (params.domains ?? []).map(normalizeDomain).filter((d) => d !== "");

        if (params.action === "status") {
          const s = await sessionStatus(params.restoreKey, domains);
          const text = !s.exists
            ? `No saved session for restore key \`${s.restoreKey}\`. Run browser_handoff action=login to create it.`
            : [
                `Restore key \`${s.restoreKey}\`: last saved ${s.savedAt}.`,
                s.cookies.length === 0
                  ? `No cookies${domains.length ? ` for ${domains.join(", ")}` : ""}: the session is probably signed out.`
                  : `${s.cookies.length} cookies, latest expiry first:\n` +
                    s.cookies
                      .slice(0, 20)
                      .map((c) => `- ${c.name} (${c.domain}): ${c.expires}`)
                      .join("\n") +
                    (s.cookies.length > 20 ? `\n- … ${s.cookies.length - 20} more` : ""),
              ].join("\n");
          return { content: [{ type: "text", text }], details: s };
        }

        // action === "login"
        if (!params.url) throw new Error("`url` is required for action=login.");
        if (domains.length === 0) throw new Error("`domains` is required for action=login, e.g. [\"notion.com\"].");
        if (!ctx.hasUI) {
          throw new Error(
            "browser_handoff login needs an interactive pi session: the user has to sign in. " +
              "In a scheduled run, report that the session expired instead.",
          );
        }
        if (!process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SURFACE_ID) {
          throw new Error("browser_handoff login needs pi running inside cmux (no CMUX_WORKSPACE_ID in the environment).");
        }
        if (loginInProgress) throw new Error("Another browser_handoff login is already waiting for the user.");

        loginInProgress = true;
        let surface: string | undefined;
        try {
          const host = new URL(params.url).hostname;
          surface = await openCmuxPane(exec, params.url, signal);
          onUpdate?.({
            content: [{ type: "text", text: `Opened ${host} in a cmux pane; waiting for the user to sign in.` }],
            details: { stage: "waiting" },
          });

          const ok = await ctx.ui.confirm(
            `Sign in to ${host}`,
            `Sign in in the browser pane on the right (Google, 2FA and passkeys work there). ` +
              `Choose Yes once you are signed in and the page has loaded, or No to cancel.`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Cancelled by the user; nothing was copied." }],
              details: { cancelled: true },
            };
          }

          const cookies = await captureCookies(exec, surface, domains, signal);
          if (cookies.length === 0) {
            throw new Error(
              `The cmux browser has no cookies for ${domains.join(", ")}. Check the domains, and that sign-in finished.`,
            );
          }

          onUpdate?.({
            content: [{ type: "text", text: `Copying ${cookies.length} cookies into \`${params.restoreKey}\`…` }],
            details: { stage: "seeding" },
          });
          const checkUrl = params.checkUrl ?? params.url;
          await seedRestoreKey(exec, params.restoreKey, { cookies, origins: [] }, checkUrl, signal);

          onUpdate?.({
            content: [{ type: "text", text: "Verifying headless…" }],
            details: { stage: "verifying" },
          });
          const v = await verifyRestoreKey(
            exec,
            params.restoreKey,
            checkUrl,
            { signedInText: params.signedInText, signedOutText: params.signedOutText },
            signal,
          );

          const details = {
            restoreKey: params.restoreKey,
            domains,
            cookies: cookies.length,
            ...v,
          };
          const use = `agent_browser args: ["--session","${params.restoreKey}","--restore","${params.restoreKey}","open","<url>"]`;
          if (!v.verified) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `Copied ${cookies.length} cookies into \`${params.restoreKey}\`, but the headless check failed: ${v.reason} ` +
                    `(${v.url}). The site may keep its login outside cookies, block headless browsers, or need different domains. ` +
                    `If it blocks headless browsers, automate it in the cmux browser instead.`,
                },
              ],
              details,
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `Signed in and saved as restore key \`${params.restoreKey}\` (${cookies.length} cookies for ${domains.join(", ")}). ` +
                  `Verified headless: "${v.title}" at ${v.url}.\nUse it with ${use}`,
              },
            ],
            details,
          };
        } finally {
          loginInProgress = false;
          if (surface) await closeCmuxPane(exec, surface);
        }
      },
    }),
  );
}
