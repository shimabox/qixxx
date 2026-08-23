#!/bin/sh
set -eu

umask 077
PATH="${NODE_BIN_DIR}:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

cd "${QIXXX_REPO_PATH}"

CLOUDFLARE_API_TOKEN=$(/usr/bin/security find-generic-password -s qixxx-ranking-audit -a CLOUDFLARE_API_TOKEN -w)
RANKING_IP_HASH_KEY=$(/usr/bin/security find-generic-password -s qixxx-ranking-audit -a RANKING_IP_HASH_KEY -w)
export CLOUDFLARE_API_TOKEN RANKING_IP_HASH_KEY

exec npm run ranking:remote:audit
