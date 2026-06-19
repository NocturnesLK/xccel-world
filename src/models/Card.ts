// =============================================================================
// Card.ts — Card utility functions
// =============================================================================

import { Card, Suit, Rank, SUITS, ENERGY_RANKS, CORE_RANKS, WheelCard, PlayerState } from './types';

/** Map rank to numeric energy value. J/Q/K return 0. */
export function getCardValue(card: Card): number {
  if (card.rank === 'A') return 1;
  const n = parseInt(card.rank, 10);
  return isNaN(n) ? 0 : n;
}

export function isEnergyCard(card: Card): boolean {
  return (ENERGY_RANKS as readonly string[]).includes(card.rank);
}

export function isCoreCard(card: Card): boolean {
  return (CORE_RANKS as readonly string[]).includes(card.rank);
}

/** Generate the image path for a card face. */
export function getCardImagePath(card: Card): string {
  const base = import.meta.env.BASE_URL;
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  return `${cleanBase}Poker/PNG/${card.suit}${card.rank}.png`;
}

/** Card back image path. */
export function getCardBackImagePath(): string {
  const base = import.meta.env.BASE_URL;
  const cleanBase = base.endsWith('/') ? base : `${base}/`;
  return `${cleanBase}Poker/PNG/Background.png`;
}

/** Create a full 52-card deck (no jokers). */
export function createFullDeck(ownerId: string): Card[] {
  const cards: Card[] = [];
  const allRanks: Rank[] = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  for (const suit of SUITS) {
    for (const rank of allRanks) {
      cards.push({
        id: `${ownerId}_${suit}_${rank}`,
        suit,
        rank,
      });
    }
  }
  return cards;
}

/** Fisher-Yates shuffle (in-place, returns same array). */
export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Get all speed cards on a player's field. */
export function getSpeedCards(player: PlayerState): { slot: number; wc: WheelCard }[] {
  const result: { slot: number; wc: WheelCard }[] = [];
  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && wc.state === 'speed') {
      result.push({ slot: i, wc });
    }
  }
  return result;
}

/** Get all drive cards (speed + accel) on a player's field. */
export function getDriveCards(player: PlayerState): { slot: number; wc: WheelCard }[] {
  const result: { slot: number; wc: WheelCard }[] = [];
  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && (wc.state === 'speed' || wc.state === 'accel')) {
      result.push({ slot: i, wc });
    }
  }
  return result;
}

/** Get all decel cards on a player's field. */
export function getDecelCards(player: PlayerState): { slot: number; wc: WheelCard }[] {
  const result: { slot: number; wc: WheelCard }[] = [];
  for (let i = 0; i < 4; i++) {
    const wc = player.wheels[i];
    if (wc && wc.state === 'decel') {
      result.push({ slot: i, wc });
    }
  }
  return result;
}

/** Get indices of empty wheel slots. */
export function getEmptyWheelSlots(player: PlayerState): number[] {
  const result: number[] = [];
  for (let i = 0; i < 4; i++) {
    if (!player.wheels[i]) result.push(i);
  }
  return result;
}

/** Count drive cards. */
export function getDriveCount(player: PlayerState): number {
  return getDriveCards(player).length;
}

/** Count speed cards. */
export function getSpeedCount(player: PlayerState): number {
  return getSpeedCards(player).length;
}

/** Check if a wheel slot has any card. */
export function hasAnyWheelCard(player: PlayerState): boolean {
  return player.wheels.some(w => w !== null);
}

/** Get the display name of a card for game logs. */
export function cardDisplayName(card: Card): string {
  const suitMap: Record<string, string> = {
    Heart: '♥', Diamond: '♦', Club: '♣', Spade: '♠',
  };
  return `${suitMap[card.suit] ?? card.suit}${card.rank}`;
}

/** NITRO_ENERGY_VALUE: each nitro card is worth 5 energy. */
export const NITRO_ENERGY_VALUE = 5;

/** MAX_HAND_SIZE: maximum hand size is 6. */
export const MAX_HAND_SIZE = 6;

/** MAX_COLLISION_ENERGY: max energy payable for collision. */
export const MAX_COLLISION_ENERGY = 10;

/** Find a card in an array by ID. */
export function findCardById(cards: Card[], id: string): Card | undefined {
  return cards.find(c => c.id === id);
}

/** Remove a card from an array by ID (returns new array). */
export function removeCardById(cards: Card[], id: string): Card[] {
  return cards.filter(c => c.id !== id);
}
