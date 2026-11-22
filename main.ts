// mend: one patch tool for every AI edit format.
//
// mend reads an edit a model wrote — a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as
// JSON — and applies it to the tree of text files in the working directory,
// changing every file or none. The whole behaviour is SPEC.md in this repo:
// every sentence of it is a requirement, and this file is written to follow
// it sentence by sentence rather than to fit any one set of examples.
//
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]` on
// Node 22, standard library alone. When MAKEFUN_ENV_URL is set, the last
// lines below hand the run over to runner.ts, which runs this file once per
// check of the trial env; keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: exactly one line on stdout, nothing else. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or ... */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line with its trailing spaces and tabs removed. */
function trailStripped(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** A line with its leading and trailing spaces and tabs removed. */
function bothStripped(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A line as a matching tier sees it: tier 0 exact, tier 1 trailing stripped, tier 2 both stripped. */
function tierView(s: string, tier: number): string {
  if (tier === 1) return trailStripped(s);
  if (tier === 2) return bothStripped(s);
  return s;
}

/** A file as lines: its line break, its lines, and whether it ends with a break. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function readState(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeState(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

/** Every 0-based position at or after `from` where `old` occurs in `lines` at one tier. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  const want = old.map((l) => tierView(l, tier));
  for (let i = Math.max(0, from); i + old.length <= lines.length; i += 1) {
    let hit = true;
    for (let j = 0; j < old.length; j += 1) {
      if (tierView(lines[i + j]!, tier) !== want[j]) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 with --strict) at which `old`
 * occurs in `lines` at or after `from`, with every occurrence at that tier.
 */
function firstTier(lines: string[], old: string[], strict: boolean, from: number): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, old, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * One line of a replacement: `text` as the patch wrote it, and whether it is
 * a context line (written as the file's own matched line, never the patch's).
 */
interface PatchLine {
  text: string;
  ctx: boolean;
}

/**
 * The lines that replace a matched block: context lines become the file's own
 * matched lines; at tier 2 every other line is re-indented from the patch's
 * first old line's leading whitespace to the file's first matched line's.
 */
function replacement(n: PatchLine[], o: PatchLine[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const oCtx: number[] = [];
  for (let i = 0; i < o.length; i += 1) if (o[i]!.ctx) oCtx.push(i);
  let seenCtx = 0;
  const p = o.length > 0 ? leadOf(o[0]!.text) : '';
  const f = fileLines.length > 0 && at < fileLines.length ? leadOf(fileLines[at]!) : '';
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[at + oCtx[seenCtx]!]!);
      seenCtx += 1;
      continue;
    }
    if (tier !== 2) {
      out.push(item.text);
      continue;
    }
    const t = item.text;
    if (t === '' || t.trim() === '' || !t.startsWith(p)) {
      out.push(t);
    } else {
      out.push(f + t.slice(p.length));
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  move(oldP: string, newP: string, text: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, text);
    this.moves.push({ old: oldP, next: newP });
  }

  snapshot(): { now: Map<string, string | null>; moves: { old: string; next: string }[] } {
    return { now: new Map(this.now), moves: [...this.moves] };
  }

  restore(s: { now: Map<string, string | null>; moves: { old: string; next: string }[] }): void {
    this.now.clear();
    for (const [k, v] of s.now) this.now.set(k, v);
    this.moves.length = 0;
    for (const m of s.moves) this.moves.push(m);
  }
}

type Edit = (tree: Tree) => void;

/** Read a file the edit must change, checking the path is safe first. */
function needFile(tree: Tree, p: string): string {
  if (!safePath(p)) throw new Fail('unsafe', p);
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needFile(tree, p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = needFile(tree, p);
      const st = readState(before);
      if (line < 0 || line > st.lines.length) throw new Fail('no-match', p);
      st.lines.splice(line, 0, ...add);
      tree.set(p, writeState(st));
    };
  }
  return null;
}

/** The JSON edits of a patch (SPEC.md section 9): one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Detect the patch format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}


/** One unified hunk: its A, its old lines O and new lines N, and whether a `\` line follows its last context-or-+ line (noFinal) or its last + line (plusNoFinal). */
interface Hunk {
  a: number;
  o: PatchLine[];
  n: PatchLine[];
  noFinal: boolean;
  plusNoFinal: boolean;
}

/** One unified section: one edit. Pair paths are undefined when no ---/+++ pair names them, null when the pair names /dev/null (no file). */
interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A ---/+++ path: text after the four characters, up to the first tab, trimmed, one leading a/ or b/ removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw.startsWith('a/')) return raw.slice(2);
  if (raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

const GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a unified patch into its sections (SPEC.md section 6). */
function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const fresh = (): Section => ({ pairOld: undefined, pairNew: undefined, renameFrom: null, renameTo: null, gitOld: null, gitNew: null, newFile: false, deletedFile: false, hunks: [] });
  const push = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      push();
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.pairOld = oldP === '/dev/null' ? null : oldP;
        cur.pairNew = newP === '/dev/null' ? null : newP;
      } else {
        push();
        cur = fresh();
        cur.pairOld = oldP === '/dev/null' ? null : oldP;
        cur.pairNew = newP === '/dev/null' ? null : newP;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
          body.push(l);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const o: PatchLine[] = [];
      const n: PatchLine[] = [];
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k += 1) {
        const b = body[k]!;
        if (b.startsWith(' ') || b === '') {
          o.push({ text: b === '' ? '' : b.slice(1), ctx: true });
          n.push({ text: b === '' ? '' : b.slice(1), ctx: true });
          lastCtxPlus = k;
        } else if (b.startsWith('-')) {
          o.push({ text: b.slice(1), ctx: false });
        } else if (b.startsWith('+')) {
          n.push({ text: b.slice(1), ctx: false });
          lastCtxPlus = k;
          lastPlus = k;
        }
      }
      const after = (k: number): boolean => k >= 0 && k + 1 < body.length && body[k + 1]!.startsWith('\\');
      cur.hunks.push({ a: Number(m[1]), o, n, noFinal: after(lastCtxPlus), plusNoFinal: after(lastPlus) });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) cur.pairNew = headerPath(line) === '/dev/null' ? null : headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  push();
  return sections;
}

/** Apply one section's hunks in order to a file's state, tracking the line drift d. */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  const out: FileState = { lines: [...st.lines], br: st.br, final: st.final };
  let d = 0;
  for (const h of hunks) {
    const oText = h.o.map((x) => x.text);
    if (oText.length === 0) {
      const oldLen = out.lines.length;
      const pos = Math.min(Math.max(h.a + d, 0), oldLen);
      const ins = h.n.map((x) => x.text);
      out.lines.splice(pos, 0, ...ins);
      if (pos === oldLen) out.final = !h.noFinal;
    } else {
      const found = firstTier(out.lines, oText, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = replacement(h.n, h.o, out.lines, best, found.tier);
      const runsToEnd = best + oText.length === out.lines.length;
      out.lines.splice(best, oText.length, ...rep);
      if (runsToEnd) out.final = !h.noFinal;
    }
    d += h.n.length - h.o.length;
  }
  return out;
}

/** One unified section as one edit (SPEC.md section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom ?? sec.gitOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo ?? sec.gitNew;
    const isCreate = sec.pairOld === null || sec.newFile;
    const isDelete = sec.pairNew === null || sec.deletedFile;
    if (isCreate) {
      if (newP === null) return;
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let plusNoFinal = false;
      let anyPlus = false;
      for (const h of sec.hunks) {
        for (const item of h.n) if (!item.ctx) plus.push(item.text);
        if (h.n.some((x) => !x.ctx)) {
          anyPlus = true;
          plusNoFinal = h.plusNoFinal;
        }
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (anyPlus && !plusNoFinal ? '\n' : '');
      tree.set(newP, text);
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safePath(oldP)) throw new Fail('unsafe', oldP);
      if (!safePath(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const done = applyHunks(readState(before), sec.hunks, strict, oldP);
      tree.move(oldP, newP, writeState(done));
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    if (!safePath(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const done = applyHunks(readState(before), sec.hunks, strict, p);
    tree.set(p, writeState(done));
  };
}

/** The unified edits of a patch (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}


/** One SEARCH/REPLACE block: its path, its old lines and its new lines. */
interface SrBlock {
  path: string;
  old: string[];
  next: string[];
}

/** Parse SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceBlocks(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let k = searchAt - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchAt + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let k = searchAt + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    for (let k = eq + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchAt + 1}`);
    blocks.push({ path, old: lines.slice(searchAt + 1, eq), next: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

/** One SEARCH/REPLACE block as one edit (SPEC.md section 7). */
function searchReplaceEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.next.length === 0 ? '' : `${b.next.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const st = readState(before);
    const found = firstTier(st.lines, b.old, strict, 0);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.at.length > 1) throw new Fail('ambiguous', b.path);
    const at = found.at[0]!;
    const rep = replacement(
      b.next.map((t) => ({ text: t, ctx: false })),
      b.old.map((t) => ({ text: t, ctx: false })),
      st.lines,
      at,
      found.tier,
    );
    st.lines.splice(at, b.old.length, ...rep);
    tree.set(b.path, writeState(st));
  };
}

/** The SEARCH/REPLACE edits of a patch (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return searchReplaceBlocks(lines).map((b) => searchReplaceEdit(b, strict));
}

/** One V4A chunk: its anchor (null: none), whether it is anchored to the end of the file, its old and new lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: PatchLine[];
  n: PatchLine[];
}

/** One V4A section: one edit. */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
}

/** Parse a V4A patch into its sections (SPEC.md section 8). */
function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };
  const sectionPath = (l: string, kind: string): string => l.slice(`*** ${kind} File:`.length).trim();
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    const path = sectionPath(l, kind === 'add' ? 'Add' : kind === 'delete' ? 'Delete' : 'Update');
    const sec: VSection = { kind, path, moveTo: null, lines: [], chunks: [] };
    i += 1;
    const bodyStart = i;
    const body: string[] = [];
    while (i < last) {
      const b = lines[i]!;
      if (sectionStart(b) !== null) break;
      if (b.trimEnd() === '*** End Patch') break;
      body.push(b);
      i += 1;
    }
    while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
    const bodyLineNo = (k: number): number => bodyStart + k + 1;
    if (kind === 'add') {
      for (let k = 0; k < body.length; k += 1) {
        const b = body[k]!;
        if (b.startsWith('+')) sec.lines.push(b.slice(1));
        else if (b === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${bodyLineNo(k)}`);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < body.length; k += 1) {
        if (!isBlank(body[k]!)) throw new Exit2(`error: parse ${bodyLineNo(k)}`);
      }
    } else {
      let k = 0;
      if (body.length > 0 && body[0]!.startsWith('*** Move to:')) {
        sec.moveTo = body[0]!.slice('*** Move to:'.length).trim();
        k = 1;
      }
      let chunk: VChunk | null = null;
      let started = false;
      const closeChunk = (): void => {
        if (chunk !== null) {
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      while (k < body.length) {
        const b = body[k]!;
        if (b.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: b.slice(2).trim() === '' ? null : b.slice(2).trim(), eof: false, o: [], n: [] };
          started = true;
          k += 1;
          continue;
        }
        if (b.trimEnd() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${bodyLineNo(k)}`);
          chunk.eof = true;
          closeChunk();
          k += 1;
          continue;
        }
        if (b.startsWith('***')) throw new Exit2(`error: parse ${bodyLineNo(k)}`);
        if (chunk === null) {
          if (started) throw new Exit2(`error: parse ${bodyLineNo(k)}`);
          chunk = { anchor: null, eof: false, o: [], n: [] };
          started = true;
        }
        if (b.startsWith(' ') || b === '') {
          const t = b === '' ? '' : b.slice(1);
          chunk.o.push({ text: t, ctx: true });
          chunk.n.push({ text: t, ctx: true });
        } else if (b.startsWith('-')) {
          chunk.o.push({ text: b.slice(1), ctx: false });
        } else if (b.startsWith('+')) {
          chunk.n.push({ text: b.slice(1), ctx: false });
        } else {
          throw new Exit2(`error: parse ${bodyLineNo(k)}`);
        }
        k += 1;
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    }
    sections.push(sec);
  }
  return sections;
}

/** Apply one V4A section's chunks in order to a file's state, tracking the cursor. */
function applyVChunks(st: FileState, chunks: VChunk[], strict: boolean, path: string): FileState {
  const out: FileState = { lines: [...st.lines], br: st.br, final: st.final };
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let foundAt: number | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const tier of tiers) {
        for (let j = cursor; j < out.lines.length; j += 1) {
          if (tierView(out.lines[j]!, tier) === tierView(c.anchor, tier)) {
            foundAt = j;
            break;
          }
        }
        if (foundAt !== null) break;
      }
      if (foundAt === null) throw new Fail('no-match', path);
      cursor = foundAt + 1;
    }
    const oText = c.o.map((x) => x.text);
    if (oText.length === 0) {
      const pos = c.eof ? out.lines.length : cursor;
      const ins = c.n.map((x) => x.text);
      out.lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
      continue;
    }
    const found = firstTier(out.lines, oText, strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    let at: number | null = null;
    for (const p of found.at) {
      if (c.eof && p + oText.length !== out.lines.length) continue;
      at = p;
      break;
    }
    if (at === null) throw new Fail('no-match', path);
    const rep = replacement(c.n, c.o, out.lines, at, found.tier);
    out.lines.splice(at, oText.length, ...rep);
    cursor = at + rep.length;
  }
  return out;
}

/** One V4A section as one edit (SPEC.md section 8). */
function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    }
    const done = applyVChunks(readState(before), sec.chunks, strict, sec.path);
    const text = writeState(done);
    if (sec.moveTo !== null) tree.move(sec.path, sec.moveTo, text);
    else tree.set(sec.path, text);
  };
}

/** The V4A edits of a patch (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((s) => v4aEdit(s, strict));
}


/** Run the CLI once over its arguments (SPEC.md sections 1, 2 and 10). */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = tree.snapshot();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.restore(before);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const covered = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.now.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      covered.add(m.old);
      covered.add(m.next);
    }
  }
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  if (!check) {
    for (const p of [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
