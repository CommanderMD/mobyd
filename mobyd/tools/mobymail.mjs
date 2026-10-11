#!/usr/bin/env node
// mobymail — MOBY-D's email hand (Microsoft Graph, delegated, device-code sign-in).
//   mobymail login                      one-time: prints Microsoft's device code, waits for Commander
//   mobymail whoami
//   mobymail list [--n 10] [--unread]   inbox summary (read-only)
//   mobymail read <id>                  one message, text body (read-only)
//   mobymail search "<query>" [--n 10]  (read-only)
//   mobymail send --to a@b.c --subject "..." --body "..." [--cc x@y.z]   (hard stop: sends to a human)
// Tokens: ~/.mobyd/secrets/ms-graph.<account>.json (0600), one per mailbox. --account <address> picks one;
// settings.mail.default otherwise. Refresh token only; access tokens are re-minted.
// No secrets in this file: a public client has none. Client/tenant ids from ~/.mobyd/mobyd-settings.json.
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS = join(homedir(), ".mobyd/mobyd-settings.json");
const SECRETS_DIR = join(homedir(), ".mobyd/secrets");
// One token file per mailbox: ms-graph.<account>.json. --account picks one; settings.mail.default otherwise.
function tokenPath(acct) {
  return join(
    SECRETS_DIR,
    `ms-graph.${String(acct)
      .toLowerCase()
      .replace(/[^a-z0-9@._-]/g, "_")}.json`,
  );
}
const SCOPES =
  "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read offline_access";
const GRAPH = "https://graph.microsoft.com/v1.0";

const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
const { client_id, tenant_id } = settings.mail ?? {};
if (!client_id || !tenant_id)
  die("settings.mail.client_id / tenant_id missing in ~/.mobyd/mobyd-settings.json");
const ACCOUNTS = settings.mail?.accounts ?? (settings.mail?.account ? [settings.mail.account] : []);
function pickAccount() {
  const i = process.argv.indexOf("--account");
  const want = i > -1 ? process.argv[i + 1] : (settings.mail?.default ?? ACCOUNTS[0]);
  if (!want) die("no mailbox configured — run: mobymail login --account <address>");
  const match = ACCOUNTS.find(
    (a) =>
      a.toLowerCase() === String(want).toLowerCase() ||
      a.toLowerCase().includes(String(want).toLowerCase()),
  );
  return match ?? String(want);
}
const ACCOUNT = pickAccount();
const TOKENS = tokenPath(ACCOUNT);
const AUTH = `https://login.microsoftonline.com/${tenant_id}/oauth2/v2.0`;

function die(msg, code = 1) {
  console.error(`mobymail: ${msg}`);
  process.exit(code);
}
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
async function form(url, data) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
function saveTokens(t, acct = ACCOUNT) {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const path = tokenPath(acct);
  writeFileSync(
    path,
    JSON.stringify(
      { refresh_token: t.refresh_token, account: acct, saved_at: new Date().toISOString() },
      null,
      2,
    ),
  );
  chmodSync(path, 0o600);
}
async function accessToken() {
  if (!existsSync(TOKENS))
    die(`${ACCOUNT}: not signed in — run: mobymail login --account ${ACCOUNT}`);
  const stored = JSON.parse(readFileSync(TOKENS, "utf8"));
  const { status, json } = await form(`${AUTH}/token`, {
    client_id,
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    scope: SCOPES,
  });
  if (status !== 200 || !json.access_token)
    die(
      `token refresh failed (${status}): ${json.error_description ?? json.error ?? "unknown"} — run: mobymail login`,
    );
  if (json.refresh_token) saveTokens({ ...stored, refresh_token: json.refresh_token });
  return json.access_token;
}
async function graph(path, init = {}) {
  const tok = await accessToken();
  const r = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 202 || r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok)
    die(`Graph ${r.status} on ${path}: ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const esc = (s) => String(s).replace(/'/g, "''");

async function login() {
  const { status, json } = await form(`${AUTH}/devicecode`, { client_id, scope: SCOPES });
  if (status !== 200 || !json.device_code)
    die(
      `device code request failed (${status}): ${json.error_description ?? JSON.stringify(json)}`,
    );
  // This is Microsoft's own message — the only place a code is ever shown.
  console.log(`\n${json.message}\n`);
  console.log(`(expires in ${Math.round(json.expires_in / 60)} min; waiting…)`);
  const interval = (json.interval ?? 5) * 1000;
  const deadline = Date.now() + json.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const t = await form(`${AUTH}/token`, {
      client_id,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: json.device_code,
    });
    if (t.status === 200 && t.json.access_token) {
      const me = await fetch(`${GRAPH}/me`, {
        headers: { Authorization: `Bearer ${t.json.access_token}` },
      }).then((r) => r.json());
      const real = (me.mail ?? me.userPrincipalName ?? ACCOUNT).toLowerCase();
      saveTokens({ refresh_token: t.json.refresh_token }, real);
      // register the mailbox in settings so --account can find it next time
      const cur = JSON.parse(readFileSync(SETTINGS, "utf8"));
      cur.mail.accounts = [...new Set([...(cur.mail.accounts ?? []), real])];
      if (!cur.mail.default) cur.mail.default = real;
      delete cur.mail.account;
      writeFileSync(SETTINGS, JSON.stringify(cur, null, 2));
      console.log(`signed in as ${real} — tokens saved to ${tokenPath(real)}`);
      return;
    }
    const e = t.json.error;
    if (e === "authorization_pending" || e === "slow_down") {
      process.stdout.write(".");
      continue;
    }
    die(`sign-in failed: ${e} — ${t.json.error_description ?? ""}`);
  }
  die("device code expired before sign-in completed");
}

async function whoami() {
  const me = await graph("/me?$select=displayName,mail,userPrincipalName");
  console.log(`${me.displayName} <${me.mail ?? me.userPrincipalName}>`);
}
async function list() {
  const n = Number(arg("n", 10));
  const unread = flag("unread");
  const q = `/me/mailFolders/inbox/messages?$top=${n}&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,isRead,bodyPreview${unread ? "&$filter=isRead eq false" : ""}`;
  const j = await graph(q);
  for (const m of j.value ?? [])
    console.log(
      `${m.isRead ? " " : "*"} ${m.receivedDateTime.slice(0, 16).replace("T", " ")}  ${(m.from?.emailAddress?.address ?? "?").padEnd(32)}  ${m.subject ?? "(no subject)"}\n    id=${m.id}\n    ${(m.bodyPreview ?? "").replace(/\s+/g, " ").slice(0, 140)}`,
    );
  if (!(j.value ?? []).length) console.log("(no messages)");
}
async function read(id) {
  if (!id) die("usage: mobymail read <id>");
  const m = await graph(
    `/me/messages/${encodeURIComponent(id)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } },
  );
  console.log(
    `From: ${m.from?.emailAddress?.name ?? ""} <${m.from?.emailAddress?.address ?? ""}>\nTo: ${(m.toRecipients ?? []).map((r) => r.emailAddress.address).join(", ")}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject}\n\n${m.body?.content ?? ""}`,
  );
}
async function search(q) {
  if (!q) die('usage: mobymail search "<query>"');
  const n = Number(arg("n", 10));
  const j = await graph(
    `/me/messages?$search="${esc(q)}"&$top=${n}&$select=id,subject,from,receivedDateTime,isRead`,
  );
  for (const m of j.value ?? [])
    console.log(
      `${m.receivedDateTime.slice(0, 16).replace("T", " ")}  ${(m.from?.emailAddress?.address ?? "?").padEnd(32)}  ${m.subject}\n    id=${m.id}`,
    );
  if (!(j.value ?? []).length) console.log("(no matches)");
}
async function send() {
  const to = arg("to"),
    subject = arg("subject"),
    body = arg("body"),
    cc = arg("cc");
  if (!to || !subject || body == null)
    die('usage: mobymail send --to a@b.c --subject "..." --body "..." [--cc x@y.z]');
  const rcpt = (s) => s.split(",").map((a) => ({ emailAddress: { address: a.trim() } }));
  await graph("/me/sendMail", {
    method: "POST",
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: rcpt(to),
        ...(cc ? { ccRecipients: rcpt(cc) } : {}),
      },
      saveToSentItems: true,
    }),
  });
  console.log(`sent from ${ACCOUNT} to ${to}: "${subject}"`);
}

const cmd = process.argv[2];
const run = {
  login,
  whoami,
  list,
  read: () => read(process.argv[3]),
  search: () => search(process.argv[3]),
  send,
}[cmd];
if (!run)
  die("commands: login | whoami | list | read <id> | search <q> | send --to --subject --body");
run().catch((e) => die(e.message ?? String(e)));
