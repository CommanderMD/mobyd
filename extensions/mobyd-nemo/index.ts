import { execFile } from "node:child_process";
// NEMO — the head of MOBY-D.
// Every inbound message becomes a typed decision (intent, risk, needs_rag, complexity, requires_approval)
// before the model sees it and before any tool runs. Policy (policy/mobyd-policy.yaml) overrides NEMO.
// Fail closed: if NEMO cannot load, chat still works but every tool call needs Commander's approval.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import YAML from "yaml";

type Decision = {
  ts: string;
  sessionKey: string;
  sender_is_owner: boolean;
  channel: string;
  intent: string;
  intent_p: number;
  risk: string;
  risk_p: number;
  needs_rag: number;
  complexity: number;
  requires_approval: number;
  policy_rule: string;
  outcome: "chat_only" | "approval_required" | "autonomous_ok" | "tier3";
  nemo_offline: boolean;
  text_preview: string;
};

const RISKY_TOOL =
  /exec|shell|bash|command|write|edit|patch|delete|remove|unlink|send|deploy|publish|git|wrangler|install|trade|order|pay/i;
const READONLY_TOOL =
  /^(read|list|search|find|get|stat|glob|grep|memory|recall|fetch|browse|view|status|time|calc)/i;

// Command-level read-only classifier. NEMO's risk score is advisory; what actually
// runs is what we judge. Every pipeline segment must start with an allowlisted
// binary and the whole string must be free of write/privilege operators.
const READONLY_BIN = new Set([
  "df",
  "du",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "find",
  "grep",
  "rg",
  "egrep",
  "pwd",
  "whoami",
  "id",
  "uname",
  "uptime",
  "date",
  "hostname",
  "sw_vers",
  "system_profiler",
  "ps",
  "top",
  "lsof",
  "netstat",
  "ifconfig",
  "ping",
  "nslookup",
  "dig",
  "which",
  "type",
  "env",
  "printenv",
  "echo",
  "printf",
  "true",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "tr",
  "jq",
  "xargs",
  "diff",
  "cmp",
  "md5",
  "shasum",
  "base64",
  "wc",
  "tree",
  "ioreg",
  "sysctl",
  "vm_stat",
  "diskutil",
  "git",
  "node",
  "python3",
  "pnpm",
  "npm",
  "wrangler",
  "mobymail",
]);
const READONLY_SUBCMD: Record<string, RegExp> = {
  git: /^(status|log|diff|show|branch|remote|rev-parse|ls-files|describe|tag|stash list|config --get)/,
  node: /^(-v|--version)/,
  python3: /^(-V|--version)/,
  pnpm: /^(-v|--version|ls|list|why)/,
  npm: /^(-v|--version|ls|view|outdated)/,
  wrangler:
    /^(whoami|--version|d1 list|kv namespace list|r2 bucket list|secret list|deployments list)/,
  diskutil: /^(list|info)/,
  mobymail: /^(whoami|list|read|search)\b/,
  sed: /^(?![^|]*\s-i)/,
  xargs: /^(ls|cat|wc|grep|head|tail|stat|file)\b/,
};
const WRITE_OPERATORS =
  /(>>?|\bsudo\b|\brm\b|\bmv\b|\bcp\b|\btee\b|\bchmod\b|\bchown\b|\bkill\b|\bpkill\b|\bcurl\b|\bwget\b|\bdd\b|\bmkfs|\bbrew\b|\bapt\b|\bsh -c\b|\bbash -c\b|\beval\b|\bexec\b|\$\(|`|\bosascript\b|\blaunchctl\b|\bdefaults write\b|\bkillall\b|\bopen\b)/;

function commandsFromParams(params: any): string[] {
  const out: string[] = [];
  const grab = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v);
  };
  if (!params || typeof params !== "object") return out;
  const looksLikeCode = (s: string) => /\b(await|return|require|const|let|exec\s*\()/.test(s);
  const fromCode = (code: string) => {
    // code-mode: exec({ command: "..." }) or execSync('...') wrappers
    const found: string[] = [];
    for (const m of code.matchAll(
      /(?:exec\s*\(\s*\{\s*command\s*:|execSync\s*\(|exec\s*\()\s*(["'`])([\s\S]*?)\1/g,
    ))
      found.push(m[2]);
    if (found.length === 0 && /child_process|exec\s*\(|require\s*\(|fs\./.test(code))
      found.push("__opaque__");
    return found;
  };
  for (const v of [params.command, params.cmd, params.script]) {
    if (typeof v !== "string" || !v.trim()) continue;
    if (looksLikeCode(v)) out.push(...fromCode(v));
    else grab(v);
  }
  if (typeof params.code === "string") out.push(...fromCode(params.code));
  // de-dupe: code-mode mirrors `code` into `command`
  return [...new Set(out)];
}

function isReadOnlyCommand(cmd: string): boolean {
  if (cmd === "__opaque__") return false;
  cmd = cmd.replace(/2>\s*(\/dev\/null|&1)/g, " ");
  if (WRITE_OPERATORS.test(cmd)) return false;
  const segments = cmd
    .split(/\|\||&&|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => {
    const [bin, ...rest] = seg.replace(/^\s*(env\s+)?([A-Z_]+=\S+\s+)*/, "").split(/\s+/);
    if (!READONLY_BIN.has(bin)) return false;
    const sub = READONLY_SUBCMD[bin];
    return sub ? sub.test(rest.join(" ")) : true;
  });
}

// Hard stops — the only things that cost Commander a tap. Everything else he asked for
// runs and is logged ("if there is no real danger of losing money, messing up a system,
// or breaking the law, finish the mission"). NEMO's risk score never reaches this gate.
const SANDBOX_ROOTS = ["/Volumes/MOBY_D/COMMANDERS ULTIMATE PLAN", "~/.mobyd", "/tmp"];
const HARD_STOP_PATTERNS: Array<[RegExp, string]> = [
  [/\bsudo\b|\bsu\b\s/, "privilege escalation"],
  [/\b(mkfs|diskutil\s+(erase|partition|apfs\s+delete)|dd\s+if=|fdisk)\b/, "disk destruction"],
  [
    /\b(launchctl|defaults\s+write|osascript|crontab|systemsetup|scutil|networksetup|pmset)\b/,
    "system settings",
  ],
  [/\bgit\s+push\b|\bgit\s+(reset\s+--hard|clean\s+-f|branch\s+-D)/, "git publish / destructive"],
  [
    /\bwrangler\s+(deploy|delete|secret|d1\s+execute|r2\s+bucket\s+delete|kv\s+key\s+delete)/,
    "cloud deploy / mutate",
  ],
  [/\b(npm|pnpm)\s+publish\b|\bgh\s+(release|repo\s+delete|pr\s+merge)/, "publish / merge"],
  [
    /\bcurl\b[^|;]*\s-(X\s*(POST|PUT|PATCH|DELETE)|d\b|-data)|\bwget\b.*--post/,
    "mutating network call",
  ],
  [/\b(ssh|scp|rsync)\b\s+\S*@/, "remote host"],
  [/\bkill(all)?\b|\bpkill\b/, "process kill"],
  [/\b(chmod|chown)\b\s+(-R\s+)?\S+\s+\/(System|usr|bin|etc|Library)/, "system permissions"],
  [
    /\b(buy|sell|trade|order|pay|transfer|withdraw|deposit)\b.*\b(btc|eth|usd|\$\d|shares|contract)/i,
    "money",
  ],
  [
    /\b(mail|sendmail|himalaya\s+(send|reply)|telegram.*send|sms|twilio)\b|\bmobymail\s+send\b/i,
    "sends to a human",
  ],
];
const DELETE_CMD = /\b(rm|rmdir|unlink|trash|shred)\b\s+(-[a-zA-Z]+\s+)*(\S+)/g;
function underSandbox(path: string): boolean {
  const p = path.replace(/^["']|["']$/g, "").replace(/^~/, homedir());
  return SANDBOX_ROOTS.some((r) => p.startsWith(r.replace(/^~/, homedir())));
}
function hardStopReason(cmd: string): string | undefined {
  for (const [re, why] of HARD_STOP_PATTERNS) if (re.test(cmd)) return why;
  for (const m of cmd.matchAll(DELETE_CMD))
    if (!underSandbox(m[3])) return `delete outside sandbox (${m[3]})`;
  for (const m of cmd.matchAll(/(?<![<>&\d])>{1,2}\s*(\S+)/g)) {
    const t = m[1];
    if (t !== "/dev/null" && !t.startsWith("&") && !underSandbox(t) && /^[~\/]/.test(t))
      return `writes outside sandbox (${t})`;
  }
  for (const m of cmd.matchAll(/\b(mv|cp)\b\s+(?:-\S+\s+)*\S+\s+(\S+)/g)) {
    if (/^[~\/]/.test(m[2]) && !underSandbox(m[2])) return `${m[1]} outside sandbox (${m[2]})`;
  }
  return undefined;
}
const HARD_STOP_TOOLS =
  /^(message|tts|sessions_send|mail|email|send|deploy|publish|pay|trade|order)$/i;

function expandHome(p: string) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}
function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default definePluginEntry({
  id: "mobyd-nemo",
  name: "NEMO (MOBY-D head)",
  description: "Typed decisions + policy gate on every message",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const log = api.logger;
    const pluginRoot = api.rootDir ?? api.resolvePath(".");
    const repoRoot = String(cfg.repoRoot || resolve(pluginRoot, "..", ".."));
    const decisionLog = expandHome(String(cfg.decisionLog || "~/.mobyd/decisions.jsonl"));
    const threshold = Number(cfg.autonomousConfidence ?? 0.75);
    const advisoryOnly = Boolean(cfg.advisoryOnly ?? false);

    // Owner identity comes from config / settings file, never from message text.
    let ownerIds = new Set<string>((cfg.ownerIds as string[] | undefined) ?? []);
    // RAG lives behind moby-router (/rag/search, /rag/put). URL + secret come from
    // ~/.mobyd/mobyd-settings.json and the keys file it points at — never from the repo.
    let ragUrl = "";
    let ragSecret = "";
    try {
      const s = JSON.parse(readFileSync(expandHome("~/.mobyd/mobyd-settings.json"), "utf8"));
      if (s.owner_telegram_id) ownerIds.add(String(s.owner_telegram_id));
      if (s.router?.url) ragUrl = String(s.router.url).replace(/\/$/, "");
      if (s.router?.secret_env && s.router?.secret_file) {
        const env = readFileSync(expandHome(String(s.router.secret_file)), "utf8");
        const m = env.match(new RegExp(`^${s.router.secret_env}=\\s*"?([^"\\n]+)"?`, "m"));
        if (m) ragSecret = m[1].trim();
      }
    } catch {
      /* settings file optional */
    }
    const ragReady = Boolean(ragUrl && ragSecret);
    log.info(`[nemo] rag ${ragReady ? "ready → " + ragUrl : "not configured (settings.router)"}`);

    type RagChunk = { text: string; key: string; score: number };
    async function ragSearch(q: string, n = 4): Promise<RagChunk[]> {
      if (!ragReady) return [];
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      try {
        const r = await fetch(`${ragUrl}/rag/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Router-Secret": ragSecret },
          body: JSON.stringify({ q, n }),
          signal: ctl.signal,
        });
        if (!r.ok) {
          log.warn(`[nemo] rag search HTTP ${r.status}`);
          return [];
        }
        const j: any = await r.json();
        return (j.chunks ?? []) as RagChunk[];
      } catch (e) {
        log.warn(`[nemo] rag search failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
        return [];
      } finally {
        clearTimeout(t);
      }
    }
    async function ragPut(key: string, text: string, metadata?: Record<string, string>) {
      if (!ragReady) throw new Error("RAG not configured (settings.router)");
      const r = await fetch(`${ragUrl}/rag/put`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Router-Secret": ragSecret },
        body: JSON.stringify({ key, text, metadata }),
      });
      const j: any = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return j as { key: string; bytes: number };
    }

    let questions: Record<string, unknown> = {};
    let policy: any = { rules: [], thresholds: {} };
    let actions: Record<string, { risk?: string }> = {};
    try {
      questions = JSON.parse(readFileSync(join(repoRoot, "mobyd/nemo/questions.json"), "utf8"));
      delete (questions as any)._comment;
      policy = YAML.parse(readFileSync(join(repoRoot, "policy/mobyd-policy.yaml"), "utf8"));
      actions = JSON.parse(readFileSync(join(repoRoot, "policy/actions.json"), "utf8"));
      delete (actions as any)._comment;
      log.info(
        `[nemo] loaded ${Object.keys(questions).length} questions, ${policy.rules?.length ?? 0} policy rules, ${Object.keys(actions).length} actions from ${repoRoot}`,
      );
    } catch (err) {
      log.warn(
        `[nemo] could not load questions/policy/actions: ${String(err)} — running fail-closed`,
      );
    }

    // Lazy singleton for the model. ~1.7 GB RSS, ~0.5 s per decision on the M4.
    let nemoPromise: Promise<any> | null = null;
    let nemoOffline = false;
    const getNemo = () => {
      if (!nemoPromise) {
        nemoPromise = import("@receptron/laya")
          .then(async (m: any) => {
            const n = await m.Laya.load({ sessionOptions: { intraOpNumThreads: 6 } });
            log.info("[nemo] model loaded");
            return n;
          })
          .catch((err: unknown) => {
            nemoOffline = true;
            log.warn(`[nemo] model failed to load, fail-closed: ${String(err)}`);
            return null;
          });
      }
      return nemoPromise;
    };
    void getNemo();

    // Decisions keyed by every session identifier the hooks hand us (message_received and
    // before_tool_call do not always agree), plus a short-lived "latest" fallback so a key
    // mismatch degrades to the most recent verdict instead of fail-closed on Commander.
    const decisions = new Map<string, Decision>();
    let latest: { d: Decision; at: number } | undefined;
    const remember = (d: Decision, ...keys: unknown[]) => {
      for (const k of keys) if (k) decisions.set(String(k), d);
      latest = { d, at: Date.now() };
    };
    const lookup = (...keys: unknown[]): Decision | undefined => {
      for (const k of keys) {
        const d = k ? decisions.get(String(k)) : undefined;
        if (d) return d;
      }
      return latest && Date.now() - latest.at < 180_000 ? latest.d : undefined;
    };

    function applyPolicy(
      d: Omit<Decision, "policy_rule" | "outcome">,
    ): Pick<Decision, "policy_rule" | "outcome"> {
      if (!d.sender_is_owner) return { policy_rule: "non-owner-chat-only", outcome: "chat_only" };
      if (d.nemo_offline) return { policy_rule: "fail-closed", outcome: "approval_required" };
      if (["spends_money", "touches_prod", "irreversible"].includes(d.risk))
        return {
          policy_rule: "money-prod-irreversible-need-approval",
          outcome: "approval_required",
        };
      if (d.intent === "deploy")
        return { policy_rule: "deploy-must-be-allowlisted", outcome: "approval_required" };
      if (d.intent === "trade")
        return { policy_rule: "trade-read-only-for-now", outcome: "approval_required" };
      if (d.risk === "writes_files")
        return {
          policy_rule: "writes-need-approval-unless-sandboxed",
          outcome: "approval_required",
        };
      if (d.intent_p < threshold)
        return { policy_rule: "low-confidence-falls-to-llm", outcome: "tier3" };
      if (["chat", "lookup", "code"].includes(d.intent))
        return { policy_rule: "generation-needed", outcome: "tier3" };
      return { policy_rule: "read-only-autonomous-when-confident", outcome: "autonomous_ok" };
    }

    async function decide(
      sessionKey: string,
      text: string,
      senderId: string | undefined,
      channel: string,
    ): Promise<Decision> {
      // Local doors (TUI/CLI/webchat) sit behind the gateway token on Commander's Mac:
      // whoever is typing there is Commander. Remote channels must prove it by sender id.
      const LOCAL_CHANNEL = /^(tui|cli|webchat|web|local)$/i;
      const sender_is_owner =
        LOCAL_CHANNEL.test(channel) || sessionKey.includes(":tui-")
          ? true
          : senderId
            ? ownerIds.has(String(senderId))
            : false;
      const base = {
        ts: new Date().toISOString(),
        sessionKey,
        sender_is_owner,
        channel,
        text_preview: clip(text.replace(/\s+/g, " "), 120),
      };
      let scored: any = {
        intent: "chat",
        intent_p: 0,
        risk: "read_only",
        risk_p: 0,
        needs_rag: 0,
        complexity: 0,
        requires_approval: 1,
        nemo_offline: true,
      };
      const nemo = await getNemo();
      if (nemo && Object.keys(questions).length) {
        try {
          const { answers: a } = await nemo.systemOne(
            { sender: sender_is_owner ? "owner" : "unknown", channel, text: clip(text, 1500) },
            questions,
          );
          scored = {
            intent: a.intent.choice,
            intent_p: a.intent.probabilities[a.intent.choice],
            risk: a.risk.choice,
            risk_p: a.risk.probabilities[a.risk.choice],
            needs_rag: a.needs_rag.noul,
            complexity: a.complexity.score / 4,
            requires_approval: a.requires_approval.noul,
            nemo_offline: false,
          };
        } catch (err) {
          log.warn(`[nemo] decision failed, fail-closed: ${String(err)}`);
        }
      }
      const partial = { ...base, ...scored } as Omit<Decision, "policy_rule" | "outcome">;
      const d: Decision = { ...partial, ...applyPolicy(partial) };
      remember(d, sessionKey);
      try {
        mkdirSync(dirname(decisionLog), { recursive: true });
        appendFileSync(decisionLog, JSON.stringify(d) + "\n");
      } catch {
        /* best effort */
      }
      log.info(
        `[nemo] ${d.outcome} via ${d.policy_rule} — intent=${d.intent}(${d.intent_p.toFixed(2)}) risk=${d.risk}(${d.risk_p.toFixed(2)}) approval=${d.requires_approval.toFixed(2)} owner=${d.sender_is_owner}`,
      );
      return d;
    }

    // 1. Every inbound message is decided before the model sees it.
    api.on("message_received", async (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? event.sessionKey ?? ctx?.conversationId ?? "default");
      const d = await decide(
        key,
        String(event.content ?? ""),
        event.senderId ? String(event.senderId) : undefined,
        String(ctx?.channelId ?? "unknown"),
      );
      remember(d, key, event.sessionKey, ctx?.sessionKey, ctx?.conversationId, event.runId);
    });

    // 2. The model gets NEMO's verdict as a short, cacheable note; non-owners get no tools.
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      let d = lookup(key, ctx?.sessionId, ctx?.runId);
      if (!d && event.currentUserMessage) {
        // No channel hook fired (TUI/CLI path). Locality comes from the session key only;
        // an unknown remote key is NOT Commander.
        const local = /:(tui|cli|webchat)-/.test(key);
        d = await decide(
          key,
          String(event.currentUserMessage),
          undefined,
          local ? "tui" : "unknown",
        );
        remember(d, key, ctx?.sessionId, ctx?.runId);
      }
      if (!d) return undefined;
      // Recall: when NEMO says the message needs memory, pull from the shared RAG before the
      // model answers. Owner only; bounded (4 chunks, ~12k chars, 6 s); silent on failure.
      // NEMO's needs_rag under-fires on plain memory questions ("what did we decide…"),
      // so a small phrase heuristic sits beside it. Either one triggers recall.
      const MEMORY_QUESTION =
        /\b(what|when|where|which|how|who|why)\b.{0,40}\b(did|have|had|was|were) (we|you|i)\b|\b(remember|recall|last time|previously|earlier|decided|decision|agreed|locked in|on record)\b/i;
      let recall = "";
      // Telegram hands the text to message_received, not always to before_prompt_build;
      // fall back to the decision's own preview so recall still has a query.
      const msgText = event.currentUserMessage
        ? String(event.currentUserMessage)
        : (d.text_preview ?? "");
      const wantsMemory = d.needs_rag >= 0.5 || MEMORY_QUESTION.test(msgText);
      if (d.sender_is_owner && wantsMemory && msgText) {
        log.info(
          `[nemo] recall attempt (needs_rag=${d.needs_rag.toFixed(2)}, phrase=${MEMORY_QUESTION.test(msgText)}) for "${clip(msgText, 60)}"`,
        );
        const chunks = await ragSearch(msgText, 4);
        if (!chunks.length) log.info("[nemo] recall: 0 chunks");
        if (chunks.length) {
          recall =
            "[Memory recall — from Moby's shared knowledge; cite the source key when you use it]\n" +
            chunks.map((c) => `--- ${c.key} (${c.score.toFixed(2)})\n${c.text.trim()}`).join("\n") +
            "\n[end recall]";
          log.info(`[nemo] recall: ${chunks.length} chunks for "${clip(msgText, 60)}"`);
        }
      }
      // Short, behavioral, and cacheable. Scores live in decisions.jsonl, not in the prompt —
      // shown raw, the model narrates them instead of acting.
      const note = d.sender_is_owner
        ? [
            `[NEMO] Commander verified. intent=${d.intent}${wantsMemory ? (recall ? " · memory consulted (see recall below)" : " · memory consulted: nothing on record — say so; do not guess or substitute a default") : ""}.`,
            "Read-only commands run immediately. Writes, spending, deploys and irreversible actions pause for a one-tap approval from Commander — just call the tool; never refuse, redirect to another door, or ask Commander to run it himself.",
            "Report only actions whose tool call actually ran this turn; if a write needs approval, say so and wait. Never claim a file was updated or a lesson filed unless the tool returned success. Never invent a login URL, device code, one-time code or token: only relay one a tool returned this turn.",
            "Do not describe or speculate about NEMO, policy, or approval internals unless Commander asks.",
          ].join("\n")
        : "[NEMO] Unverified sender: conversation only. No tools, no memory writes.";
      return d.sender_is_owner
        ? { prependContext: recall ? `${note}\n\n${recall}` : note }
        : { prependContext: note, toolsAllow: [] };
    });

    // 2b. Memory tools. `recall` reads the shared RAG; `remember` files a note into R2 (the
    // cloud memory that both doors — TUI and Telegram — read). Both are owner-only via the gate.
    api.registerTool(
      {
        contextVersion: 2,
        create: () => ({
          name: "recall",
          label: "Recall",
          description:
            "Search Moby's shared long-term memory (cloud RAG) for past decisions, facts, lessons and project context. Use when the answer may already be known.",
          parameters: Type.Object(
            {
              query: Type.String({ maxLength: 500 }),
              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
            },
            { additionalProperties: false },
          ),
          async execute(_id: string, raw: any) {
            const chunks = await ragSearch(String(raw?.query ?? ""), Number(raw?.limit ?? 4));
            return {
              content: [
                {
                  type: "text",
                  text: chunks.length
                    ? chunks
                        .map((c) => `### ${c.key} (score ${c.score.toFixed(2)})\n${c.text.trim()}`)
                        .join("\n\n")
                    : "No matching memory.",
                },
              ],
              details: { count: chunks.length, keys: chunks.map((c) => c.key) },
            };
          },
        }),
      },
      { name: "recall" },
    );
    api.registerToolMetadata({
      toolName: "recall",
      displayName: "Recall",
      description: "Search Moby's shared cloud memory.",
      risk: "low",
      tags: ["memory", "rag"],
    });
    api.registerTool(
      {
        contextVersion: 2,
        create: () => ({
          name: "remember",
          label: "Remember",
          description:
            "File a durable note into Moby's shared long-term memory (cloud). Use for decisions, lessons, facts about Commander's systems, and project state worth keeping. Key is a path like notes/2026-10-11-topic.md.",
          parameters: Type.Object(
            {
              key: Type.String({ pattern: "^[A-Za-z0-9_./-]+$", maxLength: 200 }),
              text: Type.String({ minLength: 20, maxLength: 20000 }),
              kind: Type.Optional(Type.String({ maxLength: 40 })),
            },
            { additionalProperties: false },
          ),
          async execute(_id: string, raw: any) {
            const key = String(raw?.key ?? "").replace(/^\/+/, "");
            const r = await ragPut(key, String(raw?.text ?? ""), {
              kind: String(raw?.kind ?? "note"),
              by: "moby",
            });
            // Kick an index job so the note is searchable in seconds, not on the 6 h schedule.
            // Uses the Mac's wrangler login; fire-and-forget; Cloudflare allows one per 30 s.
            execFile(
              "npx",
              ["wrangler", "ai-search", "jobs", "create", "mobyd-shared"],
              {
                cwd: expandHome("~/.mobyd"),
                env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` },
                timeout: 60_000,
              },
              (err) => {
                if (err)
                  log.warn(`[nemo] rag sync kick failed: ${String(err.message).slice(0, 120)}`);
                else log.info("[nemo] rag sync job kicked");
              },
            );
            return {
              content: [
                {
                  type: "text",
                  text: `Remembered as ${r.key} (${r.bytes} bytes). Index sync started; searchable within a minute.`,
                },
              ],
              details: r,
            };
          },
        }),
      },
      { name: "remember" },
    );
    api.registerToolMetadata({
      toolName: "remember",
      displayName: "Remember",
      description: "File a note into Moby's shared cloud memory.",
      risk: "medium",
      tags: ["memory", "rag"],
    });

    // Diagnostic: record what the model actually receives (system prompt, tools, history sizes)
    // so the prompt diet is measured, not guessed. Writes ~/.mobyd/prompt-audit/latest.json.
    api.on("llm_input", (event: any) => {
      try {
        const dir = expandHome("~/.mobyd/prompt-audit");
        mkdirSync(dir, { recursive: true });
        const sys = String(event.systemPrompt ?? "");
        const tools = (event.tools ?? []) as unknown[];
        const toolsJson = JSON.stringify(tools);
        const history = JSON.stringify(event.historyMessages ?? []);
        const est = (t: string) => Math.round(t.length / 4);
        const sections: Record<string, number> = {};
        for (const m of sys.matchAll(/^(#{1,3}\s+.+|<[a-z_-]+>)$/gm)) {
          const title = m[1].slice(0, 60);
          sections[title] = (sections[title] ?? 0) + 1;
        }
        const audit = {
          ts: new Date().toISOString(),
          provider: event.provider,
          model: event.model,
          est_tokens: {
            system: est(sys),
            tools: est(toolsJson),
            history: est(history),
            prompt: est(String(event.prompt ?? "")),
          },
          chars: { system: sys.length, tools: toolsJson.length, history: history.length },
          tool_count: tools.length,
          tool_names: tools.map((t: any) => t?.name ?? t?.function?.name).filter(Boolean),
          history_messages: (event.historyMessages ?? []).length,
        };
        writeFileSync(join(dir, "latest.json"), JSON.stringify(audit, null, 2));
        writeFileSync(join(dir, "system-prompt.txt"), sys);
        writeFileSync(join(dir, "tools.json"), toolsJson);
        log.info(
          `[nemo] prompt audit: system≈${audit.est_tokens.system}t tools≈${audit.est_tokens.tools}t (${tools.length}) history≈${audit.est_tokens.history}t`,
        );
      } catch (e) {
        log.warn(`[nemo] prompt audit failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`);
      }
    });

    // 2c. Receipt verifier. The model has claimed actions it never took (a log write, a
    // lesson filed, an email sent) four times today; instructions did not stop it. So every
    // outgoing reply is checked against the tools that actually ran this turn, and an
    // unbacked claim is stamped visibly for Commander on every door.
    const turnTools = new Map<string, string[]>(); // sessionKey -> evidence strings
    function recordToolCall(key: string, event: any) {
      const arr = turnTools.get(key) ?? [];
      const params = event.params ?? {};
      const code = typeof params.code === "string" ? params.code : "";
      const cmd = typeof params.command === "string" ? params.command : "";
      arr.push(`${String(event.toolName ?? "")} ${cmd} ${code}`.slice(0, 2000));
      turnTools.set(key, arr);
    }
    const CLAIMS: Array<[RegExp, RegExp, string]> = [
      // [what the reply claims, what must appear in this turn's tool calls, label]
      [
        /\b(i('ve| have)?\s+(just\s+)?(sent|emailed|dispatched)|(email|message|mail)\s+(has\s+been\s+|was\s+|is\s+)?(sent|delivered)|successfully\s+sent)\b/i,
        /mobymail\s+send|sendMail|smtp|\bmessage\b.*\bsend|sessions_send/i,
        "sent",
      ],
      [
        /\b(i('ve| have)?\s+(just\s+)?(updated|saved|filed|wrote|written|logged|recorded|stored)|(has\s+been|was)\s+(updated|saved|filed|written|logged|stored))\b/i,
        /\bremember\b|\bwrite\b|\bedit\b|apply_patch|>>?\s*\S|writeFile|appendFile|fs\.|tee\b|\bcat\s*<<|sed\s+-i/i,
        "wrote",
      ],
      [
        /\b(i('ve| have)?\s+(just\s+)?(deployed|published|pushed)|(has\s+been|was)\s+(deployed|published|pushed))\b/i,
        /wrangler\s+deploy|git\s+push|npm\s+publish|pnpm\s+publish/i,
        "deployed",
      ],
      [
        /\b(i('ve| have)?\s+(just\s+)?(deleted|removed|cleaned\s+up)|(has\s+been|was)\s+(deleted|removed))\b/i,
        /\brm\b|rmdir|unlink|trash|\bdelete\b|shred/i,
        "deleted",
      ],
      [
        /\b(i('ve| have)?\s+(just\s+)?(installed|configured|set\s+up|enabled)|(has\s+been|was)\s+(installed|configured|enabled))\b/i,
        /\binstall\b|brew\b|npm\b|pnpm\b|pip\b|\bwrite\b|\bedit\b|>>?\s*\S|writeFile|sed\s+-i|config\b/i,
        "configured",
      ],
    ];
    function unverifiedClaims(text: string, evidence: string[]): string[] {
      const joined = evidence.join("\n");
      const out: string[] = [];
      for (const [claim, proof, label] of CLAIMS) {
        if (claim.test(text) && !proof.test(joined)) out.push(label);
      }
      return out;
    }
    api.on("message_received", (_event: any, ctx: any) => {
      // a new inbound message starts a new turn: clear the evidence for that session
      turnTools.set(String(ctx?.sessionKey ?? _event?.sessionKey ?? "default"), []);
    });
    api.on("message_sending", (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      const text = String(event.content ?? "");
      if (!text || text.startsWith("⚠️ Unverified")) return undefined;
      const missing = unverifiedClaims(text, turnTools.get(key) ?? []);
      if (!missing.length) return undefined;
      log.warn(
        `[nemo] receipt check: reply claims "${missing.join(", ")}" but no matching tool ran this turn (${key})`,
      );
      try {
        appendFileSync(
          decisionLog,
          JSON.stringify({
            ts: new Date().toISOString(),
            sessionKey: key,
            kind: "unverified_claim",
            claims: missing,
            text_preview: clip(text.replace(/\s+/g, " "), 160),
          }) + "\n",
        );
      } catch {
        /* best effort */
      }
      return {
        content: `⚠️ Unverified: this reply says "${missing.join('", "')}" but no matching tool call ran this turn. Treat it as not done.\n\n${text}`,
      };
    });

    // 3. The gate. Policy decides; NEMO only informs. OpenClaw renders the approval prompt.
    api.on("before_tool_call", (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      recordToolCall(key, event);
      const d = lookup(key, ctx?.sessionId, ctx?.runId);
      const tool = String(event.toolName ?? "");
      // Code-mode wraps tool calls in exec({code}). If the code only calls Moby's own memory
      // tools (recall/remember) and nothing else, judge it as those tools, not as a shell.
      const codeStr = typeof event.params?.code === "string" ? event.params.code : "";
      const MEMORY_ONLY =
        codeStr.length > 0 &&
        /\b(recall|remember)\s*\(/.test(codeStr) &&
        !/\b(exec|execSync|spawn|require|import|fs\.|fetch|process\.)\b|child_process/.test(
          codeStr,
        );
      const effectiveTool = MEMORY_ONLY
        ? /\bremember\s*\(/.test(codeStr)
          ? "remember"
          : "recall"
        : tool;
      const declared = actions[effectiveTool]?.risk;
      const declaredSandboxed = actions[effectiveTool]?.sandboxed === true;
      const cmds = MEMORY_ONLY ? [] : commandsFromParams(event.params);
      const cmdReadOnly = cmds.length > 0 && cmds.every(isReadOnlyCommand);
      const readOnly =
        declared === "read_only" ||
        cmdReadOnly ||
        (!declared &&
          cmds.length === 0 &&
          READONLY_TOOL.test(effectiveTool) &&
          !RISKY_TOOL.test(effectiveTool));
      if (d && !d.sender_is_owner)
        return { block: true, blockReason: "NEMO: tools are for Commander only." };
      if (readOnly) {
        if (cmdReadOnly)
          log.info(`[nemo] read-only command passed: ${clip(cmds.join(" | "), 120)}`);
        return undefined;
      }
      const sandboxed =
        Array.isArray(event.derivedPaths) &&
        event.derivedPaths.length > 0 &&
        event.derivedPaths.every(
          (p: string) =>
            p.startsWith("/Volumes/MOBY_D/COMMANDERS ULTIMATE PLAN") ||
            p.startsWith(join(homedir(), ".mobyd/workspace")),
        );
      // Declared-sandboxed actions (e.g. `remember` → Moby's own R2 bucket) run without a tap.
      if (declaredSandboxed && d?.sender_is_owner) {
        log.info(`[nemo] sandboxed action passed: ${effectiveTool}`);
        return undefined;
      }
      // Commander's gate is a hard-stop list, not an allowlist. NEMO's message-level verdict
      // is logged for training but never decides here — measured today, it flagged 24/30
      // ordinary messages. Non-owners never reach this point (blocked above).
      const reasons: string[] = [];
      for (const c of cmds) {
        if (c === "__opaque__") {
          // Node code with no shell command: pass if it only touches sandbox paths and
          // never reaches a shell, the network, or a process.
          const paths = [...codeStr.matchAll(/["'`]((?:~|\/)[^"'`\n]{1,200})["'`]/g)].map(
            (m) => m[1],
          );
          const reachesOut =
            /child_process|\bexec(Sync)?\s*\(|\bspawn|\bfetch\s*\(|https?:\/\/|\bnet\.|\bdgram|process\.(kill|exit)/.test(
              codeStr,
            );
          if (!reachesOut && paths.length > 0 && paths.every(underSandbox)) continue;
          reasons.push(
            reachesOut
              ? "code reaches out (shell/network/process)"
              : paths.length
                ? `code touches paths outside sandbox (${paths.find((x) => !underSandbox(x))})`
                : "opaque code (cannot see what it does)",
          );
          continue;
        }
        const why = hardStopReason(c);
        if (why) reasons.push(why);
      }
      if (HARD_STOP_TOOLS.test(effectiveTool))
        reasons.push(`tool ${effectiveTool} acts on the outside world`);
      if (!d) reasons.push("no decision on record");
      if (event.derivedPaths?.length && !sandboxed) reasons.push("writes outside sandbox");
      const needs = reasons.length > 0;
      if (!needs) {
        log.info(
          `[nemo] proceed (owner): ${effectiveTool}${cmds.length ? ` cmd="${clip(cmds.join(" | "), 80)}"` : ""}`,
        );
        return undefined;
      }
      if (advisoryOnly) {
        log.info(`[nemo] (advisory) would require approval for ${tool}`);
        return undefined;
      }
      log.info(
        `[nemo] approval demanded for ${effectiveTool}: ${reasons.join("; ")}${cmds.length ? ` cmd="${clip(cmds.join(" | "), 80)}"` : ""}`,
      );
      return {
        requireApproval: {
          title: `NEMO: approve ${effectiveTool}?`,
          description: `Why: ${reasons.join("; ")}\n${cmds.length ? `cmd: ${clip(cmds.join(" | "), 200)}` : `params: ${clip(JSON.stringify(event.params ?? {}), 200)}`}`,
          severity: /money|disk|privilege|outside world|remote/.test(reasons.join(" "))
            ? "critical"
            : "warning",
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 10 * 60_000, // Commander may be on his phone, not watching
          pluginId: "mobyd-nemo",
        },
      };
    });

    log.info(
      `[nemo] registered — owners=${ownerIds.size}, threshold=${threshold}, advisoryOnly=${advisoryOnly}, log=${decisionLog}`,
    );
  },
});
