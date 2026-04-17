/**
 * agents/base-agent.js — Shared agent class all agents extend
 * Provides run loop, Claude consultation, report writing, message bus,
 * approval queue, and state management.
 */

const { db } = require('../core/firestore');
const logger = require('../core/logger');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const STAND_DOWN_WORDS = ['stop', 'pause', 'calm', 'stand down', 'enough', 'quiet', 'shut up', 'silence', 'hold', 'wait'];

class BaseAgent {
  constructor(config) {
    this.agentId = config.agentId;           // 'ceo', 'cfo', 'cmo', etc.
    this.agentName = config.agentName;        // 'CEO', 'CFO', 'CMO', etc.
    this.emoji = config.emoji;               // '🤖', '💰', '📢', etc.
    this.color = config.color;               // hex color for UI
    this.intervalMs = config.intervalMs;     // ms between cycles
    this.systemPrompt = config.systemPrompt; // Claude persona
    this.cycleCount = 0;
    this.isRunning = false;
  }

  /**
   * Check if owner issued a stand-down command in recent messages.
   * Returns 'stand_down' if owner just told agents to stop.
   * Returns 'resumed' if owner posted a new non-stand-down message after standing down.
   * Returns 'quiet' if standing down and no new owner activity.
   * Returns 'active' if not standing down.
   */
  static checkOwnerStandDown(messages) {
    const ownerMsgs = messages.filter(m => m.type === 'owner_input');
    if (ownerMsgs.length === 0) {
      return BaseAgent._standingDown ? 'quiet' : 'active';
    }

    const lastOwnerMsg = ownerMsgs[ownerMsgs.length - 1];
    const text = (lastOwnerMsg.message || '').toLowerCase();
    const isStandDown = STAND_DOWN_WORDS.some(w => text.includes(w));

    if (isStandDown) {
      BaseAgent._standingDown = true;
      return 'stand_down';
    }

    // Owner posted something new that's not a stand-down — resume
    if (BaseAgent._standingDown) {
      BaseAgent._standingDown = false;
      return 'resumed';
    }

    return 'active';
  }

  // ── MAIN RUN LOOP ──────────────────────────────────────────────────
  async start() {
    await this.updateState('idle');
    logger.log(this.agentId, 'INFO', `${this.agentName} Agent starting (${this.intervalMs/3600000}hr cycle)`);

    while (true) {
      try {
        this.isRunning = true;
        const start = Date.now();
        await this.updateState('running');

        await this.runCycle();

        this.cycleCount++;
        const duration = Date.now() - start;
        await this.updateState('idle', { lastRunDuration: duration, cycleCount: this.cycleCount });
        logger.log(this.agentId, 'SUCCESS', `Cycle ${this.cycleCount} complete in ${Math.round(duration/1000)}s`);

      } catch (err) {
        await this.updateState('error', { lastError: err.message });
        logger.log(this.agentId, 'ERROR', `Cycle failed: ${err.message}`);
      }

      this.isRunning = false;
      await this.sleep(this.intervalMs);
    }
  }

  // ── MUST IMPLEMENT ────────────────────────────────────────────────
  async runCycle() {
    throw new Error(`${this.agentId}: runCycle() not implemented`);
  }

  // ── BOARDROOM THINK ──────────────────────────────────────────────
  // Override in each agent. Receives last 20 boardroom messages.
  // Returns a concise 1-3 sentence string or null if nothing to add.
  async boardroomThink(recentMessages) {
    return null; // subclasses override
  }

  // ── CLAUDE CONSULTATION ───────────────────────────────────────────
  async think(userPrompt, options = {}) {
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: options.maxTokens || 1500,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      return response.content.map(b => b.text || '').join('');
    } catch (err) {
      logger.log(this.agentId, 'ERROR', `Claude API failed: ${err.message}`);
      return null;
    }
  }

  async thinkJSON(userPrompt, options = {}) {
    const raw = await this.think(userPrompt, options);
    if (!raw) return null;
    try {
      return JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      return null;
    }
  }

  // ── REPORT WRITING ────────────────────────────────────────────────
  async writeReport(data) {
    const docId = `${this.agentId}_${new Date().toISOString().split('T')[0]}`;
    await db.collection('agent_reports').doc(docId).set({
      agentId: this.agentId,
      agentName: this.agentName,
      emoji: this.emoji,
      generatedAt: new Date(),
      cycleNumber: this.cycleCount,
      ...data
    });
  }

  async readReport(agentId, daysAgo = 0) {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const docId = `${agentId}_${date.toISOString().split('T')[0]}`;
    const doc = await db.collection('agent_reports').doc(docId).get();
    return doc.exists ? doc.data() : null;
  }

  async readAllReports(daysAgo = 0) {
    const agents = ['ceo','cfo','cmo','operations','hr','training','customer_success','legal','pricing'];
    const reports = {};
    for (const agentId of agents) {
      reports[agentId] = await this.readReport(agentId, daysAgo);
    }
    return reports;
  }

  // ── MESSAGE BUS ───────────────────────────────────────────────────
  async sendMessage(to, type, subject, body, data = {}, requiresOwnerApproval = false) {
    await db.collection('agent_messages').add({
      from: this.agentId,
      fromName: this.agentName,
      fromEmoji: this.emoji,
      to,
      type,
      priority: data.priority || 'medium',
      subject,
      body,
      data,
      requiresOwnerApproval,
      approved: null,
      approvedAt: null,
      weekId: null,
      sentAt: new Date(),
      readBy: []
    });
  }

  async readMessages(options = {}) {
    let query = db.collection('agent_messages')
      .where('to', 'in', [this.agentId, 'all']);
    if (options.since) query = query.where('sentAt', '>', options.since);
    if (options.type) query = query.where('type', '==', options.type);
    const snap = await query.orderBy('sentAt', 'desc').limit(options.limit || 20).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  async sendMeetingMessage(weekId, body, data = {}) {
    await db.collection('agent_messages').add({
      from: this.agentId,
      fromName: this.agentName,
      fromEmoji: this.emoji,
      to: 'meeting',
      type: 'meeting_message',
      priority: 'low',
      subject: 'Staff Meeting',
      body,
      data,
      requiresOwnerApproval: false,
      approved: null,
      approvedAt: null,
      weekId,
      sentAt: new Date(),
      readBy: []
    });
    // Small delay so messages appear sequentially in UI
    await this.sleep(1500);
  }

  // ── APPROVAL QUEUE ────────────────────────────────────────────────
  async queueApproval(title, description, impact, data = {}) {
    const docRef = await db.collection('pending_approvals').add({
      agentId: this.agentId,
      agentName: this.agentName,
      emoji: this.emoji,
      title,
      description,
      impact,
      data,
      status: 'pending',
      createdAt: new Date(),
      resolvedAt: null,
      resolvedBy: null
    });
    // Also send owner a message
    await this.sendMessage('owner', 'approval_request', title, description, { approvalId: docRef.id, impact }, true);
    return docRef.id;
  }

  async checkApproval(approvalId) {
    const doc = await db.collection('pending_approvals').doc(approvalId).get();
    return doc.exists ? doc.data().status : null;
  }

  // ── STATE MANAGEMENT ──────────────────────────────────────────────
  async updateState(status, extra = {}) {
    const nextRunAt = new Date(Date.now() + this.intervalMs);
    await db.collection('agent_state').doc(this.agentId).set({
      agentId: this.agentId,
      agentName: this.agentName,
      emoji: this.emoji,
      color: this.color,
      status,
      lastRunAt: new Date(),
      nextRunAt,
      cycleCount: this.cycleCount,
      errorCount: 0,
      lastError: null,
      version: '1.0.0',
      ...extra
    }, { merge: true });
  }

  // ── UTILITIES ─────────────────────────────────────────────────────
  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  getWeekId() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil(((now - start) / 86400000 + start.getDay() + 1) / 7);
    return `${now.getFullYear()}-W${String(week).padStart(2,'0')}`;
  }

  formatCurrency(n) { return `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:0,maximumFractionDigits:0})}`; }
}

// Shared stand-down state — set after class is defined
BaseAgent._standingDown = false;

module.exports = BaseAgent;
