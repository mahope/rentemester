// Dependency-free, deterministic USTAR tar writer/reader.
//
// A backup is moved off-site as ONE file (the user drops it in a synced
// folder, the agent pushes it). A directory is not "one file"; a tar is.
// We roll our own rather than shell out to `tar` so the archive is
// byte-for-byte identical for identical input — same property the rest of
// the backup pipeline relies on (manifest hashes, signatures).
//
// Determinism: every variable a real `tar` would stamp in (mtime, uid/gid,
// owner names) is pinned to a constant. Only the file path, mode and bytes
// vary. Entries are sorted by path before writing.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const BLOCK = 512;

export type TarInputEntry = {
  // POSIX-style relative path inside the archive (always uses "/").
  path: string;
  content: Uint8Array;
  // Octal file mode. Defaults to 0o644; only the low 12 bits are kept.
  mode?: number;
};

export type TarEntry = {
  path: string;
  content: Uint8Array;
  mode: number;
};

function octalField(value: number, len: number): Buffer {
  // USTAR numeric fields: (len-1) octal digits, zero-padded, NUL-terminated.
  const digits = len - 1;
  const truncated = Math.trunc(value);
  if (truncated < 0 || !Number.isFinite(truncated)) {
    throw new Error(`tar: numeric field value must be a non-negative finite number, got ${value}`);
  }
  const text = truncated.toString(8);
  if (text.length > digits) {
    throw new Error(`tar: value ${value} does not fit in ${digits} octal digits`);
  }
  const field = Buffer.alloc(len);
  field.write(text.padStart(digits, "0"), 0, digits, "ascii");
  return field;
}

function writeString(header: Buffer, value: string, offset: number, len: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > len) {
    throw new Error(`tar: field value '${value}' exceeds ${len} bytes`);
  }
  bytes.copy(header, offset);
}

// Split a path into name(<=100) + prefix(<=155) on a "/" boundary, per USTAR.
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  const segments = path.split("/");
  for (let cut = 1; cut < segments.length; cut += 1) {
    const prefix = segments.slice(0, cut).join("/");
    const name = segments.slice(cut).join("/");
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`tar: path too long for USTAR format: ${path}`);
}

function buildHeader(entry: { path: string; size: number; mode: number }): Buffer {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(entry.path);
  writeString(header, name, 0, 100);
  octalField(entry.mode & 0o7777, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108); // uid
  octalField(0, 8).copy(header, 116); // gid
  octalField(entry.size, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136); // mtime — pinned for determinism
  header[156] = 0x30; // typeflag '0' = regular file
  writeString(header, "ustar", 257, 6);
  header[262] = 0; // magic NUL terminator
  header.write("00", 263, 2, "ascii"); // version
  octalField(0, 8).copy(header, 329); // devmajor
  octalField(0, 8).copy(header, 337); // devminor
  if (prefix) writeString(header, prefix, 345, 155);

  // Checksum is computed with the 8 checksum bytes treated as spaces.
  for (let i = 148; i < 156; i += 1) header[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i]!;
  // Stored as 6 octal digits, NUL, space.
  header.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function pad512(size: number): number {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

export function createTar(entries: TarInputEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.path === sorted[i - 1]!.path) {
      throw new Error(`tar: duplicate entry path: ${sorted[i]!.path}`);
    }
  }
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    if (entry.path.length === 0 || entry.path.startsWith("/") || entry.path.includes("\0")) {
      throw new Error(`tar: invalid entry path: ${entry.path}`);
    }
    const content = Buffer.from(entry.content);
    chunks.push(buildHeader({ path: entry.path, size: content.length, mode: entry.mode ?? 0o644 }));
    chunks.push(content);
    const padding = pad512(content.length);
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks terminate the archive
  return Buffer.concat(chunks);
}

function parseOctal(field: Buffer): number {
  let text = "";
  for (const byte of field) {
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  if (text.length === 0) return 0;
  const value = parseInt(text, 8);
  if (Number.isNaN(value)) throw new Error("tar: malformed octal field");
  return value;
}

function parseString(field: Buffer): string {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

export function readTar(archive: Buffer): TarEntry[] {
  if (archive.length % BLOCK !== 0) {
    throw new Error("tar: archive length is not a multiple of 512");
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  // A well-formed archive ends with a zero block. Requiring it — rather than
  // just stopping when the buffer runs out — is what catches a truncated or
  // interrupted transfer that would otherwise restore silently.
  let sawTerminator = false;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      sawTerminator = true;
      break;
    }

    // Verify the header checksum — cheap corruption/tamper detection.
    const stored = parseOctal(header.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    }
    if (sum !== stored) {
      throw new Error("tar: header checksum mismatch (archive is corrupt or tampered)");
    }

    const name = parseString(header.subarray(0, 100));
    const prefix = parseString(header.subarray(345, 500));
    const fullPath = prefix ? `${prefix}/${name}` : name;
    const mode = parseOctal(header.subarray(100, 108));
    const size = parseOctal(header.subarray(124, 136));
    const typeflag = header[156];

    offset += BLOCK;
    // The declared body (and its padding) must fit inside the archive — a
    // size field that overruns the buffer means the archive is truncated.
    if (size < 0 || offset + size + pad512(size) > archive.length) {
      throw new Error(`tar: archive is truncated — entry '${fullPath}' body extends past end of archive`);
    }
    const content = archive.subarray(offset, offset + size);
    offset += size + pad512(size);

    // typeflag '0' or NUL = regular file. Directory ('5') entries are not
    // emitted by createTar; restore recreates directories on demand.
    if (typeflag === 0x30 || typeflag === 0) {
      entries.push({ path: fullPath, content: Buffer.from(content), mode });
    }
  }
  if (!sawTerminator) {
    throw new Error("tar: archive is missing its terminating zero block (truncated or incomplete)");
  }
  return entries;
}

// Path-traversal-safe extraction: an entry whose path is absolute or escapes
// destDir via ".." is rejected outright rather than silently clamped.
export function extractTar(archive: Buffer, destDir: string): string[] {
  const written: string[] = [];
  for (const entry of readTar(archive)) {
    const segments = entry.path.split("/");
    if (
      entry.path.startsWith("/") ||
      segments.includes("..") ||
      segments.includes("") ||
      entry.path.includes("\\")
    ) {
      throw new Error(`tar: refusing unsafe entry path: ${entry.path}`);
    }
    const target = join(destDir, ...segments);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
    written.push(entry.path);
  }
  return written;
}

// Walks a directory tree into deterministic tar input entries with
// POSIX-style relative paths. Empty directories are dropped — restore
// recreates the fixed backup layout regardless.
export function dirToTarEntries(rootDir: string): TarInputEntry[] {
  const entries: TarInputEntry[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        walk(abs);
      } else if (item.isFile()) {
        const rel = relative(rootDir, abs).split(sep).join("/");
        entries.push({ path: rel, content: readFileSync(abs) });
      }
    }
  };
  walk(rootDir);
  return entries;
}
