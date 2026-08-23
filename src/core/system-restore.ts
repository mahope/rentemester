import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { openDb } from "./db";
import { verifyAuditChain } from "./ledger";
import { companyPaths, ensureCompanyDirs } from "./paths";
import { backupAsymmetricSignaturePath, backupManifestKeyPath, backupManifestSignaturePath } from "./system-backups";
import type { BackupManifest, ManifestFile } from "./system-backups";
import { extractTar } from "./tar";
import { insertAuditLog } from "./actor";

const RULE_ID = "DK-BOOKKEEPING-RESTORE-001";

export type RestoreSystemBackupInput = {
  backupDir: string;
  targetCompanyRoot: string;
  verificationKeyPath?: string;
  publicKeyPath?: string;
  // Optional out-of-band public-key hint. When set, an ed25519 public key
  // resolved from inside the backup must match it or restore fails closed
  // (issue #132). Backward-compatible: omitted -> previous behaviour.
  publicKeyHint?: string;
};

export type RestoreSystemBackupResult = {
  ok: boolean;
  backupId?: string;
  restoredAt?: string;
  targetCompanyRoot?: string;
  restoredDbPath?: string;
  restoredFiles?: {
    documentsOriginals: number;
    invoicesIssued: number;
    config: number;
  };
  appliedRules: string[];
  errors: string[];
};

function sha256File(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifestText(backupDir: string) {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }
}

function readManifest(backupDir: string): BackupManifest | null {
  const manifestText = readManifestText(backupDir);
  if (!manifestText) return null;
  try {
    return JSON.parse(manifestText) as BackupManifest;
  } catch {
    return null;
  }
}

function resolveManifestPath(backupDir: string, manifestPath: string) {
  const resolvedBackupDir = resolve(backupDir);
  const candidate = isAbsolute(manifestPath) ? resolve(manifestPath) : resolve(resolvedBackupDir, manifestPath);
  const normalizedRoot = `${resolvedBackupDir}${resolvedBackupDir.endsWith("/") ? "" : "/"}`;
  const normalizedCandidate = normalize(candidate);
  if (normalizedCandidate !== resolvedBackupDir && !normalizedCandidate.startsWith(normalizedRoot)) return null;
  return normalizedCandidate;
}

function ensureMatches(backupDir: string, file: ManifestFile) {
  const resolvedPath = resolveManifestPath(backupDir, file.path);
  if (!resolvedPath) return `manifest path escapes backup dir: ${file.path}`;
  if (!existsSync(resolvedPath)) return `missing backup file: ${file.path}`;
  const actualSize = statSync(resolvedPath).size;
  if (actualSize !== file.sizeBytes) return `size mismatch for ${file.path}`;
  const actualHash = sha256File(resolvedPath);
  if (actualHash !== file.sha256) return `sha256 mismatch for ${file.path}`;
  return null;
}

function inferVerificationKeyPath(backupDir: string) {
  const resolvedBackupDir = resolve(backupDir);
  const backupsDir = dirname(resolvedBackupDir);
  if (basename(backupsDir) !== "backups") return null;
  return backupManifestKeyPath(dirname(backupsDir));
}

function manifestHmac(manifestText: string, keyHex: string) {
  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(manifestText).digest("hex");
}

function verifyManifestHmac(backupDir: string, manifestText: string, verificationKeyPath?: string) {
  const signaturePath = backupManifestSignaturePath(backupDir);
  if (!existsSync(signaturePath)) return "missing backup manifest signature: manifest.json.hmac";
  const signature = readFileSync(signaturePath, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(signature)) return "invalid backup manifest signature format";

  const keyPath = verificationKeyPath ?? inferVerificationKeyPath(backupDir);
  if (!keyPath) return "backup authenticity key not found; pass verificationKeyPath or restore from the original company backups directory";
  if (!existsSync(keyPath)) return `backup authenticity key not found: ${keyPath}`;
  const keyHex = readFileSync(keyPath, "utf8").trim();
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) return `backup authenticity key is invalid: ${keyPath}`;

  const expected = Buffer.from(manifestHmac(manifestText, keyHex), "hex");
  const actual = Buffer.from(signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return "backup manifest authenticity check failed";
  return null;
}

function publicKeyHint(publicKeyPem: string) {
  return createHash("sha256").update(publicKeyPem.trim()).digest("hex").slice(0, 16);
}

type Ed25519VerifyResult =
  | { error: string }
  // keySource distinguishes a key the verifier supplied out-of-band (genuine
  // 3rd-party authenticity) from one resolved inside the backup itself. An
  // in-backup key only proves the backup is internally self-consistent — a
  // local actor who re-signs with a fresh keypair would also pass — so it is
  // INTEGRITY-ONLY, never authenticity (issue #132).
  | { ok: true; keySource: "out-of-band" | "in-backup"; publicKeyHint: string };

function verifyManifestEd25519(
  backupDir: string,
  manifest: BackupManifest,
  manifestText: string,
  overridePublicKeyPath?: string,
  expectedPublicKeyHint?: string,
): Ed25519VerifyResult | null {
  if (!manifest.asymmetricSignature) return null; // nothing to verify
  const sigPath = backupAsymmetricSignaturePath(backupDir);
  if (!existsSync(sigPath)) return { error: "missing ed25519 backup manifest signature: manifest.json.ed25519.sig" };
  const sigBase64 = readFileSync(sigPath, "utf8").trim();
  let sigBytes: Buffer;
  try {
    sigBytes = Buffer.from(sigBase64, "base64");
  } catch {
    return { error: "invalid ed25519 signature encoding" };
  }
  if (sigBytes.length !== 64) return { error: `invalid ed25519 signature length: ${sigBytes.length} (expected 64)` };

  // Resolve public key: explicit override (out-of-band) > path embedded in
  // manifest > <backupDir>/config/backup-manifest.pub. Only the override is
  // trusted for authenticity; manifest-declared / config keys ship INSIDE the
  // backup and are integrity-only.
  let publicKeyPath: string | null = null;
  let keySource: "out-of-band" | "in-backup" = "in-backup";
  if (overridePublicKeyPath) {
    publicKeyPath = overridePublicKeyPath;
    keySource = "out-of-band";
  } else {
    const declared = resolveManifestPath(backupDir, manifest.asymmetricSignature.publicKeyPath);
    if (declared && existsSync(declared)) {
      publicKeyPath = declared;
    } else {
      const fallback = join(backupDir, "config", "backup-manifest.pub");
      if (existsSync(fallback)) publicKeyPath = fallback;
    }
  }
  if (!publicKeyPath || !existsSync(publicKeyPath)) {
    return { error: "ed25519 public key not found; pass publicKeyPath or restore from a backup that ships the key under config/backup-manifest.pub" };
  }
  const pem = readFileSync(publicKeyPath, "utf8");
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    return { error: `failed to parse ed25519 public key: ${String(error)}` };
  }

  // Fail-closed hint check (issue #132): if the verifier supplied a public-key
  // hint out-of-band, the key actually used MUST match it. This defeats an
  // attacker who deletes the keypair, re-signs a tampered backup with a fresh
  // keypair, and ships the forged public key inside the backup.
  const resolvedHint = publicKeyHint(pem);
  if (expectedPublicKeyHint && resolvedHint !== expectedPublicKeyHint) {
    return { error: `ed25519 public key hint mismatch: resolved ${resolvedHint}, expected ${expectedPublicKeyHint}` };
  }

  const ok = cryptoVerify(null, Buffer.from(manifestText, "utf8"), key, sigBytes);
  if (!ok) return { error: "ed25519 manifest signature verification failed" };
  return { ok: true, keySource, publicKeyHint: resolvedHint };
}

function verifyManifestAuthenticity(
  backupDir: string,
  manifest: BackupManifest,
  manifestText: string,
  verificationKeyPath?: string,
  publicKeyPath?: string,
  publicKeyHintExpected?: string,
) {
  const hmacError = verifyManifestHmac(backupDir, manifestText, verificationKeyPath);
  if (hmacError) return hmacError;
  // If the manifest advertises an ed25519 signature, it MUST also verify.
  // This means: opting in to asymmetric signing strengthens the guarantee
  // (both HMAC and ed25519 must agree); it never weakens HMAC. Verification
  // is fail-closed: any non-null result that is not {ok:true} blocks restore.
  const ed25519 = verifyManifestEd25519(backupDir, manifest, manifestText, publicKeyPath, publicKeyHintExpected);
  if (ed25519 && "error" in ed25519) return ed25519.error;
  return null;
}

// A restore target is "safe to write into" when it does not already hold a
// live company ledger. Issue #139: the previous readdirSync(root).length === 0
// check is TOCTOU-racy and also rejects benign empty-but-not-empty dirs. The
// real thing we must never clobber is an existing ledger database, so we test
// for that explicit company marker instead.
function targetHoldsLiveCompany(targetCompanyRoot: string) {
  if (!existsSync(targetCompanyRoot)) return false;
  return existsSync(companyPaths(targetCompanyRoot).db);
}

function restoreFiles(backupDir: string, files: ManifestFile[], targetDir: string) {
  mkdirSync(targetDir, { recursive: true });
  for (const file of files) {
    const sourcePath = resolveManifestPath(backupDir, file.path);
    if (!sourcePath) throw new Error(`manifest path escapes backup dir: ${file.path}`);
    copyFileSync(sourcePath, join(targetDir, basename(sourcePath)));
  }
  return files.length;
}

function validateRestoredDb(dbPath: string, manifest: BackupManifest) {
  const db = openDb(dbPath);
  try {
    const integrity = db.query("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      return { ok: false, error: `restored database failed integrity check: ${JSON.stringify(integrity)}` };
    }

    const fkErrors = db.query("PRAGMA foreign_key_check").all() as any[];
    if (fkErrors.length > 0) {
      return { ok: false, error: `restored database has FK violations: ${JSON.stringify(fkErrors)}` };
    }

    const audit = verifyAuditChain(db);
    if (!audit.ok) {
      return { ok: false, error: `restored database has broken audit chain: ${audit.errors.join(", ")}` };
    }

    const stats = {
      journalEntries: (db.query("SELECT COUNT(*) AS n FROM journal_entries").get() as { n: number }).n,
      documents: (db.query("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n,
      bankTransactions: (db.query("SELECT COUNT(*) AS n FROM bank_transactions").get() as { n: number }).n,
    };
    if (JSON.stringify(stats) !== JSON.stringify(manifest.ledgerStats)) {
      return { ok: false, error: `restored stats ${JSON.stringify(stats)} differ from manifest ${JSON.stringify(manifest.ledgerStats)}` };
    }

    return { ok: true as const };
  } finally {
    db.close();
  }
}

export type VerifyBackupSignatureInput = {
  backupDir: string;
  verificationKeyPath?: string;
  publicKeyPath?: string;
  // Out-of-band public-key hint. When set, an ed25519 key resolved from inside
  // the backup must match it or verification fails closed (issue #132).
  publicKeyHint?: string;
};

// trustLevel makes the integrity-vs-authenticity distinction explicit
// (issues #131/#132):
//  - "third-party-authenticity": an ed25519 signature verified against a
//    public key supplied OUT-OF-BAND. A 3rd party can rely on this.
//  - "integrity-only": something verified, but only with key material that
//    ships alongside the backup (the symmetric HMAC key, or an in-backup
//    ed25519 public key). This catches accidental corruption and tampering
//    by an actor without the key, but NOT a forge by a local actor who can
//    read/rewrite the co-located key.
//  - "none": nothing could be verified.
export type BackupTrustLevel = "third-party-authenticity" | "integrity-only" | "none";

export type VerifyBackupSignatureResult = {
  ok: boolean;
  backupId?: string;
  algorithms: string[];
  trustLevel: BackupTrustLevel;
  publicKeyHint?: string;
  hmacKeyHint?: string;
  errors: string[];
};

// Standalone verification — no restore, no DB writes, no target directory
// required. Designed for 3rd-party use (revisor/Skattestyrelsen) where the
// verifier holds only the backup directory and (optionally) a public key
// file received out-of-band.
export function verifyBackupSignature(input: VerifyBackupSignatureInput): VerifyBackupSignatureResult {
  if (!input.backupDir || !existsSync(input.backupDir)) {
    return { ok: false, algorithms: [], trustLevel: "none", errors: [`backupDir does not exist: ${input.backupDir}`] };
  }
  const manifestText = readManifestText(input.backupDir);
  if (!manifestText) return { ok: false, algorithms: [], trustLevel: "none", errors: [`invalid or missing backup manifest in ${input.backupDir}`] };
  const manifest = readManifest(input.backupDir);
  if (!manifest) return { ok: false, algorithms: [], trustLevel: "none", errors: [`invalid or missing backup manifest in ${input.backupDir}`] };

  const algorithms: string[] = [];
  const errors: string[] = [];
  let sawOutOfBandAuthenticity = false;
  let sawIntegrity = false;

  // Ed25519 is the 3rd-party-friendly path. Try it first, but only if the
  // manifest advertises it. If the verifier only has a public key (no HMAC
  // key) and the manifest has no ed25519 signature, we cannot verify.
  if (manifest.asymmetricSignature) {
    const ed25519 = verifyManifestEd25519(input.backupDir, manifest, manifestText, input.publicKeyPath, input.publicKeyHint);
    if (ed25519 && "error" in ed25519) {
      errors.push(ed25519.error);
    } else if (ed25519) {
      algorithms.push("ed25519");
      // An ed25519 signature is third-party authenticity ONLY when the key
      // came from out-of-band. An in-backup key proves integrity only.
      if (ed25519.keySource === "out-of-band") sawOutOfBandAuthenticity = true;
      else sawIntegrity = true;
    }
  }

  // HMAC is verified when a key path is supplied or one can be inferred
  // (i.e. we are next to the source company root). Skipped silently for
  // pure 3rd-party verification where only the public key is held.
  const hasInferableHmacKey = input.verificationKeyPath || inferVerificationKeyPath(input.backupDir);
  if (hasInferableHmacKey) {
    const hmacError = verifyManifestHmac(input.backupDir, manifestText, input.verificationKeyPath);
    if (hmacError) {
      errors.push(hmacError);
    } else {
      algorithms.push("hmac-sha256");
      // HMAC is symmetric — the key can re-sign — so it is integrity-only,
      // never third-party authenticity (issue #131).
      sawIntegrity = true;
    }
  }

  if (algorithms.length === 0 && errors.length === 0) {
    errors.push(
      "no verifiable signature found: manifest has no asymmetricSignature block and no HMAC key was provided or inferable",
    );
  }

  // ALSO verify manifest file integrity claims (sha256/size) — a valid
  // signature over a manifest whose file hashes no longer match the on-disk
  // bytes is still a tamper-detection failure.
  const fileErrors = [
    ensureMatches(input.backupDir, manifest.dbSnapshot),
    ...manifest.copiedFiles.documentsOriginals.map((file) => ensureMatches(input.backupDir, file)),
    ...manifest.copiedFiles.invoicesIssued.map((file) => ensureMatches(input.backupDir, file)),
    ...manifest.copiedFiles.config.map((file) => ensureMatches(input.backupDir, file)),
  ].filter((value): value is string => Boolean(value));
  errors.push(...fileErrors);

  const ok = errors.length === 0 && algorithms.length > 0;
  // trustLevel reflects the STRONGEST guarantee that actually held. If
  // anything failed, the backup is not trustworthy at all -> "none".
  const trustLevel: BackupTrustLevel = !ok
    ? "none"
    : sawOutOfBandAuthenticity
      ? "third-party-authenticity"
      : sawIntegrity
        ? "integrity-only"
        : "none";

  return {
    ok,
    backupId: manifest.backupId,
    algorithms,
    trustLevel,
    publicKeyHint: manifest.asymmetricSignature?.publicKeyHint,
    hmacKeyHint: manifest.manifestSignature?.keyHint,
    errors,
  };
}

// Public entry point. `backupDir` may point at either a backup *directory*
// or a single-file backup *archive* (.tar produced by packBackupArchive). An
// archive is extracted into a throwaway temp directory and restored from
// there — note that HMAC-key inference only works for a directory still
// sitting in its original `backups/` parent, so archive restores generally
// need an explicit `verificationKeyPath` (or an ed25519 public key).
export function restoreSystemBackup(input: RestoreSystemBackupInput): RestoreSystemBackupResult {
  const source = input.backupDir;
  if (source && existsSync(source) && statSync(source).isFile()) {
    let extractDir: string;
    try {
      extractDir = mkdtempSync(join(tmpdir(), "rentemester-restore-archive-"));
    } catch (error) {
      return { ok: false, appliedRules: [RULE_ID], errors: [`failed to stage archive extraction: ${String(error)}`] };
    }
    try {
      extractTar(readFileSync(source), extractDir);
    } catch (error) {
      rmSync(extractDir, { recursive: true, force: true });
      return { ok: false, appliedRules: [RULE_ID], errors: [`failed to extract backup archive: ${String(error)}`] };
    }
    try {
      return restoreFromBackupDir({ ...input, backupDir: extractDir });
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }
  return restoreFromBackupDir(input);
}

function restoreFromBackupDir(input: RestoreSystemBackupInput): RestoreSystemBackupResult {
  const errors: string[] = [];
  if (!input.backupDir || !existsSync(input.backupDir)) errors.push(`backupDir does not exist: ${input.backupDir}`);
  if (!input.targetCompanyRoot) errors.push("targetCompanyRoot is required");
  if (errors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors };

  const manifestText = readManifestText(input.backupDir);
  if (!manifestText) return { ok: false, appliedRules: [RULE_ID], errors: [`invalid or missing backup manifest in ${input.backupDir}`] };
  const manifest = readManifest(input.backupDir);
  if (!manifest) return { ok: false, appliedRules: [RULE_ID], errors: [`invalid or missing backup manifest in ${input.backupDir}`] };
  const authenticityError = verifyManifestAuthenticity(input.backupDir, manifest, manifestText, input.verificationKeyPath, input.publicKeyPath, input.publicKeyHint);
  if (authenticityError) return { ok: false, appliedRules: [RULE_ID], errors: [authenticityError] };

  const manifestErrors = [
    ensureMatches(input.backupDir, manifest.dbSnapshot),
    ...manifest.copiedFiles.documentsOriginals.map((file) => ensureMatches(input.backupDir, file)),
    ...manifest.copiedFiles.invoicesIssued.map((file) => ensureMatches(input.backupDir, file)),
    ...manifest.copiedFiles.config.map((file) => ensureMatches(input.backupDir, file)),
  ].filter((value): value is string => Boolean(value));
  if (manifestErrors.length > 0) return { ok: false, appliedRules: [RULE_ID], errors: manifestErrors };

  if (targetHoldsLiveCompany(input.targetCompanyRoot)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`targetCompanyRoot already contains a company ledger; refusing to overwrite: ${input.targetCompanyRoot}`] };
  }

  const snapshotPath = resolveManifestPath(input.backupDir, manifest.dbSnapshot.path);
  if (!snapshotPath) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`manifest path escapes backup dir: ${manifest.dbSnapshot.path}`] };
  }

  // Issue #139: build the entire restored company inside a temp staging
  // directory, validate the database THERE, and only swap it into the target
  // once validation passes. A backup that passes file-hash checks but fails
  // validateRestoredDb (e.g. a broken audit chain) therefore never leaves a
  // half-restored, unrecoverable target behind.
  const resolvedTarget = resolve(input.targetCompanyRoot);
  const stagingRoot = join(
    dirname(resolvedTarget),
    `.restore-${basename(resolvedTarget)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`,
  );
  if (existsSync(stagingRoot)) {
    return { ok: false, appliedRules: [RULE_ID], errors: [`restore staging directory already exists: ${stagingRoot}`] };
  }

  const restoredAt = new Date().toISOString();
  let restoredFiles: { documentsOriginals: number; invoicesIssued: number; config: number };
  try {
    const stagingPaths = ensureCompanyDirs(stagingRoot);
    copyFileSync(snapshotPath, stagingPaths.db);
    restoredFiles = {
      documentsOriginals: restoreFiles(input.backupDir, manifest.copiedFiles.documentsOriginals, stagingPaths.documentsOriginals),
      invoicesIssued: restoreFiles(input.backupDir, manifest.copiedFiles.invoicesIssued, stagingPaths.invoicesIssued),
      config: restoreFiles(input.backupDir, manifest.copiedFiles.config, stagingPaths.config),
    };

    const validation = validateRestoredDb(stagingPaths.db, manifest);
    if (!validation.ok) {
      rmSync(stagingRoot, { recursive: true, force: true });
      return { ok: false, appliedRules: [RULE_ID], errors: [validation.error] };
    }

    const db = openDb(stagingPaths.db);
    try {
      insertAuditLog(db, {
        eventType: "system_restore",
        entityType: "company",
        entityId: 1,
        message: `Restored from backup ${manifest.backupId} (created ${manifest.createdAt}) at ${restoredAt}`,
      });
    } finally {
      db.close();
    }

    // Atomic swap into place. The target must not yet hold a live company
    // (checked above); if an empty placeholder dir exists, drop it so the
    // rename lands cleanly.
    if (existsSync(resolvedTarget)) {
      rmSync(resolvedTarget, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(resolvedTarget), { recursive: true });
    }
    renameSync(stagingRoot, resolvedTarget);
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    return { ok: false, appliedRules: [RULE_ID], errors: [`restore failed: ${String(error)}`] };
  }

  return {
    ok: true,
    backupId: manifest.backupId,
    restoredAt,
    targetCompanyRoot: input.targetCompanyRoot,
    restoredDbPath: companyPaths(input.targetCompanyRoot).db,
    restoredFiles,
    appliedRules: [RULE_ID],
    errors: [],
  };
}
