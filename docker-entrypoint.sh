#!/bin/sh
set -e

# If Mullvad isn't configured, drop root privileges.
# WireGuard requires NET_ADMIN (only root in the container has this),
# so root is mandatory when the VPN is in use. Without Mullvad, the app
# has no need for root and runs as the unprivileged `ppvda` user.
if [ -z "$MULLVAD_ACCOUNT" ]; then
  exec gosu ppvda node dist/index.js
fi

exec node dist/index.js
