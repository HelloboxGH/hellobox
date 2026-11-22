# Self-hosting HelloBox

This section takes you from nothing to HelloBox running on your own server, at your own
address. You don't need to have run a server before. Every step says what to type, what you
should see, and what to do when you don't see it.

> **Read this first.** When you host HelloBox yourself, your email is yours to protect. You
> run the server, the database, the backups, the updates and the security of everything on
> it, including every message you receive. A mistake can expose or lose mail. If that's
> more than you want to take on, use the hosted version at
> [hellobox.app](https://hellobox.app) and let us run it.

## What you end up with

- HelloBox at an address you choose, such as `https://mail.example.com`, with a valid
  HTTPS certificate.
- Your team's mail arriving through the email provider you already use (Amazon SES,
  Postmark, Mailgun or Resend). HelloBox reads and sends through your provider account, so
  you keep your provider. Self-hosting means you also keep the inbox.
- Everything on one server you control. It runs these parts, each in its own container (a
  sealed-off package with everything that part needs):

| Part | What it does |
|---|---|
| **web** | The app you open in the browser. |
| **worker** | Works in the background: takes in new mail, sends, checks for spam, sends notifications. |
| **postgres** | The database: messages, people, workspaces and settings. |
| **redis** | The worker's to-do list, so no job gets lost when something restarts. |
| **rspamd** | The spam filter. |
| **storage** | Keeps attachments and the original copy of every email. You can use your own S3 storage instead. |

## Time and cost

- **Time:** about an hour the first time. Most of it is waiting: for the server to start,
  for DNS changes to spread, for downloads.
- **Cost:** HelloBox is free. You pay for a small server (a few dollars or euros a month at
  most hosting companies), a domain name if you don't have one, and your email provider's
  own prices.

## The steps

Follow these in order. Each page ends where the next one starts.

1. [Before you start](before-you-start.md): the words you'll meet, and what to get ready.
2. [Get a server ready](server.md): create the server, connect to it, secure it, install
   Docker.
3. [Point your domain at the server](dns.md): two DNS records.
4. [Install HelloBox](install.md): download it, write your settings, start it.
5. [Turn on HTTPS](https.md): put Caddy in front, so it's reachable at `https://`.
6. [Sign in and invite your team](sign-in.md): your account, sign-ups, the admin tool.
7. [Connect your email provider](providers.md): so mail arrives and sends.

## Once it's running

- [Back up and restore](backups.md): do this before you rely on it.
- [Upgrade to a new version](upgrade.md).
- [Use your own S3 storage](storage.md) instead of the bundled one.
- [All settings](../../.env.example): every setting, explained.
- [If something goes wrong](troubleshooting.md).

## Getting help

- Questions, and "is this normal?": [GitHub Discussions](https://github.com/HelloboxGH/hellobox/discussions).
- Something is broken: [GitHub Issues](https://github.com/HelloboxGH/hellobox/issues). Say
  which version you run and what the logs show ([how to find both](troubleshooting.md#what-to-include-when-you-ask-for-help)).
- A security problem: report it privately with **Report a vulnerability** on the
  repository's Security tab, never in public.
