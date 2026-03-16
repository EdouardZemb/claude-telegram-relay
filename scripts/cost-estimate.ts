/**
 * CLI wrapper for cost estimation (S29-T7)
 *
 * Usage: bun run cost:estimate <task_count> [pipeline]
 * Example: bun run cost:estimate 8 DEFAULT
 */

import { createClient } from "@supabase/supabase-js";
import { estimateSprintCost, formatCostEstimate } from "../src/cost-estimate.ts";
import "dotenv/config";

const taskCount = parseInt(process.argv[2] || "0", 10);
const pipeline = process.argv[3] || "DEFAULT";

if (!taskCount || taskCount < 1) {
  console.log("Usage: bun run cost:estimate <task_count> [pipeline]");
  console.log("Pipelines: DEFAULT, QUICK, REVIEW");
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
const supabase = url && key ? createClient(url, key) : null;

const result = await estimateSprintCost(supabase, taskCount, pipeline);
console.log(formatCostEstimate(result));
