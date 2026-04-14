/**
 * maintenance/bug-scanner.js — Nightly Platform Bug Scanner
 * Fetches all four live sites and runs automated checks.
 * Runs as part of the 3am maintenance window after error log analysis.
 *
 * Three check categories:
 *   1. Static code checks (fetch HTML, run regex/pattern checks)
 *   2. Behavioral checks (Firestore queries for data anomalies)
 *   3. API checks (Railway quote API health + pricing)
 *
 * Returns a structured bug report and writes to Firestore bug_reports collection.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { KNOWN_BUG_CHECKS } = require('./known-bugs');

// ─── Site Configuration ─────────────────────────────────────
const SITES = [
  {
    key: 'rep-platform',
    name: 'Rep Platform',
    url: 'https://reps.trashappjunkremoval.com',
    requiresAuth: true,
    requiresFirebase: true,
  },
  {
    key: 'admin',
    name: 'Admin Console',
    url: 'https://admin.trashappjunkremoval.com',
    requiresAuth: true,
    requiresFirebase: true,
  },
  {
    key: 'quote',
    name: 'Quote Page',
    url: 'https://quote.trashappjunkremoval.com',
    requiresAuth: false,
    requiresFirebase: false,
  },
  {
    key: 'homepage',
    name: 'Homepage',
    url: 'https://trashappjunkremoval.com',
    requiresAuth: false,
    requiresFirebase: false,
  },
];

const RAILWAY_QUOTE_API = process.env.RAILWAY_QUOTE_API || 'https://junk-quote-api-production.up.railway.app/api/quote';

// Central Valley bounding box
const GEO_BOUNDS = { latMin: 36.0, latMax: 37.5, lngMin: -120.5, lngMax: -118.5 };

/**
 * Main entry point — runs all bug scan categories.
 * @returns {Object} Bug scan report
 */
async function runBugScan() {
  const startTime = Date.now();
  const bugsFound = [];

  // ── 1. Static Code Checks ──────────────────────────────
  for (const site of SITES) {
    try {
      const html = await fetchSiteHTML(site.url);
      if (!html) {
        bugsFound.push({
          severity: 'high',
          site: site.key,
          description: `${site.name} returned no HTML — site may be down`,
          detail: `GET ${site.url} returned empty or failed`,
          firstDetected: new Date(),
          recurrenceCount: 1,
          suggestedFix: 'Check Netlify deployment status and DNS configuration',
        });
        continue;
      }

      // Run standard static checks
      const staticBugs = await runStaticChecks(site, html);
      bugsFound.push(...staticBugs);

      // Run known bug registry checks
      const knownBugs = await runKnownBugChecks(site, html);
      bugsFound.push(...knownBugs);

    } catch (err) {
      bugsFound.push({
        severity: 'high',
        site: site.key,
        description: `Failed to fetch ${site.name}: ${err.message}`,
        detail: err.stack || err.message,
        firstDetected: new Date(),
        recurrenceCount: 1,
        suggestedFix: 'Check if site is accessible and DNS is resolving',
      });
    }
  }

  // ── 2. Behavioral Checks (Firestore) ──────────────────
  if (!db._isMock) {
    try {
      const firestoreBugs = await runFirestoreChecks();
      bugsFound.push(...firestoreBugs);
    } catch (err) {
      await logger.error('bug-scanner', `Firestore checks failed: ${err.message}`);
    }
  }

  // ── 3. API Checks ─────────────────────────────────────
  try {
    const apiBugs = await runAPIChecks();
    bugsFound.push(...apiBugs);
  } catch (err) {
    bugsFound.push({
      severity: 'medium',
      site: 'api',
      description: `API check failed: ${err.message}`,
      detail: err.stack || err.message,
      firstDetected: new Date(),
      recurrenceCount: 1,
      suggestedFix: 'Check Railway deployment and API health endpoint',
    });
  }

  // ── Build report ──────────────────────────────────────
  const report = {
    timestamp: new Date(),
    scanDurationMs: Date.now() - startTime,
    sitesChecked: SITES.length,
    bugsFound,
    allClear: bugsFound.length === 0,
  };

  // ── Write to Firestore with recurrence tracking ───────
  if (!db._isMock) {
    await writeReportWithRecurrence(report);
  }

  return report;
}

// ═══════════════════════════════════════════════════════════
// STATIC CODE CHECKS
// ═══════════════════════════════════════════════════════════

async function runStaticChecks(site, html) {
  const bugs = [];

  // Check 1: <script type="module"> present and not malformed
  if (site.requiresFirebase) {
    const hasModule = html.includes('<script type="module">') || html.includes("<script type='module'>");
    if (!hasModule) {
      bugs.push(makeBug('high', site.key,
        `${site.name}: No <script type="module"> found — Firebase imports will fail`,
        'Missing module script tag',
        'Add <script type="module"> block with Firebase SDK imports'
      ));
    }
  }

  // Check 2: Firebase import lines present
  if (site.requiresFirebase) {
    const hasFirebaseImport = html.includes("from 'https://www.gstatic.com/firebasejs") ||
                              html.includes('from "https://www.gstatic.com/firebasejs');
    if (!hasFirebaseImport) {
      bugs.push(makeBug('high', site.key,
        `${site.name}: Firebase SDK imports missing`,
        'No import from gstatic.com/firebasejs found',
        'Add Firebase SDK CDN imports in the module script'
      ));
    }
  }

  // Check 3: auth-screen element exists (login gate)
  if (site.requiresAuth) {
    if (!html.includes('auth-screen')) {
      bugs.push(makeBug('high', site.key,
        `${site.name}: auth-screen element missing — no login gate`,
        'id="auth-screen" not found in HTML',
        'Add the auth-screen div with phone login form'
      ));
    }
  }

  // Check 4: recaptcha-container on auth-required pages
  if (site.requiresAuth) {
    if (!html.includes('recaptcha-container')) {
      bugs.push(makeBug('high', site.key,
        `${site.name}: recaptcha-container missing — Firebase phone auth will fail`,
        'id="recaptcha-container" not found in HTML',
        'Add <div id="recaptcha-container"></div> for Firebase invisible reCAPTCHA'
      ));
    }
  }

  // Check 5: onclick handlers reference functions that aren't on window or globally defined
  const onclickBugs = checkOnclickHandlers(site, html);
  bugs.push(...onclickBugs);

  // Check 6: getElementById calls reference IDs that exist in HTML
  const idBugs = checkElementIds(site, html);
  bugs.push(...idBugs);

  // Check 7: Homepage pricing never below $175
  if (site.key === 'homepage') {
    const priceBugs = checkHomepagePricing(html);
    bugs.push(...priceBugs);
  }

  // Check 8: Quote page has enforceMinimumPrice
  if (site.key === 'quote') {
    if (!html.includes('enforceMinimumPrice')) {
      bugs.push(makeBug('medium', site.key,
        'Quote page missing enforceMinimumPrice function',
        'The string "enforceMinimumPrice" was not found in the HTML',
        'Add enforceMinimumPrice() and call it on all quote response paths'
      ));
    }
  }

  return bugs;
}

/**
 * Check that onclick handlers reference functions available on window or defined globally.
 */
function checkOnclickHandlers(site, html) {
  const bugs = [];
  const onclickPattern = /onclick="([^"]+)"/g;
  let match;

  // Collect all function names called in onclick handlers
  const calledFunctions = new Set();
  while ((match = onclickPattern.exec(html)) !== null) {
    const handler = match[1];
    // Extract function name (before the open paren)
    const fnMatch = handler.match(/^(\w+)\s*\(/);
    if (fnMatch) calledFunctions.add(fnMatch[1]);
  }

  // Also check onclick='...' (single quotes)
  const onclickPatternSQ = /onclick='([^']+)'/g;
  while ((match = onclickPatternSQ.exec(html)) !== null) {
    const handler = match[1];
    const fnMatch = handler.match(/^(\w+)\s*\(/);
    if (fnMatch) calledFunctions.add(fnMatch[1]);
  }

  // Check each called function has a definition
  const undefinedFns = [];
  for (const fn of calledFunctions) {
    // Skip built-in/common functions
    if (['event', 'this', 'alert', 'confirm', 'prompt', 'history', 'location', 'console'].includes(fn)) continue;

    const hasWindowExport = html.includes(`window.${fn}`) || html.includes(`window['${fn}']`) || html.includes(`window["${fn}"]`);
    const hasFunctionDef = html.includes(`function ${fn}(`) || html.includes(`function ${fn} (`);
    const hasConstDef = new RegExp(`(const|let|var)\\s+${fn}\\s*=`).test(html);

    if (!hasWindowExport && !hasFunctionDef && !hasConstDef) {
      undefinedFns.push(fn);
    }
  }

  if (undefinedFns.length > 0) {
    bugs.push(makeBug('high', site.key,
      `${site.name}: ${undefinedFns.length} onclick handler(s) call undefined functions: ${undefinedFns.slice(0, 5).join(', ')}`,
      `Functions called in onclick but not defined or exported to window: ${undefinedFns.join(', ')}`,
      'Add window.fnName = fnName exports for each function, or define them outside of module scope'
    ));
  }

  return bugs;
}

/**
 * Check that getElementById calls reference IDs that actually exist in the HTML.
 */
function checkElementIds(site, html) {
  const bugs = [];

  // Extract all getElementById calls
  const getByIdPattern = /getElementById\(['"]([^'"]+)['"]\)/g;
  const referencedIds = new Set();
  let match;
  while ((match = getByIdPattern.exec(html)) !== null) {
    referencedIds.add(match[1]);
  }

  // Extract all id= attributes in HTML
  const idAttrPattern = /\bid=["']([^"']+)["']/g;
  const definedIds = new Set();
  while ((match = idAttrPattern.exec(html)) !== null) {
    definedIds.add(match[1]);
  }

  // Find missing IDs (referenced but not defined)
  const missingIds = [];
  for (const id of referencedIds) {
    if (!definedIds.has(id)) {
      // Skip dynamically created IDs (patterns like 'evd-' + i, 'price-' + item.id)
      const isDynamic = /^(evd|price|col|count|panel)-/.test(id) || id.includes('${');
      if (!isDynamic) {
        missingIds.push(id);
      }
    }
  }

  if (missingIds.length > 0) {
    bugs.push(makeBug('medium', site.key,
      `${site.name}: ${missingIds.length} getElementById call(s) reference missing IDs: ${missingIds.slice(0, 5).join(', ')}`,
      `IDs referenced in JS but not found in HTML: ${missingIds.join(', ')}`,
      'Add missing HTML elements with the correct id attributes, or remove dead getElementById calls'
    ));
  }

  return bugs;
}

/**
 * Check homepage doesn't display pricing below $175.
 */
function checkHomepagePricing(html) {
  const bugs = [];
  const pricePattern = /\$(\d+)/g;
  let match;

  while ((match = pricePattern.exec(html)) !== null) {
    const price = parseInt(match[1]);
    // Only flag prices that look like service prices ($50-$174 range)
    if (price >= 25 && price < 175) {
      const context = html.substring(Math.max(0, match.index - 50), Math.min(html.length, match.index + 50));
      // Skip CSS, font-size, and other non-price contexts
      if (context.includes('px') || context.includes('font') || context.includes('width') ||
          context.includes('height') || context.includes('margin') || context.includes('padding') ||
          context.includes('size') || context.includes('opacity') || context.includes('rgba')) {
        continue;
      }
      bugs.push(makeBug('medium', 'homepage',
        `Homepage shows price $${price} which is below the $175 minimum`,
        `Found "$${price}" in context: ...${context.trim().replace(/\s+/g, ' ')}...`,
        'Update all displayed pricing to reflect the $175 minimum job price'
      ));
      break; // Only flag once
    }
  }

  return bugs;
}

// ═══════════════════════════════════════════════════════════
// KNOWN BUG REGISTRY CHECKS
// ═══════════════════════════════════════════════════════════

async function runKnownBugChecks(site, html) {
  const bugs = [];

  for (const knownBug of KNOWN_BUG_CHECKS) {
    // Only run checks that apply to this site
    if (knownBug.appliesTo && !knownBug.appliesTo.includes(site.key)) continue;

    try {
      const result = await knownBug.check(html);
      if (result) {
        bugs.push({
          severity: result.severity,
          site: site.key,
          description: result.description,
          detail: `Known bug "${knownBug.id}" detected on ${site.name}`,
          firstDetected: new Date(),
          recurrenceCount: 1,
          suggestedFix: result.suggestedFix,
          knownBugId: knownBug.id,
        });
      }
    } catch (err) {
      await logger.error('bug-scanner', `Known bug check "${knownBug.id}" failed: ${err.message}`);
    }
  }

  return bugs;
}

// ═══════════════════════════════════════════════════════════
// BEHAVIORAL CHECKS (Firestore)
// ═══════════════════════════════════════════════════════════

async function runFirestoreChecks() {
  const bugs = [];

  // Check 1: Jobs stuck in same status >48 hours
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const activeStatuses = ['QUOTED', 'QUOTE_SENT', 'CONFIRMED', 'AWAITING_PAYMENT', 'SCHEDULED', 'IN_PROGRESS'];
  for (const status of activeStatuses) {
    try {
      const snap = await db.collection('jobs').where('status', '==', status).get();
      const stuckJobs = snap.docs.filter(doc => {
        const data = doc.data();
        const lastUpdate = data.updated_at || data.created_at;
        return lastUpdate && lastUpdate < twoDaysAgo;
      });
      for (const doc of stuckJobs) {
        const data = doc.data();
        bugs.push(makeBug('medium', 'firestore',
          `Job stuck in ${status} for 48+ hours: ${data.customer_name || doc.id} at ${data.address || 'unknown'}`,
          `Job ${doc.id} last updated: ${data.updated_at || data.created_at}`,
          `Review job and either advance to next status or cancel`
        ));
      }
    } catch (err) {
      // Firestore query may fail if index not ready — log but don't crash
      await logger.error('bug-scanner', `Stuck job check for ${status} failed: ${err.message}`);
    }
  }

  // Check 2: Commission log with no matching job document
  try {
    const commSnap = await db.collection('commission_log').get();
    for (const doc of commSnap.docs) {
      const jobId = doc.data().job_id;
      if (jobId) {
        const jobDoc = await db.collection('jobs').doc(jobId).get();
        if (!jobDoc.exists) {
          bugs.push(makeBug('medium', 'firestore',
            `Orphaned commission log: ${doc.id} references non-existent job ${jobId}`,
            `Commission amount: $${doc.data().commission_amount || '?'}, rep: ${doc.data().rep_name || 'unknown'}`,
            'Verify the commission is legitimate and link to the correct job, or remove the orphaned entry'
          ));
        }
      }
    }
  } catch (err) {
    await logger.error('bug-scanner', `Commission check failed: ${err.message}`);
  }

  // Check 3: Zombie live_rep sessions (sessionActive true, lastUpdate >12h)
  try {
    const liveSnap = await db.collection('live_reps').where('sessionActive', '==', true).get();
    const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    for (const doc of liveSnap.docs) {
      const data = doc.data();
      const lastUpdate = data.lastUpdate || data.updated_at || data.timestamp;
      if (lastUpdate && lastUpdate < twelveHoursAgo) {
        bugs.push(makeBug('low', 'firestore',
          `Zombie rep session: ${data.name || doc.id} shows active but last update was ${lastUpdate}`,
          `live_reps/${doc.id} — sessionActive=true but stale for 12+ hours`,
          'Auto-close the session by setting sessionActive=false'
        ));
      }
    }
  } catch (err) {
    await logger.error('bug-scanner', `Zombie session check failed: ${err.message}`);
  }

  // Check 4: Doors logged outside Central Valley bounding box
  try {
    const recentDoors = await db.collection('doors')
      .where('timestamp', '>=', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .get();

    const outOfBounds = recentDoors.docs.filter(doc => {
      const data = doc.data();
      if (!data.lat || !data.lng) return false;
      return data.lat < GEO_BOUNDS.latMin || data.lat > GEO_BOUNDS.latMax ||
             data.lng < GEO_BOUNDS.lngMin || data.lng > GEO_BOUNDS.lngMax;
    });

    if (outOfBounds.length > 0) {
      bugs.push(makeBug('low', 'firestore',
        `${outOfBounds.length} door(s) logged outside Central Valley service area in last 24h`,
        `Out-of-bounds coordinates: ${outOfBounds.slice(0, 3).map(d => `(${d.data().lat}, ${d.data().lng})`).join(', ')}`,
        'Check if reps are GPS-spoofing or accidentally logging doors from wrong locations'
      ));
    }
  } catch (err) {
    await logger.error('bug-scanner', `Geo bounds check failed: ${err.message}`);
  }

  return bugs;
}

// ═══════════════════════════════════════════════════════════
// API CHECKS
// ═══════════════════════════════════════════════════════════

async function runAPIChecks() {
  const bugs = [];

  // Test Railway quote API with a sample image
  try {
    const startTime = Date.now();

    // POST a minimal test payload — the API expects form data with an image
    // We send a small test to verify the endpoint responds correctly
    const testPayload = JSON.stringify({
      test: true,
      image_url: 'https://via.placeholder.com/400x300.jpg?text=BugScanTest',
      description: 'Bug scanner test — 2 bags of yard waste, a broken chair, and some cardboard boxes',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(RAILWAY_QUOTE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: testPayload,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      bugs.push(makeBug('high', 'api',
        `Railway Quote API returned HTTP ${response.status}`,
        `POST ${RAILWAY_QUOTE_API} → ${response.status} ${response.statusText} (${elapsed}ms)`,
        'Check Railway deployment logs and API configuration'
      ));
    } else {
      const data = await response.json();

      // Verify response contains priceRange
      if (!data.priceRange) {
        bugs.push(makeBug('medium', 'api',
          'Railway Quote API response missing priceRange field',
          `Response keys: ${Object.keys(data).join(', ')}`,
          'Check quote API response format — priceRange should be a string like "$175–$300"'
        ));
      } else {
        // Verify low end is >= 175
        const lowMatch = data.priceRange.match(/\$?(\d+)/);
        if (lowMatch) {
          const lowPrice = parseInt(lowMatch[1]);
          if (lowPrice < 175) {
            bugs.push(makeBug('high', 'api',
              `Railway Quote API returned price below $175 minimum: ${data.priceRange}`,
              `Low end: $${lowPrice}, full range: ${data.priceRange}`,
              'Update quote API pricing logic to enforce $175 floor on all estimates'
            ));
          }
        }
      }

      // Verify response time < 5 seconds
      if (elapsed > 5000) {
        bugs.push(makeBug('medium', 'api',
          `Railway Quote API response time ${elapsed}ms exceeds 5-second target`,
          `POST ${RAILWAY_QUOTE_API} → ${elapsed}ms`,
          'Check Railway instance size and cold-start behavior — may need to upgrade plan'
        ));
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      bugs.push(makeBug('high', 'api',
        'Railway Quote API timed out after 10 seconds',
        `POST ${RAILWAY_QUOTE_API} — request aborted`,
        'Check if Railway instance is sleeping or needs a plan upgrade'
      ));
    } else {
      bugs.push(makeBug('high', 'api',
        `Railway Quote API unreachable: ${err.message}`,
        err.stack || err.message,
        'Check Railway deployment status and DNS configuration'
      ));
    }
  }

  return bugs;
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

/**
 * Fetch HTML from a site URL with timeout.
 */
async function fetchSiteHTML(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TrashApp-BugScanner/1.0' },
    });
    clearTimeout(timeout);

    if (!response.ok) return null;
    return await response.text();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

/**
 * Create a standardized bug object.
 */
function makeBug(severity, site, description, detail, suggestedFix) {
  return {
    severity,
    site,
    description,
    detail,
    firstDetected: new Date(),
    recurrenceCount: 1,
    suggestedFix,
  };
}

/**
 * Write bug report to Firestore with recurrence tracking.
 * If the same bug (matched by description) already exists from the last 7 days,
 * increment recurrenceCount instead of creating a new document.
 */
async function writeReportWithRecurrence(report) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch recent bug reports
  let recentBugs = [];
  try {
    const recentSnap = await db.collection('bug_reports')
      .where('timestamp', '>=', sevenDaysAgo)
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();
    recentBugs = recentSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    // Index may not exist yet — that's fine, just write fresh
    await logger.partial('bug-scanner', `Could not query recent bugs (index may be building): ${err.message}`);
  }

  // Build a lookup of recent bug descriptions → doc ID
  const recentByDescription = {};
  for (const rb of recentBugs) {
    if (rb.bugsFound) {
      // Report-level documents
      for (const bug of rb.bugsFound) {
        if (bug.description) {
          recentByDescription[bug.description] = { docId: rb.id, bug };
        }
      }
    }
  }

  // Update recurrence counts on current bugs
  for (const bug of report.bugsFound) {
    const existing = recentByDescription[bug.description];
    if (existing) {
      bug.recurrenceCount = (existing.bug.recurrenceCount || 1) + 1;
      bug.firstDetected = existing.bug.firstDetected || bug.firstDetected;
    }
  }

  // Write the report
  await db.collection('bug_reports').add({
    ...report,
    timestamp: new Date().toISOString(),
    bugsFound: report.bugsFound.map(b => ({
      ...b,
      firstDetected: b.firstDetected instanceof Date ? b.firstDetected.toISOString() : b.firstDetected,
    })),
  });
}

module.exports = { runBugScan };
