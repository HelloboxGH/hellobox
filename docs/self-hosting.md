# Self-hosting HelloBox

> **Read this first.** Your email is yours to protect if you host HelloBox yourself. You
> run the server, the database, the backups, the updates and the security of everything in
> it, including every message you receive. A mistake can expose or lose mail. Only run
> HelloBox in production if you have the system administration skills to do that. If you
> don't, use the hosted version at [hellobox.app](https://hellobox.app) and let us run it.

This guide takes you from an empty server to a running HelloBox. It should take under an
hour. You run everything with Docker Compose: the web app, a worker, Postgres, Redis, a
spam filter (rspamd) and an object store for attachments.

HelloBox reads and sends mail through your own provider account. You keep your provider.
Self-hosting means you also keep the inbox.

## What you need

- **A server.** Linux, 2 GB of RAM, 20 GB of disk, x86-64 or arm64. A small VPS is fine. Ports 80
  and 443 must be open to the internet.
- **Docker** with Compose 2.20 or newer. Check with `docker compose version`. To install
  Docker, follow [docs.docker.com/engine/install](https://docs.docker.com/engine/install/).
- **A domain** you can add DNS records to.
- **An account at an email provider**: Amazon SES, Resend, Postmark or Mailgun (see
  [Connect a provider](#connect-a-provider) for what each one needs). More providers are
  welcome: you can add one yourself, see [Contributing](#adding-a-provider).
- **A way to send HelloBox's own emails.** Sign-up verification links, password resets and
  invitations come from HelloBox itself. Use any SMTP server (your mail host, or the SMTP
  settings of SES, Postmark, Mailgun or Resend), or a [Resend](https://resend.com) API
  key. You can skip this if everyone signs in with Google or GitHub (see `.env.example`).

## 1. Point DNS at the server

Make two names. Both point at your server's IP address.

| Name | Type | What it is for |
|---|---|---|
| `mail.example.com` | A (and AAAA for IPv6) | The app, and the webhooks your provider calls |
| `files.example.com` | A (and AAAA for IPv6) | Attachments. Browsers upload and download here directly |

Use your own domain in place of `example.com` from here on.

## 2. Get HelloBox

```bash
git clone https://github.com/HelloboxGH/hellobox.git
cd hellobox/docker
```

Every command below runs in this `docker` folder.

## 3. Write your settings

Copy the example and make the secrets. Each line makes a new random value and puts it in
`.env`.

```bash
cp ../.env.example .env
chmod 600 .env
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^S3_ACCESS_KEY_ID=.*|S3_ACCESS_KEY_ID=$(openssl rand -hex 12)|" .env
sed -i "s|^S3_SECRET_ACCESS_KEY=.*|S3_SECRET_ACCESS_KEY=$(openssl rand -hex 24)|" .env
```

Now open `.env` in an editor and set these:

```ini
APP_URL=https://mail.example.com
S3_PUBLIC_ENDPOINT=https://files.example.com
SMTP_URL=smtp://user:password@smtp.example.com:587
EMAIL_FROM="HelloBox <hello@example.com>"
ADMIN_EMAILS=you@example.com
```

- `APP_URL` is the address people type in a browser. No slash at the end. HelloBox puts it in
  sign-in links and in the webhook URLs it gives your provider.
- `S3_PUBLIC_ENDPOINT` is the address of the object store, as browsers see it.
- `SMTP_URL` is your SMTP server: `smtp://` for port 587 (STARTTLS), `smtps://` for port 465.
  Write special characters in the password in percent form (`@` becomes `%40`). If you use a
  Resend API key instead, set `RESEND_API_KEY=re_your_key` and leave `SMTP_URL` out.
- `EMAIL_FROM` must be an address your SMTP server, or your Resend domain, may send from.
- `ADMIN_EMAILS` are the people who can use the admin tool (see [The first admin](#the-first-admin)).

**Back up this file.** `ENCRYPTION_KEY` protects your provider keys in the database. If you
lose it, you have to connect every provider again.

Every setting is explained in `.env.example`.

## 4. Start it

```bash
docker compose pull
docker compose up -d
```

The first start downloads the images and takes a few minutes. They come from Docker Hub
(`helloboxapp/hellobox-web` and `helloboxapp/hellobox-worker`). The same images are on GitHub's
registry as `ghcr.io/helloboxgh/hellobox-web` and `ghcr.io/helloboxgh/hellobox-worker`. If you
prefer that one, change the two `image:` lines in `compose.yml`. Check on it:

```bash
docker compose ps
```

After a minute, all services say `healthy` (`storage-init` says `Exited (0)`, which is
right: it makes the storage bucket and stops). If one doesn't, read its log, for example
`docker compose logs worker`.

The worker creates the database tables when it starts, and the web app waits for it. Every
upgrade works the same way.

## 5. Put HTTPS in front of it

The containers listen on `127.0.0.1` only: the app on port 3000 and the object store on
9000. A reverse proxy makes them public over HTTPS. [Caddy](https://caddyserver.com) gets
and renews certificates by itself. Install it with the steps on
[caddyserver.com/docs/install](https://caddyserver.com/docs/install), then put this in
`/etc/caddy/Caddyfile`:

```caddy
mail.example.com {
	reverse_proxy 127.0.0.1:3000
}

files.example.com {
	reverse_proxy 127.0.0.1:9000
}
```

Reload it:

```bash
sudo systemctl reload caddy
```

Open `https://mail.example.com`. You should see the sign-in page, with a valid certificate.
If Caddy can't get a certificate, check that DNS points at this server and that ports 80
and 443 are open.

If your server has a firewall, only open ports 22, 80 and 443. Nothing else needs to be
reachable.

## 6. Sign in

1. Open `https://mail.example.com` and choose **Sign up**.
2. Enter your email and a password. HelloBox emails you a verification link.
3. Click the link. You're in. Follow the short setup to name your workspace.

By default, anyone who can reach your address can create an account. To close sign-ups, add
this to `.env` and run `docker compose up -d`:

```ini
ALLOW_SIGNUPS=false
```

Then only two kinds of people can create an account: the addresses in `ADMIN_EMAILS`, and
people you invite. Sign up yourself first with an `ADMIN_EMAILS` address. Then invite people
in **Settings → Team**. They sign up with the address you invited. Everyone who already
has an account signs in as usual.

### The first admin

The first person to sign up owns their own workspace. They invite the rest of the team in
**Settings → Team**.

`ADMIN_EMAILS` is something else: it lists the people who can run the instance with the
`hellobox-admin` terminal tool (users, workspaces, bans, suspensions). It's in the
repository under `tools/admin`. To build it you need [Rust](https://rustup.rs) and a C
linker:

```bash
cargo install --path ../tools/admin
hellobox-admin login
```

Anyone whose address is in `ADMIN_EMAILS` must also have signed up and verified that
address. After you change `ADMIN_EMAILS`, run `docker compose up -d` to apply it.

## Connect a provider

Open **Settings → Domains → Connect a provider**.

**The webhook must be reachable from the internet.** When mail arrives, your provider calls a
URL on your server. HelloBox sets that up for you through the provider's API, using your
`APP_URL`. The provider can't call `localhost`, a private address or a server with a
self-signed certificate. Before you connect, open `https://mail.example.com/login` from a
phone on mobile data. If it loads, the provider can reach you too.

| Provider | What you paste | Webhook URLs (HelloBox creates them) |
|---|---|---|
| Postmark | An account API token | `/api/webhooks/postmark/<connection>/inbound` and `/events` |
| Mailgun | An API key and the HTTP webhook signing key | `/api/webhooks/mailgun/<connection>/inbound` and `/events` |
| Resend | Sign in with Resend (OAuth) | `/api/webhooks/resend/<connection>` |
| Amazon SES | A role in your AWS account | `/api/webhooks/ses/<connection>/inbound` and `/events` |

Each address starts with your `APP_URL`. The `<connection>` part is a long random id, which
keeps the address private.

After you connect, HelloBox lists your domains and shows the DNS records to add. Add them at
your DNS host and press **Check again**. Mail starts arriving once the MX record points at
your provider.

### What each provider needs

- **Postmark** and **Mailgun** work with the keys above and nothing else.
- **Resend** needs an OAuth app registered with Resend. Put its id and secret in
  `RESEND_OAUTH_CLIENT_ID` and `RESEND_OAUTH_CLIENT_SECRET`. Without them the Resend button
  shows an error.
- **Amazon SES** needs a small AWS setup first, described next. Without it the SES option is
  hidden.

### Set up the Amazon SES broker

HelloBox connects to SES through a role in your AWS account. That role trusts one AWS
account that you run, called the broker. The broker holds no mail. It only lets HelloBox
assume the role, and only with a secret that belongs to that connection. You set it up once.

1. Make a separate AWS account for it. An AWS Organizations member account is a good
   choice: [create one](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create.html).
2. In that account, create a CloudFormation stack from `infra/aws/broker.yaml` in this
   repository. [How to create a stack](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-create-stack.html).
   It makes a bucket for the templates, a user named `hellobox-broker` and a user named
   `hellobox-template-publisher`.
3. Create an access key for `hellobox-broker`:
   [how to](https://docs.aws.amazon.com/IAM/latest/UserGuide/access-key-self-managed.html).
4. Create an access key for `hellobox-template-publisher`, put it in your AWS CLI
   environment, then publish the template people launch in their own account:

   ```bash
   AWS_TEMPLATES_BUCKET=<the stack's TemplatesBucket output> ../scripts/publish-aws-templates.sh
   ```

5. Put the stack's outputs in `.env`, then run `docker compose up -d`:

   ```ini
   AWS_BROKER_ACCOUNT_ID=<BrokerAccountId output>
   AWS_BROKER_ACCESS_KEY_ID=<the hellobox-broker key id>
   AWS_BROKER_SECRET_ACCESS_KEY=<the hellobox-broker secret>
   AWS_BROKER_REGION=<the region of the stack>
   AWS_TEMPLATES_BASE_URL=<TemplatesBaseUrl output>
   ```

Now **Connect Amazon SES** appears in HelloBox. It sends you to AWS to launch the template
in the account that has your SES setup. AWS also has to call your webhook, so `APP_URL`
must be reachable from the internet over HTTPS. For the SES side (verifying a domain,
production access, receiving), see AWS's
[Amazon SES guide](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html).

### Adding a provider

Four providers are built in. If you use another one, you can add it. Each provider is an
implementation of the `MailProvider` interface in `packages/providers/src/types.ts`; the
Postmark and Mailgun ones are the shortest examples. Read `CONTRIBUTING.md` and open a pull
request, or ask in [Discussions](https://github.com/HelloboxGH/hellobox/discussions) first.

## Use another S3 service for attachments

The bundled store is the easy default. To use AWS S3, Backblaze B2, Cloudflare R2 or any other
S3-compatible service instead:

1. In `.env`, delete the line `COMPOSE_PROFILES=storage`.
2. Create a bucket and an access key with read and write access to it.
3. Set `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_ENDPOINT` to the
   service's values. Leave `S3_ENDPOINT` empty for AWS S3, and set `S3_REGION` instead.
   Leave `S3_PUBLIC_ENDPOINT` empty.
4. Add a CORS rule to the bucket that allows `PUT` and `GET` from `APP_URL` and exposes the
   `ETag` header. Browsers upload attachments straight to the bucket, and it doesn't work
   without this.
5. Run `docker compose up -d`. You don't need the `files.example.com` name or its Caddy block.

## Back up

Back up three things: the database, the files and your `.env`.

```bash
mkdir -p backups
docker compose exec -T postgres pg_dump -U hellobox -Fc hellobox > backups/db-$(date +%F).dump
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" --entrypoint sh storage-init \
  -c 'rc alias set store http://storage:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && rc mirror "store/$S3_BUCKET" /backup/storage'
cp .env backups/env
```

Copy the `backups` folder to another machine. Run these every night with cron. Keep a few days
of database dumps. The files copy only adds and updates, so it stays one folder.

If you use another S3 service, back it up with that service's own tools (versioning, or
replication to a second bucket) instead of the second command.

### Restore

On the new server, do steps 2 and 3 with your saved `.env`. Then start only the database and
load the dump:

```bash
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U hellobox -d hellobox --no-owner < backups/db-2026-01-01.dump
```

Start the bundled storage and put the files back:

```bash
docker compose up -d storage storage-init
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" --entrypoint sh storage-init \
  -c 'rc alias set store http://storage:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && rc mirror /backup/storage "store/$S3_BUCKET"'
```

Then start everything:

```bash
docker compose up -d
```

Try a restore on a spare machine now, before you need it.

## Upgrade

1. Take a backup (above).
2. Read the release notes for the version you want.
3. Check out the files of that release, so the compose file matches the images, and set
   the version:

   ```bash
   git fetch --tags
   git checkout 2026.11.1
   sed -i "s|^HELLOBOX_VERSION=.*|HELLOBOX_VERSION=2026.11.1|" .env
   ```

4. Pull the new images and restart:

   ```bash
   docker compose pull
   docker compose up -d
   ```

The worker applies database migrations when it starts, and the web app starts after it.
Migrations only go forward. To go back to an older version, restore your backup first.

With `HELLOBOX_VERSION=latest` you always get the newest release when you pull. For a server
you rely on, pin a version, so that you upgrade when you choose.

## If something goes wrong

| What you see | What to try |
|---|---|
| `docker compose up` says a variable is missing | Open `.env` and fill in the one it names. |
| A service stays unhealthy | `docker compose logs <service>`. The worker log shows migration errors. |
| The sign-up email never comes | Check `SMTP_URL` (or `RESEND_API_KEY`) and that `EMAIL_FROM` is allowed to send. `docker compose logs web` shows the error. Look in the spam folder too. |
| The page loads but sign-in fails | `APP_URL` must be exactly the address in the browser, with `https://`. |
| Attachments don't upload | Open `https://files.example.com/health`: it should answer with `"status":"ok"`. Check `S3_PUBLIC_ENDPOINT`. |
| The provider says it can't reach the webhook | See [Connect a provider](#connect-a-provider). The address has to work from the internet. |

## Where to ask

Questions and ideas go to [GitHub Discussions](https://github.com/HelloboxGH/hellobox/discussions).
Bugs go to [Issues](https://github.com/HelloboxGH/hellobox/issues). Security problems
go to the address in `SECURITY.md`, never in public.
