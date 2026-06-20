// =============================================================================
// AIController.ts — Heuristic AI for Accelerated World
// =============================================================================

import {
  GameState, GameAction, PlayerState, Card, WheelCard,
  cloneState, PlayerId,
} from '../models/types';
import {
  isEnergyCard, isCoreCard, getCardValue, getEmptyWheelSlots,
  getDecelCards, getSpeedCards, getDriveCards, getDriveCount, getSpeedCount,
  findCardById, NITRO_ENERGY_VALUE, MAX_COLLISION_ENERGY, MAX_HAND_SIZE,
} from '../models/Card';
import {
  getAvailableActions, getValidCollisionTargets, getValidAttackers,
  executeUpdate, executeAccel, executeRecover, executeStartCollision,
  executeCollisionAttack, executeEndTurn,
} from '../engine/RulesEngine';
import { createLogger } from '../logger';

const log = createLogger('AI');

// ---------------------------------------------------------------------------
// Score weights
// ---------------------------------------------------------------------------

const W = {
  SPEED_CARD: 15,
  ACCEL_CARD: 10,
  DECEL_CARD: -8,
  NITRO_CARD: 12,
  HAND_CARD: 3,
  CORE_VALUE: 5,
  OPP_SPEED: -12,
  OPP_ACCEL: -8,
  OPP_DECEL: 4,
  OPP_NITRO: -10,
  OPP_HAND: -2,
  VICTORY_MAXACCEL_PROGRESS: 20,
  COLLISION_REMOVE_SPEED: 18,
  COLLISION_REMOVE_ACCEL: 12,
  COLLISION_CORE_HIT: 9999,
  CORE_J_ACTIVE: 8,
  CORE_Q_ACTIVE: 6,
  CORE_K_ACTIVE: 7,
};

// ---------------------------------------------------------------------------
// Board evaluation
// ---------------------------------------------------------------------------

function getCoreActivationScore(player: PlayerState): number {
  if (!player.core) return 0;
  const coreRank = player.core.rank;
  const driveCards = getDriveCards(player);
  let activeCount = 0;

  for (const { wc } of driveCards) {
    const r = wc.card.rank;
    if (coreRank === 'J') {
      if (['A', '2', '3', '4'].includes(r)) activeCount++;
    } else if (coreRank === 'Q') {
      if (['A', '5', '6', '7'].includes(r)) activeCount++;
    } else if (coreRank === 'K') {
      if (['A', '8', '9', '10'].includes(r)) activeCount++;
    }
  }

  if (coreRank === 'J') return activeCount * W.CORE_J_ACTIVE;
  if (coreRank === 'Q') return activeCount * W.CORE_Q_ACTIVE;
  if (coreRank === 'K') return activeCount * W.CORE_K_ACTIVE;
  return 0;
}

function evaluateBoard(state: GameState, forPlayer: 0 | 1): number {
  const me = state.players[forPlayer];
  const opp = state.players[forPlayer === 0 ? 1 : 0];
  let score = 0;

  // My field
  for (const wc of me.wheels) {
    if (!wc) continue;
    if (wc.state === 'speed') score += W.SPEED_CARD + getCardValue(wc.card);
    else if (wc.state === 'accel') score += W.ACCEL_CARD + getCardValue(wc.card);
    else if (wc.state === 'decel') score += W.DECEL_CARD;
  }
  score += me.nitro.length * W.NITRO_CARD;
  score += me.hand.length * W.HAND_CARD;
  score += getCoreActivationScore(me);

  // Opponent's field
  for (const wc of opp.wheels) {
    if (!wc) continue;
    if (wc.state === 'speed') score += W.OPP_SPEED - getCardValue(wc.card);
    else if (wc.state === 'accel') score += W.OPP_ACCEL;
    else if (wc.state === 'decel') score += W.OPP_DECEL;
  }
  score += opp.nitro.length * W.OPP_NITRO;
  score += opp.hand.length * W.OPP_HAND;
  score -= getCoreActivationScore(opp);

  // Victory proximity: maxAccel (4 speed + 4 nitro)
  const speedCount = getSpeedCount(me);
  const nitroCount = me.nitro.length;
  score += (speedCount + nitroCount) * W.VICTORY_MAXACCEL_PROGRESS;

  // If game over and we won, huge bonus
  if (state.winner === me.id) score += 100000;
  if (state.winner === opp.id) score -= 100000;

  return score;
}

function getDecelSortValue(player: PlayerState, wc: WheelCard): number {
  let val = getCardValue(wc.card);
  // Accel cards are much more valuable to keep since decelerating them discards them completely.
  if (wc.state === 'accel') {
    val += 100;
  }

  // Resonance awareness under new rules:
  // - ACCEL resonance: any suit, each once → diversity of suits on field is valuable.
  //   Each card represents a potential accel resonance trigger. Any card with a same-suit
  //   partner (core or drive) is valuable. The more unique suits on field, the more nitro.
  // - RECOVER resonance: locked to ONE suit, unlimited triggers → suit CONCENTRATION matters.
  //   Cards of the most concentrated suit are most valuable for chained recover resonance.
  const suit = wc.card.suit;

  // Count same-suit partners (core + other drive cards) for this card
  let suitPartners = 0;
  if (player.core && player.core.suit === suit) suitPartners++;
  for (const otherWc of player.wheels) {
    if (otherWc && otherWc !== wc &&
        (otherWc.state === 'speed' || otherWc.state === 'accel') &&
        otherWc.card.suit === suit) {
      suitPartners++;
    }
  }

  // Accel value: contributes a unique suit to the field (each suit triggers accel resonance once)
  // If this card is the only representative of its suit on field, removing it cuts accel potential.
  const suitsOnField = new Set<string>();
  if (player.core) suitsOnField.add(player.core.suit);
  for (const otherWc of player.wheels) {
    if (otherWc && (otherWc.state === 'speed' || otherWc.state === 'accel')) {
      suitsOnField.add(otherWc.card.suit);
    }
  }
  const sameCount = [...player.wheels].filter(
    w => w && (w.state === 'speed' || w.state === 'accel') && w.card.suit === suit
  ).length;
  if (sameCount === 1 && !player.core?.suit) {
    // Sole representative of this suit on field — losing it loses accel resonance potential
    val += 20;
  }

  // Recover value: concentrated suits allow unlimited chained recover resonance.
  // The suit with the most drive cards is most worth protecting.
  if (suitPartners >= 2) {
    // Strong concentration — cornerstone of recover resonance chain
    val += 28;
  } else if (suitPartners === 1) {
    // Pair — still valuable for recover resonance
    val += 14;
  }

  return val;
}

function simulateSettlePhase(state: GameState, playerIndex: number): GameState {
  const s = cloneState(state);
  const player = s.players[playerIndex];

  // 1. Discard all decel cards
  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && wc.state === 'decel') {
      player.discard.push(wc.card);
      player.wheels[i] = null;
    }
  }

  // 2. Check: drive count > hand count → must decelerate
  const driveCount = getDriveCount(player);
  const handCount = player.hand.length;
  const diff = driveCount - handCount;

  if (diff > 0) {
    // Collect all current drive cards (speed or accel) after discarding decel
    const driveCards: { slot: number; wc: WheelCard }[] = [];
    for (let i = 0; i < 4; i++) {
      const wc = player.wheels[i];
      if (wc && (wc.state === 'speed' || wc.state === 'accel')) {
        driveCards.push({ slot: i, wc });
      }
    }

    // Sort drive cards using resonance-aware decel sort value
    const sorted = driveCards.sort((a, b) => {
      return getDecelSortValue(player, a.wc) - getDecelSortValue(player, b.wc);
    });

    const slots = sorted.slice(0, diff).map(d => d.slot);

    // Apply deceleration / discard in the simulation
    for (const slot of slots) {
      const wc = player.wheels[slot];
      if (!wc) continue;
      if (wc.state === 'speed') {
        wc.state = 'decel';
      } else if (wc.state === 'accel') {
        player.discard.push(wc.card);
        player.wheels[slot] = null;
      }
    }
  }

  // 3. Enforce nitro limit in simulation: nitro count <= drive count. Discard excess from top.
  const finalDriveCount = getDriveCount(player);
  while (player.nitro.length > finalDriveCount) {
    const removed = player.nitro.pop()!;
    player.discard.push(removed);
  }

  return s;
}

function evaluateBoardFuture(state: GameState, forPlayer: 0 | 1): number {
  const settledState = simulateSettlePhase(state, forPlayer);
  return evaluateBoard(settledState, forPlayer);
}

// ---------------------------------------------------------------------------
// Action generation helpers
// ---------------------------------------------------------------------------

interface ScoredAction {
  action: GameAction;
  score: number;
  description: string;
}

function getAIPlayer(state: GameState): PlayerState {
  return state.players[state.currentPlayerIndex];
}

// ---------------------------------------------------------------------------
// Main AI decision functions
// ---------------------------------------------------------------------------

/** Choose mulligan cards. AI keeps high-value energy cards and core cards. */
export function decideMulligan(state: GameState): GameAction {
  const player = getAIPlayer(state);
  const toReturn: string[] = [];

  // Return low-value energy cards (1-3), keep 4+ and core cards
  for (const card of player.hand) {
    if (isEnergyCard(card) && getCardValue(card) <= 2) {
      toReturn.push(card.id);
    }
  }

  log.info(`Mulligan: returning ${toReturn.length} cards`);
  return { type: 'mulligan', cardIds: toReturn };
}

/** Choose initial speed card. AI picks a medium-value card (4-6 preferred). */
export function decideInitialSpeed(state: GameState): GameAction {
  const player = getAIPlayer(state);
  const energyCards = player.hand.filter(c => isEnergyCard(c));

  // Prefer values 4-6 for initial speed
  const preferred = energyCards.filter(c => {
    const v = getCardValue(c);
    return v >= 4 && v <= 6;
  });

  const chosen = preferred.length > 0
    ? preferred[0]
    : energyCards.sort((a, b) => getCardValue(b) - getCardValue(a))[0];

  if (!chosen) {
    log.error('No energy card for initial speed!');
    return { type: 'selectInitialSpeed', cardId: player.hand[0].id, wheelSlot: 0 };
  }

  log.info(`Initial speed: ${chosen.rank} value=${getCardValue(chosen)}`);
  return { type: 'selectInitialSpeed', cardId: chosen.id, wheelSlot: 0 };
}

/** Choose cards to discard when hand > 6. Discard lowest value energy cards. */
export function decideDiscard(state: GameState, count: number): GameAction {
  const player = getAIPlayer(state);
  const sorted = [...player.hand].sort((a, b) => {
    // Prefer to keep core cards and high-value energy
    const aVal = isCoreCard(a) ? 20 : getCardValue(a);
    const bVal = isCoreCard(b) ? 20 : getCardValue(b);
    return aVal - bVal;
  });

  const toDiscard = sorted.slice(0, count).map(c => c.id);
  log.info(`Discard ${count} cards`);
  return { type: 'discard', cardIds: toDiscard };
}

/** Choose which drive cards to decelerate during settle phase. */
export function decideSettleDeceleration(state: GameState, count: number): GameAction {
  const player = getAIPlayer(state);
  const driveCards = getDriveCards(player);

  // Sort drive cards using resonance-aware decel sort value
  const sorted = driveCards.sort((a, b) => {
    return getDecelSortValue(player, a.wc) - getDecelSortValue(player, b.wc);
  });

  const slots = sorted.slice(0, count).map(d => d.slot);
  log.info(`Settle deceleration: slots ${slots.join(',')}`);
  return { type: 'settleDeceleration', slots };
}

function getResonancePriority(player: PlayerState, card: Card, type: 'accel' | 'recover'): number {
  const suit = card.suit;

  if (type === 'recover') {
    // Recover resonance: locked to ONE suit per turn, UNLIMITED triggers of that suit.
    // Strategy: concentrate on the locked suit (or the best candidate suit if not yet locked).
    if (player.resonanceRecoverSuit !== null && player.resonanceRecoverSuit !== suit) return 0; // wrong suit, zero priority

    // Count same-suit partners for recover resonance check
    let count = 0;
    if (player.core && player.core.suit === suit) count++;
    for (const wc of player.wheels) {
      if (wc && (wc.state === 'speed' || wc.state === 'accel') && wc.card.suit === suit) count++;
    }

    // How many same-suit cards do we have in hand (incl. this card)? More = bigger burst potential.
    const handSameCount = player.hand.filter(c => c.suit === suit && c.id !== card.id).length;
    if (count >= 1) {
      // Already locked or lockable — high priority; bonus for burst potential
      return 20 + handSameCount * 5;
    }
    return 0;

  } else { // accel
    // Accel resonance: ANY suit, but each suit only ONCE per turn.
    // Strategy: prefer suits not yet used for accel resonance this turn.
    if (player.resonanceAccelSuits.includes(suit)) return 0; // this suit already used this turn

    // Count same-suit partners
    let count = 0;
    if (player.core && player.core.suit === suit) count++;
    for (const wc of player.wheels) {
      if (wc && (wc.state === 'speed' || wc.state === 'accel') && wc.card.suit === suit) count++;
    }
    return count >= 1 ? 30 : 0;
  }
}

// ---------------------------------------------------------------------------
// Main play-phase decision
// ---------------------------------------------------------------------------

/** Decide the next action during play phase. Returns null when AI wants to end turn. */
export function decidePlayAction(state: GameState): GameAction {
  const actions = getAvailableActions(state);
  const player = getAIPlayer(state);
  const candidates: ScoredAction[] = [];

  // === Update core ===
  for (const card of actions.updateCards) {
    const simState = cloneState(state);
    const result = executeUpdate(simState, { type: 'update', cardId: card.id });
    
    // Resonance penalty under new rules:
    // - Accel: field suit DIVERSITY matters. Core contributes one suit. Switching core to a
    //   suit already covered by drives doesn't add new accel potential, but switching away
    //   from a suit only the core provides DOES reduce accel potential.
    // - Recover: suit CONCENTRATION matters. Core contributes to recover chain for its suit.
    //   Switching core breaks the concentration if drives are all of the current core suit.
    let resonancePenalty = 0;
    if (player.core) {
      const currentSuit = player.core.suit;
      const newSuit = card.suit;
      if (currentSuit !== newSuit) {
        const driveCards = getDriveCards(player);
        const currentSuitDriveCount = driveCards.filter(d => d.wc.card.suit === currentSuit).length;
        const newSuitDriveCount = driveCards.filter(d => d.wc.card.suit === newSuit).length;

        // Accel penalty: if current core is the ONLY source of currentSuit on field,
        // switching loses an accel resonance opportunity for that suit.
        if (currentSuitDriveCount === 0) {
          // Core is sole source of currentSuit — switching loses that suit's accel potential
          resonancePenalty -= 20;
        }
        // Accel bonus: if newSuit has no field presence, switching adds a new unique suit
        if (newSuitDriveCount === 0) {
          resonancePenalty += 10; // adds new accel resonance suit
        }

        // Recover penalty: if drives are heavily concentrated in currentSuit,
        // switching core breaks the recover chain concentration.
        if (currentSuitDriveCount >= 2) {
          // Drives are concentrated on current core suit — high recover chain value
          resonancePenalty -= 35;
        } else if (currentSuitDriveCount >= 1) {
          resonancePenalty -= 15;
        }
      }
    }

    const score = evaluateBoardFuture(result.state, state.currentPlayerIndex) + 5 + resonancePenalty;
    candidates.push({ action: { type: 'update', cardId: card.id }, score, description: `update core with ${card.rank} (${card.suit})` });
  }

  // === Accel ===
  if (actions.canAccel) {
    const energyCards = [...actions.accelCards]
      .sort((a, b) => {
        const priorityA = getResonancePriority(player, a, 'accel') + getCardValue(a);
        const priorityB = getResonancePriority(player, b, 'accel') + getCardValue(b);
        return priorityB - priorityA; // descending
      });

    for (const card of energyCards.slice(0, 5)) { // limit simulation count to 5
      for (const slot of actions.emptySlots.slice(0, 2)) {
        const simState = cloneState(state);
        const result = executeAccel(simState, { type: 'accel', cardId: card.id, wheelSlot: slot });
        const score = evaluateBoardFuture(result.state, state.currentPlayerIndex);
        candidates.push({
          action: { type: 'accel', cardId: card.id, wheelSlot: slot },
          score,
          description: `accel ${card.rank} (${card.suit}) to slot ${slot}`,
        });
      }
    }
  }

  // === Recover ===
  if (actions.canRecover) {
    const energyCards = [...actions.recoverCards]
      .sort((a, b) => {
        const priorityA = getResonancePriority(player, a, 'recover') + getCardValue(a);
        const priorityB = getResonancePriority(player, b, 'recover') + getCardValue(b);
        return priorityB - priorityA;
      });

    for (const card of energyCards.slice(0, 5)) { // limit simulation count to 5
      for (const slot of actions.decelSlots) {
        const simState = cloneState(state);
        const result = executeRecover(simState, { type: 'recover', cardId: card.id, wheelSlot: slot });
        const score = evaluateBoardFuture(result.state, state.currentPlayerIndex);
        candidates.push({
          action: { type: 'recover', cardId: card.id, wheelSlot: slot },
          score,
          description: `recover slot ${slot} with ${card.rank} (${card.suit})`,
        });
      }
    }
  }

  // === Collision ===
  if (actions.canCollide) {
    const collisionPlan = planCollision(state);
    if (collisionPlan) {
      candidates.push(collisionPlan);
    }
  }

  // === End turn baseline ===
  const endScore = evaluateBoardFuture(state, state.currentPlayerIndex) - 2; // slight penalty to encourage action
  candidates.push({
    action: { type: 'endTurn' },
    score: endScore,
    description: 'end turn',
  });

  // Sort by score descending, pick best
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  log.info(`Decision: ${best.description} (score: ${best.score.toFixed(0)})`);
  log.debug(`Top 3 candidates:`, candidates.slice(0, 3).map(c => `${c.description}: ${c.score.toFixed(0)}`));

  return best.action;
}

// ---------------------------------------------------------------------------
// Collision planning
// ---------------------------------------------------------------------------

function buildPayment(player: PlayerState, targetEnergy: number): { cardIds: string[]; energyPaid: number } | null {
  const energyInHand = player.hand.filter(c => isEnergyCard(c));
  const sortedEnergy = [...energyInHand].sort((a, b) => getCardValue(a) - getCardValue(b));

  const paymentIds: string[] = [];
  let paid = 0;

  for (const card of sortedEnergy) {
    if (paid >= targetEnergy) break;
    if (paid + getCardValue(card) <= MAX_COLLISION_ENERGY) {
      paymentIds.push(card.id);
      paid += getCardValue(card);
    }
  }

  if (paid < targetEnergy && player.nitro.length > 0) {
    for (let i = player.nitro.length - 1; i >= 0 && paid < targetEnergy; i--) {
      if (paid + NITRO_ENERGY_VALUE <= MAX_COLLISION_ENERGY) {
        paymentIds.push(player.nitro[i].id);
        paid += NITRO_ENERGY_VALUE;
      }
    }
  }

  if (paid < targetEnergy) {
    return null;
  }

  return { cardIds: paymentIds, energyPaid: paid };
}

function findBestSimulatedAttack(
  simState: GameState,
  currentPlayerIndex: 0 | 1
): { attackerSlot: number; targetSlot: number | 'core'; nextState: GameState; score: number } | null {
  const attackers = getValidAttackers(simState);
  const targets = getValidCollisionTargets(simState);

  if (attackers.length === 0 || targets.length === 0) {
    return null;
  }

  let bestResult: {
    attackerSlot: number;
    targetSlot: number | 'core';
    nextState: GameState;
    score: number;
  } | null = null;

  for (const attackerSlot of attackers) {
    for (const targetSlot of targets) {
      const attackRes = executeCollisionAttack(simState, {
        type: 'collisionAttack',
        attackerSlot,
        targetSlot,
      });
      const score = evaluateBoardFuture(attackRes.state, currentPlayerIndex);

      if (!bestResult || score > bestResult.score) {
        bestResult = {
          attackerSlot,
          targetSlot,
          nextState: attackRes.state,
          score,
        };
      }
    }
  }

  return bestResult;
}

function planCollision(state: GameState): ScoredAction | null {
  const player = getAIPlayer(state);
  const speedCards = getSpeedCards(player);
  if (speedCards.length === 0) return null;

  const minSpeedValue = Math.min(...speedCards.map(s => getCardValue(s.wc.card)));
  const targets = getValidCollisionTargets(state);
  if (targets.length === 0) return null;

  // We try payment targets from minSpeedValue up to MAX_COLLISION_ENERGY (10)
  const uniquePayments = new Map<string, { cardIds: string[]; energyPaid: number }>();

  for (let e = minSpeedValue; e <= MAX_COLLISION_ENERGY; e++) {
    const pay = buildPayment(player, e);
    if (pay) {
      const key = [...pay.cardIds].sort().join(',');
      uniquePayments.set(key, pay);
    }
  }

  if (uniquePayments.size === 0) return null;

  let bestPlan: ScoredAction | null = null;

  for (const [_, pay] of uniquePayments) {
    const simState = cloneState(state);
    const startResult = executeStartCollision(simState, {
      type: 'startCollision',
      paymentCardIds: pay.cardIds,
    });
    
    let currentSimState = startResult.state;
    const attackSequence: { attackerSlot: number; targetSlot: number | 'core' }[] = [];

    // Greedy simulate attacks until no valid attackers remain (or game over)
    while (true) {
      if (currentSimState.phase === 'gameOver') break;
      const bestAttack = findBestSimulatedAttack(currentSimState, state.currentPlayerIndex);
      if (!bestAttack) break;

      currentSimState = bestAttack.nextState;
      attackSequence.push({
        attackerSlot: bestAttack.attackerSlot,
        targetSlot: bestAttack.targetSlot,
      });
    }

    const finalScore = evaluateBoardFuture(currentSimState, state.currentPlayerIndex);

    if (attackSequence.length > 0) {
      if (!bestPlan || finalScore > bestPlan.score) {
        bestPlan = {
          action: { type: 'startCollision', paymentCardIds: pay.cardIds },
          score: finalScore,
          description: `collision: pay ${pay.energyPaid} (cards: ${pay.cardIds.length}) -> sequence: ${attackSequence.map(a => `${a.attackerSlot}->${a.targetSlot}`).join(', ')}`,
        };
      }
    }
  }

  const endScore = evaluateBoardFuture(state, state.currentPlayerIndex) - 2;
  if (bestPlan && bestPlan.score > endScore) {
    return bestPlan;
  }

  return null;
}

/** Decide collision attacker when in overload / continuing collision. */
export function decideCollisionAttacker(state: GameState): GameAction {
  const best = findBestSimulatedAttack(state, state.currentPlayerIndex);
  if (best) {
    log.info(`Collision attack: slot ${best.attackerSlot} → ${best.targetSlot}`);
    return {
      type: 'collisionAttack',
      attackerSlot: best.attackerSlot,
      targetSlot: best.targetSlot,
    };
  }
  log.error('No best attack found in overload');
  return { type: 'endTurn' };
}
