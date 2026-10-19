#!/usr/bin/env bash
# Force Homunculus to use Node.js instead of Bun.
# Use this if Bun causes high CPU usage on your platform.
unset HOMUNCULUS_USE_BUN SILLYBUNNY_USE_BUN
export HOMUNCULUS_USE_NODE=1
export HOMUNCULUS_TERMUX_RUNTIME=node
exec "$(dirname "${BASH_SOURCE[0]}")/start.sh" "$@"
