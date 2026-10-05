/* ── Setup — fill in your values, run setupConfig() once, done ──────── */

function setupConfig() {
  PropertiesService.getScriptProperties().setProperties({

    // General
    GMAIL_USER: 'yourname', // part before the @
    GMAIL_DOMAIN: 'gmail.com', // 'gmail.com' or your Workspace domain

    // Alias labeler
    ALLOWED_DOMAINS_JSON: JSON.stringify([
      'yourdomain.com',
      'icloud.com',
    ]),

    // Booking scanner
    TICKETS_FOLDER_ID: '', // Drive folder ID (from folder URL)

    // Layer 3 AI extraction — optional. Only Claude or Gemini models for now.
    AI_MODEL: '',
    AI_API_KEY: '',

  }, true);
}

function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runAll')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runAll').timeBased().everyMinutes(15).create();
  console.log('Trigger installed: runAll() every 15 minutes.');
}

/* ── Feature flags ──────────────────────────────────────────────────── */

const FEATURES = {
  aliasLabeler: true,
  bookingScanner: true,
};

/* ── Booking scanner ────────────────────────────────────────────────── */

const BC = {
  CALENDAR_ID: 'primary',
  TIMEZONE: 'Europe/Paris',
};
