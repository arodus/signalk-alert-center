#!/bin/sh
set -eu

# Bind-mounted volumes can take a moment to become writable right after
# container start on some Docker Desktop backends; retry briefly instead
# of failing immediately.
i=0
until mkdir -p /home/node/.signalk/node_modules 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 20 ]; then
    echo "Timed out waiting for /home/node/.signalk to become writable" >&2
    exit 1
  fi
  sleep 0.5
done

# /home/node/.signalk is normally a mounted volume, which shadows anything
# baked into that path at image build time. Install the plugin here on
# every start instead so mounted (persistent) or ephemeral data dirs both
# end up with it; this mirrors a real "npm install --prefix .signalk" install.
rm -rf /home/node/.signalk/node_modules/signalk-persistent-notifier
cp -r /opt/signalk-persistent-notifier /home/node/.signalk/node_modules/signalk-persistent-notifier

if [ ! -f /home/node/.signalk/settings.json ]; then
  cat > /home/node/.signalk/settings.json <<'EOF'
{
  "port": 3000,
  "host": "0.0.0.0",
  "plugins": {
    "signalk-persistent-notifier": {
      "storage": {
        "path": "/home/node/.signalk/persistent-notifier.sqlite"
      },
      "connectivity": {
        "enabled": false
      },
      "notifiers": {},
      "rules": []
    }
  }
}
EOF
fi

exec /home/node/signalk/startup.sh "$@"
