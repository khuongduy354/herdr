#!/bin/sh
# Linux installation, isolated from the existing Herdr executable and sessions.
set -eu
source=$(dirname "$(readlink -f "$0")")
binary=${HERDR_KOALA_BINARY:-$source/../../target/release/herdr}
if [ ! -x "$binary" ]; then echo 'Run just build first.' >&2; exit 1; fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
destination="${XDG_DATA_HOME:-$HOME/.local/share}/duys-koala-herd"
install -d "$destination" "$HOME/.local/bin"
cp "$source"/*.mjs "$source/package.json" "$source/package-lock.json" "$destination/"
npm ci --prefix "$destination" --omit=dev --ignore-scripts --no-audit --no-fund
# Desktop launchers may not load nvm or the interactive shell's PATH.
node -p 'process.execPath' > "$destination/node-path"
# Replace atomically so an already running executable remains valid.
install -m 755 "$binary" "$destination/herdr.new"
mv -f "$destination/herdr.new" "$destination/herdr"
install -m 755 "$source/run.sh" "$destination/run.sh"
ln -sfn "$destination/run.sh" "$HOME/.local/bin/duys-koala-herd"
printf '%s\n' "Installed Duy's Koala Herd. Run duys-koala-herd."
