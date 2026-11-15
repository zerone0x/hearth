import { describe, expect, test } from "bun:test";
import { type AuditRecord, type AuditSink, MemoryAuditSink, withAudit } from "./audit";
import { AllowAllAuthorizer } from "./authorize";
import { classifyFailure, HearthError } from "./failure";
import { LOCAL_PRINCIPAL, type Principal } from "./identity";
import { DEFAULT_WORKSPACE_ID, SingleWorkspaceResolver } from "./tenancy";

const failingSink: AuditSink = {
  write: async () => {
    throw new Error("disk full");
  },
};

const sessionResource = { workspaceId: DEFAULT_WORKSPACE_ID, type: "session", id: "s1" };

describe("AllowAllAuthorizer", () => {
  test("allows and audits the decision before resolving", async () => {
    const audit = new MemoryAuditSink();
    const authz = new AllowAllAuthorizer({ audit, now: () => 1234 });

    const decision = await authz.authorize(LOCAL_PRINCIPAL, "session.create", {
      workspaceId: DEFAULT_WORKSPACE_ID,
      type: "session",
    });

    expect(decision).toEqual({ allowed: true, policy: "allow-all" });
    expect(audit.records).toEqual([
      {
        workspaceId: DEFAULT_WORKSPACE_ID,
        principalId: LOCAL_PRINCIPAL.id,
        principalKind: "user",
        action: "session.create",
        resource: { workspaceId: DEFAULT_WORKSPACE_ID, type: "session" },
        decision: { allowed: true, policy: "allow-all" },
        at: 1234,
      },
    ]);
  });

  test("audits every call, one record each", async () => {
    const audit = new MemoryAuditSink();
    const authz = new AllowAllAuthorizer({ audit });
    await authz.authorize(LOCAL_PRINCIPAL, "session.message", sessionResource);
    await authz.authorize(LOCAL_PRINCIPAL, "box.echo", { ...sessionResource, type: "box" });
    expect(audit.records.map((r) => r.action)).toEqual(["session.message", "box.echo"]);
  });

  test("denies, and audits the denial, across workspaces", async () => {
    const audit = new MemoryAuditSink();
    const authz = new AllowAllAuthorizer({ audit });
    const decision = await authz.authorize(LOCAL_PRINCIPAL, "session.read", {
      ...sessionResource,
      workspaceId: "ws_other",
    });
    expect(decision.allowed).toBe(false);
    expect(audit.records[0]?.decision).toEqual(decision);
  });

  test("fails closed when the audit write fails", async () => {
    const authz = new AllowAllAuthorizer({ audit: failingSink });
    const decision = await authz.authorize(LOCAL_PRINCIPAL, "session.create", sessionResource);
    expect(decision).toEqual({ allowed: false, policy: "allow-all", reason: "audit unavailable" });
  });
});

describe("withAudit", () => {
  const record: AuditRecord = {
    workspaceId: DEFAULT_WORKSPACE_ID,
    principalId: LOCAL_PRINCIPAL.id,
    principalKind: "user",
    action: "desktop.takeover",
    resource: { workspaceId: DEFAULT_WORKSPACE_ID, type: "box", id: "b1" },
    at: 1,
  };

  test("writes the record before running the action", async () => {
    const audit = new MemoryAuditSink();
    const result = await withAudit(audit, record, () => {
      expect(audit.records).toHaveLength(1);
      return "done";
    });
    expect(result).toBe("done");
  });

  test("does not run the action when the write fails", async () => {
    let ran = false;
    const attempt = withAudit(failingSink, record, () => {
      ran = true;
    });
    await expect(attempt).rejects.toBeInstanceOf(HearthError);
    await expect(attempt).rejects.toMatchObject({ code: "audit.write-failed", owner: "hub" });
    expect(ran).toBe(false);
  });
});

describe("single workspace and local principal", () => {
  test("the local principal resolves to the default workspace", () => {
    const resolver = new SingleWorkspaceResolver();
    expect(resolver.scopeFor(LOCAL_PRINCIPAL)).toEqual({ workspaceId: DEFAULT_WORKSPACE_ID });
  });

  test("a principal from another workspace is refused", () => {
    const stranger: Principal = { ...LOCAL_PRINCIPAL, workspaceId: "ws_other" };
    expect(() => new SingleWorkspaceResolver().scopeFor(stranger)).toThrow("ws_other");
  });
});

describe("classifyFailure", () => {
  test("keeps the class of a HearthError and treats anything else as a hub bug", () => {
    const boxFailure = new HearthError("oom", {
      owner: "box",
      disposition: "retry-cold",
      code: "box.oom",
    });
    expect(classifyFailure(boxFailure)).toEqual({ owner: "box", disposition: "retry-cold" });
    expect(classifyFailure(new TypeError("x"))).toEqual({ owner: "hub", disposition: "give-up" });
  });
});
