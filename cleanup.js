require('dotenv').config();
const admin = require('firebase-admin');

const isDryRun = process.argv.includes('--dry-run');

if (!admin.apps.length) {
  admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
}
const db = admin.firestore();

const TEST_PHONES = ['+15597744249', '+19096729370', '+15551234567'];
const TEST_PATTERNS = ['test', 'demo', 'sample', 'fake', 'dummy', 'john doe', 'jane doe'];

async function scan(collection) {
  const snap = await db.collection(collection).get();
  const toDelete = [];
  snap.docs.forEach(doc => {
    const d = doc.data();
    const str = JSON.stringify(d).toLowerCase();
    const isTest = TEST_PATTERNS.some(p => str.includes(p)) ||
      TEST_PHONES.some(p => (d.customerPhone || d.phone || '').includes(p));
    if (isTest) toDelete.push({ id: doc.id, data: d });
  });
  return toDelete;
}

async function run() {
  console.log(`\n🧹 TrashApp Cleanup ${isDryRun ? '(DRY RUN)' : '(LIVE)'}\n`);
  const collections = ['jobs', 'doors', 'reps', 'rep_sessions', 'agent_messages', 'commissions'];
  
  for (const col of collections) {
    try {
      const found = await scan(col);
      console.log(`── ${col}: ${found.length} test records found`);
      found.forEach(r => console.log(`   ${r.id} — ${r.data.customerPhone || r.data.phone || r.data.from || 'no phone'}`));
      if (!isDryRun && found.length > 0) {
        for (const r of found) await db.collection(col).doc(r.id).delete();
        console.log(`   ✅ Deleted ${found.length} records`);
      }
    } catch(e) {
      console.log(`   ⚠️ ${col}: ${e.message}`);
    }
  }
  console.log('\nDone.');
  process.exit(0);
}

run();
