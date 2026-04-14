/**
 * agents/meeting-runner.js — Weekly Staff Meeting Orchestrator
 * Schedule: Every Monday at 9:00am Pacific
 * Not a standard agent — orchestrates all agents taking turns.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');

const MEETING_ORDER = [
  'ceo', 'cfo', 'cmo', 'operations', 'hr', 'training', 'customer_success', 'pricing', 'legal'
];

/**
 * Run the weekly staff meeting.
 * CEO opens, each agent presents in order, CEO closes with approval summary.
 * All messages written to agent_messages with weekId for real-time chat display.
 *
 * @param {object} agents — Map of agentId → agent instance
 */
async function runWeeklyMeeting(agents) {
  const weekId = agents.ceo.getWeekId();

  logger.log('meeting', 'INFO', `Starting weekly staff meeting ${weekId}`);

  // Create meeting doc
  await db.collection('agent_meetings').doc(weekId).set({
    weekId,
    startedAt: new Date(),
    completedAt: null,
    status: 'running',
    participantCount: MEETING_ORDER.length,
    approvalCount: 0
  });

  const collectedApprovals = [];
  const context = { weekId, approvals: collectedApprovals };

  // CEO opens the meeting
  try {
    await agents.ceo.meetingTurn(weekId, context);
  } catch (err) {
    logger.log('meeting', 'ERROR', `CEO failed to open meeting: ${err.message}`);
  }

  // Each agent takes their turn in order
  for (const agentId of MEETING_ORDER.slice(1)) {
    try {
      // Brief pause between speakers for natural pacing
      await new Promise(r => setTimeout(r, 2000));

      // Find agent — handle both snake_case and camelCase keys
      const agent = agents[agentId] || agents[agentId.replace(/_/g, '')];
      if (agent && agent.meetingTurn) {
        // Read meeting messages so far — agent can reference what was said
        const snap = await db.collection('agent_messages')
          .where('weekId', '==', weekId)
          .orderBy('sentAt', 'asc')
          .get();
        const meetingContext = snap.docs.map(d => ({
          from: d.data().fromName,
          body: d.data().body
        }));

        await agent.meetingTurn(weekId, { ...context, meetingContext });
      }
    } catch (err) {
      logger.log('meeting', 'ERROR', `${agentId} failed meeting turn: ${err.message}`);
    }
  }

  // Collect all approvals generated during meeting
  const approvalsSnap = await db.collection('pending_approvals')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  const approvals = approvalsSnap.docs.map(d => d.data());

  // CEO closes the meeting
  try {
    await agents.ceo.closeMeeting(weekId, [], approvals);
  } catch (err) {
    logger.log('meeting', 'ERROR', `CEO failed to close meeting: ${err.message}`);
  }

  // Mark meeting complete
  await db.collection('agent_meetings').doc(weekId).update({
    completedAt: new Date(),
    status: 'completed',
    approvalCount: approvals.length
  });

  // Send SMS to owner
  try {
    const { sendSMS } = require('../core/twilio');
    await sendSMS(process.env.ADMIN_PHONE,
      `TrashApp Weekly Staff Meeting complete.\n${approvals.length} items need your approval.\nOpen admin console to review.`
    );
  } catch (err) {
    logger.log('meeting', 'ERROR', `Meeting SMS failed: ${err.message}`);
  }

  logger.log('meeting', 'SUCCESS', `Weekly meeting ${weekId} complete. ${approvals.length} approvals queued.`);
}

module.exports = { runWeeklyMeeting };
