/**
 * core/firestore.js — Firebase Admin SDK connection
 * Exports `db` (Firestore instance) and `admin` (Firebase Admin).
 *
 * Credential resolution order:
 *   1. Service account env vars (FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
 *   2. Application Default Credentials (ADC) — requires only FIREBASE_PROJECT_ID and a valid
 *      gcloud ADC file on disk (set up via `gcloud auth application-default login`).
 *   3. Mock db — silent no-op fallback when nothing is configured or init fails.
 */

const admin = require('firebase-admin');

let db;
let isConfigured = false;
let credentialMode = 'none'; // 'service-account' | 'adc' | 'mock' | 'none'

function initFirestore() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  try {
    if (!admin.apps.length) {
      if (projectId && clientEmail && privateKey) {
        // Service account credentials
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
          }),
        });
        credentialMode = 'service-account';
        console.log(`\u2713 Firebase connected (service account) \u2014 project: ${projectId}`);
      } else if (projectId) {
        // Application Default Credentials (e.g., `gcloud auth application-default login`)
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
          projectId,
        });
        credentialMode = 'adc';
        console.log(`\u2713 Firebase connected (ADC) \u2014 project: ${projectId}`);
      } else {
        console.log('SERVICE NOT CONFIGURED: Firebase \u2014 missing FIREBASE_PROJECT_ID');
        credentialMode = 'mock';
        return createMockDb();
      }
    }

    db = admin.firestore();
    isConfigured = true;
    return db;
  } catch (err) {
    console.error('Firebase initialization failed:', err.message);
    console.log('SERVICE NOT CONFIGURED: Firebase (init error)');
    credentialMode = 'mock';
    return createMockDb();
  }
}

/**
 * Mock Firestore that silently no-ops every call.
 * Allows the rest of the app to run without Firebase credentials.
 */
function createMockDb() {
  const mockDocRef = {
    get: async () => ({ exists: false, data: () => null, id: 'mock' }),
    set: async () => {},
    update: async () => {},
    delete: async () => {},
    onSnapshot: (cb) => {
      // Return unsubscribe function
      return () => {};
    },
    collection: () => mockCollectionRef,
  };

  const mockQuery = {
    get: async () => ({ empty: true, docs: [], forEach: () => {}, size: 0 }),
    onSnapshot: (cb) => () => {},
    where: () => mockQuery,
    orderBy: () => mockQuery,
    limit: () => mockQuery,
    startAfter: () => mockQuery,
  };

  const mockCollectionRef = {
    doc: () => mockDocRef,
    add: async (data) => ({ id: 'mock-' + Date.now(), ...mockDocRef }),
    get: async () => ({ empty: true, docs: [], forEach: () => {}, size: 0 }),
    where: () => mockQuery,
    orderBy: () => mockQuery,
    limit: () => mockQuery,
    onSnapshot: (cb) => () => {},
  };

  const mock = {
    collection: () => mockCollectionRef,
    doc: () => mockDocRef,
    batch: () => ({
      set: () => {},
      update: () => {},
      delete: () => {},
      commit: async () => {},
    }),
    runTransaction: async (fn) => {
      await fn({
        get: async () => ({ exists: false, data: () => null }),
        set: () => {},
        update: () => {},
      });
    },
    _isMock: true,
  };

  return mock;
}

db = initFirestore();

// Log mock vs real status for quick diagnostics
if (db && db._isMock) {
  console.log('[Firestore] Running with MOCK db (_isMock=true)');
} else {
  console.log(`[Firestore] Running with REAL Firestore (mode: ${credentialMode})`);
}

module.exports = {
  db,
  admin,
  isConfigured: () => isConfigured,
  getCredentialMode: () => credentialMode,
};
