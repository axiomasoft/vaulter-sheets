#!/usr/bin/env bash
# Check out the sibling repositories that the Composer path repositories and the npm `file:`
# dependencies point at (`../vaulter`, `../vaulter-collaboration`, `../packman`), beside this
# checkout, at the refs this repository is tested against.
#
# Usage: scripts/ci/checkout-ecosystem.sh [sibling ...]   (default: all three)
#
# Packman is fetched at the tag named by the version the root composer.json pins for
# axiomasoft/packman, so CI and the path repository can never disagree. The Vaulter
# repositories are fetched at main. VAULTER_READ_TOKEN, when set, is sent as an HTTP header
# (never written into a URL or a git config) for the private repositories.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
workspace=$(dirname "$root")
packman_version=$(jq -er '.repositories[] | select(.url == "../packman/packages/*") | .options.versions["axiomasoft/packman"]' "$root/composer.json")

auth=()
if [ -n "${VAULTER_READ_TOKEN:-}" ]; then
    auth=(-c "http.https://github.com/.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$VAULTER_READ_TOKEN" | base64 -w0)")
fi

fetch_dependency() {
    local directory=$1 url=$2 ref=$3
    local dest="$workspace/$directory"
    if [ -e "$dest" ]; then
        echo "sibling present: $dest"
        return 0
    fi
    git init -q "$dest"
    GIT_TERMINAL_PROMPT=0 git "${auth[@]}" -C "$dest" fetch --quiet --depth=1 "$url" "$ref"
    git -C "$dest" checkout -q -b main FETCH_HEAD
    echo "$directory: $ref @ $(git -C "$dest" rev-parse --short HEAD)"
}

siblings=("$@")
if [ ${#siblings[@]} -eq 0 ]; then
    siblings=(vaulter vaulter-collaboration packman)
fi

for sibling in "${siblings[@]}"; do
    case "$sibling" in
        vaulter | vaulter-collaboration)
            fetch_dependency "$sibling" "https://github.com/axiomasoft/$sibling.git" refs/heads/main
            ;;
        packman)
            fetch_dependency packman https://github.com/axiomasoft/packman.git "refs/tags/v$packman_version"
            ;;
        *)
            echo "unknown sibling: $sibling" >&2
            exit 2
            ;;
    esac
done
