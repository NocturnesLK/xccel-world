// =============================================================================
// RulesEngine.ts — Pure-function game rules engine for Accelerated World
// =============================================================================

import {
  GameState, PlayerState, ActionResult, GameLogEntry, Card, WheelCard,
  Suit, PlayerId, VictoryType, GamePhase, cloneState,
  UpdateAction, AccelAction, RecoverAction, StartCollisionAction,
  CollisionAttackAction, SettleDecelerationAction, DiscardAction,
  MulliganAction, SelectInitialSpeedAction,
} from '../models/types';
import {
  createFullDeck, shuffle, getCardValue, isEnergyCard, isCoreCard,
  getSpeedCards, getDriveCards, getDecelCards, getEmptyWheelSlots,
  getDriveCount, getSpeedCount, cardDisplayName, findCardById, removeCardById,
  MAX_HAND_SIZE, NITRO_ENERGY_VALUE, MAX_COLLISION_ENERGY,
} from '../models/Card';
import {
  executeCollisionAttack as collisionAttack,
  getValidCollisionTargets, getValidAttackers, isOverloadActive,
} from './CollisionResolver';
import { createLogger } from '../logger';

const log = createLogger('Engine');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog(
  turn: number, pid: PlayerId | null, msg: string,
  logType: GameLogEntry['logType'] = 'action',
): GameLogEntry {
  return { turnNumber: turn, playerId: pid, message: msg, logType, timestamp: Date.now() };
}

function drawCards(player: PlayerState, count: number, logs: GameLogEntry[], turn: number): void {
  const drawn = Math.min(count, player.deck.length);
  for (let i = 0; i < drawn; i++) {
    const card = player.deck.shift()!;
    player.hand.push(card);
  }
  if (drawn > 0) {
    logs.push(makeLog(turn, player.id, `摸了 ${drawn} 张牌`, 'action'));
  }
  log.debug(`${player.id} drew ${drawn} cards, hand=${player.hand.length}, deck=${player.deck.length}`);
}

function checkDeckExhaustion(player: PlayerState, logs: GameLogEntry[], turn: number): boolean {
  if (player.deck.length > 0) return false;

  log.info(`${player.id} deck exhausted!`);
  player.deckExhaustCount++;
  logs.push(makeLog(turn, player.id, `牌堆耗尽！(第${player.deckExhaustCount}次)`, 'system'));

  // Reshuffle: discard pile → shuffle → exclude top 5 → new deck
  const pile = [...player.discard];
  player.discard = [];
  shuffle(pile);

  const excludeCount = Math.min(5, pile.length);
  for (let i = 0; i < excludeCount; i++) {
    player.excluded.push(pile.pop()!);
  }
  player.deck = pile;

  logs.push(makeLog(turn, player.id, `弃牌区洗混为新牌堆(除外${excludeCount}张)`, 'system'));
  return true;
}

/** Enforce: nitro count <= drive count. Discard excess from top. */
function enforceNitroLimit(player: PlayerState, logs: GameLogEntry[], turn: number): void {
  const driveCount = getDriveCount(player);
  while (player.nitro.length > driveCount) {
    const removed = player.nitro.pop()!;
    player.discard.push(removed);
    logs.push(makeLog(turn, player.id, `氮气牌超出驱动牌数量，弃置 ${cardDisplayName(removed)}`, 'system'));
  }
}

/** Check all three victory conditions. */
function checkVictory(state: GameState): { winner: PlayerId; type: VictoryType } | null {
  for (const player of state.players) {
    // crashCore is checked during collision resolution
    if (state.winner) return { winner: state.winner, type: state.victoryType! };

    // maxAccel: 4 speed cards + 4 nitro cards
    if (getSpeedCount(player) >= 4 && player.nitro.length >= 4) {
      return { winner: player.id, type: 'maxAccel' };
    }

    // deckExhaust: 2 times
    if (player.deckExhaustCount >= 2) {
      return { winner: player.id, type: 'deckExhaust' };
    }
  }
  return null;
}

function applyVictoryCheck(state: GameState, logs: GameLogEntry[]): void {
  const result = checkVictory(state);
  if (result) {
    state.winner = result.winner;
    state.victoryType = result.type;
    state.phase = 'gameOver';
    const typeNames: Record<VictoryType, string> = {
      crashCore: '撞敌飞天', maxAccel: '极限加速', deckExhaust: '赛程终结',
    };
    logs.push(makeLog(state.turnNumber, result.winner, `胜利！${typeNames[result.type]}`, 'victory'));
  }
}

// ---------------------------------------------------------------------------
// Check resonance
// ---------------------------------------------------------------------------

function checkRecoverResonance(
  state: GameState, player: PlayerState, playedCard: Card,
  logs: GameLogEntry[],
): void {
  const suit = playedCard.suit;
  if (player.resonanceRecoverSuits.includes(suit)) return; // already used this suit

  // Count same-suit cards among core + drive cards (excluding the just-placed card)
  let count = 0;
  if (player.core && player.core.suit === suit) count++;
  for (const wc of player.wheels) {
    if (wc && (wc.state === 'speed' || wc.state === 'accel') && wc.card.suit === suit) {
      // Don't count the card we just placed
      if (wc.card.id !== playedCard.id) {
        count++;
      }
    }
  }

  if (count >= 1) {
    player.resonanceRecoverSuits.push(suit);
    drawCards(player, 1, logs, state.turnNumber);
    checkDeckExhaustion(player, logs, state.turnNumber);
    logs.push(makeLog(state.turnNumber, player.id, `恢复共鸣(${suit})：摸1张`, 'resonance'));
    log.debug(`Recover resonance triggered for suit ${suit}`);
  }
}

function checkAccelResonance(
  state: GameState, player: PlayerState, playedCard: Card,
  logs: GameLogEntry[],
): void {
  const suit = playedCard.suit;
  // Only one suit can resonate for accel per turn
  if (player.resonanceAccelSuit !== null && player.resonanceAccelSuit !== suit) return;

  // Count same-suit cards among core + drive cards (excluding the just-placed card)
  // Rule: "若核心牌和其他驱动牌存在与打出的能量牌相同花色1张以上"
  let count = 0;
  if (player.core && player.core.suit === suit) count++;
  for (const wc of player.wheels) {
    if (wc && (wc.state === 'speed' || wc.state === 'accel') && wc.card.suit === suit) {
      // Don't count the card we just placed
      if (wc.card.id !== playedCard.id) {
        count++;
      }
    }
  }

  if (count >= 1) {
    player.resonanceAccelSuit = suit;
    // Place top deck card into nitro (bottom of stack)
    if (player.deck.length > 0) {
      const nitroCard = player.deck.shift()!;
      player.nitro.unshift(nitroCard); // add to bottom
      logs.push(makeLog(state.turnNumber, player.id, `加速共鸣(${suit})：牌堆顶牌加入氮气`, 'resonance'));
      checkDeckExhaustion(player, logs, state.turnNumber);
      enforceNitroLimit(player, logs, state.turnNumber);
    }
    log.debug(`Accel resonance triggered for suit ${suit}`);
  }
}

// ---------------------------------------------------------------------------
// Game Setup
// ---------------------------------------------------------------------------

export function setupGame(): GameState {
  log.info('Setting up new game');

  const createPlayerState = (id: PlayerId): PlayerState => {
    const deck = createFullDeck(id);

    // Extract all J, Q, K cards
    const coreCards = deck.filter(c => isCoreCard(c));
    const energyDeck = deck.filter(c => isEnergyCard(c));

    // Shuffle core cards, exclude 6, take 1 for initial core
    shuffle(coreCards);
    const excluded = coreCards.splice(0, 6);
    const initialCore = coreCards.splice(0, 1)[0];
    // Remaining core cards (5) go back into the energy deck
    const mainDeck = [...energyDeck, ...coreCards];
    shuffle(mainDeck);

    // Exclude 20 cards from main deck
    const excludedMain = mainDeck.splice(0, 20);

    return {
      id,
      core: initialCore,
      wheels: [null, null, null, null],
      nitro: [],
      hand: [],
      deck: mainDeck,
      discard: [],
      excluded: [...excluded, ...excludedMain],
      deckExhaustCount: 0,
      resonanceRecoverSuits: [],
      resonanceAccelSuit: null,
    };
  };

  const p1 = createPlayerState('player');
  const p2 = createPlayerState('ai');

  // Draw initial hands: first player 5, second player 6
  const firstPlayer = 0 as 0 | 1; // player goes first
  const p1Draw = firstPlayer === 0 ? 5 : 6;
  const p2Draw = firstPlayer === 0 ? 6 : 5;

  const initLogs: GameLogEntry[] = [];
  for (let i = 0; i < p1Draw; i++) {
    if (p1.deck.length > 0) p1.hand.push(p1.deck.shift()!);
  }
  for (let i = 0; i < p2Draw; i++) {
    if (p2.deck.length > 0) p2.hand.push(p2.deck.shift()!);
  }

  log.info(`Player hand: ${p1.hand.length}, AI hand: ${p2.hand.length}`);

  return {
    players: [p1, p2],
    currentPlayerIndex: firstPlayer,
    phase: 'mulligan',
    turnNumber: 1,
    firstPlayerIndex: firstPlayer,
    winner: null,
    victoryType: null,
    collisionState: null,
  };
}

// ---------------------------------------------------------------------------
// Mulligan
// ---------------------------------------------------------------------------

export function executeMulligan(state: GameState, action: MulliganAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  if (action.cardIds.length > 0) {
    // Return selected cards to deck bottom, draw same number
    const returned: Card[] = [];
    for (const cid of action.cardIds) {
      const card = findCardById(player.hand, cid);
      if (card) {
        returned.push(card);
        player.hand = removeCardById(player.hand, cid);
      }
    }
    for (const card of returned) {
      player.deck.push(card); // to bottom
    }
    // Draw same number
    for (let i = 0; i < returned.length; i++) {
      if (player.deck.length > 0) {
        player.hand.push(player.deck.shift()!);
      }
    }
    logs.push(makeLog(s.turnNumber, player.id, `换回 ${returned.length} 张手牌`, 'action'));
  } else {
    logs.push(makeLog(s.turnNumber, player.id, `保留全部手牌`, 'action'));
  }

  // Check if both players have mulliganed
  if (s.currentPlayerIndex === 0) {
    // Switch to AI mulligan
    s.currentPlayerIndex = 1;
  } else {
    // Both done → select initial speed
    s.currentPlayerIndex = s.firstPlayerIndex;
    s.phase = 'selectInitialSpeed';
  }

  return { state: s, logs };
}

// ---------------------------------------------------------------------------
// Select Initial Speed
// ---------------------------------------------------------------------------

export function executeSelectInitialSpeed(state: GameState, action: SelectInitialSpeedAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  const card = findCardById(player.hand, action.cardId);
  if (!card || !isEnergyCard(card)) {
    log.error('Invalid initial speed card', action.cardId);
    return { state: s, logs };
  }

  player.hand = removeCardById(player.hand, action.cardId);
  player.wheels[action.wheelSlot] = { card, state: 'speed' };
  logs.push(makeLog(s.turnNumber, player.id, `放置 ${cardDisplayName(card)} 为初始速度牌`, 'action'));

  if (s.currentPlayerIndex === 0) {
    s.currentPlayerIndex = 1;
  } else {
    // Both done → start game, first player's draw phase
    s.currentPlayerIndex = s.firstPlayerIndex;
    s.phase = 'draw';
    logs.push(makeLog(s.turnNumber, null, `游戏开始！`, 'system'));
  }

  return { state: s, logs };
}

// ---------------------------------------------------------------------------
// Draw Phase
// ---------------------------------------------------------------------------

export function executeDrawPhase(state: GameState): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  logs.push(makeLog(s.turnNumber, player.id, `—— 摸牌阶段 ——`, 'phase'));

  // Reset per-turn resonance tracking
  player.resonanceRecoverSuits = [];
  player.resonanceAccelSuit = null;

  // All accel cards become speed cards
  let accelConverted = 0;
  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && wc.state === 'accel') {
      wc.state = 'speed';
      accelConverted++;
    }
  }
  if (accelConverted > 0) {
    logs.push(makeLog(s.turnNumber, player.id, `${accelConverted} 张加速牌变为速度牌`, 'action'));
  }

  // Draw cards equal to speed card count
  const speedCount = getSpeedCount(player);
  drawCards(player, speedCount, logs, s.turnNumber);
  checkDeckExhaustion(player, logs, s.turnNumber);
  applyVictoryCheck(s, logs);

  if (s.phase === 'gameOver') return { state: s, logs };

  // If hand > 6, need to discard
  if (player.hand.length > MAX_HAND_SIZE) {
    s.phase = 'drawDiscard';
    const excess = player.hand.length - MAX_HAND_SIZE;
    logs.push(makeLog(s.turnNumber, player.id, `手牌 ${player.hand.length} 张，需弃掉 ${excess} 张`, 'system'));
  } else {
    s.phase = 'play';
    logs.push(makeLog(s.turnNumber, player.id, `—— 出牌阶段 ——`, 'phase'));
  }

  return { state: s, logs };
}

// ---------------------------------------------------------------------------
// Play Phase Actions
// ---------------------------------------------------------------------------

/** Update core: play J/Q/K from hand to core area. */
export function executeUpdate(state: GameState, action: UpdateAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  const card = findCardById(player.hand, action.cardId);
  if (!card || !isCoreCard(card)) {
    log.error('Invalid update card', action.cardId);
    return { state: s, logs };
  }

  // Replace core
  const oldCore = player.core;
  if (oldCore) player.discard.push(oldCore);

  player.hand = removeCardById(player.hand, action.cardId);
  player.core = card;

  // Draw 1 card
  drawCards(player, 1, logs, s.turnNumber);
  checkDeckExhaustion(player, logs, s.turnNumber);

  logs.push(makeLog(s.turnNumber, player.id,
    `更新核心：${cardDisplayName(card)}${oldCore ? ` (替换 ${cardDisplayName(oldCore)})` : ''}`, 'action'));

  applyVictoryCheck(s, logs);
  return { state: s, logs };
}

/** Accel: play energy card to empty wheel slot as accel card. */
export function executeAccel(state: GameState, action: AccelAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  const card = findCardById(player.hand, action.cardId);
  if (!card || !isEnergyCard(card)) {
    log.error('Invalid accel card', action.cardId);
    return { state: s, logs };
  }
  if (player.wheels[action.wheelSlot] !== null) {
    log.error('Wheel slot not empty', action.wheelSlot);
    return { state: s, logs };
  }

  player.hand = removeCardById(player.hand, action.cardId);
  player.wheels[action.wheelSlot] = { card, state: 'accel' };
  logs.push(makeLog(s.turnNumber, player.id, `加速：${cardDisplayName(card)} → 车轮${action.wheelSlot + 1}`, 'action'));

  // Check accel resonance
  checkAccelResonance(s, player, card, logs);
  enforceNitroLimit(player, logs, s.turnNumber);
  applyVictoryCheck(s, logs);

  return { state: s, logs };
}

/** Recover: play energy card to replace decel card as speed card. */
export function executeRecover(state: GameState, action: RecoverAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  const card = findCardById(player.hand, action.cardId);
  if (!card || !isEnergyCard(card)) {
    log.error('Invalid recover card', action.cardId);
    return { state: s, logs };
  }
  const targetWc = player.wheels[action.wheelSlot];
  if (!targetWc || targetWc.state !== 'decel') {
    log.error('Target slot is not decel', action.wheelSlot);
    return { state: s, logs };
  }

  // Replace decel card
  player.discard.push(targetWc.card);
  player.hand = removeCardById(player.hand, action.cardId);
  player.wheels[action.wheelSlot] = { card, state: 'speed' };

  logs.push(makeLog(s.turnNumber, player.id,
    `恢复：${cardDisplayName(card)} 替换 ${cardDisplayName(targetWc.card)}(减速) → 车轮${action.wheelSlot + 1}`, 'action'));

  // Check recover resonance
  checkRecoverResonance(s, player, card, logs);
  applyVictoryCheck(s, logs);

  return { state: s, logs };
}

/** Start a collision by paying energy. */
export function executeStartCollision(state: GameState, action: StartCollisionAction): ActionResult {
  const s = cloneState(state);
  const player = s.players[s.currentPlayerIndex];

  // Calculate and validate payment
  let totalEnergy = 0;
  const handPaymentCards: Card[] = [];
  const nitroPaymentCards: Card[] = [];

  for (const cid of action.paymentCardIds) {
    const handCard = findCardById(player.hand, cid);
    if (handCard) {
      totalEnergy += getCardValue(handCard);
      handPaymentCards.push(handCard);
      continue;
    }
    const nitroIdx = player.nitro.findIndex(c => c.id === cid);
    if (nitroIdx >= 0) {
      totalEnergy += NITRO_ENERGY_VALUE;
      nitroPaymentCards.push(player.nitro[nitroIdx]);
    }
  }

  if (totalEnergy <= 0 || totalEnergy > MAX_COLLISION_ENERGY) {
    log.warn('Invalid collision payment total', totalEnergy);
    return { state: s, logs: [] };
  }

  // Remove payment cards and add to discard
  for (const card of handPaymentCards) {
    player.hand = removeCardById(player.hand, card.id);
    player.discard.push(card);
  }
  for (const card of nitroPaymentCards) {
    player.nitro = player.nitro.filter(c => c.id !== card.id);
    player.discard.push(card);
  }

  const logs: GameLogEntry[] = [];
  logs.push(makeLog(s.turnNumber, player.id, `支付 ${totalEnergy} 点能量发起碰撞`, 'collision'));

  s.collisionState = {
    totalPaid: totalEnergy,
    remainingEnergy: totalEnergy,
    paymentCardIds: action.paymentCardIds,
    attacks: [],
  };

  return { state: s, logs };
}

/** Execute a single collision attack (attacker → target). */
export function executeCollisionAttack(state: GameState, action: CollisionAttackAction): ActionResult {
  const s = cloneState(state);
  return collisionAttack(s, action.attackerSlot, action.targetSlot);
}

// ---------------------------------------------------------------------------
// Settle Phase
// ---------------------------------------------------------------------------

export function executeSettlePhase(state: GameState): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  logs.push(makeLog(s.turnNumber, player.id, `—— 结算阶段 ——`, 'phase'));

  // Discard all decel cards
  let decelRemoved = 0;
  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && wc.state === 'decel') {
      player.discard.push(wc.card);
      player.wheels[i] = null;
      decelRemoved++;
    }
  }
  if (decelRemoved > 0) {
    logs.push(makeLog(s.turnNumber, player.id, `弃掉 ${decelRemoved} 张减速牌`, 'action'));
  }

  // Check: drive count > hand count → must decelerate
  const driveCount = getDriveCount(player);
  const handCount = player.hand.length;
  const diff = driveCount - handCount;

  if (diff > 0) {
    s.phase = 'settleDiscard';
    logs.push(makeLog(s.turnNumber, player.id,
      `驱动牌(${driveCount}) > 手牌(${handCount})，需选 ${diff} 张驱动牌减速`, 'system'));
  } else {
    // End turn
    enforceNitroLimit(player, logs, s.turnNumber);
    applyVictoryCheck(s, logs);
    if (s.phase !== 'gameOver') {
      endCurrentTurn(s, logs);
    }
  }

  return { state: s, logs };
}

/** Execute settle deceleration: player chose which drive cards to decelerate. */
export function executeSettleDeceleration(state: GameState, action: SettleDecelerationAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  for (const slot of action.slots) {
    const wc = player.wheels[slot];
    if (!wc) continue;
    if (wc.state === 'speed') {
      wc.state = 'decel';
      logs.push(makeLog(s.turnNumber, player.id, `${cardDisplayName(wc.card)} 减速`, 'action'));
    } else if (wc.state === 'accel') {
      player.discard.push(wc.card);
      player.wheels[slot] = null;
      logs.push(makeLog(s.turnNumber, player.id, `${cardDisplayName(wc.card)}(加速) 弃置`, 'action'));
    }
  }

  enforceNitroLimit(player, logs, s.turnNumber);
  applyVictoryCheck(s, logs);
  if (s.phase !== 'gameOver') {
    endCurrentTurn(s, logs);
  }

  return { state: s, logs };
}

// ---------------------------------------------------------------------------
// Discard (hand > 6)
// ---------------------------------------------------------------------------

export function executeDiscard(state: GameState, action: DiscardAction): ActionResult {
  const s = cloneState(state);
  const logs: GameLogEntry[] = [];
  const player = s.players[s.currentPlayerIndex];

  for (const cid of action.cardIds) {
    const card = findCardById(player.hand, cid);
    if (card) {
      player.hand = removeCardById(player.hand, cid);
      player.discard.push(card);
    }
  }
  logs.push(makeLog(s.turnNumber, player.id, `弃掉 ${action.cardIds.length} 张手牌`, 'action'));

  s.phase = 'play';
  logs.push(makeLog(s.turnNumber, player.id, `—— 出牌阶段 ——`, 'phase'));

  return { state: s, logs };
}

// ---------------------------------------------------------------------------
// End Turn
// ---------------------------------------------------------------------------

function endCurrentTurn(state: GameState, logs: GameLogEntry[]): void {
  const oldPlayer = state.players[state.currentPlayerIndex];
  logs.push(makeLog(state.turnNumber, oldPlayer.id, `回合结束`, 'phase'));

  // Switch player
  state.currentPlayerIndex = state.currentPlayerIndex === 0 ? 1 : 0;

  // If we've gone through both players, increment turn
  if (state.currentPlayerIndex === state.firstPlayerIndex) {
    state.turnNumber++;
  }

  state.phase = 'draw';
  state.collisionState = null;
}

export function executeEndTurn(state: GameState): ActionResult {
  const s = cloneState(state);
  // Go to settle phase
  s.phase = 'settle';
  return executeSettlePhase(s);
}

// ---------------------------------------------------------------------------
// Validation Helpers (used by UI and AI)
// ---------------------------------------------------------------------------

/** Get all possible play actions for the current player. */
export function getAvailableActions(state: GameState): {
  canUpdate: boolean;
  canAccel: boolean;
  canRecover: boolean;
  canCollide: boolean;
  updateCards: Card[];
  accelCards: Card[];
  recoverCards: Card[];
  emptySlots: number[];
  decelSlots: number[];
} {
  const player = state.players[state.currentPlayerIndex];

  const coreCardsInHand = player.hand.filter(c => isCoreCard(c));
  const energyCardsInHand = player.hand.filter(c => isEnergyCard(c));
  const emptySlots = getEmptyWheelSlots(player);
  const decelSlots = getDecelCards(player).map(d => d.slot);
  const speedCards = getSpeedCards(player);

  // Collision: need speed cards + energy to pay
  const totalAvailableEnergy = energyCardsInHand.reduce((sum, c) => sum + getCardValue(c), 0)
    + player.nitro.length * NITRO_ENERGY_VALUE;
  const minSpeedCost = speedCards.length > 0
    ? Math.min(...speedCards.map(s => getCardValue(s.wc.card)))
    : Infinity;

  const hasTargets = getValidCollisionTargets(state).length > 0;

  return {
    canUpdate: coreCardsInHand.length > 0,
    canAccel: energyCardsInHand.length > 0 && emptySlots.length > 0,
    canRecover: energyCardsInHand.length > 0 && decelSlots.length > 0,
    canCollide: speedCards.length > 0 && totalAvailableEnergy >= minSpeedCost && hasTargets,
    updateCards: coreCardsInHand,
    accelCards: energyCardsInHand,
    recoverCards: energyCardsInHand,
    emptySlots,
    decelSlots,
  };
}

export { getValidCollisionTargets, getValidAttackers, isOverloadActive };
