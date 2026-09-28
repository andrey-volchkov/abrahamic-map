// Minimal animation helpers on the Web Animations API (keeps the project on open licenses).
export const animCfg = { scale: 1 };

export const EASE = {
  out: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  out3: 'cubic-bezier(0.16, 1, 0.3, 1)',
  in: 'cubic-bezier(0.55, 0, 0.9, 0.45)',
  inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
};

export function anim(el: Element, kf: Keyframe[], duration: number, delay = 0, easing = EASE.out): Animation {
  return el.animate(kf, { duration: duration * 1000 * animCfg.scale, delay: delay * 1000 * animCfg.scale, easing, fill: 'both' });
}

export function stop(...els: Element[]) {
  for (const e of els) for (const a of e.getAnimations()) a.cancel();
}

export function fadeTo(el: HTMLElement, to: number, duration: number, easing = EASE.out): Animation {
  const from = getComputedStyle(el).opacity;
  stop(el);
  el.style.opacity = String(to);
  return anim(el, [{ opacity: from }, { opacity: to }], duration, 0, easing);
}

export function rise(els: Element[], dy: number, duration: number, stagger: number, delay = 0, easing = EASE.out3) {
  els.forEach((e, i) => {
    stop(e);
    anim(e, [{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'none' }], duration, delay + i * stagger, easing);
  });
}
