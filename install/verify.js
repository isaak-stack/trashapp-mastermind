/**
 * install/verify.js — Post-install verification script
 * Checks all required env vars and connections before starting.
 *
 * Firebase credentials may be supplied in one of two ways:
 *   (a) Service account env vars: FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 *   (b) Application Default Credentials (ADC) file written by `gcloud auth application-default login`
 *       - Windows: %APPDATA%\gcloud\application_default_credentials.json
 *       - Mac/Linux: ~/.config/gcloud/application_default_credentials.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const os = require('os');

function adcFilePath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'gcloud', 'application_default_credentials.json');
  }
  return path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

function adcAvailable() {
  try {
    return fs.existsSync(adcFilePath());
  } catch (_) {
    return false;
  }
}

const checks = [
  { name: 'FIREBASE_PROJECT_ID', critical: true },
  { name: 'FIREBASE_CLIENT_EMAIL', critical: true, adcFallback: true },
  { name: 'FIREBASE_PRIVATE_KEY', critical: true, adcFallback: true },
  { name: 'TWILIO_ACCOUNT_SID', critical: true },
  { name: 'TWILIO_AUTH_TOKEN', critical: true },
  { name: 'TWILIO_PHONE_NUMBER', critical: true },
  { name: 'ANTHROPIC_API_KEY', critical: true },
  { name: 'ADMIN_PHONE', critical: true },
  { name: 'RAILWAY_QUOTE_API', critical: true },
  { name: 'EIA_API_KEY', critical: false },
  { name: 'STRIPE_SECRET_KEY', critical: false },
  { name: 'DASHBOARD_PASSWORD', critical: false },
];

let allCriticalPass = true;
console.log('\n\ud83d\udccb Environment Check\n');

const hasADC = adcAvailable();

for (const check of checks) {
  const val = process.env[check.name];
  const present = val && val.length > 0 && !val.includes('your_') && !val.includes('YOUR_');

  // If env var is missing but ADC file is on disk, treat Firebase creds as satisfied
  const satisfiedByADC = !present && check.adcFallback && hasADC;

  const label = check.critical ? '\ud83d\udd34 REQUIRED' : '\ud83d\udfe1 OPTIONAL';
  let status;
  let note;

  if (present) {
    status = '\u2705';
    note = 'Set';
  } else if (satisfiedByADC) {
    status = '\u2705';
    note = 'ADC mode';
  } else {
    status = check.critical ? '\u274c' : '\u26a0\ufe0f ';
    note = `Missing ${label}`;
  }

  console.log(`${status} ${check.name.padEnd(30)} ${note}`);

  if (!present && !satisfiedByADC && check.critical) allCriticalPass = false;
}

if (hasADC) {
  console.log(`\n\u2139\ufe0f  Detected gcloud ADC file at: ${adcFilePath()}`);
}

console.log('\n' + '\u2501'.repeat(50));

if (allCriticalPass) {
  console.log('\u2705 All critical variables set. Ready to start.\n');
  process.exit(0);
} else {
  console.log('\u274c Missing critical variables. Fill in .env before starting.\n');
  console.log('Your credentials are saved in your Claude conversation history.\n');
  process.exit(1);
}
