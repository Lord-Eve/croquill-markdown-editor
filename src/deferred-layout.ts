import { DOMSerializer } from '@milkdown/kit/prose/model';
import { Plugin } from '@milkdown/kit/prose/state';
import type { NodeViewConstructor } from '@milkdown/kit/prose/view';

const minBlocks = 100;
const componentSelector = '.table-wrapper,.milkdown-code-block,.croquill-html-preview';

/** Keep the natural content-box height, including wrapped lines, before a text
 * block becomes eligible for offscreen containment. No editor transaction or
 * additional DOM around the caret is needed. */
export function deferredLayout() {
  const size = new ResizeObserver(entries => {
    for (const { target, contentRect } of entries) {
      if (contentRect.height > 0 && target.getAttribute('data-layout-height') !== String(contentRect.height))
        target.setAttribute('data-layout-height', String(contentRect.height));
    }
  });
  const textBlock: NodeViewConstructor = (node, view) => {
    const { dom, contentDOM } = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node));
    if (view.state.doc.childCount >= minBlocks) size.observe(dom as Element);
    return {
      dom, contentDOM,
      ignoreMutation: m => m.type === 'attributes' && m.target === dom && m.attributeName === 'data-layout-height',
      destroy: () => size.unobserve(dom as Element),
    };
  };
  return new Plugin({
    props: {
      attributes: state => ({ class: state.doc.childCount >= minBlocks ? 'long-document' : '' }),
      nodeViews: { paragraph: textBlock, heading: textBlock },
    },
    view(view) {
      const parent = view.dom.parentElement!;
      let components = new Set<Element>();
      function observeComponents() {
        const next = new Set(view.dom.querySelectorAll(componentSelector));
        for (const el of components) if (!next.has(el)) size.unobserve(el);
        for (const el of next) if (!components.has(el)) size.observe(el);
        components = next;
      }
      if (view.state.doc.childCount >= minBlocks) observeComponents();
      let firstToc: Element | null = null;
      const tocSize = new ResizeObserver(([entry]) => {
        if (entry.target === firstToc && entry.contentRect.height) {
          parent.style.setProperty('--toc-height', entry.contentRect.height + 'px');
          firstToc.setAttribute('data-toc-sized', '');
        }
      });
      function observeToc() {
        const toc = view.dom.querySelector(':scope > nav[data-croquill-toc]');
        if (toc === firstToc) return;
        tocSize.disconnect(); firstToc = toc;
        parent.style.removeProperty('--toc-height');
        if (toc) tocSize.observe(toc);
      }
      observeToc();
      // A different available width or font can wrap offscreen text again.
      // Give ResizeObserver a natural layout pass to refresh all stored sizes.
      let width = 0, frame = 0;
      function remeasure() {
        if (view.state.doc.childCount < minBlocks) return;
        parent.style.setProperty('--offscreen-layout', 'visible');
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => parent.style.removeProperty('--offscreen-layout'));
        });
      }
      const viewport = new ResizeObserver(([entry]) => {
        const next = entry.contentRect.width;
        if (!next) return;
        if (width && width !== next) remeasure();
        width = next;
      });
      viewport.observe(view.dom);
      const settings = new MutationObserver(remeasure);
      settings.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
      document.fonts.addEventListener('loadingdone', remeasure);
      return {
        update(current, previous) {
          if (current.state.doc === previous.doc) return;
          if (current.state.doc.childCount !== previous.doc.childCount || firstToc && !view.dom.contains(firstToc)) {
            observeToc();
            if (current.state.doc.childCount >= minBlocks) {
              observeComponents();
              if (previous.doc.childCount < minBlocks) {
                for (const el of view.dom.querySelectorAll('p,h1,h2,h3,h4,h5,h6')) size.observe(el);
              }
            }
          }
        },
        destroy() {
          size.disconnect(); tocSize.disconnect(); viewport.disconnect(); settings.disconnect();
          document.fonts.removeEventListener('loadingdone', remeasure); cancelAnimationFrame(frame);
          parent.style.removeProperty('--offscreen-layout'); parent.style.removeProperty('--toc-height');
        },
      };
    },
  });
}
