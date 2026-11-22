# Turn on HTTPS

HelloBox only listens on the server itself: the app on port 3000, the storage on port 9000.
Here you install [Caddy](https://caddyserver.com), a reverse proxy that makes both reachable
from the internet over HTTPS. Caddy gets a free certificate from Let's Encrypt and renews it
by itself, so you never have to think about it again.

Before you start, check that your [DNS records](dns.md#check-that-it-works) already point at
the server. Caddy can't get a certificate until they do.

## Install Caddy

These are the steps from [Caddy's install guide](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)
for Ubuntu. If anything below fails, follow that page instead.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Caddy starts right away and starts again by itself whenever the server restarts.

## Tell Caddy about HelloBox

Caddy's settings are in a file called the Caddyfile. Open it:

```bash
sudo nano /etc/caddy/Caddyfile
```

Delete everything in it (hold Ctrl+K to delete line by line), then type or paste this, with
your own domain:

```caddy
mail.example.com {
	reverse_proxy 127.0.0.1:3000
}

files.example.com {
	reverse_proxy 127.0.0.1:9000
}
```

Each block says: for visitors to this name, get a certificate and pass them on to this
port. If you [use your own S3 storage](storage.md), leave out the `files.example.com` block.

Save (Ctrl+O, Enter) and quit (Ctrl+X). Then load the new settings:

```bash
sudo systemctl reload caddy
```

## Check it

Open `https://mail.example.com` in your browser. You should see HelloBox's sign-in page,
with a padlock next to the address.

The first visit can take a few seconds while Caddy gets the certificates. If the page
doesn't load, look at what Caddy says:

```bash
sudo journalctl -u caddy --since "10 minutes ago" --no-pager | tail -30
```

| What Caddy says | What it means |
|---|---|
| `no such host`, or a DNS problem | The DNS records don't point at this server yet. Check them with `nslookup`, and wait. |
| `connection refused`, `timeout` while getting a certificate | Ports 80 or 443 are closed. Check `sudo ufw status` and your hosting company's firewall. |
| `Caddyfile:2 - Error during parsing` | A typo in the Caddyfile. Open it again and compare it with the example above. |
| `dial tcp 127.0.0.1:3000: connect: connection refused` | HelloBox isn't running. Run `docker compose ps` in `~/hellobox/docker`. |

Also open `https://files.example.com/health`. It should show `"status":"ok"`.

## Already have a reverse proxy?

If the server already runs nginx, Traefik or another reverse proxy, use it instead of
Caddy. Point `mail.example.com` at `127.0.0.1:3000` and `files.example.com` at
`127.0.0.1:9000`, and make sure it:

- passes the original `Host` header and the `X-Forwarded-Proto` header;
- doesn't buffer responses from HelloBox, which streams live updates to the browser (in
  nginx: `proxy_buffering off;`);
- allows uploads at least as large as your biggest attachments (in nginx:
  `client_max_body_size 50m;` or more).

Next: [Sign in and invite your team](sign-in.md).
