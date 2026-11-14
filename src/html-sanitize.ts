import DOMPurify from 'dompurify';

export interface SanitizeHtmlOptions {
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

  const adopted = document.adoptNode(fragment) as DocumentFragment;
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
