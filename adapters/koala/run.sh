#!/bin/sh
set -eu
adapter=$(dirname "$(readlink -f "$0")")
if [ -f "$adapter/node-path" ]; then
  IFS= read -r node_binary < "$adapter/node-path"
  if [ ! -x "$node_binary" ]; then
    echo "The installed Node.js runtime is missing. Reinstall Duy's Koala Herd with Node.js 22 or newer." >&2
    exit 1
  fi
  PATH="$(dirname "$node_binary"):$PATH"
  export PATH
fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' 2>/dev/null; then
  echo "Duy's Koala Herd requires Node.js 22 or newer. Run adapters/koala/install.sh from a Node.js 22+ shell." >&2
  exit 1
fi
binary=${HERDR_KOALA_BINARY:-$adapter/herdr}
if [ ! -x "$binary" ]; then binary="$adapter/../../target/release/herdr"; fi
if [ ! -x "$binary" ]; then
  echo "Build Duy's Koala Herd with just build before launching." >&2
  exit 1
fi
export HERDR_KOALA_ADAPTER="$adapter/worker.mjs"
unset HERDR_SOCKET_PATH HERDR_CLIENT_SOCKET_PATH
exec "$binary" --session "${HERDR_KOALA_SESSION:-duys-koala-herd}" "$@"
