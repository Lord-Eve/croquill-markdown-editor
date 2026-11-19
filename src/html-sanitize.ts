import DOMPurify from 'dompurify';
import { decodeEntity } from './character-references';

export interface SanitizeHtmlOptions {
  exportDocument?: Document;
  resolveImage?: (src: string) => Promise<string>;
  isStale?: () => boolean;
}

const DIRECT_IMAGE_URI_RE = /^(?:https?:|data:)/i;
const ASCII_CONTROL_SPACE_RE = /[\u0000-\u0020]+/g;

function isLocalImageSource(value: string): boolean {
  const compact = value.replace(ASCII_CONTROL_SPACE_RE, '');
  if (!compact) return false;
  if (/^file:/i.test(compact)) return true;
  if (/^[a-z]:[\\/]/i.test(compact)) return true;
  return !/^(?:\/\/|[a-z][a-z\d+.-]*:)/i.test(compact);
}

const pairedInlineTags = ['span', 'kbd', 'sup', 'sub', 'u', 'ins', 's', 'del', 'mark', 'b', 'strong', 'i', 'em', 'small', 'a'] as const;
type PairedInlineTag = typeof pairedInlineTags[number];
const isPairedInlineTag = (tag: string): tag is PairedInlineTag => pairedInlineTags.some(allowed => allowed === tag);
const commonInlineAttributes = new Set(['title', 'class', 'id', 'lang', 'dir']);
const imageAttributes = new Set(['src', 'alt', 'width', 'height']);
const inlineStyleProperties = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line']);

export interface InlineHtmlImage {
  tag: 'img';
  src: string;
  local: boolean;
  alt: string;
  title?: string;
  width?: string;
  height?: string;
}

export type InlineHtmlElement = InlineHtmlImage | {
  tag: PairedInlineTag;
  title?: string;
  href?: string;
  styles?: [property: string, value: string][];
};

function parseInlineAttributes(tag: string, tail: string): Map<string, string> | null {
  const attribute = /[\t\n\f\r ]+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/y;
  const attributes = new Map<string, string>();
  let end = 0;
  for (let match = attribute.exec(tail); match; match = attribute.exec(tail)) {
    const name = match[1].toLowerCase();
    if (attributes.has(name) || name.startsWith('on') ||
        !(commonInlineAttributes.has(name) || tag === 'span' && name === 'style' ||
          tag === 'a' && name === 'href' || tag === 'img' && imageAttributes.has(name))) return null;
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    const value = raw.replace(/&(?:#[xX][\da-fA-F]+;?|#\d+;?|[A-Za-z][A-Za-z\d]*;)/g, ref =>
      decodeEntity(ref.endsWith(';') ? ref : ref + ';'));
    attributes.set(name, value);
    end = attribute.lastIndex;
  }
  return /^[\t\n\f\r ]*\/?$/.test(tail.slice(end)) ? attributes : null;
}

function parseInlineStyles(raw: string): [string, string][] {
  const styles: [string, string][] = [];
  let depth = 0, start = 0;
  // A semicolon in a CSS string, comment or function is part of the value.
  const tokens = /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|\\[\s\S]|[()[\]{};]/g;
  for (const { 0: token, index } of (raw + ';').matchAll(tokens)) {
    if (token.length !== 1) continue;
    if ('([{'.includes(token)) depth++;
    else if (')]}'.includes(token)) depth = Math.max(0, depth - 1);
    else if (token === ';' && !depth) {
      const declaration = raw.slice(start, index).replace(/\/\*[\s\S]*?\*\//g, '');
      start = index + 1;
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      if (inlineStyleProperties.has(property) && value && !/(?:url|expression)\s*\(|[\\<]/i.test(value)) {
        styles.push([property, value]);
      }
    }
  }
  return styles;
}

function imageLength(value: string | undefined): string | undefined {
  const match = /^(\d+|(\d*\.\d+))(px|%)?$/i.exec(value?.trim() ?? '');
  if (!match || match[2] && !match[3] || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) return undefined;
  return match[1] + (match[3]?.toLowerCase() ?? 'px');
}

function isDirectInlineImageSource(src: string): boolean {
  if (/[\u0000-\u001f\u007f]/.test(src)) return false;
  return /^(?:https?:\/\/[^/\\\s]|data:image\/[a-z0-9.+-]+(?:;[^,]*)?,)/i.test(src);
}

/** Return only data the inline decoration may display. Unknown tags or attributes stay literal. */
export function sanitizeInlineHtml(tag: string, tail: string, paired: boolean): InlineHtmlElement | null {
  if (paired ? !isPairedInlineTag(tag) : tag !== 'img') return null;
  const attributes = parseInlineAttributes(tag, tail);
  if (!attributes) return null;
  const title = attributes.get('title');
  if (tag === 'img') {
    const src = attributes.get('src')?.trim() ?? '';
    const local = !/^(?:[\\/]{2}|[?#])|[\u0000-\u001f\u007f]/.test(src) && isLocalImageSource(src);
    if (!local && !isDirectInlineImageSource(src)) return null;
    return { tag, src, local, title, alt: attributes.get('alt') ?? '', width: imageLength(attributes.get('width')), height: imageLength(attributes.get('height')) };
  }
  if (!isPairedInlineTag(tag)) return null;
  return { tag, title, href: attributes.get('href')?.trim(), styles: tag === 'span' ? parseInlineStyles(attributes.get('style') ?? '') : undefined };
}

/** Serialize individual, validated CSS declarations for a decoration. */
export function inlineHtmlStyle(styles: [string, string][]): string {
  return styles.filter(([property, value]) => CSS.supports(property, value.replace(/\s*!\s*important$/i, '')))
    .map(([property, value]) => `${property}: ${value}`).join('; ');
}

/** Local resolver results are checked here too, before touching a DOM URL. */
export function createInlineHtmlImage(src: string, image: InlineHtmlImage): HTMLImageElement | null {
  if (!isDirectInlineImageSource(src)) return null;
  const dom = document.createElement('img');
  dom.className = 'md-html-image';
  dom.alt = image.alt;
  if (image.title) dom.title = image.title;
  if (image.width) dom.style.width = image.width;
  if (image.height) dom.style.height = image.height;
  dom.draggable = false;
  dom.src = src;
  return dom;
}

let htmlSanitizer: ReturnType<typeof DOMPurify> | null = null;
let activePendingImages: Map<Element, string> | null = null;

function getHtmlSanitizer(): ReturnType<typeof DOMPurify> {
  if (htmlSanitizer) return htmlSanitizer;
  // Isolate hooks from the default DOMPurify export so @milkdown/crepe keeps stock behavior.
  const instance = DOMPurify(window);
  instance.addHook('uponSanitizeAttribute', (node, data) => {
    if (!activePendingImages) return;
    if (node.nodeName.toLowerCase() !== 'img' || data.attrName !== 'src') return;
    const trimmed = data.attrValue.trim();
    if (!trimmed) {
      data.keepAttr = false;
      return;
    }
    const compact = trimmed.replace(ASCII_CONTROL_SPACE_RE, '');
    if (DIRECT_IMAGE_URI_RE.test(compact)) return;
    // Strip non-http/data img[src] synchronously before fragment adoption so relative paths,
    // C:/..., and file:///... neither leak to mounted DOM nor get dropped before resolveImage sees them.
    data.keepAttr = false;
    if (isLocalImageSource(trimmed)) {
      activePendingImages.set(node, trimmed);
    }
  });
  htmlSanitizer = instance;
  return instance;
}

const FORBID_TAGS = [
  'style',
  'script',
  'iframe',
  'frame',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'link',
  'meta',
  'base',
  'video',
  'audio',
  'source',
  'track',
  'svg',
  'math',
];

const FORBID_ATTR = ['srcset', 'ping', 'formaction'];

/** Sanitizes an HTML block into a DOM fragment using DOMPurify and resolves local image paths safely. */
export function sanitizeHtmlFragment(source: string, options: SanitizeHtmlOptions = {}): DocumentFragment {
  const pendingMap = new Map<Element, string>();
  let fragment: DocumentFragment;
  activePendingImages = pendingMap;
  try {
    fragment = getHtmlSanitizer().sanitize(source, {
      USE_PROFILES: { html: true },
      FORBID_TAGS,
      FORBID_ATTR,
      ALLOW_DATA_ATTR: false,
      SANITIZE_NAMED_PROPS: true,
      RETURN_DOM_FRAGMENT: true,
    }) as unknown as DocumentFragment;
  } finally {
    activePendingImages = null;
  }

  // Only resolve surviving <img> elements; discarded elements remain ignored.
  const pendingImages: Array<{ img: HTMLImageElement; src: string }> = [];
  for (const img of fragment.querySelectorAll('img')) {
    const rawSrc = pendingMap.get(img);
    if (!rawSrc) continue;
    img.removeAttribute('src');
    pendingImages.push({ img, src: rawSrc });
  }

  const adopted = (options.exportDocument ?? document).adoptNode(fragment) as DocumentFragment;
  if (options.exportDocument) {
    for (const { img, src } of pendingImages) img.setAttribute('src', src);
    for (const node of adopted.querySelectorAll('[contenteditable]')) node.removeAttribute('contenteditable');
  }
  if (options.resolveImage) {
    for (const { img, src } of pendingImages) {
      void options.resolveImage(src).then(resolved => {
        if (options.isStale?.() || !resolved) return;
        img.setAttribute('src', resolved);
      }).catch(() => {});
    }
  }
  return adopted;
}
