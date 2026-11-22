# Back up and restore

A server can die, a disk can fail, an upgrade can go wrong. A backup is a copy of
everything HelloBox needs, kept somewhere else, so you can start again on a new server
without losing mail.

**Set this up on the day you install, and test a restore once.** A backup you've never
restored is a hope, not a backup.

## What to back up

| What | Where it is | Why |
|---|---|---|
| The database | The `postgres` container | Accounts, workspaces, conversations, settings. |
| The files | The `storage` container | Attachments and the original copy of every message. |
| Your `.env` | `~/hellobox/docker/.env` | Without `ENCRYPTION_KEY`, the database's provider keys can't be read. |

If you [use your own S3 storage](storage.md), the files are already off your server. Back
them up with that service's own tools instead (versioning, or copying to a second bucket),
and skip the files part below.

## The backup script

This script backs up all three into `~/hellobox/docker/backups`, and keeps the last seven
database copies. Make it:

```bash
cd ~/hellobox/docker
nano backup.sh
```

Paste this, then save (Ctrl+O, Enter) and quit (Ctrl+X):

```bash
#!/bin/sh
# Backs up HelloBox's database, files and settings into ./backups.
set -e
cd "$(dirname "$0")"
mkdir -p backups

# The database, in one file per day.
docker compose exec -T postgres pg_dump -U hellobox -Fc hellobox > "backups/db-$(date +%F).dump"

# The files. This only adds and updates, so it stays one folder.
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" --entrypoint sh storage-init \
  -c 'rc alias set store http://storage:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && rc mirror "store/$S3_BUCKET" /backup/storage'

# The settings.
cp .env backups/env
chmod 600 backups/env

# Keep the newest seven database copies.
ls -1t backups/db-*.dump | tail -n +8 | xargs -r rm --
```

Make it runnable and try it:

```bash
chmod +x backup.sh
./backup.sh
ls -lh backups
```

You should see a `db-<today>.dump` file, a `storage` folder and an `env` file.

## Run it every night

`cron` runs commands on a schedule. Open your schedule:

```bash
crontab -e
```

The first time, it asks which editor to use: pick `nano`. Add this line at the end:

```text
30 3 * * * /home/hellobox/hellobox/docker/backup.sh >> /home/hellobox/hellobox/docker/backups/backup.log 2>&1
```

It means: every day at 03:30 (server time), run the script, and write what happened to
`backup.log`. Save and quit. Check the log tomorrow:

```bash
tail ~/hellobox/docker/backups/backup.log
```

No output at all means it worked without complaint.

## Copy the backups off the server

A backup on the same server dies with the server. Copy the `backups` folder somewhere else
regularly. The simplest way, from **your own computer**:

```bash
rsync -a hellobox@<server-ip>:hellobox/docker/backups/ ./hellobox-backups/
```

Run it every week or so, or automate it. Other good options: your hosting company's
snapshot or backup feature (often a few euros a month), or a tool like
[restic](https://restic.net) that sends encrypted backups to object storage.

The `env` file holds your secrets. Wherever the backups go, keep them private.

## Restore

On a new server, follow [Get a server ready](server.md), [point DNS at it](dns.md), and
[download HelloBox](install.md#download-hellobox) at the same version you had. Then copy
your backups folder to `~/hellobox/docker/backups` (with `rsync` from your computer, the
other way round), and:

1. Put your settings back:

   ```bash
   cd ~/hellobox/docker
   cp backups/env .env
   chmod 600 .env
   ```

2. Start only the database and load the newest copy (change the date):

   ```bash
   docker compose up -d postgres
   docker compose exec -T postgres pg_restore -U hellobox -d hellobox --no-owner < backups/db-2026-11-22.dump
   ```

3. Start the storage and put the files back:

   ```bash
   docker compose up -d storage storage-init
   docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" --entrypoint sh storage-init \
     -c 'rc alias set store http://storage:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && rc mirror /backup/storage "store/$S3_BUCKET"'
   ```

4. Start everything:

   ```bash
   docker compose up -d
   ```

Then [turn on HTTPS](https.md) as before. Sign in and check that your conversations and
attachments are there.

## Test a restore

Once, soon after you install, rent a small server for an hour and restore onto it. Use a
different name than `mail.example.com` (like `restore-test.example.com`) and set `APP_URL`
to it in the restored `.env`, so your real instance isn't touched. Delete the test server
when you're done.
