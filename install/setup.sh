#!/bin/bash
echo "🚀 TrashApp Mastermind — PC Setup"
echo "=================================="

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Installing via Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew install node
else
  echo "✅ Node.js $(node -v) found"
fi

# Check git
if ! command -v git &> /dev/null; then
  echo "Installing git..."
  brew install git
fi

# Clone repo
INSTALL_DIR="$HOME/Desktop/Trashapp/Mastermind"
if [ -d "$INSTALL_DIR" ]; then
  echo "📁 Mastermind folder found — pulling latest..."
  cd "$INSTALL_DIR" && git pull origin main
else
  echo "📦 Cloning Mastermind repo..."
  mkdir -p "$HOME/Desktop/Trashapp"
  git clone https://github.com/isaak-stack/trashapp-mastermind.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install dependencies
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR" && npm install

# Create .env if it doesn't exist
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "⚙️  Creating .env file..."
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "⚠️  ACTION REQUIRED: Fill in your .env file"
  echo "Open: $INSTALL_DIR/.env"
  echo "Add all credentials from your records"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
  echo "✅ .env file found"
fi

# Run verification
echo ""
echo "🔍 Running verification..."
node "$INSTALL_DIR/install/verify.js"

# Install as background service
echo ""
echo "⚙️  Installing as auto-start service..."
node "$INSTALL_DIR/install-service.js"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ TrashApp AI OS installed successfully"
echo "Dashboard: http://localhost:3000"
echo "To start manually: cd ~/Desktop/Trashapp/Mastermind && node index.js"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
