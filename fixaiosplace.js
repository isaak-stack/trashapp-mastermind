const fs = require('fs');
const f = 'C:\\Users\\claud\\Desktop\\Trashapp\\DEPLOY\\admin-console.html';
let c = fs.readFileSync(f, 'utf8');

// Add a one-time fix at the end of showView function
// Find showView function and add DOM move for aios
const target = "window.showView = view => {";
const replacement = `window.showView = view => {
  // Ensure view-aios is inside .content (structural fix)
  if (view === 'aios') {
    const aiosEl = document.getElementById('view-aios');
    const contentEl = document.querySelector('.content');
    if (aiosEl && contentEl && !contentEl.contains(aiosEl)) {
      contentEl.appendChild(aiosEl);
    }
  }`;

c = c.replace(target, replacement);
fs.writeFileSync(f, c, 'utf8');
console.log('Fixed:', c.includes("Ensure view-aios is inside .content"));
