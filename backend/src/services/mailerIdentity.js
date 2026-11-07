import { APP_VERSION } from './buildInfo.js';

// Outgoing mail identifies its software, like every mainstream client does. Strict shared
// hosting outbound filters (Bluehost's Cloudmark router, #492) treat the absence of any
// X-Mailer or User-Agent as a botnet heuristic, and nodemailer 9 emits none by default
// (verified against the bundled version: the header set matches the reporter's capture
// exactly). Whether the missing header alone is what Bluehost drops on is unproven, since
// the failing pair's headers cannot be captured; the declaration is standard regardless.
//
// Own zero-dependency module so every sender (compose, rule forwards) can import it
// without dragging the SMTP stack along, which tests mock.
export const MAILER_ID = `MailFlow ${APP_VERSION}`;
