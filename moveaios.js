const fs = require('fs');
const f = 'C:\\Users\\claud\\Desktop\\Trashapp\\DEPLOY\\admin-console.html';
let c = fs.readFileSync(f, 'utf8');

// Find view-aios block
const aiosStart = c.indexOf('<div class="view" id="view-aios">');
// Find its closing tag by counting div depth
let depth = 0;
let i = aiosStart;
while (i < c.length) {
  if (c.substring(i, i+5) === '<div ') depth++;
  else if (c.substring(i, i+4) === '</di') { depth--; if (depth === 0) { i += 6; break; } }
  i++;
}
const aiosEnd = i;
const aiosBlock = c.substring(aiosStart, aiosEnd);

// Remove from current location
c = c.substring(0, aiosStart) + c.substring(aiosEnd);

// Find the last </div> before <script type="module"> and insert before it
const scriptPos = c.indexOf('<script type="module">');
// Go backwards from scriptPos to find the right closing div
const beforeScript = c.substring(0, scriptPos);
const lastDiv = beforeScript.lastIndexOf('</div>');
c = c.substring(0, lastDiv) + '\n' + aiosBlock + '\n' + c.substring(lastDiv);

fs.writeFileSync(f, c, 'utf8');
console.log('Done - moved view-aios inside content div, block length:', aiosBlock.length);
