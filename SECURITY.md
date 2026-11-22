# Security policy

HelloBox handles other people's email, so we take security reports seriously and thank
everyone who sends one.

## Report a vulnerability

**Don't open a public issue, discussion or pull request.** Report it privately instead:

1. Open the repository's **Security** tab.
2. Press **Report a vulnerability**.
3. Describe the problem: what an attacker can do, the steps to reproduce it, and the version
   or commit you tested (`git describe --tags`).

Only you and the maintainers can see the report. We talk it through there, and credit you
in the advisory unless you'd rather stay anonymous.

## What we promise

- We acknowledge your report within **3 working days**.
- We tell you whether we accept it, and keep you updated while we work on a fix.
- We fix accepted problems in a release as soon as we can, then publish an advisory that
  says who's affected and what to do.
- We won't take legal action against research done in good faith that follows this policy.

Please give us a reasonable time to release a fix before you talk about it publicly.

## In scope

- The code in this repository: the web app, the worker, the packages, the admin tool, and
  the Docker setup in `docker/`.
- HelloBox Cloud at [hellobox.app](https://hellobox.app), as long as you only test with
  accounts and data that are yours. Don't access other people's mail, don't degrade the
  service, and don't send spam.

## Not in scope

- Problems in a self-hosted server's own setup (an open port, a weak password, a missing
  update), unless our docs told you to set it up that way.
- Reports from automated scanners without a way to exploit them.
- Missing best-practice headers or settings that don't lead to a real attack.
- Social engineering and physical attacks.

## Supported versions

We fix security problems in the newest release. If you self-host, keep up to date with the
[upgrade guide](docs/self-hosting/upgrade.md).
