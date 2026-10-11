// NEMO — the head of MOBY-D.
// Every inbound message becomes a typed decision (intent, risk, needs_rag, complexity, requires_approval)
// before the model sees it and before any tool runs. Policy (policy/mobyd-policy.yaml) overrides NEMO.
// Fail closed: if NEMO cannot load, chat still works but every tool call needs Commander's approval.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
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
    try {
      const s = JSON.parse(readFileSync(expandHome("~/.mobyd/mobyd-settings.json"), "utf8"));
      if (s.owner_telegram_id) ownerIds.add(String(s.owner_telegram_id));
    } catch {
      /* settings file optional */
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

    const decisions = new Map<string, Decision>();

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
      const sender_is_owner = senderId
        ? ownerIds.has(String(senderId))
        : channel === "tui" || channel === "cli";
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
      decisions.set(sessionKey, d);
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
      const key = String(event.sessionKey ?? ctx?.conversationId ?? "default");
      await decide(
        key,
        String(event.content ?? ""),
        event.senderId ? String(event.senderId) : undefined,
        String(ctx?.channelId ?? "unknown"),
      );
    });

    // 2. The model gets NEMO's verdict as a short, cacheable note; non-owners get no tools.
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      let d = decisions.get(key);
      if (!d && event.currentUserMessage)
        d = await decide(key, String(event.currentUserMessage), undefined, "tui");
      if (!d) return undefined;
      const note = [
        "[NEMO verdict for this message]",
        `intent=${d.intent} (${(d.intent_p * 100).toFixed(0)}%) · risk=${d.risk} · complexity=${d.complexity.toFixed(2)} · needs_memory=${d.needs_rag >= 0.5 ? "yes" : "no"}`,
        `policy: ${d.policy_rule} → ${d.outcome}${d.nemo_offline ? " (NEMO offline, fail-closed)" : ""}`,
        d.outcome === "approval_required"
          ? "Any tool that writes, spends, deploys or cannot be undone will ask Commander first."
          : "",
        !d.sender_is_owner
          ? "Sender is not Commander: conversation only, no tools, no memory writes."
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return d.sender_is_owner
        ? { prependContext: note }
        : { prependContext: note, toolsAllow: [] };
    });

    // 3. The gate. Policy decides; NEMO only informs. OpenClaw renders the approval prompt.
    api.on("before_tool_call", (event: any, ctx: any) => {
      const key = String(ctx?.sessionKey ?? "default");
      const d = decisions.get(key);
      const tool = String(event.toolName ?? "");
      const declared = actions[tool]?.risk;
      const readOnly =
        declared === "read_only" ||
        (!declared && READONLY_TOOL.test(tool) && !RISKY_TOOL.test(tool));
      if (d && !d.sender_is_owner)
        return { block: true, blockReason: "NEMO: tools are for Commander only." };
      if (readOnly) return undefined;
      const sandboxed =
        Array.isArray(event.derivedPaths) &&
        event.derivedPaths.length > 0 &&
        event.derivedPaths.every(
          (p: string) =>
            p.startsWith("/Volumes/MOBY_D/COMMANDERS ULTIMATE PLAN") ||
            p.startsWith(join(homedir(), ".mobyd/workspace")),
        );
      const needs =
        !d ||
        d.nemo_offline ||
        d.outcome === "approval_required" ||
        RISKY_TOOL.test(tool) ||
        !declared;
      if (!needs || (sandboxed && d?.risk === "writes_files")) return undefined;
      if (advisoryOnly) {
        log.info(`[nemo] (advisory) would require approval for ${tool}`);
        return undefined;
      }
      return {
        requireApproval: {
          title: `NEMO: approve ${tool}?`,
          description: `${d ? `intent=${d.intent}, risk=${d.risk}, rule=${d.policy_rule}` : "no decision on record (fail-closed)"}\nparams: ${clip(JSON.stringify(event.params ?? {}), 300)}`,
          severity:
            d && ["spends_money", "touches_prod", "irreversible"].includes(d.risk)
              ? "critical"
              : "warning",
          allowedDecisions: ["allow-once", "deny"],
          pluginId: "mobyd-nemo",
        },
      };
    });

    log.info(
      `[nemo] registered — owners=${ownerIds.size}, threshold=${threshold}, advisoryOnly=${advisoryOnly}, log=${decisionLog}`,
    );
  },
});
