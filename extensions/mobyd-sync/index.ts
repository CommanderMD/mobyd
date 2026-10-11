import { execFileSync } from "node:child_process";
// MOBY-D Sync — the nervous system (Mac → Moby Cloud half).
// After every agent turn, the owner's working context (last turns, open task, files touched)
// is written to D1 `sessions` so any door — TUI, Telegram, a future cloud Moby — picks up
// exactly where Commander left off. Heartbeats every N minutes; events are idempotent.
// Transport: HMAC-SHA256 signed JSON to moby-cloud. Secret from ~/.helix/keys.env, never the repo.
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

function expandHome(p: string) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
function textOf(m: any): string {
  const c = m?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .filter(Boolean)
      .join("\n");
  return typeof m?.text === "string" ? m.text : "";
}

export default definePluginEntry({
  id: "mobyd-sync",
  name: "MOBY-D Sync",
  description: "Keeps Moby Cloud's session record, events and heartbeats in step with the Mac",
  register(api: OpenClawPluginApi) {
    const log = api.logger;
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

    // Endpoint + secret from settings and the keys file (same pattern as NEMO's RAG client).
    let cloudUrl = "";
    let secret = "";
    let ownerId = String(cfg.ownerId ?? "");
    try {
      const s = JSON.parse(readFileSync(expandHome("~/.mobyd/mobyd-settings.json"), "utf8"));
      if (!ownerId && s.owner_telegram_id) ownerId = String(s.owner_telegram_id);
      if (s.cloud?.url) cloudUrl = String(s.cloud.url).replace(/\/$/, "");
      if (s.cloud?.secret_env && s.cloud?.secret_file) {
        const env = readFileSync(expandHome(String(s.cloud.secret_file)), "utf8");
        const m = env.match(new RegExp(`^${s.cloud.secret_env}=\\s*"?([^"\\n]+)"?`, "m"));
        if (m) secret = m[1].trim();
      }
    } catch {
      /* settings optional */
    }
    const ready = Boolean(cloudUrl && secret && ownerId);
    const host = String(cfg.host ?? "erics-mac-mini");
    const heartbeatMin = Number(cfg.heartbeatMinutes ?? 5);
    log.info(
      `[sync] ${ready ? `ready → ${cloudUrl} (owner ${ownerId})` : "not configured (settings.cloud / owner)"}`,
    );
    if (!ready) return;

    async function post(path: string, body: unknown): Promise<any> {
      const raw = JSON.stringify(body);
      const ts = String(Date.now());
      const sig = createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`${cloudUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Moby-Ts": ts, "X-Moby-Sig": sig },
          body: raw,
          signal: ctl.signal,
        });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) log.warn(`[sync] ${path} HTTP ${r.status}: ${clip(JSON.stringify(j), 120)}`);
        return j;
      } catch (e) {
        log.warn(`[sync] ${path} failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
        return undefined;
      } finally {
        clearTimeout(t);
      }
    }

    // Working context per session key: last 20 turns, files touched this session.
    const turns = new Map<string, Array<{ role: string; text: string; ts: string }>>();
    const files = new Map<string, Set<string>>();

    api.on("message_received", (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? event.sessionKey ?? "default");
      const arr = turns.get(key) ?? [];
      arr.push({
        role: "user",
        text: clip(String(event.content ?? ""), 600),
        ts: new Date().toISOString(),
      });
      turns.set(key, arr.slice(-20));
    });

    api.on("before_tool_call", (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      const set = files.get(key) ?? new Set<string>();
      for (const p of event.derivedPaths ?? []) set.add(String(p));
      const params = event.params ?? {};
      for (const v of [params.path, params.file, params.filePath])
        if (typeof v === "string") set.add(v);
      files.set(key, set);
      return undefined;
    });

    // 1. After every turn: the handoff record. This is what "one Moby, one memory" rests on.
    api.on("agent_end", async (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      const arr = turns.get(key) ?? [];
      const msgs = Array.isArray(event.messages) ? event.messages : [];
      // Take the turn's own user message when no channel hook recorded it (CLI path).
      const lastUserMsg = [...msgs].reverse().find((m: any) => m?.role === "user");
      const lastUserText = lastUserMsg ? clip(textOf(lastUserMsg), 600) : "";
      if (lastUserText && !arr.some((t) => t.role === "user" && t.text === lastUserText))
        arr.push({ role: "user", text: lastUserText, ts: new Date().toISOString() });
      const last = [...msgs].reverse().find((m: any) => m?.role === "assistant");
      if (last)
        arr.push({
          role: "assistant",
          text: clip(textOf(last), 600),
          ts: new Date().toISOString(),
        });
      turns.set(key, arr.slice(-20));
      const lastUser = [...arr].reverse().find((t) => t.role === "user");
      const r = await post("/sync/session", {
        owner_id: ownerId,
        active_thread_id: key,
        last_turns: arr.slice(-20),
        open_task: lastUser ? clip(lastUser.text, 200) : null,
        working_files: [...(files.get(key) ?? [])].slice(-30),
        updated_by: "mac",
      });
      if (r?.ok) log.info(`[sync] session → cloud (${r.turns} turns, ${key})`);
      void post("/sync/event", {
        event_id: randomUUID(),
        type: "session.turn",
        payload: { session: key, success: event.success !== false, ms: event.durationMs ?? null },
        sender: "mac",
        ts: new Date().toISOString(),
      });
    });

    // 2. Heartbeat: liveness + the few numbers a cloud Moby needs to answer "is the Mac up?"
    const beat = async () => {
      let disk_free_gb: number | null = null;
      try {
        // df -k on the Data volume (the real Mac); column 4 is available KB.
        const out = execFileSync("df", ["-k", "/System/Volumes/Data"], {
          encoding: "utf8",
          timeout: 5000,
        });
        const cols = out.trim().split("\n").pop()?.split(/\s+/) ?? [];
        if (cols[3]) disk_free_gb = Math.round(Number(cols[3]) / 1024 / 1024);
      } catch {
        /* leave null */
      }
      const r = await post("/sync/heartbeat", {
        host,
        status: {
          load: Number(loadavg()[0].toFixed(2)),
          disk_free_gb,
          pid: process.pid,
          uptime_s: Math.round(process.uptime()),
        },
      });
      if (r?.ok) log.info("[sync] heartbeat");
    };
    void beat();
    const timer = setInterval(beat, Math.max(1, heartbeatMin) * 60_000);
    timer.unref?.();
    log.info(`[sync] registered — heartbeat every ${heartbeatMin} min`);
  },
});
