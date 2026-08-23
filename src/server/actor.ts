// Cockpit write-actor attribution (#213).
//
// A Cockpit mutation is a *third* write-stack alongside the CLI (`src/cli.ts`)
// and the MCP server (`src/mcp/registry.ts`). Each stack owns its own actor
// policy: the CLI resolves an actor from `--actor`/env, MCP derives one from
// the client handshake. The server is neither — it must map the request
// `Principal` (from `authMiddleware`) to a core `ActorContext` so an
// append-only `audit_log` row can be traced back to "a human acting in the
// Cockpit".
//
// Phase 1 is deliberately a *fixed* web actor: there is no per-user identity
// yet (Better Auth is Phase 2), and every Cockpit write is performed by the
// same localhost-trusted operator. When Phase 2 lands, the real user id flows
// through `Principal.id` and this mapper starts honouring it.
//
// IMPORTANT: like the MCP actor, the resolved actor is passed to core as an
// EXPLICIT payload parameter (`createdBy` / `createdByProgram`) — never via a
// process env var, which is race-prone when requests are handled in parallel.

import type { ActorContext } from "../core/actor";
import type { Principal } from "./auth";

/** The fixed Phase-1 Cockpit actor id. */
export const COCKPIT_ACTOR_ID = "system:cockpit";
/** The fixed Phase-1 Cockpit program tag (lands in `created_by_program`). */
export const COCKPIT_ACTOR_PROGRAM = "rentemester-cockpit";

/**
 * Maps an authenticated `Principal` to a core `ActorContext`.
 *
 * Phase 1: the principal is always the synthetic localhost/cockpit identity,
 * so the actor is the fixed web actor regardless of `principal`. The argument
 * is taken now so the Phase-2 swap — honouring a real `user:<id>` principal —
 * is a change to this function body only, never a change to its callers.
 */
export function resolveCockpitActor(_principal: Principal): ActorContext {
  return {
    createdBy: COCKPIT_ACTOR_ID,
    createdByProgram: COCKPIT_ACTOR_PROGRAM,
    auditActor: `${COCKPIT_ACTOR_ID} via ${COCKPIT_ACTOR_PROGRAM}`,
  };
}

/**
 * Folds the resolved actor into a core payload as explicit `createdBy` /
 * `createdByProgram` fields, without overwriting any value the caller set.
 * Mirrors `withActor` in `src/mcp/actor.ts`.
 */
export function withCockpitActor<T extends object>(
  payload: T,
  actor: ActorContext,
): T & { createdBy: string; createdByProgram: string } {
  const existing = payload as { createdBy?: string; createdByProgram?: string };
  return {
    ...payload,
    createdBy: existing.createdBy ?? actor.createdBy,
    createdByProgram: existing.createdByProgram ?? actor.createdByProgram,
  };
}
