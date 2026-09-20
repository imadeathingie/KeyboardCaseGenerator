/** Tiny DOM helpers shared by the form GUI. */

type Props = Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, props: Props = {}, ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v as object);
    else if (k === 'style') node.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k in node) (node as unknown as Props)[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): HTMLElement {
  node.textContent = '';
  return node;
}

/** Trailing-edge debounce, used so typing doesn't rebuild on every keystroke. */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void, ms: number,
): (...args: T) => void {
  let handle: number | undefined;
  return (...args: T) => {
    if (handle !== undefined) window.clearTimeout(handle);
    handle = window.setTimeout(() => fn(...args), ms);
  };
}

export const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
