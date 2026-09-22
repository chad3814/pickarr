#!/usr/bin/env bash
#
# Proves the container actually drops privileges, by running it.
#
# **This is the only test of `docker-entrypoint.sh` there is, and it has to
# be.** The script it covers is shell, runs as root, and its whole job is
# to change the uid of the process that follows it -- there is nothing to
# unit test that would not be a reimplementation of `su-exec` and `chown`.
# So each case here runs the real image and reads back what really
# happened: the uid of the process, and the owner of a file it created.
#
# Each case overrides `CMD` rather than booting the host, so the whole file
# runs in a few seconds and never needs a port, a database or a config
# file. `ENTRYPOINT` still runs -- that is exactly what is under test --
# because overriding `CMD` does not skip it.
#
# **Ownership is read from inside a container, against a named volume,
# rather than from the host against a bind mount.** The bind mount is the
# case an operator actually hits, and on Linux the host-side `stat` would
# be the more faithful assertion -- but Docker Desktop remaps bind-mount
# ownership on macOS and Windows, so that assertion fails there for
# reasons having nothing to do with this entrypoint. A named volume stores
# real uids on every platform, so the question asked here -- "which uid
# owns what the container wrote" -- is the same one, and it can be asked
# anywhere.
#
# Usage: scripts/test-container-user.sh [image-tag]
set -euo pipefail

IMAGE="${1:-pickarr:test}"
failures=0

# A fresh volume per case, so one case's ownership cannot satisfy the
# next one's assertion.
volumes=()
containers=()
cleanup() {
  # Containers first: a volume still attached to one cannot be removed.
  for container in ${containers+"${containers[@]}"}; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  for volume in ${volumes+"${volumes[@]}"}; do
    docker volume rm "$volume" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

new_config_volume() {
  local volume="pickarr-entrypoint-test-$RANDOM$RANDOM"
  docker volume create "$volume" >/dev/null
  volumes+=("$volume")
  printf '%s' "$volume"
}

# Reads an owner off the volume without going through the image under
# test, so a broken entrypoint cannot answer the question about itself.
#
# Answers `<missing>` rather than failing when the path is not there. An
# entrypoint that skips its `chown` leaves `/config` root-owned and
# unwritable by the dropped user, so the step that was meant to create the
# probe file fails and the file never appears -- and under `set -e` that
# aborted this whole script with no `FAIL` line at all. A mutant that
# crashes the suite looks exactly like a mutant the suite killed, which is
# how the missing-`chown` mutant first read as caught when it was not.
owner_of() {
  docker run --rm -v "$1:/config" alpine:3 \
    sh -c "[ -e '/config/$2' ] && stat -c '%u:%g' '/config/$2' || echo '<missing>'"
}

# Runs the image and swallows a non-zero exit, so a case that was supposed
# to fail reports a `FAIL` line instead of taking the suite down with it.
# Prints the status, which is what the refusal cases assert on.
status_of() {
  local status=0
  docker run --rm "$@" >/dev/null 2>&1 || status=$?
  printf '%s' "$status"
}

# Whether the entrypoint refused in its own words, or merely failed.
#
# A `case` over a captured string rather than a pipe into `grep`: under
# `set -o pipefail` a pipeline takes its status from the *last failing*
# command, so `docker run ... | grep -q ... && echo refused` reported
# `other` for every refusal -- the `grep` matched, and `docker`'s exit 1
# poisoned the pipeline anyway. Every one of these four cases read as a
# failure that was really this line.
refusal_of() {
  local out
  out="$(docker run --rm "$@" 2>&1 || true)"
  case "$out" in
    *"PUID and PGID must both be set"*) printf 'refused' ;;
    *) printf 'other' ;;
  esac
}

# A setup step that has to succeed for the assertion after it to mean
# anything. Reported as a `FAIL` and stepped over, never allowed to abort.
#
# **Every bare `docker run` in this file used to be one of these, and that
# was the same hole twice.** Under `set -e` a setup step that fails takes
# the suite down mid-run, printing no `FAIL` line -- so a mutant that broke
# the entrypoint badly enough to break setup produced *cleaner* output than
# one that broke it subtly. Two mutants read as caught while nothing had
# caught them.
setup_run() {
  local what="$1"
  shift
  if ! docker run --rm "$@" >/dev/null 2>&1; then
    echo "FAIL - setup: $what" >&2
    failures=$((failures + 1))
  fi
}

check() {
  local what="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "ok   - $what"
  else
    echo "FAIL - $what: expected '$expected', got '$actual'" >&2
    failures=$((failures + 1))
  fi
}

echo "# running $IMAGE"

# --- the drop itself ------------------------------------------------------
# 1234:5678 rather than 1000:1000 on purpose: this base image already ships
# a `node` user at uid 1000, so passing 1000 would still pass if the
# entrypoint resolved a name somewhere instead of the number it was given.
check "PUID/PGID set: the process runs as that uid" \
  "1234" \
  "$(docker run --rm -e PUID=1234 -e PGID=5678 "$IMAGE" id -u)"

check "PUID/PGID set: the process runs as that gid" \
  "5678" \
  "$(docker run --rm -e PUID=1234 -e PGID=5678 "$IMAGE" id -g)"

# --- what the drop is for -------------------------------------------------
# The uid above is the mechanism; this is the outcome an operator cares
# about. A volume Docker has just created is root-owned, which is also
# every existing deployment's `/config` the first time PUID is set -- so
# this covers the takeover and the subsequent write in one case.
volume="$(new_config_volume)"
check "the dropped user can write into /config at all" \
  "0" \
  "$(status_of -e PUID=1234 -e PGID=5678 -v "$volume:/config" "$IMAGE" sh -c 'touch /config/probe')"
check "a file written into /config is owned by PUID:PGID" \
  "1234:5678" "$(owner_of "$volume" probe)"
check "and /config itself was taken over" \
  "1234:5678" "$(owner_of "$volume" .)"

# A file that arrived root-owned before PUID was ever set is chowned too,
# not merely stepped around -- otherwise an upgrading operator's existing
# database stays unreadable by the user the app now runs as.
volume="$(new_config_volume)"
setup_run "write a root-owned file before PUID is ever set" \
  -v "$volume:/config" "$IMAGE" sh -c 'touch /config/legacy'
setup_run "start once with PUID set" \
  -e PUID=1234 -e PGID=5678 -v "$volume:/config" "$IMAGE" true
check "a pre-existing root-owned file in /config is chowned on the next start" \
  "1234:5678" "$(owner_of "$volume" legacy)"

# --- backward compatibility ----------------------------------------------
# Pinned, not assumed. Adding an entrypoint to an image that had none is
# exactly the change that silently moves an existing deployment's files.
check "no PUID/PGID: still root, exactly as before" \
  "0" \
  "$(docker run --rm "$IMAGE" id -u)"

volume="$(new_config_volume)"
setup_run "write into /config with no PUID set" \
  -v "$volume:/config" "$IMAGE" sh -c 'touch /config/probe'
check "no PUID/PGID: /config is left alone" \
  "0:0" "$(owner_of "$volume" probe)"

# --- refusing a malformed id ---------------------------------------------
# The reason the entrypoint exits instead of falling back to root: a typo
# that starts the container anyway produces root-owned files, discovered
# days later and somewhere else.
#
# **Exit status alone is a weak assertion here, measured.** Deleting the
# entrypoint's validation left `notanumber`, `-1` and `12.5` still exiting
# non-zero -- `su-exec` refuses them itself, several lines later and after
# `chown -R` has already run with the same unchecked string. So each case
# asserts the entrypoint's own message too: that is what distinguishes
# "refused before touching anything" from "blew up somewhere downstream".
for bad in "notanumber" "-1" "12.5" ""; do
  check "PUID='$bad' refuses to start" "1" \
    "$(status_of -e "PUID=$bad" -e PGID=5678 "$IMAGE" id -u)"
  check "PUID='$bad' says why, rather than failing downstream" "refused" \
    "$(refusal_of -e "PUID=$bad" -e PGID=5678 "$IMAGE" id -u)"
done

# One set and the other not is the same half-configured container: a PUID
# with a root group still writes group-root files.
check "PUID without PGID refuses to start" "1" \
  "$(status_of -e PUID=1234 "$IMAGE" id -u)"
check "PUID without PGID says why" "refused" \
  "$(refusal_of -e PUID=1234 "$IMAGE" id -u)"

# --- the real deployment shape --------------------------------------------
# Every case above overrides `CMD` with something that exits immediately.
# This one starts the actual server and reads the uid of pid 1 out of
# `/proc`, because "the entrypoint can drop privileges for `id`" and "the
# host runs as the dropped user" are not the same claim.
volume="$(new_config_volume)"
container="pickarr-entrypoint-test-$RANDOM$RANDOM"
# Registered before it is started, and removed by the trap rather than
# only on the happy path: a failing `check` between here and the `rm`
# below would otherwise leave a server running and its volume unremovable.
containers+=("$container")
docker run --rm -d --name "$container" -e PUID=1234 -e PGID=5678 \
  -v "$volume:/config" "$IMAGE" >/dev/null
# `until`, not a fixed sleep: the host migrates a database on first boot
# and how long that takes is not this test's business.
tries=0
until docker exec "$container" test -f /proc/1/status >/dev/null 2>&1 || [ "$tries" -ge 30 ]; do
  tries=$((tries + 1))
  sleep 1
done
check "the server process itself runs as PUID:PGID" \
  "1234 5678" \
  "$(docker exec "$container" sh -c \
      "awk '/^Uid:/ {u=\$2} /^Gid:/ {g=\$2} END {print u, g}' /proc/1/status" 2>/dev/null || echo unreadable)"
check "and the process really is the host, not a leftover shell" \
  "node" \
  "$(docker exec "$container" sh -c "tr '\\0' ' ' </proc/1/cmdline | cut -d' ' -f1" 2>/dev/null || echo unreadable)"

# **`docker exec` is root, and that is a documented limitation rather than
# a bug this can fix.** `exec` runs straight from the image, which has no
# `USER`, so it never passes through `ENTRYPOINT`; a `USER` line would
# break the `chown` the entrypoint needs root for. Pinned because
# `README.md` tells operators to pass `docker exec -u` on the strength of
# it -- if a later change makes `exec` drop privileges on its own, that
# advice becomes wrong and this is what says so.
check "docker exec bypasses the entrypoint and is root" \
  "0" \
  "$(docker exec "$container" id -u)"
check "docker exec -u is the documented way round it" \
  "1234" \
  "$(docker exec -u 1234:5678 "$container" id -u)"
docker rm -f "$container" >/dev/null

# --- explicit root --------------------------------------------------------
check "PUID=0 PGID=0 is honoured as root" \
  "0" \
  "$(docker run --rm -e PUID=0 -e PGID=0 "$IMAGE" id -u)"

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
