#!/bin/sh
set -eu

config_dir="${SIGNALK_NODE_CONFIG_DIR:-$HOME/.signalk}"
server_dir="$HOME/signalk"
export SIGNALK_NODE_CONFIG_DIR="$config_dir"

# Bind-mounted volumes can take a moment to become writable right after
# container start on some Docker Desktop backends; retry briefly instead
# of failing immediately.
i=0
until mkdir -p "$config_dir/node_modules" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 20 ]; then
    echo "Timed out waiting for $config_dir to become writable" >&2
    exit 1
  fi
  sleep 0.5
done

# The Signal K data directory is normally a mounted volume, which shadows anything
# baked into that path at image build time. Install the plugin here on
# every start instead so mounted (persistent) or ephemeral data dirs both
# end up with it; this mirrors a real "npm install --prefix .signalk" install.
install_plugin() {
  source_dir="$1"
  package_name="$2"
  destination="$config_dir/node_modules/$package_name"
  rm -rf "$destination"
  cp -R "$source_dir" "$destination"
}

install_plugin /opt/signalk-alert-center signalk-alert-center
if [ -d /opt/signalk-test-fixture ]; then
  install_plugin /opt/signalk-test-fixture signalk-test-fixture
fi

if [ ! -f "$config_dir/settings.json" ]; then
  cat > "$config_dir/settings.json" <<'EOF'
{
  "port": 3000,
  "host": "0.0.0.0",
  "plugins": {}
}
EOF
fi

mkdir -p "$config_dir/plugin-config-data"
new_config="$config_dir/plugin-config-data/signalk-alert-center.json"
if [ ! -f "$new_config" ]; then
  zone_refresh_seconds="${SIGNALK_ZONE_REFRESH_SECONDS:-300}"
  node -e '
    const path = require("node:path");
    console.log(JSON.stringify({
      enabled: true,
      configuration: {
        storage: { path: path.join(process.argv[1], "alert-center.sqlite") },
        discovery: { zoneRefreshSeconds: Number(process.argv[2]) },
        connectivity: { enabled: false },
        notifiers: []
      }
    }, null, 2));
  ' "$config_dir" "$zone_refresh_seconds" > "$new_config"
fi

if [ -d /opt/signalk-test-fixture ]; then
  fixture_seed_on_start="${SIGNALK_FIXTURE_SEED_ON_START:-false}"
  cat > "$config_dir/plugin-config-data/signalk-test-fixture.json" <<EOF
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
  exec "$server_dir/node_modules/signalk-server/bin/signalk-server" "$@"
fi

exec "$server_dir/startup.sh" "$@"
