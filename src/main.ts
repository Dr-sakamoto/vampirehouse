import { App } from './ui/app';
import { renderSetup } from './ui/setup';
import type { GameConfig } from './game/types';
import './styles.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // オフライン対応が使えないだけなので、ゲーム自体は続行する
    });
  });
}

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
