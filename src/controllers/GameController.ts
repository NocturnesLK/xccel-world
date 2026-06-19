// =============================================================================
// GameController.ts — Game flow orchestrator for Accelerated World
// =============================================================================

import {
  GameState, GameAction, GameLogEntry, InteractionMode,
  ActionResult, cloneState,
} from '../models/types';
import {
  getDriveCount, getSpeedCount, MAX_HAND_SIZE,
} from '../models/Card';
import {
  setupGame, executeMulligan, executeSelectInitialSpeed,
  executeDrawPhase, executeUpdate, executeAccel, executeRecover,
  executeStartCollision, executeCollisionAttack, executeSettlePhase,
  executeSettleDeceleration, executeDiscard, executeEndTurn,
  isOverloadActive, getValidAttackers,
} from '../engine/RulesEngine';
import {
  decideMulligan, decideInitialSpeed, decidePlayAction,
  decideDiscard, decideSettleDeceleration, decideCollisionAttacker,
} from '../controllers/AIController';
import { UIManager } from '../views/UIManager';
import { createLogger } from '../logger';

const log = createLogger('GameCtrl');

const AI_DELAY = 800;  // ms delay for AI actions (readability)
const AI_FAST  = 400;

export class GameController {
  private state!: GameState;
  private logs: GameLogEntry[] = [];
  private ui: UIManager;

  constructor(root: HTMLElement) {
    this.ui = new UIManager(root);
    this.ui.setActionHandler((action) => this.handleAction(action));
    this.ui.setStartHandler(() => this.startGame());
    this.ui.setRestartHandler(() => this.startGame());
    this.ui.showStartScreen();
    log.info('GameController initialised');
  }

  // =========================================================================
  // Game lifecycle
  // =========================================================================

  private startGame(): void {
    log.info('Starting new game');
    this.state = setupGame();
    this.logs = [];
    this.addLog({ turnNumber: 0, playerId: null, message: '游戏初始化完成', logType: 'system', timestamp: Date.now() });
    this.addLog({ turnNumber: 0, playerId: null, message: '—— 换牌阶段 ——', logType: 'phase', timestamp: Date.now() });
    this.updateUI({ type: 'mulligan' });

    // If AI goes first for mulligan (currentPlayerIndex is 0 = player first)
    if (this.state.currentPlayerIndex === 1) {
      this.scheduleAI();
    }
  }

  // =========================================================================
  // Action handler (from UI)
  // =========================================================================

  private handleAction(action: GameAction): void {
    log.info(`Action received: ${action.type}`);

    const result = this.executeAction(action);
    if (!result) return;

    this.applyResult(result);
    this.afterAction();
  }

  private executeAction(action: GameAction): ActionResult | null {
    switch (action.type) {
      case 'mulligan':
        return executeMulligan(this.state, action);
      case 'selectInitialSpeed':
        return executeSelectInitialSpeed(this.state, action);
      case 'update':
        return executeUpdate(this.state, action);
      case 'accel':
        return executeAccel(this.state, action);
      case 'recover':
        return executeRecover(this.state, action);
      case 'startCollision':
        return executeStartCollision(this.state, action);
      case 'collisionAttack':
        return executeCollisionAttack(this.state, action);
      case 'endTurn':
        return executeEndTurn(this.state);
      case 'discard':
        return executeDiscard(this.state, action);
      case 'settleDeceleration':
        return executeSettleDeceleration(this.state, action);
      default:
        log.warn('Unknown action type', (action as GameAction).type);
        return null;
    }
  }

  private applyResult(result: ActionResult): void {
    this.state = result.state;
    for (const entry of result.logs) {
      this.addLog(entry);
    }
  }

  // =========================================================================
  // Post-action flow control
  // =========================================================================

  private afterAction(): void {
    const s = this.state;

    // Game over check
    if (s.phase === 'gameOver') {
      this.updateUI({ type: 'gameOver' });
      this.ui.getRenderer().showVictory(s.winner!, s.victoryType!);
      return;
    }

    // Check if collision is active → need attacker/target selection
    if (s.collisionState) {
      if (isOverloadActive(s) || getValidAttackers(s).length > 0) {
        if (this.isAITurn()) {
          this.scheduleAI();
        } else {
          this.updateUI({
            type: 'selectCollisionAttacker',
            remainingEnergy: s.collisionState.remainingEnergy,
          });
        }
        return;
      }
      // Collision ended naturally
      s.collisionState = null;
    }

    // Phase-specific flow
    switch (s.phase) {
      case 'mulligan':
        if (this.isAITurn()) this.scheduleAI();
        else this.updateUI({ type: 'mulligan' });
        break;

      case 'selectInitialSpeed':
        if (this.isAITurn()) this.scheduleAI();
        else this.updateUI({ type: 'selectInitialSpeed' });
        break;

      case 'draw':
        // Auto-execute draw phase
        this.executeDraw();
        break;

      case 'play':
        if (this.isAITurn()) this.scheduleAI();
        else this.updateUI({ type: 'play' });
        break;

      case 'drawDiscard':
        this.handleDrawDiscard();
        break;

      case 'settle':
        // Settle phase auto-executes
        this.executeSettle();
        break;

      case 'settleDiscard':
        this.handleSettleDiscard();
        break;

      default:
        log.warn('Unexpected phase after action', s.phase);
    }
  }

  // =========================================================================
  // Phase execution
  // =========================================================================

  private executeDraw(): void {
    const result = executeDrawPhase(this.state);
    this.applyResult(result);

    if (this.state.phase === 'gameOver') {
      this.updateUI({ type: 'gameOver' });
      this.ui.getRenderer().showVictory(this.state.winner!, this.state.victoryType!);
      return;
    }

    if (this.state.phase === 'drawDiscard') {
      this.handleDrawDiscard();
      return;
    }

    // phase is now 'play'
    if (this.isAITurn()) {
      this.scheduleAI();
    } else {
      this.updateUI({ type: 'play' });
    }
  }

  private handleDrawDiscard(): void {
    const player = this.state.players[this.state.currentPlayerIndex];
    const excess = player.hand.length - MAX_HAND_SIZE;
    if (excess <= 0) {
      this.state.phase = 'play';
      this.afterAction();
      return;
    }

    if (this.isAITurn()) {
      // AI auto-discards
      const action = decideDiscard(this.state, excess);
      const result = this.executeAction(action);
      if (result) this.applyResult(result);
      this.afterAction();
    } else {
      this.updateUI({
        type: 'selectDiscardCards',
        count: excess,
        selectedCardIds: [],
      });
    }
  }

  private executeSettle(): void {
    const result = executeSettlePhase(this.state);
    this.applyResult(result);
    this.afterAction();
  }

  private handleSettleDiscard(): void {
    const player = this.state.players[this.state.currentPlayerIndex];
    const driveCount = getDriveCount(player);
    const diff = driveCount - player.hand.length;

    if (diff <= 0) {
      // No longer need to decelerate, end turn
      this.state.phase = 'play'; // trick: let afterAction handle endTurn flow
      this.afterAction();
      return;
    }

    if (this.isAITurn()) {
      const action = decideSettleDeceleration(this.state, diff);
      const result = this.executeAction(action);
      if (result) this.applyResult(result);
      this.afterAction();
    } else {
      this.updateUI({
        type: 'selectSettleCards',
        count: diff,
        selectedSlots: [],
      });
    }
  }

  // =========================================================================
  // AI scheduling
  // =========================================================================

  private isAITurn(): boolean {
    return this.state.currentPlayerIndex === 1;
  }

  private scheduleAI(): void {
    this.updateUI({ type: 'waiting' });
    const delay = this.state.collisionState ? AI_FAST : AI_DELAY;
    setTimeout(() => this.executeAITurn(), delay);
  }

  private executeAITurn(): void {
    if (this.state.phase === 'gameOver') return;

    log.debug('AI turn executing', { phase: this.state.phase });

    let action: GameAction;

    switch (this.state.phase) {
      case 'mulligan':
        action = decideMulligan(this.state);
        break;

      case 'selectInitialSpeed':
        action = decideInitialSpeed(this.state);
        break;

      case 'play':
        action = decidePlayAction(this.state);
        break;

      case 'drawDiscard': {
        const excess = this.state.players[1].hand.length - MAX_HAND_SIZE;
        action = decideDiscard(this.state, excess);
        break;
      }

      case 'settleDiscard': {
        const diff = getDriveCount(this.state.players[1]) - this.state.players[1].hand.length;
        action = decideSettleDeceleration(this.state, diff);
        break;
      }

      default:
        // Check if in collision state
        if (this.state.collisionState) {
          action = decideCollisionAttacker(this.state);
          break;
        }
        log.warn('AI has nothing to do in phase', this.state.phase);
        return;
    }

    // For collision: after startCollision, AI needs to pick attacker+target
    const result = this.executeAction(action);
    if (!result) return;
    this.applyResult(result);

    // If AI just started a collision, continue with attacker selection
    if (action.type === 'startCollision' && this.state.collisionState) {
      setTimeout(() => this.aiCollisionLoop(), AI_FAST);
      return;
    }

    // If AI play action was not endTurn, schedule next action
    if (this.state.phase === 'play' && this.isAITurn() && action.type !== 'endTurn') {
      this.scheduleAI();
      return;
    }

    this.afterAction();
  }

  private aiCollisionLoop(): void {
    if (!this.state.collisionState || this.state.phase === 'gameOver') {
      this.afterAction();
      return;
    }

    const attackers = getValidAttackers(this.state);
    if (attackers.length === 0) {
      this.state.collisionState = null;
      // After collision ends, AI continues play phase or endTurn
      if (this.state.phase === 'play' && this.isAITurn()) {
        this.scheduleAI();
      } else {
        this.afterAction();
      }
      return;
    }

    const action = decideCollisionAttacker(this.state);
    const result = this.executeAction(action);
    if (result) this.applyResult(result);

    if (this.state.collisionState) {
      this.updateUI({ type: 'waiting' });
      setTimeout(() => this.aiCollisionLoop(), AI_FAST);
    } else {
      // Collision ended
      if (this.state.phase === 'play' && this.isAITurn()) {
        this.scheduleAI();
      } else {
        this.afterAction();
      }
    }
  }

  // =========================================================================
  // UI helpers
  // =========================================================================

  private updateUI(mode: InteractionMode): void {
    this.ui.updateState(this.state, mode);
    this.ui.getRenderer().renderGameLog(this.logs);
  }

  private addLog(entry: GameLogEntry): void {
    this.logs.push(entry);
  }
}
