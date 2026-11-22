# Before you start

This page explains the words the guide uses, then lists what to get ready. Nothing here
changes anything yet.

## The words you'll meet

**Server, VPS.** A computer at a hosting company that's always on and connected to the
internet. A VPS (virtual private server) is a slice of a bigger machine that behaves like
your own computer. You rent it by the month and control it completely.

**Terminal, command.** A window where you type instructions instead of clicking. Every
command in this guide is in a grey box. Copy it, paste it into the terminal and press
Enter. Text in angle brackets, like `<your server's address>`, is a placeholder: put your
own value there, without the brackets.

**SSH.** How you open a terminal on the server from your own computer. You type
`ssh` and the server's address, and from then on your commands run on the server.

**Domain, DNS.** A domain is a name like `example.com`. DNS is the internet's address book:
its records say which server a name points to. You add records at your *DNS host*, usually
the company you bought the domain from.

**Docker, Docker Compose.** Docker runs each part of HelloBox in its own container, with
everything it needs inside, so you don't install those parts one by one. Docker Compose
starts all of them together from one file, `compose.yml`.

**Reverse proxy, HTTPS.** HTTPS is the padlock in the browser: it encrypts the connection.
It needs a certificate, which proves the address is yours. A reverse proxy is a small
program that receives visitors on the HTTPS port and passes them to HelloBox. This guide
uses Caddy, which gets and renews certificates by itself.

**`.env` file.** A text file with HelloBox's settings, one `NAME=value` per line. It holds
secrets, so only you should be able to read it.

**Email provider.** The service that actually moves your email across the internet:
Amazon SES, Postmark, Mailgun or Resend. HelloBox doesn't replace it. HelloBox gives your
team an inbox on top of it.

**Webhook.** An address on your server that your email provider calls when something
happens, such as "a new email arrived". That's why your server has to be reachable from the
internet.

## What you need

### A server

- **Size:** 2 GB of memory (RAM), 20 GB of disk, any recent processor (x86-64 or arm64).
  Start small; you can make it bigger later at most hosting companies.
- **System:** Ubuntu 24.04 LTS. Other Linux systems work, but the commands in this guide
  are written for Ubuntu.
- **Where:** any company that rents a VPS with a public IP address, for example Hetzner,
  DigitalOcean, OVHcloud, Scaleway, Vultr or Akamai (Linode). Pick a location close to
  your team.

A computer at home or in the office is not a good fit. It needs a fixed public address,
ports 80 and 443 open to the internet, and to stay on all the time.

### A domain

You need a domain whose DNS records you can change. You don't need a new one: HelloBox can
live on a subdomain such as `mail.example.com`. Adding a subdomain doesn't touch your
website or the email you already receive at `example.com`.

### An account at an email provider

| Provider | How HelloBox connects | Good to know |
|---|---|---|
| Postmark | You paste an account API token | The quickest to set up. |
| Mailgun | You paste an API key and a webhook signing key | Also quick. |
| Amazon SES | A role in your AWS account | The lowest prices at volume, and the most setup: you run a small AWS account for HelloBox first. |
| Resend | Sign in with Resend | Needs an OAuth app from Resend before it works on your own server. |

If you're not sure, start with Postmark or Mailgun. [Connect your email
provider](providers.md) has the details for each.

### A way for HelloBox to send its own emails

HelloBox sends a few emails itself: the link to confirm a new account, password resets and
team invitations. These go through an SMTP server (the standard way programs send email)
or a Resend API key. Every provider above gives you SMTP details, so the account you
already have usually covers it. [Install HelloBox](install.md#set-up-the-email-hellobox-sends)
shows where to find them.

You can skip this only if everyone will sign in with Google or GitHub.

### A safe place for secrets

You'll make several passwords and keys. Keep them in a password manager, not in a text
file on your desktop.

## Ready?

- [ ] A hosting account where you can create a server
- [ ] A domain, and the login of its DNS host
- [ ] An account at your email provider
- [ ] Your provider's SMTP details, or a Resend API key
- [ ] A password manager
- [ ] About an hour

Next: [Get a server ready](server.md).
