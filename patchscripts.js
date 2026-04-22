const fs = require('fs');

// Patch cleanup-test-data.js
let c1 = fs.readFileSync('scripts/cleanup-test-data.js', 'utf8');
if (!c1.includes("require('dotenv')")) {
  c1 = c1.replace(
    "const admin = require('firebase-admin');",
    "require('dotenv').config();\nconst admin = require('firebase-admin');"
  );
  fs.writeFileSync('scripts/cleanup-test-data.js', c1, 'utf8');
  console.log('✅ Patched cleanup-test-data.js');
} else {
  console.log('⏭ cleanup-test-data.js already patched');
}

// Patch remove-test-numbers.js
let c2 = fs.readFileSync('scripts/remove-test-numbers.js', 'utf8');
if (!c2.includes("require('dotenv')")) {
  c2 = c2.replace(
    "const admin = require('firebase-admin');",
    "require('dotenv').config();\nconst admin = require('firebase-admin');"
  );
  fs.writeFileSync('scripts/remove-test-numbers.js', c2, 'utf8');
  console.log('✅ Patched remove-test-numbers.js');
} else {
  console.log('⏭ remove-test-numbers.js already patched');
}
