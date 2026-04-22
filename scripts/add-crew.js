#!/usr/bin/env node
/**
 * scripts/add-crew.js
 * Add a new crew member to the crew_members collection.
 * Usage: node scripts/add-crew.js --name "Mike Torres" --phone "+15591234567" [--company "TrashApp"] [--rate 20]
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
    console.log('Usage: node scripts/add-crew.js --name "Mike Torres" --phone "+15591234567" [--company "TrashApp"] [--rate 20]');
    process.exit(1);
  }

  const phone = args.phone.startsWith('+') ? args.phone : '+1' + args.phone.replace(/\D/g, '');

  // Check if phone already exists
  const existing = await db.collection('crew_members').where('phone', '==', phone).get();
  if (!existing.empty) {
    console.log(`⚠ Crew member with phone ${phone} already exists (ID: ${existing.docs[0].id})`);
    process.exit(1);
  }

  const crewData = {
    name: args.name,
    phone: phone,
    status: 'approved',
    crewCompany: args.company || 'TrashApp',
    hourlyRate: parseFloat(args.rate) || 20,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  const ref = await db.collection('crew_members').add(crewData);
  console.log(`✓ Crew member added: ${args.name} (${phone})`);
  console.log(`  Firestore ID: ${ref.id}`);
  console.log(`  Status: approved (can log in immediately)`);
  console.log(`  Hourly rate: $${crewData.hourlyRate}`);
  process.exit(0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
