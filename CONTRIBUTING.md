# Contributing to HelloBox

Thanks for helping. This page covers how to run HelloBox locally, what we accept, and what
happens to your pull request. How the code, copy and commits should look is in
[the conventions](docs/CONVENTIONS.md); read it before your first pull request.

## Before you start

- **Bugs:** open an issue with what you did, what you expected and what happened. For a
  security problem, don't open an issue: report it privately with **Report a
  vulnerability** on the repository's Security tab.
- **Questions and ideas:** ask in
  [Discussions](https://github.com/HelloboxGH/hellobox/discussions).
- **Small fixes** (a typo, a clear bug with an obvious fix): open a pull request straight away.
- **Anything larger** (a feature, a new provider, a change to how something works): open an
  issue or a Discussion first, so we can agree on the approach before you spend the time.

### What we accept

HelloBox is open source and also runs as a hosted service. A few features exist only in the
hosted version: single sign-on, audit logs, billing and plans, and the marketing site. Pull
requests that rebuild those aren't accepted. That's a policy, not a judgement of the work.
Everything else is open, including every provider, shared mailboxes, rules, campaigns, the
MCP server and the instance admin tool. New hosted-only features may come later, but an
open feature stays open: we won't move an existing public feature into the hosted version.

## Run it locally

You need [Bun](https://bun.sh) 1.4.2, Node.js 20 or later (Next.js runs on it), and Docker
for Postgres, Redis and rspamd. Rust is only needed for the admin tool in `tools/admin`.

```bash
git clone https://github.com/HelloboxGH/hellobox.git
cd hellobox
bun install
cp .env.example apps/web/.env.local
cp .env.example apps/worker/.env.local
```

In both `.env.local` files, set `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` to the same
values (`openssl rand -base64 32` makes each one). The other defaults already work with the
development services. Then:

```bash
bun run services:up    # Postgres, Redis and rspamd in Docker
bun run db:migrate     # create the tables
bun run dev            # the app on http://127.0.0.1:3010, and the worker
```

Sign up in the app. Without `SMTP_URL` or `RESEND_API_KEY`, emails HelloBox would send
(sign-in links, invitations) are printed in the terminal instead. To try the admin tool in
`tools/admin`, put your address in `ADMIN_EMAILS`.

To receive real mail locally, a provider has to reach your machine: use a tunnel (such as
`cloudflared` or `ngrok`) and set `APP_URL` to its address.

`bun run services:down` stops the services. Your data stays in Docker volumes.

## Make the change

- One change per pull request. Small ones are reviewed faster.
- New logic comes with tests next to the code (`*.test.ts`); a bug fix comes with a test
  that fails without it.
- A database change: edit `packages/db/src/schema.ts`, then run `bunx drizzle-kit generate`
  in `packages/db`. Never edit a migration that's already merged; CI refuses it.
- A new setting goes through `packages/config` and in `.env.example` with a comment.

Before you push, run the same checks CI runs:

```bash
bun run typecheck
bun run lint
bun test packages apps
```

Lint checks most of [the conventions](docs/CONVENTIONS.md): no hosted-only imports,
Phosphor icons, theme colors, settings through `packages/config`. If a rule really can't
apply to a line, disable it for that line and say why:
`// eslint-disable-next-line <rule> -- <reason>`.

## Open the pull request

- Write the commit subject in the imperative ("Show the sender's provider in the thread
  header") and say why in the body. If anything breaks for people running HelloBox, add a
  line that starts with `Breaking:` and says what they must do. Release notes list those
  first.
- Commit messages, the title and the description are public and end up in the history and
  the release notes. Keep customer names, private URLs and secrets out.
- **Sign the CLA.** A bot asks on your first pull request. It's a one-time click, and we
  can't take the change without it. You keep the copyright to your work; the agreement lets
  us ship it in both the open and the hosted version.

## What happens next

A maintainer reviews it here, and may ask for changes. Once it's accepted:

1. It gets the `accepted` label, and within the hour your change is imported into the
   repository HelloBox is built from, with you as the author.
2. The full CI runs on it there, and a maintainer merges it.
3. Your commit comes back to this repository, and your pull request is closed with a link
   to it. **Pull requests aren't merged on GitHub**, so seeing it closed rather than merged
   is normal.

If an import fails (usually because `main` moved and the change no longer applies), the
label changes to `import-failed`. Rebase on `main`, push, and say so in the pull request.

Releases go out every Monday when `main` changed, named by date (`2026.11.1`). Your change
is in the next one.

## License

HelloBox is licensed under the [GNU Affero General Public License v3.0](LICENSE). By
contributing, you agree to the CLA described above.
