const fs = require('fs');

['scripts/cleanup-test-data.js', 'scripts/remove-test-numbers.js'].forEach(f => {
  let c = fs.readFileSync(f, 'utf8');
  // Remove shebang line if present
  c = c.replace(/^#!.*\n/, '');
  // Remove any existing dotenv require to avoid duplicates
  c = c.replace(/^require\('dotenv'\)\.config\(\);\n/m, '');
  // Add dotenv after the opening comment block
  c = c.replace(
    "const admin = require('firebase-admin');",
    "require('dotenv').config();\nconst admin = require('firebase-admin');"
  );
  fs.writeFileSync(f, c, 'utf8');
  console.log('✅ Fixed:', f);
});
