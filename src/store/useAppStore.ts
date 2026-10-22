import { create } from 'zustand';
import type { Camera, MapImageMeta, MapNode, MapProject, NodeType, Road } from '../types';
import { createNode, nextNodeName, sortNodes, validateNodeName, validateNodePoint } from '../lib/nodes';

/**
 * 应用状态（阶段1）。
 *
 * 关键设计：相机状态（zoom/offset）与业务数据（节点像素坐标）彻底分离。
 * 任何缩放/拖动/窗口 resize 都不会触碰节点的 point 字段。
 */

export interface Notice {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
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
  /** 阶段1固定为空数组；道路功能属于后续阶段 */
  roads: Road[];

  // ---- 选择与相机 ----
  selectedNodeId: string | null;
  camera: Camera;
  /** 视图是否已经完成过一次“适配窗口”的初始化 */
  viewInitialized: boolean;

  // ---- 提示 ----
  notices: Notice[];

  // ---- 操作 ----
  setImage: (meta: MapImageMeta, objectUrl: string) => void;
  clearImage: () => void;
  setCamera: (camera: Camera) => void;
  markViewInitialized: () => void;

  addNodeAtPixel: (x: number, y: number, name?: string, type?: NodeType) => { ok: boolean; error?: string; node?: MapNode };
  renameNode: (id: string, name: string) => { ok: boolean; error?: string };
  moveNode: (id: string, x: number, y: number) => { ok: boolean; error?: string };
  setNodeType: (id: string, type: NodeType) => void;
  deleteNode: (id: string) => void;
  selectNode: (id: string | null) => void;

  pushNotice: (kind: Notice['kind'], text: string) => void;
  dismissNotice: (id: number) => void;

  /** 导出为可复用的工程数据（阶段1不使用，供后续持久化阶段复用） */
  toProject: () => MapProject | null;
}

let noticeSeq = 0;

export const useAppStore = create<AppState>((set, get) => ({
  image: null,
  imageUrl: null,
  imageWidth: 0,
  imageHeight: 0,
  nodes: [],
  roads: [],
  selectedNodeId: null,
  camera: { zoom: 1, offsetX: 0, offsetY: 0 },
  viewInitialized: false,
  notices: [],

  setImage: (meta, objectUrl) => {
    const previousUrl = get().imageUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    set({
      image: meta,
      imageUrl: objectUrl,
      imageWidth: meta.width,
      imageHeight: meta.height,
      // 换图后旧节点坐标失去意义，明确清空并提示，避免坐标错位
      nodes: [],
      roads: [],
      selectedNodeId: null,
      viewInitialized: false,
      camera: { zoom: 1, offsetX: 0, offsetY: 0 },
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
      selectedNodeId: null,
      viewInitialized: false,
      camera: { zoom: 1, offsetX: 0, offsetY: 0 },
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

  deleteNode: (id) => {
    const { nodes, selectedNodeId } = get();
    set({
      nodes: nodes.filter((node) => node.id !== id),
      selectedNodeId: selectedNodeId === id ? null : selectedNodeId,
    });
  },

  selectNode: (id) => set({ selectedNodeId: id }),

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
