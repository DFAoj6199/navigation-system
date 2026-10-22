import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { createMapScale, pixelsToMeters } from '../lib/scale';
import type { MapImageMeta } from '../types';

/**
 * 阶段4 核心验收：
 *   1. 用人工可计算的折线验证距离公式；
 *   2. 验证比例尺变化后，道路长度与最短路径结果按预期更新。
 */

const META: MapImageMeta = {
  fileName: 'tianhe.png',
  width: 1600,
  height: 1200,
  mimeType: 'image/png',
};

function resetStore() {
  useAppStore.setState({
    image: null,
    imageUrl: null,
    imageWidth: 0,
    imageHeight: 0,
    nodes: [],
    roads: [],
    selectedNodeId: null,
    selectedRoadId: null,
    camera: { zoom: 1, offsetX: 0, offsetY: 0 },
    viewInitialized: false,
    draft: null,
    notices: [],
    startNodeId: '',
    endNodeId: '',
    scale: null,
    scalePointA: null,
    scalePointB: null,
    scalePicking: false,
    scaleNextPoint: 'a',
  });
}

/** 在 (x,y) 添加节点并返回 id */
function addNode(x: number, y: number, name: string) {
  const r = useAppStore.getState().addNodeAtPixel(x, y, name);
  if (!r.ok || !r.node) throw new Error(r.error ?? '添加节点失败');
  return r.node.id;
}

/** 直接建路（用 store 的草稿流程，不走 UI） */
function buildRoad(fromId: string, toId: string, mids: { x: number; y: number }[] = []) {
  const started = useAppStore.getState().startRoadDraft(fromId, toId);
  if (!started.ok) throw new Error(started.error ?? '开始绘制失败');
  for (const m of mids) {
    const r = useAppStore.getState().addDraftPoint(m.x, m.y);
    if (!r.ok) throw new Error(r.error ?? '添加中间点失败');
  }
  const done = useAppStore.getState().commitRoadDraft();
  if (!done.ok) throw new Error(done.error ?? '完成绘制失败');
  return done.roadId!;
}

describe('阶段4 - 比例尺与距离估算', () => {
  beforeEach(() => {
    resetStore();
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    useAppStore.getState().setImage(META, 'blob:test');
  });

  // 人工可计算的校准基准：A(0,0) → B(300,400)，像素距离恰为 500
  const CAL_A = { x: 0, y: 0 };
  const CAL_B = { x: 300, y: 400 };

  function calibrate(knownDistance: number, unit: 'm' | 'km') {
    useAppStore.getState().setScalePoint('a', CAL_A);
    useAppStore.getState().setScalePoint('b', CAL_B);
    const r = useAppStore.getState().applyScale(knownDistance, unit);
    if (!r.ok) throw new Error(r.error);
    return r.scale;
  }

  it('校准 500 米 / 500 像素 → 系数 1 米每像素，并保存到项目状态', () => {
    const scale = calibrate(500, 'm');
    expect(scale.metersPerPixel).toBeCloseTo(1, 9);
    expect(useAppStore.getState().scale?.metersPerPixel).toBeCloseTo(1, 9);
    expect(useAppStore.getState().toProject()?.scale?.metersPerPixel).toBeCloseTo(1, 9);
  });

  it('未校准时长度只按像素返回，不把像素冒充为米', () => {
    const a = addNode(0, 0, 'A');
    const b = addNode(600, 0, 'B');
    buildRoad(a, b);
    useAppStore.getState().setStartNodeId(a);
    useAppStore.getState().setEndNodeId(b);
    useAppStore.getState().runSearch();

    const search = useAppStore.getState().search;
    expect(search.shortest?.length).toBeCloseTo(600, 9);
    expect(search.shortest?.meters).toBeNull();
    expect(search.simple?.paths[0].meters).toBeNull();
  });

  it('人工折线：4 段各 √(100²+200²) 累加 = 894.427 像素 → 894.4 米', () => {
    calibrate(500, 'm'); // 1 米/像素
    const a = addNode(100, 100, 'A');
    const b = addNode(700, 100, 'B');
    buildRoad(a, b, [
      { x: 200, y: 300 },
      { x: 400, y: 400 },
      { x: 600, y: 300 },
    ]);
    useAppStore.getState().setStartNodeId(a);
    useAppStore.getState().setEndNodeId(b);
    useAppStore.getState().runSearch();

    const path = useAppStore.getState().search.shortest!;
    // 人工推导：4 × 223.6068 = 894.4272
    expect(path.length).toBeCloseTo(894.4272, 3);
    expect(path.meters).toBeCloseTo(894.4272, 3);
  });

  it('比例尺变化后道路实际长度按比例更新（1 米/px → 2 米/px）', () => {
    const a = addNode(0, 0, 'A');
    const b = addNode(600, 0, 'B');
    buildRoad(a, b);
    useAppStore.getState().setStartNodeId(a);
    useAppStore.getState().setEndNodeId(b);

    calibrate(500, 'm'); // 1 m/px
    useAppStore.getState().runSearch();
    const first = useAppStore.getState().search.shortest!;
    expect(first.length).toBeCloseTo(600, 9);
    expect(first.meters).toBeCloseTo(600, 9);

    // 改为 1000 米 / 500 像素 = 2 m/px
    calibrate(1000, 'm');
    useAppStore.getState().runSearch();
    const second = useAppStore.getState().search.shortest!;
    expect(second.length).toBeCloseTo(600, 9); // 像素长度不变
    expect(second.meters).toBeCloseTo(1200, 9); // 实际距离翻倍
    expect(second.meters! / first.meters!).toBeCloseTo(2, 12);
  });

  it('比例尺变化后最短路径的“选择结果”随之一致变化', () => {
    // 两条 A->C 的路线：
    //   路线1 A->B->C：300 + 300 = 600 像素
    //   路线2 A->D（C 与 D 坐标相同，便于两条路线汇于同一点）：
    //        折线 A(0,0)->(0,900)->(600,900)->D(600,0) = 900+600+900 = 2400 像素
    // 因为“米 = 像素 × 正系数”是严格线性的单调变换，比例的取值不会改变两条路线的
    // 长短排序，所以最短路径的节点序列在任意校准下都必须相同，只有米数按比例缩放。
    const A = addNode(0, 0, 'A');
    const B = addNode(300, 0, 'B');
    const C = addNode(600, 0, 'C');
    const D = addNode(600, 0, 'D');

    // A->B->C：300 + 300 = 600 像素
    buildRoad(A, B);
    buildRoad(B, C);
    // A->D 绕行折线：远大于 600 像素
    buildRoad(A, D, [{ x: 0, y: 900 }, { x: 600, y: 900 }]);

    useAppStore.getState().setStartNodeId(A);
    useAppStore.getState().setEndNodeId(C);

    calibrate(500, 'm'); // 1 m/px
    useAppStore.getState().runSearch();
    const p1 = useAppStore.getState().search.shortest!;
    expect(p1.nodeIds).toEqual([A, B, C]);
    expect(p1.meters).toBeCloseTo(600, 9);

    calibrate(50, 'm'); // 0.1 m/px
    useAppStore.getState().runSearch();
    const p2 = useAppStore.getState().search.shortest!;
    // 选择结果不变，但实际距离按 0.1 缩放
    expect(p2.nodeIds).toEqual([A, B, C]);
    expect(p2.meters).toBeCloseTo(60, 9);
    expect(p2.meters! / p1.meters!).toBeCloseTo(0.1, 12);
  });

  it('比例尺不改变像素长度与路径数量', () => {
    const A = addNode(0, 0, 'A');
    const B = addNode(300, 0, 'B');
    const C = addNode(150, 200, 'C');
    buildRoad(A, B);
    buildRoad(A, C);
    buildRoad(C, B);
    useAppStore.getState().setStartNodeId(A);
    useAppStore.getState().setEndNodeId(B);

    calibrate(500, 'm');
    useAppStore.getState().runSearch();
    const s1 = useAppStore.getState().search.simple!;
    const px1 = s1.paths.map((p) => p.length);

    calibrate(5000, 'km');
    useAppStore.getState().runSearch();
    const s2 = useAppStore.getState().search.simple!;
    const px2 = s2.paths.map((p) => p.length);

    expect(s2.paths).toHaveLength(s1.paths.length);
    expect(px2).toEqual(px1);
  });

  it('校准后修改比例尺会使旧搜索结果失效', () => {
    const A = addNode(0, 0, 'A');
    const B = addNode(100, 0, 'B');
    buildRoad(A, B);
    useAppStore.getState().setStartNodeId(A);
    useAppStore.getState().setEndNodeId(B);
    calibrate(500, 'm');
    useAppStore.getState().runSearch();
    expect(useAppStore.getState().search.status).toBe('found');

    calibrate(1000, 'm');
    expect(useAppStore.getState().search.status).toBe('idle');
  });

  it('清除比例尺后长度回到像素且 meters 为 null', () => {
    const A = addNode(0, 0, 'A');
    const B = addNode(100, 0, 'B');
    buildRoad(A, B);
    calibrate(500, 'm');
    expect(useAppStore.getState().scale).not.toBeNull();

    useAppStore.getState().clearScale();
    expect(useAppStore.getState().scale).toBeNull();

    useAppStore.getState().setStartNodeId(A);
    useAppStore.getState().setEndNodeId(B);
    useAppStore.getState().runSearch();
    expect(useAppStore.getState().search.shortest?.meters).toBeNull();
  });

  it('更换底图会清除比例尺（旧比例尺对新图无意义）', () => {
    calibrate(500, 'm');
    expect(useAppStore.getState().scale).not.toBeNull();
    useAppStore.getState().setImage({ ...META, width: 2000 }, 'blob:test2');
    expect(useAppStore.getState().scale).toBeNull();
    expect(useAppStore.getState().scalePointA).toBeNull();
  });

  it('缩放/拖动相机不影响已保存的比例尺与长度', () => {
    const A = addNode(0, 0, 'A');
    const B = addNode(600, 0, 'B');
    buildRoad(A, B);
    const scale = calibrate(500, 'm');
    const before = scale.metersPerPixel;

    // 模拟用户反复缩放拖动（只改相机状态）
    useAppStore.getState().setCamera({ zoom: 3.7, offsetX: -820, offsetY: 145 });
    useAppStore.getState().setCamera({ zoom: 0.12, offsetX: 40, offsetY: -900 });

    const after = useAppStore.getState().scale!;
    expect(after.metersPerPixel).toBe(before);
    expect(after.pixelDistance).toBe(scale.pixelDistance);

    useAppStore.getState().setStartNodeId(A);
    useAppStore.getState().setEndNodeId(B);
    useAppStore.getState().runSearch();
    expect(useAppStore.getState().search.shortest?.meters).toBeCloseTo(600, 9);
  });

  it('非法输入被拒绝且不产生比例尺', () => {
    useAppStore.getState().setScalePoint('a', CAL_A);
    useAppStore.getState().setScalePoint('b', CAL_B);
    const r = useAppStore.getState().applyScale(0, 'm');
    expect(r.ok).toBe(false);
    expect(useAppStore.getState().scale).toBeNull();
  });

  it('未选择两个校准点时不能应用校准', () => {
    useAppStore.getState().setScalePoint('a', CAL_A);
    const r = useAppStore.getState().applyScale(500, 'm');
    expect(r.ok).toBe(false);
    expect(useAppStore.getState().scale).toBeNull();
  });

  it('应用校准后退出点选模式', () => {
    useAppStore.getState().setScalePicking(true);
    calibrate(500, 'm');
    expect(useAppStore.getState().scalePicking).toBe(false);
  });
});

describe('阶段4 - 单位换算与格式化（人工核对）', () => {
  it('千米输入等价于对应米数', () => {
    const r1 = createMapScale({ x: 0, y: 0 }, { x: 500, y: 0 }, 2, 'km', 1600, 1200);
    if (!r1.ok) throw new Error('应成功');
    // 2000 米 / 500 像素 = 4 米/像素
    expect(r1.scale.metersPerPixel).toBeCloseTo(4, 9);
  });

  it('像素→米换算：600 px × 2 m/px = 1200 m', () => {
    const r = createMapScale({ x: 0, y: 0 }, { x: 300, y: 400 }, 1, 'km', 1600, 1200);
    if (!r.ok) throw new Error('应成功');
    // 1000 米 / 500 像素 = 2 米/像素
    expect(pixelsToMeters(600, r.scale)).toBeCloseTo(1200, 9);
  });
});
