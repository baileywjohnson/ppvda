#!/bin/sh
set -e

# Bare deployment (no VPN): Node doesn't need any extra privileges, drop
# straight to the ppvda user.
if [ -z "$MULLVAD_ACCOUNT" ]; then
  exec gosu ppvda node dist/index.js
fi

# Mullvad deployment: we split privileges between two processes.
#
#   1. wg-supervisor runs as root. It's the only thing that touches
#      CAP_NET_ADMIN operations (wg-quick, ip route) and root-owned
#      filesystem paths (/etc/resolv.conf, /etc/hosts). It speaks a
#      length-prefixed JSON protocol over a Unix socket.
#
#   2. The Node app runs as the `ppvda` user. When it needs to bring up
#      the tunnel, switch countries, or add a bypass route it sends an
#      RPC to the supervisor. SO_PEERCRED on the supervisor side rejects
#      any connection that isn't from the ppvda uid.
#
# This recovers Chromium's user-namespace sandbox: when Playwright spawns
# the browser as the ppvda uid, Chromium enables its renderer sandbox.
# Running Node as root (the pre-split arrangement) made Chromium refuse
# to sandbox, so a renderer RCE meant full container root.
#
# Requires in docker-compose / docker run:
#   cap_add: [NET_ADMIN]
#   devices: [/dev/net/tun:/dev/net/tun]

PPVDA_UID="$(id -u ppvda)"

# Start the supervisor in the background with its pid captured. The
# supervisor MkdirAlls /run/ppvda itself if needed, but the Dockerfile
# also creates it at build time so the socket's parent exists from the
# first boot.
/usr/local/bin/wg-supervisor -socket /run/ppvda/wg.sock -uid "$PPVDA_UID" &
SUPERVISOR_PID=$!

# Propagate termination signals so `docker stop` tears the supervisor
# down cleanly instead of SIGKILLing it. Once we exec into gosu+node
# below this trap is gone (exec replaces the shell), but by that point
# Docker will signal PID 1 directly and the supervisor gets notified via
# the kernel when its parent (now gosu) exits if it installed PR_SET_PDEATHSIG.
# The supervisor doesn't currently use PR_SET_PDEATHSIG — if operators
# need faster cleanup on crash, they rely on Docker killing the whole
# container's process tree.
trap 'kill -TERM "$SUPERVISOR_PID" 2>/dev/null || true' TERM INT

# Wait for the socket to appear so Node's first RPC doesn't race against
# the supervisor's Listen(). Bounded — if the supervisor crashes out of
# the gate we abort instead of hanging indefinitely.
i=0
while [ "$i" -lt 50 ]; do
  if [ -S /run/ppvda/wg.sock ]; then
    break
  fi
  if ! kill -0 "$SUPERVISOR_PID" 2>/dev/null; then
    echo "wg-supervisor exited before socket appeared" >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.1
done

if [ ! -S /run/ppvda/wg.sock ]; then
  echo "wg-supervisor socket did not appear within 5s" >&2
  kill "$SUPERVISOR_PID" 2>/dev/null || true
  exit 1
fi

# Drop to the ppvda user for the main Node process. If wg-supervisor
# later dies mid-run, RPCs from Node will fail with ECONNREFUSED — that
# surfaces in the application log as "wg-supervisor connect ...: ...".
# Restart the container to recover. We intentionally don't auto-kill the
# container on supervisor death from here because once we exec below,
# this shell is gone and there's no reliable way to monitor a detached
# child across the exec boundary without pulling in tini/s6.
exec gosu ppvda node dist/index.js
