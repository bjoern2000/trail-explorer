// Trail data model page — renders data-model.jsonc, it does not describe it.
//
// `data-model.jsonc` at the repo root is the single source of truth for the model. This
// page imports that file as TEXT and parses it at load, so the page cannot drift from the
// model: editing the jsonc is editing the page, and there is no second copy of a field
// name, an example value or a provenance tag anywhere in this module.
//
// Why a hand-written parser rather than JSON.parse. Everything that makes the file worth
// reading lives in its comments: the provenance tag on each field, the one-sentence
// derivation, the `-> Entity` relations, the `// group` separators, and the dashed banner
// blocks that introduce each entity. JSON.parse throws all of that away, and a jsonc
// library would only recover part of it and would be a new dependency. So the parser is
// line-based and reads the comments as data.
//
// TOLERANCE IS A REQUIREMENT, not a nicety. Someone will edit the jsonc without opening
// this file, so every unrecognised line degrades to a plain comment row rather than
// throwing: an unparseable line costs one row of fidelity, never the page.

import '../tokens.css';
import './datamodel.css';

import raw from '../../data-model.jsonc?raw';

import { mountNav } from '../ui/nav';
import { h } from '../ui/dom';

const PAGE_DATE = '2026-08-31';

// ============================================================================
// MODEL
// ============================================================================

type Prov = 'source' | 'computed' | 'gap';

const PROV_MEANING: Record<Prov, string> = {
  source: 'published by an open data source as it stands',
  computed: 'derived by the pipeline from geometry, terrain or polygons',
  gap: 'nothing in open data provides it: editorial, licensing or telemetry work',
};

const isProv = (s: string): s is Prov => s === 'source' || s === 'computed' || s === 'gap';

interface FieldNode {
  kind: 'field';
  key: string;
  /** Verbatim value text from the file: strings keep their quotes, arrays their spacing. */
  value: string;
  /** `Place[]` from a `-> Place[]` in either the value or the comment. */
  relation: string | null;
  prov: Prov | null;
  /** What would fill a gap, from `[gap -> editorial]`. */
  fill: string | null;
  /** The rest of the comment sentence. */
  note: string;
  /** Present when the value is an object, inline or braced across lines. */
  children: DocNode[] | null;
}

interface CommentNode {
  kind: 'comment';
  text: string;
}

type DocNode = FieldNode | CommentNode;

interface Entity {
  name: string;
  /** From the dashed banner immediately above it, when that banner introduces only it. */
  intro: string;
  nodes: DocNode[];
}

type Item = { kind: 'band'; text: string } | { kind: 'entity'; entity: Entity };

// ============================================================================
// PARSER
// ============================================================================
//
// Shape: one pass over the lines, three pieces of state (a banner accumulator, the current
// entity, and a stack of node lists for nesting). Every branch below is a line SHAPE, and
// the last branch is the fallback that keeps an unknown line on the page as a comment.

/** Index of the `//` that starts a trailing comment, ignoring one inside a string. */
function commentStart(s: string): number {
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '/' && s[i + 1] === '/') return i;
  }
  return -1;
}

/** Split an inline object body on top-level commas. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

interface ParsedComment {
  prov: Prov | null;
  fill: string | null;
  relation: string | null;
  note: string;
}

/**
 * `[gap -> editorial] permits, closures, dogs` and
 * `[computed] -> Place[], every place whose scope holds this trail`.
 */
function parseComment(text: string): ParsedComment {
  let rest = text.trim();
  let prov: Prov | null = null;
  let fill: string | null = null;

  const tag = rest.match(/^\[([^\]]*)\]\s*/);
  if (tag) {
    rest = rest.slice(tag[0].length);
    const [head, ...tail] = tag[1].split('->');
    const word = head.trim().toLowerCase();
    if (isProv(word)) prov = word;
    if (tail.length) fill = tail.join('->').trim();
  }

  let relation: string | null = null;
  const rel = rest.match(/^->\s*([^,]+?)\s*(?:,\s*([\s\S]*))?$/);
  if (rel) {
    relation = rel[1].trim();
    rest = (rel[2] ?? '').trim();
  }

  return { prov, fill, relation, note: rest };
}

/** One `"key": value` line, already stripped of its trailing comment. */
function parseField(keyValue: string, comment: string): FieldNode | null {
  const m = keyValue.match(/^"([^"]+)"\s*:\s*([\s\S]*)$/);
  if (!m) return null;
  let value = m[2].trim().replace(/,$/, '').trim();

  const c = parseComment(comment);
  let relation = c.relation;

  // A relation can live in the value (`"-> Trail[]"`) or in the comment (`-> Region, …`).
  const inValue = value.match(/^"->\s*([\s\S]*)"$/);
  if (inValue) {
    relation = inValue[1].trim();
    value = '';
  }

  const node: FieldNode = {
    kind: 'field',
    key: m[1],
    value,
    relation,
    prov: c.prov,
    fill: c.fill,
    note: c.note,
    children: null,
  };

  // Inline object: `{ "highway": "path", "surface": "dirt" }` nests like a braced one.
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const kids: DocNode[] = [];
    for (const part of splitTopLevel(inner)) {
      const kid = parseField(part, '');
      if (kid) kids.push(kid);
    }
    if (kids.length) {
      node.children = kids;
      node.value = '';
    }
  }
  return node;
}

/** A rule line: box-drawing characters, or a run of plain dashes, equals or underscores. */
const BANNER_RE = /^[\u2500-\u257F=_-]{5,}$/;

function parseModel(src: string): Item[] {
  const items: Item[] = [];

  let banner: string[] | null = null;
  let pendingBanner: string | null = null;
  let entity: Entity | null = null;
  let stack: DocNode[][] = [];

  const push = (n: DocNode): void => {
    if (stack.length) stack[stack.length - 1].push(n);
  };

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // ---- banner blocks (the dashed // rules) --------------------------------
    if (line.startsWith('//')) {
      const body = line.slice(2).trim();
      if (BANNER_RE.test(body)) {
        if (banner === null) {
          banner = [];
        } else {
          pendingBanner = banner.join(' ').replace(/\s+/g, ' ').trim();
          banner = null;
        }
        continue;
      }
      if (banner !== null) {
        banner.push(body);
        continue;
      }
      // A comment line inside an entity is a group separator; outside one it is the file
      // preamble, which the page's own intro replaces.
      if (entity) push({ kind: 'comment', text: body });
      continue;
    }

    // ---- entity open --------------------------------------------------------
    const open = line.match(/^"([A-Za-z][\w-]*)"\s*:\s*\{\s*$/);
    if (open && !entity) {
      entity = { name: open[1], intro: '', nodes: [] };
      stack = [entity.nodes];
      if (pendingBanner) {
        items.push({ kind: 'band', text: pendingBanner });
        pendingBanner = null;
      }
      items.push({ kind: 'entity', entity });
      continue;
    }

    if (!entity) continue; // the outer `{` and the final `}`

    // ---- close a nested object, or the entity -------------------------------
    if (/^\}[,]?$/.test(line)) {
      if (stack.length > 1) stack.pop();
      else {
        entity = null;
        stack = [];
      }
      continue;
    }

    // ---- a field ------------------------------------------------------------
    const ci = commentStart(line);
    const keyValue = (ci >= 0 ? line.slice(0, ci) : line).trim();
    const comment = ci >= 0 ? line.slice(ci + 2).trim() : '';

    // Nested object opening across lines: `"canopy": {`
    const nest = keyValue.match(/^"([^"]+)"\s*:\s*\{$/);
    if (nest) {
      const c = parseComment(comment);
      const node: FieldNode = {
        kind: 'field',
        key: nest[1],
        value: '',
        relation: c.relation,
        prov: c.prov,
        fill: c.fill,
        note: c.note,
        children: [],
      };
      push(node);
      stack.push(node.children as DocNode[]);
      continue;
    }

    const field = parseField(keyValue, comment);
    if (field) push(field);
    else push({ kind: 'comment', text: line }); // tolerant fallback
  }

  // A banner with no entity after it still deserves to be on the page.
  if (pendingBanner) items.push({ kind: 'band', text: pendingBanner });

  // A banner that introduces exactly one entity reads as that entity's subtitle. A banner
  // that covers several (the "Related entities" block) stays a band above the group.
  const out: Item[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'band') {
      const next = items[i + 1];
      const after = items[i + 2];
      if (next?.kind === 'entity' && (!after || after.kind === 'band')) {
        next.entity.intro = it.text;
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

// ============================================================================
// RENDER
// ============================================================================

const chip = (prov: Prov): HTMLElement =>
  h('span', { class: `prov prov-${prov}`, title: PROV_MEANING[prov] }, prov);

/** Fields only, nested ones included, for the count in the card header. */
function countFields(nodes: DocNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.kind !== 'field') continue;
    n++;
    if (node.children) n += countFields(node.children);
  }
  return n;
}

/** True when every field that declares a provenance declares `gap`. */
function allGap(nodes: DocNode[]): boolean {
  let seen = 0;
  for (const node of nodes) {
    if (node.kind !== 'field' || !node.prov) continue;
    if (node.prov !== 'gap') return false;
    seen++;
  }
  return seen > 0;
}

function annotationOf(f: FieldNode): string {
  if (f.fill && f.note) return `${f.fill} · ${f.note}`;
  return f.fill ?? f.note;
}

function fieldRow(f: FieldNode): HTMLElement {
  const note = annotationOf(f);
  const attrs: Record<string, string> = { class: 'row' + (note ? ' row-tip' : '') };
  if (note) attrs.title = note;

  return h(
    'div',
    attrs,
    h('span', { class: 'r-k' }, f.key),
    h(
      'span',
      { class: 'r-v' },
      f.value && h('span', { class: 'r-lit' }, f.value),
      f.relation && h('span', { class: 'r-rel' }, `→ ${f.relation}`),
    ),
    h('span', { class: 'r-note' }, note),
    f.prov ? chip(f.prov) : h('span', {}),
  );
}

/**
 * A nested object renders as a collapsible branch with a left guide line. Default open,
 * because the hierarchy is the thing the page is for; collapsing is for getting a long
 * entity back onto one screen.
 */
function nestedRow(f: FieldNode, kids: DocNode[]): HTMLElement {
  const note = annotationOf(f);
  const summary = h(
    'summary',
    { class: 'row row-sum' + (note ? ' row-tip' : '') },
    h('span', { class: 'r-k' }, f.key),
    h('span', { class: 'r-v' }, h('span', { class: 'r-lit' }, '{')),
    h('span', { class: 'r-note' }, note),
    f.prov ? chip(f.prov) : h('span', {}),
  );
  const det = h(
    'details',
    { class: 'nest', open: true, ...(note ? { title: note } : {}) },
    summary,
    h('div', { class: 'nest-body' }, ...kids.map(renderNode)),
    h('div', { class: 'row-brace nest-close' }, '}'),
  );
  return det;
}

function renderNode(n: DocNode): HTMLElement {
  if (n.kind === 'comment') return h('div', { class: 'row-comment' }, `// ${n.text}`);
  if (n.children) return nestedRow(n, n.children);
  return fieldRow(n);
}

function entityCard(e: Entity): HTMLElement {
  const fields = countFields(e.nodes);
  return h(
    'section',
    { class: 'ent' + (allGap(e.nodes) ? ' ent-gap' : '') },
    h(
      'div',
      { class: 'ent-head' },
      h('span', { class: 'ent-name' }, e.name),
      h('span', { class: 'ent-count' }, `${fields} field${fields === 1 ? '' : 's'}`),
    ),
    e.intro && h('p', { class: 'ent-intro' }, e.intro),
    h(
      'div',
      { class: 'ent-body' },
      h('div', { class: 'row-brace' }, '{'),
      ...e.nodes.map(renderNode),
      h('div', { class: 'row-brace' }, '}'),
    ),
  );
}

/** Entities small enough to sit beside each other rather than each taking a full row. */
const SMALL_FIELDS = 5;

function layout(items: Item[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  let grid: HTMLElement[] = [];

  const flush = (): void => {
    if (grid.length > 1) out.push(h('div', { class: 'ent-grid' }, ...grid));
    else out.push(...grid);
    grid = [];
  };

  for (const it of items) {
    if (it.kind === 'band') {
      flush();
      out.push(h('p', { class: 'band' }, it.text));
      continue;
    }
    const card = entityCard(it.entity);
    if (countFields(it.entity.nodes) <= SMALL_FIELDS && !it.entity.intro) {
      grid.push(card);
    } else {
      flush();
      out.push(card);
    }
  }
  flush();
  return out;
}

// ---- download ----------------------------------------------------------------------

function downloadSource(): void {
  const blob = new Blob([raw], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'data-model.jsonc';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- the page ------------------------------------------------------------------------

function buildDoc(): HTMLElement[] {
  const items = parseModel(raw);
  const entities = items.filter((i): i is { kind: 'entity'; entity: Entity } => i.kind === 'entity');
  const fields = entities.reduce((n, i) => n + countFields(i.entity.nodes), 0);

  const header = h(
    'header',
    { class: 'doc-head' },
    h('div', { class: 'doc-kicker' }, 'TrailScope'),
    h('h1', {}, 'The trail data model'),
    h(
      'p',
      { class: 'lede' },
      'This page renders ',
      h('code', {}, 'data-model.jsonc'),
      ' directly. That file is the single source of truth, so the model changes when it changes and nothing here restates it. Example values are real, read from Emerald Lake Trail in the frozen Rocky Mountain snapshot, one of 427 trails across three regions.',
    ),
    h(
      'div',
      { class: 'dm-bar' },
      h(
        'div',
        { class: 'dm-legend' },
        h('span', { class: 'dm-legend-lead' }, 'Every field carries a provenance tag'),
        ...(['source', 'computed', 'gap'] as Prov[]).map((prov) =>
          h('span', { class: 'dm-legend-item' }, chip(prov), h('span', { class: 'dm-legend-text' }, PROV_MEANING[prov])),
        ),
      ),
      h(
        'button',
        { class: 'doc-btn', type: 'button', onclick: () => downloadSource() },
        'DOWNLOAD DATA-MODEL.JSONC',
      ),
    ),
    h(
      'div',
      { class: 'dm-count' },
      `${entities.length} entities · ${fields} fields · weather and conditions deliberately absent from this revision`,
    ),
  );

  const footer = h(
    'footer',
    { class: 'doc-foot' },
    h(
      'p',
      {},
      'Trail geometry, names and tags plus wooded polygons: OpenStreetMap contributors, ODbL. Elevation, slope and aspect: Terrarium z13 (AWS elevation-tiles-prod, Mapzen/Nextzen). Place boundaries: Census TIGER, PAD-US, GNIS.',
    ),
    h('p', {}, `TrailScope · trail data source evaluation for The Weather Company · ${PAGE_DATE}`),
  );

  return [header, ...layout(items), footer];
}

// ---- boot ----------------------------------------------------------------------------

function boot(): void {
  mountNav('datamodel');
  const doc = document.getElementById('doc');
  if (doc) doc.replaceChildren(...buildDoc());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
