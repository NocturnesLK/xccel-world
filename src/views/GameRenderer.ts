// =============================================================================
// GameRenderer.ts — DOM rendering engine for Accelerated World
// =============================================================================

import {
  GameState, PlayerState, InteractionMode, Card, WheelCard,
  GameLogEntry, PlayerId,
} from '../models/types';
import {
  getCardImagePath, getCardBackImagePath, cardDisplayName,
  isEnergyCard, isCoreCard, getCardValue,
} from '../models/Card';
import { createLogger } from '../logger';

const log = createLogger('Renderer');

// === Callback interface ===
export interface RenderCallbacks {
  onStartGame: () => void;
  onCardClick: (cardId: string, source: 'hand' | 'field') => void;
  onWheelSlotClick: (playerIndex: number, slot: number) => void;
  onCoreClick: (playerIndex: number) => void;
  onNitroClick: (playerIndex: number) => void;
  onEndTurn: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRestart: () => void;
}

// === Cached DOM references ===
interface CachedElements {
  startScreen: HTMLElement;
  gameBoard: HTMLElement;
  aiInfoBar: HTMLElement;
  aiArea: HTMLElement;
  aiHand: HTMLElement;
  divider: HTMLElement;
  playerHand: HTMLElement;
  playerArea: HTMLElement;
  playerInfoBar: HTMLElement;
  bottomPanel: HTMLElement;
  logContainer: HTMLElement;
  gameLog: HTMLElement;
  actionHint: HTMLElement;
  actionButtons: HTMLElement;
  victoryOverlay: HTMLElement;
}

const PHASE_NAMES: Record<string, string> = {
  mulligan: '调度', selectInitialSpeed: '初始速度', draw: '抽牌',
  play: '出牌', settle: '结算', settleDiscard: '结算',
  drawDiscard: '弃牌', gameOver: '结束',
};

const VICTORY_NAMES: Record<string, string> = {
  crashCore: '核心击溃', maxAccel: '全速胜利', deckExhaust: '资源耗尽',
};

function getHintText(mode: InteractionMode): string {
  switch (mode.type) {
    case 'waiting': return '等待对手行动...';
    case 'mulligan': return '选择要换回的手牌，然后点击确认';
    case 'selectInitialSpeed': return '选择一张能量牌作为初始速度牌';
    case 'play': return '出牌阶段 — 点击手牌进行操作';
    case 'selectCoreSlot': return '选择核心位置替换核心牌';
    case 'selectWheelSlot': return '选择一个车轮位放置卡牌';
    case 'selectCollisionPayment':
      return `选择手牌/氮气支付能量 (已选: ${mode.totalEnergy}点, 上限10点)`;
    case 'selectCollisionAttacker':
      return `选择一张速度牌发起撞击 (剩余能量: ${mode.remainingEnergy})`;
    case 'selectCollisionTarget': return '选择撞击目标';
    case 'selectSettleCards': return `选择 ${mode.count} 张驱动牌减速`;
    case 'selectDiscardCards': return `弃掉 ${mode.count} 张手牌（手牌上限6张）`;
    case 'opponentDecision': return '等待对手决定...';
    case 'gameOver': return '游戏结束!';
  }
}

// =============================================================================
export class GameRenderer {
  private root: HTMLElement;
  private callbacks: RenderCallbacks;
  private els!: CachedElements;

  constructor(root: HTMLElement, callbacks: RenderCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  /** Build the initial DOM scaffold (called once). */
  initDOM(): void {
    log.debug('initDOM');
    this.root.innerHTML = '';

    const startScreen = this.mkEl('div', 'start-screen');
    startScreen.innerHTML = `<h1>加速世界</h1><p class="subtitle">Accelerated World</p>
      <button class="start-btn">开始对战</button>`;
    startScreen.querySelector('.start-btn')!
      .addEventListener('click', () => this.callbacks.onStartGame());

    const board = this.mkEl('div', 'game-board');
    board.style.display = 'none';
    const aiInfoBar = this.mkEl('div', 'info-bar ai');
    const aiArea = this.mkEl('div', 'player-area ai');
    const aiHand = this.mkEl('div', 'hand-area ai-hand');
    const divider = this.mkEl('div', 'battle-divider');
    const playerHand = this.mkEl('div', 'hand-area player-hand');
    const playerArea = this.mkEl('div', 'player-area player');
    const playerInfoBar = this.mkEl('div', 'info-bar player');
    board.append(aiHand, aiInfoBar, aiArea, divider, playerArea, playerInfoBar, playerHand);

    const bottomPanel = this.mkEl('div', 'bottom-panel');
    
    // Wrap gameLog in a container with a header for mobile
    const logContainer = this.mkEl('div', 'log-container');
    const logHeader = this.mkEl('div', 'log-header');
    logHeader.innerHTML = `<span class="log-title">对战日志</span><button class="log-close-btn">&times;</button>`;
    const gameLog = this.mkEl('div', 'game-log');
    logContainer.append(logHeader, gameLog);

    logHeader.querySelector('.log-close-btn')!.addEventListener('click', () => {
      logContainer.classList.remove('show');
    });

    const actionBar = this.mkEl('div', 'action-bar');
    const actionHint = this.mkEl('div', 'action-hint');
    const actionButtons = this.mkEl('div', 'action-buttons');
    actionBar.append(actionHint, actionButtons);
    bottomPanel.append(logContainer, actionBar);
    bottomPanel.style.display = 'none';

    const victoryOverlay = this.mkEl('div', 'victory-overlay');
    victoryOverlay.style.display = 'none';

    this.root.append(startScreen, board, bottomPanel, victoryOverlay);
    this.els = {
      startScreen, gameBoard: board, aiInfoBar, aiArea, aiHand,
      divider,
      playerHand, playerArea, playerInfoBar,
      bottomPanel, logContainer, gameLog, actionHint, actionButtons, victoryOverlay,
    };
  }

  /** Full re-render from state. */
  render(state: GameState, mode: InteractionMode): void {
    log.trace('render', { phase: state.phase, mode: mode.type });
    this.hideStartScreen();
    this.renderInfoBar(state.players[1], true, state);
    this.renderPlayerArea(state.players[1], true, state, mode);
    this.renderHand(state.players[1], true, mode);
    this.renderHand(state.players[0], false, mode);
    this.renderPlayerArea(state.players[0], false, state, mode);
    this.renderInfoBar(state.players[0], false, state);
    this.renderBattleDivider(state);
    this.renderBottomPanel(state, mode);
  }

  // --- Sub-renders ---

  private renderInfoBar(player: PlayerState, isAI: boolean, state: GameState): void {
    const el = isAI ? this.els.aiInfoBar : this.els.playerInfoBar;
    const name = isAI ? 'AI' : 'PLAYER';
    const cur = (isAI && state.currentPlayerIndex === 1) || (!isAI && state.currentPlayerIndex === 0);
    el.innerHTML = `
      <span class="player-name">${name}${cur ? ' ◀' : ''}</span>
      <span class="stat">牌库: <span class="stat-value">${player.deck.length}</span></span>
      <span class="stat">弃牌: <span class="stat-value">${player.discard.length}</span></span>
      <span class="stat">手牌: <span class="stat-value">${player.hand.length}</span></span>
      <span class="stat">氮气: <span class="stat-value">${player.nitro.length}</span></span>`;
  }

  private renderBattleDivider(state: GameState): void {
    const activePlayerIndex = state.currentPlayerIndex;
    const phase = PHASE_NAMES[state.phase] ?? state.phase;

    // AI side
    const aiActive = activePlayerIndex === 1;
    const aiPhaseHtml = aiActive ? `<span class="phase-label ${state.phase}">${phase}</span>` : '';
    const aiClass = aiActive ? 'active' : '';

    // Player side
    const playerActive = activePlayerIndex === 0;
    const playerPhaseHtml = playerActive ? `<span class="phase-label ${state.phase}">${phase}</span>` : '';
    const playerClass = playerActive ? 'active' : '';

    this.els.divider.innerHTML = `
      <div class="divider-content">
        <span class="divider-player ai ${aiClass}">AI ${aiPhaseHtml}</span>
        <span class="vs-text">⚡ VS ⚡</span>
        <span class="divider-player player ${playerClass}">${playerPhaseHtml} PLAYER</span>
        <span class="divider-turn">T${state.turnNumber}</span>
      </div>
    `;
  }

  private renderPlayerArea(p: PlayerState, isAI: boolean, state: GameState, mode: InteractionMode): void {
    const c = isAI ? this.els.aiArea : this.els.playerArea;
    c.innerHTML = '';

    // Deck + discard
    const deckArea = this.mkEl('div', 'deck-area');
    deckArea.innerHTML = `<div class="deck-pile">${p.deck.length}</div><span class="deck-label">牌库</span>
      <div class="discard-pile">${p.discard.length}</div><span class="deck-label">弃牌</span>`;

    // Field: [W0 W1] [Core] [W2 W3]
    const field = this.mkEl('div', 'field-area');
    const wL = this.mkEl('div', 'wheels-group');
    const wR = this.mkEl('div', 'wheels-group');
    for (let i = 0; i < 4; i++) {
      (i < 2 ? wL : wR).appendChild(this.buildWheelSlot(p, i, isAI, state, mode));
    }
    field.append(wL, this.buildCoreSlot(p, isAI, mode), wR);

    // Nitro
    const nitro = this.buildNitroArea(p, isAI, mode);
    c.append(deckArea, field, nitro);
  }

  private buildWheelSlot(p: PlayerState, idx: number, isAI: boolean, state: GameState, mode: InteractionMode): HTMLElement {
    const wc = p.wheels[idx];
    const pIdx = isAI ? 1 : 0;
    const slot = this.mkEl('div', 'card-slot');
    slot.setAttribute('data-slot', String(idx));

    if (!wc) {
      slot.classList.add('empty');
      slot.innerHTML = `<span class="slot-label">W${idx + 1}</span>`;
      if (!isAI && mode.type === 'selectWheelSlot' && (mode.purpose === 'accel' || mode.purpose === 'both')) {
        slot.classList.add('accel-placeable');
        slot.style.cursor = 'pointer';
      }
    } else {
      const cardEl = this.buildFieldCard(wc);
      slot.appendChild(cardEl);

      if (!isAI && mode.type === 'selectWheelSlot' && (mode.purpose === 'recover' || mode.purpose === 'both') && wc.state === 'decel') {
        slot.classList.add('placeable');
        slot.style.cursor = 'pointer';
      }
      
      const isValidAttacker =
        !isAI &&
        mode.type === 'selectCollisionAttacker' &&
        wc.state === 'speed' &&
        getCardValue(wc.card) <= mode.remainingEnergy &&
        !(state.collisionState?.attacks.some((a: any) => a.attackerSlot === idx));

      if (isValidAttacker) {
        cardEl.classList.add('attacker-selectable');
        cardEl.style.cursor = 'pointer';
        cardEl.addEventListener('click', () => this.callbacks.onCardClick(wc.card.id, 'field'));
      }
      if (isAI && mode.type === 'selectCollisionTarget') {
        slot.classList.add('targetable');
        slot.style.cursor = 'pointer';
      }
      if (!isAI && mode.type === 'selectSettleCards' && (wc.state === 'speed' || wc.state === 'accel')) {
        if (mode.selectedSlots.includes(idx)) cardEl.classList.add('selected');
        cardEl.style.cursor = 'pointer';
        cardEl.addEventListener('click', () => this.callbacks.onCardClick(wc.card.id, 'field'));
      }
    }

    // Generic slot click (empty slots + targetable slots)
    slot.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === slot || t.classList.contains('slot-label')) {
        this.callbacks.onWheelSlotClick(pIdx, idx);
      }
    });
    if ((isAI && mode.type === 'selectCollisionTarget') || (!isAI && mode.type === 'selectWheelSlot')) {
      slot.addEventListener('click', () => this.callbacks.onWheelSlotClick(pIdx, idx));
    }
    return slot;
  }

  private buildCoreSlot(p: PlayerState, isAI: boolean, mode: InteractionMode): HTMLElement {
    const pIdx = isAI ? 1 : 0;
    const slot = this.mkEl('div', 'card-slot core-slot');
    if (!p.core) {
      slot.classList.add('empty');
      slot.innerHTML = `<span class="slot-label">核心</span>`;
    } else {
      slot.appendChild(this.createCardElement(p.core, true, ['speed']));
    }
    if (isAI && mode.type === 'selectCollisionTarget') {
      slot.classList.add('targetable');
      slot.style.cursor = 'pointer';
    }
    if (!isAI && mode.type === 'selectCoreSlot') {
      slot.classList.add('placeable');
      slot.style.cursor = 'pointer';
    }
    slot.addEventListener('click', () => this.callbacks.onCoreClick(pIdx));
    return slot;
  }

  private buildNitroArea(p: PlayerState, isAI: boolean, mode: InteractionMode): HTMLElement {
    const pIdx = isAI ? 1 : 0;
    const area = this.mkEl('div', 'nitro-area');
    const layers = Math.min(p.nitro.length, 4);
    let stack = '';
    const backImg = getCardBackImagePath();
    for (let i = 0; i < layers; i++) {
      stack += `<div class="nitro-card-visual"><img src="${backImg}" alt="nitro back" style="width:100%; height:100%; object-fit:cover; border-radius:var(--card-radius);" /></div>`;
    }

    area.innerHTML = `<div class="nitro-stack">${stack}</div>
      <span class="nitro-count">×${p.nitro.length}</span><span class="slot-label">氮气</span>`;

    if (!isAI && mode.type === 'selectCollisionPayment' && p.nitro.length > 0) {
      area.style.cursor = 'pointer';
      area.classList.add('placeable');
    }
    area.addEventListener('click', () => this.callbacks.onNitroClick(pIdx));
    return area;
  }

  private renderHand(player: PlayerState, isAI: boolean, mode: InteractionMode): void {
    const container = isAI ? this.els.aiHand : this.els.playerHand;
    container.innerHTML = '';
    if (isAI) {
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';
    for (const card of player.hand) {
      const el = this.createCardElement(card, true);
      el.classList.add(`suit-${card.suit.toLowerCase()}`);
      this.applyHandCardMode(el, card, mode, player);
      el.addEventListener('click', () => this.callbacks.onCardClick(card.id, 'hand'));
      container.appendChild(el);
    }
  }

  private applyHandCardMode(el: HTMLElement, card: Card, mode: InteractionMode, player: PlayerState): void {
    switch (mode.type) {
      case 'mulligan':
        el.style.cursor = 'pointer'; break;
      case 'play':
        el.style.cursor = 'pointer';
        if (isCoreCard(card) && player.hasUpdatedThisTurn) {
          el.classList.add('disabled');
          el.style.cursor = 'not-allowed';
        }
        break;
      case 'selectCoreSlot':
      case 'selectWheelSlot':
        el.style.cursor = 'pointer';
        if (mode.cardId === card.id) el.classList.add('selected');
        break;
      case 'selectInitialSpeed':
        if (isEnergyCard(card)) el.style.cursor = 'pointer';
        else el.classList.add('disabled');
        break;
      case 'selectCollisionPayment':
        if (isEnergyCard(card)) {
          el.style.cursor = 'pointer';
          if (mode.selectedCardIds.includes(card.id)) el.classList.add('payment-selected');
        } else el.classList.add('disabled');
        break;
      case 'selectDiscardCards':
        el.style.cursor = 'pointer';
        if (mode.selectedCardIds.includes(card.id)) el.classList.add('selected');
        break;
    }
  }

  private renderBottomPanel(state: GameState, mode: InteractionMode): void {
    this.els.actionHint.textContent = getHintText(mode);
    this.renderActionButtons(state, mode);
  }

  private renderActionButtons(state: GameState, mode: InteractionMode): void {
    const c = this.els.actionButtons;
    c.innerHTML = '';
    const btn = (text: string, cls: string, fn: () => void, disabled = false) => {
      const b = document.createElement('button');
      b.className = `btn ${cls}`; b.textContent = text; b.disabled = disabled;
      b.addEventListener('click', fn); c.appendChild(b);
    };
    switch (mode.type) {
      case 'play': {
        const player = state.players[state.currentPlayerIndex];
        btn('碰撞', 'danger', () => this.callbacks.onConfirm(), player.hasCollidedThisTurn);
        btn('结束回合', 'primary', () => this.callbacks.onEndTurn());
        break;
      }
      case 'selectCollisionPayment':
        btn(`确认支付 (${mode.totalEnergy})`, 'confirm', () => this.callbacks.onConfirm(), mode.totalEnergy === 0);
        btn('取消', '', () => this.callbacks.onCancel());
        break;
      case 'selectCollisionAttacker':
      case 'selectCollisionTarget':
        btn('取消碰撞', '', () => this.callbacks.onCancel()); break;
      case 'mulligan':
        btn('确认', 'confirm', () => this.callbacks.onConfirm()); break;
      case 'selectSettleCards':
        btn('确认', 'confirm', () => this.callbacks.onConfirm(), mode.selectedSlots.length !== mode.count); break;
      case 'selectDiscardCards':
        btn('确认', 'confirm', () => this.callbacks.onConfirm(), mode.selectedCardIds.length !== mode.count); break;
      case 'selectCoreSlot':
      case 'selectWheelSlot':
        btn('取消', '', () => this.callbacks.onCancel()); break;
      case 'gameOver':
        btn('再来一局', 'primary', () => this.callbacks.onRestart()); break;
    }

    // Always append a view log button for mobile drawer toggle (hidden on desktop via CSS)
    btn('查看日志', 'btn-log', () => {
      this.els.logContainer.classList.toggle('show');
    });
  }

  // --- Game log ---

  renderGameLog(logs: GameLogEntry[]): void {
    this.els.gameLog.innerHTML = '';
    const visible = logs.slice(-50);
    for (const entry of visible) this.els.gameLog.appendChild(this.mkLogEl(entry));
    this.els.gameLog.scrollTop = this.els.gameLog.scrollHeight;
  }

  addLog(entry: GameLogEntry): void {
    this.els.gameLog.appendChild(this.mkLogEl(entry));
    this.els.gameLog.scrollTop = this.els.gameLog.scrollHeight;
  }

  private mkLogEl(entry: GameLogEntry): HTMLElement {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.logType}`;
    const tag = entry.playerId
      ? `<span class="log-player ${entry.playerId}">[${entry.playerId === 'player' ? '玩家' : 'AI'}]</span> ` : '';
    div.innerHTML = `${tag}${entry.message}`;
    return div;
  }

  // --- Overlays ---

  showStartScreen(): void {
    this.els.startScreen.style.display = 'flex';
    this.els.gameBoard.style.display = 'none';
    this.els.bottomPanel.style.display = 'none';
    this.els.victoryOverlay.style.display = 'none';
  }

  hideStartScreen(): void {
    this.els.startScreen.style.display = 'none';
    this.els.gameBoard.style.display = 'flex';
    this.els.bottomPanel.style.display = 'flex';
    this.els.victoryOverlay.style.display = 'none';
  }

  showVictory(winner: PlayerId, victoryType: string): void {
    const name = winner === 'player' ? '玩家' : 'AI';
    this.els.victoryOverlay.style.display = 'flex';
    this.els.victoryOverlay.innerHTML = `
      <div class="victory-modal"><h2>游戏结束</h2>
        <div class="winner-label ${winner}">${name} 获胜!</div>
        <div class="victory-type">${VICTORY_NAMES[victoryType] ?? victoryType}</div>
        <button class="btn primary" style="margin-top:16px">再来一局</button></div>`;
    this.els.victoryOverlay.querySelector('button')!
      .addEventListener('click', () => this.callbacks.onRestart());
  }

  // --- Card element factories ---

  private createCardElement(card: Card, faceUp: boolean, extra: string[] = []): HTMLElement {
    const div = document.createElement('div');
    div.className = `card ${faceUp ? 'face-up' : 'face-down'} ${extra.join(' ')}`.trim();
    div.setAttribute('data-card-id', card.id);
    const img = document.createElement('img');
    img.src = faceUp ? getCardImagePath(card) : getCardBackImagePath();
    img.alt = faceUp ? cardDisplayName(card) : 'back';
    img.loading = 'lazy';
    div.appendChild(img);
    return div;
  }

  private createCardBack(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'card face-down';
    const img = document.createElement('img');
    img.src = getCardBackImagePath();
    img.alt = 'back';
    img.loading = 'lazy';
    div.appendChild(img);
    return div;
  }

  private buildFieldCard(wc: WheelCard): HTMLElement {
    const faceUp = wc.state !== 'decel';
    const el = this.createCardElement(wc.card, faceUp, [wc.state]);
    if (faceUp) {
      const badge = document.createElement('div');
      badge.className = 'card-value-badge';
      badge.textContent = String(getCardValue(wc.card));
      el.appendChild(badge);
    }
    return el;
  }

  private mkEl(tag: string, className: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = className;
    return e;
  }
}
