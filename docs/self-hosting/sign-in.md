# Sign in and invite your team

HelloBox is reachable. Now make your account, decide who else can sign up, and, if you
want, set up the admin tool.

## Create your account

1. Open `https://mail.example.com` and choose **Sign up**.
2. Enter your email address and a password. Use the address you put in `ADMIN_EMAILS`.
3. HelloBox emails you a link. Open it to confirm your address.
4. Follow the short setup to name your workspace. A workspace is your team's shared space:
   its domains, mailboxes and people.

**The email doesn't come?** Look in the spam folder first. Then read the web app's log on
the server:

```bash
cd ~/hellobox/docker
docker compose logs web --tail 50
```

It shows why sending failed, usually a wrong `SMTP_URL` or an `EMAIL_FROM` your provider
doesn't let you send from. Fix `.env`, run `docker compose up -d`, and ask for a new link.

## Invite your team

Open **Settings → Team** and invite people by email. They get an email with a link and
create their account with the address you invited. Each person is a **Member** or an
**Admin**; admins can connect providers and manage the team.

## Close sign-ups

Right now anyone who finds your address can create an account and a workspace of their
own. Once your account exists, close sign-ups. Add this line to `.env` (or set it, if it's
there already):

```ini
ALLOW_SIGNUPS=false
```

Then apply it:

```bash
docker compose up -d
```

From then on, only two kinds of people can create an account: the addresses in
`ADMIN_EMAILS`, and people invited to a workspace. Everyone who already has an account signs
in as before.

## Sign in with Google or GitHub

Optional. It adds **Continue with Google** and **Continue with GitHub** buttons to the
sign-in page. Each button shows once both of its settings are filled in.

### Google

1. Open the [Google Cloud console](https://console.cloud.google.com), and create a project
   (or pick one).
2. Go to **APIs & Services → OAuth consent screen** and fill in the app name and your email.
3. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
4. Choose **Web application**. Under **Authorized redirect URIs**, add
   `https://mail.example.com/api/auth/callback/google`.
5. Copy the client ID and client secret into `.env`:

   ```ini
   GOOGLE_CLIENT_ID=<client ID>
   GOOGLE_CLIENT_SECRET=<client secret>
   ```

### GitHub

1. On GitHub, open **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL:** `https://mail.example.com`. **Authorization callback URL:**
   `https://mail.example.com/api/auth/callback/github`.
3. Create it, then **Generate a new client secret**.
4. Copy both into `.env`:

   ```ini
   GITHUB_CLIENT_ID=<client ID>
   GITHUB_CLIENT_SECRET=<client secret>
   ```

Run `docker compose up -d` after either one.

## The admin tool

`hellobox-admin` is a terminal tool for whoever runs the instance: usage numbers, every
user and workspace, and bans or suspensions. It's separate from the admins inside a
workspace. Only addresses in `ADMIN_EMAILS` can use it, and only after they've signed up and
confirmed that address. With `ADMIN_EMAILS` empty, the tool can't connect at all.

You install it on your own computer, not the server. It needs [Rust](https://rustup.rs) and
a C compiler (on Ubuntu `sudo apt install build-essential`; on macOS
`xcode-select --install`; on Fedora `sudo dnf install gcc`). Then:

```bash
git clone https://github.com/HelloboxGH/hellobox.git
cd hellobox
cargo install --path tools/admin
hellobox-admin login
```

`login` asks for your HelloBox address and opens the browser, where you approve the
sign-in. After that, `hellobox-admin` opens the dashboard.

After you change `ADMIN_EMAILS` in `.env`, run `docker compose up -d` on the server.

Next: [Connect your email provider](providers.md).
