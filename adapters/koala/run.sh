#!/bin/sh
set -eu
adapter=$(dirname "$(readlink -f "$0")")
binary=${HERDR_KOALA_BINARY:-$adapter/herdr}
if [ ! -x "$binary" ]; then binary="$adapter/../../target/release/herdr"; fi
if [ ! -x "$binary" ]; then
  echo "Build Duy's Koala Herd with just build before launching." >&2
  exit 1
fi
export HERDR_KOALA_ADAPTER="$adapter/worker.mjs"
unset HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH
exec "$binary" --session "${HERDR_KOALA_SESSION:-duys-koala-herd}" "$@"
