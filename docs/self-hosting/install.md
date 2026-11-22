# Install HelloBox

On this page you download HelloBox, write its settings and start it. Connect to your server
first:

```bash
ssh hellobox@<server-ip>
```

## Download HelloBox

```bash
cd ~
git clone https://github.com/HelloboxGH/hellobox.git
cd hellobox/docker
```

This puts HelloBox in a folder called `hellobox` in your home folder. **Every command from
here on runs in `~/hellobox/docker`.** If you connect again later, go back there first with
`cd ~/hellobox/docker`.

Now pick the version to run. Releases are named by date: `2026.11.1` is the first release
of November 2026. Open the [releases page](https://github.com/HelloboxGH/hellobox/releases),
note the newest one, and switch to it:

```bash
git checkout <version>
```

Git may print a note about a "detached HEAD". That's expected.

## Create the settings file

The settings live in a file called `.env`, next to `compose.yml`. Start from the example,
and make the file readable only by you:

```bash
cp ../.env.example .env
chmod 600 .env
```

## Make the secrets

HelloBox needs six random secrets. Each command below makes one and writes it into `.env`,
so you don't have to type them:

```bash
sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -hex 24)|" .env
sed -i "s|^S3_ACCESS_KEY_ID=.*|S3_ACCESS_KEY_ID=$(openssl rand -hex 12)|" .env
sed -i "s|^S3_SECRET_ACCESS_KEY=.*|S3_SECRET_ACCESS_KEY=$(openssl rand -hex 24)|" .env
```

What they are:

| Setting | What it protects |
|---|---|
| `ENCRYPTION_KEY` | Encrypts your provider keys and tokens in the database. **If you lose it, you have to connect every provider again.** Never change it after the first start. |
| `BETTER_AUTH_SECRET` | Signs everyone's sign-in sessions. Changing it signs everyone out. |
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | The database and the job queue. Only HelloBox's own containers use them. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | The bundled storage for attachments. |

Check that they're filled in:

```bash
grep -E '^(ENCRYPTION_KEY|BETTER_AUTH_SECRET|POSTGRES_PASSWORD|REDIS_PASSWORD|S3_ACCESS_KEY_ID|S3_SECRET_ACCESS_KEY)=' .env
```

Each of the six lines should have a long value after `=`.

## Edit the settings file

You'll edit `.env` with `nano`, a simple text editor that runs in the terminal:

```bash
nano .env
```

- Move around with the arrow keys. The mouse doesn't work.
- **Ctrl+W** searches: type a setting's name and press Enter to jump to it.
- **Ctrl+O** then Enter saves. **Ctrl+X** quits.

Set these lines. Each one already exists in the file; change the part after `=`.

```ini
APP_URL=https://mail.example.com
S3_PUBLIC_ENDPOINT=https://files.example.com
HELLOBOX_VERSION=<version>
ADMIN_EMAILS=you@example.com
```

- **`APP_URL`** is the address people will type in the browser, with `https://` and no `/`
  at the end. Sign-in links and the webhook addresses your provider calls are built from
  it, so it must be exactly right.
- **`S3_PUBLIC_ENDPOINT`** is the address browsers use for attachments.
- **`HELLOBOX_VERSION`** is the version you checked out above. Pinning it means HelloBox
  only changes when you [upgrade](upgrade.md). `latest` would follow every new release.
- **`ADMIN_EMAILS`** is your own email address. It lets you use the admin tool
  ([Sign in and invite your team](sign-in.md#the-admin-tool) explains it). Several
  addresses go on one line with commas between them.

Leave everything else as it is for now. [All settings](../../.env.example) explains each
one.

## Set up the email HelloBox sends

HelloBox emails people the link to confirm their account, password resets and team
invitations. Choose one of the ways below and set its lines in `.env`.

### With your provider's SMTP details

SMTP is the standard way programs send email. Your provider gives you a server name, a
username and a password for it:

| Provider | Where to find them | Server and port |
|---|---|---|
| Postmark | Your server in Postmark → **Default Transactional Stream** → **Setup instructions** → SMTP. The username and password are both your Server API token. | `smtp.postmarkapp.com`, 587 |
| Mailgun | **Sending** → **Domain settings** → **SMTP credentials**. | `smtp.mailgun.org` (`smtp.eu.mailgun.org` for EU accounts), 587 |
| Amazon SES | SES console → **SMTP settings** → **Create SMTP credentials**. | `email-smtp.<region>.amazonaws.com`, 587 |
| Resend | Username `resend`, the password is an API key. | `smtp.resend.com`, 587 |

Put them together in one line, `smtp://<username>:<password>@<server>:<port>`:

```ini
SMTP_URL=smtp://<username>:<password>@smtp.postmarkapp.com:587
EMAIL_FROM="HelloBox <hello@example.com>"
```

- **`EMAIL_FROM`** is who these emails come from. Use an address on a domain your provider
  lets you send from (one you verified there). Keep the quotes.
- If the username or password contains any of these characters, replace them as shown, or
  the line won't be read correctly:

  | Character | Write it as |
  |---|---|
  | `@` | `%40` |
  | `:` | `%3A` |
  | `/` | `%2F` |
  | `#` | `%23` |
  | `?` | `%3F` |
  | `%` | `%25` |

  For example, the password `p@ss/word` becomes `p%40ss%2Fword`.
- Port 465 instead of 587? Start the line with `smtps://` instead of `smtp://`.

### With a Resend API key

If you use Resend, an API key is simpler than SMTP:

```ini
RESEND_API_KEY=re_<your key>
EMAIL_FROM="HelloBox <hello@example.com>"
```

Leave `SMTP_URL` empty: when both are set, SMTP wins.

### Without email

Only if everyone will [sign in with Google or GitHub](sign-in.md#sign-in-with-google-or-github).
Leave `SMTP_URL`, `RESEND_API_KEY` and `EMAIL_FROM` empty. Nobody can then sign up with a
password, reset one or get an invitation email.

Save the file (Ctrl+O, Enter) and quit nano (Ctrl+X).

## Start HelloBox

Download the containers, then start them in the background:

```bash
docker compose pull
docker compose up -d
```

The first download takes a few minutes. The images come from Docker Hub
(`helloboxapp/hellobox-web` and `helloboxapp/hellobox-worker`). The same images are on
GitHub as `ghcr.io/helloboxgh/hellobox-web` and `ghcr.io/helloboxgh/hellobox-worker`; to use
those, change the two `image:` lines in `compose.yml`.

If `up` stops with a message like `Set POSTGRES_PASSWORD in .env`, that setting is empty:
open `.env`, fill it in and run `docker compose up -d` again.

## Check that it's running

Wait a minute, then:

```bash
docker compose ps
```

Every part should say `healthy` in the **STATUS** column:

| Part | What you should see |
|---|---|
| `web`, `worker`, `postgres`, `redis`, `rspamd`, `storage` | `Up ... (healthy)` |
| `storage-init` | Not in the list, or `Exited (0)`. That's right: it makes the storage bucket once and stops. |

While a part says `(health: starting)`, give it another minute. The worker sets up the
database on its first start, and the web app waits for it.

If a part says `unhealthy` or `Restarting`, read its log. For example, for the worker:

```bash
docker compose logs worker --tail 50
```

The last lines usually say what's wrong, often a setting. To watch a log live, add `-f`
(`docker compose logs -f worker`) and press Ctrl+C to stop watching.

Finally, check that the app answers on the server itself:

```bash
curl -sI http://127.0.0.1:3000 | head -1
```

It prints a line starting with `HTTP/1.1` and a number. Anything below 400 is fine.

## Keep a copy of your settings

Your `.env` holds the keys to everything, including `ENCRYPTION_KEY`. Copy it somewhere
safe now. From a terminal on **your own computer** (not the server):

```bash
scp hellobox@<server-ip>:~/hellobox/docker/.env ./hellobox.env
```

Put that file in your password manager, then delete it from your computer.

HelloBox is running, but only on the server itself. Next: [Turn on HTTPS](https.md), so
you can open it in a browser.
