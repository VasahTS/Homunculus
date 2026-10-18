#!/usr/bin/env bash
# Regenerates public/style-classic.css and public/css/classic--*.css.
# Usage: classic-ui/tools/build-css.sh /path/to/SillyTavern-checkout
# Takes upstream SillyTavern's CSS and appends only the rules SillyBunny adds for its own elements.
set -euo pipefail
ST_ROOT="${1:?path to a SillyTavern checkout (staging branch)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$HERE" && [ -d node_modules ] || npm install --no-audit --no-fund --ignore-scripts >/dev/null
cd "$REPO"

# Stylesheets taken from SillyTavern as-is: SillyBunny's extra rules there only restyle shared
# markup (cards, split panes); the few SillyBunny-only bits are styled in public/css/classic-ui.css.
ST_ONLY=(world-info.css)

MERGED=()
for f in public/css/*.css; do
    name="$(basename "$f")"
    case "$name" in classic--*|classic-*) continue ;; esac
    if [ -f "$ST_ROOT/public/css/$name" ] && ! cmp -s "$ST_ROOT/public/css/$name" "$f"; then
        if [[ " ${ST_ONLY[*]} " == *" $name "* ]]; then
            cp "$ST_ROOT/public/css/$name" "$REPO/public/css/classic--$name"
            continue
        fi
        MERGED+=("css/$name=>css/classic--$name")
    fi
done
node "$HERE/css-merge.mjs" "$ST_ROOT" "$REPO" "$REPO" "style.css=>style-classic.css" "${MERGED[@]}"

# Point style-classic.css imports at the classic copies.
for spec in "${MERGED[@]}"; do
    name="${spec%%=>*}"; name="${name#css/}"
    sed -i -E "s#@import url\(css/${name//./\\.}(\?[^)]*)?\);#@import url(css/classic--${name});#" "$REPO/public/style-classic.css"
done

# SillyBunny-only rules from stylesheets the classic UI no longer loads directly.
rm -f "$REPO/public/css/classic-sb-extras.css"
APPEND=1 node "$HERE/css-merge.mjs" "$ST_ROOT" "$REPO" "$REPO" \
    "extract:css/sillybunny-theme.css=>css/classic-sb-extras.css" \
    "extract:css/personas.css=>css/classic-sb-extras.css"
echo "Classic CSS regenerated."
