// Tests: src/legal-sources.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadLegalSources } from "../../src/legal-sources";

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

describe("download legal sources", () => {
  test("preserves downloadedAt for unchanged content and writes relative paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-legal-sources-"));
    mkdirSync(join(root, "sources", "downloaded"), { recursive: true });

    const body = '<?xml version="1.0"?><law />';
    writeFileSync(join(root, "sources", "legal-sources.json"), JSON.stringify([
      { id: "DK-TEST-001", title: "Test source", authority: "Test", category: "test", url: "https://example.test/source.xml" }
    ], null, 2));
    writeFileSync(join(root, "sources", "downloaded", "DK-TEST-001.xml"), body);
    writeFileSync(join(root, "sources", "downloaded", "index.json"), JSON.stringify([
      {
        id: "DK-TEST-001",
        title: "Test source",
        authority: "Test",
        category: "test",
        url: "https://example.test/source.xml",
        downloadedAt: "2026-05-17T01:40:21.543Z",
        localPath: "sources/downloaded/DK-TEST-001.xml",
        bytes: Buffer.byteLength(body),
        sha256: sha256(body)
      }
    ], null, 2));

    const result = await downloadLegalSources({
      rootDir: root,
      fetchImpl: (async () => new Response(body, { headers: { "content-type": "application/xml" } })) as unknown as typeof fetch,
      now: () => "2099-01-01T00:00:00.000Z",
    });

    expect(result.errors).toEqual([]);
    expect(result.index).toHaveLength(1);
    expect(result.index[0]?.localPath).toBe("sources/downloaded/DK-TEST-001.xml");
    expect(result.index[0]?.downloadedAt).toBe("2026-05-17T01:40:21.543Z");
    expect(result.readme).not.toContain("Downloaded at");
  });

  test("keeps existing index entry when a source fetch fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "rentemester-legal-sources-"));
    mkdirSync(join(root, "sources", "downloaded"), { recursive: true });

    const body = '<?xml version="1.0"?><law id="keep" />';
    writeFileSync(join(root, "sources", "legal-sources.json"), JSON.stringify([
      { id: "DK-KEEP-001", title: "Keep me", authority: "Test", category: "test", url: "https://example.test/keep.xml" },
      { id: "DK-FAIL-001", title: "Fail me", authority: "Test", category: "test", url: "https://example.test/fail.xml" }
    ], null, 2));
    writeFileSync(join(root, "sources", "downloaded", "DK-KEEP-001.xml"), body);
    writeFileSync(join(root, "sources", "downloaded", "index.json"), JSON.stringify([
      {
        id: "DK-KEEP-001",
        title: "Keep me",
        authority: "Test",
        category: "test",
        url: "https://example.test/keep.xml",
        downloadedAt: "2026-05-17T01:40:21.543Z",
        localPath: "sources/downloaded/DK-KEEP-001.xml",
        bytes: Buffer.byteLength(body),
        sha256: sha256(body)
      }
    ], null, 2));

    const result = await downloadLegalSources({
      rootDir: root,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("keep.xml")) {
          return new Response(body, { headers: { "content-type": "application/xml" } });
        }
        throw new Error("temporary upstream failure");
      }) as unknown as typeof fetch,
    });

    expect(result.index.map((entry) => entry.id)).toEqual(["DK-KEEP-001"]);
    expect(result.errors).toEqual(["DK-FAIL-001: temporary upstream failure"]);
    expect(readFileSync(join(root, result.index[0]!.localPath), "utf8")).toContain("keep");
  });
});
