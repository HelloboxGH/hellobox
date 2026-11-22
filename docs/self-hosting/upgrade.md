# Upgrade

New HelloBox versions bring fixes, security updates and features. Upgrading takes a few
minutes, and HelloBox is down for about a minute while it restarts.

## Find out what's new

Releases are listed on the [releases page](https://github.com/HelloboxGH/hellobox/releases),
named by date: `2026.12.1` is the first release of December 2026. To see which version you
run:

```bash
cd ~/hellobox/docker
grep ^HELLOBOX_VERSION .env
```

Read the notes of **every** release between yours and the new one. Most changes need
nothing from you. Lines starting with **Breaking:** do: they say what you have to change,
such as a setting that was renamed. Do those steps along with the upgrade.

To hear about new releases, open the repository on GitHub, press **Watch → Custom**, and
tick **Releases**.

## Upgrade, step by step

1. **Back up.** Run your [backup script](backups.md#the-backup-script):

   ```bash
   ./backup.sh
   ```

2. **Get the new version's files**, so `compose.yml` matches the new images. Replace
   `<version>` with the new version, for example `2026.12.1`:

   ```bash
   git fetch --tags
   git checkout <version>
   ```

   If Git refuses because "your local changes would be overwritten", you edited a file
   that came with HelloBox (often `compose.yml`). Run `git diff` to see what you changed,
   then `git stash`, check out again, and redo your change by hand.

3. **Set the version in `.env`:**

   ```bash
   sed -i "s|^HELLOBOX_VERSION=.*|HELLOBOX_VERSION=<version>|" .env
   ```

4. **Do any `Breaking:` steps** from the release notes.

5. **Download and restart:**

   ```bash
   docker compose pull
   docker compose up -d
   ```

6. **Check it**, as after the install:

   ```bash
   docker compose ps
   ```

   Every part should become `healthy` within a couple of minutes. Then sign in and open a
   conversation.

## What happens during an upgrade

The worker starts first and updates the database for the new version (these updates are
called *migrations*). The web app waits until the worker is ready, then starts. If a
migration fails, the worker stops, the web app doesn't start, and
`docker compose logs worker` says why.

## Going back

Migrations only go forward: an older version can't read a database that a newer one
updated. To go back, check out the old version again, set it in `.env`, and
[restore the backup](backups.md#restore) you took in step 1.

## Why pin a version

`HELLOBOX_VERSION=latest` takes whatever is newest each time you pull, which can include
a breaking change you haven't read about. With a pinned version, HelloBox only changes when
you decide to upgrade.
