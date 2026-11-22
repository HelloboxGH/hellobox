# HelloBox conventions

How code, copy and commits look in HelloBox. Maintainers review every pull request
against this page, so reading it first saves you a round of review. Where a rule is
checked automatically, it says so; [the lint rules](#the-lint-rules) lists them all.

New here? Set up the code with the [contributing guide](../CONTRIBUTING.md) first.

## What we accept

HelloBox is open source (AGPL-3.0) and also runs as a hosted service. A few features exist
only in the hosted version: single sign-on, audit logs, billing and plans, and the
marketing site. Pull requests that rebuild those in the open code aren't accepted. That's
a policy, not a judgement of the work.

Everything else is open: the inbox, threading, the composer, every provider, shared
mailboxes, labels, notes, team views, notifications, roles, spam checks, rules, contacts,
templates, campaigns, the MCP server for AI agents, and the instance admin tool.

New hosted-only features may come later. But a feature that's open stays open: we won't
move an existing public feature into the hosted version.

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

## Where things live

HelloBox is a TypeScript monorepo, strict, on [Bun](https://bun.sh). Each folder in `apps`
and `packages` is a *workspace*: its own package, imported by name (`@hellobox/mail`).

| Folder | What's in it |
|---|---|
| `apps/web` | The Next.js app: pages, components and the server actions behind them. |
| `apps/web/app` | Routes. |
| `apps/web/components` | React components. `components/ui` holds the base components everything else builds on. |
| `apps/web/core/server` | Server-only code: the action builders, middlewares, and `actions/*`. |
| `apps/web/core/client` | Browser code, including `call()` for server actions. |
| `apps/worker` | Background jobs on BullMQ: incoming mail, sending, notifications, cleanup. It also runs the database migrations on start. |
| `apps/docs` | This documentation site, built from the Markdown in `docs/`. |
| `packages/mail` | Mail handling: ingest, threading, spam checks, sending. The app and the worker both use it. |
| `packages/providers` | One file per email provider, each implementing `MailProvider`. |
| `packages/db` | The database schema (Drizzle) and its migrations. |
| `packages/config` | Settings: `setting("NAME")` and the list of every variable. |
| `packages/extensions` | The slots where the hosted version plugs in, with open defaults. |
| `packages/nezt` | The small framework behind server actions: builders, middlewares, errors. |
| `packages/email` | The emails HelloBox itself sends (verification, invitations), and SMTP. |
| `packages/queue`, `packages/storage` | The job queue and S3 storage clients. |
| `packages/resend` | The Resend API client, its OAuth flow and webhooks. |
| `packages/eslint-config` | The lint rules on this page. |
| `tools/admin` | `hellobox-admin`, the terminal admin tool, in Rust. |

Put code where it's used: logic both the app and the worker need goes in a package; logic
only one page needs stays next to that page.

## Server actions

Everything the browser asks of the server goes through a *server action*: a typed function
with a path, an access level, validated input and a handler. They live in
`apps/web/core/server/actions/*.ts`.

### Writing one

Pick the builder for who may call it, from `apps/web/core/server/builder.ts`:

| Builder | Who may call it | What `ctx` has |
|---|---|---|
| `publicAction` | Anyone, signed in or not | Nothing extra |
| `userAction` | A signed-in person | `ctx.user` |
| `workspaceAction` | A member of the current workspace | `ctx.user`, `ctx.workspace` |
| `adminAction` | An admin of the current workspace | The same, checked for the admin role |
| `platformAdminAction` | Whoever runs the instance (`ADMIN_EMAILS`), through the admin tool | `ctx.user` |

Choose the narrowest one that works. Then describe the input with `zod` and write the
handler. A real one, from `actions/workspace.ts`:

```ts
export const createLabel = workspaceAction("/labels/create")
  .input(z.object({
    name: z.string().trim().min(1).max(50),
    icon: labelIcon.optional(),
  }))
  .handler(async ({ input, ctx }) => {
    const [label] = await getDb()
      .insert(labels)
      .values({ ...input, workspaceId: ctx.workspace.id })
      .onConflictDoNothing()
      .returning();
    if (!label) throw conflict("This label already exists");
    return label;
  });
```

- **The path** is `/area/verb`, lowercase, with dashes: `/labels/create`,
  `/domains/set-enabled`.
- **Validate everything** in `.input()`. Limit string lengths, trim names, and use
  `z.enum` for a fixed set of values. The handler can then trust `input`.

### Registering it

Each file ends with its action map, and the map is spread into `allActions` in
`apps/web/core/server/actions-manifest.ts`. An action that isn't in a map can't be called.

```ts
export const workspaceActions = {
  "/labels/create": createLabel,
  // ...
};
```

A new file means a new map, added to `allActions`.

### Calling it

From the browser, `call()` from `@/core/client/api` takes the path and the input. Both are
typed from the manifest, so a wrong path or field fails the typecheck:

```ts
import { call } from "@/core/client/api";

const label = await call("/labels/create", { name: "Invoices" });
```

## Every query is scoped

Filter by the workspace (and by the user, when the data is personal) **in the query
itself**. Never load a row by its id alone and check afterwards: a check that's forgotten
once shows one workspace's mail to another.

```ts
// Do: the workspace is part of the query.
await db.update(labels).set(patch)
  .where(and(eq(labels.id, id), eq(labels.workspaceId, ctx.workspace.id)));

// Don't: any workspace's label, checked later (or not).
const [label] = await db.select().from(labels).where(eq(labels.id, id));
```

## Errors people read

Throw the error helpers from `nezt` with a sentence a person understands. Say what
happened and, where it helps, what to do. No stack traces, codes or internal names.

| Helper | When |
|---|---|
| `badRequest("...")` | The input is wrong in a way validation can't see. |
| `forbidden("...")` | The person may not do this. |
| `notFound("Label")` | The thing doesn't exist, or isn't in this workspace. Give the thing's name. |
| `conflict("...")` | It clashes with something that exists. |
| `rateLimitExceeded(...)` | Too many tries. |

```ts
// Do
throw badRequest("Add your provider's base URL in Settings first");
// Don't
throw new Error("ERR_NO_BASE_URL");
```

Unexpected errors (a provider that's down, say) can throw a plain `Error`. Its message can
still reach the person, so write it the same way:
`new Error("This Postmark server has no API token. Add one in Postmark, then try again.")`.

## Addresses from people

A URL that a person typed (a webhook, a notification channel, a remote image, a custom AI
endpoint) goes through `assertPublicUrl` or `postToPublicUrl` from `@hellobox/mail`. They
refuse addresses on the server's own network, so nobody can use HelloBox to reach the
database or another private service.

## Settings

Code reads settings through `@hellobox/config`, never `process.env` or `Bun.env`
directly. *(Checked by lint. Tests and `packages/config` itself are exempt, and
`process.env.NODE_ENV` is allowed, since the browser build needs it.)*

```ts
import { isProduction, setting } from "@hellobox/config";

const url = setting("APP_URL");
if (isProduction()) { /* ... */ }
```

To add a setting:

1. Add its name to `SETTINGS` in `packages/config/src/index.ts`.
2. Add it to `.env.example`, in the right group, with a comment above it: **Required** or
   **Optional**, what it does in plain words, and an `Example:` (or `Generate:` with the
   command for a secret). The [All settings](../.env.example) page on the docs site is built
   from these comments, so they're what self-hosters read.
3. If it's optional, the feature it controls turns off cleanly when it's empty.

*(A test checks that `SETTINGS` and `.env.example` list the same names.)*

## Database and migrations

The schema is in `packages/db/src/schema.ts`, written with Drizzle. To change it:

1. Edit `schema.ts`.
2. Generate the migration:

   ```bash
   bun run db:generate
   ```

   It writes a SQL file and a snapshot to `packages/db/migrations/`. Read the SQL: it's
   what runs on every self-hoster's database.
3. Apply it to your local database:

   ```bash
   bun run db:migrate
   ```

4. Commit `schema.ts` and the generated files together.

Rules:

- **Never edit a generated migration by hand.** Change the schema and generate again.
- **Never change a migration that's already merged.** Self-hosted databases already ran
  it. Fix forward with a new one. *(Checked by CI.)*
- **Migrations only go forward,** and they run on large databases while HelloBox starts.
  Adding a column with a default is fine; rewriting every row of `messages` isn't. For a
  large change, ask first.
- **Every table with workspace data has a `workspaceId`**, so queries can be
  [scoped](#every-query-is-scoped).

## Providers

Each email provider is one implementation of the `MailProvider` interface in
`packages/providers/src/types.ts`:

```ts
export interface MailProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  listDomains(): Promise<ProviderDomain[]>;
  send(message: OutgoingMessage, idempotencyKey: string): Promise<SentMessage>;
  fetchInbound(id: string, hint?: InboundHint): Promise<InboundEmail>;
  listInbound(next?: string): Promise<InboundPage>;
  afterIngest?(id: string): Promise<void>;
  retryFailedInbound?(): Promise<number>;
}
```

A provider only talks to its API: it lists domains, sends, and fetches mail. Everything
after that (storing, threading, spam checks) is in `packages/mail` and is the same for every
provider. Postmark and Mailgun are the shortest examples to start from. A new provider
also needs its connect dialog and webhook route in `apps/web`; ask in a Discussion first,
and we'll point you at each piece.

## Extension points

The open code never imports hosted-only code. *(Checked by lint.)* Where the hosted version
adds behaviour (billing, the audit log), it does so through a *slot* in
`packages/extensions/src/types.ts`. The open code calls the slot if it's there, and does
the open thing if it isn't:

```ts
// Billing isn't installed in the open build, so every workspace is unlimited.
const refused = await getExtensions().billing?.canCreateWorkspace?.(ctx.user.id);
```

Slots have open defaults: `UNLIMITED`, for example, is what a workspace gets without
billing. If your change needs to behave differently in the hosted version, say so in the
pull request; a maintainer adds or extends the slot.

## Tests

Tests sit next to the code as `*.test.ts` and run with `bun test`:

```ts
import { describe, expect, test } from "bun:test";
import { signupsClosed } from "./signups";

describe("closed sign-ups", () => {
  test("only ALLOW_SIGNUPS=false closes them", () => {
    expect(signupsClosed(undefined)).toBe(false);
    expect(signupsClosed("false")).toBe(true);
    expect(signupsClosed(" False ")).toBe(true);
  });
});
```

- **New logic comes with tests.** A bug fix comes with a test that failed before it.
- **Test behaviour, not wiring.** Pass values in (like `signupsClosed(value)` above) rather
  than mocking modules.
- **No network.** Tests that need a provider's API use a fake `fetch`.

```bash
bun test packages apps                          # everything
bun test packages/mail/src/threading.test.ts    # one file
```

## Dependencies

Add one only when it earns its place, with a license compatible with AGPL-3.0, and say why
in the pull request. Prefer what Bun, the platform or an existing dependency already does.

No license headers in source files. The `LICENSE` file covers the repo.

## Interface

### Components

Build with the components in `apps/web/components/ui` (coss ui, on Base UI and
Tailwind 4): `Button`, `Dialog`, `Field`, `Input`, `Badge` and the rest. Import Base UI
directly only inside `components/ui`. *(Checked by lint.)*

Icons come from Phosphor only:

```ts
import { CaretRight, Key } from "@phosphor-icons/react";
```

*(Other icon libraries are refused by lint.)*

### Colors

Colors come from the theme tokens, never Tailwind's palette (`text-amber-500`, `bg-white`)
or hex values, so every color works in light and dark mode. *(Checked by lint.)*

| Token | Use it for |
|---|---|
| `background`, `foreground` | The page and its text. |
| `canvas` | The surface behind panels. |
| `card`, `popover`, `muted`, `accent` | Raised surfaces, menus, quiet text and backgrounds, hover. |
| `primary`, `secondary` | Buttons. |
| `brand`, `brand-soft`, `brand-foreground`, `brand-contrast` | Selection, unread, focus and AI only. |
| `star` | Starred conversations. |
| `success`, `warning`, `info`, `destructive` | Status, each with a `-foreground` for text. |
| `border`, `input`, `ring` | Lines, fields and focus rings. |

```tsx
// Do
<span className="bg-success/12 text-success-foreground">Connected</span>
// Don't
<span className="bg-green-100 text-green-700">Connected</span>
```

Other companies' logos and buttons keep their own brand colors; those are allowed by name
in the lint rule.

### Email content

No `dangerouslySetInnerHTML`. Email HTML is shown in a sandboxed iframe. *(Checked by
lint.)*

### States and feel

- Loading shows skeletons, and every view has a designed empty state.
- Destructive actions confirm in an alert dialog. Undo uses a toast.
- Keyboard first: new actions get a shortcut where it makes sense, shown in the tooltip.
- Motion is rare, uses an exponential ease-out, and respects reduced motion.
- It works on a phone: one panel at a time, the sidebar as a sheet.

## Writing

For interface copy, error messages, docs and commit messages alike:

- Plain words and short sentences. Say what happens, not how clever it is.
- Sentence case for headings and buttons.
- Address the person as "you". Buttons name the action, not "OK" or "Submit".
- No hype, no exclamation marks, no emoji in the product.

| Do | Don't |
|---|---|
| Connect a provider | Connect A Provider |
| Delete domain | OK |
| This label already exists | Error 409: duplicate key |
| Couldn't reach Postmark. Check your token and try again. | Oops! Something went wrong 😕 |
| Messages arrive as soon as your provider gets them. | Blazing-fast, real-time email delivery! |

## Commits and pull requests

- **One change per pull request.** Small is easier to review and to import.
- **The commit subject** is imperative and says what changes, in under about 70
  characters: "Show the sender's provider in the thread header", not "Fixed stuff" or
  "feat: header". The body says why.
- **Breaking changes:** add a line that starts with `Breaking:` to the commit body and
  says what people must do, for example
  `Breaking: SMTP_HOST is now MAIL_HOST; rename it in your .env.` Release notes list
  these first, and self-hosters read them before they upgrade.
- **Everything is public.** Commit messages, pull request titles and descriptions end up
  in the history and the release notes. Keep customer names, private URLs and secrets out.
- **Sign the CLA** when the bot asks. We can't import a pull request without it.
- **Pull requests aren't merged on GitHub.** Once accepted, a maintainer imports your
  change into the repository HelloBox is built from. It then comes back here as a commit
  with you as the author, and your pull request is closed with a link to it. That's normal.

## The lint rules

`bun run lint` checks these in the open code:

| Rule | What it stops |
|---|---|
| No hosted-only imports | Importing a `cloud` folder or package from open code. |
| `@ext` entry points | Importing `@ext/...` (where the hosted code plugs in) anywhere but the app's own entry point, such as `@ext/server` in `apps/web`. |
| Phosphor icons only | Other icon libraries. |
| Base UI in `components/ui` only | Bare Base UI elsewhere. |
| `hellobox/no-hard-coded-colors` | Tailwind palette classes and hex colors outside the brand list. |
| `react/no-danger` | `dangerouslySetInnerHTML`. |
| Settings through config | `process.env` and `Bun.env` outside `packages/config` and tests. |

Where a rule really can't apply, turn it off for that one line, with the reason:

```ts
// eslint-disable-next-line hellobox/no-hard-coded-colors -- the Mailgun logo's own red
```

## Before you open a pull request

```bash
bun install
bun run typecheck
bun run lint
bun test packages apps
```

The same checks run on every pull request.
