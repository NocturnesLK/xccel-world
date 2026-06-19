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
};

// ---------------------------------------------------------------------------
// Board evaluation
// ---------------------------------------------------------------------------

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

  // Opponent's field
  for (const wc of opp.wheels) {
    if (!wc) continue;
    if (wc.state === 'speed') score += W.OPP_SPEED - getCardValue(wc.card);
    else if (wc.state === 'accel') score += W.OPP_ACCEL;
    else if (wc.state === 'decel') score += W.OPP_DECEL;
  }
  score += opp.nitro.length * W.OPP_NITRO;
  score += opp.hand.length * W.OPP_HAND;

  // Victory proximity: maxAccel (4 speed + 4 nitro)
  const speedCount = getSpeedCount(me);
  const nitroCount = me.nitro.length;
  score += (speedCount + nitroCount) * W.VICTORY_MAXACCEL_PROGRESS;

  // If game over and we won, huge bonus
  if (state.winner === me.id) score += 100000;
  if (state.winner === opp.id) score -= 100000;

  return score;
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

    // Sort drive cards exactly as in decideSettleDeceleration
    const sorted = driveCards.sort((a, b) => {
      if (a.wc.state !== b.wc.state) {
        return a.wc.state === 'speed' ? -1 : 1; // prefer to decel speed over accel
      }
      return getCardValue(a.wc.card) - getCardValue(b.wc.card);
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

  // Prefer to decelerate low-value cards and accel cards (since accel→discard)
  const sorted = driveCards.sort((a, b) => {
    // Accel cards are worse to lose (they get discarded), so actually prefer to decel speed cards
    // Speed cards just become decel (can be recovered), accel cards get fully discarded
    // Strategy: decelerate speed cards with lowest values first
    if (a.wc.state !== b.wc.state) {
      return a.wc.state === 'speed' ? -1 : 1; // prefer to decel speed over accel
    }
    return getCardValue(a.wc.card) - getCardValue(b.wc.card);
  });

  const slots = sorted.slice(0, count).map(d => d.slot);
  log.info(`Settle deceleration: slots ${slots.join(',')}`);
  return { type: 'settleDeceleration', slots };
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
    const score = evaluateBoardFuture(result.state, state.currentPlayerIndex) + 5;
    candidates.push({ action: { type: 'update', cardId: card.id }, score, description: `update core with ${card.rank}` });
  }

  // === Accel ===
  if (actions.canAccel) {
    const energyCards = actions.accelCards
      .sort((a, b) => getCardValue(b) - getCardValue(a)); // prefer high value

    for (const card of energyCards.slice(0, 3)) { // limit simulation count
      for (const slot of actions.emptySlots.slice(0, 2)) {
        const simState = cloneState(state);
        const result = executeAccel(simState, { type: 'accel', cardId: card.id, wheelSlot: slot });
        const score = evaluateBoardFuture(result.state, state.currentPlayerIndex);
        candidates.push({
          action: { type: 'accel', cardId: card.id, wheelSlot: slot },
          score,
          description: `accel ${card.rank} to slot ${slot}`,
        });
      }
    }
  }

  // === Recover ===
  if (actions.canRecover) {
    const energyCards = actions.recoverCards
      .sort((a, b) => getCardValue(b) - getCardValue(a));

    for (const card of energyCards.slice(0, 3)) {
      for (const slot of actions.decelSlots) {
        const simState = cloneState(state);
        const result = executeRecover(simState, { type: 'recover', cardId: card.id, wheelSlot: slot });
        const score = evaluateBoardFuture(result.state, state.currentPlayerIndex);
        candidates.push({
          action: { type: 'recover', cardId: card.id, wheelSlot: slot },
          score,
          description: `recover slot ${slot} with ${card.rank}`,
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

function planCollision(state: GameState): ScoredAction | null {
  const player = getAIPlayer(state);
  const speedCards = getSpeedCards(player);
  if (speedCards.length === 0) return null;

  const energyInHand = player.hand.filter(c => isEnergyCard(c));
  const totalHandEnergy = energyInHand.reduce((sum, c) => sum + getCardValue(c), 0);
  const totalNitroEnergy = player.nitro.length * NITRO_ENERGY_VALUE;
  const totalAvailable = Math.min(totalHandEnergy + totalNitroEnergy, MAX_COLLISION_ENERGY);

  if (totalAvailable <= 0) return null;

  // Find the best attacker (can afford)
  const affordable = speedCards.filter(s => getCardValue(s.wc.card) <= totalAvailable);
  if (affordable.length === 0) return null;

  // Check targets
  const targets = getValidCollisionTargets(state);
  if (targets.length === 0) return null;

  // Simple strategy: pick highest value attacker that we can afford
  affordable.sort((a, b) => getCardValue(b.wc.card) - getCardValue(a.wc.card));
  const attacker = affordable[0];
  const attackerValue = getCardValue(attacker.wc.card);

  // Build payment: use lowest value hand cards first, then nitro
  const paymentIds: string[] = [];
  let paid = 0;
  const sortedEnergy = [...energyInHand].sort((a, b) => getCardValue(a) - getCardValue(b));

  for (const card of sortedEnergy) {
    if (paid >= attackerValue) break;
    if (paid + getCardValue(card) <= MAX_COLLISION_ENERGY) {
      paymentIds.push(card.id);
      paid += getCardValue(card);
    }
  }

  // Use nitro if still not enough
  if (paid < attackerValue && player.nitro.length > 0) {
    for (let i = player.nitro.length - 1; i >= 0 && paid < attackerValue; i--) {
      if (paid + NITRO_ENERGY_VALUE <= MAX_COLLISION_ENERGY) {
        paymentIds.push(player.nitro[i].id);
        paid += NITRO_ENERGY_VALUE;
      }
    }
  }

  if (paid < attackerValue) return null;

  // Evaluate collision outcome
  let bestScore = -Infinity;
  let bestTarget: number | 'core' = targets[0];
  const opp = state.players[state.currentPlayerIndex === 0 ? 1 : 0];

  for (const target of targets) {
    let score = 0;
    if (target === 'core') {
      score = W.COLLISION_CORE_HIT;
    } else {
      const targetWc = opp.wheels[target];
      if (!targetWc) continue;
      if (targetWc.state === 'accel') {
        score = W.COLLISION_REMOVE_ACCEL;
      } else if (targetWc.state === 'decel') {
        score = W.COLLISION_REMOVE_ACCEL; // easy removal
      } else {
        // Speed vs speed
        const targetValue = getCardValue(targetWc.card);
        if (attackerValue > targetValue) {
          score = W.COLLISION_REMOVE_SPEED + (targetValue * 2);
        } else if (attackerValue === targetValue) {
          score = -5; // both decel, usually not worth it
        } else {
          score = -20; // we get slowed, bad
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestTarget = target;
    }
  }

  // Only collide if the outcome is positive
  if (bestScore <= 0) return null;

  // Simulate the full collision
  const simState = cloneState(state);
  const startResult = executeStartCollision(simState, { type: 'startCollision', paymentCardIds: paymentIds });
  const afterStart = startResult.state;

  // Execute the attack
  const attackResult = executeCollisionAttack(afterStart, {
    type: 'collisionAttack', attackerSlot: attacker.slot, targetSlot: bestTarget,
  });

  const finalScore = evaluateBoardFuture(attackResult.state, state.currentPlayerIndex);

  return {
    action: { type: 'startCollision', paymentCardIds: paymentIds },
    score: finalScore,
    description: `collision: pay ${paid}, attacker slot ${attacker.slot} → target ${bestTarget}`,
  };
}

/** Decide collision attacker when in overload / continuing collision. */
export function decideCollisionAttacker(state: GameState): GameAction {
  const attackers = getValidAttackers(state);
  const player = getAIPlayer(state);
  const targets = getValidCollisionTargets(state);

  if (attackers.length === 0 || targets.length === 0) {
    log.error('No valid attackers or targets in overload');
    return { type: 'endTurn' };
  }

  // Pick attacker with highest value
  let bestSlot = attackers[0];
  let bestVal = 0;
  for (const slot of attackers) {
    const wc = player.wheels[slot];
    if (wc) {
      const v = getCardValue(wc.card);
      if (v > bestVal) { bestVal = v; bestSlot = slot; }
    }
  }

  // Pick best target
  let bestTarget: number | 'core' = targets[0];
  if (targets.includes('core')) {
    bestTarget = 'core';
  } else {
    const opp = state.players[state.currentPlayerIndex === 0 ? 1 : 0];
    // Prefer speed cards we can beat, then accel, then decel
    let bestTargetScore = -Infinity;
    for (const t of targets) {
      if (t === 'core') continue;
      const wc = opp.wheels[t];
      if (!wc) continue;
      let score = 0;
      if (wc.state === 'accel' || wc.state === 'decel') score = 10;
      else if (getCardValue(wc.card) < bestVal) score = 15 + getCardValue(wc.card);
      else if (getCardValue(wc.card) === bestVal) score = -5;
      else score = -15;
      if (score > bestTargetScore) { bestTargetScore = score; bestTarget = t; }
    }
  }

  log.info(`Collision attack: slot ${bestSlot} → ${bestTarget}`);
  return { type: 'collisionAttack', attackerSlot: bestSlot, targetSlot: bestTarget };
}
