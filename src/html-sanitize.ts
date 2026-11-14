import DOMPurify from 'dompurify';

export interface SanitizeHtmlOptions {
  resolveImage?: (src: string) => Promise<string>;
  isStale?: () => boolean;
}

const DIRECT_IMAGE_URI_RE = /^(?:https?:|data:)/i;

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
  const fragment = DOMPurify.sanitize(source, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    SANITIZE_NAMED_PROPS: true,
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;

  // Strip relative or non-http/data img[src] before adopting into the live document so no app-origin HTTP request fires.
  const pendingImages: Array<{ img: HTMLImageElement; src: string }> = [];
  for (const img of fragment.querySelectorAll('img')) {
    const rawSrc = img.getAttribute('src');
    if (rawSrc == null) continue;
    const trimmed = rawSrc.trim();
    if (!trimmed) {
      img.removeAttribute('src');
      continue;
    }
    if (DIRECT_IMAGE_URI_RE.test(trimmed)) continue;
    img.removeAttribute('src');
    pendingImages.push({ img, src: trimmed });
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
