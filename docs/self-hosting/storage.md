# Use your own S3 storage

HelloBox keeps attachments and the original copy of every message in *object storage*: a
place for files that programs reach over the web. The common way to talk to it is called
S3, after Amazon's service, and many companies offer the same thing.

By default HelloBox runs its own storage on your server, so you don't need any of this.
Use your own if:

- your server's disk is small, and you'd rather pay a few cents per GB elsewhere;
- you want your files in a service that keeps copies for you.

Do this before you have real mail in HelloBox. Moving existing files from the bundled
storage to another one isn't covered here.

## Which service

Any S3-compatible service works: AWS S3, Backblaze B2, Wasabi, Hetzner Object Storage,
Scaleway, Cloudflare R2 and more.

## 1. Create a bucket and a key

In your service's dashboard:

1. Create a **bucket** (a top-level folder). Name it, for example, `hellobox-mail`. Keep it
   **private**: no public access.
2. Create an **access key** (it may be called an application key or API token) that can read
   and write that bucket. You get two values: a key ID and a secret. Keep them in your
   password manager.
3. Note the service's **endpoint** (an address like `https://s3.eu-central-003.backblazeb2.com`)
   and **region** (like `eu-central-003`). The dashboard or the service's docs show both.

## 2. Allow uploads from HelloBox

Browsers upload attachments straight to the bucket. The bucket only allows that if it has a
*CORS rule* naming your HelloBox address. Most dashboards have a **CORS** section on the
bucket; paste this, with your own `APP_URL`:

```json
[
  {
    "AllowedOrigins": ["https://mail.example.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Some services set CORS another way (Backblaze B2, for example, has its own format in its
CLI). Look for "CORS" in their docs; the rule must allow `GET` and `PUT` from your `APP_URL`
and expose the `ETag` header.

## 3. Change the settings

On the server, open `.env` (`nano .env` in `~/hellobox/docker`):

1. **Delete the line** `COMPOSE_PROFILES=storage`. This stops the bundled storage.
2. Set the storage lines:

   ```ini
   S3_BUCKET=hellobox-mail
   S3_ACCESS_KEY_ID=<key ID>
   S3_SECRET_ACCESS_KEY=<secret>
   S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
   S3_REGION=eu-central-003
   S3_PUBLIC_ENDPOINT=
   ```

   - For **AWS S3**, leave `S3_ENDPOINT` empty and only set `S3_REGION`.
   - Leave **`S3_PUBLIC_ENDPOINT` empty**. Browsers then use `S3_ENDPOINT`, which is already
     public.

3. Apply it:

   ```bash
   docker compose up -d --remove-orphans
   ```

   `--remove-orphans` stops the bundled storage containers you no longer use.

You don't need the `files.example.com` DNS record or its block in the Caddyfile any more.
You can remove both.

## Cloudflare R2

R2 has its own settings, used when the `S3_*` lines aren't all filled in. Leave `S3_ACCESS_KEY_ID`
and `S3_SECRET_ACCESS_KEY` empty, and set:

```ini
R2_ACCOUNT_ID=<your Cloudflare account ID>
R2_ACCESS_KEY_ID=<R2 token's access key ID>
R2_SECRET_ACCESS_KEY=<R2 token's secret>
R2_BUCKET=hellobox-mail
```

Add the CORS rule from step 2 in the bucket's **Settings → CORS policy**.

## Check it

Open a conversation in HelloBox, write a reply, and attach a small file. If the upload
fails, the browser couldn't reach the bucket: check the CORS rule first, then the endpoint.
`docker compose logs web --tail 50` shows errors from the server's side, such as a wrong
key.
