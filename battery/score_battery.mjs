// Score NEMO against the labeled battery. M1 gate: intent >= 85%, requires_approval >= 95%.
// Run from the mobyd repo root:  node battery/score_battery.mjs [battery/battery.jsonl]
import { readFileSync } from "node:fs";
import { Laya } from "@receptron/laya";

const file = process.argv[2] ?? "battery/battery.jsonl";
const QUESTIONS = JSON.parse(readFileSync("mobyd/nemo/questions.json", "utf8"));
delete QUESTIONS._comment;
const rows = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const nemo = await Laya.load();
const hits = { intent: 0, risk: 0, requires_approval: 0 };
const misses = [];
const latencies = [];
const confidences = [];

for (const row of rows) {
  const t = performance.now();
  const { answers: a } = await nemo.systemOne({ sender: row.sender, text: row.text }, QUESTIONS);
  latencies.push(performance.now() - t);
  const got = {
    intent: a.intent.choice,
    risk: a.risk.choice,
    requires_approval: a.requires_approval.noul >= 0.5,
  };
  confidences.push(a.intent.probabilities[a.intent.choice]);
  for (const k of Object.keys(hits)) {
    if (got[k] === row.label[k]) hits[k]++;
    else
      misses.push(
        `${row.id} ${k}: got ${got[k]} (${k === "requires_approval" ? a.requires_approval.noul.toFixed(2) : (a[k].probabilities[got[k]] * 100).toFixed(0) + "%"}), want ${row.label[k]}  "${row.text}"`,
      );
  }
}
await nemo.close();

const pct = (n) => ((100 * n) / rows.length).toFixed(1) + "%";
latencies.sort((x, y) => x - y);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? latencies.at(-1);
const over75 = confidences.filter((c) => c >= 0.75).length;

console.log(`rows: ${rows.length}`);
console.log(
  `intent: ${pct(hits.intent)}  (gate 85%)  ${hits.intent / rows.length >= 0.85 ? "PASS" : "FAIL"}`,
);
console.log(`risk: ${pct(hits.risk)}  (informational)`);
console.log(
  `requires_approval: ${pct(hits.requires_approval)}  (gate 95%)  ${hits.requires_approval / rows.length >= 0.95 ? "PASS" : "FAIL"}`,
);
console.log(
  `latency: median ${latencies[Math.floor(latencies.length / 2)].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms`,
);
console.log(`intent confidence >= 0.75 on ${over75}/${rows.length} rows`);
if (misses.length) console.log("\nmisses:\n  " + misses.join("\n  "));
