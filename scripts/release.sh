#!/usr/bin/env bash
set -euo pipefail
# Existing CI gates preparation; this does not create tags or push anything.
echo 'MailFlow Plus: open a PR into mailflow-plus, or run CI on the exact approved commit.'
echo 'After Backend and Frontend succeed, CI builds offline images and exercises recovery.'
echo 'Review release-manifest.json; registry promotion is not configured.'
