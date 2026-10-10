#!/bin/sh
# Installs the Trommi connector (trommi-connector) from a signed release of github.com/trommi/trommi.
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh
#
#   install.sh                  the newest release that has a connector for this machine
#   install.sh --tag <tag>      that release (a release older than the one installed is refused all the same)
#   install.sh --from <dir>     a release that lies in a folder already: manifest.json, manifest.json.sig and
#                               trommi-connector-<target>, as downloaded from a release page
#
# What it does, in this order:
#   1. finds the release (GitHub's feed of releases, then each asked for its files) and downloads manifest.json, manifest.json.sig and the connector of this
#      machine (github.com, which hands the file out from its release store) into a private folder. Only https, only
#      these hosts, every file bounded in size. Nothing that was downloaded is run or read as a script.
#   2. checks the signature of manifest.json against the release key below (Ed25519 over the manifest's exact
#      bytes; the key is release/public-key.pem of the repository, and a release never brings a key with it),
#   3. checks what the manifest says: product, repository, tag, a version not older than the one installed,
#   4. checks the connector against the manifest: its size and its SHA-256,
#   5. only then makes the file executable, asks it for its version (the connector checks the same manifest
#      against the key that is compiled into it) and puts it in place:
#        ~/.local/share/trommi/bin/trommi-connector, manifest.json, manifest.json.sig
#        ~/.local/bin/trommi-connector -> the first
#   6. says the version that was verified and the SHA-256 of its manifest.
#
# It refuses to run as root, asks for nothing, changes nothing outside the two folders named above, and does not
# touch Claude Code or Codex: `trommi-connector setup claude` and `trommi-connector setup codex` do that.
#
# Who vouches for this script itself: on the first run only TLS and GitHub. Whoever wants more downloads a
# release by hand, checks it with release/sign.sh (verify, then files) from a checkout, and runs
# `install.sh --from <dir>`.
#
# Needs: sh, curl, an openssl that knows Ed25519 (OpenSSL 3; on macOS `brew install openssl@3`), sha256sum or
# shasum. Linux and macOS, x86_64 and arm64.
set -eu

# Everything is in main(), called on the last line: piped into sh, the whole script is read before anything runs.
main() {
umask 077
REPOSITORY=trommi/trommi
MAX_MANIFEST=1048576
MAX_BINARY=209715200
MAX_LISTING=8388608

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

from='' tag=''
while [ $# -gt 0 ]; do
  case $1 in
    --from) [ $# -ge 2 ] || fail "--from needs a folder"; from=$2; shift 2 ;;
    --tag) [ $# -ge 2 ] || fail "--tag needs a tag"; tag=$2; shift 2 ;;
    *) fail "unknown argument $1 (use --tag <tag> or --from <dir>)" ;;
  esac
done
[ -z "$from" ] || [ -z "$tag" ] || fail "--from and --tag do not go together"
if [ -n "$tag" ]; then
  printf '%s' "$tag" | grep -Eq '^([a-z]+-)?v[1-9][0-9]{0,11}$' || fail "not a release tag: $tag"
fi

[ "$(id -u)" != 0 ] || fail "do not run this as root: the connector belongs to the user whose Claude Code or Codex starts it."
case ${HOME:-} in /*) ;; *) fail "HOME is not set to a folder" ;; esac
[ -d "$HOME" ] || fail "HOME is not set to a folder"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64) target=x86_64-unknown-linux-musl ;;
  Linux/aarch64|Linux/arm64) target=aarch64-unknown-linux-musl ;;
  Darwin/arm64|Darwin/aarch64) target=aarch64-apple-darwin ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  *) fail "there is no Trommi connector for $(uname -s)/$(uname -m) (only Linux and macOS, x86_64 and arm64)" ;;
esac
name=trommi-connector-$target

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "neither sha256sum nor shasum is here"
fi
size_of() { wc -c < "$1" | tr -d ' '; }

share=$HOME/.local/share/trommi
bin=$share/bin
link_dir=$HOME/.local/bin
mkdir -p "$share" "$bin"
work=$(mktemp -d "$share/install.XXXXXX") || fail "no private folder under $share"
trap 'rm -rf "$work"' EXIT
trap 'exit 1' INT TERM HUP

# The release key: release/public-key.pem of the repository.
cat > "$work/key.pem" <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAvWZlpOXX2LEyKOWZR0LvtTEfi9vksICT/a2nl68x7L8=
-----END PUBLIC KEY-----
KEY

# An openssl that can check an Ed25519 signature over a file. The one of macOS itself cannot.
openssl=
for candidate in openssl /opt/homebrew/opt/openssl@3/bin/openssl /usr/local/opt/openssl@3/bin/openssl; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  "$candidate" pkey -pubin -in "$work/key.pem" -noout >/dev/null 2>&1 || continue
  "$candidate" pkeyutl -help 2>&1 | grep -q -- -rawin || continue
  openssl=$candidate
  break
done
[ -n "$openssl" ] || fail "no openssl here can check an Ed25519 signature (OpenSSL 3 is needed; on macOS: brew install openssl@3). Nothing was installed."

# Whether the signature beside a manifest is the release key's.
signed() {
  [ "$(size_of "$1.sig")" = 64 ] || return 1
  "$openssl" pkeyutl -verify -rawin -pubin -inkey "$work/key.pem" -in "$1" -sigfile "$1.sig" >/dev/null 2>&1
}
# One value of a manifest in the form release/manifest.sh writes: a line `  "key": value,`.
stated() { sed -n 's/^  "'"$2"'": "\{0,1\}\([A-Za-z0-9._\/-]*\)"\{0,1\},\{0,1\}$/\1/p' "$1"; }

# ---- 1. the three files ----------------------------------------------------------------------------------------
if [ -n "$from" ]; then
  [ -d "$from" ] || fail "no such folder: $from"
  for file in manifest.json manifest.json.sig "$name"; do
    [ -f "$from/$file" ] || fail "$from holds no $file"
  done
  [ "$(size_of "$from/manifest.json")" -le "$MAX_MANIFEST" ] || fail "manifest.json is larger than a manifest is"
  [ "$(size_of "$from/$name")" -le "$MAX_BINARY" ] || fail "$name is larger than a connector is"
  cp "$from/manifest.json" "$work/manifest.json"
  cp "$from/manifest.json.sig" "$work/manifest.json.sig"
  cp "$from/$name" "$work/$name"
else
  command -v curl >/dev/null 2>&1 || fail "curl is missing"
  # Only https, no redirect followed by curl itself.
  get() { curl -sS --proto '=https' --tlsv1.2 --max-redirs 0 "$@"; }
  # A file of a release: github.com answers with a redirect into its release store. The redirect is read, held
  # against the hosts that store is, and fetched as a second request.
  fetch() {
    url=https://github.com/$REPOSITORY/releases/download/$1/$2
    to=$(get --max-time 60 -o /dev/null -w '%{redirect_url}' "$url") || fail "could not reach $url"
    case $to in
      https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;
      '') fail "$url is not there" ;;
      *) fail "$url points somewhere unexpected; nothing was installed" ;;
    esac
    get -f --max-time 900 --max-filesize "$4" -o "$3" "$to" || fail "could not download $url"
    [ "$(size_of "$3")" -le "$4" ] || fail "$2 of $1 is larger than it may be"
  }
  # Whether a release has a file: github.com answers with a redirect for one that is there, 404 for one that is not.
  has() {
    code=$(get --head --max-time 60 -o /dev/null -w '%{http_code}' "https://github.com/$REPOSITORY/releases/download/$1/$2") || fail "could not reach github.com"
    case $code in 30[12378]) return 0 ;; 404) return 1 ;; *) fail "github.com answers $code for $2 of $1" ;; esac
  }
  if [ -z "$tag" ]; then
    # GitHub's feed of releases names the newest; each, highest number first, is asked for the two files.
    get -f --max-time 60 --max-filesize "$MAX_LISTING" -o "$work/releases.atom" "https://github.com/$REPOSITORY/releases.atom" \
      || fail "could not read the releases of $REPOSITORY from github.com"
    sed -n 's|.*href="https://github.com/'"$REPOSITORY"'/releases/tag/\([a-z-]*v[1-9][0-9]*\)".*|\1|p' "$work/releases.atom" \
      | while read -r candidate; do
          printf '%s' "$candidate" | grep -Eq '^([a-z]+-)?v[1-9][0-9]{0,11}$' || continue
          printf '%s %s\n' "${candidate##*v}" "$candidate"
        done | sort -n -r -u | head -n 20 > "$work/tags"
    while read -r _ candidate; do
      if has "$candidate" "$name" && has "$candidate" manifest.json; then tag=$candidate; break; fi
    done < "$work/tags"
    [ -n "$tag" ] || fail "no recent release of $REPOSITORY has a connector for $target"
  fi
  say "Downloading the Trommi connector, release $tag, for $target"
  fetch "$tag" manifest.json "$work/manifest.json" "$MAX_MANIFEST"
  fetch "$tag" manifest.json.sig "$work/manifest.json.sig" 1024
  fetch "$tag" "$name" "$work/$name" "$MAX_BINARY"
fi

# ---- 2. the signature ------------------------------------------------------------------------------------------
signed "$work/manifest.json" || fail "the signature of manifest.json is not the release key's. Nothing was installed."

# ---- 3. what the manifest says ---------------------------------------------------------------------------------
product=$(stated "$work/manifest.json" product)
version=$(stated "$work/manifest.json" version)
stated_tag=$(stated "$work/manifest.json" tag)
case $product in trommi-connector|trommi) ;; *) fail "the release is of another product ($product). Nothing was installed." ;; esac
[ "$(stated "$work/manifest.json" repository)" = "$REPOSITORY" ] || fail "the release is of another repository. Nothing was installed."
printf '%s' "$version" | grep -Eq '^[1-9][0-9]{0,11}$' || fail "the manifest names no version. Nothing was installed."
case $stated_tag in "v$version"|"connector-v$version") ;; *) fail "the manifest's tag is not its version's. Nothing was installed." ;; esac
if [ -n "$tag" ] && [ "$stated_tag" != "$tag" ]; then fail "the manifest is of $stated_tag, asked for was $tag. Nothing was installed."; fi
# never back: what is installed was verified when it was installed, and is verified again before it counts
if [ -f "$bin/manifest.json" ] && [ -f "$bin/manifest.json.sig" ] && signed "$bin/manifest.json"; then
  installed=$(stated "$bin/manifest.json" version)
  if printf '%s' "$installed" | grep -Eq '^[1-9][0-9]{0,11}$' && [ "$installed" -gt "$version" ]; then
    fail "release $version is older than the installed one ($installed). Nothing was changed."
  fi
fi

# ---- 4. the file -----------------------------------------------------------------------------------------------
# one asset per line, as release/manifest.sh writes it; exactly one line may name this file
sed -n 's/^ *{ "name": "'"$name"'", "sha256": "\([0-9a-f]\{64\}\)", "size": \([1-9][0-9]*\) }.*/\1 \2/p' "$work/manifest.json" > "$work/asset"
[ "$(wc -l < "$work/asset" | tr -d ' ')" = 1 ] || fail "the manifest names no connector for $target. Nothing was installed."
read -r want_sum want_size < "$work/asset"
[ "$(size_of "$work/$name")" = "$want_size" ] || fail "the downloaded connector is not the file the manifest names. Nothing was installed."
[ "$(sha256 "$work/$name")" = "$want_sum" ] || fail "the downloaded connector is not the file the manifest names. Nothing was installed."

# ---- 5. in place -----------------------------------------------------------------------------------------------
# Only now is the file made executable and started once, with its manifest beside it: the connector checks the
# same release against the key that is compiled into it.
mkdir "$work/stage"
cp "$work/manifest.json" "$work/manifest.json.sig" "$work/stage/"
cp "$work/$name" "$work/stage/trommi-connector"
chmod 755 "$work/stage/trommi-connector"
answer=$("$work/stage/trommi-connector" --version </dev/null 2>&1) || fail "the connector does not start on this machine: $answer"
case $answer in
  *"release $version, signature verified"*|*"release $stated_tag, signature verified"*) ;;
  *) fail "the connector does not find itself verified ($answer). Nothing was installed." ;;
esac
# the manifest first, the program last: each by a rename within one folder
chmod 644 "$work/stage/manifest.json" "$work/stage/manifest.json.sig"
for file in manifest.json.sig manifest.json trommi-connector; do
  mv -f "$work/stage/$file" "$bin/.new.$file"
  mv -f "$bin/.new.$file" "$bin/$file"
done
mkdir -p "$link_dir"
ln -sf "$bin/trommi-connector" "$link_dir/.trommi-connector.new"
mv -f "$link_dir/.trommi-connector.new" "$link_dir/trommi-connector"

# ---- 6. what was installed -------------------------------------------------------------------------------------
say "Installed: trommi-connector, release $version ($stated_tag), signature verified"
say "  manifest.json SHA-256: $(sha256 "$bin/manifest.json")"
say "  program: $bin/trommi-connector"
say "  command: $link_dir/trommi-connector"
case ":${PATH:-}:" in
  *":$link_dir:"*) ;;
  *) say "  $link_dir is not on your PATH: add it, or call the program by its full path." ;;
esac
say "Next: trommi-connector setup claude   (or: setup codex), then in your project: trommi-connector connect '<invite link>'"
}

main "$@"
