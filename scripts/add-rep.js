#!/usr/bin/env node
/**
 * scripts/add-rep.js
 * Add a new rep to the reps collection.
 * Usage: node scripts/add-rep.js --name "John Smith" --phone "+15591234567" [--email john@example.com]
 */
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

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs();

  if (!args.name || !args.phone) {
    console.log('Usage: node scripts/add-rep.js --name "John Smith" --phone "+15591234567" [--email john@example.com]');
    process.exit(1);
  }

  const phone = args.phone.startsWith('+') ? args.phone : '+1' + args.phone.replace(/\D/g, '');

  // Check if phone already exists
  const existing = await db.collection('reps').where('phone', '==', phone).get();
  if (!existing.empty) {
    console.log(`⚠ Rep with phone ${phone} already exists (ID: ${existing.docs[0].id})`);
    process.exit(1);
  }

  const repData = {
    name: args.name,
    phone: phone,
    email: args.email || '',
    role: 'rep',
    status: 'approved',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection('reps').add(repData);
  console.log(`✓ Rep added: ${args.name} (${phone})`);
  console.log(`  Firestore ID: ${ref.id}`);
  console.log(`  Status: approved (can log in immediately)`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
