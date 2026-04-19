#!/bin/bash
#
# Generate SRI (Subresource Integrity) hashes for web assets and
# cache-busting version parameters. Run this after modifying any
# file in public/css/ or public/js/.
#
# SRI hashes prevent the browser from executing tampered scripts
# or stylesheets — if the file content doesn't match the hash in
# index.html, the browser refuses to load it.
#
set -e

cd "$(dirname "$0")"

# Generate SRI hashes (SHA-384)
CSS_HASH="sha384-$(openssl dgst -sha384 -binary public/css/app.css | openssl base64 -A)"
APP_HASH="sha384-$(openssl dgst -sha384 -binary public/js/app.js | openssl base64 -A)"

# Generate short content hashes for cache-busting query parameters.
# When file content changes, the ?v= param changes, busting browser caches.
CSS_VER=$(openssl dgst -sha256 public/css/app.css | awk '{print $NF}' | cut -c1-16)
APP_VER=$(openssl dgst -sha256 public/js/app.js | awk '{print $NF}' | cut -c1-16)

# Update integrity attributes and cache-busting version params in index.html.
perl -i -pe "s|href=\"/css/app\.css(\?v=[^\"]+)?\"(.*?)integrity=\"sha384-[A-Za-z0-9+/=]+\"|href=\"/css/app.css?v=${CSS_VER}\"\2integrity=\"${CSS_HASH}\"|" public/index.html
perl -i -pe "s|src=\"/js/app\.js(\?v=[^\"]+)?\"(.*?)integrity=\"sha384-[A-Za-z0-9+/=]+\"|src=\"/js/app.js?v=${APP_VER}\"\2integrity=\"${APP_HASH}\"|" public/index.html

echo "SRI hashes updated:"
echo "  app.css:  ${CSS_HASH}"
echo "  app.js:   ${APP_HASH}"
echo "Cache-bust versions:"
echo "  app.css:  ${CSS_VER}"
echo "  app.js:   ${APP_VER}"
