#!/usr/bin/env node
/**
 * scripts/remove-test-numbers.js
 * Removes known test phone numbers from all collections.
 * Usage: node scripts/remove-test-numbers.js [--dry-run]
 */
require('dotenv').config();
const admin = require('firebase-admin');

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

// Known test numbers from the codebase
const TEST_NUMBERS = [
  '+15597744249',   // Test number in rep-platform.html
  '+19096729370',   // Test number in rep-platform.html
  '+10000000000',
  '+11111111111',
  '+12345678900'
];

const COLLECTIONS_TO_SCAN = [
  { name: 'jobs', phoneFields: ['phone', 'customerPhone', 'customer_phone'] },
  { name: 'leads', phoneFields: ['phone'] },
  { name: 'reps', phoneFields: ['phone'] },
  { name: 'doors', phoneFields: ['phone', 'customerPhone'] },
  { name: 'pending_notifications', phoneFields: ['to'] }
];

async function main() {
  console.log(`\n📱 Remove Test Phone Numbers ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
  console.log(`Test numbers: ${TEST_NUMBERS.join(', ')}`);
  console.log('═'.repeat(50));

  let total = 0;

  for (const { name, phoneFields } of COLLECTIONS_TO_SCAN) {
    console.log(`\n── ${name} ──`);
    let found = 0;

    for (const field of phoneFields) {
      for (const testNum of TEST_NUMBERS) {
        try {
          const snap = await db.collection(name).where(field, '==', testNum).get();
          for (const doc of snap.docs) {
            if (DRY_RUN) {
              console.log(`  [DRY RUN] Would delete ${name}/${doc.id} (${field}=${testNum})`);
            } else {
              await doc.ref.delete();
              console.log(`  ✓ Deleted ${name}/${doc.id} (${field}=${testNum})`);
            }
            found++;
          }
        } catch (err) {
          // Collection may not exist or field not indexed
          if (!err.message.includes('not found')) {
            console.warn(`  ⚠ Error scanning ${name}.${field}: ${err.message}`);
          }
        }
      }
    }

    console.log(`  ${found} record(s) ${DRY_RUN ? 'found' : 'deleted'}`);
    total += found;
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`Total: ${total} test record(s) ${DRY_RUN ? 'found' : 'removed'}`);
  if (DRY_RUN) console.log('Run without --dry-run to delete.');
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
