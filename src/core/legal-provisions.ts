import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type ProvisionKind = "operative" | "commencement" | "amendment";

export type Provision = {
  sourceId: string;
  ref: string;
  path: string[];
  kind: ProvisionKind;
  text: string;
  textHash: string;
};

type XmlNode = {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

type Token =
  | { type: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: "close"; name: string }
  | { type: "text"; value: string };

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
      return whole;
    }
    const replacement = ENTITIES[body];
    return replacement === undefined ? whole : replacement;
  });
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = xml.length;
  while (i < len) {
    if (xml[i] === "<") {
      if (xml.startsWith("<!--", i)) {
        const end = xml.indexOf("-->", i + 4);
        i = end === -1 ? len : end + 3;
        continue;
      }
      if (xml.startsWith("<?", i)) {
        const end = xml.indexOf("?>", i + 2);
        i = end === -1 ? len : end + 2;
        continue;
      }
      if (xml.startsWith("<![CDATA[", i)) {
        const end = xml.indexOf("]]>", i + 9);
        const inner = xml.slice(i + 9, end === -1 ? len : end);
        if (inner.length > 0) tokens.push({ type: "text", value: inner });
        i = end === -1 ? len : end + 3;
        continue;
      }
      if (xml.startsWith("<!", i)) {
        const end = xml.indexOf(">", i + 2);
        i = end === -1 ? len : end + 1;
        continue;
      }
      // Scan to the tag's closing '>', skipping any '>' inside quoted attributes.
      let j = i + 1;
      let quote = "";
      while (j < len) {
        const c = xml[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === ">") {
          break;
        }
        j += 1;
      }
      if (j >= len) break;
      const raw = xml.slice(i + 1, j).trim();
      i = j + 1;
      if (raw.startsWith("/")) {
        tokens.push({ type: "close", name: raw.slice(1).trim() });
        continue;
      }
      const selfClosing = raw.endsWith("/");
      const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
      const nameMatch = body.match(/^([^\s/]+)/);
      const name = nameMatch ? nameMatch[1] : body;
      const attrs: Record<string, string> = {};
      const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard while-re.exec idiom
      while ((m = attrRe.exec(body.slice(name.length))) !== null) {
        attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? "");
      }
      tokens.push({ type: "open", name, attrs, selfClosing });
      continue;
    }
    const next = xml.indexOf("<", i);
    const slice = xml.slice(i, next === -1 ? len : next);
    if (slice.length > 0) tokens.push({ type: "text", value: decodeEntities(slice) });
    i = next === -1 ? len : next;
  }
  return tokens;
}

function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  for (const token of tokenize(xml)) {
    const top = stack[stack.length - 1];
    if (token.type === "text") {
      top.text += token.value;
      continue;
    }
    if (token.type === "open") {
      const node: XmlNode = { name: token.name, attrs: token.attrs, children: [], text: "" };
      top.children.push(node);
      if (!token.selfClosing) stack.push(node);
      continue;
    }
    for (let s = stack.length - 1; s > 0; s -= 1) {
      if (stack[s].name === token.name) {
        stack.length = s;
        break;
      }
    }
  }
  return root;
}

function findFirst(node: XmlNode, name: string): XmlNode | undefined {
  for (const child of node.children) {
    if (child.name === name) return child;
    const nested = findFirst(child, name);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeText(parts: string[]): string {
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function collectCharText(node: XmlNode, skip: Set<XmlNode>, into: string[]): void {
  if (skip.has(node)) return;
  if (node.name === "Char") {
    if (node.text) into.push(node.text);
    return;
  }
  for (const child of node.children) collectCharText(child, skip, into);
}

function descendants(node: XmlNode, name: string, out: XmlNode[]): void {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    descendants(child, name, out);
  }
}

function directIndentatios(stk: XmlNode): XmlNode[] {
  const indexes: XmlNode[] = [];
  descendants(stk, "Index", indexes);
  const seen = new Set<XmlNode>();
  const result: XmlNode[] = [];
  for (const index of indexes) {
    for (const child of index.children) {
      if (child.name === "Indentatio" && !seen.has(child)) {
        seen.add(child);
        result.push(child);
      }
    }
  }
  return result;
}

function parseOrdinalLabel(label: string): string | undefined {
  const digits = label.match(/(\d+)/);
  if (digits) return digits[1];
  const letter = label.match(/([a-zæøåA-ZÆØÅ])/);
  if (letter) return letter[1].toLowerCase();
  return undefined;
}

function parseStkLabel(label: string): string | undefined {
  const match = label.match(/Stk\.\s*(\d+)/i);
  return match ? match[1] : undefined;
}

const SORT_KEY_RE = /(\d+|\D+)/g;

function comparePathSegment(a: string, b: string): number {
  const ax = a.match(SORT_KEY_RE) ?? [];
  const bx = b.match(SORT_KEY_RE) ?? [];
  const max = Math.max(ax.length, bx.length);
  for (let i = 0; i < max; i += 1) {
    const ap = ax[i];
    const bp = bx[i];
    if (ap === undefined) return -1;
    if (bp === undefined) return 1;
    const an = /^\d+$/.test(ap);
    const bn = /^\d+$/.test(bp);
    if (an && bn) {
      const diff = Number(ap) - Number(bp);
      if (diff !== 0) return diff;
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1;
    }
  }
  return 0;
}

// Numeric-aware comparison of two paragraf identifiers ("3", "3a", "9b", "138a")
// so that "3a" sorts after "3" and before "4". Exposed for range membership
// checks in the regulatory-coverage scope engine.
export function compareParagrafIds(a: string, b: string): number {
  return comparePathSegment(a.toLowerCase(), b.toLowerCase());
}

function comparePaths(a: string[], b: string[]): number {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const cmp = comparePathSegment(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const PARAGRAF_NAMES = new Set(["Paragraf", "AendringCentreretParagraf", "IkraftCentreretParagraf"]);

function isAmendmentDocument(root: XmlNode): boolean {
  const docType = findFirst(root, "DocumentType");
  if (docType && /Æ/.test(docType.text)) return true;
  const title = findFirst(root, "DocumentTitle");
  if (title && /ændring af/i.test(title.text)) return true;
  return false;
}

const COMMENCEMENT_PHRASE = "træder i kraft";

// A commencement provision either opens with the phrase ("Bekendtgørelsen
// træder i kraft …") or leads with a bare paragraf enumeration before it
// ("§§ 1-14, 18 og 38 træder i kraft …"). The phrase sitting after real prose —
// a delegation clause that merely mentions commencement timing — is not itself
// a commencement provision, so the prefix must carry no words other than "og".
function looksLikeCommencement(text: string): boolean {
  const idx = text.toLowerCase().indexOf(COMMENCEMENT_PHRASE);
  if (idx < 0) return false;
  if (idx <= 30) return true;
  const prefix = text.slice(0, idx).toLowerCase();
  return /^[§\s\d.,()\-–]*(?:\bog\b[§\s\d.,()\-–]*)*$/.test(prefix);
}

function classify(
  text: string,
  commencementContext: boolean,
  amendmentContext: boolean,
): ProvisionKind {
  if (commencementContext || looksLikeCommencement(text)) return "commencement";
  if (amendmentContext) return "amendment";
  return "operative";
}

export function extractProvisions(xmlText: string, sourceId: string): Provision[] {
  const root = parseXml(xmlText);
  const indhold = findFirst(root, "DokumentIndhold");
  if (!indhold) return [];
  const documentIsAmendment = isAmendmentDocument(root);

  const paragraffer: XmlNode[] = [];
  for (const name of PARAGRAF_NAMES) descendants(indhold, name, paragraffer);

  const provisions: Provision[] = [];

  for (const paragraf of paragraffer) {
    const localId = paragraf.attrs.localId;
    if (!localId) continue;
    const paragrafIsAmendment = paragraf.name === "AendringCentreretParagraf"
      || findFirst(paragraf, "Aendring") !== undefined
      || findFirst(paragraf, "AendringDefinition") !== undefined;
    const paragrafIsCommencement = paragraf.name === "IkraftCentreretParagraf";
    const explicitStk = paragraf.children.filter((child) => child.name === "Stk");
    const stkNodes = explicitStk.length > 0 ? explicitStk : [paragraf];

    stkNodes.forEach((stk, stkIndex) => {
      let stkOrdinal = String(stkIndex + 1);
      const explicatus = stk.children.find((child) => child.name === "Explicatus");
      if (explicatus) {
        const labelled = parseStkLabel(explicatus.text);
        if (labelled) stkOrdinal = labelled;
      }

      const indentatios = directIndentatios(stk);
      const stkSkip = new Set<XmlNode>();
      for (const child of stk.children) {
        if (child.name === "Explicatus") stkSkip.add(child);
      }
      for (const indents of indentatios) stkSkip.add(indents);
      const stkParts: string[] = [];
      collectCharText(stk, stkSkip, stkParts);
      const stkText = normalizeText(stkParts);
      const amendmentContext = documentIsAmendment || paragrafIsAmendment;

      provisions.push({
        sourceId,
        ref: `§ ${localId}, stk. ${stkOrdinal}`,
        path: [localId, stkOrdinal],
        kind: classify(stkText, paragrafIsCommencement, amendmentContext),
        text: stkText,
        textHash: `sha256:${sha256Hex(stkText)}`,
      });

      indentatios.forEach((indentatio, indentIndex) => {
        const indentExplicatus = indentatio.children.find((child) => child.name === "Explicatus");
        let ordinal = String(indentIndex + 1);
        if (indentExplicatus) {
          const parsed = parseOrdinalLabel(indentExplicatus.text);
          if (parsed) ordinal = parsed;
        }
        const isLitra = indentatio.attrs.formaInd === "Litra";
        const indentSkip = new Set<XmlNode>();
        if (indentExplicatus) indentSkip.add(indentExplicatus);
        for (const child of indentatio.children) {
          if (child.name === "Index") indentSkip.add(child);
        }
        const nestedIndexes: XmlNode[] = [];
        descendants(indentatio, "Index", nestedIndexes);
        for (const nested of nestedIndexes) indentSkip.add(nested);
        const indentParts: string[] = [];
        collectCharText(indentatio, indentSkip, indentParts);
        const indentText = normalizeText(indentParts);
        const label = isLitra ? `litra ${ordinal}` : `nr. ${ordinal}`;

        provisions.push({
          sourceId,
          ref: `§ ${localId}, stk. ${stkOrdinal}, ${label}`,
          path: [localId, stkOrdinal, ordinal],
          kind: classify(indentText, paragrafIsCommencement, amendmentContext),
          text: indentText,
          textHash: `sha256:${sha256Hex(indentText)}`,
        });
      });
    });
  }

  provisions.sort((a, b) => {
    const cmp = comparePaths(a.path, b.path);
    if (cmp !== 0) return cmp;
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
  return provisions;
}

// Whole-string match: any trailing or interleaved junk (a stray space in
// "§ 3 a", a dangling "og 7") fails the match and surfaces as a loud closure
// error rather than silently resolving to the wrong provision.
const PROVISION_REF_RE =
  /^§\s*(\d+[a-zæøå]*)(?:,\s*stk\.\s*(\d+)(?:,\s*(?:nr\.|litra)\s*(\d+|[a-zæøå]+))?)?$/i;

export function parseProvisionRef(ref: string): string[] | undefined {
  const match = ref.trim().match(PROVISION_REF_RE);
  if (!match) return undefined;
  const path = [match[1].toLowerCase()];
  if (match[2] !== undefined) path.push(match[2]);
  if (match[3] !== undefined) path.push(match[3].toLowerCase());
  return path;
}

export function findProvision(provisions: Provision[], ref: string): Provision | undefined {
  const path = parseProvisionRef(ref);
  if (!path) return undefined;
  return provisions.find((provision) =>
    provision.path.length === path.length
    && provision.path.every((segment, index) => segment === path[index]));
}

function repoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function loadAllProvisions(rootDir: string = repoRoot()): Map<string, Provision[]> {
  const downloadedDir = join(rootDir, "sources", "downloaded");
  const indexPath = join(downloadedDir, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{ id: string; localPath: string }>;
  const sorted = [...index].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const result = new Map<string, Provision[]>();
  for (const entry of sorted) {
    const xmlPath = join(rootDir, entry.localPath);
    const xmlText = readFileSync(xmlPath, "utf8");
    result.set(entry.id, extractProvisions(xmlText, entry.id));
  }
  return result;
}
