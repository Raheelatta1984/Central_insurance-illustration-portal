#!/usr/bin/env bash
# Recreate the SONAME symlinks Chromium needs under /home/user/local-libs.
#
# Why this exists: the workspace snapshot keeps regular files but not symlinks, so after a restore the
# real libraries are present (libatk-1.0.so.0.23609.1) while the names the loader looks for
# (libatk-1.0.so.0) are missing, and Chromium exits with code 127. This script is idempotent: run it
# after any restore, then export the two variables it prints.
#
#   bash tools/link-browser-libs.sh
#   export LD_LIBRARY_PATH=/home/user/local-libs/usr/lib/x86_64-linux-gnu
#   export PLAYWRIGHT_BROWSERS_PATH=/home/user/tools-bin/ms-playwright
set -u
LIBDIR="${LIBDIR:-/home/user/local-libs/usr/lib/x86_64-linux-gnu}"

if [ ! -d "$LIBDIR" ]; then
  echo "no $LIBDIR — extract the .deb files in /home/user/debs first:" >&2
  echo "  for d in /home/user/debs/*.deb; do dpkg-deb -x \"\$d\" /home/user/local-libs; done" >&2
  exit 1
fi

made=0
for real in "$LIBDIR"/*.so.*.*; do
  [ -e "$real" ] || continue
  base="${real%%.so*}"
  rest="${real#*.so.}"
  soname="${base}.so.${rest%%.*}"
  if [ ! -e "$soname" ]; then
    ln -s "$(basename "$real")" "$soname"
    made=$((made + 1))
  fi
done

echo "soname symlinks created: $made"
echo "export LD_LIBRARY_PATH=$LIBDIR"
echo "export PLAYWRIGHT_BROWSERS_PATH=/home/user/tools-bin/ms-playwright"
