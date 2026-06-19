// =============================================================================
// main.ts — Application entry point for Accelerated World
// =============================================================================

import './styles/index.css';
import { GameController } from './controllers/GameController';
import { setLogLevel } from './logger';

// Set log level based on environment
setLogLevel(import.meta.env.DEV ? 'debug' : 'info');

// Initialize the game
const root = document.getElementById('app');
if (!root) throw new Error('Root element #app not found');

new GameController(root);
