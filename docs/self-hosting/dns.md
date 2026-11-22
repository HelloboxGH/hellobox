# Point your domain at the server

DNS records tell the internet which server a name belongs to. Here you add two, so that
`mail.example.com` and `files.example.com` lead to your server. They don't change your
website or the email you already receive.

Everywhere in this guide, replace `example.com` with your own domain.

## The two names

| Name | What it's for |
|---|---|
| `mail.example.com` | HelloBox itself, and the webhooks your provider calls. You can pick another word than `mail`. |
| `files.example.com` | Attachments. Browsers upload and download them here directly. You only need it with the bundled storage; skip it if you'll [use your own S3 storage](storage.md). |

## Add the records

1. Sign in at your DNS host. That's usually where you bought the domain (Namecheap, GoDaddy,
   OVHcloud, Gandi...), or Cloudflare if you moved your DNS there.
2. Open the DNS settings of your domain. It may be called **DNS**, **DNS records**, **Zone
   editor** or **Manage DNS**.
3. Add a record:
   - **Type:** `A`
   - **Name** (or **Host**): `mail`. Just the first part: most DNS hosts add `.example.com`
     for you.
   - **Value** (or **Points to**, **IPv4 address**): your server's IP address.
   - **TTL:** leave the default.
4. Add a second one, the same, with the name `files`.

If your server also has an IPv6 address (a longer one with colons, like `2001:db8::10`),
add an `AAAA` record for each name with that address too. It's optional.

> **Using Cloudflare?** Set both records to **DNS only** (a grey cloud, not orange). Caddy
> needs to reach your server directly to get its certificate, and large uploads go faster.

## Check that it works

DNS changes take a few minutes to spread, sometimes up to an hour. On your own computer
(not the server), run:

```bash
nslookup mail.example.com
```

When the answer shows your server's IP address after `Address:`, it works. Check
`files.example.com` the same way. If it shows another address or `can't find`, wait ten
minutes and try again.

## What about MX records?

MX records decide where *email* for a domain goes. Don't change them now. When you connect
your email provider later, HelloBox shows exactly which records to add, and it can receive
on a subdomain (like `inbox.example.com`) so the mail you already get at `example.com`
stays where it is.

Next: [Install HelloBox](install.md).
