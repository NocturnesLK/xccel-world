// =============================================================================
// UIManager.ts — User interaction layer for Accelerated World
// Translates UI events into GameActions via the renderer's callback system.
// =============================================================================

import { GameState, GameAction, InteractionMode, PlayerState } from '../models/types';
import {
  isEnergyCard, isCoreCard, getCardValue, getEmptyWheelSlots,
  getDecelCards, findCardById, NITRO_ENERGY_VALUE, MAX_COLLISION_ENERGY,
} from '../models/Card';
import { GameRenderer, RenderCallbacks } from './GameRenderer';
import { AnimationManager } from './AnimationManager';
import { createLogger } from '../logger';

const log = createLogger('UIManager');

export class UIManager {
  private renderer: GameRenderer;
  private animator: AnimationManager;
  private state: GameState | null = null;
  private mode: InteractionMode = { type: 'waiting' };
  private onAction: ((action: GameAction) => void) | null = null;
  private onStart: (() => void) | null = null;
  private onRestart: (() => void) | null = null;
  private pendingCardId: string | null = null;   // two-step flow: card → slot
  private mulliganSelected: string[] = [];        // local mulligan selection tracking

  constructor(root: HTMLElement) {
    this.animator = new AnimationManager();
    const cb: RenderCallbacks = {
      onStartGame: () => { log.info('startGame'); this.onStart?.(); },
      onCardClick: (id, src) => this.handleCardClick(id, src),
      onWheelSlotClick: (pi, s) => this.handleWheelSlotClick(pi, s),
      onCoreClick: (pi) => this.handleCoreClick(pi),
      onNitroClick: (pi) => this.handleNitroClick(pi),
      onEndTurn: () => this.emitAction({ type: 'endTurn' }),
      onConfirm: () => this.handleConfirm(),
      onCancel: () => this.handleCancel(),
      onRestart: () => { log.info('restart'); this.onRestart?.(); },
    };
    this.renderer = new GameRenderer(root, cb);
    this.renderer.initDOM();
  }

  // === Public API ===

  setActionHandler(handler: (action: GameAction) => void): void { this.onAction = handler; }
  setStartHandler(handler: () => void): void { this.onStart = handler; }
  setRestartHandler(handler: () => void): void { this.onRestart = handler; }

  updateState(state: GameState, mode: InteractionMode): void {
    this.state = state;
    this.mode = mode;
    this.renderer.render(state, mode);
    log.debug('updateState', { phase: state.phase, mode: mode.type });
  }

  showStartScreen(): void { this.renderer.showStartScreen(); }
  getRenderer(): GameRenderer { return this.renderer; }
  getAnimator(): AnimationManager { return this.animator; }

  // === Event routing ===

  private handleCardClick(cardId: string, source: 'hand' | 'field'): void {
    if (!this.state) return;
    log.debug('cardClick', { cardId, source, mode: this.mode.type });
    source === 'hand' ? this.onHandCard(cardId) : this.onFieldCard(cardId);
  }

  private onHandCard(cardId: string): void {
    if (!this.state) return;
    const player = this.getCurrentPlayer();
    const card = findCardById(player.hand, cardId);
    if (!card) return;

    // 1. Multi-select modes
    if (this.mode.type === 'mulligan') {
      this.onMulliganCard(cardId);
      return;
    }
    if (this.mode.type === 'selectCollisionPayment') {
      this.onPaymentCard(cardId);
      return;
    }
    if (this.mode.type === 'selectDiscardCards') {
      this.onDiscardCard(cardId);
      return;
    }

    // 2. Single-select modes (selectInitialSpeed, play, selectWheelSlot, selectCoreSlot)
    // If the clicked card is already selected, deselect it and return to the base mode
    if ((this.mode.type === 'selectWheelSlot' || this.mode.type === 'selectCoreSlot') && this.mode.cardId === cardId) {
      this.pendingCardId = null;
      if (this.state.phase === 'selectInitialSpeed') {
        this.setMode({ type: 'selectInitialSpeed' });
      } else {
        this.setMode({ type: 'play' });
      }
      return;
    }

    // Otherwise, we are selecting a new card
    if (this.mode.type === 'play' || this.mode.type === 'selectInitialSpeed' ||
        this.mode.type === 'selectWheelSlot' || this.mode.type === 'selectCoreSlot') {
      if (isCoreCard(card)) {
        if (this.state.phase === 'play') {
          this.pendingCardId = cardId;
          this.setMode({ type: 'selectCoreSlot', cardId });
        }
        return;
      }
      if (isEnergyCard(card)) {
        let purpose: 'accel' | 'recover' | 'both' = 'accel';
        if (this.state.phase === 'play') {
          const empty = getEmptyWheelSlots(player);
          const decel = getDecelCards(player);
          if (empty.length === 0 && decel.length === 0) {
            log.warn('no available wheel slots');
            return;
          }
          if (empty.length > 0 && decel.length > 0) {
            purpose = 'both';
          } else if (empty.length > 0) {
            purpose = 'accel';
          } else {
            purpose = 'recover';
          }
        }
        this.pendingCardId = cardId;
        this.setMode({ type: 'selectWheelSlot', cardId, purpose });
      }
    }
  }

  private onFieldCard(cardId: string): void {
    if (!this.state) return;
    const p = this.getCurrentPlayer();
    const slotIdx = p.wheels.findIndex(wc => wc !== null && wc.card.id === cardId);
    if (slotIdx === -1) return;

    if (this.mode.type === 'selectCollisionAttacker') this.onAttackerSlot(slotIdx);
    else if (this.mode.type === 'selectSettleCards') this.onSettleSlot(slotIdx);
  }

  private handleWheelSlotClick(playerIndex: number, slot: number): void {
    if (!this.state) return;
    log.debug('wheelSlotClick', { playerIndex, slot, mode: this.mode.type });
    if (this.mode.type === 'selectWheelSlot') this.onWheelSlotSelection(playerIndex, slot);
    else if (this.mode.type === 'selectCollisionTarget' && playerIndex === 1) {
      this.onTargetClick(playerIndex, slot);
    }
  }

  private handleCoreClick(playerIndex: number): void {
    if (!this.state) return;
    if (this.mode.type === 'selectCollisionTarget' && playerIndex === 1) {
      this.onTargetClick(playerIndex, 'core');
    } else if (this.mode.type === 'selectCoreSlot' && playerIndex === 0) {
      // Confirm core replacement
      this.emitAction({ type: 'update', cardId: this.mode.cardId });
      this.pendingCardId = null;
    }
  }

  private handleNitroClick(playerIndex: number): void {
    if (!this.state) return;
    if (playerIndex === 0 && this.mode.type === 'selectCollisionPayment') {
      this.onNitroPaymentToggle();
    }
  }

  private handleConfirm(): void {
    log.debug('confirm', { mode: this.mode.type });
    switch (this.mode.type) {
      case 'mulligan': this.confirmMulligan(); break;
      case 'play':
        // In play mode, confirm = start collision payment flow
        this.setMode({ type: 'selectCollisionPayment', selectedCardIds: [], totalEnergy: 0 });
        break;
      case 'selectCollisionPayment': this.confirmPayment(); break;
      case 'selectSettleCards': this.confirmSettle(); break;
      case 'selectDiscardCards': this.confirmDiscard(); break;
    }
  }

  private handleCancel(): void {
    log.debug('cancel', { mode: this.mode.type });
    if (['selectWheelSlot', 'selectCoreSlot', 'selectCollisionPayment',
         'selectCollisionAttacker', 'selectCollisionTarget'].includes(this.mode.type)) {
      this.pendingCardId = null;
      if (this.state && this.state.phase === 'selectInitialSpeed') {
        this.setMode({ type: 'selectInitialSpeed' });
      } else {
        this.setMode({ type: 'play' });
      }
    }
  }

  // === Mulligan ===

  private onMulliganCard(cardId: string): void {
    const idx = this.mulliganSelected.indexOf(cardId);
    if (idx >= 0) this.mulliganSelected.splice(idx, 1);
    else this.mulliganSelected.push(cardId);
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    if (el) el.classList.toggle('selected');
  }

  private confirmMulligan(): void {
    this.emitAction({ type: 'mulligan', cardIds: [...this.mulliganSelected] });
    this.mulliganSelected = [];
  }

  // === Wheel slot selection (after card selected) ===

  private onWheelSlotSelection(playerIndex: number, slot: number): void {
    if (!this.state || !this.pendingCardId || playerIndex !== 0) return;
    const wc = this.getCurrentPlayer().wheels[slot];

    if (this.state.phase === 'selectInitialSpeed') {
      if (wc) return; // slot not empty
      this.emitAction({ type: 'selectInitialSpeed', cardId: this.pendingCardId, wheelSlot: slot });
      this.pendingCardId = null;
      return;
    }

    if (!wc) {
      this.emitAction({ type: 'accel', cardId: this.pendingCardId, wheelSlot: slot });
    } else if (wc.state === 'decel') {
      this.emitAction({ type: 'recover', cardId: this.pendingCardId, wheelSlot: slot });
    } else {
      log.warn('slot occupied with non-decel card');
      return;
    }
    this.pendingCardId = null;
  }

  // === Collision payment ===

  private onPaymentCard(cardId: string): void {
    if (this.mode.type !== 'selectCollisionPayment' || !this.state) return;
    const card = findCardById(this.getCurrentPlayer().hand, cardId);
    if (!card || !isEnergyCard(card)) return;

    const { selectedCardIds, totalEnergy } = this.mode;
    const idx = selectedCardIds.indexOf(cardId);
    if (idx >= 0) {
      this.setMode({
        type: 'selectCollisionPayment',
        selectedCardIds: selectedCardIds.filter(id => id !== cardId),
        totalEnergy: totalEnergy - getCardValue(card),
      });
    } else {
      const newTotal = totalEnergy + getCardValue(card);
      if (newTotal > MAX_COLLISION_ENERGY) { log.warn('exceeds max energy'); return; }
      this.setMode({
        type: 'selectCollisionPayment',
        selectedCardIds: [...selectedCardIds, cardId],
        totalEnergy: newTotal,
      });
    }
  }

  private onNitroPaymentToggle(): void {
    if (this.mode.type !== 'selectCollisionPayment' || !this.state) return;
    const player = this.getCurrentPlayer();
    if (player.nitro.length === 0) return;
    const nitroCard = player.nitro[player.nitro.length - 1];
    const { selectedCardIds, totalEnergy } = this.mode;
    const idx = selectedCardIds.indexOf(nitroCard.id);

    if (idx >= 0) {
      this.setMode({
        type: 'selectCollisionPayment',
        selectedCardIds: selectedCardIds.filter(id => id !== nitroCard.id),
        totalEnergy: totalEnergy - NITRO_ENERGY_VALUE,
      });
    } else {
      const newTotal = totalEnergy + NITRO_ENERGY_VALUE;
      if (newTotal > MAX_COLLISION_ENERGY) { log.warn('exceeds max energy'); return; }
      this.setMode({
        type: 'selectCollisionPayment',
        selectedCardIds: [...selectedCardIds, nitroCard.id],
        totalEnergy: newTotal,
      });
    }
  }

  private confirmPayment(): void {
    if (this.mode.type !== 'selectCollisionPayment' || this.mode.totalEnergy === 0) return;
    this.emitAction({ type: 'startCollision', paymentCardIds: [...this.mode.selectedCardIds] });
  }

  // === Collision attacker / target ===

  private onAttackerSlot(slot: number): void {
    if (this.mode.type !== 'selectCollisionAttacker' || !this.state) return;
    const wc = this.getCurrentPlayer().wheels[slot];
    if (!wc || wc.state !== 'speed') return;
    if (getCardValue(wc.card) > this.mode.remainingEnergy) return;
    if (this.state.collisionState?.attacks.some(a => a.attackerSlot === slot)) return;

    this.setMode({
      type: 'selectCollisionTarget',
      attackerSlot: slot,
      remainingEnergy: this.mode.remainingEnergy,
    });
  }

  private onTargetClick(_playerIndex: number, slot: number | 'core'): void {
    if (this.mode.type !== 'selectCollisionTarget') return;
    this.emitAction({
      type: 'collisionAttack',
      attackerSlot: this.mode.attackerSlot,
      targetSlot: slot,
    });
  }

  // === Settle deceleration ===

  private onSettleSlot(slotIdx: number): void {
    if (this.mode.type !== 'selectSettleCards' || !this.state) return;
    const wc = this.getCurrentPlayer().wheels[slotIdx];
    if (!wc || (wc.state !== 'speed' && wc.state !== 'accel')) return;

    const { count, selectedSlots } = this.mode;
    const idx = selectedSlots.indexOf(slotIdx);
    if (idx >= 0) {
      this.setMode({ type: 'selectSettleCards', count, selectedSlots: selectedSlots.filter(s => s !== slotIdx) });
    } else {
      if (selectedSlots.length >= count) return;
      this.setMode({ type: 'selectSettleCards', count, selectedSlots: [...selectedSlots, slotIdx] });
    }
  }

  private confirmSettle(): void {
    if (this.mode.type !== 'selectSettleCards' || this.mode.selectedSlots.length !== this.mode.count) return;
    this.emitAction({ type: 'settleDeceleration', slots: [...this.mode.selectedSlots] });
  }

  // === Discard ===

  private onDiscardCard(cardId: string): void {
    if (this.mode.type !== 'selectDiscardCards') return;
    const { count, selectedCardIds } = this.mode;
    const idx = selectedCardIds.indexOf(cardId);
    if (idx >= 0) {
      this.setMode({ type: 'selectDiscardCards', count, selectedCardIds: selectedCardIds.filter(id => id !== cardId) });
    } else {
      if (selectedCardIds.length >= count) return;
      this.setMode({ type: 'selectDiscardCards', count, selectedCardIds: [...selectedCardIds, cardId] });
    }
  }

  private confirmDiscard(): void {
    if (this.mode.type !== 'selectDiscardCards' || this.mode.selectedCardIds.length !== this.mode.count) return;
    this.emitAction({ type: 'discard', cardIds: [...this.mode.selectedCardIds] });
  }

  // === Helpers ===

  private setMode(mode: InteractionMode): void {
    this.mode = mode;
    if (this.state) this.renderer.render(this.state, this.mode);
  }

  private emitAction(action: GameAction): void {
    log.info('emitAction', action.type);
    this.onAction?.(action);
  }

  private getCurrentPlayer(): PlayerState {
    return this.state!.players[0];
  }
}
