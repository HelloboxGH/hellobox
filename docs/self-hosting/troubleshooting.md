# Troubleshooting

Find what you see below. Run every command on the server, in `~/hellobox/docker`.

## Reading the logs

Each part of HelloBox writes a log: a running list of what it does, and what went wrong.
It's almost always the fastest way to the answer.

```bash
docker compose ps                       # Which parts run, and whether they're healthy
docker compose logs worker --tail 50    # The last 50 lines of one part
docker compose logs -f web              # Follow a log live; Ctrl+C to stop
```

The parts are `web` (the app), `worker` (background jobs, database updates, incoming mail),
`postgres` (the database), `redis` (the job queue), `rspamd` (the spam filter) and
`storage` (attachments). Errors are usually near the end, and often name a setting.

> **Never run `docker compose down -v`.** The `-v` deletes the database and the files, for
> good. `docker compose down` (without `-v`) is safe: it only stops HelloBox, and
> `docker compose up -d` starts it again.

After you change `.env`, always run `docker compose up -d` to apply it.

## Starting up

| What you see | What to do |
|---|---|
| `up` says `Set POSTGRES_PASSWORD in .env` (or another name) | That setting is empty. Fill it in `.env`, then `docker compose up -d`. |
| `permission denied while trying to connect to the Docker daemon` | Your user isn't in the `docker` group yet. See [Install Docker](server.md#install-docker), then disconnect and connect again. |
| A part says `unhealthy` or `Restarting` | Read its log. The worker's log shows database errors. |
| `web` waits for a long time | It waits for the worker. Read the worker's log. |
| `Bind for 127.0.0.1:3000 failed: port is already allocated` | Something else uses that port. Set `WEB_PORT=3001` in `.env` (or `STORAGE_PORT`), and use the same port in the Caddyfile. |
| The server runs out of memory or disk | Check with `free -h` and `df -h`. Old images pile up after upgrades: `docker image prune` removes unused ones. |

## The website

| What you see | What to do |
|---|---|
| The page doesn't load at all | See [Check it](https.md#check-it) on the HTTPS page. |
| A certificate warning | Caddy hasn't got the certificate yet. Check its log: `sudo journalctl -u caddy --no-pager \| tail -30`. |
| The page loads, but sign-in fails or loops | `APP_URL` must be exactly the address in the browser, with `https://` and no `/` at the end. |
| `502 Bad Gateway` | Caddy works, HelloBox doesn't. Run `docker compose ps`. |

## Signing in

| What you see | What to do |
|---|---|
| The confirmation email never comes | Look in spam. Then `docker compose logs web --tail 50`: it shows why sending failed. Check `SMTP_URL` (special characters in the password must be [encoded](install.md#with-your-providers-smtp-details)) and that your provider lets `EMAIL_FROM` send. |
| "Sign-ups are closed on this server" | `ALLOW_SIGNUPS=false` is set. Invite the person from **Settings → Team**, or add them to `ADMIN_EMAILS`. |
| The Google or GitHub button is missing | Both of its settings must be filled in, then `docker compose up -d`. |
| `hellobox-admin login` is refused | Your address must be in `ADMIN_EMAILS`, signed up and confirmed. |

## Mail doesn't arrive

1. In **Settings → Domains**, does the domain show every record as found? If not, add the
   missing ones at your DNS host and press **Check again**.
2. Does your server [answer from the internet](providers.md#check-that-your-server-is-reachable)?
3. Look at your provider's dashboard. Most show each webhook call and its result. An error
   there (like `401`, `404` or a timeout) says the call didn't get through.
4. Read the worker's log right after you send a test: `docker compose logs -f worker`.

| What you see | What to do |
|---|---|
| The provider says it can't reach the webhook | `APP_URL` has to work from the internet over HTTPS. |
| **Connect Resend** shows an error, or Resend says the redirect is invalid | `RESEND_OAUTH_CLIENT_ID` and `RESEND_OAUTH_CLIENT_SECRET` are missing, or the app was registered with another address. [Register again](providers.md#1-register-your-instance-with-resend-once) with your exact `APP_URL`. |
| **Amazon SES** isn't in the list | One of the five `AWS_*` settings is empty. See [Part 1](providers.md#part-1-set-up-the-broker-once). |
| The SES stack fails with `ROLLBACK_COMPLETE` | See [Part 2](providers.md#part-2-connect-your-aws-account). |
| You changed `APP_URL` after connecting | The provider still calls the old address. Reconnect the provider in **Settings → Domains**. |
| Mail arrives late | Check the worker's log and `docker compose ps`; a stopped worker means no new mail. |
| Mail lands in the spam folder in HelloBox | That's the spam filter's (rspamd's) verdict. Open the spam folder and move it out. |

## Sending

| What you see | What to do |
|---|---|
| Replies fail to send | Read the error in HelloBox, then the worker's log. Often your provider refuses the sender: the domain must be verified there. |
| Replies end up in spam for others | Your domain's SPF and DKIM records are missing. **Settings → Domains** shows them. |

## Attachments

| What you see | What to do |
|---|---|
| Uploads fail | Open `https://files.example.com/health`: it should show `"status":"ok"`. Check `S3_PUBLIC_ENDPOINT`, the `files` DNS record and its Caddy block. |
| Uploads fail with your own S3 | Check the bucket's [CORS rule](storage.md#2-allow-uploads-from-hellobox). |

## What to include when you ask for help

If you're stuck, ask in [GitHub Discussions](https://github.com/HelloboxGH/hellobox/discussions),
or [open an issue](https://github.com/HelloboxGH/hellobox/issues) for a bug. Include:

- What you did, what you expected, and what happened instead.
- Your version and setup:

  ```bash
  git describe --tags
  docker compose images
  docker compose ps
  ```

- The last lines of the log of the part that fails, for example
  `docker compose logs worker --tail 100`.

**Before you paste, remove secrets.** Never post your `.env`, passwords, API keys or tokens.
If a log line shows one, replace it with `***`. If you posted one by accident, change it at
once.

A security problem goes in private: use **Report a vulnerability** on the repository's
Security tab, never a public issue.
