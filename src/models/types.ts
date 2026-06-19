// =============================================================================
// types.ts — Core type definitions for Accelerated World card game
// =============================================================================

// === Card Types ===

export const SUITS = ['Heart', 'Diamond', 'Club', 'Spade'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

export const ENERGY_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'] as const;
export type EnergyRank = (typeof ENERGY_RANKS)[number];

export const CORE_RANKS = ['J', 'Q', 'K'] as const;
export type CoreRank = (typeof CORE_RANKS)[number];

/** Immutable card identity */
export interface Card {
  readonly id: string;
  readonly suit: Suit;
  readonly rank: Rank;
}

// === Field Types ===

export type WheelCardState = 'speed' | 'accel' | 'decel';

export interface WheelCard {
  card: Card;
  state: WheelCardState;
}

export type PlayerId = 'player' | 'ai';

export interface PlayerState {
  id: PlayerId;
  core: Card | null;
  wheels: (WheelCard | null)[]; // length 4, indices 0-3
  nitro: Card[]; // stack, index 0 = bottom
  hand: Card[];
  deck: Card[];
  discard: Card[];
  excluded: Card[];
  deckExhaustCount: number; // tracks times deck ran out for victory condition

  // Per-turn resonance tracking (reset each turn)
  resonanceRecoverSuits: Suit[];
  resonanceAccelSuit: Suit | null;
}

// === Game State ===

export type GamePhase =
  | 'mulligan'
  | 'selectInitialSpeed'
  | 'draw'
  | 'play'
  | 'settle'
  | 'settleDiscard' // sub-phase: drive > hand, pick cards to decelerate
  | 'drawDiscard'   // sub-phase: hand > 6 after drawing
  | 'gameOver';

export type VictoryType = 'crashCore' | 'maxAccel' | 'deckExhaust';

export interface CollisionState {
  totalPaid: number;
  remainingEnergy: number;
  paymentCardIds: string[];
  attacks: CollisionAttackRecord[];
}

export interface CollisionAttackRecord {
  attackerSlot: number;
  targetSlot: number | 'core';
  result: CollisionResult;
}

export type CollisionResult =
  | 'targetDecel'       // attacker > target speed → target becomes decel
  | 'bothDecel'         // attacker == target speed → both become decel
  | 'attackerDecel'     // attacker < target speed → attacker becomes decel
  | 'targetDestroyed'   // target was accel/decel → destroyed
  | 'targetSavedByNitro'// target was accel → opponent chose to sacrifice nitro
  | 'coreHit';          // core was hit → game over

export interface GameState {
  players: [PlayerState, PlayerState]; // index 0 = player, index 1 = ai
  currentPlayerIndex: 0 | 1;
  phase: GamePhase;
  turnNumber: number;
  firstPlayerIndex: 0 | 1;
  winner: PlayerId | null;
  victoryType: VictoryType | null;
  collisionState: CollisionState | null;
}

// === Actions ===

export interface UpdateAction {
  type: 'update';
  cardId: string; // core card (J/Q/K) from hand
}

export interface AccelAction {
  type: 'accel';
  cardId: string; // energy card from hand
  wheelSlot: number; // empty wheel slot index
}

export interface RecoverAction {
  type: 'recover';
  cardId: string; // energy card from hand
  wheelSlot: number; // wheel slot with decel card
}

export interface StartCollisionAction {
  type: 'startCollision';
  paymentCardIds: string[]; // hand energy cards + nitro cards to pay
}

export interface CollisionAttackAction {
  type: 'collisionAttack';
  attackerSlot: number; // wheel slot of speed card
  targetSlot: number | 'core'; // target on opponent's field
}

export interface EndTurnAction {
  type: 'endTurn';
}

export interface DiscardAction {
  type: 'discard';
  cardIds: string[]; // cards to discard from hand
}

export interface SettleDecelerationAction {
  type: 'settleDeceleration';
  slots: number[]; // wheel slots to decelerate (speed→decel, accel→discard)
}

export interface MulliganAction {
  type: 'mulligan';
  cardIds: string[]; // cards to return to deck bottom (can be empty = keep all)
}

export interface SelectInitialSpeedAction {
  type: 'selectInitialSpeed';
  cardId: string; // energy card from hand
  wheelSlot: number; // wheel slot 0-3
}

export type GameAction =
  | UpdateAction
  | AccelAction
  | RecoverAction
  | StartCollisionAction
  | CollisionAttackAction
  | EndTurnAction
  | DiscardAction
  | SettleDecelerationAction
  | MulliganAction
  | SelectInitialSpeedAction;

// === UI Interaction Modes ===

export type InteractionMode =
  | { type: 'waiting' }
  | { type: 'mulligan' }
  | { type: 'selectInitialSpeed' }
  | { type: 'play' }
  | { type: 'selectWheelSlot'; cardId: string; purpose: 'accel' | 'recover' }
  | { type: 'selectCollisionPayment'; selectedCardIds: string[]; totalEnergy: number }
  | { type: 'selectCollisionAttacker'; remainingEnergy: number }
  | { type: 'selectCollisionTarget'; attackerSlot: number; remainingEnergy: number }
  | { type: 'selectSettleCards'; count: number; selectedSlots: number[] }
  | { type: 'selectDiscardCards'; count: number; selectedCardIds: string[] }
  | { type: 'opponentDecision' } // waiting for opponent to decide (e.g., nitro sacrifice)
  | { type: 'gameOver' };

// === Game Log ===

export type LogType = 'action' | 'phase' | 'resonance' | 'collision' | 'victory' | 'system';

export interface GameLogEntry {
  turnNumber: number;
  playerId: PlayerId | null;
  message: string;
  logType: LogType;
  timestamp: number;
}

// === Engine Result ===

export interface ActionResult {
  state: GameState;
  logs: GameLogEntry[];
}

// === Utility type for deep cloning ===

export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state));
}

export function clonePlayer(player: PlayerState): PlayerState {
  return JSON.parse(JSON.stringify(player));
}
