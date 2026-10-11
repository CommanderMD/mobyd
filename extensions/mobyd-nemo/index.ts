import { execFile } from "node:child_process";
// NEMO — the head of MOBY-D.
// Every inbound message becomes a typed decision (intent, risk, needs_rag, complexity, requires_approval)
// before the model sees it and before any tool runs. Policy (policy/mobyd-policy.yaml) overrides NEMO.
// Fail closed: if NEMO cannot load, chat still works but every tool call needs Commander's approval.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
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
            "Report only actions whose tool call actually ran this turn; if a write needs approval, say so and wait. Never claim a file was updated or a lesson filed unless the tool returned success.",
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

    // 3. The gate. Policy decides; NEMO only informs. OpenClaw renders the approval prompt.
    api.on("before_tool_call", (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
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
      // Declared-sandboxed actions (e.g. `remember` → Moby's own R2 bucket) are writes with
      // no blast radius outside Moby: they run without a tap and are logged.
      if (declaredSandboxed && d?.sender_is_owner) {
        log.info(`[nemo] sandboxed action passed: ${effectiveTool}`);
        return undefined;
      }
      const needs =
        !d ||
        d.nemo_offline ||
        d.outcome === "approval_required" ||
        RISKY_TOOL.test(effectiveTool) ||
        !declared;
      if (!needs || (sandboxed && d?.risk === "writes_files")) return undefined;
      if (advisoryOnly) {
        log.info(`[nemo] (advisory) would require approval for ${tool}`);
        return undefined;
      }
      log.info(
        `[nemo] approval demanded for ${effectiveTool}${effectiveTool !== tool ? ` (via ${tool})` : ""}: ${d ? `rule=${d.policy_rule} risk=${d.risk}` : "no decision (fail-closed)"}${cmds.length ? ` cmd="${clip(cmds.join(" | "), 80)}"` : ""}`,
      );
      return {
        requireApproval: {
          title: `NEMO: approve ${effectiveTool}?`,
          description: `${d ? `intent=${d.intent}, risk=${d.risk}, rule=${d.policy_rule}` : "no decision on record (fail-closed)"}\nparams: ${clip(JSON.stringify(event.params ?? {}), 300)}`,
          severity:
            d && ["spends_money", "touches_prod", "irreversible"].includes(d.risk)
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
