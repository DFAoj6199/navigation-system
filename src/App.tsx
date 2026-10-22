import { useState } from 'react';
import { MapUploader } from './components/MapUploader';
import { MapViewport } from './components/MapViewport';
import { NodeAddPanel } from './components/NodeAddPanel';
import { NodeList } from './components/NodeList';
import { NoticeBar } from './components/NoticeBar';
import { useAppStore } from './store/useAppStore';
import styles from './App.module.css';

export type InteractionMode = 'pan' | 'add';

export default function App() {
  const [mode, setMode] = useState<InteractionMode>('pan');
  const image = useAppStore((s) => s.image);
  const nodeCount = useAppStore((s) => s.nodes.length);

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>天河体育中心周边地图可视化导航系统</h1>
          <p className={styles.subtitle}>阶段 1 · 地图显示与节点管理</p>
        </div>
        <div className={styles.badgeGroup}>
          <span className={[styles.badge, image ? styles.badgeOk : styles.badgeMuted].join(' ')}>
            {image ? '底图已加载' : '未加载底图'}
          </span>
          <span className={[styles.badge, styles.badgeMuted].join(' ')}>节点 {nodeCount}</span>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <MapUploader />
          <NodeAddPanel />
          <NodeList />
        </aside>

        <main className={styles.main}>
          <div className={styles.modeBar} role="group" aria-label="交互模式">
            <span className={styles.modeLabel}>地图模式：</span>
            <button
              type="button"
              className={[styles.modeButton, mode === 'pan' ? styles.modeActive : ''].join(' ')}
              onClick={() => setMode('pan')}
              data-testid="mode-pan"
              aria-pressed={mode === 'pan'}
            >
              拖动 / 浏览
            </button>
            <button
              type="button"
              className={[styles.modeButton, mode === 'add' ? styles.modeActive : ''].join(' ')}
              onClick={() => setMode('add')}
              disabled={!image}
              data-testid="mode-add"
              aria-pressed={mode === 'add'}
              title={image ? '点击地图添加节点' : '请先上传底图'}
            >
              添加节点
            </button>
            <span className={styles.modeTip}>
              {mode === 'pan'
                ? '拖动平移、滚轮缩放；在列表中选中节点可查看其像素坐标'
                : '在地图上单击即可添加节点，坐标自动按原始像素计算'}
            </span>
          </div>

          <div className={styles.viewport}>
            <MapViewport mode={mode} />
          </div>
        </main>
      </div>

      <NoticeBar />
    </div>
  );
}
