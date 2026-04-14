/**
 * agents/operations-agent.js — Operations AI Agent
 * Interval: 2 hours
 * Persona: Detail-oriented, process-driven. Focused on execution quality
 * and efficiency. Flags problems early.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');

class OperationsAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'operations',
      agentName: 'Operations',
      emoji: '⚙️',
      color: '#E67E22',
      intervalMs: 2 * 60 * 60 * 1000, // 2 hours
      systemPrompt: `You are the Operations AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: make sure every job runs smoothly and nothing falls through the cracks.
You are detail-oriented, process-driven, and focused on execution quality.
You flag problems early — before they become customer complaints.
You think about slot utilization, crew efficiency, and process bottlenecks.
You never ignore a stale job or missed update.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Check for stale jobs (2+ hours past slot, no status update)
    const staleJobs = await this.checkStaleJobs();

    // 2. Calculate slot utilization for next 7 days
    const slotUtil = await this.checkSlotUtilization();

    // 3. Check for stale manual reviews
    const staleReviews = await this.checkStaleManualReviews();

    // 4. Monitor rep session activity (weekdays only)
    const repActivity = await this.checkRepActivity();

    // 5. Check bug reports
    const bugStatus = await this.checkBugReports();

    // 6. Calculate avg job completion time
    const completionTime = await this.calcAvgCompletionTime();

    // 7. Read messages
    const messages = await this.readMessages({ limit: 10 });

    // 8. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}
      Day: ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()]}

      STALE JOBS (2+ hrs past slot, no update):
      ${JSON.stringify(staleJobs, null, 2)}

      SLOT UTILIZATION (next 7 days):
      ${JSON.stringify(slotUtil, null, 2)}

      STALE MANUAL REVIEWS (>2 hrs pending):
      ${JSON.stringify(staleReviews, null, 2)}

      REP ACTIVITY TODAY:
      ${JSON.stringify(repActivity, null, 2)}

      BUG STATUS:
      ${JSON.stringify(bugStatus, null, 2)}

      AVG COMPLETION TIME: ${completionTime}

      MESSAGES:
      ${JSON.stringify(messages.slice(0,5), null, 2)}

      As Operations, analyze and return JSON:
      {
        "operationalHealth": "green|yellow|red",
        "issues": [{ "severity": "low|medium|high", "description": string, "action": string }],
        "slotRecommendations": [string],
        "processImprovements": [string],
        "summary": "2-3 sentence operations summary"
      }
    `, { maxTokens: 1500 });

    if (!analysis) return;

    // 9. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: analysis.issues?.map(i => `[${i.severity}] ${i.description}`) || [],
      recommendations: [...(analysis.slotRecommendations || []), ...(analysis.processImprovements || [])],
      metricsSnapshot: { staleJobs: staleJobs.length, slotUtil, repActivity, bugStatus, completionTime }
    });

    // 10. Alert on high-severity issues
    for (const issue of (analysis.issues || [])) {
      if (issue.severity === 'high') {
        await this.sendMessage('ceo', 'alert', `Ops issue: ${issue.description}`, issue.action, { priority: 'high' });
      }
    }
  }

  async checkStaleJobs() {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const snap = await db.collection('jobs')
        .where('status', 'in', ['SCHEDULED', 'EN_ROUTE', 'ON_SITE'])
        .get();

      const stale = [];
      snap.docs.forEach(doc => {
        const job = doc.data();
        const lastUpdate = job.updated_at || job.created_at;
        if (lastUpdate && lastUpdate < twoHoursAgo) {
          stale.push({ jobId: doc.id, status: job.status, lastUpdate, customer: job.customer_name });
        }
      });
      return stale;
    } catch { return []; }
  }

  async checkSlotUtilization() {
    try {
      const today = new Date();
      const results = [];
      for (let i = 0; i < 7; i++) {
        const date = new Date(today.getTime() + i * 86400000);
        const dateStr = date.toISOString().split('T')[0];
        const snap = await db.collection('job_slots')
          .where('date', '==', dateStr)
          .get();

        const slots = snap.docs.map(d => d.data());
        const total = slots.filter(s => s.status !== 'blocked').length;
        const booked = slots.filter(s => s.status === 'booked').length;

        results.push({
          date: dateStr,
          day: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()],
          totalSlots: total,
          bookedSlots: booked,
          utilization: total > 0 ? Math.round((booked / total) * 100) + '%' : '0%',
          belowThreshold: total > 0 && (booked / total) < 0.4
        });
      }
      return results;
    } catch { return []; }
  }

  async checkStaleManualReviews() {
    try {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const snap = await db.collection('manual_review')
        .where('created_at', '<', twoHoursAgo)
        .get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch { return []; }
  }

  async checkRepActivity() {
    try {
      const today = new Date();
      const dayOfWeek = today.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return { weekday: false, message: 'Weekend — no sessions expected' };

      const todayStr = today.toISOString().split('T')[0];
      const snap = await db.collection('rep_sessions')
        .where('startedAt', '>=', todayStr)
        .get();

      return {
        weekday: true,
        sessionsToday: snap.size,
        noActivity: snap.size === 0
      };
    } catch { return { error: true }; }
  }

  async checkBugReports() {
    try {
      const snap = await db.collection('bug_reports')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get();

      if (snap.empty) return { hasBugs: false };
      const report = snap.docs[0].data();
      return {
        hasBugs: (report.bugsFound || []).length > 0,
        bugCount: (report.bugsFound || []).length,
        lastScan: report.timestamp
      };
    } catch { return { hasBugs: false }; }
  }

  async calcAvgCompletionTime() {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const snap = await db.collection('jobs')
        .where('status', '==', 'COMPLETED')
        .where('completed_at', '>', weekAgo)
        .get();

      if (snap.empty) return 'No completed jobs this week';

      let totalMinutes = 0;
      let count = 0;
      snap.docs.forEach(doc => {
        const job = doc.data();
        if (job.en_route_at && job.completed_at) {
          const start = new Date(job.en_route_at).getTime();
          const end = new Date(job.completed_at).getTime();
          totalMinutes += (end - start) / 60000;
          count++;
        }
      });

      return count > 0 ? `${Math.round(totalMinutes / count)} min avg (${count} jobs)` : 'No timing data';
    } catch { return 'Error calculating'; }
  }

  async meetingTurn(weekId, context) {
    const slotUtil = await this.checkSlotUtilization();
    const staleJobs = await this.checkStaleJobs();
    const lowDays = slotUtil.filter(d => d.belowThreshold);

    await this.sendMeetingMessage(weekId,
      `Operations report: ${staleJobs.length} stale jobs needing attention.\n` +
      `Slot utilization: ${lowDays.length > 0 ? lowDays.map(d => `${d.day}: ${d.utilization}`).join(', ') + ' below 40%' : 'All days above threshold.'}.\n` +
      `Avg completion time: ${await this.calcAvgCompletionTime()}.`,
      { slotUtil }
    );
  }
}

module.exports = OperationsAgent;
