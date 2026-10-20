#!/bin/sh
# Mozilla Bugzilla 2083449: distrust only emSign ECC Root CA - G3.
set -eu
fingerprint=86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B
is_g3() {
    identity=$(openssl x509 -in "$1" -noout -subject -issuer -nameopt RFC2253 2>/dev/null) || return 1
    case "$identity" in
      *'CN=emSign ECC Root CA - G3,'*'O=eMudhra Technologies Limited,'*'C=IN'*)
        actual=$(openssl x509 -in "$1" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':')
        [ "$actual" = "$fingerprint" ] || { echo 'Unexpected G3 certificate fingerprint' >&2; exit 1; }
        return 0;;
      *) return 1;;
    esac
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
# Disable the Debian anchor as well as removing it. Reinstallation must not
# silently enable this root during a subsequent package operation.
if [ -f /etc/ca-certificates.conf ]; then
    sed -i 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt$|!mozilla/emSign_ECC_Root_CA_-_G3.crt|' /etc/ca-certificates.conf
fi
for directory in /usr/share/ca-certificates /usr/local/share/ca-certificates; do
    [ ! -d "$directory" ] || find "$directory" -type f \( -name '*.crt' -o -name '*.pem' \) >> "$work/anchors"
done
if [ -f "$work/anchors" ]; then
    while IFS= read -r certificate; do
        if is_g3 "$certificate"; then rm "$certificate"; fi
    done < "$work/anchors"
fi
update-ca-certificates --fresh
# Python distributions can carry certifi separately from the OS store.
for directory in /usr/local/lib /opt; do
    [ ! -d "$directory" ] || find "$directory" -type f -path '*/certifi/cacert.pem' >> "$work/bundles"
done
printf '%s\n' /etc/ssl/certs/ca-certificates.crt >> "$work/bundles"
while IFS= read -r bundle; do
    [ -f "$bundle" ] || { echo "Missing CA bundle: $bundle" >&2; exit 1; }
    mkdir "$work/parts"
    awk -v dir="$work/parts" '/-----BEGIN CERTIFICATE-----/{n++; out=sprintf("%s/%06d.pem",dir,n)} out {print > out} /-----END CERTIFICATE-----/{close(out);out=""}' "$bundle"
    : > "$work/filtered"
    count=0
    for certificate in "$work"/parts/*.pem; do
        openssl x509 -in "$certificate" -noout >/dev/null
        if ! is_g3 "$certificate"; then cat "$certificate" >> "$work/filtered"; count=$((count+1)); fi
    done
    [ "$count" -gt 0 ] || { echo "Empty trust store: $bundle" >&2; exit 1; }
    cat "$work/filtered" > "$bundle"
    rm -rf "$work/parts"
    printf 'Verified G3 absent: %s (%s certificates)\n' "$bundle" "$count"
done < "$work/bundles"
# Rehash symlinks without enabling disabled anchors again.
openssl rehash /etc/ssl/certs
