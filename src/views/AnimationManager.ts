// =============================================================================
// AnimationManager.ts — Simple animation utilities for Accelerated World
// =============================================================================

import { createLogger } from '../logger';

const log = createLogger('Animation');

/** Default durations in milliseconds */
const DEFAULT_MOVE_DURATION = 300;
const DEFAULT_EFFECT_DURATION = 400;

export class AnimationManager {

  /**
   * Animate a card element moving from one bounding rect to another.
   * Uses Web Animations API for smooth, cancellable movement.
   */
  async animateCardMove(
    element: HTMLElement,
    fromRect: DOMRect,
    toRect: DOMRect,
    duration = DEFAULT_MOVE_DURATION,
  ): Promise<void> {
    const dx = fromRect.left - toRect.left;
    const dy = fromRect.top - toRect.top;

    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;

    log.trace('animateCardMove', { dx, dy, duration });

    const anim = element.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.7 },
        { transform: 'translate(0, 0)', opacity: 1 },
      ],
      { duration, easing: 'ease-out', fill: 'none' },
    );

    await anim.finished;
  }

  /**
   * Shake + flash effect on the target element to visualise a collision impact.
   */
  async animateCollision(targetElement: HTMLElement): Promise<void> {
    log.debug('animateCollision');

    targetElement.classList.add('collision-flash');

    // The CSS animation for collision-shake lasts 300ms
    await this.delay(350);

    targetElement.classList.remove('collision-flash');
  }

  /**
   * Pulsing green glow effect for resonance triggers.
   */
  async animateResonance(element: HTMLElement): Promise<void> {
    log.debug('animateResonance');

    element.classList.add('resonance-glow');

    // CSS resonance-pulse is 800ms
    await this.delay(850);

    element.classList.remove('resonance-glow');
  }

  /**
   * Simple scale-based card flip effect.
   * Collapses horizontally, then expands back — simulating a 180° flip.
   */
  async animateFlip(element: HTMLElement): Promise<void> {
    log.trace('animateFlip');

    const anim = element.animate(
      [
        { transform: 'scaleX(1)' },
        { transform: 'scaleX(0)', offset: 0.5 },
        { transform: 'scaleX(1)' },
      ],
      { duration: DEFAULT_EFFECT_DURATION, easing: 'ease-in-out', fill: 'none' },
    );

    await anim.finished;
  }

  /**
   * Animate an element appearing with a slide + fade.
   */
  async animateAppear(
    element: HTMLElement,
    direction: 'up' | 'down' = 'up',
  ): Promise<void> {
    const cls = direction === 'up' ? 'animate-slide-up' : 'animate-slide-down';
    element.classList.add(cls);

    // CSS slide animations use --anim-normal (0.3s)
    await this.delay(320);

    element.classList.remove(cls);
  }

  /**
   * Fade-in animation for overlays and modals.
   */
  async animateFade(element: HTMLElement): Promise<void> {
    element.classList.add('animate-fade');
    await this.delay(320);
    element.classList.remove('animate-fade');
  }

  /**
   * Promise-based delay utility.
   */
  delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
