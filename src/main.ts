import './styles/base.css';
import { SceneApp } from './app/SceneApp';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('Missing #app container.');

const app = new SceneApp(container);

if (import.meta.env.DEV) {
  (window as Window & { __THREE_CHINA_TERRAIN__?: SceneApp }).__THREE_CHINA_TERRAIN__ = app;
}

try {
  await app.initialize();
} catch (error) {
  console.error(error);
  const loading = document.querySelector<HTMLElement>('#loading');
  if (loading) {
    loading.textContent = error instanceof Error ? error.message : '场景初始化失败';
    loading.classList.add('is-error');
  }
}

window.addEventListener('beforeunload', () => app.dispose(), { once: true });
