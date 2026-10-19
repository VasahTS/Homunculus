#!/usr/bin/env bash
# Force Homunculus to use Bun instead of Node.js.
# Use this when you specifically want Bun behavior on a platform that may prefer Node.js.
unset HOMUNCULUS_USE_NODE SILLYBUNNY_USE_NODE
export HOMUNCULUS_USE_BUN=1
export HOMUNCULUS_TERMUX_RUNTIME=bun
exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
