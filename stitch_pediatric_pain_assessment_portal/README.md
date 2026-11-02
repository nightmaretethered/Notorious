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

The dashboard's assessment button opens the authenticated assessment-launch page. Caregivers may optionally enter temperature, nutrition (1–10), systolic/diastolic blood pressure, and a bowel-movement count. The inputs are stored as PostgreSQL records scoped to the signed-in account and child profile; they are report context and do not affect the facial estimate.

Earlier clients could submit yes/no eating and bowel-movement observations. Those fields remain stored for compatibility with existing records.

After saving, the flow opens an authenticated one-minute live camera assessment. The browser loads the local face-api.js expression and 68-point landmark models from the `Webcam Face Expression Recognition` folder, uses only facial expressions and head/jaw landmark changes, and requests camera access without audio. Video frames are analyzed in memory and never uploaded or saved. Only temporary facial probability/landmark samples are held in browser session storage to pass through the parent-confirmation page; they are removed after the report saves or the caregiver stops the capture. **Stop without report** releases the camera and leaves the page ready to start another capture. Parents answer three yes/no questions based on what they observed: distress confirmation adds 8 exploratory points, calm/happy periods subtract 8, and face visibility affects capture quality only. Reports with less than 60% face-detection capture quality are rejected; the confirmation button then becomes **Retake the live video test** and returns to the camera assessment. The resulting `childId`, `painLevel`, `painScore`, `confidence`, `reasons`, `guidance`, server-generated `createdAt`, and optional context are saved to the selected assessment and shown on the Pain Scale Report page. The report's print action opens the browser print dialog, where it can be saved as PDF.

This facial score is experimental, has not been validated for child pain, and cannot guarantee accurate or consistent pain measurement. `confidence` describes face-detection capture quality, not certainty about pain. Do not use the report to diagnose, treat, or delay care; consult a qualified clinician. Do not test this prototype on real children or use real patient information.

Signed-in users can create and edit child profiles from the dashboard. Profile records are stored in PostgreSQL and scoped to the account that created them. The dashboard assessment button is enabled after a profile is selected.

The sign-in page links to a separate Organization / Hospital Login at `/hospital-login`. The local `.env` and `.env.example` configure `KARNATAKA_HOSPITAL_IDS=1234`; hospital accounts must register and sign in with that ID. The hospital portal at `/hospital-reports` lists completed reports created by all individual/caregiver accounts, including the child's name and age, caregiver account email, report date, pain level, score, and a link to each report. Report details are available to signed-in hospital accounts using ID 1234. The list includes reports saved before or after the hospital account signs in because it reads the shared local database. To support additional hospital IDs, add them to the comma-separated allowlist; only ID 1234 has access to the shared caregiver-report list. An empty allowlist disables hospital authentication. This local allowlist is not a connection to a government or hospital registry and should not be treated as proof of staff authorization.

Signed-in users can open **Generate Report QR** from the dashboard, select a child with a completed report, and download or print a QR code linking directly to that specific report. The generated link opens the report after sign-in and only the account that owns the child profile can retrieve it. Report QR links contain the local application URL and profile/assessment IDs; the server verifies ownership and report completion before generating the image and does not save the QR link. Do not use real patient information with this prototype.

Choose **Scan QR Code** on the dashboard to scan a report link or import profile JSON such as `{"displayName":"Child Name","ageYears":3}`. Supported browsers scan using the device camera; if camera scanning is unavailable, paste the content into the QR dialog. Report links open the selected report (and ask the user to sign in when needed); profile JSON only prefills the existing profile form, which staff must review and save explicitly. Caregiver profile and report APIs remain scoped to their owner; the separate, authenticated Hospital ID 1234 portal can view completed caregiver reports across accounts on this local instance. QR codes themselves do not synchronize data between hospital and caregiver accounts.

## Enable Google sign-in

1. In Google Cloud Console, create an OAuth client ID with application type **Web application**.
2. Add `http://localhost:3000` as an authorized JavaScript origin and `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
3. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback` to the local `.env` file. Keep the client secret private.
4. Restart the server with `npm start`. The Google button becomes available when the server sees both credentials.

The callback verifies Google's ID token, verified email, nonce, and OAuth state before creating a local session. Google sign-in does not automatically link to an existing password account by email; use that account's password to sign in instead.
