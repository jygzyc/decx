/**
 * Worker payload autonomy enforcement.
 *
 * Given a role definition and a parsed worker payload, decide whether the
 * role is allowed to produce that payload, and (for the intents case) trim
 * intents to the role's maxIntentsPerStep cap.
 */

import type { RoleDefinition } from "./roles.js";
import type { WorkerPayload } from "../core/protocol.js";

export type AutonomyResult =
  | { allowed: true; payload: WorkerPayload }
  | { allowed: false; reason: string };

export function applyAutonomy(role: RoleDefinition, payload: WorkerPayload): AutonomyResult {
  if (payload.kind === "intents") {
    if (!role.autonomy.canCreateIntents) return { allowed: false, reason: `${role.id} cannot create intents` };
    if (payload.intents.length > role.autonomy.maxIntentsPerStep) {
      return { allowed: true, payload: { ...payload, intents: payload.intents.slice(0, role.autonomy.maxIntentsPerStep) } };
    }
  }
  if (payload.kind === "complete" && !role.autonomy.canCompleteRun) return { allowed: false, reason: `${role.id} cannot complete runs` };
  if (payload.kind === "rejected" && !role.autonomy.canFailRun) return { allowed: false, reason: `${role.id} cannot fail work` };
  if (payload.kind === "review" && !role.autonomy.canReview) return { allowed: false, reason: `${role.id} cannot review` };
  return { allowed: true, payload };
}
