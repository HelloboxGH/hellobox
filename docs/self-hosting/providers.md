# Connect your email provider

HelloBox doesn't send or receive email by itself. It works through your account at an email
provider: Postmark, Mailgun, Resend, Amazon SES, SendGrid, Brevo, MailerSend, Mailjet, Bird, or any SMTP server. Your mail keeps going through that
account, under your name and reputation; HelloBox shows it to your team and sends the
replies.

This is the most important step, and the one that differs most between providers. Read
[Before you connect](#before-you-connect), pick your provider, and follow only its section.

This is a different job from the [email HelloBox sends](install.md#set-up-the-email-hellobox-sends)
for sign-ups. You can use the same provider for both.

## Before you connect

### How mail reaches HelloBox

1. Someone writes to `hello@example.com`.
2. The domain's **MX record** says your provider receives mail for `example.com`.
3. Your provider calls a **webhook**: an address on your server, under `APP_URL`, that says
   "new mail, here it is".
4. HelloBox stores the message and shows it in the inbox.

HelloBox sets the webhook up for you, through your provider's API. You never copy a webhook
address by hand. But your provider has to be able to reach your server from the internet.

### Check that your server is reachable

On your phone, turn off Wi-Fi so you use mobile data, and open
`https://mail.example.com/login`. If the sign-in page loads with a padlock, your provider can
reach you too.

It won't work if `APP_URL` is `localhost`, a private address like `192.168.1.20`, or a site
without a valid certificate. Fix that first: see [Turn on HTTPS](https.md).

### Who can connect

Only a workspace **admin** can connect a provider. The person who created the workspace is
one.

### Which provider?

If you already send with one of these, use it. If you're choosing:

| Provider | Setting it up | Good to know |
|---|---|---|
| **Postmark** | Easiest. Paste one key. | Very good delivery. One Postmark *server* receives for one domain, so each extra domain needs [a subdomain or another server](#receive-on-a-subdomain). |
| **Mailgun** | Easy. Paste two keys. | Receives for many domains on one account. |
| **Resend** | Medium. Register an app once with one command, then sign in. | Domains and receiving are managed in Resend's own dashboard. |
| **Amazon SES** | The most work: about 30 minutes in AWS, once. | The cheapest at volume. New accounts start in a *sandbox* and need AWS's approval to send to anyone. |
| **SendGrid** | Easy. Paste one key. | Receives for many domains. Each receiving domain's MX points at SendGrid. The free plan allows one events webhook. |
| **Brevo** | Easy. Paste one key. | Receives best on a subdomain, like `reply.example.com`. Attachments of received mail are fetched from Brevo. |
| **MailerSend** | Easy. Paste one token. | Receives for many domains. Each domain needs its own events webhook, and plans cap them. Threading replies needs a paid plan. |
| **Mailjet** | Easy. Paste two keys. | Receiving needs a paid Mailjet plan. Mailjet takes one events address per event type for the whole account. |
| **Bird** | Easy. Paste one key. | Formerly SparkPost. Signed webhooks, and Bird keeps received mail for 30 days, so none is lost. Use a subdomain, like `mail.example.com`. |
| **SMTP** | Easy. A server, a username and a password. | Only sends, so it needs HelloBox's own mail server to receive. Sent mail shows *Sent*, never *Delivered*, and campaigns aren't available. |

You can connect more than one provider to a workspace later.

## Postmark

**What you need:** a Postmark account, and to be its owner or an admin (only they can see
account tokens).

A new Postmark account is *pending approval*: until Postmark approves it, it can only send to
addresses at your own domain. Ask for approval in Postmark early; it's usually quick.

### 1. Copy your account API token

Postmark has two kinds of token. HelloBox needs the **Account API token**, which can see your
whole account, so HelloBox can set up receiving for you. A *Server* API token won't work.

1. Sign in at [account.postmarkapp.com](https://account.postmarkapp.com).
2. Open **Account** in the top menu, then **API Tokens**.
3. Copy the **Account API token**. It looks like `1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f`.

### 2. Connect it in HelloBox

1. In HelloBox, open **Settings → Domains → Connect a provider → Postmark**.
2. Paste the token and press **Connect**.
3. Pick a Postmark **server** (Postmark's word for a group of settings and message streams):
   - **A new server called HelloBox**, if you're not sure. It keeps HelloBox apart from
     anything else you send with Postmark.
   - **An existing server**, if your domain is already set up on it. If that server already
     sends its incoming mail somewhere else, HelloBox warns you before it takes over.

HelloBox then points the server's incoming mail at your instance, turns on delivery and bounce
events, and lists the account's domains.

### 3. Set up your domain

Go on to [Set up your domains](#set-up-your-domains). With Postmark, keep in mind:

- **Add domain** in HelloBox adds a domain to Postmark for you.
- A Postmark server receives for **one** domain. To receive for a second one, use
  [a subdomain](#receive-on-a-subdomain) or connect another Postmark server.
- Postmark only starts receiving once it sees the MX record. HelloBox asks every minute. Wait
  until the domain shows **Waiting for the first email** before you rely on it, or early mail
  bounces.

## Mailgun

**What you need:** a Mailgun account.

### 1. Copy two keys

Both are on the same page in Mailgun:

1. Sign in at [app.mailgun.com](https://app.mailgun.com).
2. Open the account menu (top right), then **API Security**
   ([direct link](https://app.mailgun.com/settings/api_security)).
3. Under **Mailgun API keys**, press **Add new key**, name it `HelloBox`, and copy the key.
   Mailgun shows it only once. Use a full **API key**: a *domain sending key* can only send, so
   HelloBox couldn't set up receiving with it.
4. On the same page, find the **HTTP webhook signing key** and copy it too. HelloBox uses it to
   check that every notification really comes from Mailgun.

### 2. Connect it in HelloBox

1. Open **Settings → Domains → Connect a provider → Mailgun**.
2. Paste the **API key** and the **HTTP webhook signing key**, and press **Connect**.

HelloBox finds out by itself whether your account is in Mailgun's US or EU region, sets up
delivery events, and lists your domains.

### 3. Set up your domain

Go on to [Set up your domains](#set-up-your-domains). **Add domain** in HelloBox adds a domain to
Mailgun, and turning on receiving creates the Mailgun *route* that sends its mail to HelloBox.

## Resend

Resend connects by *OAuth*: you sign in to Resend and press **Allow**, the way you'd let an app
use your Google account. No key to copy each time.

For that, Resend has to know your HelloBox instance. You **register it once** as an *OAuth app*,
and put the two values Resend gives you in `.env`. Resend has no screen for this yet, so you
do it with one command. After that, everyone on your instance connects with a click.

**What you need:** a Resend account, with your domain added and verified in Resend.

### 1. Register your instance with Resend (once)

Run this from any terminal: your computer or the server. Change the two `mail.example.com`
addresses to your `APP_URL` first.

```bash
curl -X POST https://api.resend.com/oauth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "HelloBox (mail.example.com)",
    "client_uri": "https://mail.example.com",
    "redirect_uris": ["https://mail.example.com/api/resend/oauth/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "client_secret_basic"
  }'
```

What the parts mean:

- **`client_name`** is the name Resend shows when someone presses **Allow**. Make it clear it's
  your instance.
- **`redirect_uris`** is where Resend sends people back after they allow access. It must be your
  `APP_URL` followed by `/api/resend/oauth/callback`, exactly.
- **`client_secret_basic`** asks for a secret, so only your server can use the app.

Resend answers with something like this (shortened):

```json
{
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  "client_secret": "3vProAFw7...",
  "client_secret_expires_at": 0,
  "client_name": "HelloBox (mail.example.com)",
  "redirect_uris": ["https://mail.example.com/api/resend/oauth/callback"]
}
```

**Copy `client_id` and `client_secret` into your password manager now.** Resend shows the
secret only this once. If you lose it, run the command again to register a new app.

If the answer is an error instead:

| Error | What to do |
|---|---|
| `invalid_request` | A typo in the command, or a `redirect_uris` address that isn't `https://`. Check the quotes and the address. |
| `too_many_requests` | Resend allows 20 registrations an hour from one address. Wait an hour. |

### 2. Add them to HelloBox

On the server, in `~/hellobox/docker`, open `.env` (`nano .env`) and set:

```ini
RESEND_OAUTH_CLIENT_ID=550e8400-e29b-41d4-a716-446655440000
RESEND_OAUTH_CLIENT_SECRET=3vProAFw7...
```

Save, then apply it:

```bash
docker compose up -d
```

If you ever change `APP_URL`, the redirect address no longer matches: register again with the
new address and replace both values.

### 3. Connect it in HelloBox

1. Open **Settings → Domains → Connect a provider → Resend**.
2. Resend opens. Sign in to the Resend account you want to connect, check the app's name (the
   `client_name` you chose), and press **Allow**.
3. You land back in HelloBox, connected. HelloBox creates the webhook in Resend for you and
   lists your domains.

A workspace connects one Resend account. To see or remove HelloBox's access from Resend's side,
open **Team settings** in Resend.

### 4. Set up your domain

With Resend, domains are managed in Resend's dashboard, not in HelloBox:

1. Add and verify the domain in Resend (**Domains → Add domain**), if you haven't.
2. Turn on **receiving** for it in Resend, and add the MX record Resend shows.
3. Back in HelloBox, reload **Settings → Domains**: the domain appears under the Resend
   connection. Press **Check again** on it if it still says **Waiting for DNS**.

[Receiving on a subdomain](#receive-on-a-subdomain) works from HelloBox, as for other
providers.

## Amazon SES

SES is the cheapest provider, and the one that takes the most setting up. Set aside half an
hour, read the whole section first, and do it in order.

### How it works, in plain words

HelloBox never asks for your AWS password or keys. Instead:

- You run a small piece of AWS for HelloBox, called the **broker**. It's an AWS user that can
  do exactly one thing: borrow permissions that someone gave to HelloBox. It holds no mail.
- When someone connects SES, they launch a **stack** (a ready-made set of AWS resources, from a
  template file) in *their* AWS account. It creates a **role**: a set of SES permissions that
  only your broker may borrow, and only with a secret that belongs to that one connection.
- To delete the stack is to disconnect. Access ends at once.

You set up the broker **once per HelloBox instance** (part 1). Connecting is then a few clicks
(part 2), and can be done by anyone on your instance with their own AWS account.

Words you'll meet in the AWS console:

| Word | What it is |
|---|---|
| **Region** | Where in the world AWS runs something, like `eu-west-1` (Ireland). The region picker is at the top right of the console. |
| **CloudFormation** | The AWS service that creates resources from a template file. A *stack* is one use of a template. |
| **IAM** | Identity and Access Management: AWS's users, roles and permissions. |
| **Access key** | A key ID and a secret that let a program act as an IAM user. |
| **S3 bucket** | A folder for files in AWS. |

**What you need:**

- An AWS account ([create one](https://portal.aws.amazon.com/billing/signup)). The broker
  costs nothing to run; SES itself charges per email.
- About 30 minutes, and a password manager for the keys.

### Part 1: set up the broker (once)

We recommend a separate AWS account for the broker, so it stays apart from the account with
your mail. With [AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_accounts_create.html)
you can make one from your main account in a minute. If you run HelloBox only for yourself,
one account for both also works.

**1. Download the two template files.** Save both to your computer (right-click, **Save link
as**):

- [broker.yaml](https://raw.githubusercontent.com/HelloboxGH/hellobox/main/infra/aws/broker.yaml):
  the broker.
- [connect.yaml](https://raw.githubusercontent.com/HelloboxGH/hellobox/main/infra/aws/connect.yaml):
  what people launch to connect.

**2. Create the broker stack.**

1. Sign in to the [AWS console](https://console.aws.amazon.com) with the broker's account.
2. At the top right, pick a region. Any works; pick one near you.
3. Search for **CloudFormation** in the top bar and open it.
4. Press **Create stack → With new resources (standard)**.
5. Choose **Choose an existing template**, then **Upload a template file**, pick
   `broker.yaml`, and press **Next**.
6. **Stack name:** `hellobox-broker`. Press **Next**.
7. Leave the options page as it is. Press **Next**.
8. At the bottom of the review page, tick **I acknowledge that AWS CloudFormation might create
   IAM resources with custom names**, and press **Submit**.

Wait a minute, until the stack's status says **CREATE_COMPLETE** (press the refresh button).
Then open its **Outputs** tab and keep it open: you need `BrokerAccountId`, `TemplatesBucket`
and `TemplatesBaseUrl`.

The stack created:

- an S3 bucket called `hellobox-templates-<your account number>`, where the connect template
  goes;
- a user called `hellobox-broker`, which HelloBox runs as;
- a user called `hellobox-template-publisher`, for publishing the template from the command
  line. You don't need it if you follow step 4 below.

**3. Make an access key for the broker.**

1. Search for **IAM** in the top bar and open it. Open **Users**, then `hellobox-broker`.
2. Open the **Security credentials** tab, and press **Create access key**.
3. Choose **Application running outside AWS**, press **Next**, then **Create access key**.
4. Copy the **Access key** and the **Secret access key** into your password manager. AWS shows
   the secret only once.

**4. Upload the connect template.**

1. Search for **S3** and open the bucket `hellobox-templates-<your account number>`.
2. Press **Create folder**, name it `templates`, and create it.
3. Open the `templates` folder, press **Upload**, add `connect.yaml`, and press **Upload**.

The file must end up at `templates/connect.yaml`, exactly. To check, open
`<TemplatesBaseUrl>/connect.yaml` in your browser: it should show the template's text (or
download it).

> **From the command line instead:** make an access key for `hellobox-template-publisher`,
> set it up with `aws configure`, and run
> `AWS_TEMPLATES_BUCKET=<TemplatesBucket> scripts/publish-aws-templates.sh` from the
> `hellobox` folder. It also checks the template.

**5. Give the values to HelloBox.** On the server, open `.env` (`nano .env` in
`~/hellobox/docker`) and set:

```ini
AWS_BROKER_ACCOUNT_ID=<BrokerAccountId output>
AWS_BROKER_ACCESS_KEY_ID=<the broker's access key>
AWS_BROKER_SECRET_ACCESS_KEY=<the broker's secret access key>
AWS_BROKER_REGION=<the region you created the stack in, like eu-west-1>
AWS_TEMPLATES_BASE_URL=<TemplatesBaseUrl output>
```

Save, then apply it:

```bash
docker compose up -d
```

**Amazon SES** now shows up in **Connect a provider**. It stays hidden as long as any of these
is missing.

When a new HelloBox release changes `connect.yaml` (its release notes say so), upload the new
file the same way. Stacks people already launched keep working.

### Part 2: connect your AWS account

Use the AWS account that has, or will have, your SES setup. If you haven't used SES before,
that's fine: HelloBox sets it up.

1. In HelloBox, open **Settings → Domains → Connect a provider → Amazon SES**.
2. **Region:** where SES will run. If you already use SES, pick the region your domains are
   verified in. Otherwise pick one near you. Every region in the list can receive mail.
3. **Set up DNS in Route 53 for me:** tick it if your domain's DNS is in AWS Route 53. HelloBox
   then adds the records itself. It never replaces an MX record that points somewhere else.
4. Press **Open AWS**. Sign in to AWS in the new tab if asked, with the account you want to
   connect.
5. AWS shows **Quick create stack**, with everything filled in. Don't change anything. Scroll to
   the bottom, tick **I acknowledge that AWS CloudFormation might create IAM resources**, and
   press **Create stack**.
6. Go back to the HelloBox tab. It updates by itself: first **Waiting for the stack in AWS**,
   then **Stack created**, then **Connected**. This takes a minute or two.

If it stays on "Waiting" for more than five minutes, open CloudFormation in that region and
look at the stack called `HelloBox-...`:

| Status | What to do |
|---|---|
| No stack | You closed the AWS tab before **Create stack**. Use **Open it again** in HelloBox. |
| `CREATE_IN_PROGRESS` | Wait a little longer. |
| `ROLLBACK_COMPLETE` | The stack couldn't reach HelloBox. Check that [your server is reachable](#check-that-your-server-is-reachable), delete the stack, and connect again. The **Events** tab says what failed. |

### Part 3: domains, and leaving the sandbox

**Add your domain.** In **Settings → Domains**, under the SES connection, press **Add domain**.
HelloBox adds it to SES and shows the DNS records, then continue with
[Set up your domains](#set-up-your-domains). Turning on receiving adds the domain to SES's
receipt rule for you.

**The sandbox.** Every new SES account starts in the *sandbox*: it can only send to addresses
you've verified. HelloBox shows this under the connection, with two buttons:

- **Test recipients:** add an address, AWS emails it a confirmation link, and once it's
  confirmed you can send to it. Use it to try things out.
- **Request production access:** asks AWS to lift the limit. Say what you'll mostly send
  (**Transactional and replies** for a team inbox) and describe your use in a sentence or two:
  for example, "Replies to customers who email our support address, sent by our team." AWS
  says it answers within 96 hours, may email you questions, and decides by itself.

Once approved, HelloBox shows **Production access is on**, with your daily sending limit.

**Disconnecting** in HelloBox stops new mail and sending, and removes HelloBox's receipt rule.
Your existing mail stays in HelloBox. To end HelloBox's access completely, also delete the
`HelloBox-...` stack in CloudFormation.

For anything else about SES itself, see [AWS's SES guide](https://docs.aws.amazon.com/ses/latest/dg/Welcome.html).

## SendGrid

**What you need:** a SendGrid account and an API key with **Full Access**. HelloBox uses it to
read your domains, set up receiving and add the delivery events webhook.

1. In SendGrid, open **Settings → API Keys → Create API Key**, choose **Full Access**, and copy
   the key. SendGrid shows it once. EU accounts work too: HelloBox finds the region.
2. In HelloBox, open **Settings → Domains → Connect a provider → SendGrid**, paste the key and
   press **Connect**.
3. Your authenticated domains appear. **Add domain** authenticates a new one in SendGrid.
4. On each domain you want to receive on, turn on **Receiving**. HelloBox adds an Inbound Parse
   setting for it, and shows the MX record (`mx.sendgrid.net`) to add.

HelloBox also adds a signed events webhook, so sent mail shows *Delivered*, bounces and spam
reports. SendGrid limits events webhooks by plan; if yours are all in use, the connection works
without one and HelloBox says so. Free one in SendGrid, then **Connect again**.

SendGrid keeps no copy of received mail, so HelloBox must be reachable when it arrives. SendGrid
retries for up to three days.

## Brevo

**What you need:** a Brevo account and an **API key** (not an SMTP key).

1. In Brevo, open **SMTP & API → API Keys → Generate a new API key**, and copy it.
2. In HelloBox, open **Settings → Domains → Connect a provider → Brevo**, paste the key and
   press **Connect**.
3. Your Brevo domains appear. **Add domain** adds a new one; add the records HelloBox shows,
   then **Check again** so Brevo authenticates it.
4. To receive, Brevo recommends a subdomain you don't send from, like `reply.example.com`. Use
   **Receive on a subdomain**, or turn on **Receiving** on a domain. HelloBox adds an inbound
   webhook for it and shows the two MX records (`inbound1.sendinblue.com` and
   `inbound2.sendinblue.com`).

HelloBox also adds a delivery events webhook, so sent mail shows *Delivered*, bounces and spam
reports. Brevo doesn't sign its webhooks: each one carries a long secret token of the
connection's instead.

Brevo writes its own Message-ID on mail it sends, and HelloBox keeps it, so replies still
thread. Brevo keeps no copy of received mail, so HelloBox must be reachable when it arrives.

## MailerSend

**What you need:** a MailerSend account and an API token for **All domains** with **Full
access**.

1. In MailerSend, open **Integrations → API tokens → Generate new token**, choose all domains
   and full access, and copy it. MailerSend shows it once.
2. In HelloBox, open **Settings → Domains → Connect a provider → MailerSend**, paste the token
   and press **Connect**.
3. Your MailerSend domains appear. **Add domain** adds a new one.
4. On each domain you want to receive on, turn on **Receiving**. HelloBox adds a catch-all
   inbound route for it and shows the MX record to add.

HelloBox adds a signed events webhook to each domain, so sent mail shows *Delivered*, bounces
and spam reports. MailerSend's plans cap webhooks; a domain left without one still works, and
HelloBox says so.

MailerSend writes its own Message-ID. HelloBox threads replies with MailerSend's
`in_reply_to` and `references`, which its free plan doesn't allow; there, replies go out
without them, so the other person's mail app may not thread them.

## Mailjet

**What you need:** a Mailjet account, its **API key** and **secret key**, and a paid plan if you
want to receive (Mailjet's Parse API isn't on the free plan).

1. In Mailjet, open **Account settings → API Key Management** and copy the API key and the
   secret key.
2. In HelloBox, open **Settings → Domains → Connect a provider → Mailjet**, paste both and press
   **Connect**.
3. Your Mailjet domains appear. **Add domain** adds one; add the records HelloBox shows (a TXT
   that proves the domain is yours, DKIM and SPF), then **Check again**.
4. On each domain you want to receive on, turn on **Receiving**. HelloBox adds a parse route for
   it and shows the MX record (`parse.mailjet.com`).

HelloBox adds event callbacks for sent, bounced, blocked and spam mail. Mailjet keeps one
address per event type for the whole account: if one is already set, for another tool, HelloBox
leaves it and says so. Mailjet signs neither its events nor received mail, so each address
carries a long secret of the connection's.

## Bird

**What you need:** a Bird workspace and an **access key** with email and webhook access. Bird
(bird.com) took over SparkPost; this is its new platform, not classic SparkPost.

1. In Bird, open **Settings → API keys**, create a key with email and webhook access, and copy
   it. Bird shows it once. HelloBox finds the region (US or EU) from the key.
2. In HelloBox, open **Settings → Domains → Connect a provider → Bird**, paste the key and press
   **Connect**.
3. Your Bird domains appear. **Add domain** adds one; Bird suggests a subdomain, like
   `mail.example.com`. Add the records HelloBox shows, then **Check again**.
4. On each domain you want to receive on, turn on **Receiving** and add the MX record HelloBox
   shows. Bird turns receiving on once it sees the domain's DKIM record; until then the domain
   shows *Waiting*, and HelloBox keeps trying.

HelloBox adds one signed webhook for delivery events and received mail. Bird keeps received
mail for 30 days, so mail that arrives while HelloBox is down is picked up later.

## SMTP

**What you need:** an SMTP server you can send through with a username and password, such as
Google Workspace's relay, Zoho, Fastmail or your own, and HelloBox's own mail server running
(`MX_HOSTNAME` and `MX_SIGNING_KEY` set on the web app). Without the mail server, SMTP isn't
offered: an SMTP server can't pass incoming mail on to HelloBox.

1. In HelloBox, open **Settings → Domains → Connect a provider → SMTP**.
2. Enter the **server** (like `smtp.example.com`), the **port**, the **username** and the
   **password**. Use an app password where your provider offers one.
   - **587** (or **2525**) starts plain and must switch to a secure connection (STARTTLS).
   - **465** is secure from the start.
   - A server that offers neither isn't used, so a password never crosses the network in the
     clear.
3. Press **Connect**. HelloBox signs in once to check, and saves nothing if that fails.
4. **Add domain** for each domain you send from. An SMTP server can't list them.
5. On each domain, press **Receive with HelloBox…** and follow the steps: a TXT record that
   proves the domain is yours, then the MX record.

Set up SPF and DKIM for the domain wherever your SMTP provider says, so your mail doesn't land
in spam. HelloBox has no records of its own to show for SMTP.

If the password changes, the connection shows **Connect again**.

## Set up your domains

After you connect, **Settings → Domains** lists the domains in your provider account. For
Postmark, Mailgun, SES, SendGrid, Brevo, MailerSend, Mailjet and Bird, **Add domain** adds a new one; for Resend, add it in Resend. For
SMTP, add each domain you send from.

### Add the DNS records

For each domain, HelloBox shows the DNS records it still needs:

| Record | What it does |
|---|---|
| **TXT** (SPF, DKIM) and sometimes **CNAME** | Prove your provider may send for the domain, so your mail doesn't land in spam. |
| **MX** | Sends the domain's incoming mail to your provider. Only needed to receive. |

Add them at your DNS host, the same way you [added the A records](dns.md#add-the-records):
copy each **Name** and **Value** exactly, as HelloBox shows them. Then press **Check again**. DNS
changes can take up to an hour.

If your DNS is in Cloudflare and your instance has the Cloudflare settings (`CF_CLIENT_ID` and
`CF_CLIENT_SECRET`), **Add DNS records** writes them for you. With SES and Route 53, the box you
ticked when connecting does the same.

### Turn on receiving

Each domain has a switch, **Receive mail for this domain**. Turn it on to get the domain's mail
in HelloBox. (With Resend, receiving is turned on in Resend.)

### What the labels mean

| Label | Meaning |
|---|---|
| **Waiting for DNS** | Your provider doesn't see the records yet. Check them and wait. |
| **Verified** | Sending works. |
| **Receiving waits for the MX** | Receiving is on, but the provider doesn't see the MX record yet. |
| **Waiting for the first email…** | All set. Send a test. |
| **Receiving** | Mail is arriving. |

## Receive on a subdomain

**Already receive mail at this domain somewhere else**, like Google Workspace or Microsoft 365?
Changing the MX record would move all of it to HelloBox. Don't.

Use **Receive replies on a subdomain** under the domain instead. HelloBox receives at, say,
`inbox.example.com`; the mail you already get at `example.com` stays where it is. You keep
sending from `example.com`, and HelloBox shows you how to set a *Reply-To* so replies land in
HelloBox.

## Send a test

Once a domain shows **Waiting for the first email…**, send an email to any address at it from
your personal email. It should appear in HelloBox within a few seconds. Reply to it and check
that the reply arrives. (With SES in the sandbox, your personal address must be a
[test recipient](#part-3-domains-and-leaving-the-sandbox) first.)

Nothing shows up? See [Troubleshooting](troubleshooting.md#mail-doesnt-arrive).

## The webhook addresses

HelloBox creates these at your provider for you. You only need them to check your provider's
settings. Each starts with your `APP_URL`; `<connection>` is a long random ID that keeps the
address private.

| Provider | Webhook addresses |
|---|---|
| Postmark | `/api/webhooks/postmark/<connection>/inbound` and `/events` |
| Mailgun | `/api/webhooks/mailgun/<connection>/inbound` and `/events` |
| Resend | `/api/webhooks/resend/<connection>` |
| Amazon SES | `/api/webhooks/ses/<connection>/inbound` and `/events` |
| SendGrid | `/api/webhooks/sendgrid/<connection>/inbound` and `/events` |
| Brevo | `/api/webhooks/brevo/<connection>/inbound` and `/events` |
| MailerSend | `/api/webhooks/mailersend/<connection>/inbound` and `/events` |
| Mailjet | `/api/webhooks/mailjet/<connection>/inbound` and `/events` |
| Bird | `/api/webhooks/bird/<connection>` |

If you change `APP_URL` later, your provider still calls the old addresses: press
**Reconnect** (or **Connect again**) on each connection.

## Use another provider

These are built in. If you use another one, you can add it: each provider is one
implementation of the `MailProvider` interface, and Postmark and Mailgun are the shortest
examples. Read the [contributing guide](../../CONTRIBUTING.md), or ask in
[Discussions](https://github.com/HelloboxGH/hellobox/discussions) first.

HelloBox is set up. The pages after this one are for later:
[back up](backups.md) and [upgrade](upgrade.md).
