#!/bin/sh
#
# Runs the container's command as `PUID`:`PGID` instead of as root.
#
# **Why this exists.** Everything Pickarr writes -- the database, the
# artwork derived from its path, the config file -- lands in a bind mount
# the operator owns on the other side. A container running as root writes
# root-owned files there, which the operator then cannot read, back up or
# delete without `sudo`. `PUID`/`PGID` is how every *arr image solves this,
# and the names are deliberate: `UID` is a readonly builtin in `bash` and
# `zsh`, so `UID=1000 docker compose up` fails in the operator's own shell
# and `export UID` is impossible.
#
# **Unset means root, exactly as before.** Adding this file must not move
# an existing deployment's files or change who writes them; an operator who
# has never heard of `PUID` gets the behaviour they already had.
#
# **A malformed id is fatal, not ignored.** Falling back to root on a typo
# would put the failure where nobody looks: the container starts, serves
# happily, and the damage is a directory of root-owned files discovered
# days later. Refusing to start puts it in the first line of `docker logs`.
set -eu

# `-0700` and `1e3` are not ids, and `${#}`-style trickery is not worth it
# here: one `case` over the whole string is the shell's own way to say "one
# or more digits and nothing else". Leading zeros are accepted because
# `chown` and `su-exec` both read them as decimal, the same as `id` prints.
is_id() {
  case "$1" in
    '') return 1 ;;
    *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# The directory the host writes into. Derived from `PICKARR_CONFIG` rather
# than hardcoded to `/config`, so an operator who moves the config file
# moves what gets chowned with it.
#
# **`database.path` is not consulted, and that is a real limit.** It lives
# inside the config file's JSON, and parsing JSON in `sh` to decide what to
# `chown -R` is how an entrypoint ends up recursively chowning `/` because
# a quote was in the wrong place. A database outside this directory needs
# its directory owned correctly before the container starts; `README.md`
# says so where `database.path` is documented.
config_dir() {
  dirname "${PICKARR_CONFIG:-/config/pickarr.config.json}"
}

# Whether `dir` is already owned by `uid`:`gid`, so the common case -- a
# container restarting against a directory it already fixed -- starts
# immediately.
#
# **The check is what makes this affordable.** Artwork is stored in a
# directory derived from the database path, so a mature install has
# thousands of files under here and an unconditional `chown -R` would walk
# all of them on every boot. Checking the directory itself and trusting it
# to speak for its contents is the same bargain every *arr image makes: it
# is wrong only if something chowned the children without the parent, which
# nothing here does.
owned_by() {
  [ "$(stat -c '%u:%g' "$1")" = "$2:$3" ]
}

PUID="${PUID:-}"
PGID="${PGID:-}"

if [ -z "$PUID" ] && [ -z "$PGID" ]; then
  exec "$@"
fi

# One without the other is a half-configured container, not a default to
# guess at: a `PUID` with a root group still writes group-root files.
if ! is_id "$PUID" || ! is_id "$PGID"; then
  echo "pickarr: PUID and PGID must both be set to non-negative integers (got PUID='$PUID' PGID='$PGID')" >&2
  exit 1
fi

# `0:0` is root asked for explicitly. Honoured by doing nothing at all
# rather than by `su-exec 0:0`, which would work but would also `chown -R`
# a tree that is already root-owned on the first boot after an operator
# sets it.
if [ "$PUID" = "0" ] && [ "$PGID" = "0" ]; then
  exec "$@"
fi

dir="$(config_dir)"
if [ -d "$dir" ] && ! owned_by "$dir" "$PUID" "$PGID"; then
  echo "pickarr: taking ownership of $dir as $PUID:$PGID"
  chown -R "$PUID:$PGID" "$dir"
fi

# Numeric, so no `/etc/passwd` entry has to exist. Creating a user would
# mean colliding with the `node` user this base image already ships at uid
# 1000 -- which is the single most common `PUID` there is.
exec su-exec "$PUID:$PGID" "$@"
