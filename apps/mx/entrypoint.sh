#!/bin/sh
# Haraka reads its settings from files, and the image's filesystem is read-only. So the
# settings are copied to /run/haraka (a tmpfs) and completed from the environment.
set -eu

: "${MX_HOSTNAME:?Set MX_HOSTNAME to the name the MX record points at, like mx1.example.com}"
: "${HELLOBOX_URL:?Set HELLOBOX_URL to the HelloBox address, like https://hellobox.example.com}"
: "${MX_SIGNING_KEY:?Set MX_SIGNING_KEY to the same value as on the HelloBox web app}"

home=/run/haraka
rm -rf "${home:?}"/*
cp -r /app/config /app/plugins "$home/"
echo "$MX_HOSTNAME" > "$home/config/me"

# STARTTLS only with a certificate. Without one, mail still arrives, unencrypted.
if [ -f /certs/key.pem ] && [ -f /certs/cert.pem ]; then
  cp /certs/key.pem "$home/config/tls_key.pem"
  cp /certs/cert.pem "$home/config/tls_cert.pem"
  { echo tls; cat "$home/config/plugins.base"; } > "$home/config/plugins"
else
  echo "No certificate in /certs: STARTTLS is off" >&2
  cp "$home/config/plugins.base" "$home/config/plugins"
fi

exec haraka -c "$home"
