# HelloBox conventions

How code, copy and commits look in HelloBox. Maintainers review every pull request
against this page, so reading it first saves you a round of review. Where a rule is
checked automatically, it says so.

## What we accept

HelloBox is open source (AGPL-3.0) and also runs as a hosted service. A few features exist
only in the hosted version: single sign-on, audit logs, billing and plans, and the
marketing site. Pull requests that rebuild those in the open code aren't accepted. That's
a policy, not a judgement of the work.

Everything else is open: the inbox, threading, the composer, every provider, shared
mailboxes, labels, notes, team views, notifications, roles, spam checks, rules, contacts,
templates, campaigns, the MCP server for AI agents, and the instance admin tool.

Before a large change, open a Discussion or an issue first, so we can agree on the
approach before you spend the time.

## The principles every change keeps

These come before any style rule. A change that breaks one is declined however good the
rest is.

- **Never lose mail.** Store an incoming message (or the webhook event that announces it)
  before acknowledging it. A failure must leave something to retry, never nothing.
- **Nothing sends unless a person decided it.** Someone pressed Send, or gave an AI agent
  the `send` permission themselves. Rules and other automation sort, draft and suggest;
  they never send on their own.
- **Explain automated decisions.** When HelloBox marks something as spam, files it or
  hides it, the person can see why.
- **Private by default.** Remote images stay blocked until someone allows them. Data from
  one workspace is never visible from another.

## Code

- **TypeScript, strict, on Bun.** A Bun monorepo: `apps/web` (Next.js), `apps/worker`
  (BullMQ jobs), `packages/*` (shared code), `tools/admin` (the Rust admin TUI).
- **Server actions** go through `nezt`, in `apps/web/core/server/actions/*`. Each file
  defines actions with `workspaceAction("/area/verb")` (or `userAction`, `adminAction`,
  `publicAction` when that's the right level of access), validates
  input with `zod`, and lists them in its action map. The client calls them with
  `call("/area/verb")`.
- **Every query is scoped.** Filter by the workspace (and the user, when the data is
  personal) in the query itself. Never load a row by id alone and check afterwards.
- **Errors people read.** Throw `badRequest`, `forbidden` or `notFound` from `nezt` with a
  sentence that says what happened and, where it helps, what to do. No stack traces or
  codes in messages.
- **URLs from people** (webhooks, notification channels, images) go through
  `assertPublicUrl` / `postToPublicUrl` from `@hellobox/mail`, so they can't reach the
  server's own network.
- **Database:** change `packages/db/src/schema.ts`, then generate the migration with
  `bunx drizzle-kit generate` in `packages/db`. Never edit a generated migration by hand,
  and never change one that's already merged.
- **Settings** are read through `packages/config`. A new variable also goes in
  `.env.example`, grouped, with a comment: required or optional, what it does, an example.
- **Providers** implement the `MailProvider` interface in `packages/providers`. Mail
  handling (ingest, threading, spam, sending) lives in `packages/mail`, not in the app.
- **Extension points:** the open code never imports hosted-only code. Where the hosted
  version adds behaviour, it does so through a slot in `packages/extensions`. *(Checked by
  lint.)*
- **Tests** sit next to the code as `*.test.ts` and run with `bun test`. New logic comes
  with tests; a bug fix comes with a test that failed before it.
- **Dependencies:** add one only when it earns its place, with a license compatible with
  AGPL-3.0. Say why in the pull request.
- **No license headers** in source files. The `LICENSE` file covers the repo.

## Interface

- Build with the coss ui components in `apps/web/components/ui` (Base UI and Tailwind 4)
  and Phosphor icons, not bare Base UI or native controls.
- Colors come from the theme tokens (`--brand`, `--canvas`, `--primary`, and the
  `success` / `warning` / `info` / `destructive` status tokens), never hard-coded values.
  The brand color is for selection, unread, focus and AI only.
- Loading shows skeletons, and every view has a designed empty state.
- Destructive actions confirm in an alert dialog. Undo uses a toast.
- Keyboard first: new actions get a shortcut where it makes sense, shown in the tooltip.
- Motion is rare, uses an exponential ease-out, and respects reduced motion.
- It works on a phone: one panel at a time, the sidebar as a sheet.

## Writing

For interface copy, error messages, docs and commit messages alike:

- Plain words and short sentences. Say what happens, not how clever it is.
- Sentence case for headings and buttons ("Connect a provider", not "Connect A Provider").
- Address the person as "you". Buttons name the action ("Send", "Delete domain"), not
  "OK" or "Submit".
- No hype, no exclamation marks, no emoji in the product.

## Commits and pull requests

- **One change per pull request.** Small is easier to review and to import.
- **The commit subject** is imperative and says what changes, in under about 70
  characters: "Show the sender's provider in the thread header". The body says why.
- **Breaking changes:** add a line that starts with `Breaking:` to the commit body and
  says what people must do, for example
  `Breaking: SMTP_HOST is now MAIL_HOST; rename it in your .env.` Release notes list
  these first.
- **Everything is public.** Commit messages, pull request titles and descriptions end up
  in the history and the release notes. Keep customer names, private URLs and secrets out.
- **Sign the CLA** when the bot asks. We can't import a pull request without it.
- **Pull requests aren't merged on GitHub.** Once accepted, a maintainer imports your
  change into the repository HelloBox is built from. It then comes back here as a commit
  with you as the author, and your pull request is closed with a link to it. That's normal.

## Before you open a pull request

```bash
bun install
bun run typecheck
bun run lint
bun test packages apps
```

The same checks run on every pull request.
