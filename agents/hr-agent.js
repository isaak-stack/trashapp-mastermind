/**
 * agents/hr-agent.js — HR AI Agent
 * Interval: 8 hours
 * Persona: People-focused, systematic. Thinks about culture as much as headcount.
 * Protective of team quality.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');
const axios = require('axios');

class HRAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'hr',
      agentName: 'HR',
      emoji: '👥',
      color: '#9B59B6',
      intervalMs: 8 * 60 * 60 * 1000, // 8 hours
      systemPrompt: `You are the HR AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: build and maintain a strong team. Recruit, track performance, flag problems.
You think about people as the business's most important asset.
You track: headcount, applicant pipeline, rep activity, performance trends.
When a rep goes quiet (no sessions in 3+ days), you flag it immediately.
When active rep count drops below 2, you escalate to CEO as high priority.
You write compelling job listings that attract quality candidates.
Respond only in JSON. No preamble.`
    });
  }

  async runCycle() {
    // 1. Check active rep count and activity
    const repActivity = await this.checkRepActivity();

    // 2. Check job applications
    const applications = await this.checkApplications();

    // 3. Generate performance summary per rep
    const repPerformance = await this.generateRepPerformance();

    // 4. Read messages
    const messages = await this.readMessages({ limit: 10 });

    // 5. Think
    const analysis = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      REP ACTIVITY:
      ${JSON.stringify(repActivity, null, 2)}

      APPLICATIONS:
      ${JSON.stringify(applications, null, 2)}

      REP PERFORMANCE (7 days):
      ${JSON.stringify(repPerformance, null, 2)}

      MESSAGES:
      ${JSON.stringify(messages.slice(0,5), null, 2)}

      As HR, analyze and return JSON:
      {
        "headcount": { "activeReps": number, "inactiveReps": number, "needsHiring": boolean },
        "inactiveFlags": [{ "repId": string, "name": string, "daysSinceLastSession": number }],
        "applicantPipeline": { "new": number, "flagged": number, "contacted": number },
        "jobListings": [
          {
            "role": "sales_rep|crew_member",
            "title": string,
            "body": string,
            "platform": "craigslist|indeed"
          }
        ],
        "approvalRequests": [{ "title": string, "description": string, "impact": string, "priority": "low|medium|high" }],
        "summary": "2-3 sentence HR summary"
      }
    `, { maxTokens: 2500 });

    if (!analysis || !analysis.summary) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete HR analysis, skipping cycle');
      return;
    }

    // 6. Write report
    await this.writeReport({
      summary: analysis.summary,
      findings: [
        ...(analysis.inactiveFlags || []).map(f => `${f.name}: ${f.daysSinceLastSession} days inactive`),
        `Headcount: ${analysis.headcount?.activeReps || 0} active reps`
      ],
      recommendations: (analysis.approvalRequests || []).map(r => r.title),
      metricsSnapshot: { headcount: analysis.headcount, applicantPipeline: analysis.applicantPipeline }
    });

    // 7. Post job listings to content_queue
    for (const listing of (analysis.jobListings || [])) {
      await db.collection('content_queue').add({
        agentId: 'hr',
        platform: listing.platform,
        postType: 'hiring_ad',
        title: listing.title,
        body: listing.body,
        status: 'pending',
        scheduledFor: null,
        postedAt: null,
        createdAt: new Date(),
        performanceData: null
      });
    }

    // 8. Escalate if rep count too low
    if (analysis.headcount?.activeReps < 2) {
      await this.sendMessage('ceo', 'alert', 'Critical: Active rep count below 2',
        `Only ${analysis.headcount.activeReps} active reps. Need immediate hiring push.`,
        { priority: 'critical' }
      );
      await this.queueApproval(
        'Urgent hiring push needed',
        `Active rep count is ${analysis.headcount.activeReps}. Recommend posting to all channels immediately.`,
        'Risk: unable to cover territories',
        { activeReps: analysis.headcount.activeReps }
      );
    }

    // 9. Queue approvals
    for (const req of (analysis.approvalRequests || [])) {
      await this.queueApproval(req.title, req.description, req.impact, {});
    }
  }

  async checkRepActivity() {
    try {
      const repsSnap = await db.collection('reps').get();
      const reps = repsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

      const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
      const results = [];

      for (const rep of reps) {
        const sessionsSnap = await db.collection('rep_sessions')
          .where('repId', '==', rep.id)
          .orderBy('startedAt', 'desc')
          .limit(1)
          .get();

        const lastSession = sessionsSnap.empty ? null : sessionsSnap.docs[0].data();
        const lastActive = lastSession?.startedAt ? new Date(lastSession.startedAt) : null;
        const daysSince = lastActive ? Math.floor((Date.now() - lastActive.getTime()) / 86400000) : 999;

        results.push({
          repId: rep.id,
          name: rep.name || 'Unknown',
          phone: rep.phone,
          status: rep.status,
          lastSessionDate: lastActive?.toISOString()?.split('T')[0] || 'never',
          daysSinceLastSession: daysSince,
          inactive: daysSince > 3
        });
      }

      return {
        totalReps: reps.length,
        activeReps: results.filter(r => !r.inactive && r.status === 'approved').length,
        inactiveReps: results.filter(r => r.inactive).length,
        details: results
      };
    } catch { return { totalReps: 0, activeReps: 0, inactiveReps: 0, details: [] }; }
  }

  async checkApplications() {
    try {
      const snap = await db.collection('job_applications')
        .where('status', '==', 'new')
        .orderBy('receivedAt', 'desc')
        .limit(20)
        .get();

      const apps = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Score new applicants using Claude
      for (const app of apps) {
        if (!app.score) {
          const score = await this.thinkJSON(`
            Score this applicant for a junk removal ${app.role || 'sales_rep'} role in Fresno:
            Name: ${app.name}
            Message: ${app.message}
            Source: ${app.source}
            Return JSON: { "score": 0-100, "reasoning": "1 sentence" }
          `);

          if (score) {
            await db.collection('job_applications').doc(app.id).update({
              score: score.score,
              scoreReasoning: score.reasoning,
              status: score.score > 60 ? 'flagged' : 'new'
            });
          }
        }
      }

      return { newApplicants: apps.length };
    } catch { return { newApplicants: 0 }; }
  }

  async generateRepPerformance() {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const sessionsSnap = await db.collection('rep_sessions')
        .where('startedAt', '>', weekAgo.toISOString())
        .get();

      const repStats = {};
      sessionsSnap.docs.forEach(doc => {
        const s = doc.data();
        const repId = s.repId || 'unknown';
        if (!repStats[repId]) {
          repStats[repId] = { sessions: 0, doors: 0, quotes: 0, booked: 0, commission: 0 };
        }
        repStats[repId].sessions++;
        repStats[repId].doors += s.doorsKnocked || 0;
        repStats[repId].quotes += s.quotesGiven || 0;
        repStats[repId].booked += s.jobsBooked || 0;
        repStats[repId].commission += s.commissionEarned || 0;
      });

      return Object.entries(repStats).map(([repId, stats]) => ({
        repId,
        ...stats,
        closeRate: stats.quotes > 0 ? ((stats.booked / stats.quotes) * 100).toFixed(1) + '%' : '0%'
      }));
    } catch { return []; }
  }

  async meetingTurn(weekId, context) {
    const repActivity = await this.checkRepActivity();
    const inactive = repActivity.details?.filter(r => r.inactive) || [];

    await this.sendMeetingMessage(weekId,
      `HR update: ${repActivity.activeReps} active reps, ${repActivity.inactiveReps} inactive.\n` +
      `${inactive.length > 0 ? 'Inactive: ' + inactive.map(r => `${r.name} (${r.daysSinceLastSession}d)`).join(', ') + '.' : 'All reps active.'}\n` +
      `Applicant pipeline has new candidates ready for review.`,
      { repActivity }
    );
  }
}

module.exports = HRAgent;
