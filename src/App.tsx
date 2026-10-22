import { useState } from 'react';
import { MapUploader } from './components/MapUploader';
import { MapViewport } from './components/MapViewport';
import type { MapMode } from './components/MapViewport';
import { NodeAddPanel } from './components/NodeAddPanel';
import { NodeList } from './components/NodeList';
import { RoadPanel } from './components/RoadPanel';
import { PathPanel } from './components/PathPanel';
import { NoticeBar } from './components/NoticeBar';
import { useAppStore } from './store/useAppStore';
import styles from './App.module.css';

/** 页面管理区域：普通查看 / 节点管理 / 道路管理 / 路径搜索 */
export type ManageTab = 'view' | 'nodes' | 'roads' | 'paths';

export default function App() {
  const [mode, setMode] = useState<MapMode>('pan');
  const [tab, setTab] = useState<ManageTab>('view');
  const image = useAppStore((s) => s.image);
  const nodeCount = useAppStore((s) => s.nodes.length);
  const roadCount = useAppStore((s) => s.roads.length);
  const draft = useAppStore((s) => s.draft);

  // 切换管理页签时退出绘制模式，避免误点添加中间点
  const changeTab = (next: ManageTab) => {
    setTab(next);
    if (mode === 'draw' && next !== 'roads') setMode('pan');
  };

  const showLists = tab !== 'view';

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>天河体育中心周边地图可视化导航系统</h1>
          <p className={styles.subtitle}>阶段 3 · 简单路径与最短路径搜索</p>
        </div>
        <div className={styles.badgeGroup}>
          <span className={[styles.badge, image ? styles.badgeOk : styles.badgeMuted].join(' ')}>
            {image ? '底图已加载' : '未加载底图'}
          </span>
          <span className={[styles.badge, styles.badgeMuted].join(' ')}>节点 {nodeCount}</span>
          <span className={[styles.badge, styles.badgeMuted].join(' ')}>道路 {roadCount}</span>
        </div>
      </header>

      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.tabs} role="tablist" aria-label="管理模式">
            {(
              [
                { key: 'view', label: '查看模式' },
                { key: 'nodes', label: '节点管理' },
                { key: 'roads', label: '道路管理' },
                { key: 'paths', label: '路径搜索' },
              ] as Array<{ key: ManageTab; label: string }>
            ).map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={[styles.tab, tab === item.key ? styles.tabActive : ''].join(' ')}
                onClick={() => changeTab(item.key)}
                data-testid={`tab-${item.key}`}
              >
                {item.label}
              </button>
            ))}
          </div>

          {showLists && (
            <details
              className={styles.collapsible}
              // 道路管理页签默认收起上传区，把纵向空间让给道路列表；
              // 节点管理页签保持展开（上传是节点编辑的前置操作）。
              open={tab === 'nodes'}
              data-testid="uploader-details"
            >
              <summary data-testid="uploader-summary">底图上传 / 更换</summary>
              <div className={styles.collapsibleBody}>
                <MapUploader />
              </div>
            </details>
          )}
          {tab === 'nodes' && <NodeAddPanel />}
          {tab === 'nodes' && <NodeList />}
          {tab === 'roads' && <RoadPanel mode={mode} setMode={setMode} />}
          {tab === 'paths' && <PathPanel />}
          {tab === 'view' && (
            <div className={styles.viewInfo} data-testid="view-mode-info">
              <p>当前为查看模式，节点与道路管理列表已隐藏。</p>
              <p>可拖动平移、滚轮缩放；点击节点或道路可查看其信息。</p>
            </div>
          )}
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
            <button
              type="button"
              className={[styles.modeButton, mode === 'draw' ? styles.modeActive : ''].join(' ')}
              onClick={() => setMode('draw')}
              disabled={!draft}
              data-testid="mode-draw"
              aria-pressed={mode === 'draw'}
              title={draft ? '在地图上点击添加道路中间点' : '请先在“道路管理”中选择端点并点击“绘制道路”'}
            >
              绘制道路
            </button>
            <span className={styles.modeTip}>
              {mode === 'pan'
                ? '拖动平移、滚轮缩放；点击节点/道路可选中，拖动白色圆点可编辑中间点'
                : mode === 'add'
                  ? '在地图上单击即可添加节点，坐标自动按原始像素计算'
                  : '在道路上连续单击添加中间点，完成后在“道路管理”点“完成绘制”'}
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
