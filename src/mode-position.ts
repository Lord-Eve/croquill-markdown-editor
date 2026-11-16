import { EditorSelection, Transaction } from '@codemirror/state';
import type { EditorView as CMView } from '@codemirror/view';
import type { Node as PMNode } from '@milkdown/kit/prose/model';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView as PMView } from '@milkdown/kit/prose/view';

const MODE_POSITION_META = 'croquill-mode-position';
import { parseMarkdownAst, splitFrontmatter } from './fidelity';
import { normalizedOffset, sourceOffset } from './search-core';

type AstPosition = {
  start?: { offset?: number };
  end?: { offset?: number };
};

interface AstNodeLike {
  type: string;
  depth?: number;
  checked?: boolean | null;
  value?: string;
  position?: AstPosition;
  children?: AstNodeLike[];
}

export type InlineSegment =
  | { kind: 'exact'; rawFrom: number; rawTo: number; pmFrom: number; pmTo: number }
  | { kind: 'gap'; rawFrom: number; rawSplitRaw: number; rawTo: number; pmFrom: number; pmTo: number };

export interface AlignedBlock {
  rawStart: number;
  rawEnd: number;
  richPos: number;
  richEnd: number;
  isTextblock: boolean;
  canNodeSelect: boolean;
  contentSize: number;
  rawEmptyOffset: number;
  segments: InlineSegment[] | null;
}

export interface AlignedContainer {
  rawStart: number;
  rawEnd: number;
  richPos: number;
  richEnd: number;
  childBlockIndices: number[];
}

export interface DocumentAlignment {
  prefixLen: number;
  blocks: AlignedBlock[];
  containers: AlignedContainer[];
}

export type ModeScrollAnchor =
  | { kind: 'caret'; offsetFromVpTop: number }
  | { kind: 'block'; rawStart: number; rawEnd: number; offsetFromVpTop: number };

export interface CapturedModePosition {
  rawOffset: number;
  scrollAnchor: ModeScrollAnchor | null;
}

type PmToken =
  | { kind: 'text'; text: string; pmFrom: number; pmTo: number }
  | { kind: 'break'; pmFrom: number; pmTo: number }
  | { kind: 'inline_raw'; raw: string; pmFrom: number; pmTo: number }
  | { kind: 'footnote_ref'; label: string; pmFrom: number; pmTo: number }
  | { kind: 'unknown'; pmFrom: number; pmTo: number };

function isEmptyParagraphPm(node: PMNode): boolean {
  return node.type.name === 'paragraph' && node.content.size === 0;
}

function collectPmTokens(node: PMNode): PmToken[] {
  const tokens: PmToken[] = [];
  node.forEach((child, offset) => {
    if (child.isText) {
      const text = child.text ?? '';
      const last = tokens[tokens.length - 1];
      if (last && last.kind === 'text' && last.pmTo === offset) {
        last.text += text;
        last.pmTo += text.length;
      } else {
        tokens.push({ kind: 'text', text, pmFrom: offset, pmTo: offset + text.length });
      }
      return;
    }
    const name = child.type.name;
    if (name === 'hardbreak') {
      tokens.push({ kind: 'break', pmFrom: offset, pmTo: offset + child.nodeSize });
    } else if (name === 'croquill_inline_raw') {
      tokens.push({
        kind: 'inline_raw',
        raw: String(child.attrs.value ?? ''),
        pmFrom: offset,
        pmTo: offset + child.nodeSize,
      });
    } else if (name === 'footnote_reference') {
      const label = String(child.attrs.label ?? child.attrs.identifier ?? '');
      tokens.push({ kind: 'footnote_ref', label, pmFrom: offset, pmTo: offset + child.nodeSize });
    } else {
      tokens.push({ kind: 'unknown', pmFrom: offset, pmTo: offset + child.nodeSize });
    }
  });
  return tokens;
}

function verifyTextblockSegments(
  body: string,
  prefixLen: number,
  astBlock: AstNodeLike,
  astParent: AstNodeLike | null,
  isFirstChild: boolean,
  pmNode: PMNode,
): { exact: true; segments: InlineSegment[]; rawEmptyOffset: number } | { exact: false } {
  const blockStart = astBlock.position?.start?.offset;
  const blockEnd = astBlock.position?.end?.offset;
  if (blockStart == null || blockEnd == null) return { exact: false };

  const astChildren = astBlock.children ?? [];
  if (astChildren.length === 0) {
    if (pmNode.content.size === 0) {
      return { exact: true, segments: [], rawEmptyOffset: prefixLen + blockEnd };
    }
    return { exact: false };
  }

  const pmTokens = collectPmTokens(pmNode);
  if (pmTokens.some(token => token.kind === 'unknown')) return { exact: false };

  const firstStart = astChildren[0]?.position?.start?.offset;
  const lastEnd = astChildren[astChildren.length - 1]?.position?.end?.offset;
  if (firstStart == null || lastEnd == null) return { exact: false };

  let rawPos = firstStart;
  const rawEnd = lastEnd;

  // Task list items may include "[x] " in the AST paragraph start before Milkdown strips the marker.
  if (astParent?.type === 'listItem' && typeof astParent.checked === 'boolean' && isFirstChild) {
    const taskMatch = body.slice(rawPos, rawEnd).match(/^(\[[xX ]\]\s+)/);
    const firstPmText = pmTokens[0]?.kind === 'text' ? pmTokens[0].text : '';
    if (taskMatch && !firstPmText.startsWith(taskMatch[1])) {
      rawPos += taskMatch[1].length;
    }
  }

  const segments: InlineSegment[] = [];

  for (const token of pmTokens) {
    if (token.kind === 'text') {
      let tIdx = 0;
      const tLen = token.text.length;
      let segRawStart = rawPos;
      let segPmStart = token.pmFrom;

      while (tIdx < tLen) {
        if (rawPos < rawEnd && body[rawPos] === token.text[tIdx]) {
          rawPos += 1;
          tIdx += 1;
          continue;
        }
        if (token.text[tIdx] === '\n' || token.text[tIdx] === ' ') {
          const contMatch = body.slice(rawPos, rawEnd).match(/^(\r?\n)((?:[ \t]*>[ \t]?)*[ \t]*)/);
          if (contMatch) {
            if (rawPos > segRawStart) {
              segments.push({
                kind: 'exact',
                rawFrom: prefixLen + segRawStart,
                rawTo: prefixLen + rawPos,
                pmFrom: segPmStart,
                pmTo: token.pmFrom + tIdx,
              });
            }
            const nlLen = contMatch[1].length;
            const fullLen = contMatch[0].length;
            segments.push({
              kind: 'gap',
              rawFrom: prefixLen + rawPos,
              rawSplitRaw: prefixLen + rawPos + nlLen,
              rawTo: prefixLen + rawPos + fullLen,
              pmFrom: token.pmFrom + tIdx,
              pmTo: token.pmFrom + tIdx + 1,
            });
            rawPos += fullLen;
            tIdx += 1;
            segRawStart = rawPos;
            segPmStart = token.pmFrom + tIdx;
            continue;
          }
        }
        return { exact: false };
      }

      if (rawPos > segRawStart) {
        segments.push({
          kind: 'exact',
          rawFrom: prefixLen + segRawStart,
          rawTo: prefixLen + rawPos,
          pmFrom: segPmStart,
          pmTo: token.pmFrom + tLen,
        });
      }
      continue;
    }

    if (token.kind === 'break') {
      const slice = body.slice(rawPos, rawEnd);
      const lineBreak = slice.match(/^((?: {2,}|\\)\r?\n)((?:[ \t]*>[ \t]?)*[ \t]*)/);
      if (lineBreak) {
        const nlLen = lineBreak[1].length;
        const fullLen = lineBreak[0].length;
        segments.push({
          kind: 'gap',
          rawFrom: prefixLen + rawPos,
          rawSplitRaw: prefixLen + rawPos + nlLen,
          rawTo: prefixLen + rawPos + fullLen,
          pmFrom: token.pmFrom,
          pmTo: token.pmTo,
        });
        rawPos += fullLen;
        continue;
      }
      const nextToken = pmTokens[pmTokens.indexOf(token) + 1];
      const nextStartsNl = nextToken?.kind === 'text' && nextToken.text.startsWith('\n');
      const htmlBr = slice.match(
        nextStartsNl ? /^<br\b[^>]*\/?>/i : /^<br\b[^>]*\/?>(?:[ \t]*\r?\n(?:[ \t]*>[ \t]?)*[ \t]*)?/i,
      );
      if (htmlBr) {
        const tagOnly = slice.match(/^<br\b[^>]*\/?>/i)![0].length;
        const len = htmlBr[0].length;
        segments.push({
          kind: 'gap',
          rawFrom: prefixLen + rawPos,
          rawSplitRaw: prefixLen + rawPos + tagOnly,
          rawTo: prefixLen + rawPos + len,
          pmFrom: token.pmFrom,
          pmTo: token.pmTo,
        });
        rawPos += len;
        continue;
      }
      const softBreak = slice.match(/^(\r?\n)((?:[ \t]*>[ \t]?)*[ \t]*)/);
      if (softBreak) {
        const nlLen = softBreak[1].length;
        const fullLen = softBreak[0].length;
        segments.push({
          kind: 'gap',
          rawFrom: prefixLen + rawPos,
          rawSplitRaw: prefixLen + rawPos + nlLen,
          rawTo: prefixLen + rawPos + fullLen,
          pmFrom: token.pmFrom,
          pmTo: token.pmTo,
        });
        rawPos += fullLen;
        continue;
      }
      return { exact: false };
    }

    if (token.kind === 'inline_raw') {
      if (!token.raw || !body.slice(rawPos, rawEnd).startsWith(token.raw)) return { exact: false };
      segments.push({
        kind: 'gap',
        rawFrom: prefixLen + rawPos,
        rawSplitRaw: prefixLen + rawPos + Math.max(0, token.raw.length - 1),
        rawTo: prefixLen + rawPos + token.raw.length,
        pmFrom: token.pmFrom,
        pmTo: token.pmTo,
      });
      rawPos += token.raw.length;
      continue;
    }

    if (token.kind === 'footnote_ref') {
      const refMatch = body.slice(rawPos, rawEnd).match(/^\[\^([^\]]+)\]/);
      if (!refMatch || (token.label && refMatch[1] !== token.label)) return { exact: false };
      const len = refMatch[0].length;
      segments.push({
        kind: 'gap',
        rawFrom: prefixLen + rawPos,
        rawSplitRaw: prefixLen + rawPos + Math.max(0, len - 1),
        rawTo: prefixLen + rawPos + len,
        pmFrom: token.pmFrom,
        pmTo: token.pmTo,
      });
      rawPos += len;
      continue;
    }

    return { exact: false };
  }

  if (rawPos !== rawEnd) return { exact: false };
  return { exact: true, segments, rawEmptyOffset: prefixLen + rawPos };
}

function isAstImageParagraph(astNode: AstNodeLike): boolean {
  return astNode.type === 'paragraph' && (astNode.children?.length ?? 0) === 1 && astNode.children?.[0]?.type === 'image';
}

function isAstTocParagraph(body: string, astNode: AstNodeLike): boolean {
  if (astNode.type !== 'paragraph') return false;
  const start = astNode.position?.start?.offset;
  const end = astNode.position?.end?.offset;
  if (start == null || end == null) return false;
  return body.slice(start, end).trim() === '[TOC]';
}

function nodePairCompatible(body: string, astNode: AstNodeLike, pmNode: PMNode): 'container' | 'textblock' | 'degenerate' | 'mismatch' {
  const pmType = pmNode.type.name;
  if (pmType === 'croquill_raw_block' || pmType === 'croquill_html_comment') return 'degenerate';
  if (pmType === 'croquill_toc' && isAstTocParagraph(body, astNode)) return 'degenerate';
  if (pmType === 'image-block' && isAstImageParagraph(astNode)) return 'degenerate';
  if (pmType === 'table' && astNode.type === 'table') return 'degenerate';
  if ((pmType === 'code_block' || pmType === 'math_block') && (astNode.type === 'code' || astNode.type === 'math')) {
    return 'degenerate';
  }
  if (pmType === 'hr' && astNode.type === 'thematicBreak') return 'degenerate';
  if (pmType === 'footnote_definition' && astNode.type === 'footnoteDefinition') return 'degenerate';

  if (pmType === 'paragraph' && astNode.type === 'paragraph') return 'textblock';
  if (pmType === 'heading' && astNode.type === 'heading' && Number(pmNode.attrs.level) === astNode.depth) return 'textblock';

  if (pmType === 'blockquote' && astNode.type === 'blockquote') return 'container';
  if (pmType === 'croquill_alert' && astNode.type === 'blockquote') return 'container';
  if ((pmType === 'bullet_list' || pmType === 'ordered_list') && astNode.type === 'list') return 'container';
  if (pmType === 'list_item' && astNode.type === 'listItem') return 'container';

  return 'mismatch';
}

/** Builds a deterministic block-and-inline correspondence table between Markdown source and ProseMirror doc. */
export function buildDocumentAlignment(raw: string, richDoc: PMNode): DocumentAlignment {
  const { prefix, body } = splitFrontmatter(raw);
  const prefixLen = prefix.length;
  const astRoot = parseMarkdownAst(body) as AstNodeLike;
  const blocks: AlignedBlock[] = [];
  const containers: AlignedContainer[] = [];

  function pushDegenerate(astNode: AstNodeLike, pmNode: PMNode, richPos: number): number {
    const start = astNode.position?.start?.offset;
    const end = astNode.position?.end?.offset;
    if (start == null || end == null) return -1;
    const blockIndex = blocks.length;
    blocks.push({
      rawStart: prefixLen + start,
      rawEnd: prefixLen + end,
      richPos,
      richEnd: richPos + pmNode.nodeSize,
      isTextblock: pmNode.isTextblock,
      canNodeSelect: NodeSelection.isSelectable(pmNode),
      contentSize: pmNode.content.size,
      rawEmptyOffset: prefixLen + start,
      segments: null,
    });
    return blockIndex;
  }

  function alignChildren(
    astChildren: AstNodeLike[],
    astParent: AstNodeLike | null,
    pmParent: PMNode,
    pmContentStart: number,
  ): number[] {
    const childBlocks: number[] = [];
    const pmChildren: { node: PMNode; pos: number }[] = [];
    pmParent.forEach((child, offset) => pmChildren.push({ node: child, pos: pmContentStart + offset }));

    // Empty list items or an empty document contain a single synthetic empty paragraph in ProseMirror.
    if (astChildren.length === 0 && pmChildren.length === 1 && isEmptyParagraphPm(pmChildren[0].node)) {
      const parentEnd = astParent?.position?.end?.offset ?? body.length;
      const parentStart = astParent?.position?.start?.offset ?? body.length;
      const emptyIdx = blocks.length;
      blocks.push({
        rawStart: prefixLen + parentStart,
        rawEnd: prefixLen + parentEnd,
        richPos: pmChildren[0].pos,
        richEnd: pmChildren[0].pos + pmChildren[0].node.nodeSize,
        isTextblock: true,
        canNodeSelect: false,
        contentSize: 0,
        rawEmptyOffset: prefixLen + parentEnd,
        segments: [],
      });
      childBlocks.push(emptyIdx);
      return childBlocks;
    }

    const pairCount = Math.min(astChildren.length, pmChildren.length);
    for (let i = 0; i < pairCount; i++) {
      const astChild = astChildren[i];
      const { node: pmChild, pos: pmPos } = pmChildren[i];
      const kind = nodePairCompatible(body, astChild, pmChild);

      if (kind === 'degenerate') {
        const idx = pushDegenerate(astChild, pmChild, pmPos);
        if (idx !== -1) childBlocks.push(idx);
        continue;
      }

      if (kind === 'textblock') {
        const start = astChild.position?.start?.offset;
        const end = astChild.position?.end?.offset;
        if (start == null || end == null) continue;
        const verified = verifyTextblockSegments(body, prefixLen, astChild, astParent, i === 0, pmChild);
        const blockIndex = blocks.length;
        blocks.push({
          rawStart: prefixLen + start,
          rawEnd: prefixLen + end,
          richPos: pmPos,
          richEnd: pmPos + pmChild.nodeSize,
          isTextblock: true,
          canNodeSelect: false,
          contentSize: pmChild.content.size,
          rawEmptyOffset: verified.exact ? verified.rawEmptyOffset : prefixLen + start,
          segments: verified.exact ? verified.segments : null,
        });
        childBlocks.push(blockIndex);
        continue;
      }

      if (kind === 'container') {
        const start = astChild.position?.start?.offset;
        const end = astChild.position?.end?.offset;
        const nestedAstChildren = astChild.children ?? [];
        // Keep mismatched containers intact at container granularity rather than crossing blocks.
        const countMatches =
          nestedAstChildren.length === pmChild.childCount ||
          (astChild.type === 'listItem' && nestedAstChildren.length === 0 && pmChild.childCount === 1 && isEmptyParagraphPm(pmChild.child(0)));
        if (!countMatches) {
          const idx = pushDegenerate(astChild, pmChild, pmPos);
          if (idx !== -1) childBlocks.push(idx);
          continue;
        }
        const nestedIndices = alignChildren(nestedAstChildren, astChild, pmChild, pmPos + 1);
        if (start != null && end != null && nestedIndices.length > 0) {
          containers.push({
            rawStart: prefixLen + start,
            rawEnd: prefixLen + end,
            richPos: pmPos,
            richEnd: pmPos + pmChild.nodeSize,
            childBlockIndices: nestedIndices,
          });
        }
        childBlocks.push(...nestedIndices);
        continue;
      }

      // Stop walking further siblings once a structural mismatch appears.
      if (astParent !== null) {
        const idx = pushDegenerate(astParent, pmParent, Math.max(0, pmContentStart - 1));
        if (idx !== -1) childBlocks.push(idx);
      }
      break;
    }

    return childBlocks;
  }

  alignChildren(astRoot.children ?? [], null, richDoc, 0);
  return { prefixLen, blocks, containers };
}

function findDeepestRichBlock(alignment: DocumentAlignment, richPos: number): AlignedBlock | null {
  let match: AlignedBlock | null = null;
  for (const block of alignment.blocks) {
    if (richPos >= block.richPos && richPos <= block.richEnd) {
      if (!match || block.richPos >= match.richPos) match = block;
    }
  }
  return match;
}

/** Maps the head of a Rich ProseMirror selection to an exact raw Markdown character offset. */
export function mapRichSelectionToRawOffset(alignment: DocumentAlignment, rawLength: number, selection: Selection): number {
  const clampRaw = (offset: number) => Math.max(0, Math.min(rawLength, offset));

  if (selection instanceof NodeSelection) {
    const exactNode = alignment.blocks.find(block => block.richPos === selection.from);
    if (exactNode) return clampRaw(exactNode.rawStart);
    const enclosing = findDeepestRichBlock(alignment, selection.from);
    if (enclosing) return clampRaw(enclosing.rawStart);
  }

  const head = selection.head;
  const block = findDeepestRichBlock(alignment, head);
  if (!block) {
    for (const container of alignment.containers) {
      if (head >= container.richPos && head <= container.richEnd) return clampRaw(container.rawStart);
    }
    return clampRaw(alignment.prefixLen);
  }

  if (!block.segments || !block.isTextblock) {
    return clampRaw(block.rawStart);
  }

  if (block.segments.length === 0) {
    return clampRaw(block.rawEmptyOffset);
  }

  const pmOffset = Math.max(0, Math.min(block.contentSize, head - (block.richPos + 1)));
  for (const seg of block.segments) {
    if (seg.kind === 'exact') {
      if (pmOffset >= seg.pmFrom && pmOffset <= seg.pmTo) {
        return clampRaw(seg.rawFrom + (pmOffset - seg.pmFrom));
      }
    } else if (pmOffset <= seg.pmFrom) {
      return clampRaw(seg.rawFrom);
    } else if (pmOffset === seg.pmTo) {
      return clampRaw(seg.rawTo);
    }
  }

  const last = block.segments[block.segments.length - 1];
  return clampRaw(last.rawTo);
}

function findDeepestRawBlockIndex(alignment: DocumentAlignment, rawOffset: number): number {
  let match = -1;
  let bestSpan = Infinity;
  for (let i = 0; i < alignment.blocks.length; i++) {
    const block = alignment.blocks[i];
    if (rawOffset >= block.rawStart && rawOffset <= block.rawEnd) {
      const span = block.rawEnd - block.rawStart;
      if (span <= bestSpan) {
        bestSpan = span;
        match = i;
      }
    }
  }
  return match;
}

function createDegenerateBlockSelection(richDoc: PMNode, block: AlignedBlock): Selection {
  const node = richDoc.nodeAt(block.richPos);
  if (!node) return Selection.atStart(richDoc);

  if (block.isTextblock) {
    return TextSelection.create(richDoc, block.richPos + 1);
  }

  const isLeafLike =
    node.isAtom ||
    node.isLeaf ||
    node.type.name === 'croquill_raw_block' ||
    node.type.name === 'image-block' ||
    node.type.name === 'croquill_toc' ||
    node.type.name === 'croquill_html_comment' ||
    node.type.name === 'hr';

  if (isLeafLike && block.canNodeSelect) {
    try {
      return NodeSelection.create(richDoc, block.richPos);
    } catch {
      // Fallback below if ProseMirror disallows NodeSelection on this context.
    }
  }

  const innerStart = Math.min(richDoc.content.size, block.richPos + 1);
  const found = Selection.findFrom(richDoc.resolve(innerStart), 1, true);
  if (found && found.from >= block.richPos && found.to <= block.richEnd) {
    return found;
  }

  if (block.canNodeSelect) {
    try {
      return NodeSelection.create(richDoc, block.richPos);
    } catch {
      // Fallback below.
    }
  }
  return Selection.near(richDoc.resolve(block.richPos), 1);
}

/** Maps a raw Markdown character offset to a Rich ProseMirror selection, falling back safely to block starts. */
export function mapRawOffsetToRichSelection(
  alignment: DocumentAlignment,
  richDoc: PMNode,
  rawOffset: number,
): Selection {
  if (alignment.blocks.length === 0) return Selection.atStart(richDoc);
  if (rawOffset < alignment.prefixLen) return createDegenerateBlockSelection(richDoc, alignment.blocks[0]);

  const blockIndex = findDeepestRawBlockIndex(alignment, rawOffset);
  if (blockIndex === -1) {
    // Check if inside a container blank line before picking next or last block.
    for (let c = alignment.containers.length - 1; c >= 0; c--) {
      const container = alignment.containers[c];
      if (rawOffset >= container.rawStart && rawOffset <= container.rawEnd && container.childBlockIndices.length > 0) {
        const nextChildIdx =
          container.childBlockIndices.find(idx => alignment.blocks[idx].rawStart >= rawOffset) ??
          container.childBlockIndices[container.childBlockIndices.length - 1];
        const block = alignment.blocks[nextChildIdx];
        return block.isTextblock ? TextSelection.create(richDoc, block.richPos + 1) : createDegenerateBlockSelection(richDoc, block);
      }
    }

    const nextIdx = alignment.blocks.findIndex(block => block.rawStart >= rawOffset);
    if (nextIdx !== -1) {
      const block = alignment.blocks[nextIdx];
      return block.isTextblock ? TextSelection.create(richDoc, block.richPos + 1) : createDegenerateBlockSelection(richDoc, block);
    }

    const last = alignment.blocks[alignment.blocks.length - 1];
    if (last.isTextblock) {
      return TextSelection.create(richDoc, last.richPos + 1 + last.contentSize);
    }
    return createDegenerateBlockSelection(richDoc, last);
  }

  const block = alignment.blocks[blockIndex];
  if (!block.segments || !block.isTextblock) {
    return createDegenerateBlockSelection(richDoc, block);
  }

  if (block.segments.length === 0) {
    return TextSelection.create(richDoc, block.richPos + 1);
  }

  const firstSeg = block.segments[0];
  if (rawOffset < firstSeg.rawFrom) {
    return TextSelection.create(richDoc, block.richPos + 1);
  }

  for (const seg of block.segments) {
    if (seg.kind === 'exact') {
      if (rawOffset >= seg.rawFrom && rawOffset <= seg.rawTo) {
        return TextSelection.create(richDoc, block.richPos + 1 + seg.pmFrom + (rawOffset - seg.rawFrom));
      }
    } else if (rawOffset >= seg.rawFrom && rawOffset < seg.rawTo) {
      const pmPos = rawOffset < seg.rawSplitRaw ? seg.pmFrom : seg.pmTo;
      return TextSelection.create(richDoc, block.richPos + 1 + pmPos);
    }
  }

  return TextSelection.create(richDoc, block.richPos + 1 + block.contentSize);
}

function measureRichSelectionRect(view: PMView, selection: Selection): { top: number; bottom: number } | null {
  try {
    if (selection instanceof NodeSelection) {
      const dom = view.nodeDOM(selection.from);
      if (dom instanceof Element) {
        const rect = dom.getBoundingClientRect();
        if (rect.height > 0 || rect.width > 0) return { top: rect.top, bottom: rect.bottom };
      }
    }
    const coords = view.coordsAtPos(selection.head);
    return { top: coords.top, bottom: coords.bottom };
  } catch {
    return null;
  }
}

function measureSourcePosRect(view: CMView, cmPos: number): { top: number; bottom: number } | null {
  try {
    const clamped = Math.max(0, Math.min(view.state.doc.length, cmPos));
    const coords = view.coordsAtPos(clamped);
    if (coords) return { top: coords.top, bottom: coords.bottom };
    const lineBlock = view.lineBlockAt(clamped);
    return { top: view.documentTop + lineBlock.top, bottom: view.documentTop + lineBlock.bottom };
  } catch {
    return null;
  }
}

function measureRichBlockBox(view: PMView, block: AlignedBlock): { top: number; bottom: number } | null {
  try {
    const dom = view.nodeDOM(block.richPos);
    if (dom instanceof Element) {
      const rect = dom.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }
    const start = view.coordsAtPos(block.richPos + (block.isTextblock ? 1 : 0));
    return { top: start.top, bottom: start.bottom };
  } catch {
    return null;
  }
}

function collectAstBlockRanges(raw: string): { rawStart: number; rawEnd: number }[] {
  const { prefix, body } = splitFrontmatter(raw);
  const prefixLen = prefix.length;
  const astRoot = parseMarkdownAst(body) as AstNodeLike;
  const ranges: { rawStart: number; rawEnd: number }[] = [];

  const visit = (node: AstNodeLike) => {
    if (node.type === 'blockquote' || node.type === 'list' || node.type === 'listItem') {
      if (node.children?.length) {
        for (const child of node.children) visit(child);
        return;
      }
    }
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start != null && end != null) {
      ranges.push({ rawStart: prefixLen + start, rawEnd: prefixLen + end });
    }
  };

  for (const child of astRoot.children ?? []) visit(child);
  return ranges;
}

function measureSourceBlockBox(view: CMView, raw: string, range: { rawStart: number; rawEnd: number }): { top: number; bottom: number } | null {
  try {
    const docLen = view.state.doc.length;
    const from = Math.max(0, Math.min(docLen, normalizedOffset(raw, range.rawStart)));
    const to = Math.max(from, Math.min(docLen, normalizedOffset(raw, range.rawEnd)));
    const topBlock = view.lineBlockAt(from);
    const botBlock = view.lineBlockAt(to);
    return {
      top: view.documentTop + topBlock.top,
      bottom: view.documentTop + botBlock.bottom,
    };
  } catch {
    return null;
  }
}

/** Captures current caret raw offset and relative viewport scroll anchor prior to switching modes. */
export function captureModePosition(options: {
  fromMode: 'rich' | 'source';
  raw: string;
  richView: PMView | null;
  sourceView: CMView | null;
  scrollContainer?: HTMLElement;
}): CapturedModePosition | null {
  const { fromMode, raw, richView, sourceView, scrollContainer } = options;
  if (fromMode === 'rich') {
    if (!richView) return null;
    const alignment = buildDocumentAlignment(raw, richView.state.doc);
    const rawOffset = mapRichSelectionToRawOffset(alignment, raw.length, richView.state.selection);
    if (!scrollContainer) return { rawOffset, scrollAnchor: null };

    const vp = scrollContainer.getBoundingClientRect();
    const caret = measureRichSelectionRect(richView, richView.state.selection);
    if (caret && caret.bottom > vp.top + 0.5 && caret.top < vp.bottom - 0.5) {
      return { rawOffset, scrollAnchor: { kind: 'caret', offsetFromVpTop: caret.top - vp.top } };
    }

    for (const block of alignment.blocks) {
      const box = measureRichBlockBox(richView, block);
      if (box && box.bottom > vp.top + 0.5 && box.top < vp.bottom - 0.5) {
        return {
          rawOffset,
          scrollAnchor: { kind: 'block', rawStart: block.rawStart, rawEnd: block.rawEnd, offsetFromVpTop: box.top - vp.top },
        };
      }
    }
    return { rawOffset, scrollAnchor: null };
  }

  if (!sourceView) return null;
  const cmHead = sourceView.state.selection.main.head;
  const rawOffset = sourceOffset(raw, cmHead);
  if (!scrollContainer) return { rawOffset, scrollAnchor: null };

  const vp = scrollContainer.getBoundingClientRect();
  const caret = measureSourcePosRect(sourceView, cmHead);
  if (caret && caret.bottom > vp.top + 0.5 && caret.top < vp.bottom - 0.5) {
    return { rawOffset, scrollAnchor: { kind: 'caret', offsetFromVpTop: caret.top - vp.top } };
  }

  for (const range of collectAstBlockRanges(raw)) {
    const box = measureSourceBlockBox(sourceView, raw, range);
    if (box && box.bottom > vp.top + 0.5 && box.top < vp.bottom - 0.5) {
      return {
        rawOffset,
        scrollAnchor: { kind: 'block', rawStart: range.rawStart, rawEnd: range.rawEnd, offsetFromVpTop: box.top - vp.top },
      };
    }
  }

  return { rawOffset, scrollAnchor: null };
}

/** Applies Source caret from a raw offset without mutating undo history or scrolling. */
export function applySourceSelectionFromRaw(sourceView: CMView, raw: string, rawOffset: number): void {
  const cmPos = Math.max(0, Math.min(sourceView.state.doc.length, normalizedOffset(raw, rawOffset)));
  sourceView.dispatch({
    selection: EditorSelection.cursor(cmPos),
    annotations: [Transaction.addToHistory.of(false)],
  });
}

/** Applies Rich selection from a raw offset without mutating undo history or scrolling. */
export function applyRichSelectionFromRaw(richView: PMView, raw: string, rawOffset: number): void {
  const alignment = buildDocumentAlignment(raw, richView.state.doc);
  const selection = mapRawOffsetToRichSelection(alignment, richView.state.doc, rawOffset);
  const tr = richView.state.tr
    .setSelection(selection)
    .setMeta('addToHistory', false)
    .setMeta(MODE_POSITION_META, true);
  richView.dispatch(tr);
}

/**
 * Protects a NodeSelection restored by Source -> Rich mode switching against
 * spurious Blink DOM selectionchange resets on uneditable atom blocks until
 * genuine pointer or editing input occurs.
 */
export function modeNodeSelectionGuardPlugin(): Plugin {
  const key = new PluginKey<{ guarded: boolean }>('croquill-mode-node-selection-guard');
  return new Plugin({
    key,
    state: {
      init: () => ({ guarded: false }),
      apply(tr, value) {
        if (tr.getMeta(MODE_POSITION_META) === true) {
          return { guarded: tr.selection instanceof NodeSelection };
        }
        if (
          value.guarded &&
          (tr.docChanged ||
            tr.getMeta('pointer') ||
            tr.getMeta('croquill-user-key') ||
            !(tr.selection instanceof NodeSelection))
        ) {
          return { guarded: false };
        }
        return value;
      },
    },
    filterTransaction(tr, state) {
      const guarded = key.getState(state)?.guarded ?? false;
      if (
        guarded &&
        state.selection instanceof NodeSelection &&
        !tr.docChanged &&
        tr.selectionSet &&
        !tr.getMeta('pointer') &&
        !tr.getMeta('croquill-user-key') &&
        tr.getMeta('addToHistory') !== false &&
        !tr.getMeta(MODE_POSITION_META)
      ) {
        return false;
      }
      return true;
    },
    props: {
      handleDOMEvents: {
        mousedown(view) {
          if (key.getState(view.state)?.guarded) {
            view.dispatch(view.state.tr.setMeta('pointer', true).setMeta('addToHistory', false));
          }
          return false;
        },
        keydown(view, event) {
          const isModifier =
            event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta';
          const isModeShortcut =
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            (event.key === '/' || event.code === 'Slash' || (event.shiftKey && event.code === 'KeyM'));
          if (!isModifier && !isModeShortcut && key.getState(view.state)?.guarded) {
            view.dispatch(view.state.tr.setMeta('croquill-user-key', true).setMeta('addToHistory', false));
          }
          return false;
        },
      },
    },
  });
}

/** Restores relative viewport scroll position across animation frames after layout settles. */
export function scheduleModeScrollRestore(options: {
  targetMode: 'rich' | 'source';
  raw: string;
  anchor: ModeScrollAnchor;
  richView: PMView | null;
  sourceView: CMView | null;
  scrollContainer: HTMLElement;
}): () => void {
  const { targetMode, raw, anchor, richView, sourceView, scrollContainer } = options;
  let cancelled = false;
  let rafId = 0;
  let frame = 0;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
    scrollContainer.removeEventListener('wheel', cancel);
    scrollContainer.removeEventListener('touchstart', cancel);
    scrollContainer.removeEventListener('pointerdown', cancel);
  };

  scrollContainer.addEventListener('wheel', cancel, { passive: true });
  scrollContainer.addEventListener('touchstart', cancel, { passive: true });
  scrollContainer.addEventListener('pointerdown', cancel, { passive: true });

  let richTargetBlock: AlignedBlock | null = null;
  if (targetMode === 'rich' && anchor.kind === 'block' && richView) {
    const alignment = buildDocumentAlignment(raw, richView.state.doc);
    richTargetBlock =
      alignment.blocks.find(b => b.rawStart === anchor.rawStart) ??
      alignment.blocks.find(b => b.rawEnd >= anchor.rawStart) ??
      alignment.blocks[alignment.blocks.length - 1] ??
      null;
  }

  const measureCurrentTop = (): number | null => {
    if (targetMode === 'source') {
      if (!sourceView) return null;
      if (anchor.kind === 'caret') {
        const rect = measureSourcePosRect(sourceView, sourceView.state.selection.main.head);
        return rect?.top ?? null;
      }
      return measureSourceBlockBox(sourceView, raw, anchor)?.top ?? null;
    }

    if (!richView) return null;
    if (anchor.kind === 'caret') {
      return measureRichSelectionRect(richView, richView.state.selection)?.top ?? null;
    }
    return richTargetBlock ? measureRichBlockBox(richView, richTargetBlock)?.top ?? null : null;
  };

  const step = () => {
    if (cancelled) return;
    if (targetMode === 'source') sourceView?.requestMeasure();

    const actualTop = measureCurrentTop();
    if (actualTop !== null) {
      const vpTop = scrollContainer.getBoundingClientRect().top;
      const desiredTop = vpTop + anchor.offsetFromVpTop;
      const delta = actualTop - desiredTop;
      if (Math.abs(delta) > 0.5) {
        const maxScroll = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        scrollContainer.scrollTop = Math.max(0, Math.min(maxScroll, scrollContainer.scrollTop + delta));
      }
    }

    frame += 1;
    if (frame < 3) {
      rafId = requestAnimationFrame(step);
    } else {
      cancel();
    }
  };

  if (targetMode === 'source') sourceView?.requestMeasure();
  rafId = requestAnimationFrame(step);
  return cancel;
}
