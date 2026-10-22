import { create } from 'zustand';
import type { Camera, MapImageMeta, MapNode, MapProject, NodeType, PixelPoint, Road } from '../types';
import { createNode, nextNodeName, sortNodes, validateNodeName, validateNodePoint } from '../lib/nodes';
import {
  buildRoadPolyline,
  createRoad,
  isPointInside,
  isSameNodePair,
  roadsAffectedByNodeDeletion,
  validateNewRoad,
} from '../lib/roads';

/**
 * 应用状态（阶段2：地图显示 + 节点管理 + 双向道路管理）。
 *
 * 关键设计：
 *   1. 相机状态（zoom/offset）与业务数据（节点/道路的像素坐标）彻底分离；
 *   2. 道路只保存中间点，端点由节点实时提供，节点移动时折线自动跟随；
 *   3. 删除节点时同步删除关联道路，绝不留悬空引用。
 */

export interface Notice {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
}

/** 道路绘制会话：尚未落库的“草稿” */
export interface RoadDraft {
  /** 起点节点 id */
  fromNodeId: string;
  /** 终点节点 id */
  toNodeId: string;
  /** 已点击的中间点（原图像素坐标） */
  points: PixelPoint[];
  /** 正在编辑的道路 id；为空表示新建 */
  editingRoadId?: string;
}

interface AppState {
  // ---- 底图 ----
  image: MapImageMeta | null;
  imageUrl: string | null;
  /** 图片原始像素尺寸，未加载时为 0 */
  imageWidth: number;
  imageHeight: number;

  // ---- 业务数据 ----
  nodes: MapNode[];
  roads: Road[];

  // ---- 选择与相机 ----
  selectedNodeId: string | null;
  selectedRoadId: string | null;
  camera: Camera;
  /** 视图是否已经完成过一次“适配窗口”的初始化 */
  viewInitialized: boolean;

  // ---- 道路绘制 ----
  /** 当前绘制草稿；null 表示不在绘制中 */
  draft: RoadDraft | null;

  // ---- 提示 ----
  notices: Notice[];

  // ---- 底图操作 ----
  setImage: (meta: MapImageMeta, objectUrl: string) => void;
  clearImage: () => void;
  setCamera: (camera: Camera) => void;
  markViewInitialized: () => void;

  // ---- 节点操作 ----
  addNodeAtPixel: (x: number, y: number, name?: string, type?: NodeType) => { ok: boolean; error?: string; node?: MapNode };
  renameNode: (id: string, name: string) => { ok: boolean; error?: string };
  moveNode: (id: string, x: number, y: number) => { ok: boolean; error?: string };
  setNodeType: (id: string, type: NodeType) => void;
  deleteNode: (id: string) => { ok: boolean; removedRoads: number; error?: string };
  selectNode: (id: string | null) => void;

  // ---- 道路操作 ----
  startRoadDraft: (fromNodeId: string, toNodeId: string) => { ok: boolean; error?: string };
  startRedrawRoad: (roadId: string) => { ok: boolean; error?: string };
  addDraftPoint: (x: number, y: number) => { ok: boolean; error?: string };
  updateDraftPoint: (index: number, x: number, y: number) => { ok: boolean; error?: string };
  removeDraftPoint: (index: number) => void;
  clearDraftPoints: () => void;
  /** 撤销最近添加的一个中间点 */
  undoDraftPoint: () => void;
  commitRoadDraft: () => { ok: boolean; error?: string; roadId?: string; replaced?: boolean };
  cancelRoadDraft: () => void;

  renameRoad: (id: string, name: string) => { ok: boolean; error?: string };
  deleteRoad: (id: string) => void;
  selectRoad: (id: string | null) => void;
  /** 拖动编辑已存在道路的中间点 */
  updateRoadPoint: (roadId: string, index: number, x: number, y: number) => { ok: boolean; error?: string };

  pushNotice: (kind: Notice['kind'], text: string) => void;
  dismissNotice: (id: number) => void;

  /** 导出为可复用的工程数据（阶段2用于测试与后续持久化） */
  toProject: () => MapProject | null;
}

let noticeSeq = 0;

const initialView = {
  selectedNodeId: null,
  selectedRoadId: null,
  camera: { zoom: 1, offsetX: 0, offsetY: 0 },
  viewInitialized: false,
  draft: null,
} satisfies Partial<AppState>;

export const useAppStore = create<AppState>((set, get) => ({
  image: null,
  imageUrl: null,
  imageWidth: 0,
  imageHeight: 0,
  nodes: [],
  roads: [],
  notices: [],
  ...initialView,

  setImage: (meta, objectUrl) => {
    const previousUrl = get().imageUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    set({
      image: meta,
      imageUrl: objectUrl,
      imageWidth: meta.width,
      imageHeight: meta.height,
      // 换图后旧节点/道路坐标失去意义，明确清空并提示，避免坐标错位
      nodes: [],
      roads: [],
      ...initialView,
      notices: get().notices,
    });
  },

  clearImage: () => {
    const previousUrl = get().imageUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    set({
      image: null,
      imageUrl: null,
      imageWidth: 0,
      imageHeight: 0,
      nodes: [],
      roads: [],
      ...initialView,
      notices: get().notices,
    });
  },

  setCamera: (camera) => set({ camera }),
  markViewInitialized: () => set({ viewInitialized: true }),

  addNodeAtPixel: (x, y, name, type = 'junction') => {
    const { imageWidth, imageHeight, nodes } = get();
    if (!get().image) {
      return { ok: false, error: '请先上传地图图片' };
    }
    const check = validateNodePoint(x, y, imageWidth, imageHeight);
    if (!check.ok) {
      return { ok: false, error: check.error };
    }
    const finalName = (name ?? nextNodeName(nodes)).trim();
    const nameError = validateNodeName(finalName);
    if (nameError) {
      return { ok: false, error: nameError };
    }
    const node = createNode(check.point, finalName, type);
    set({
      nodes: [...nodes, node],
      selectedNodeId: node.id,
    });
    return { ok: true, node };
  },

  renameNode: (id, name) => {
    const nameError = validateNodeName(name);
    if (nameError) return { ok: false, error: nameError };
    const trimmed = name.trim();
    const exists = get().nodes.some((n) => n.id !== id && n.name === trimmed);
    if (exists) {
      return { ok: false, error: `已存在同名节点“${trimmed}”，请换一个名称` };
    }
    set({
      nodes: get().nodes.map((node) => (node.id === id ? { ...node, name: trimmed } : node)),
    });
    return { ok: true };
  },

  moveNode: (id, x, y) => {
    const { imageWidth, imageHeight } = get();
    const check = validateNodePoint(x, y, imageWidth, imageHeight);
    if (!check.ok) return { ok: false, error: check.error };
    set({
      nodes: get().nodes.map((node) =>
        node.id === id ? { ...node, point: check.point } : node,
      ),
    });
    return { ok: true };
  },

  setNodeType: (id, type) => {
    set({
      nodes: get().nodes.map((node) => (node.id === id ? { ...node, type } : node)),
    });
  },

  /**
   * 删除节点。
   * 若该节点还连接着道路，必须一并删除这些道路，避免留下悬空引用。
   * 返回值告知调用方删除了多少条道路，以便给出明确提示。
   */
  deleteNode: (id) => {
    const { nodes, roads, selectedNodeId, selectedRoadId, draft } = get();
    const node = nodes.find((n) => n.id === id);
    if (!node) return { ok: false, removedRoads: 0, error: '节点不存在' };

    const affected = roadsAffectedByNodeDeletion(id, roads);
    const affectedIds = new Set(affected.map((r) => r.id));

    set({
      nodes: nodes.filter((n) => n.id !== id),
      roads: roads.filter((r) => !affectedIds.has(r.id)),
      selectedNodeId: selectedNodeId === id ? null : selectedNodeId,
      selectedRoadId: selectedRoadId && affectedIds.has(selectedRoadId) ? null : selectedRoadId,
      // 若绘制草稿引用了该节点，草稿直接作废
      draft: draft && (draft.fromNodeId === id || draft.toNodeId === id) ? null : draft,
    });
    return { ok: true, removedRoads: affected.length };
  },

  selectNode: (id) => set({ selectedNodeId: id, selectedRoadId: null }),

  // ---------------- 道路 ----------------

  startRoadDraft: (fromNodeId, toNodeId) => {
    const { nodes, roads } = get();
    if (!get().image) return { ok: false, error: '请先上传地图图片' };
    if (!fromNodeId || !toNodeId) return { ok: false, error: '请选择道路的两个端点节点' };
    if (fromNodeId === toNodeId) return { ok: false, error: '道路的两个端点不能是同一个节点' };
    if (!nodes.some((n) => n.id === fromNodeId) || !nodes.some((n) => n.id === toNodeId)) {
      return { ok: false, error: '端点节点不存在，可能已被删除' };
    }
    if (roads.some((r) => isSameNodePair(r, fromNodeId, toNodeId))) {
      return { ok: false, error: '这两个节点之间已存在道路，如需调整请使用“重新绘制”' };
    }
    set({
      draft: { fromNodeId, toNodeId, points: [] },
      selectedRoadId: null,
      selectedNodeId: null,
    });
    return { ok: true };
  },

  startRedrawRoad: (roadId) => {
    const { roads, nodes } = get();
    const road = roads.find((r) => r.id === roadId);
    if (!road) return { ok: false, error: '道路不存在' };
    if (!nodes.some((n) => n.id === road.fromNodeId) || !nodes.some((n) => n.id === road.toNodeId)) {
      return { ok: false, error: '道路端点节点不存在' };
    }
    set({
      draft: {
        fromNodeId: road.fromNodeId,
        toNodeId: road.toNodeId,
        points: [],
        editingRoadId: road.id,
      },
      selectedRoadId: road.id,
      selectedNodeId: null,
    });
    return { ok: true };
  },

  addDraftPoint: (x, y) => {
    const { draft, imageWidth, imageHeight } = get();
    if (!draft) return { ok: false, error: '当前不在道路绘制状态' };
    const point = { x: Math.round(x), y: Math.round(y) };
    if (!isPointInside(point, imageWidth, imageHeight)) {
      return { ok: false, error: `中间点 (${point.x}, ${point.y}) 超出地图范围` };
    }
    set({ draft: { ...draft, points: [...draft.points, point] } });
    return { ok: true };
  },

  updateDraftPoint: (index, x, y) => {
    const { draft, imageWidth, imageHeight } = get();
    if (!draft) return { ok: false, error: '当前不在道路绘制状态' };
    if (index < 0 || index >= draft.points.length) return { ok: false, error: '中间点不存在' };
    const point = { x: Math.round(x), y: Math.round(y) };
    if (!isPointInside(point, imageWidth, imageHeight)) {
      return { ok: false, error: `中间点 (${point.x}, ${point.y}) 超出地图范围` };
    }
    const points = draft.points.map((p, i) => (i === index ? point : p));
    set({ draft: { ...draft, points } });
    return { ok: true };
  },

  removeDraftPoint: (index) => {
    const { draft } = get();
    if (!draft) return;
    set({ draft: { ...draft, points: draft.points.filter((_, i) => i !== index) } });
  },

  clearDraftPoints: () => {
    const { draft } = get();
    if (!draft) return;
    set({ draft: { ...draft, points: [] } });
  },

  undoDraftPoint: () => {
    const { draft } = get();
    if (!draft || draft.points.length === 0) return;
    set({ draft: { ...draft, points: draft.points.slice(0, -1) } });
  },

  /**
   * 完成绘制（落库）。
   * 中间点数量不限（可为 0，表示两端点直连），绝不自动简化为直线。
   */
  commitRoadDraft: () => {
    const { draft, nodes, roads, imageWidth, imageHeight } = get();
    if (!draft) return { ok: false, error: '当前不在道路绘制状态' };

    if (draft.editingRoadId) {
      // 重新绘制：替换原道路的中间点
      const existing = roads.find((r) => r.id === draft.editingRoadId);
      if (!existing) return { ok: false, error: '要重新绘制的道路已不存在' };
      for (let i = 0; i < draft.points.length; i += 1) {
        if (!isPointInside(draft.points[i], imageWidth, imageHeight)) {
          return { ok: false, error: `第 ${i + 1} 个中间点超出地图范围` };
        }
      }
      set({
        roads: roads.map((r) =>
          r.id === existing.id
            ? {
                ...r,
                points: draft.points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
              }
            : r,
        ),
        draft: null,
        selectedRoadId: existing.id,
      });
      return { ok: true, roadId: existing.id, replaced: true };
    }

    const validation = validateNewRoad(
      draft.fromNodeId,
      draft.toNodeId,
      draft.points,
      nodes,
      roads,
      imageWidth,
      imageHeight,
    );
    if (!validation.ok) return { ok: false, error: validation.error };

    const road = createRoad(draft.fromNodeId, draft.toNodeId, draft.points);
    set({
      roads: [...roads, road],
      draft: null,
      selectedRoadId: road.id,
    });
    return { ok: true, roadId: road.id };
  },

  cancelRoadDraft: () => set({ draft: null }),

  renameRoad: (id, name) => {
    const trimmed = name.trim();
    if (trimmed.length > 60) return { ok: false, error: '道路名称不能超过 60 个字符' };
    const exists = get().roads.some((r) => r.id !== id && r.name === trimmed);
    if (trimmed && exists) return { ok: false, error: `已存在同名道路“${trimmed}”，请换一个名称` };
    set({
      roads: get().roads.map((r) => (r.id === id ? { ...r, name: trimmed || undefined } : r)),
    });
    return { ok: true };
  },

  deleteRoad: (id) => {
    const { roads, selectedRoadId, draft } = get();
    set({
      roads: roads.filter((r) => r.id !== id),
      selectedRoadId: selectedRoadId === id ? null : selectedRoadId,
      draft: draft?.editingRoadId === id ? null : draft,
    });
  },

  selectRoad: (id) => set({ selectedRoadId: id, selectedNodeId: null }),

  updateRoadPoint: (roadId, index, x, y) => {
    const { roads, imageWidth, imageHeight } = get();
    const road = roads.find((r) => r.id === roadId);
    if (!road) return { ok: false, error: '道路不存在' };
    if (index < 0 || index >= road.points.length) return { ok: false, error: '中间点不存在' };
    const point = { x: Math.round(x), y: Math.round(y) };
    if (!isPointInside(point, imageWidth, imageHeight)) {
      return { ok: false, error: `中间点 (${point.x}, ${point.y}) 超出地图范围` };
    }
    set({
      roads: roads.map((r) =>
        r.id === roadId
          ? { ...r, points: r.points.map((p, i) => (i === index ? point : p)) }
          : r,
      ),
    });
    return { ok: true };
  },

  // ---------------- 提示 ----------------

  pushNotice: (kind, text) => {
    noticeSeq += 1;
    const notice: Notice = { id: noticeSeq, kind, text };
    set({ notices: [...get().notices, notice] });
    // 成功/信息提示自动消失；错误提示需要用户手动关闭，避免被忽略
    if (kind !== 'error') {
      const id = notice.id;
      window.setTimeout(() => {
        set({ notices: get().notices.filter((n) => n.id !== id) });
      }, 3200);
    }
  },

  dismissNotice: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),

  toProject: () => {
    const { image, nodes, roads } = get();
    if (!image) return null;
    return {
      version: 1,
      image,
      nodes: sortNodes(nodes),
      roads,
    };
  },
}));

/** 便捷选择器：获取某条道路的完整折线（端点由节点实时提供） */
export function selectRoadPolyline(road: Road, nodes: MapNode[]): PixelPoint[] | null {
  const from = nodes.find((n) => n.id === road.fromNodeId);
  const to = nodes.find((n) => n.id === road.toNodeId);
  if (!from || !to) return null;
  return buildRoadPolyline(road, from.point, to.point);
}
