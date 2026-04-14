/**
 * dispatch/ai-verify.js — AI re-verification of job quotes
 * Sends job data to Railway Quote API for confidence scoring,
 * then returns the AI assessment for pipeline routing.
 */

const axios = require('axios');
const logger = require('../core/logger');
const pricing = require('../config/pricing.json');

const QUOTE_API = process.env.RAILWAY_QUOTE_API || 'https://junk-quote-api-production.up.railway.app/api/quote';
const CONFIDENCE_AUTO_SEND = pricing.confidence.mediumThreshold;   // 0.60
const CONFIDENCE_MANUAL = pricing.confidence.manualReviewThreshold; // 0.45

/**
 * Re-verify a job's quote through the Railway AI pricing API.
 *
 * @param {object} job — Firestore job document data
 * @returns {object}   — { confidence, priceRange, midpoint, negotiationFloor, itemsSeen, notes, action }
 *   action: 'auto_send' | 'manual_review' | 'needs_photos'
 */
async function verifyQuote(job) {
  try {
    const payload = {
      address: job.address || '',
      images: job.images || [],
      imageMime: job.imageMime || 'image/jpeg',
    };

    // If no images available, use existing quote data for re-verification
    if (!payload.images.length && job.estimated_revenue) {
      return synthesizeFromExisting(job);
    }

    const response = await axios.post(QUOTE_API, payload, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    const data = response.data;
    const confidenceScore = parseConfidence(data.confidence, data.midpoint);

    let action;
    if (confidenceScore >= CONFIDENCE_AUTO_SEND) {
      action = 'auto_send';
    } else if (confidenceScore >= CONFIDENCE_MANUAL) {
      action = 'manual_review';
    } else {
      action = 'needs_photos';
    }

    const result = {
      confidence: confidenceScore,
      confidenceLabel: data.confidence,
      priceRange: data.priceRange,
      midpoint: data.midpoint,
      negotiationFloor: data.negotiationFloor,
      itemsSeen: data.itemsSeen || [],
      notes: data.notes || '',
      surcharges: data.surcharges || [],
      breakdown: data.breakdown || {},
      action,
    };

    await logger.success('ai-verify', `AI verified Job ${job.id || 'unknown'}: ${action} (confidence: ${(confidenceScore * 100).toFixed(0)}%)`, {
      type: 'ai_verification',
      jobId: job.id,
      confidence: confidenceScore,
      action,
      priceRange: data.priceRange,
    });

    return result;
  } catch (err) {
    await logger.error('ai-verify', `AI verification failed for Job ${job.id || 'unknown'}: ${err.message}`, {
      type: 'ai_verification_error',
      jobId: job.id,
      error: err.message,
    });

    // On API failure, route to manual review
    return {
      confidence: 0,
      action: 'manual_review',
      priceRange: job.priceRange || 'Unknown',
      midpoint: job.estimated_revenue || 0,
      notes: 'AI verification unavailable — routed to manual review',
      error: err.message,
    };
  }
}

/**
 * Parse confidence from the API response.
 * Railway API returns "high", "medium", "low" — map to numeric.
 */
function parseConfidence(label, midpoint) {
  const map = {
    high: 0.85,
    medium: 0.65,
    low: 0.35,
  };

  if (typeof label === 'number') return label;
  return map[label] || 0.5;
}

/**
 * When no images are available, synthesize a confidence score
 * from existing job data (estimated revenue, item descriptions).
 */
function synthesizeFromExisting(job) {
  const hasRevenue = job.estimated_revenue && job.estimated_revenue >= pricing.minimumJob;
  const hasAddress = !!job.address;
  const hasPhone = !!job.phone;

  let confidence = 0.40; // Baseline
  if (hasRevenue) confidence += 0.20;
  if (hasAddress) confidence += 0.10;
  if (hasPhone) confidence += 0.05;
  if (job.items_description) confidence += 0.10;

  confidence = Math.min(confidence, 0.75); // Cap without photos

  const expansion = confidence >= 0.60 ? pricing.confidence.mediumExpansion : pricing.confidence.lowExpansion;
  const mid = job.estimated_revenue || pricing.minimumJob;
  const low = Math.max(Math.round(mid * (1 - expansion)), pricing.minimumJob);
  const high = Math.round(mid * (1 + expansion));

  let action;
  if (confidence >= CONFIDENCE_AUTO_SEND) {
    action = 'auto_send';
  } else if (confidence >= CONFIDENCE_MANUAL) {
    action = 'manual_review';
  } else {
    action = 'needs_photos';
  }

  return {
    confidence,
    action,
    priceRange: `$${low}–$${high}`,
    midpoint: mid,
    negotiationFloor: Math.round(mid * (1 - pricing.floorMargin)),
    notes: 'Synthesized from existing job data (no photos)',
    itemsSeen: [],
  };
}

module.exports = { verifyQuote };
