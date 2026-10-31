# LittleCare local sign-in

This prototype uses PostgreSQL-backed email/password accounts. Google sign-in is intentionally disabled until Google OAuth credentials and a callback URL are configured.

## Run locally

1. Install Node.js 22.9 or newer and PostgreSQL.
2. The setup command expects the PostgreSQL role `postgres` by default; set `PGUSER` if your installer used a different role.
3. Run `npm run setup:local-db` in Terminal and enter that PostgreSQL role's password at the hidden prompt. It creates the `littlecare` database and writes `.env`.
4. From this directory, run `npm install` and then `npm start`.
5. Open <http://localhost:3000>.

The server creates the account and session tables on startup. It stores password hashes (not plaintext passwords), issues an HttpOnly session cookie, and only serves the dashboard after a valid sign-in.

This is a local development prototype, not a production-ready or HIPAA-compliant authentication system. It does not include email verification or password reset. Do not use real patient information or deploy it for clinical use without a security and compliance review.

The dashboard's assessment button opens the authenticated assessment-launch page. Caregivers can enter temperature, yes/no eating and bowel-movement observations, and optional systolic/diastolic blood pressure. These answers are stored as timestamped PostgreSQL records scoped to the signed-in account and child profile. After saving, the flow continues to the authenticated camera page. Camera recordings and selected videos stay in the browser for preview; no AI provider is configured. The AI Analysis button continues to parent confirmation but does not analyze video or generate clinical results.

Signed-in users can create and edit child profiles from the dashboard. Profile records are stored in PostgreSQL and scoped to the account that created them. The dashboard assessment button is enabled after a profile is selected.

The sign-in page links to a separate Organization / Hospital Login at `/hospital-login`. Configure `KARNATAKA_HOSPITAL_IDS` in `.env` as a comma-separated allowlist; IDs are matched case-insensitively. Hospital accounts must register and sign in with an allowlisted ID, and the same ID is required for subsequent sign-ins. An empty allowlist disables hospital authentication. This local allowlist is not a connection to a government or hospital registry and should not be treated as proof of staff authorization.

The dashboard also supports creating a child profile from a QR code. The QR payload must be JSON such as `{"displayName":"Child Name","ageYears":3}`. Supported browsers scan using the device camera; if camera scanning is unavailable, the same JSON can be pasted into the QR dialog. The scan only prefills the existing profile form; staff review and save it explicitly. QR content is processed in the browser and is not uploaded.

## Enable Google sign-in

1. In Google Cloud Console, create an OAuth client ID with application type **Web application**.
2. Add `http://localhost:3000` as an authorized JavaScript origin and `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
3. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback` to the local `.env` file. Keep the client secret private.
4. Restart the server with `npm start`. The Google button becomes available when the server sees both credentials.

The callback verifies Google's ID token, verified email, nonce, and OAuth state before creating a local session.
