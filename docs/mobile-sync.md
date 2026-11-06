# Mobile manual sync

Use the sync button or pull down at the top of the message list to request a refresh.
If the request cannot reach the server or the server rejects it, MailFlow displays a
localized error notification and stops the sync indicator. Check the connection and
try the same action again. A successful request does not add a success notification.

This feedback covers the manual `/mail/sync` request and, outside the inbox, its
`/mail/sync-folder` request. The server can accept a request before the mailbox sync
finishes; later mailbox errors still use the existing account error handling.

To check the behavior with a test account and mocked requests:

1. In a narrow touch viewport, reject `/api/mail/sync` and tap sync. Confirm one
   readable error notification, an idle indicator, and usable navigation.
2. Restore the response and tap sync again. Confirm another request is made and
   the indicator stops on the existing completion event or fallback timeout.
3. Reject the request again, pull down from the top of the list, and release.
   Confirm the same single error notification and stopped pull indicator.
4. In a non-inbox folder, reject `/api/mail/sync-folder` after accepting
   `/api/mail/sync`; confirm the same feedback. Background refreshes should not
   produce these manual-sync notifications.

The behavior tests are in `frontend/src/components/MessageList.sync.render.test.js`.
Run them alongside `MessageList.render.test.js`, `NotificationToasts.render.test.js`,
and `src/locales/i18n.test.js` with the repository's Node 22 frontend test command.
Android Chrome and an installed PWA require separate device acceptance; a Chromium
mobile viewport verifies layout and interactions only.
