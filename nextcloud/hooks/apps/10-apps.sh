#!/bin/sh
#
# The apps a Nextcloud on this stack comes with.
#
# Run by the image's own entrypoint, from /docker-entrypoint-hooks.d, as the web
# user -- so occ is called directly rather than through su. The same directory is
# mounted at both post-installation and post-upgrade: the first is a new
# instance, the second catches one that predates this file, and an app that is
# already there costs a failed install and nothing else.
#
# Nothing in here is allowed to stop Nextcloud starting. The entrypoint aborts
# on a hook that exits non-zero, and an app store that is briefly down is not a
# reason for somebody's files to be offline, so every step is tolerated and the
# script always ends well.
set -u

OCC="/var/www/html/occ"
APPS="contacts calendar notes tasks spreed"

echo "=> Installing the apps this stack ships Nextcloud with: ${APPS}"

for app in ${APPS}; do
    if php "${OCC}" app:install "${app}" >/tmp/app-install.log 2>&1; then
        echo "   ${app}: installed"
    elif grep -qi "already installed" /tmp/app-install.log; then
        # The ordinary case on every start after the first.
        echo "   ${app}: already here"
    else
        # Anything else is worth seeing: an app store outage, a version of
        # Nextcloud the app does not support yet, no network.
        reason=$(tail -n 2 /tmp/app-install.log | tr '\n' ' ' | sed 's/  */ /g')
        echo "   ${app}: could not be installed (${reason:-no output})"
    fi
    # Installed but switched off is a state somebody can end up in after a major
    # version upgrade, and it looks identical to not having the app.
    php "${OCC}" app:enable "${app}" >/dev/null 2>&1 || true
done

rm -f /tmp/app-install.log
echo "=> Done. Contacts, Calendar, Notes, Tasks and Talk are what this stack expects to be here."
exit 0
