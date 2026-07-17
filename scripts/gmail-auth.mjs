/* ============================================================
   One-time Gmail refresh-token helper — run LOCALLY, never in CI.

   The background sync worker (scripts/gmail-sync.mjs) needs offline
   Gmail access: a refresh token it can trade for a fresh access
   token on every scheduled run, with no browser and no consent
   screen. This script mints that token once:

     1. starts a tiny localhost HTTP server (the OAuth loopback
        redirect target),
     2. prints a Google consent URL for you to open in a browser,
     3. catches the authorization code on the redirect back,
     4. exchanges it for tokens and prints the refresh token with
        instructions to store it as the GMAIL_REFRESH_TOKEN repo
        secret.

   Use a "Desktop app" type OAuth client (create one in the same
   Google Cloud project — APIs & Services → Credentials → Create
   credentials → OAuth client ID → Desktop app). Desktop clients
   allow http://localhost loopback redirects out of the box; the
   project's existing client is a Web type whose redirect allowlist
   doesn't include localhost. Full steps (Windows/PowerShell):
   docs/background-sync-setup.md.

   Usage (PowerShell — one line each, no && chaining):
     $env:GMAIL_CLIENT_ID = "xxxxx.apps.googleusercontent.com"
     $env:GMAIL_CLIENT_SECRET = "GOCSPX-..."
     node scripts/gmail-auth.mjs
   or pass them as arguments:
     node scripts/gmail-auth.mjs <client_id> <client_secret>
   ============================================================ */

import http from "node:http";

const CLIENT_ID = process.argv[2] || process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.argv[3] || process.env.GMAIL_CLIENT_SECRET;
const PORT = Number(process.env.GMAIL_AUTH_PORT || 8765);
const REDIRECT_URI = `http://localhost:${PORT}`;
// gmail.readonly matches what the sync worker needs — same scope the app
// itself requests (minus the profile scopes it only uses for UI).
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing credentials. Provide GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET as env vars or arguments:");
  console.error("  node scripts/gmail-auth.mjs <client_id> <client_secret>");
  console.error("See docs/background-sync-setup.md for how to create the Desktop-app OAuth client.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    // access_type=offline + prompt=consent is what makes Google return a
    // refresh_token (a plain re-auth of an already-consented app doesn't).
    access_type: "offline",
    prompt: "consent",
  }).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  // Browsers also request /favicon.ico against the loopback server —
  // answer anything without a code with a 404 and keep waiting.
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h3>Authorization was denied — you can close this tab and re-run the script.</h3>");
    console.error(`\nGoogle returned an error: ${err}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json().catch(() => null);
    if (!tokenRes.ok || !tokens?.refresh_token) {
      throw new Error(`token exchange failed (HTTP ${tokenRes.status}): ${JSON.stringify(tokens || "").slice(0, 300)}`);
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h3>Done — the refresh token is in your terminal. You can close this tab.</h3>");
    console.log("\n================================================================");
    console.log("SUCCESS — your Gmail refresh token:\n");
    console.log(`  ${tokens.refresh_token}\n`);
    console.log("Store it (plus the client id/secret) as GitHub repo secrets:");
    console.log("  Settings → Secrets and variables → Actions → New repository secret");
    console.log("    GMAIL_CLIENT_ID     = the Desktop-app client id");
    console.log("    GMAIL_CLIENT_SECRET = the Desktop-app client secret");
    console.log("    GMAIL_REFRESH_TOKEN = the token printed above");
    console.log("\nKeep it private — it grants read access to this Gmail account");
    console.log("until revoked (https://myaccount.google.com/permissions).");
    console.log("================================================================");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/html" });
    res.end("<h3>Token exchange failed — see the terminal for details.</h3>");
    console.error(`\n${e.message}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("Listening on " + REDIRECT_URI + " — open this URL in your browser and approve access:\n");
  console.log(authUrl + "\n");
  console.log("(Sign in with the SAME Google account whose Temu emails the dashboard reads.");
  console.log(" The app is in Testing mode, so that account must be on the OAuth test-users list.)");
});
