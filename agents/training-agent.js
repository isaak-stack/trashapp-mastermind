/**
 * agents/training-agent.js — Training AI Agent
 * Interval: 24 hours
 * Persona: Coach. Analytical, encouraging, specific.
 * Builds people up with data. Never vague.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');

class TrainingAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'training',
      agentName: 'Training',
      emoji: '🎯',
      color: '#1ABC9C',
      intervalMs: 24 * 60 * 60 * 1000, // 24 hours
      systemPrompt: `You are the Training AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: make every rep better by analyzing their actual data.
You are a coach — analytical, encouraging, and specific.
You never give vague advice. Every tip is backed by real numbers from their sessions.
You study what top performers do differently and teach it to everyone.
You generate personalized coaching tips that reference specific metrics.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Pull all rep sessions from last 30 days grouped by rep
    const repData = await this.pullRepData();

    // 2. Find top 3 performing sessions
    const topSessions = await this.findTopSessions();

    // 3. Read messages
    const messages = await this.readMessages({ limit: 10 });

    // 4. Think — generate coaching insights
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      REP PERFORMANCE DATA (30 days):
      ${JSON.stringify(repData, null, 2)}

      TOP PERFORMING SESSIONS:
      ${JSON.stringify(topSessions, null, 2)}

      As Training Coach, analyze and return JSON:
      {
        "teamOverview": {
          "avgCloseRate": number,
          "topCloseRate": number,
          "avgDoorsPerSession": number,
          "bestTimeOfDay": string,
          "bestZipCodes": [string]
        },
        "repCoachingTips": [
          {
            "repId": string,
            "repName": string,
            "metric": string,
            "tip": string,
            "comparedToTop": string
          }
        ],
        "weeklyTip": string,
        "bestPractices": [string],
        "summary": "2-3 sentence training summary"
      }
    `, { maxTokens: 2500 });

    if (!analysis || !analysis.summary) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete training analysis, skipping cycle');
      return;
    }

    // 5. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: analysis.bestPractices || [],
      recommendations: analysis.repCoachingTips?.map(t => `${t.repName}: ${t.tip}`) || [],
      metricsSnapshot: analysis.teamOverview || {}
    });

    // 6. Update training playbook
    if (analysis.teamOverview) {
      await db.collection('system_config').doc('training_playbook').set({
        updatedAt: new Date(),
        topCloseRate: analysis.teamOverview.topCloseRate,
        avgCloseRate: analysis.teamOverview.avgCloseRate,
        bestTimeOfDay: analysis.teamOverview.bestTimeOfDay,
        bestZipCodes: analysis.teamOverview.bestZipCodes || [],
        bestDoorScript: '',
        commonObjections: [],
        objectionResponses: {},
        weeklyTip: analysis.weeklyTip || '',
        bestPractices: analysis.bestPractices || []
      }, { merge: true });
    }

    // 7. Queue coaching tips for owner approval before sending to reps
    for (const tip of (analysis.repCoachingTips || [])) {
      await this.queueApproval(
        `Coaching tip for ${tip.repName}`,
        `${tip.tip}\n\nMetric: ${tip.metric}\nCompared to top: ${tip.comparedToTop}`,
        'Improves rep performance',
        { repId: tip.repId, tip: tip.tip }
      );
    }
  }

  // ── BOARDROOM THINK ────────────────────────────────────────────
  async boardroomThink(recentMessages) {
    const repData = await this.pullRepData();
    const msgContext = recentMessages.map(m => `[${m.from || m.agentId}]: ${m.message}`).join('\n');

    const avgClose = repData.length > 0
      ? (repData.reduce((sum, r) => sum + parseFloat(r.closeRate), 0) / repData.length).toFixed(1) + '%'
      : 'N/A';
    const topRep = repData.sort((a, b) => parseFloat(b.closeRate) - parseFloat(a.closeRate))[0];

    const prompt = `You are the Training Coach at TrashApp Junk Removal. Analytical, encouraging, specific.

TRAINING DATA: Team avg close rate ${avgClose}. ${repData.length} reps tracked.
${topRep ? `Top performer: ${topRep.repName} at ${topRep.closeRate}, ${topRep.avgDoorsPerSession} doors/session.` : 'No session data yet.'}

RECENT BOARDROOM MESSAGES:
${msgContext}

Share a coaching insight or react to discussion. Reference specific metrics when possible. 1-2 sentences. Sign off with "— Training". If nothing to add, respond with exactly "null".`;

    const response = await this.think(prompt, { maxTokens: 200 });
    if (!response || response.trim().toLowerCase() === 'null') return null;
    return response.trim();
  }

  async pullRepData() {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      const sessionsSnap = await db.collection('rep_sessions')
        .where('startedAt', '>', thirtyDaysAgo.toISOString())
        .get();

      const repData = {};
      sessionsSnap.docs.forEach(doc => {
        const s = doc.data();
        const repId = s.repId || 'unknown';
        if (!repData[repId]) {
          repData[repId] = {
            repId,
            repName: s.repName || 'Unknown',
            sessions: [],
            totalDoors: 0,
            totalQuotes: 0,
            totalBooked: 0,
            totalCommission: 0,
            zips: {},
            timeOfDay: { morning: 0, afternoon: 0, evening: 0 }
          };
        }

        repData[repId].sessions.push({
          date: s.startedAt,
          doors: s.doorsKnocked || 0,
          quotes: s.quotesGiven || 0,
          booked: s.jobsBooked || 0,
          zip: s.zipCode || s.zip
        });

        repData[repId].totalDoors += s.doorsKnocked || 0;
        repData[repId].totalQuotes += s.quotesGiven || 0;
        repData[repId].totalBooked += s.jobsBooked || 0;
        repData[repId].totalCommission += s.commissionEarned || 0;

        const zip = s.zipCode || s.zip || 'unknown';
        if (!repData[repId].zips[zip]) repData[repId].zips[zip] = { doors: 0, booked: 0 };
        repData[repId].zips[zip].doors += s.doorsKnocked || 0;
        repData[repId].zips[zip].booked += s.jobsBooked || 0;

        // Track time of day
        const hour = s.startedAt ? new Date(s.startedAt).getHours() : 12;
        if (hour < 12) repData[repId].timeOfDay.morning++;
        else if (hour < 17) repData[repId].timeOfDay.afternoon++;
        else repData[repId].timeOfDay.evening++;
      });

      // Calculate close rates
      return Object.values(repData).map(rep => ({
        ...rep,
        closeRate: rep.totalQuotes > 0 ? ((rep.totalBooked / rep.totalQuotes) * 100).toFixed(1) + '%' : '0%',
        avgDoorsPerSession: rep.sessions.length > 0 ? Math.round(rep.totalDoors / rep.sessions.length) : 0,
        sessionCount: rep.sessions.length,
        bestZip: Object.entries(rep.zips).sort((a, b) => b[1].booked - a[1].booked)[0]?.[0] || 'unknown',
        sessions: rep.sessions.slice(-5) // last 5 only for Claude context
      }));
    } catch { return []; }
  }

  async findTopSessions() {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const snap = await db.collection('rep_sessions')
        .where('startedAt', '>', weekAgo.toISOString())
        .get();

      const sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return sessions
        .filter(s => s.quotesGiven > 0)
        .sort((a, b) => {
          const rateA = a.jobsBooked / a.quotesGiven;
          const rateB = b.jobsBooked / b.quotesGiven;
          return rateB - rateA;
        })
        .slice(0, 3)
        .map(s => ({
          repName: s.repName || 'Unknown',
          doors: s.doorsKnocked,
          quotes: s.quotesGiven,
          booked: s.jobsBooked,
          closeRate: ((s.jobsBooked / s.quotesGiven) * 100).toFixed(0) + '%',
          zip: s.zipCode || s.zip,
          date: s.startedAt
        }));
    } catch { return []; }
  }

  async meetingTurn(weekId, context) {
    const repData = await this.pullRepData();
    const avgClose = repData.length > 0
      ? (repData.reduce((sum, r) => sum + parseFloat(r.closeRate), 0) / repData.length).toFixed(1) + '%'
      : 'N/A';
    const topRep = repData.sort((a, b) => parseFloat(b.closeRate) - parseFloat(a.closeRate))[0];

    await this.sendMeetingMessage(weekId,
      `Training update: Team avg close rate ${avgClose}.\n` +
      `${topRep ? `Top performer: ${topRep.repName} at ${topRep.closeRate} close rate, ${topRep.avgDoorsPerSession} doors/session.` : 'No session data yet.'}\n` +
      `Personalized coaching tips queued for each rep pending approval.`,
      { avgCloseRate: avgClose }
    );
  }
}

module.exports = TrainingAgent;
