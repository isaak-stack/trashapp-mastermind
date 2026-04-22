# TrashApp Security Configuration

## Google Maps API Key Restriction

The Google Maps API key (`AIzaSyDtkh_G25Kr6YaAeNJOd9D9YJuyZnKvu08`) is currently unrestricted. Before launch, restrict it to prevent unauthorized usage and billing.

### Steps

1. Go to [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services** → **Credentials**
2. Find the **Browser key (auto created by Firebase)** — this is the key used in the TrashApp HTML files
3. Click the key to edit it
4. Under **Application restrictions**, select **HTTP referrers (websites)**
5. Under **Website restrictions**, add these referrer patterns:
   - `*.trashappjunkremoval.com/*`
   - `trashappjunkremoval.com/*`
   - `localhost/*`
   - `127.0.0.1/*`
6. Click **Save**

### APIs to Enable

Ensure these APIs are enabled for the project:
- Maps JavaScript API
- Places API
- Geocoding API

### Firebase API Keys

Firebase API keys (`AIzaSyCtl7TaehqrgDCHhgNhOe5URh7YXfCzY8E`) are safe to expose in client code — Firebase security is enforced by Firestore Security Rules, not API keys. However, ensure Firestore rules (`firestore.rules`) are properly configured before launch.

### Environment Variables (Server-Side)

These must NEVER be committed to git or exposed in client code:
- `STRIPE_SECRET_KEY` — Stripe API secret key
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — Twilio credentials
- `FB_SERVICE_ACCOUNT` — Firebase Admin SDK service account
- `ANTHROPIC_API_KEY` — Claude API key

### Stripe Configuration

- Verify you are using **live keys** (`sk_live_*`) in production, not test keys (`sk_test_*`)
- Set up webhook signing secrets for `/webhooks/stripe`
- Restrict Stripe API key to only necessary permissions

### Twilio Configuration

- Use a dedicated Twilio number for production
- Set up webhook URL validation
- Enable TLS for all webhook endpoints
