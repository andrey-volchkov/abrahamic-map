export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

export const ICON = {
  prev: '<svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.5v11l9-5.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="m3.5 3.5 9 9m0-9-9 9" stroke="currentColor" stroke-width="1.3"/></svg>',
};
