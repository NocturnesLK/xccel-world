// =============================================================================
// CollisionResolver.ts — Collision mechanics for Accelerated World
// =============================================================================

import {
  GameState, CollisionAttackRecord,
  CollisionResult, GameLogEntry, ActionResult, PlayerId,
} from '../models/types';
import {
  getCardValue, cardDisplayName,
  hasAnyWheelCard,
} from '../models/Card';
import { createLogger } from '../logger';

const log = createLogger('Collision');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLog(state: GameState, msg: string, logType: GameLogEntry['logType'] = 'collision'): GameLogEntry {
  const pid = state.players[state.currentPlayerIndex].id;
  return { turnNumber: state.turnNumber, playerId: pid, message: msg, logType, timestamp: Date.now() };
}

function opponentIndex(state: GameState): 0 | 1 {
  return state.currentPlayerIndex === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------


/** Get valid collision targets for the current player. */
export function getValidCollisionTargets(state: GameState): (number | 'core')[] {
  const oppIdx = opponentIndex(state);
  const opponent = state.players[oppIdx];
  const targets: (number | 'core')[] = [];

  // Check if opponent has any wheel cards at all
  if (!hasAnyWheelCard(opponent)) {
    // Can target core
    targets.push('core');
    return targets;
  }

  // Can target any wheel card (speed, accel, or decel)
  for (let i = 0; i < 4; i++) {
    if (opponent.wheels[i] !== null) {
      targets.push(i);
    }
  }

  return targets;
}

/** Get speed cards that can be used as attackers given remaining energy. */
export function getValidAttackers(state: GameState): number[] {
  if (!state.collisionState) return [];
  const player = state.players[state.currentPlayerIndex];
  const remaining = state.collisionState.remainingEnergy;
  const slots: number[] = [];

  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && wc.state === 'speed' && getCardValue(wc.card) <= remaining) {
      slots.push(i);
    }
  }
  return slots;
}

/** Check if overload is in effect (must continue attacking). */
export function isOverloadActive(state: GameState): boolean {
  return getValidAttackers(state).length > 0;
}

/** Execute a single collision attack. */
export function executeCollisionAttack(
  state: GameState,
  attackerSlot: number,
  targetSlot: number | 'core',
): ActionResult {
  const logs: GameLogEntry[] = [];
  const cs = state.collisionState;
  if (!cs) {
    log.error('No collision state');
    return { state, logs };
  }

  const player = state.players[state.currentPlayerIndex];
  const oppIdx = opponentIndex(state);
  const opponent = state.players[oppIdx];
  const attackerWc = player.wheels[attackerSlot];

  if (!attackerWc || attackerWc.state !== 'speed') {
    log.error('Attacker is not a speed card', attackerSlot);
    return { state, logs };
  }

  const attackerValue = getCardValue(attackerWc.card);
  cs.remainingEnergy -= attackerValue;
  log.debug(`Attacker ${cardDisplayName(attackerWc.card)} costs ${attackerValue}, remaining: ${cs.remainingEnergy}`);

  let result: CollisionResult;

  if (targetSlot === 'core') {
    // Hit opponent's core → game over
    result = 'coreHit';
    logs.push(makeLog(state, `${cardDisplayName(attackerWc.card)} 撞击了对手的核心！`));
    state.winner = player.id;
    state.victoryType = 'crashCore';
    state.phase = 'gameOver';
  } else {
    const targetWc = opponent.wheels[targetSlot];
    if (!targetWc) {
      log.error('Target slot is empty', targetSlot);
      return { state, logs };
    }

    const targetName = cardDisplayName(targetWc.card);
    const attackerName = cardDisplayName(attackerWc.card);

    if (targetWc.state === 'decel') {
      // Target is decel → destroy
      result = 'targetDestroyed';
      opponent.wheels[targetSlot] = null;
      opponent.discard.push(targetWc.card);
      logs.push(makeLog(state, `${attackerName} → ${targetName}(减速)：直接摧毁`));
    } else if (targetWc.state === 'accel') {
      // Target is accel → destroy, but opponent can sacrifice nitro
      if (opponent.nitro.length > 0) {
        // Sacrifice nitro to save accel card (auto-sacrifice for both AI and player)
        const nitroCard = opponent.nitro.pop()!;
        opponent.discard.push(nitroCard);
        result = 'targetSavedByNitro';
        const defenderName = opponent.id === 'ai' ? 'AI' : '玩家';
        logs.push(makeLog(state, `${attackerName} → ${targetName}(加速)：${defenderName}弃置氮气牌保护`));
      } else {
        result = 'targetDestroyed';
        opponent.wheels[targetSlot] = null;
        opponent.discard.push(targetWc.card);
        logs.push(makeLog(state, `${attackerName} → ${targetName}(加速)：摧毁`));
      }
    } else {
      // Target is speed → compare values
      const targetValue = getCardValue(targetWc.card);
      if (attackerValue > targetValue) {
        result = 'targetDecel';
        targetWc.state = 'decel';
        logs.push(makeLog(state, `${attackerName}(${attackerValue}) > ${targetName}(${targetValue})：目标减速`));
      } else if (attackerValue === targetValue) {
        result = 'bothDecel';
        targetWc.state = 'decel';
        attackerWc.state = 'decel';
        logs.push(makeLog(state, `${attackerName}(${attackerValue}) = ${targetName}(${targetValue})：双方减速`));
      } else {
        result = 'attackerDecel';
        attackerWc.state = 'decel';
        logs.push(makeLog(state, `${attackerName}(${attackerValue}) < ${targetName}(${targetValue})：攻击方减速`));
      }
    }
  }

  cs.attacks.push({ attackerSlot, targetSlot, result });

  // Check if collision should end
  if (state.phase === 'gameOver') {
    state.collisionState = null;
  } else if (!isOverloadActive(state)) {
    log.debug('Collision ends, no more valid attackers');
    state.collisionState = null;
  } else {
    logs.push(makeLog(state, `过载！剩余能量 ${cs.remainingEnergy}，必须继续撞击`));
  }

  return { state, logs };
}

/** Check if collision is still in progress. */
export function isCollisionActive(state: GameState): boolean {
  return state.collisionState !== null;
}
