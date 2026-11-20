# hellobox-admin

A terminal dashboard for running HelloBox: usage stats first, then users and
workspaces, with bans and suspensions.

```bash
cargo install --path tools/admin   # or: cargo run --release -- <command>
hellobox-admin                     # opens the dashboard, signing in first if needed
```

It needs a C linker to build (`build-essential` on Ubuntu, `gcc` on Fedora).

## Signing in

Only the emails in the web app's `ADMIN_EMAILS` can sign in. With it empty, the admin
API doesn't exist.

`hellobox-admin login` opens your browser at `/admin/cli`, where you approve the sign-in
as you're signed in to HelloBox:

- You need a sign-in from the last 10 minutes. With an older one, the page asks you to
  sign in again, including two-factor.
- The terminal and the page show the same confirmation code, so you can tell the request
  is yours.
- The browser hands a one-time code to a listener on `127.0.0.1` only. The terminal trades
  it with a PKCE verifier (RFC 7636), so nothing else can use the code, and it works once
  for two minutes.

The admin session lasts 12 hours. It's stored at
`~/.config/hellobox-admin/sessions.json` with `0600` permissions, and the server keeps only
a hash. The admin API takes this bearer token and never a browser cookie. Every request
checks that the email is still in `ADMIN_EMAILS`, verified and not banned, so removing an
address ends that admin's access at once. `hellobox-admin logout` revokes the session.

Plain `http://` URLs are only allowed for `127.0.0.1` and `localhost`.

## Commands

| Command | What it does |
| --- | --- |
| `hellobox-admin` | The dashboard |
| `hellobox-admin stats [--json]` | Usage stats, printed |
| `hellobox-admin whoami` | Who you're signed in as, and until when |
| `hellobox-admin login` / `logout` | Start or end the admin session |
| `hellobox-admin requests export [--out file.html] [--open]` | Provider requests from "Using something else? Tell us", as an HTML page with counts per provider |
| `hellobox-admin requests flush [--yes]` | Delete the requests so far, after you type `flush`. One that arrives meanwhile is kept, and the flush goes in the admin activity log |

`--url` (or `HELLOBOX_URL`) picks the app, `https://hellobox.app` by default. Each URL
keeps its own session. `HELLOBOX_ADMIN_TOKEN` overrides the saved session, for scripts.

## The dashboard

- **Overview**: users, active users, workspaces and, on the hosted build, estimated MRR; verified, two-factor,
  onboarded and active shares; plans (hosted build); sign-ups and new workspaces over 30 days; mail,
  storage, contacts, campaigns and agent use.
- **Users**: search (`/`), filter (`f`: all, banned, unverified) and open (`Enter`).
  - `b` bans, with a reason: it signs them out everywhere, ends their agent connections,
    and blocks sign-in. Admins can't be banned until they're out of `ADMIN_EMAILS`.
  - `u` unbans, and `o` signs them out everywhere.
- **Workspaces**: search by name or owner, filter (all, paying, suspended) and open.
  - `s` suspends, with a reason. Nobody can open it, and its queued mail and campaigns
    stop sending.
  - `u` lifts the suspension.
- **Activity**: every admin sign-in, ban and suspension, with who did it and why.

Press `?` for keys and `q` to quit.
