import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TaskKey = "categorize" | "estimate" | "approve" | "duplicate";

export interface Claim {
  id: string;
  task: TaskKey;
  difficulty?: string;
  tolerance?: number;
  input: Record<string, any>;
  label: string | number | boolean;
}

export function loadClaims(): Claim[] {
  const p = resolve(__dirname, "../data/claims.json");
  return JSON.parse(readFileSync(p, "utf8")) as Claim[];
}

// Task key -> the task name created by the structure seed (resolved by name).
export const TASK_NAME: Record<TaskKey, string> = {
  categorize: "Categorize claim",
  estimate: "Estimate payout",
  approve: "Approve / deny claim",
  duplicate: "Flag potential duplicate claim",
};

// Escalation thresholds — governance posture by risk (escalate when worker
// confidence is below the bar). Higher-risk tasks escalate more readily.
// Mirrors the Policy rows written by the structure seed.
export const ESCALATION_THRESHOLD: Record<string, number> = {
  "Categorize claim": 0.4,
  "Estimate payout": 0.96,
  "Approve / deny claim": 0.99,
  "Flag potential duplicate claim": 1.0,
};
