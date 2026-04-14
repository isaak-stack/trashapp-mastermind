/**
 * dispatch/territory-engine.js — Territory assignment engine
 * Runs Sunday 10pm. Pulls rep profiles, session histories, and ZIP intel,
 * then uses Claude API to generate optimal weekly territory assignments.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const { sendSMS } = require('../core/twilio');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '+15597744249';

const CLAUDE_AVAILABLE = !!ANTHROPIC_API_KEY;

if (CLAUDE_AVAILABLE) {
  console.log('✓ Claude API configured — territory engine will use AI optimization');
} else {
  console.log('ℹ Territory engine using simple assignment — add ANTHROPIC_API_KEY for AI optimization');
}

/**
 * Run territory assignment engine.
 * Called Sunday 10pm (22:00) Los Angeles time.
 */
async function runTerritoryEngine() {
  if (db._isMock) {
    await logger.log('territory-engine', 'SUCCESS', 'Mock mode — skipping engine run', { icon: '🗺️' });
    return;
  }

  try {
    await logger.log('territory-engine', 'SUCCESS', 'Starting territory assignment engine...', { icon: '🗺️' });

    // Get this week's ID (YYYY-Wnn format)
    const weekId = getWeekId();

    // 1. Fetch all approved reps
    const repsSnap = await db.collection('reps').where('status', '==', 'approved').get();
    if (repsSnap.empty) {
      await logger.partial('territory-engine', 'No approved reps found', { icon: '⚠️' });
      return;
    }

    const reps = repsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // 2. Compute close_rate_by_zip for each rep (last 30 days)
    const repProfiles = [];
    for (const rep of reps) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const sessionsSnap = await db.collection('rep_sessions')
        .where('repId', '==', rep.id)
        .where('timestamp', '>=', thirtyDaysAgo)
        .get();

      const zipStats = {};
      sessionsSnap.docs.forEach((doc) => {
        const session = doc.data();
        const zip = session.zipCode || session.zip || rep.zip || 'unknown';
        if (!zipStats[zip]) zipStats[zip] = { closes: 0, attempts: 0 };
        zipStats[zip].attempts++;
        if (session.status === 'deal_closed' || session.status === 'closed') {
          zipStats[zip].closes++;
        }
      });

      repProfiles.push({
        repId: rep.id,
        name: rep.name || 'Unknown',
        phone: rep.phone,
        homeZip: rep.zip || 'unknown',
        closeRateByZip: zipStats,
        experience: rep.experience || 0,
      });
    }

    // 3. Fetch current week_scores from zip_intel
    const intelSnap = await db.collection('zip_intel').get();
    const zipIntel = {};
    intelSnap.docs.forEach((doc) => {
      const data = doc.data();
      zipIntel[data.zipCode] = {
        weekScore: data.weekScore || 50,
        rainDays: data.rainDays || 0,
        topSignal: data.topSignal || null,
      };
    });

    // 4. Generate assignments (with Claude if available, else simple fallback)
    let assignments;
    if (CLAUDE_AVAILABLE) {
      try {
        assignments = await callClaudeAssigner(repProfiles, zipIntel);
      } catch (err) {
        await logger.partial('territory-engine', `Claude API failed: ${err.message} — using fallback`, {
          error: err.message,
        });
        assignments = generateFallbackAssignments(repProfiles, zipIntel);
      }
    } else {
      assignments = generateFallbackAssignments(repProfiles, zipIntel);
    }

    // 5. Write assignments to Firestore
    await db.collection('territory_assignments').doc(weekId).set(
      {
        weekId,
        createdAt: new Date().toISOString(),
        assignments,
        status: 'pending_approval',
        approvedAt: null,
      },
      { merge: true }
    );

    await logger.success('territory-engine', `Territory assignments created for week ${weekId}`, {
      repCount: repProfiles.length,
      assignmentCount: assignments.length,
      icon: '🗺️',
    });

    // 6. Send admin notification SMS
    const summary = assignments
      .slice(0, 5)
      .map((a) => `${a.repName}: ${a.primaryZip}/${a.secondaryZip}`)
      .join(' | ');
    await sendSMS(
      ADMIN_PHONE,
      `Territory assignments ready for week ${weekId}: ${summary}... Review and approve at dashboard.`
    );
  } catch (err) {
    await logger.error('territory-engine', `Engine error: ${err.message}`, { error: err.message });
  }
}

/**
 * Send Monday 7am briefing SMS to all reps.
 * Reads this week's territory_assignments and sends personalized SMS.
 */
async function sendBriefingSMS() {
  if (db._isMock) return;

  try {
    const weekId = getWeekId();

    const assignmentDoc = await db.collection('territory_assignments').doc(weekId).get();
    if (!assignmentDoc.exists) {
      await logger.partial('territory-engine', `No assignments found for week ${weekId}`, { icon: '⚠️' });
      return;
    }

    const data = assignmentDoc.data();
    const assignments = data.assignments || [];

    let sentCount = 0;
    for (const assignment of assignments) {
      if (!assignment.repPhone) continue;

      const msg = buildBriefingSMS(assignment);
      try {
        await sendSMS(assignment.repPhone, msg);
        sentCount++;
      } catch (err) {
        await logger.partial('territory-engine', `Failed to send briefing to ${assignment.repName}`, {
          error: err.message,
        });
      }
    }

    await logger.success('territory-engine', `Monday briefing SMS sent to ${sentCount} reps`, {
      repCount: sentCount,
      icon: '📱',
    });
  } catch (err) {
    await logger.error('territory-engine', `Briefing SMS error: ${err.message}`, { error: err.message });
  }
}

/**
 * Build a personalized briefing SMS for a rep.
 */
function buildBriefingSMS(assignment) {
  const name = (assignment.repName || 'there').split(' ')[0];
  const primary = assignment.primaryZip || 'your zone';
  const secondary = assignment.secondaryZip || 'backup zone';
  const topSignal = assignment.topSignal ? ` Hot lead: ${assignment.topSignal}` : '';
  const tip = assignment.strategyTip ? ` ${assignment.strategyTip}` : '';

  return `Good morning ${name}! Your zones this week: Primary ${primary}, Secondary ${secondary}. Week score: ${assignment.primaryScore}/100.${topSignal}${tip} Go crush it! 💪`;
}

/**
 * Call Claude API to optimize territory assignments.
 */
async function callClaudeAssigner(repProfiles, zipIntel) {
  try {
    const repJson = JSON.stringify(repProfiles.slice(0, 20));
    const intelJson = JSON.stringify(
      Object.entries(zipIntel)
        .slice(0, 25)
        .map(([zip, data]) => ({ zip, ...data }))
    );

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1-20250805',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: `You are a field sales territory optimization AI for a Fresno junk removal company.

Rep profiles (30-day history): ${repJson}

ZIP code intelligence (weekly scores): ${intelJson}

Assign each rep to a primary ZIP and secondary ZIP for this week. Return ONLY valid JSON (no markdown):
[
  {
    "repId": "rep-id",
    "repName": "Full Name",
    "repPhone": "+15551234567",
    "primaryZip": "93650",
    "secondaryZip": "93651",
    "primaryScore": 85,
    "secondaryScore": 72,
    "strategyTip": "Focus on the estate sales this week",
    "topSignal": "Estate sale on Oak Ave"
  }
]

Optimize for: high close rates, rep experience, signal strength, and territory coverage. Keep zones geographically sensible.`,
          },
        ],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';
    const clean = text.replace(/```json|```/g, '').trim();
    const assignments = JSON.parse(clean);

    return assignments.map((a) => ({
      repId: a.repId,
      repName: a.repName,
      repPhone: a.repPhone,
      primaryZip: a.primaryZip,
      secondaryZip: a.secondaryZip,
      primaryScore: a.primaryScore || 50,
      secondaryScore: a.secondaryScore || 40,
      strategyTip: a.strategyTip || '',
      topSignal: a.topSignal || '',
    }));
  } catch (err) {
    console.error('Claude assigner error:', err.message);
    throw err;
  }
}

/**
 * Fallback: simple assignment logic when Claude is unavailable.
 * Each rep gets their home ZIP as primary, highest-scoring neighbor as secondary.
 */
function generateFallbackAssignments(repProfiles, zipIntel) {
  const allZips = Object.keys(zipIntel);
  const fresnoZips = allZips.filter((z) => z.startsWith('9365'));

  return repProfiles.map((rep) => {
    const primaryZip = rep.homeZip || fresnoZips[0] || '93650';
    const primaryScore = zipIntel[primaryZip]?.weekScore || 50;

    // Find second-best ZIP not assigned to another rep
    const otherZips = fresnoZips.filter((z) => z !== primaryZip);
    const secondaryZip = otherZips.sort((a, b) => (zipIntel[b]?.weekScore || 0) - (zipIntel[a]?.weekScore || 0))[0] || '93651';
    const secondaryScore = zipIntel[secondaryZip]?.weekScore || 40;

    return {
      repId: rep.repId,
      repName: rep.name,
      repPhone: rep.phone,
      primaryZip,
      secondaryZip,
      primaryScore,
      secondaryScore,
      strategyTip: primaryScore > 70 ? 'Strong signals this week — push hard!' : 'Moderate activity — steady work.',
      topSignal: zipIntel[primaryZip]?.topSignal || '',
    };
  });
}

/**
 * Get week ID in YYYY-Wnn format.
 */
function getWeekId() {
  const now = new Date();
  const year = now.getFullYear();
  const firstDayOfYear = new Date(year, 0, 1);
  const days = Math.floor((now - firstDayOfYear) / 86400000);
  const week = Math.ceil((days + firstDayOfYear.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

module.exports = { runTerritoryEngine, sendBriefingSMS };
