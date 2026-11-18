#!/usr/bin/env bash
# Moved to infra/setup.sh. This stub stays for one release: the auto-deploy script already installed on the server
# still calls deploy/setup.sh, and the first deploy of the new layout replaces it with one that calls infra/setup.sh.
exec bash "$(dirname "$0")/../infra/setup.sh" "$@"
