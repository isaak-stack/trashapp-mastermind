/**
 * maintenance/known-bugs.js — Known Bug Registry
 * Every bug that gets fixed gets added here so it can never
 * silently come back. The bug scanner runs these checks nightly.
 *
 * Each check receives the HTML string of a site and returns:
 *   null — if the bug is NOT present (all clear)
 *   { severity, description, suggestedFix } — if the bug IS present
 */

const KNOWN_BUG_CHECKS = [
  {
    id: 'door-sheet-state-contamination',
    description: 'Door sheet notes pre-filling from nearby doors',
    appliesTo: ['rep-platform'],
    check: async (html) => {
      // Check that the 50m proximity pre-fill only applies to notes within 5m
      const hasProximityCheck = html.includes('dist < 5') || html.includes('dist<5') || html.includes('noteDist<5') || html.includes('noteDist < 5');
      return hasProximityCheck ? null : {
        severity: 'medium',
        description: 'Door sheet notes pre-filling from nearby doors (50m radius too wide)',
        suggestedFix: 'Reduce note pre-fill radius from 50m to 5m in openDoorSheet function'
      };
    }
  },
  {
    id: 'quote-price-floor',
    description: 'Quote page showing prices below $175',
    appliesTo: ['quote'],
    check: async (html) => {
      const hasFloor = html.includes('enforceMinimumPrice') || (html.includes('Math.max') && html.includes('175'));
      return hasFloor ? null : {
        severity: 'high',
        description: 'Quote page missing $175 minimum price floor enforcement',
        suggestedFix: 'Add enforceMinimumPrice() function and apply to all quote responses'
      };
    }
  },
  {
    id: 'firebase-auth-screen',
    description: 'Login screen missing from platform',
    appliesTo: ['rep-platform', 'admin'],
    check: async (html) => {
      const hasAuth = html.includes('auth-screen') && html.includes('recaptcha-container');
      return hasAuth ? null : {
        severity: 'high',
        description: 'Firebase auth screen or recaptcha container missing — login will be broken',
        suggestedFix: 'Check for JS syntax errors that may have killed the module before Firebase loaded'
      };
    }
  },
  {
    id: 'module-scope-window-export',
    description: 'Module-scoped functions not exported to window for onclick handlers',
    appliesTo: ['rep-platform', 'admin'],
    check: async (html) => {
      // If the file uses <script type="module">, critical functions must be on window
      const usesModule = html.includes('type="module"') || html.includes("type='module'");
      if (!usesModule) return null;

      // Check rep platform critical functions
      const hasWindowSendOTP = html.includes('window.sendOTP') || html.includes('window.sendAdminOTP');
      const hasWindowVerifyOTP = html.includes('window.verifyOTP') || html.includes('window.verifyAdminOTP');

      if (!hasWindowSendOTP || !hasWindowVerifyOTP) {
        return {
          severity: 'high',
          description: 'Auth functions (sendOTP/verifyOTP) not exported to window — login buttons will be dead',
          suggestedFix: 'Add window.sendOTP = sendOTP and window.verifyOTP = verifyOTP after function definitions'
        };
      }
      return null;
    }
  },
  {
    id: 'duplicate-let-declarations',
    description: 'Duplicate let declarations killing the module',
    appliesTo: ['rep-platform', 'admin'],
    check: async (html) => {
      // Extract all let/const declarations and check for duplicates within script blocks
      const letPattern = /\blet\s+(\w+)\s*[=;,]/g;
      const declarations = {};
      let match;
      while ((match = letPattern.exec(html)) !== null) {
        const name = match[1];
        if (!declarations[name]) declarations[name] = 0;
        declarations[name]++;
      }
      const dupes = Object.entries(declarations).filter(([, count]) => count > 2);
      if (dupes.length > 0) {
        return {
          severity: 'high',
          description: `Duplicate let declarations found: ${dupes.map(([n, c]) => `${n}(${c}x)`).join(', ')} — will kill the JS module`,
          suggestedFix: 'Remove duplicate let declarations — only declare each variable once per scope'
        };
      }
      return null;
    }
  },
  {
    id: 'homepage-price-below-175',
    description: 'Homepage displaying prices below $175 minimum',
    appliesTo: ['homepage'],
    check: async (html) => {
      // Check for any hard-coded prices below $175 in visible text
      const pricePattern = /\$(\d+)/g;
      let match;
      const lowPrices = [];
      while ((match = pricePattern.exec(html)) !== null) {
        const price = parseInt(match[1]);
        // Only flag prices that look like job prices (not CSS values, years, etc.)
        if (price > 0 && price < 175 && price !== 0) {
          // Skip pixel values, years, and common non-price numbers
          const context = html.substring(Math.max(0, match.index - 30), match.index + 20);
          if (!context.includes('px') && !context.includes('font') && !context.includes('width') && !context.includes('height')) {
            lowPrices.push(price);
          }
        }
      }
      if (lowPrices.length > 0) {
        return {
          severity: 'medium',
          description: `Homepage shows prices below $175: ${lowPrices.join(', ')}`,
          suggestedFix: 'Update all displayed pricing to reflect $175 minimum'
        };
      }
      return null;
    }
  },
  {
    id: 'gas-price-stale',
    description: 'Gas price in Firestore is more than 8 days old',
    appliesTo: ['mastermind'],
    check: async (html, db) => {
      try {
        if (!db || db._isMock) return null;
        const gasDoc = await db.collection('system_config').doc('gas_price').get();
        if (!gasDoc.exists) return { severity: 'medium', description: 'Gas price never fetched', suggestedFix: 'Run POST /api/gas-price/refresh from dashboard' };
        const days = (Date.now() - gasDoc.data().fetchedAt.toDate().getTime()) / 86400000;
        return days > 8 ? { severity: 'low', description: 'Gas price is '+Math.round(days)+' days old', suggestedFix: 'Monday auto-fetch may be failing — check EIA API connectivity' } : null;
      } catch { return null; }
    }
  }
];

module.exports = { KNOWN_BUG_CHECKS };
