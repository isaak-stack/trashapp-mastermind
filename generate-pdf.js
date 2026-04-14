/**
 * generate-pdf.js — TrashApp Mastermind PC Setup PDF Generator
 * Uses PDFKit to create a comprehensive setup guide.
 * Auto-runs on first startup if PDF doesn't exist.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'TrashApp_Mastermind_PC_Setup.pdf');

// Colors
const DARK_BG = '#0e0e0e';
const GOLD = '#F5A623';
const WHITE = '#e5e5e5';
const MUTED = '#999999';
const CARD_BG = '#1a1a1a';

function generatePDF() {
  if (fs.existsSync(OUTPUT_PATH)) {
    console.log('[PDF] Setup guide already exists, skipping generation.');
    return;
  }

  console.log('[PDF] Generating TrashApp Mastermind PC Setup Guide...');

  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: 'TrashApp Mastermind PC Setup Guide',
      Author: 'TrashApp Junk Removal',
      Subject: 'System Setup and Configuration',
    },
  });

  const stream = fs.createWriteStream(OUTPUT_PATH);
  doc.pipe(stream);

  // ═══════════════════════════════════════════════════════
  // COVER PAGE
  // ═══════════════════════════════════════════════════════
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(DARK_BG);

  doc.moveDown(8);
  doc.fontSize(48).fillColor(GOLD).font('Helvetica-Bold')
    .text('TRASHAPP', { align: 'center' });
  doc.fontSize(32).fillColor(WHITE)
    .text('MASTERMIND', { align: 'center' });
  doc.moveDown(1);
  doc.fontSize(18).fillColor(GOLD)
    .text('PC Setup Guide', { align: 'center' });
  doc.moveDown(2);
  doc.fontSize(12).fillColor(MUTED)
    .text('"One man\'s trash is our whole business"', { align: 'center' });
  doc.moveDown(4);
  doc.fontSize(11).fillColor(MUTED)
    .text(`Generated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`, { align: 'center' });
  doc.text('Version 1.0', { align: 'center' });

  // ═══════════════════════════════════════════════════════
  // SECTION 1 — What This Is
  // ═══════════════════════════════════════════════════════
  newSection(doc, '1. What This Is');

  body(doc, 'TrashApp Mastermind is the AI dispatch brain that connects all your TrashApp services into one automated pipeline. It runs 24/7 on a dedicated PC in your office.');
  doc.moveDown(0.5);
  body(doc, 'What runs on this PC:');
  bullet(doc, 'Real-time dispatch dashboard (localhost:3000)');
  bullet(doc, 'Automated SMS conversations with customers');
  bullet(doc, 'AI-powered quote verification and routing');
  bullet(doc, 'Payment link generation via Stripe');
  bullet(doc, 'Crew scheduling and route optimization');
  bullet(doc, 'Nightly maintenance, health checks, and reporting');
  doc.moveDown(0.5);
  body(doc, 'What runs in the cloud (unchanged):');
  bullet(doc, 'Railway — AI Quote API (pricing engine)');
  bullet(doc, 'Netlify — Rep Platform, Admin Console, Quote Page, Homepage');
  bullet(doc, 'Firebase — Database, Authentication, Storage');

  // ═══════════════════════════════════════════════════════
  // SECTION 2 — System Requirements
  // ═══════════════════════════════════════════════════════
  newSection(doc, '2. System Requirements');

  const reqs = [
    ['Node.js', 'v22 or newer (download from nodejs.org)'],
    ['RAM', '4 GB minimum (8 GB recommended)'],
    ['Internet', 'Stable broadband connection, always connected'],
    ['Power', 'Always-on power — disable sleep mode and hibernation'],
    ['OS', 'Windows 10/11 or macOS 12+ (Monterey or newer)'],
    ['Disk Space', '500 MB free for application and logs'],
    ['Ports', 'Port 3000 open for dashboard (localhost only by default)'],
  ];

  reqs.forEach(([label, desc]) => {
    doc.fontSize(11).fillColor(GOLD).font('Helvetica-Bold').text(label + ': ', { continued: true });
    doc.fillColor(WHITE).font('Helvetica').text(desc);
    doc.moveDown(0.3);
  });

  // ═══════════════════════════════════════════════════════
  // SECTION 3 — Step by Step Installation
  // ═══════════════════════════════════════════════════════
  newSection(doc, '3. Step-by-Step Installation');

  const steps = [
    'Install Node.js v22+ from https://nodejs.org (use the LTS installer)',
    'Open Terminal (Mac) or Command Prompt (Windows)',
    'Clone the repository:\n   git clone https://github.com/isaak-stack/trashapp-mastermind.git',
    'Enter the project folder:\n   cd trashapp-mastermind',
    'Copy the example environment file:\n   cp .env.example .env  (Mac)\n   copy .env.example .env  (Windows)',
    'Fill in your .env file with service credentials (see Section 4)',
    'Install dependencies:\n   npm install',
    'Generate this setup PDF (if not already generated):\n   node generate-pdf.js',
    'Register as a system service (starts on boot):\n   node install-service.js',
    'Open your browser to http://localhost:3000',
    'Verify all health dots are green on the dashboard',
  ];

  steps.forEach((step, i) => {
    doc.fontSize(14).fillColor(GOLD).font('Helvetica-Bold').text(`${i + 1}.`, { continued: true });
    doc.fontSize(11).fillColor(WHITE).font('Helvetica').text(`  ${step}`);
    doc.moveDown(0.5);
  });

  // ═══════════════════════════════════════════════════════
  // SECTION 4 — Filling in the .env File
  // ═══════════════════════════════════════════════════════
  newSection(doc, '4. Filling in the .env File');

  body(doc, 'Open the .env file in any text editor. Fill in each variable:');
  doc.moveDown(0.5);

  const envVars = [
    ['FIREBASE_PROJECT_ID', 'trashapp-reps (already set)', 'N/A — pre-filled'],
    ['FIREBASE_CLIENT_EMAIL', 'Service account email', 'Firebase Console → Project Settings → Service Accounts'],
    ['FIREBASE_PRIVATE_KEY', 'Private key from JSON file', 'Same page → Generate New Private Key → copy key field'],
    ['TWILIO_ACCOUNT_SID', 'Starts with AC...', 'https://www.twilio.com/console'],
    ['TWILIO_AUTH_TOKEN', '32-character token', 'https://www.twilio.com/console'],
    ['TWILIO_PHONE_NUMBER', '+1 format phone number', 'https://www.twilio.com/console/phone-numbers'],
    ['STRIPE_SECRET_KEY', 'Starts with sk_live_ or sk_test_', 'https://dashboard.stripe.com/apikeys'],
    ['STRIPE_WEBHOOK_SECRET', 'Starts with whsec_', 'https://dashboard.stripe.com/webhooks'],
    ['CALENDLY_WEBHOOK_SECRET', 'Webhook signing key', 'https://calendly.com/integrations'],
    ['DASHBOARD_PASSWORD', 'Any password (optional)', 'Choose your own — leave blank for no password'],
  ];

  envVars.forEach(([varName, desc, where]) => {
    doc.fontSize(10).fillColor(GOLD).font('Helvetica-Bold').text(varName);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica').text(`  ${desc}`);
    doc.fontSize(9).fillColor(MUTED).text(`  Find it: ${where}`);
    doc.moveDown(0.4);
  });

  // ═══════════════════════════════════════════════════════
  // SECTION 5 — Service Setup Guides
  // ═══════════════════════════════════════════════════════
  newSection(doc, '5. Service Setup Guides');

  subheading(doc, 'Twilio (SMS)');
  bullet(doc, 'Sign up at https://www.twilio.com');
  bullet(doc, 'Buy a phone number with SMS capability');
  bullet(doc, 'Copy Account SID and Auth Token from the Console dashboard');
  bullet(doc, 'Set webhook URL: http://YOUR-IP:3000/webhooks/twilio (POST)');
  bullet(doc, 'Enable incoming messages on your Twilio number → set to webhook URL above');
  doc.moveDown(0.5);

  subheading(doc, 'Stripe (Payments)');
  bullet(doc, 'Sign up at https://dashboard.stripe.com');
  bullet(doc, 'Get your Secret Key from Developers → API Keys');
  bullet(doc, 'Add webhook endpoint: http://YOUR-IP:3000/webhooks/stripe');
  bullet(doc, 'Select event: payment_intent.succeeded and checkout.session.completed');
  bullet(doc, 'Copy the Webhook Signing Secret (starts with whsec_)');
  doc.moveDown(0.5);

  subheading(doc, 'Calendly (Bookings)');
  bullet(doc, 'Go to https://calendly.com/integrations/webhooks');
  bullet(doc, 'Create webhook subscription pointing to: http://YOUR-IP:3000/webhooks/calendly');
  bullet(doc, 'Select event: invitee.created');
  bullet(doc, 'Copy the webhook signing key');
  doc.moveDown(0.5);

  subheading(doc, 'Firebase (Database)');
  bullet(doc, 'Go to https://console.firebase.google.com → Project: trashapp-reps');
  bullet(doc, 'Project Settings → Service Accounts → Generate New Private Key');
  bullet(doc, 'Download the JSON file');
  bullet(doc, 'Copy client_email and private_key values into your .env file');
  bullet(doc, 'IMPORTANT: Wrap the private_key value in double quotes in the .env file');

  // ═══════════════════════════════════════════════════════
  // SECTION 6 — Accessing the Dashboard
  // ═══════════════════════════════════════════════════════
  newSection(doc, '6. Accessing the Dashboard');

  body(doc, 'Local access: Open http://localhost:3000 on the PC running Mastermind.');
  doc.moveDown(0.3);
  body(doc, 'Remote access: Use ngrok to expose the dashboard securely:');
  bullet(doc, 'Install ngrok: https://ngrok.com/download');
  bullet(doc, 'Run: ngrok http 3000');
  bullet(doc, 'Use the generated https://xxx.ngrok.io URL from any device');
  bullet(doc, 'Update your Twilio, Stripe, and Calendly webhook URLs to the ngrok URL');
  doc.moveDown(0.3);
  body(doc, 'If you set a DASHBOARD_PASSWORD in .env, you\'ll need to enter it to access the dashboard.');

  // ═══════════════════════════════════════════════════════
  // SECTION 7 — Keeping It Running
  // ═══════════════════════════════════════════════════════
  newSection(doc, '7. Keeping It Running');

  body(doc, 'After running install-service.js, the Mastermind starts automatically on boot and restarts on crash.');
  doc.moveDown(0.5);
  bullet(doc, 'Check health dots on the dashboard — all green means healthy');
  bullet(doc, 'Gold dots mean a service is not configured yet (fill in .env and restart)');
  bullet(doc, 'Red dots mean a service is down — check the event feed for details');
  bullet(doc, 'The system_logs Firestore collection has a complete audit trail');
  bullet(doc, 'Daily summary SMS arrives at 8 PM with revenue and activity stats');
  bullet(doc, 'Nightly maintenance (2–4:30 AM) runs health checks and reports');
  bullet(doc, 'NEVER leave the PC in sleep mode — disable all power saving');

  // ═══════════════════════════════════════════════════════
  // SECTION 8 — Troubleshooting
  // ═══════════════════════════════════════════════════════
  newSection(doc, '8. Troubleshooting');

  const issues = [
    ['Dashboard not loading', 'Check that the process is running: npm start. Check port 3000 is not blocked. Try http://127.0.0.1:3000 instead of localhost.'],
    ['Firebase health dot is red', 'Verify FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env. Make sure private key includes \\n line breaks and is wrapped in quotes.'],
    ['Twilio SMS not sending', 'Check TWILIO_ACCOUNT_SID, AUTH_TOKEN, and PHONE_NUMBER. Verify the phone number has SMS capability. Check Twilio console for error logs.'],
    ['Stripe payments not processing', 'Verify STRIPE_SECRET_KEY. Check webhook URL is reachable from the internet. Verify events selected in Stripe dashboard.'],
    ['Service won\'t start on boot', 'Re-run: node install-service.js. On Windows check Services panel. On Mac check ~/Library/LaunchAgents/ for the plist file.'],
    ['High memory usage', 'Restart the service. Check for stuck Firestore listeners. Minimum 4 GB RAM required.'],
    ['Webhooks timing out', 'If behind a firewall, configure port forwarding for port 3000. Use ngrok for testing.'],
  ];

  issues.forEach(([problem, solution]) => {
    doc.fontSize(11).fillColor(GOLD).font('Helvetica-Bold').text(problem);
    doc.fontSize(10).fillColor(WHITE).font('Helvetica').text(`  ${solution}`);
    doc.moveDown(0.5);
  });

  // ═══════════════════════════════════════════════════════
  // SECTION 9 — Contact
  // ═══════════════════════════════════════════════════════
  newSection(doc, '9. Contact');

  doc.fontSize(14).fillColor(GOLD).font('Helvetica-Bold').text('Isaak Thammavong');
  doc.fontSize(12).fillColor(WHITE).font('Helvetica').text('CEO — TrashApp Junk Removal');
  doc.moveDown(0.3);
  doc.fontSize(11).fillColor(MUTED).text('Phone: (559) 774-4249');
  doc.text('Email: isaak@igniscreatives.com');
  doc.text('Web: trashappjunkremoval.com');
  doc.moveDown(2);
  doc.fontSize(10).fillColor(MUTED).text('© TrashApp Junk Removal. All rights reserved.', { align: 'center' });

  // Finalize
  doc.end();

  stream.on('finish', () => {
    console.log(`✓ PDF generated: ${OUTPUT_PATH}`);
  });
}

// ─── Helpers ─────────────────────────────────────────────

function newSection(doc, title) {
  doc.addPage();
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(DARK_BG);
  doc.moveDown(0.5);
  doc.fontSize(24).fillColor(GOLD).font('Helvetica-Bold').text(title);
  doc.moveDown(0.3);
  doc.moveTo(60, doc.y).lineTo(doc.page.width - 60, doc.y).stroke(GOLD);
  doc.moveDown(0.8);
}

function subheading(doc, text) {
  doc.fontSize(14).fillColor(GOLD).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
}

function body(doc, text) {
  doc.fontSize(11).fillColor(WHITE).font('Helvetica').text(text, { lineGap: 2 });
}

function bullet(doc, text) {
  doc.fontSize(11).fillColor(WHITE).font('Helvetica').text(`  •  ${text}`, { lineGap: 1 });
}

// Run if called directly
if (require.main === module) {
  generatePDF();
}

module.exports = { generatePDF };
