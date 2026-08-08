#!/usr/bin/env bash
# Create the local certificate the port signs patched binaries with. One time,
# by hand, in a real Terminal: it needs a trust confirmation and your login
# password, and neither can be answered by a background job.
#
#   setup-signing.sh
#
# macOS keys TCC permissions — automation, accessibility, screen recording — to
# a binary's signing identity. tweakcc's repack is ad-hoc signed, which gives it
# no identity beyond its own hash, so every promotion is an app macOS has never
# seen and every permission is asked for again. Signing with one stable
# certificate makes every future patched binary the same app: you answer the
# prompts once more, and never again.
set -euo pipefail
[[ "$(uname)" == Darwin ]] || { echo "Code signing is macOS-only — nothing to set up."; exit 0; }
NAME=claude-patching
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning -v 2>/dev/null | grep -q "\"$NAME\""; then
  echo "A $NAME code-signing identity already exists — nothing to do."
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-signing.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# /usr/bin/openssl, not a Homebrew one: LibreSSL's PKCS#12 output is the format
# security(1) can still import. Twenty years, because a certificate that expires
# is a certificate whose grants all have to be answered again.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 7300 \
  -subj "/CN=$NAME" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -name "$NAME" \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/identity.p12" -passout pass:"$NAME"
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$NAME" -T /usr/bin/codesign

# codesign refuses an identity it cannot build a chain for, so a self-signed
# certificate has to be trusted as its own root. Only for code signing: this
# says nothing about who may serve TLS.
echo
echo "Trusting the certificate for code signing — macOS will ask you to confirm."
security add-trusted-cert -r trustRoot -p codeSign "$WORK/cert.pem"

# The port signs unattended, so codesign must reach the key without a keychain
# dialog. Scoped to this key by label, so no other identity's access changes.
echo
echo "The port signs in the background, so the new key needs to be usable without a dialog."
printf 'macOS login password: '
read -rs PASSWORD
echo
security set-key-partition-list -S apple-tool:,apple: -s -l "$NAME" -k "$PASSWORD" "$KEYCHAIN" >/dev/null

security find-identity -p codesigning -v | grep -q "\"$NAME\"" ||
  { echo "$NAME is still not a valid code-signing identity — the port will keep signing ad-hoc. The errors above say why." >&2; exit 1; }

cat <<EOF

Done — $NAME is a valid code-signing identity, and the next port signs with it.
To rebuild now rather than wait for the next Claude Code release:

    trash ~/.local/share/claude/versions/\$(basename "\$(realpath ~/.local/bin/claude)").patched

and start a session. Expect one last round of macOS permission prompts for the
freshly signed binary; after that the grants carry across every promotion.
EOF
