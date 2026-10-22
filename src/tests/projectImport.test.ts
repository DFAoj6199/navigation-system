import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../store/useAppStore';
import { buildProjectFile, parseProjectText } from '../lib/projectIO';
import { serializeProject } from '../lib/project';
import type { MapImageMeta } from '../types';

/**
 * 阶段6：导入项目到 store 的行为。
 *
 * 关键约束：
 *   - 导入是“整份替换”，不会残留旧项目的搜索结果或选择状态；
 *   - 未内嵌图片时仍保留节点与道路，但底图为空（由界面提示重新选图）；
 *   - 导入后的数据与节点/道路/比例尺保持一致。
 */

const META: MapImageMeta = {
  fileName: 'tianhe.png',
  width: 1600,
  height: 1200,
  mimeType: 'image/png',
};

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function reset() {
  useAppStore.setState({
    image: null,
    imageUrl: null,
    imageWidth: 0,
    imageHeight: 0,
    imageFile: null,
    imageDataUrl: null,
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
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
}

/** 构造一个“已经建好图、算过路径”的当前项目 */
function buildCurrentProject() {
  reset();
  useAppStore.getState().setImage(META, 'blob:test');
  const A = useAppStore.getState().addNodeAtPixel(100, 100, 'A').node!.id;
  const B = useAppStore.getState().addNodeAtPixel(500, 100, 'B').node!.id;
  useAppStore.getState().startRoadDraft(A, B);
  useAppStore.getState().addDraftPoint(300, 200);
  useAppStore.getState().commitRoadDraft();
  useAppStore.getState().setStartNodeId(A);
  useAppStore.getState().setEndNodeId(B);
  useAppStore.getState().runSearch();
  return { A, B };
}

/** 构造一份导出的项目文件 */
function exportCurrent() {
  const s = useAppStore.getState();
  return buildProjectFile({
    image: s.image!,
    imageDataUrl: DATA_URL,
    nodes: s.nodes,
    roads: s.roads,
    scale: s.scale,
    searchLimits: s.searchLimits,
  });
}

describe('阶段6 - 导入到 store', () => {
  beforeEach(reset);

  it('导入后节点、道路、比例尺与文件一致', () => {
    buildCurrentProject();
    const file = exportCurrent();
    const text = serializeProject(file);

    reset();
    const parsed = parseProjectText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    useAppStore.getState().importProject({
      image: {
        fileName: parsed.project.image.fileName,
        width: parsed.project.image.width,
        height: parsed.project.image.height,
        mimeType: parsed.project.image.mimeType,
      },
      imageDataUrl: parsed.project.image.dataUrl,
      objectUrl: parsed.project.image.dataUrl,
      nodes: parsed.project.nodes,
      roads: parsed.project.roads,
      scale: parsed.project.scale,
    });

    const after = useAppStore.getState();
    expect(after.nodes).toHaveLength(2);
    expect(after.roads).toHaveLength(1);
    expect(after.roads[0].points).toEqual([{ x: 300, y: 200 }]);
    expect(after.image?.fileName).toBe('tianhe.png');
    expect(after.imageWidth).toBe(1600);
    expect(after.imageHeight).toBe(1200);
    expect(after.imageUrl).toBe(DATA_URL);
  });

  it('导入会清空旧项目的搜索结果与起终点', () => {
    const { A, B } = buildCurrentProject();
    expect(useAppStore.getState().search.status).toBe('found');

    const file = exportCurrent();
    // 换成一份内容不同的项目
    file.nodes = file.nodes.filter((n) => n.id !== B);
    file.roads = [];
    file.scale = null;

    useAppStore.getState().importProject({
      image: { fileName: 'other.png', width: 800, height: 600, mimeType: 'image/png' },
      imageDataUrl: DATA_URL,
      objectUrl: DATA_URL,
      nodes: file.nodes,
      roads: file.roads,
      scale: null,
    });

    const after = useAppStore.getState();
    expect(after.search.status).toBe('idle');
    expect(after.search.simple).toBeNull();
    expect(after.search.shortest).toBeNull();
    expect(after.search.highlightedRoadIds).toEqual([]);
    expect(after.startNodeId).toBe('');
    expect(after.endNodeId).toBe('');
    expect(after.selectedNodeId).toBeNull();
    expect(after.selectedRoadId).toBeNull();
    // 旧项目的 B 节点不应残留
    expect(after.nodes.map((n) => n.id)).not.toContain(B);
    // A 仍然存在
    expect(after.nodes.map((n) => n.id)).toContain(A);
  });

  it('未内嵌图片时保留节点与道路，但底图为空', () => {
    buildCurrentProject();
    const file = exportCurrent();
    file.image.dataUrl = null;

    useAppStore.getState().importProject({
      image: {
        fileName: file.image.fileName,
        width: file.image.width,
        height: file.image.height,
        mimeType: file.image.mimeType,
      },
      imageDataUrl: null,
      objectUrl: null,
      nodes: file.nodes,
      roads: file.roads,
      scale: null,
    });

    const after = useAppStore.getState();
    expect(after.imageUrl).toBeNull();
    expect(after.imageDataUrl).toBeNull();
    expect(after.nodes).toHaveLength(2);
    expect(after.roads).toHaveLength(1);
    expect(after.image?.width).toBe(1600);
  });

  it('导入的比例尺生效，随后可正常计算实际距离', () => {
    reset();
    useAppStore.getState().importProject({
      image: { fileName: 'x.png', width: 1600, height: 1200, mimeType: 'image/png' },
      imageDataUrl: DATA_URL,
      objectUrl: DATA_URL,
      nodes: [
        { id: 'a', name: 'A', point: { x: 0, y: 0 }, type: 'junction', createdAt: 't1' },
        { id: 'b', name: 'B', point: { x: 1000, y: 0 }, type: 'junction', createdAt: 't2' },
      ],
      roads: [
        { id: 'r', fromNodeId: 'a', toNodeId: 'b', points: [], createdAt: 't3' },
      ],
      scale: {
        a: { x: 0, y: 0 },
        b: { x: 100, y: 0 },
        knownDistance: 100,
        unit: 'm',
        knownDistanceMeters: 100,
        pixelDistance: 100,
        metersPerPixel: 1,
        calibratedAt: 't4',
      },
    });

    const after = useAppStore.getState();
    expect(after.scale?.metersPerPixel).toBe(1);
    expect(after.scalePointA).toBeNull();
    expect(after.scalePointB).toBeNull();
    expect(after.scalePicking).toBe(false);

    // 用导入的数据直接搜索，距离应以米显示
    useAppStore.getState().setStartNodeId('a');
    useAppStore.getState().setEndNodeId('b');
    useAppStore.getState().runSearch();
    const shortest = useAppStore.getState().search.shortest;
    expect(shortest).not.toBeNull();
    expect(shortest!.length).toBeCloseTo(1000, 6);
    expect(shortest!.meters).toBeCloseTo(1000, 6);
  });

  it('导入后再次导出，节点与道路保持一致（导入导出闭环）', () => {
    buildCurrentProject();
    const first = exportCurrent();
    const text1 = serializeProject(first);

    reset();
    const parsed = parseProjectText(text1);
    if (!parsed.ok) throw new Error('解析应成功');
    useAppStore.getState().importProject({
      image: {
        fileName: parsed.project.image.fileName,
        width: parsed.project.image.width,
        height: parsed.project.image.height,
        mimeType: parsed.project.image.mimeType,
      },
      imageDataUrl: parsed.project.image.dataUrl,
      objectUrl: parsed.project.image.dataUrl,
      nodes: parsed.project.nodes,
      roads: parsed.project.roads,
      scale: parsed.project.scale,
    });

    const second = exportCurrent();
    expect(second.nodes).toEqual(first.nodes);
    expect(second.roads).toEqual(first.roads);
    expect(second.image).toEqual(first.image);
  });

  it('导入不会破坏原有数据一致性：道路端点都能在节点中找到', () => {
    reset();
    useAppStore.getState().importProject({
      image: { fileName: 'x.png', width: 1600, height: 1200, mimeType: 'image/png' },
      imageDataUrl: null,
      objectUrl: null,
      nodes: [
        { id: 'a', name: 'A', point: { x: 10, y: 10 }, type: 'junction', createdAt: 't' },
        { id: 'b', name: 'B', point: { x: 20, y: 20 }, type: 'junction', createdAt: 't' },
      ],
      roads: [{ id: 'r', fromNodeId: 'a', toNodeId: 'b', points: [{ x: 15, y: 15 }], createdAt: 't' }],
      scale: null,
    });
    const { nodes, roads } = useAppStore.getState();
    for (const road of roads) {
      expect(nodes.some((n) => n.id === road.fromNodeId)).toBe(true);
      expect(nodes.some((n) => n.id === road.toNodeId)).toBe(true);
    }
    // 折线端点由节点实时提供，可正确构造
    expect(useAppStore.getState().toProject()).not.toBeNull();
  });
});

describe('阶段6 - 删除操作对搜索结果的影响', () => {
  beforeEach(reset);

  it('删除道路后搜索结果被清除（不残留过期结果）', () => {
    buildCurrentProject();
    expect(useAppStore.getState().search.status).toBe('found');
    const roadId = useAppStore.getState().roads[0].id;

    useAppStore.getState().deleteRoad(roadId);

    const after = useAppStore.getState();
    expect(after.roads).toHaveLength(0);
    expect(after.search.status).toBe('idle');
    expect(after.search.simple).toBeNull();
    expect(after.search.shortest).toBeNull();
    expect(after.search.highlightedRoadIds).toEqual([]);
  });

  it('删除节点时关联道路一并删除，搜索结果被清除', () => {
    const { B } = buildCurrentProject();
    const res = useAppStore.getState().deleteNode(B);

    expect(res.ok).toBe(true);
    expect(res.removedRoads).toBe(1);
    const after = useAppStore.getState();
    expect(after.roads).toHaveLength(0);
    expect(after.nodes).toHaveLength(1);
    expect(after.search.status).toBe('idle');
  });
});
