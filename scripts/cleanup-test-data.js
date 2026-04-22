#!/usr/bin/env node
/**
 * scripts/cleanup-test-data.js
 * Removes test data from Firestore collections.
 * Usage: node scripts/cleanup-test-data.js [--dry-run]
 */
require('dotenv').config();
const admin = require('firebase-admin');

// Initialize with ADC or service account
if (!admin.apps.length) {
  try {
    const sa = require('../service-account.json');
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } catch {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}
const db = admin.firestore();
const DRY_RUN = process.argv.includes('--dry-run');

const TEST_PATTERNS = [
  /test/i, /demo/i, /sample/i, /fake/i, /dummy/i,
  /john\s*doe/i, /jane\s*doe/i, /asdf/i, /xxx/i
];

const TEST_PHONES = ['+15597744249', '+19096729370', '+10000000000', '+11111111111', '+12345678900'];

async function cleanCollection(name, fieldChecks) {
  console.log(`\n── Scanning: ${name} ──`);
  const snap = await db.collection(name).get();
  let deleted = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    let isTest = false;
    let reason = '';

    for (const { field, check } of fieldChecks) {
      const val = data[field];
      if (!val) continue;
      if (check === 'pattern' && TEST_PATTERNS.some(p => p.test(String(val)))) {
        isTest = true; reason = `${field}="${val}" matches test pattern`; break;
      }
      if (check === 'phone' && TEST_PHONES.includes(String(val))) {
        isTest = true; reason = `${field}="${val}" is test phone`; break;
      }
    }

    if (isTest) {
      if (DRY_RUN) {
        console.log(`  [DRY RUN] Would delete ${name}/${doc.id} — ${reason}`);
      } else {
        await doc.ref.delete();
        console.log(`  ✓ Deleted ${name}/${doc.id} — ${reason}`);
      }
      deleted++;
    }
  }

  console.log(`  ${deleted} test record(s) ${DRY_RUN ? 'found' : 'deleted'} in ${name}`);
  return deleted;
}

async function main() {
  console.log(`\n🧹 TrashApp Test Data Cleanup ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log('═'.repeat(50));

  let total = 0;

  total += await cleanCollection('jobs', [
    { field: 'customer_name', check: 'pattern' },
    { field: 'phone', check: 'phone' },
    { field: 'email', check: 'pattern' }
  ]);

  total += await cleanCollection('doors', [
    { field: 'address', check: 'pattern' },
    { field: 'notes', check: 'pattern' }
  ]);

  total += await cleanCollection('rep_sessions', [
    { field: 'repName', check: 'pattern' }
  ]);

  total += await cleanCollection('leads', [
    { field: 'name', check: 'pattern' },
    { field: 'phone', check: 'phone' }
  ]);

  console.log(`\n═══════════════════════════════════════`);
  console.log(`Total: ${total} test record(s) ${DRY_RUN ? 'found' : 'cleaned'}`);
  if (DRY_RUN) console.log('Run without --dry-run to delete.');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
