import { App } from './ui/app';
import { renderSetup } from './ui/setup';
import type { GameConfig } from './game/types';
import './styles.css';

const root = document.getElementById('app')!;
let app: App | null = null;

function showSetup(): void {
  app?.destroy();
  app = null;
  renderSetup(root, startGame);
}

function startGame(config: GameConfig): void {
  app?.destroy();
  app = new App(root, config, showSetup);
}

showSetup();
