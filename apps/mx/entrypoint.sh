#!/bin/sh
# Haraka reads its settings from files, and the image's filesystem is read-only. So the
# settings are copied to /run/haraka (a tmpfs) and completed from the environment.
set -eu

: "${MX_HOSTNAME:?Set MX_HOSTNAME to the name the MX record points at, like mx1.example.com}"
: "${HELLOBOX_URL:?Set HELLOBOX_URL to the HelloBox address, like https://hellobox.example.com}"
: "${MX_SIGNING_KEY:?Set MX_SIGNING_KEY to the same value as on the HelloBox web app}"

home=/run/haraka
if ! [ -w "$home" ]; then
  echo "$home isn't writable by $(id -un) ($(id -u)). Mount a tmpfs there owned by that user, like /run/haraka:uid=$(id -u),gid=$(id -g)" >&2
  exit 1
fi
rm -rf "${home:?}"/*
cp -r /app/config /app/plugins "$home/"
echo "$MX_HOSTNAME" > "$home/config/me"

# STARTTLS only with a certificate. Without one, mail still arrives, unencrypted.
if [ -f /certs/key.pem ] && [ -f /certs/cert.pem ]; then
  if ! [ -r /certs/key.pem ] || ! [ -r /certs/cert.pem ]; then
    echo "The certificate in /certs isn't readable by uid $(id -u). Make key.pem and cert.pem readable by it (chown $(id -u) on the host)" >&2
    exit 1
  fi
  cp /certs/key.pem "$home/config/tls_key.pem"
  cp /certs/cert.pem "$home/config/tls_cert.pem"
  { echo tls; cat "$home/config/plugins.base"; } > "$home/config/plugins"
else
  echo "No certificate in /certs: STARTTLS is off" >&2
  cp "$home/config/plugins.base" "$home/config/plugins"
fi

exec haraka -c "$home"
