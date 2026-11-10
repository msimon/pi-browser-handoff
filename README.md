# pi-browser-handoff

Hand a website login from the [cmux](https://cmux.com) browser to headless [agent-browser](https://github.com/vercel-labs/agent-browser), so pi automations and scheduled jobs can use sites that need you to sign in.

Headless Chrome cannot do most interactive sign-ins: Google refuses it, and 2FA or passkeys need you. The cmux browser can. This package adds a `browser_handoff` tool: you sign in once in a cmux pane, it copies **only that site's cookies** into a named agent-browser restore session, checks headless that it is signed in, and closes the pane. Headless runs then reuse it with `--session <key> --restore <key>`.

## What you get

- **`browser_handoff` tool**
  - `action: "login"`: opens a cmux browser pane at `url`, waits for you to confirm in pi that you signed in, copies the cookies for `domains` (subdomains included) into `restoreKey`, reopens it headless to verify, closes the pane. Returns a cookie count and the verified page; never cookie values.
  - `action: "status"`: when the restore key was last saved, and each matching cookie's name and expiry.
- **`browser-handoff` skill**: when to use a saved password (`agent_browser auth save`), a handoff, or a cmux pane for bot-protected sites; how long sessions last; what scheduled runs do when a login is gone.

## Install

```bash
pi install git:github.com/msimon/pi-browser-handoff
```

Requires pi running inside cmux, the `cmux` CLI, the `agent-browser` CLI (0.38+), and [pi-agent-browser-native](https://www.npmjs.com/package/pi-agent-browser-native) for the `agent_browser` tool.

## How it works

1. `cmux browser open-split <url>` opens the pane; you sign in.
2. `cmux browser <surface> state save <tmp>` dumps the browser state. That dump holds **every** cookie in the cmux browser, so it is written into a fresh 0700 temp directory, filtered to `domains` in memory, and deleted in a `finally`.
3. The kept cookies are converted to Playwright storage-state form, written to a 0600 temp file, and loaded with `agent-browser --session <key> --restore=<key> --state <file> open <checkUrl>`; closing the session saves it under the restore key. `--state` wins over an existing stale save, so re-running a handoff replaces an expired login. The temp file is deleted.
4. The session is reopened headless with only `--restore` (and `--restore-save never`) and checked: no login URL, no `signedOutText`, `signedInText` present if given.

No cookie value is passed on a command line, printed, or returned to the model.

## Session lifetime

Some sites renew their session cookie on every use (Notion reissues `token_v2` with a fresh one-year expiry), and `--restore` saves the renewed copy, so a regularly used session stays signed in. Others force a fresh sign-in after a fixed time. Use `action: "status"` to see which kind you have.

Sites behind bot protection (Cloudflare "Just a moment...") block headless Chrome regardless of cookies; automate those in a cmux browser pane instead.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
