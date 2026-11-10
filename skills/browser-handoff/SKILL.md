---
name: browser-handoff
description: Get a website login into headless agent_browser so automations and scheduled jobs can use it. Use when an automation needs a site the user must sign in to, when a skill or job reports a browser session expired or not-authenticated, when choosing how a recurring browser job should authenticate, or when the user asks how long a saved browser login lasts. Covers the three routes (saved password, cmux sign-in handed off with the browser_handoff tool, cmux-only for bot-protected sites) and what scheduled runs must do when a login is gone.
---

# Browser handoff

Headless `agent_browser` cannot do most interactive sign-ins: Google refuses its Chrome ("This browser or app may not be secure"), and 2FA or passkeys need the user. The cmux browser can, because it is a real browser the user drives. The `browser_handoff` tool bridges the two: the user signs in once in a cmux pane, and the tool copies **only that site's cookies** into a named agent-browser restore session that headless runs reuse.

## Pick the route first

| The site signs in with | Route | Headless runs use |
|---|---|---|
| Email + password, no 2FA (or 2FA with "remember this device") | **Saved password.** `agent_browser auth save <name> --url <login-url> --username <u> --password-stdin` (password in the tool's `stdin`, never in `args`). Logs in fresh every run, nothing to expire. | `["auth","login","<name>"]` with `sessionMode: "fresh"` |
| Google / SSO / magic link / passkey / 2FA every time | **Handoff.** `browser_handoff` action=login, below. | `["--session","<key>","--restore","<key>", ...]` |
| Anything, but headless gets a challenge page ("Just a moment...", CAPTCHA) even when signed in | **cmux only.** Bot protection blocks headless Chrome whatever its cookies. Automate it with `cmux browser <surface> ...` in a pane instead. | a cmux browser pane |

Not sure which? Do the handoff. If its headless check fails on a challenge page, it is the third row.

## Handoff: `browser_handoff` action=login

```json
{
  "action": "login",
  "url": "https://app.notion.com",
  "domains": ["notion.com", "notion.so"],
  "restoreKey": "notion",
  "signedOutText": "Log in"
}
```

1. Tell the user a pane will open on the right and they should sign in there, then call the tool. It opens the pane and shows a confirmation dialog in pi; the user picks Yes once signed in.
2. The tool copies the matching cookies, seeds the restore key, reopens it headless to verify, and closes the pane. It returns the cookie count, the verified page, and the `agent_browser` args to use. It never returns cookie values.

Choosing the inputs:

- **`domains`**: the site's base domains. Subdomains are included. List every base domain the site uses for its login (Notion: `notion.com` and `notion.so`). Do not include `google.com` or other identity providers: the site's own session cookie is what keeps it signed in, and copying Google's would hand over far more than this site.
- **`restoreKey`**: one per site, reused forever. If a skill already uses a key (`standup-tasks` uses `notion`), pass that same key so the skill picks the login up with no change.
- **`checkUrl`**: a page that needs the login, when `url` is a public landing page.
- **`signedOutText` / `signedInText`**: text that only shows when signed out ("Log in", "Sign in") or signed in (a workspace name). Makes the check reliable on sites that do not redirect to a `/login` URL.

Requirements: an interactive pi session (the user has to sign in) running inside cmux. The tool refuses otherwise.

## How long a handoff lasts

Check with action=status, which lists each cookie's name and expiry, never its value:

```json
{ "action": "status", "restoreKey": "notion", "domains": ["notion.com"] }
```

Two kinds of site:

- **Renewing.** Every use reissues the session cookie with a fresh expiry, and `--restore` saves the renewed copy when the session closes. Notion does this (`token_v2` gets a new one-year expiry each run), so a job that runs regularly stays signed in until the user changes their password, signs out everywhere, or the site resets sessions.
- **Fixed lifetime.** Banks, insurers, admin consoles and many SSO apps force a fresh sign-in after a set time however often you use them. Expect to hand off again: days to weeks, depending on the site.

Do not promise a session will last. When it matters, run action=status after the first few scheduled runs and see whether the expiry moves forward.

## In a scheduled or non-interactive run

Nobody can sign in, so never call action=login there, and never fall back to guessing or a partial result. Detect the signed-out state (a redirect to a login URL, signed-out text, or a skill's own `not-authenticated` check), stop, and report:

```
PI_JOB_STATUS: failure - <site> session expired; run browser_handoff (restoreKey <key>) in an interactive pi session
```

The user then runs the handoff once and the next scheduled run picks the login up.

## Safety

- Never read, print or copy `~/.agent-browser/sessions/*.json` or a cmux state file yourself. They hold live session cookies. The tool is the only thing that touches them.
- `cmux browser state save` writes every cookie the cmux browser has (every site the user is signed into). The tool deletes that dump immediately and keeps only the requested domains. Do not run `cmux browser state save` yourself to work around a tool error.
- Do not open a headed `agent_browser` window for the user to sign in. Sign-ins the user does go through cmux.
