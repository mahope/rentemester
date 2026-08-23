// Tests: src/cli.ts, src/cli-args.ts (CLI input boundary errors)
import { describe, expect, test } from "bun:test";

describe("CLI input boundary errors", () => {
  test("fails fast when a required flag value is missing", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "bank", "import",
      "--company",
      "--file", "examples/bank-transactions.csv",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Flag --company requires a value");
  });

  test("rejects a --company path containing parent-directory traversal", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "journal", "post",
      "--company", "/tmp/../tmp/evil",
      "--input", "examples/journal-entry.expense.json",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RENTEMESTER_COMPANY: "" },
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr.toLowerCase()).toContain("company");
  });

  test("fails with a clear error when a company-bound command has no --company", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "journal", "post",
      "--input", "examples/journal-entry.expense.json",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RENTEMESTER_COMPANY: "" },
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--company");
    expect(stderr).not.toContain("/company");
  });

  test("invoice validate still works without --company", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "invoice", "validate",
      "--input", "examples/full-invoice.dk.json",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, RENTEMESTER_COMPANY: "" },
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // validate needs no company; it must not fail on a missing --company.
    expect(stderr).not.toContain("--company is required");
    expect([0, 1]).toContain(exitCode);
  });

  test("prints a useful error for unknown commands", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "nonsense", "command"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Unknown command: nonsense command");
    // The global usage lists commands grouped by read vs write, with the
    // actor contract among the global flags. (#231)
    expect(stdout).toContain("Læsekommandoer");
    expect(stdout).toContain("Skrivekommandoer");
    expect(stdout).toContain("--actor");
  });
});

describe("CLI exit code contract (parse error vs business rejection)", () => {
  test("exit 2 for parse/usage errors — missing flag value", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "invoice", "validate",
      "--format", "invalid",
    ], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--format must be either json or human");
  });

  test("exit 2 for unknown commands", async () => {
    const proc = Bun.spawn(["bun", "run", "src/cli.ts", "unknown_cmd", "--format", "json"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    expect(exitCode).toBe(2);
  });

  test("exit 1 for business-rule rejection with JSON envelope", async () => {
    const proc = Bun.spawn([
      "bun", "run", "src/cli.ts",
      "invoice", "validate",
      "--input", "/dev/stdin",
      "--format", "json",
    ], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    (proc.stdin as any).write(JSON.stringify({
      invoiceType: "full",
      issueDate: "",
    }));
    (proc.stdin as any).end();

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(Array.isArray(parsed.errors)).toBe(true);
    expect(parsed.errors.length).toBeGreaterThan(0);
    // Must contain specific validation errors, not generic messages
    expect(parsed.errors.some((e: string) => e.startsWith("issueDate"))).toBe(true);
  });
});
