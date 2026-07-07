/**
 * Permission checking for subagent graph mutations.
 *
 * A SubagentProfile declares which capabilities its output may trigger. The
 * decision applier consults PermissionChecker before applying any side effect,
 * so an explorer cannot (for example) resolve facts or conclude the run even
 * if its worker output happens to include those fields.
 *
 * The built-in permission sets live in types.ts (BUILTIN_PERMISSIONS); custom
 * profiles declare their own via SubagentProfile.permissions.
 */

import type { Permission, SubagentProfile } from "./types.js";

export class PermissionChecker {
  private readonly granted: Set<Permission>;

  constructor(private readonly profile: SubagentProfile) {
    this.granted = new Set(profile.permissions ?? []);
  }

  has(permission: Permission): boolean {
    return this.granted.has(permission);
  }

  require(permission: Permission): void {
    if (!this.has(permission)) {
      throw new PermissionDeniedError(this.profile.role, permission);
    }
  }

  requireAny(...permissions: Permission[]): void {
    if (permissions.length === 0) return;
    if (!permissions.some((p) => this.has(p))) {
      throw new PermissionDeniedError(this.profile.role, permissions[0]!);
    }
  }

  get role(): string {
    return this.profile.role;
  }
}

export class PermissionDeniedError extends Error {
  constructor(
    role: string,
    readonly permission: Permission,
  ) {
    super(`role "${role}" lacks permission "${permission}"`);
    this.name = "PermissionDeniedError";
  }
}
