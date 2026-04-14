/**
 * install-service.js — Register TrashApp Mastermind as a system service
 * Windows: uses node-windows to create a Windows Service
 * Mac: creates a launchd plist for auto-start on login
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const SERVICE_NAME = 'TrashApp Mastermind';
const DESCRIPTION = 'TrashApp AI Dispatch Brain — runs the automated dispatch pipeline and dashboard';
const SCRIPT_PATH = path.join(__dirname, 'index.js');

async function install() {
  const platform = os.platform();
  console.log(`\n  TrashApp Mastermind — Service Installer`);
  console.log(`  Platform: ${platform}`);
  console.log(`  Script: ${SCRIPT_PATH}\n`);

  if (platform === 'win32') {
    await installWindows();
  } else if (platform === 'darwin') {
    await installMac();
  } else {
    console.log('  Unsupported platform. Supported: Windows (win32), macOS (darwin)');
    console.log('  On Linux, consider using systemd or pm2 to run as a service.');
    createPM2Config();
  }

  // Auto-open browser
  try {
    const open = require('open');
    const port = process.env.DASHBOARD_PORT || 3000;
    console.log(`\n  Opening dashboard at http://localhost:${port} ...`);
    await open(`http://localhost:${port}`);
  } catch (err) {
    console.log(`  Could not auto-open browser: ${err.message}`);
    console.log(`  Open manually: http://localhost:${process.env.DASHBOARD_PORT || 3000}`);
  }
}

async function installWindows() {
  try {
    const { Service } = require('node-windows');

    const svc = new Service({
      name: SERVICE_NAME,
      description: DESCRIPTION,
      script: SCRIPT_PATH,
      nodeOptions: [],
      env: [
        { name: 'NODE_ENV', value: 'production' },
      ],
    });

    svc.on('install', () => {
      console.log('  ✓ Windows Service installed successfully!');
      console.log('  ✓ Service starts automatically on boot.');
      console.log('  ✓ Auto-restarts on crash.');
      svc.start();
      console.log('  ✓ Service started.');
      console.log('\n  Manage via: services.msc (Windows Services panel)');
      console.log(`  Service name: "${SERVICE_NAME}"`);
    });

    svc.on('alreadyinstalled', () => {
      console.log('  ✓ Service already installed. Starting...');
      svc.start();
    });

    svc.on('error', (err) => {
      console.error('  ✗ Service install error:', err.message || err);
    });

    console.log('  Installing Windows Service...');
    svc.install();
  } catch (err) {
    console.error('  ✗ node-windows not available:', err.message);
    console.log('  Install it: npm install node-windows');
    console.log('  Fallback: Use PM2 or Task Scheduler to run on startup.');
  }
}

async function installMac() {
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, 'com.trashapp.mastermind.plist');
  const nodePath = process.execPath;
  const workingDir = __dirname;
  const logDir = path.join(os.homedir(), 'Library', 'Logs', 'TrashAppMastermind');

  // Ensure log directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.trashapp.mastermind</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${SCRIPT_PATH}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${workingDir}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logDir}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${logDir}/stderr.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>`;

  // Write plist
  fs.writeFileSync(plistPath, plistContent);
  console.log(`  ✓ Plist written to: ${plistPath}`);

  // Load the agent
  const { execSync } = require('child_process');
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
  } catch (_) {}

  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
    console.log('  ✓ LaunchAgent loaded successfully!');
    console.log('  ✓ Starts automatically on login.');
    console.log('  ✓ Auto-restarts on crash (KeepAlive=true).');
    console.log(`\n  Logs: ${logDir}/`);
    console.log(`  Manage: launchctl start/stop com.trashapp.mastermind`);
    console.log(`  Uninstall: launchctl unload "${plistPath}" && rm "${plistPath}"`);
  } catch (err) {
    console.error('  ✗ launchctl load failed:', err.message);
    console.log(`  Try manually: launchctl load "${plistPath}"`);
  }
}

function createPM2Config() {
  const pm2Config = {
    apps: [{
      name: 'trashapp-mastermind',
      script: 'index.js',
      cwd: __dirname,
      env: { NODE_ENV: 'production' },
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
    }],
  };

  const configPath = path.join(__dirname, 'ecosystem.config.js');
  fs.writeFileSync(configPath, `module.exports = ${JSON.stringify(pm2Config, null, 2)};\n`);
  console.log(`  ✓ PM2 config written to: ${configPath}`);
  console.log('  Run: pm2 start ecosystem.config.js');
  console.log('  Auto-start: pm2 startup && pm2 save');
}

// Run
console.log('\n  TrashApp Mastermind registered as system service. Starts automatically on boot.\n');
install().catch(console.error);
