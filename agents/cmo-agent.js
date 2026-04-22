/**
 * agents/cmo-agent.js — CMO AI Agent
 * Interval: 4 hours
 * Persona: Creative, growth-focused, data-driven marketer.
 * Knows what converts. Speaks in leads, CPL, and rankings.
 */

const BaseAgent = require('./base-agent');
const { db } = require('../core/firestore');
const logger = require('../core/logger');
const axios = require('axios');
const cheerio = require('cheerio');

class CMOAgent extends BaseAgent {
  constructor() {
    super({
      agentId: 'cmo',
      agentName: 'CMO',
      emoji: '📢',
      color: '#3498DB',
      intervalMs: 4 * 60 * 60 * 1000, // 4 hours
      systemPrompt: `You are the CMO AI agent for TrashApp Junk Removal in Fresno, CA.
Your job: drive leads, build brand awareness, and grow the business.
You think in terms of leads, cost per lead (CPL), conversion rates, and search rankings.
You are creative but always tie ideas back to ROI.
You know that local SEO and Craigslist are the highest-ROI channels for a junk removal startup.
You generate compelling ad copy that sounds human, not corporate.
When asked for JSON, respond only in JSON. When asked for plain text, respond in plain text. No preamble.`
    });
    this.domainKeywords = ['marketing', 'ads', 'ad', 'leads', 'lead', 'facebook', 'google', 'craigslist', 'social', 'content', 'brand', 'post', 'seo', 'ranking', 'nextdoor', 'campaign', 'cpl'];
  }

  async runCycle() {
    // 0. Report capability gaps ONCE per session
    await this.reportCapabilityGap('cmo_facebook', {
      envKeys: ['FACEBOOK_PAGE_ID', 'FACEBOOK_ACCESS_TOKEN'],
      missing: 'Facebook posting',
      steps: 'Go to developers.facebook.com/tools/explorer → select TrashApp page → add pages_manage_posts permission → regenerate token → add FACEBOOK_PAGE_ID and FACEBOOK_ACCESS_TOKEN to .env',
      unlocks: 'Auto-posting approved content drafts to your Facebook page'
    });
    await this.reportCapabilityGap('cmo_google_business', {
      envKeys: ['GBP_LOCATION_ID', 'GBP_ACCESS_TOKEN'],
      missing: 'Google Business Profile posting',
      steps: 'Go to business.google.com → verify your listing → copy the location ID from the URL → set up OAuth at console.cloud.google.com → add GBP_LOCATION_ID and GBP_ACCESS_TOKEN to .env',
      unlocks: 'Auto-posting updates and offers to your Google Business listing'
    });
    await this.reportCapabilityGap('cmo_craigslist', {
      envKeys: ['__CRAIGSLIST_NO_API__'], // Will never exist — permanent gap
      missing: 'Craigslist auto-posting (no API exists)',
      steps: 'Craigslist has no public API. Manually repost ads every 48 hours using the drafts I queue in content_queue. Copy/paste the body text from the admin console.',
      unlocks: 'N/A — I will keep drafting copy for you to post manually'
    });

    // 1. Check Google rankings for key terms
    const rankings = await this.checkRankings();

    // 2. Scrape competitor Google Business listings
    const competitors = await this.scrapeCompetitors();

    // 3. Pull inbound lead volume
    const leadData = await this.pullLeadVolume();

    // 4. Read messages from other agents
    const messages = await this.readMessages({ limit: 10 });

    // 5. Generate content drafts via Claude
    const contentPlan = await this.thinkJSON(`
      Today's date: ${new Date().toLocaleDateString()}

      SEARCH RANKINGS:
      ${JSON.stringify(rankings, null, 2)}

      COMPETITOR DATA:
      ${JSON.stringify(competitors, null, 2)}

      LEAD DATA (7 days):
      ${JSON.stringify(leadData, null, 2)}

      CEO MESSAGES:
      ${JSON.stringify(messages.filter(m => m.from === 'ceo').slice(0,3), null, 2)}

      Generate 3 post drafts and marketing analysis. Return JSON:
      {
        "seoSummary": "2-3 sentences on search position",
        "leadReport": { "weeklyLeads": number, "topSource": string, "trend": "up|down|flat" },
        "competitorMoves": [{ "name": string, "change": string }],
        "contentDrafts": [
          {
            "platform": "facebook|craigslist|nextdoor|google_business",
            "postType": "service_ad|hiring_ad|community_post",
            "title": string,
            "body": string
          }
        ],
        "recommendations": [string],
        "summary": "2-3 sentence marketing summary"
      }
    `, { maxTokens: 2500 });

    if (!contentPlan || !contentPlan.summary) {
      logger.log(this.agentId, 'WARN', 'Claude returned null/incomplete content plan, skipping cycle');
      return;
    }

    // 6. Queue content drafts in content_queue
    for (const draft of (contentPlan.contentDrafts || [])) {
      await db.collection('content_queue').add({
        agentId: 'cmo',
        platform: draft.platform,
        postType: draft.postType,
        title: draft.title,
        body: draft.body,
        status: 'pending',
        scheduledFor: null,
        postedAt: null,
        createdAt: new Date(),
        performanceData: null
      });
    }

    // 7. Write report
    await this.writeReport({
      summary: contentPlan.summary,
      findings: [
        contentPlan.seoSummary,
        ...(contentPlan.competitorMoves || []).map(c => `${c.name}: ${c.change}`)
      ],
      recommendations: contentPlan.recommendations || [],
      metricsSnapshot: {
        rankings,
        leadData,
        draftsGenerated: (contentPlan.contentDrafts || []).length
      }
    });

    // 8. Alert CEO about significant changes
    if (contentPlan.leadReport?.trend === 'down') {
      await this.sendMessage('ceo', 'alert', 'Lead volume declining',
        `Leads trending down: ${contentPlan.leadReport.weeklyLeads} this week. ${contentPlan.summary}`,
        { priority: 'high' }
      );
    }
  }

  async checkRankings() {
    const keywords = [
      'junk removal fresno',
      'junk removal fresno ca',
      'trash removal fresno',
      'furniture removal fresno',
      'appliance removal fresno',
      'junk hauling fresno'
    ];

    const results = [];
    for (const kw of keywords) {
      try {
        const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(kw)}&num=20`, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(res.data);
        const allResults = [];
        $('div.g').each((i, el) => {
          const link = $(el).find('a').attr('href') || '';
          allResults.push(link);
        });

        const trashappPos = allResults.findIndex(l =>
          l.includes('trashapp') || l.includes('trash-app')
        );

        results.push({
          keyword: kw,
          position: trashappPos >= 0 ? trashappPos + 1 : null,
          topResult: allResults[0]?.substring(0, 60) || 'unknown'
        });
      } catch {
        results.push({ keyword: kw, position: null, error: 'fetch failed' });
      }
    }
    return results;
  }

  async scrapeCompetitors() {
    const competitors = [
      'College Hunks Hauling Junk Fresno',
      'Junk King Fresno',
      '1-800-GOT-JUNK Fresno'
    ];

    const results = [];
    for (const name of competitors) {
      try {
        const res = await axios.get(`https://www.google.com/search?q=${encodeURIComponent(name + ' reviews')}`, {
          timeout: 10000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(res.data);
        const ratingText = $('span.Aq14fc').first().text() || '';
        const reviewCountText = $('span.hqzQac').first().text() || '';
        results.push({
          name,
          rating: parseFloat(ratingText) || null,
          reviewCount: parseInt(reviewCountText.replace(/[^\d]/g, '')) || null
        });
      } catch {
        results.push({ name, rating: null, reviewCount: null });
      }
    }
    return results;
  }

  async pullLeadVolume() {
    try {
      const weekAgo = new Date(Date.now() - 7 * 86400000);
      const jobsSnap = await db.collection('jobs')
        .where('created_at', '>', weekAgo.toISOString())
        .get();

      const customersSnap = await db.collection('customers')
        .where('created_at', '>', weekAgo.toISOString())
        .get();

      return {
        newJobs: jobsSnap.size,
        newCustomers: customersSnap.size,
        topSource: 'organic' // placeholder — would need attribution tracking
      };
    } catch {
      return { newJobs: 0, newCustomers: 0, topSource: 'unknown' };
    }
  }

  // ── BOARDROOM THINK ────────────────────────────────────────────
  async boardroomThink(recentMessages) {
    const BaseAgent = require('./base-agent');
    const standDown = BaseAgent.checkOwnerStandDown(recentMessages);
    if (standDown === 'stand_down' || standDown === 'quiet') return null;

    // Attempt to post pending Facebook content (one per cycle)
    const fbResult = await this.processContentQueue();
    if (fbResult) return fbResult; // Return the post result as the boardroom message

    const leadData = await this.pullLeadVolume();
    const msgContext = recentMessages.slice(-10).map(m => `[${m.from || m.agentId}]: ${m.message}`).join('\n');

    let pendingContent = 0;
    try {
      const snap = await db.collection('content_queue').where('status', '==', 'pending').get();
      pendingContent = snap.size;
    } catch {}

    const prompt = `You are the CMO of TrashApp Junk Removal.

REAL DATA (from Firestore — report ONLY these numbers, do NOT invent any):
- New jobs this week: ${leadData.newJobs || 0}
- New customers this week: ${leadData.newCustomers || 0}
- Content queue pending: ${pendingContent}
${leadData.newJobs === 0 && leadData.newCustomers === 0 ? '- NOTE: No lead data yet. Say "no leads tracked yet" — do NOT make up numbers.' : ''}

RECENT MESSAGES:
${msgContext}

CONVERSATION VARIETY:
- Don't repeat your last message. Find a new angle — a question for HR about rep referrals, a note to CEO about brand positioning, or a reaction to what someone else said.
- If someone mentioned customer feedback or reviews, connect it to marketing.
- Vary your opening — don't always lead with lead count.

RULES:
- Only state the exact numbers above. Do NOT invent leads, rankings, CPL, or conversion rates that aren't listed.
- 1-2 sentences max. Calm tone. No ALL CAPS. No "CRITICAL" or "EMERGENCY."
- No JSON. Plain text. Sign off with "— CMO".
- If nothing to add, respond with exactly "null".`;

    const response = await this.think(prompt, { maxTokens: 150 });
    if (!response || response.trim().toLowerCase() === 'null') return null;
    return response.trim();
  }

  // ── REAL API: Post to Facebook (Graph API v18.0) ───────────────
  async postToFacebook(postText) {
    const pageId = process.env.FACEBOOK_PAGE_ID;
    const token = process.env.FACEBOOK_ACCESS_TOKEN;

    if (!pageId || !token) {
      // Gap already reported in runCycle — just return null
      return { success: false, error: 'Missing FACEBOOK_PAGE_ID or FACEBOOK_ACCESS_TOKEN' };
    }

    try {
      const res = await axios.post(
        `https://graph.facebook.com/v18.0/${pageId}/feed`,
        { message: postText, access_token: token },
        { timeout: 15000 }
      );
      const postId = res.data?.id || null;
      logger.log(this.agentId, 'SUCCESS', `Facebook post published: ${postId}`);
      return { success: true, postId };
    } catch (e) {
      const fbError = e.response?.data?.error;
      const errorMsg = fbError
        ? `Facebook API error ${fbError.code}: ${fbError.message}`
        : `Facebook post failed: ${e.message}`;

      logger.log(this.agentId, 'ERROR', errorMsg);

      // Detect permission-specific errors
      if (fbError?.code === 200 || fbError?.type === 'OAuthException') {
        await this.reportCapabilityGap('cmo_facebook_permission', {
          envKeys: ['__FACEBOOK_PERMISSION_FIX__'], // Manual fix needed
          missing: 'Facebook token permission (pages_manage_posts)',
          steps: 'Your token exists but lacks the pages_manage_posts permission. Go to developers.facebook.com/tools/explorer → reselect TrashApp page → add pages_manage_posts → regenerate token → update FACEBOOK_ACCESS_TOKEN in .env',
          unlocks: 'Auto-posting to Facebook'
        });
      }

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Process pending Facebook posts from content_queue.
   * Called from boardroomThink when credentials are configured.
   * Posts ONE item per cycle to avoid spam.
   */
  async processContentQueue() {
    if (!process.env.FACEBOOK_PAGE_ID || !process.env.FACEBOOK_ACCESS_TOKEN) return null;

    try {
      const snap = await db.collection('content_queue')
        .where('platform', '==', 'facebook')
        .where('status', '==', 'pending')
        .orderBy('createdAt', 'asc')
        .limit(1)
        .get();

      if (snap.empty) return null;

      const doc = snap.docs[0];
      const post = doc.data();
      const postText = post.body || post.title || '';
      if (!postText) return null;

      const result = await this.postToFacebook(postText);

      if (result.success) {
        // Update content_queue doc
        await db.collection('content_queue').doc(doc.id).update({
          status: 'posted',
          postedAt: new Date(),
          postId: result.postId,
          performanceData: { platform: 'facebook', postId: result.postId }
        });
        return `Posted to Facebook: "${postText.substring(0, 60)}..." (ID: ${result.postId}) — CMO`;
      } else {
        // Mark as failed so we don't retry forever
        await db.collection('content_queue').doc(doc.id).update({
          status: 'failed',
          error: result.error,
          failedAt: new Date()
        });
        return `Facebook post failed: ${result.error} — CMO`;
      }
    } catch (err) {
      logger.log(this.agentId, 'ERROR', `processContentQueue error: ${err.message}`);
      return null;
    }
  }

  // ── REAL API: Deploy blog to Netlify ──────────────────────────
  async deployBlog(content) {
    if (!process.env.NETLIFY_API_TOKEN || !process.env.NETLIFY_BLOG_SITE_ID) {
      await this.reportCapabilityGap('cmo_netlify', {
        envKeys: ['NETLIFY_API_TOKEN', 'NETLIFY_BLOG_SITE_ID'],
        missing: 'Netlify blog deployment',
        steps: 'Go to app.netlify.com → Site settings → create a personal access token → add NETLIFY_API_TOKEN and NETLIFY_BLOG_SITE_ID to .env',
        unlocks: 'Auto-deploying blog posts to your Netlify site'
      });
      return null;
    }
    try {
      const res = await axios.post(`https://api.netlify.com/api/v1/sites/${process.env.NETLIFY_BLOG_SITE_ID}/deploys`, {}, {
        headers: { 'Authorization': `Bearer ${process.env.NETLIFY_API_TOKEN}` },
        timeout: 30000
      });
      return res.data?.deploy_url || null;
    } catch (e) {
      console.error('[CMO] Netlify deploy failed:', e.message);
      return null;
    }
  }

  async meetingTurn(weekId, context) {
    const rankings = await this.checkRankings();
    const leadData = await this.pullLeadVolume();
    const rankedKw = rankings.filter(r => r.position).map(r => `"${r.keyword}": #${r.position}`).join(', ');

    await this.sendMeetingMessage(weekId,
      `Marketing update: ${leadData.newJobs} new leads this week.\n` +
      `Rankings: ${rankedKw || 'Not yet ranking for target keywords'}.\n` +
      `Content queue has new drafts ready for approval. Recommend pushing Craigslist ads harder this week.`,
      { rankings, leadData }
    );
  }
}

module.exports = CMOAgent;
