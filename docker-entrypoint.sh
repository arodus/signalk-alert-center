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
install_plugin() {
  source_dir="$1"
  package_name="$2"
  destination="/home/node/.signalk/node_modules/$package_name"
  rm -rf "$destination"
  cp -R "$source_dir" "$destination"
}

install_plugin /opt/signalk-alert-center signalk-alert-center
# Development images before the rename installed the old package into the
# persistent data volume. Remove only that obsolete package copy; its database
# and configuration are handled separately below.
rm -rf /home/node/.signalk/node_modules/signalk-persistent-notifier
if [ -d /opt/signalk-test-fixture ]; then
  install_plugin /opt/signalk-test-fixture signalk-test-fixture
fi

if [ ! -f /home/node/.signalk/settings.json ]; then
  cat > /home/node/.signalk/settings.json <<'EOF'
{
  "port": 3000,
  "host": "0.0.0.0",
  "plugins": {}
}
EOF
fi

mkdir -p /home/node/.signalk/plugin-config-data
old_config=/home/node/.signalk/plugin-config-data/signalk-persistent-notifier.json
new_config=/home/node/.signalk/plugin-config-data/signalk-alert-center.json
if [ ! -f "$new_config" ] && [ -f "$old_config" ]; then
  mv "$old_config" "$new_config"
  echo "Migrated Signal K Alert Center configuration to the new plugin id"
elif [ -f "$new_config" ] && [ -f "$old_config" ]; then
  echo "Both old and new Alert Center configurations exist; leaving the old file untouched" >&2
fi

if [ ! -f "$new_config" ]; then
  zone_refresh_seconds="${SIGNALK_ZONE_REFRESH_SECONDS:-300}"
  cat > "$new_config" <<EOF
{
  "enabled": true,
  "configuration": {
    "storage": { "path": "/home/node/.signalk/persistent-notifier.sqlite" },
    "discovery": { "zoneRefreshSeconds": $zone_refresh_seconds },
    "connectivity": { "enabled": false },
    "notifiers": []
  }
}
EOF
fi

# Convert the pre-list development format without dropping locally stored
# credentials. New installations and the Signal K form always write an array.
node - "$new_config" <<'NODE'
const fs = require("node:fs");
const filename = process.argv[2];
const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
const notifiers = saved.configuration?.notifiers;
if (notifiers && !Array.isArray(notifiers) && typeof notifiers === "object") {
  saved.configuration.notifiers = Object.entries(notifiers).map(
    ([name, configuration]) => ({ name, ...configuration }),
  );
  fs.writeFileSync(filename, `${JSON.stringify(saved, null, 2)}\n`);
}
NODE

if [ -d /opt/signalk-test-fixture ]; then
  fixture_seed_on_start="${SIGNALK_FIXTURE_SEED_ON_START:-false}"
  cat > /home/node/.signalk/plugin-config-data/signalk-test-fixture.json <<EOF
{
  "enabled": true,
  "configuration": { "seedOnStart": $fixture_seed_on_start }
}
EOF
fi

if [ "${SIGNALK_DISABLE_SECURITY:-0}" = "1" ]; then
  # Acceptance containers are isolated on a private Compose network. Skipping
  # the image wrapper avoids its unconditional --securityenabled flag and lets
  # tests exercise mutation routes without baking credentials into fixtures.
  exec /home/node/signalk/node_modules/signalk-server/bin/signalk-server "$@"
fi

exec /home/node/signalk/startup.sh "$@"
