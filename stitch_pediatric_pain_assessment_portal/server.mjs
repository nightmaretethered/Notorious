import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import pg from 'pg';

const { Pool } = pg;
const scrypt = promisify(scryptCallback);
const projectDirectory = dirname(fileURLToPath(import.meta.url));
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sessionCookieName = 'littlecare_session';
const oauthStateCookieName = 'littlecare_google_oauth';
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const passwordKeyLength = 64;
const rateLimitWindowMs = 15 * 60 * 1000;
const maxAttemptsPerWindow = 10;
const maxVideoUploadBytes = 100 * 1024 * 1024;
const configuredKarnatakaHospitalIds = new Set(
  (process.env.KARNATAKA_HOSPITAL_IDS || '')
    .split(',')
    .map((hospitalId) => hospitalId.trim().toUpperCase())
    .filter(Boolean)
);
const rateLimits = new Map();
const dummySalt = Buffer.alloc(16, 1);
const secureCookie = process.env.NODE_ENV === 'production';
const googleOAuthClientId = process.env.GOOGLE_CLIENT_ID;
const googleOAuthClientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : false
});
const googleOAuthClient = googleOAuthClientId && googleOAuthClientSecret
  ? new OAuth2Client(googleOAuthClientId, googleOAuthClientSecret, googleRedirectUri)
  : null;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function sendCookie(response, token) {
  const secure = secureCookie ? '; Secure' : '';
  const cookies = [
    `${sessionCookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetimeMs / 1000}${secure}`,
    `${oauthStateCookieName}=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  ];
  response.setHeader('Set-Cookie', cookies);
}

function clearCookie(response) {
  const secure = secureCookie ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function readCookie(request, name) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return null;
}

function clearGoogleOAuthCookie(response) {
  const secure = secureCookie ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${oauthStateCookieName}=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function isGoogleOAuthConfigured() {
  return Boolean(googleOAuthClient);
}

function redirectToLogin(response, error) {
  response.writeHead(303, {
    Location: `/login?authError=${encodeURIComponent(error)}`,
    'Cache-Control': 'no-store'
  });
  response.end();
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function consumeRateLimit(request, action) {
  const key = `${action}:${request.socket.remoteAddress ?? 'unknown'}`;
  const now = Date.now();
  let entry = rateLimits.get(key);

  if (!entry || entry.expiresAt <= now) {
    entry = { count: 0, expiresAt: now + rateLimitWindowMs };
    rateLimits.set(key, entry);
  }

  if (entry.count >= maxAttemptsPerWindow) return false;
  entry.count += 1;
  return true;
}

function clearRateLimit(request, action) {
  rateLimits.delete(`${action}:${request.socket.remoteAddress ?? 'unknown'}`);
}

async function readJsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Send this request as JSON.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request could not be read. Please try again.');
  }
}

async function receiveVideoUpload(request, response) {
  if (!await getSessionUser(request)) {
    throw new HttpError(401, 'Please sign in before uploading a video.');
  }

  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (!contentType?.startsWith('video/')) {
    throw new HttpError(415, 'Upload a video file to continue.');
  }

  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxVideoUploadBytes) {
    throw new HttpError(413, 'The video must be 100 MB or smaller.');
  }

  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxVideoUploadBytes) {
      throw new HttpError(413, 'The video must be 100 MB or smaller.');
    }
  }

  if (size === 0) {
    throw new HttpError(400, 'The selected video is empty.');
  }

  sendJson(response, 501, {
    received: true,
    discarded: true,
    analysisAvailable: false,
    error: 'The video reached this local app and was discarded. No AI provider is configured, so no analysis was performed.'
  });
}

function validateCredentials(body) {
  if (!body || typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw new HttpError(400, 'Enter your email address and password.');
  }

  const email = body.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }

  if (body.password.length < 12 || body.password.length > 128) {
    throw new HttpError(400, 'Your password must be between 12 and 128 characters.');
  }

  return { email, password: body.password };
}

function validateKarnatakaHospitalId(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    throw new HttpError(400, 'Enter a valid Karnataka Hospital ID.');
  }
  if (configuredKarnatakaHospitalIds.size === 0) {
    throw new HttpError(503, 'Hospital sign-in is not configured. Contact your administrator.');
  }

  const hospitalId = value.trim().toUpperCase();
  if (!configuredKarnatakaHospitalIds.has(hospitalId)) {
    throw new HttpError(403, 'That Karnataka Hospital ID could not be verified.');
  }
  return hospitalId;
}

function validateChildProfile(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Enter the child profile details.');
  }

  if (typeof body.displayName !== 'string') {
    throw new HttpError(400, 'Enter the child’s preferred name.');
  }

  const displayName = body.displayName.trim();
  if (!displayName || displayName.length > 100) {
    throw new HttpError(400, 'The child’s preferred name must be between 1 and 100 characters.');
  }

  const textFields = [
    ['caregiverContacts', 1000, 'Caregiver contacts'],
    ['intervention', 200, 'Intervention'],
    ['motorPatterns', 2000, 'Motor behavior patterns'],
    ['facialMarkers', 2000, 'Facial behavior markers']
  ];
  const profile = { displayName };

  for (const [field, maxLength, label] of textFields) {
    const value = body[field] ?? '';
    if (typeof value !== 'string' || value.length > maxLength) {
      throw new HttpError(400, `${label} must be ${maxLength} characters or fewer.`);
    }
    profile[field] = value.trim();
  }

  if (body.ageYears === '' || body.ageYears === null || body.ageYears === undefined) {
    profile.ageYears = null;
  } else if (
    typeof body.ageYears !== 'number'
    || !Number.isFinite(body.ageYears)
    || body.ageYears < 0
    || body.ageYears > 18
  ) {
    throw new HttpError(400, 'Age must be a number between 0 and 18 years.');
  } else {
    profile.ageYears = body.ageYears;
  }

  for (const field of ['disregardSolitaryBrow', 'requireNasolabial']) {
    if (typeof body[field] !== 'boolean') {
      throw new HttpError(400, 'Choose valid facial baseline settings.');
    }
    profile[field] = body[field];
  }

  return profile;
}

function validateAssessmentAnswers(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Enter the assessment observations.');
  }

  const {
    temperature, temperatureUnit, eatingProperly, bowelMovementNormal,
    bloodPressureSystolic, bloodPressureDiastolic
  } = body;
  if (
    typeof temperature !== 'number'
    || !Number.isFinite(temperature)
    || !['C', 'F'].includes(temperatureUnit)
    || temperature < (temperatureUnit === 'C' ? 25 : 77)
    || temperature > (temperatureUnit === 'C' ? 45 : 113)
  ) {
    throw new HttpError(400, 'Enter a valid temperature between 25–45 °C or 77–113 °F.');
  }

  if (typeof eatingProperly !== 'boolean') {
    throw new HttpError(400, 'Choose yes or no for whether the baby has been eating properly.');
  }
  if (typeof bowelMovementNormal !== 'boolean') {
    throw new HttpError(400, 'Choose yes or no for whether bowel movements have been normal.');
  }

  const hasSystolic = bloodPressureSystolic !== null && bloodPressureSystolic !== undefined;
  const hasDiastolic = bloodPressureDiastolic !== null && bloodPressureDiastolic !== undefined;
  if (hasSystolic !== hasDiastolic) {
    throw new HttpError(400, 'Enter both blood pressure values, or leave both blank.');
  }
  if (hasSystolic && (
    !Number.isInteger(bloodPressureSystolic)
    || !Number.isInteger(bloodPressureDiastolic)
    || bloodPressureSystolic < 1
    || bloodPressureSystolic > 500
    || bloodPressureDiastolic < 1
    || bloodPressureDiastolic > 300
    || bloodPressureSystolic <= bloodPressureDiastolic
  )) {
    throw new HttpError(400, 'Enter valid systolic and diastolic blood pressure values.');
  }

  return {
    temperature,
    temperatureUnit,
    eatingProperly,
    bowelMovementNormal,
    bloodPressureSystolic: hasSystolic ? bloodPressureSystolic : null,
    bloodPressureDiastolic: hasDiastolic ? bloodPressureDiastolic : null
  };
}

function serializeAssessment(row) {
  return {
    id: String(row.id),
    profileId: String(row.child_profile_id),
    temperature: Number(row.temperature),
    temperatureUnit: row.temperature_unit,
    eatingProperly: row.eating_properly,
    bowelMovementNormal: row.bowel_movement_normal,
    bloodPressureSystolic: row.blood_pressure_systolic,
    bloodPressureDiastolic: row.blood_pressure_diastolic,
    createdAt: row.created_at
  };
}

async function getLatestAssessment(request, response, profileId) {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, 'Please sign in to view assessment answers.');
  if (!/^[1-9]\d{0,17}$/.test(profileId)) {
    throw new HttpError(400, 'That child profile could not be found.');
  }

  const result = await pool.query(
    `SELECT a.id, a.child_profile_id, a.temperature, a.temperature_unit,
            a.eating_properly, a.bowel_movement_normal, a.blood_pressure_systolic,
            a.blood_pressure_diastolic, a.created_at
     FROM child_assessments a
     JOIN child_profiles p ON p.id = a.child_profile_id
     WHERE a.user_id = $1 AND a.child_profile_id = $2
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 1`,
    [user.id, profileId]
  );
  if (result.rowCount === 0) {
    const profile = await pool.query(
      'SELECT 1 FROM child_profiles WHERE id = $1 AND user_id = $2',
      [profileId, user.id]
    );
    if (profile.rowCount === 0) throw new HttpError(404, 'That child profile could not be found.');
  }

  sendJson(response, 200, { assessment: result.rows[0] ? serializeAssessment(result.rows[0]) : null });
}

async function saveAssessment(request, response, profileId) {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, 'Please sign in before saving assessment answers.');
  if (!/^[1-9]\d{0,17}$/.test(profileId)) {
    throw new HttpError(400, 'That child profile could not be found.');
  }

  const answers = validateAssessmentAnswers(await readJsonBody(request));
  const result = await pool.query(
    `INSERT INTO child_assessments (
       user_id, child_profile_id, temperature, temperature_unit, eating_properly,
       bowel_movement_normal, eating_score, bowel_movement_score,
       blood_pressure_systolic, blood_pressure_diastolic
     )
     SELECT $1, p.id, $3, $4, $5, $6, NULL, NULL, $7, $8
     FROM child_profiles p
     WHERE p.id = $2 AND p.user_id = $1
     RETURNING id, child_profile_id, temperature, temperature_unit, eating_properly,
               bowel_movement_normal, blood_pressure_systolic,
               blood_pressure_diastolic, created_at`,
    [
      user.id, profileId, answers.temperature, answers.temperatureUnit,
      answers.eatingProperly, answers.bowelMovementNormal,
      answers.bloodPressureSystolic, answers.bloodPressureDiastolic
    ]
  );
  if (result.rowCount !== 1) throw new HttpError(404, 'That child profile could not be found.');
  sendJson(response, 201, { assessment: serializeAssessment(result.rows[0]) });
}

function serializeChildProfile(row) {
  return {
    id: String(row.id),
    displayName: row.display_name,
    ageYears: row.age_years === null ? null : Number(row.age_years),
    caregiverContacts: row.caregiver_contacts,
    intervention: row.intervention,
    motorPatterns: row.motor_patterns,
    facialMarkers: row.facial_markers,
    disregardSolitaryBrow: row.disregard_solitary_brow,
    requireNasolabial: row.require_nasolabial,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getChildProfiles(request, response) {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, 'Please sign in to view child profiles.');

  const result = await pool.query(
    `SELECT id, display_name, age_years, caregiver_contacts, intervention,
            motor_patterns, facial_markers, disregard_solitary_brow,
            require_nasolabial, created_at, updated_at
     FROM child_profiles
     WHERE user_id = $1
     ORDER BY created_at, id`,
    [user.id]
  );
  sendJson(response, 200, { profiles: result.rows.map(serializeChildProfile) });
}

async function createChildProfile(request, response) {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, 'Please sign in before creating a child profile.');

  const profile = validateChildProfile(await readJsonBody(request));
  const result = await pool.query(
    `INSERT INTO child_profiles (
       user_id, display_name, age_years, caregiver_contacts, intervention,
       motor_patterns, facial_markers, disregard_solitary_brow, require_nasolabial
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, display_name, age_years, caregiver_contacts, intervention,
               motor_patterns, facial_markers, disregard_solitary_brow,
               require_nasolabial, created_at, updated_at`,
    [
      user.id, profile.displayName, profile.ageYears, profile.caregiverContacts,
      profile.intervention, profile.motorPatterns, profile.facialMarkers,
      profile.disregardSolitaryBrow, profile.requireNasolabial
    ]
  );
  sendJson(response, 201, { profile: serializeChildProfile(result.rows[0]) });
}

async function updateChildProfile(request, response, profileId) {
  const user = await getSessionUser(request);
  if (!user) throw new HttpError(401, 'Please sign in before editing a child profile.');
  if (!/^[1-9]\d{0,17}$/.test(profileId)) {
    throw new HttpError(400, 'That child profile could not be found.');
  }

  const profile = validateChildProfile(await readJsonBody(request));
  const result = await pool.query(
    `UPDATE child_profiles
     SET display_name = $3, age_years = $4, caregiver_contacts = $5,
         intervention = $6, motor_patterns = $7, facial_markers = $8,
         disregard_solitary_brow = $9, require_nasolabial = $10,
         updated_at = now()
     WHERE id = $1 AND user_id = $2
     RETURNING id, display_name, age_years, caregiver_contacts, intervention,
               motor_patterns, facial_markers, disregard_solitary_brow,
               require_nasolabial, created_at, updated_at`,
    [
      profileId, user.id, profile.displayName, profile.ageYears,
      profile.caregiverContacts, profile.intervention, profile.motorPatterns,
      profile.facialMarkers, profile.disregardSolitaryBrow, profile.requireNasolabial
    ]
  );
  if (result.rowCount !== 1) throw new HttpError(404, 'That child profile could not be found.');
  sendJson(response, 200, { profile: serializeChildProfile(result.rows[0]) });
}

async function hashPassword(password, salt = randomBytes(16)) {
  const derivedKey = await scrypt(password, salt, passwordKeyLength);
  return { salt, hash: derivedKey };
}

async function createSession(userId, client = pool) {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  await client.query(
    'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, expiresAt]
  );
  return token;
}

async function getSessionUser(request) {
  const token = readCookie(request, sessionCookieName);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const result = await pool.query(
    `SELECT users.id, users.email
     FROM auth_sessions
     JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.token_hash = $1 AND auth_sessions.expires_at > now()`,
    [hashToken(token)]
  );

  return result.rows[0] ?? null;
}

async function register(request, response) {
  if (!consumeRateLimit(request, 'register')) {
    throw new HttpError(429, 'Too many account attempts. Please wait a few minutes and try again.');
  }

  const body = await readJsonBody(request);
  const { email, password } = validateCredentials(body);
  const hospitalId = Object.hasOwn(body, 'hospitalId')
    ? validateKarnatakaHospitalId(body.hospitalId)
    : null;
  const { salt, hash } = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      'INSERT INTO users (email, password_salt, password_hash, hospital_id) VALUES ($1, $2, $3, $4) RETURNING id, email',
      [email, salt, hash, hospitalId]
    );
    const user = result.rows[0];
    const token = await createSession(user.id, client);
    await client.query('COMMIT');
    clearRateLimit(request, 'register');
    sendCookie(response, token);
    sendJson(response, 201, { user: { id: user.id, email: user.email } });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      throw new HttpError(409, 'An account with that email already exists. Try signing in instead.');
    }
    throw error;
  } finally {
    client.release();
  }
}

async function login(request, response) {
  if (!consumeRateLimit(request, 'login')) {
    throw new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.');
  }

  const body = await readJsonBody(request);
  const { email, password } = validateCredentials(body);
  const hospitalId = Object.hasOwn(body, 'hospitalId')
    ? validateKarnatakaHospitalId(body.hospitalId)
    : null;
  const result = await pool.query(
    'SELECT id, email, password_salt, password_hash, hospital_id FROM users WHERE email = $1',
    [email]
  );
  const user = result.rows[0];
  const salt = user?.password_salt ?? dummySalt;
  const { hash } = await hashPassword(password, salt);
  const passwordMatches = Boolean(user?.password_hash && timingSafeEqual(hash, user.password_hash));
  const portalMatches = hospitalId
    ? user?.hospital_id === hospitalId
    : !user?.hospital_id;

  if (!passwordMatches || !portalMatches) {
    throw new HttpError(401, 'Email or password is incorrect.');
  }

  const token = await createSession(user.id);
  clearRateLimit(request, 'login');
  sendCookie(response, token);
  sendJson(response, 200, { user: { id: user.id, email: user.email } });
}

function startGoogleOAuth(response) {
  if (!googleOAuthClient) {
    redirectToLogin(response, 'Google sign-in is not configured yet.');
    return;
  }

  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(48).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const statePayload = Buffer.from(JSON.stringify({ state, nonce, codeVerifier })).toString('base64url');
  const secure = secureCookie ? '; Secure' : '';
  const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorizationUrl.search = new URLSearchParams({
    client_id: googleOAuthClientId,
    redirect_uri: googleRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  }).toString();

  response.writeHead(302, {
    Location: authorizationUrl.toString(),
    'Cache-Control': 'no-store',
    'Set-Cookie': `${oauthStateCookieName}=${statePayload}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure}`
  });
  response.end();
}

async function completeGoogleOAuth(request, response, url) {
  if (!googleOAuthClient) {
    clearGoogleOAuthCookie(response);
    redirectToLogin(response, 'Google sign-in is not configured yet.');
    return;
  }

  const encodedState = readCookie(request, oauthStateCookieName);
  clearGoogleOAuthCookie(response);
  if (url.searchParams.has('error')) {
    redirectToLogin(response, 'Google sign-in was cancelled or could not be completed.');
    return;
  }

  let savedState;
  try {
    savedState = JSON.parse(Buffer.from(encodedState || '', 'base64url').toString('utf8'));
  } catch {
    redirectToLogin(response, 'Google sign-in expired. Please try again.');
    return;
  }

  const returnedState = url.searchParams.get('state') || '';
  if (
    typeof savedState.state !== 'string'
    || !/^[A-Za-z0-9_-]{40,50}$/.test(savedState.state)
    || Buffer.byteLength(returnedState) !== Buffer.byteLength(savedState.state)
    || !timingSafeEqual(Buffer.from(returnedState), Buffer.from(savedState.state))
    || typeof savedState.nonce !== 'string'
    || typeof savedState.codeVerifier !== 'string'
  ) {
    redirectToLogin(response, 'Google sign-in could not be verified. Please try again.');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    redirectToLogin(response, 'Google did not return a sign-in code. Please try again.');
    return;
  }

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: googleOAuthClientId,
        client_secret: googleOAuthClientSecret,
        redirect_uri: googleRedirectUri,
        grant_type: 'authorization_code',
        code_verifier: savedState.codeVerifier
      }),
      signal: AbortSignal.timeout(10000)
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || typeof tokens.id_token !== 'string') {
      throw new Error('Google token exchange failed.');
    }

    const ticket = await googleOAuthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: googleOAuthClientId
    });
    const identity = ticket.getPayload();
    if (
      !identity
      || identity.nonce !== savedState.nonce
      || identity.email_verified !== true
      || typeof identity.email !== 'string'
      || typeof identity.sub !== 'string'
    ) {
      throw new Error('Google identity verification failed.');
    }

    const email = identity.email.trim().toLowerCase();
    const client = await pool.connect();
    let token;

    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO users (email, password_salt, password_hash, google_sub)
         VALUES ($1, NULL, NULL, $2)
         ON CONFLICT (email) DO UPDATE
         SET google_sub = COALESCE(users.google_sub, EXCLUDED.google_sub)
         WHERE (users.google_sub IS NULL OR users.google_sub = EXCLUDED.google_sub)
           AND users.hospital_id IS NULL
         RETURNING id, email`,
        [email, identity.sub]
      );
      if (result.rowCount !== 1) {
        throw new HttpError(409, 'This Google account could not be linked to the existing account.');
      }

      token = await createSession(result.rows[0].id, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    sendCookie(response, token);
    response.writeHead(303, { Location: '/dashboard', 'Cache-Control': 'no-store' });
    response.end();
  } catch (error) {
    if (error instanceof HttpError) {
      redirectToLogin(response, error.message);
      return;
    }

    console.error('Google sign-in could not be completed:', error.message);
    redirectToLogin(response, 'Google sign-in could not be completed. Check your OAuth settings and try again.');
  }
}

async function logout(request, response) {
  const token = readCookie(request, sessionCookieName);
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await pool.query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashToken(token)]);
  }

  clearCookie(response);
  sendJson(response, 200, { ok: true });
}

async function sendHtmlFile(response, path) {
  const content = await readFile(join(projectDirectory, path));
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  response.end(content);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://localhost');

  if (
    request.method === 'GET'
    && (url.pathname === '/' || url.pathname === '/login' || url.pathname === '/hospital-login')
  ) {
    const page = await readFile(join(projectDirectory, 'login_otp_authentication/code.html'), 'utf8');
    const error = url.searchParams.get('authError');
    const safeError = error ? error.replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[character]) : '';
    const html = page.replace('<!-- AUTH_ERROR -->', safeError);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    response.end(html);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/google/status') {
    sendJson(response, 200, { enabled: isGoogleOAuthConfigured() });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/auth/google') {
    startGoogleOAuth(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/auth/google/callback') {
    await completeGoogleOAuth(request, response, url);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/dashboard') {
    if (!await getSessionUser(request)) {
      response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    await sendHtmlFile(response, 'child_profile_assessment_dashboard/code.html');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/assessment-launch') {
    if (!await getSessionUser(request)) {
      response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    await sendHtmlFile(response, 'assessment_launch/code.html');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/ai-disambiguation') {
    if (!await getSessionUser(request)) {
      response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    await sendHtmlFile(response, 'ai_analysis_parent_disambiguation/code.html');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/pain-scale-report') {
    if (!await getSessionUser(request)) {
      response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    await sendHtmlFile(response, 'pediatric_pain_scale_final_report/code.html');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/camera-telemetry') {
    if (!await getSessionUser(request)) {
      response.writeHead(303, { Location: '/login', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    await sendHtmlFile(response, 'live_video_camera_telemetry/code.html');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/register') {
    await register(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    await login(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    await logout(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/video-upload') {
    await receiveVideoUpload(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/child-profiles') {
    await getChildProfiles(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/child-profiles') {
    await createChildProfile(request, response);
    return;
  }

  const childProfileMatch = url.pathname.match(/^\/api\/child-profiles\/([^/]+)$/);
  if (request.method === 'PUT' && childProfileMatch) {
    await updateChildProfile(request, response, childProfileMatch[1]);
    return;
  }

  const childAssessmentMatch = url.pathname.match(/^\/api\/child-profiles\/([^/]+)\/assessments(?:\/latest)?$/);
  if (request.method === 'GET' && childAssessmentMatch && url.pathname.endsWith('/latest')) {
    await getLatestAssessment(request, response, childAssessmentMatch[1]);
    return;
  }
  if (request.method === 'POST' && childAssessmentMatch && !url.pathname.endsWith('/latest')) {
    await saveAssessment(request, response, childAssessmentMatch[1]);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = await getSessionUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Please sign in to continue.' });
      return;
    }
    sendJson(response, 200, { user: { id: user.id, email: user.email } });
    return;
  }

  sendJson(response, 404, { error: 'Page not found.' });
}

async function startServer() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_salt BYTEA,
      password_hash BYTEA,
      google_sub TEXT UNIQUE,
      hospital_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE users ALTER COLUMN password_salt DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT UNIQUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hospital_id TEXT;
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx ON auth_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS child_profiles (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
      age_years NUMERIC(4, 2) CHECK (age_years >= 0 AND age_years <= 18),
      caregiver_contacts TEXT NOT NULL DEFAULT '',
      intervention TEXT NOT NULL DEFAULT '',
      motor_patterns TEXT NOT NULL DEFAULT '',
      facial_markers TEXT NOT NULL DEFAULT '',
      disregard_solitary_brow BOOLEAN NOT NULL DEFAULT false,
      require_nasolabial BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS child_profiles_user_id_idx ON child_profiles(user_id);
    CREATE TABLE IF NOT EXISTS child_assessments (
      id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      child_profile_id BIGINT NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
      temperature NUMERIC(5, 2) NOT NULL CHECK (temperature > 0),
      temperature_unit TEXT NOT NULL CHECK (temperature_unit IN ('C', 'F')),
      eating_score SMALLINT CHECK (eating_score BETWEEN 1 AND 10),
      bowel_movement_score SMALLINT CHECK (bowel_movement_score BETWEEN 1 AND 10),
      eating_properly BOOLEAN,
      bowel_movement_normal BOOLEAN,
      blood_pressure_systolic SMALLINT CHECK (blood_pressure_systolic BETWEEN 1 AND 500),
      blood_pressure_diastolic SMALLINT CHECK (blood_pressure_diastolic BETWEEN 1 AND 300),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (
        (blood_pressure_systolic IS NULL AND blood_pressure_diastolic IS NULL)
        OR (
          blood_pressure_systolic IS NOT NULL
          AND blood_pressure_diastolic IS NOT NULL
          AND blood_pressure_systolic > blood_pressure_diastolic
        )
      )
    );
    ALTER TABLE child_assessments ALTER COLUMN eating_score DROP NOT NULL;
    ALTER TABLE child_assessments ALTER COLUMN bowel_movement_score DROP NOT NULL;
    ALTER TABLE child_assessments ADD COLUMN IF NOT EXISTS eating_properly BOOLEAN;
    ALTER TABLE child_assessments ADD COLUMN IF NOT EXISTS bowel_movement_normal BOOLEAN;
    CREATE INDEX IF NOT EXISTS child_assessments_profile_created_idx
      ON child_assessments(child_profile_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS child_assessments_user_id_idx ON child_assessments(user_id);
  `);

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }

      console.error('Request failed:', error);
      sendJson(response, 500, { error: 'Something went wrong. Please try again.' });
    });
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => {
    console.log(`LittleCare is running at http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Could not start LittleCare. Check PostgreSQL and DATABASE_URL.', error);
  process.exitCode = 1;
});
