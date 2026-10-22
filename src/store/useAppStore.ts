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
import {
  DEFAULT_SEARCH_LIMITS,
  findAllSimplePaths,
  findShortestPath,
  type PathResult,
  type SearchLimits,
} from '../lib/pathfinding';
import {
  createMapScale,
  type MapScale,
  type ScalePoint,
  type ScaleValidationResult,
} from '../lib/scale';

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

/**
 * 寻路结果状态。
 *
 * 关键点：必须区分“完整结果”与“被限制截断的结果”，
 * 绝不把部分结果当作全部路径展示。
 */
export interface SearchState {
  /**
   * 本次搜索的状态：
   * - idle：尚未搜索
   * - no-path：确实不存在任何可通行路径
   * - partial：简单路径搜索被上限截断，尚未完成，既不能断言“无路径”，也不能当作完整结果
   * - found：至少找到一条简单路径
   * - error：搜索无法执行
   */
  status: 'idle' | 'no-path' | 'partial' | 'found' | 'error';
  /** 错误信息 */
  error?: string;
  /** 简单路径结果 */
  simple: {
    paths: PathResult[];
    truncated: boolean;
    truncatedReason?: 'maxResults' | 'maxExpansions';
    complete: boolean;
    expansions: number;
  } | null;
  /** 最短路径结果；null 表示不可达 */
  shortest: PathResult | null;
  /** 起终点相同标记 */
  sameEndpoint: boolean;
  /** 本次搜索实际使用的起点节点 id（用于在结果区标注） */
  searchedStartId: string;
  /** 本次搜索实际使用的终点节点 id */
  searchedEndId: string;
  /** 本次搜索实际使用的限制，便于在界面上明示 */
  limits: SearchLimits;
  /** 当前在地图上高亮的路径（点击结果条目后设置） */
  highlightedRoadIds: string[];
  /** 高亮路径经过的节点 id（含首尾），用于节点配色 */
  highlightedNodeIds: string[];
  /** 高亮路径的完整折线（复用道路真实折线坐标） */
  highlightedPolyline: PixelPoint[];
}

interface AppState {
  // ---- 底图 ----
  image: MapImageMeta | null;
  imageUrl: string | null;
  /** 图片原始像素尺寸，未加载时为 0 */
  imageWidth: number;
  imageHeight: number;
  /** 底图原始文件对象与内嵌数据（用于导出时内嵌图片；非上传来源时为 null） */
  imageFile: File | null;
  imageDataUrl: string | null;

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
  /**
   * 正在等待用户在地图上点选作为道路端点的位置：'from' 起点、'to' 终点、null 未在选取。
   * 仅用于“点击地图上的节点选择端点”，不影响绘制草稿本身。
   */
  roadEndpointPicking: 'from' | 'to' | null;
  /** 通过点击地图节点选中的端点：起点 id / 终点 id（空串表示未选） */
  pickedFromNodeId: string;
  pickedToNodeId: string;
  /** 开始 / 结束在地图上点选道路端点 */
  setRoadEndpointPicking: (target: 'from' | 'to' | null) => void;
  /** 记录一次地图点选到的端点节点 */
  applyPickedRoadEndpoint: (nodeId: string) => void;

  // ---- 寻路 ----
  /** 起点节点 id */
  startNodeId: string;
  /** 终点节点 id */
  endNodeId: string;
  /** 寻路结果 */
  search: SearchState;
  /** 结果数量上限（用户可调） */
  searchLimits: SearchLimits;
  /** 执行搜索：同时计算全部简单路径与最短路径（只读，绝不修改道路） */
  runSearch: (limits?: Partial<SearchLimits>) => { ok: boolean; error?: string };
  setStartNodeId: (id: string) => void;
  setEndNodeId: (id: string) => void;
  setSearchLimits: (limits: Partial<SearchLimits>) => void;
  /** 清空搜索结果（修改图数据后调用，避免展示过期结果） */
  clearSearch: () => void;
  /** 在地图上高亮某条路径 */
  highlightPath: (path: PathResult | null) => void;

  // ---- 比例尺校准（阶段4） ----
  /** 已保存的比例尺；null 表示未校准 */
  scale: MapScale | null;
  /** 校准点 A（选取过程中） */
  scalePointA: ScalePoint | null;
  /** 校准点 B（选取过程中） */
  scalePointB: ScalePoint | null;
  /** 是否处于“在地图上点选校准点”模式 */
  scalePicking: boolean;
  /** 下一个待设置的点：'a' | 'b'；两个都设好后为 null */
  scaleNextPoint: 'a' | 'b' | null;
  /** 开始/结束在地图上点选校准点 */
  setScalePicking: (on: boolean) => void;
  /** 在地图上点选一个校准点（自动填充 A 或 B） */
  pickScalePoint: (point: ScalePoint) => void;
  /** 直接设置某个校准点（手动输入坐标时使用） */
  setScalePoint: (which: 'a' | 'b', point: ScalePoint | null) => void;
  /** 重置校准点选择（不清除已保存的比例尺） */
  resetScalePoints: () => void;
  /** 应用校准：校验并保存到项目状态 */
  applyScale: (knownDistance: number | string, unit: string) => ScaleValidationResult;
  /** 清除比例尺（回到未校准状态） */
  clearScale: () => void;

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
  /**
   * 切换道路选中状态：再次点击已选中的道路则取消选中。
   * 取消选中时地图上的道路高亮一并恢复为普通状态。
   */
  toggleRoadSelection: (id: string) => void;
  /** 拖动编辑已存在道路的中间点 */
  updateRoadPoint: (roadId: string, index: number, x: number, y: number) => { ok: boolean; error?: string };

  pushNotice: (kind: Notice['kind'], text: string) => void;
  dismissNotice: (id: number) => void;

  /** 导出为可复用的工程数据（阶段2用于测试与后续持久化） */
  toProject: () => MapProject | null;

  /**
   * 导入一份已通过校验的项目数据。
   *
   * 调用方必须先完成校验与用户确认；这里只做状态替换。
   * 若传入的 imageDataUrl 为 null（文件未内嵌图片），则清空底图但保留节点与道路，
   * 由界面提示用户重新选择底图。
   */
  importProject: (input: {
    image: MapImageMeta;
    imageDataUrl: string | null;
    objectUrl: string | null;
    nodes: MapNode[];
    roads: Road[];
    scale: MapScale | null;
    searchLimits?: SearchLimits;
  }) => void;

  /** 记录底图对应的原始文件（上传时调用，导出时用于内嵌图片） */
  setImageSource: (file: File | null, dataUrl: string | null) => void;
}

let noticeSeq = 0;

const initialView = {
  selectedNodeId: null,
  selectedRoadId: null,
  camera: { zoom: 1, offsetX: 0, offsetY: 0 },
  viewInitialized: false,
  draft: null,
  roadEndpointPicking: null,
  pickedFromNodeId: '',
  pickedToNodeId: '',
} satisfies Partial<AppState>;

/** 初始寻路状态 */
export function createInitialSearchState(limits: SearchLimits = DEFAULT_SEARCH_LIMITS): SearchState {
  return {
    status: 'idle',
    simple: null,
    shortest: null,
    sameEndpoint: false,
    searchedStartId: '',
    searchedEndId: '',
    limits,
    highlightedRoadIds: [],
    highlightedNodeIds: [],
    highlightedPolyline: [],
  };
}

const initialSearch = {
  startNodeId: '',
  endNodeId: '',
  search: createInitialSearchState(),
  searchLimits: DEFAULT_SEARCH_LIMITS,
} satisfies Partial<AppState>;

/** 比例尺初始状态：未校准 */
const initialScale = {
  scale: null,
  scalePointA: null,
  scalePointB: null,
  scalePicking: false,
  scaleNextPoint: 'a',
} satisfies Partial<AppState>;

/**
 * 图数据（节点/道路）发生变化时，旧的寻路结果即失效。
 * 返回一个“清空结果但保留用户设置的上限”的状态片段。
 */
function invalidateSearch(state: { searchLimits: SearchLimits }) {
  return { search: createInitialSearchState(state.searchLimits) };
}

export const useAppStore = create<AppState>((set, get) => ({
  image: null,
  imageUrl: null,
  imageWidth: 0,
  imageHeight: 0,
  imageFile: null,
  imageDataUrl: null,
  nodes: [],
  roads: [],
  notices: [],
  ...initialView,
  ...initialSearch,
  ...initialScale,

  setImage: (meta, objectUrl) => {
    const previousUrl = get().imageUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    set({
      image: meta,
      imageUrl: objectUrl,
      imageWidth: meta.width,
      imageHeight: meta.height,
      // 换图后旧的图片数据不再对应当前底图，一并清空（由 setImageSource 重新写入）
      imageFile: null,
      imageDataUrl: null,
      // 换图后旧节点/道路坐标失去意义，明确清空并提示，避免坐标错位
      nodes: [],
      roads: [],
      startNodeId: '',
      endNodeId: '',
      // 换图后旧比例尺对新图没有意义，必须清除，避免把像素当米
      ...initialScale,
      ...initialView,
      ...invalidateSearch(get()),
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
      imageFile: null,
      imageDataUrl: null,
      nodes: [],
      roads: [],
      startNodeId: '',
      endNodeId: '',
      // 换图后旧比例尺对新图没有意义，必须清除，避免把像素当米
      ...initialScale,
      ...initialView,
      ...invalidateSearch(get()),
      notices: get().notices,
    });
  },

  setCamera: (camera) => set({ camera }),
  markViewInitialized: () => set({ viewInitialized: true }),

  // 默认建成“地标”：地图在非节点管理页签只显示出入口与地标，
  // 若默认建成路口，用户在地图上新加的节点会看不见。
  addNodeAtPixel: (x, y, name, type = 'landmark') => {
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
    const { nodes, roads, selectedNodeId, selectedRoadId, draft, startNodeId, endNodeId } = get();
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
      // 起终点被删除时同步清空，避免引用不存在的节点
      startNodeId: startNodeId === id ? '' : startNodeId,
      endNodeId: endNodeId === id ? '' : endNodeId,
      ...invalidateSearch(get()),
    });
    return { ok: true, removedRoads: affected.length };
  },

  selectNode: (id) => set({ selectedNodeId: id, selectedRoadId: null }),

  // ---------------- 道路 ----------------

  setRoadEndpointPicking: (target) => set({ roadEndpointPicking: target }),

  /**
   * 把地图上点到的节点记为当前正在选取的端点。
   * 选完起点后自动切到“选终点”，两个都选好后自动退出点选状态，
   * 用户只需在地图上点两下即可完成起终点选择。
   */
  applyPickedRoadEndpoint: (nodeId) => {
    const { roadEndpointPicking, pickedFromNodeId, nodes } = get();
    if (!roadEndpointPicking) return;
    if (!nodes.some((n) => n.id === nodeId)) return;

    if (roadEndpointPicking === 'from') {
      set({ pickedFromNodeId: nodeId, roadEndpointPicking: 'to' });
      return;
    }
    // 选终点：不能与起点相同
    if (pickedFromNodeId && nodeId === pickedFromNodeId) {
      return;
    }
    set({ pickedToNodeId: nodeId, roadEndpointPicking: null });
  },

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
      // 端点已齐备并开始绘制，退出点选状态并清空临时选中结果，
      // 避免下次新建道路时残留上一次的端点
      roadEndpointPicking: null,
      pickedFromNodeId: '',
      pickedToNodeId: '',
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
        ...invalidateSearch(get()),
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
      ...invalidateSearch(get()),
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
      ...invalidateSearch(get()),
    });
  },

  selectRoad: (id) => set({ selectedRoadId: id, selectedNodeId: null }),

  toggleRoadSelection: (id) => {
    const { selectedRoadId } = get();
    // 再次点击同一条道路 -> 取消选中；否则选中该道路
    if (selectedRoadId === id) {
      set({ selectedRoadId: null, selectedNodeId: null });
      return;
    }
    set({ selectedRoadId: id, selectedNodeId: null });
  },

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
      // 拖动中间点会改变道路像素长度，旧寻路结果随之失效
      ...invalidateSearch(get()),
    });
    return { ok: true };
  },

  // ---------------- 寻路 ----------------

  setStartNodeId: (id) => {
    set({ startNodeId: id, ...invalidateSearch(get()) });
  },

  setEndNodeId: (id) => {
    set({ endNodeId: id, ...invalidateSearch(get()) });
  },

  setSearchLimits: (limits) => {
    const next: SearchLimits = {
      ...get().searchLimits,
      ...limits,
    };
    set({ searchLimits: next, ...invalidateSearch({ searchLimits: next }) });
  },

  clearSearch: () => set({ ...invalidateSearch(get()) }),

  highlightPath: (path) =>
    set({
      search: {
        ...get().search,
        highlightedRoadIds: path ? [...path.roadIds] : [],
        highlightedNodeIds: path ? [...path.nodeIds] : [],
        highlightedPolyline: path ? path.polyline.map((p) => ({ x: p.x, y: p.y })) : [],
      },
    }),

  /**
   * 执行寻路。
   *
   * 严格只读：不创建、不修改、不删除任何节点或道路。
   * 同时产出“全部简单路径”与“Dijkstra 最短路径”。
   */
  runSearch: (limits) => {
    const { nodes, roads, startNodeId, endNodeId, searchLimits, scale } = get();
    const effectiveLimits: SearchLimits = { ...searchLimits, ...limits };

    if (!startNodeId || !endNodeId) {
      const error = '请选择起点和终点';
      set({ search: { ...createInitialSearchState(effectiveLimits), status: 'error', error } });
      return { ok: false, error };
    }

    const simple = findAllSimplePaths(nodes, roads, startNodeId, endNodeId, effectiveLimits, scale);
    if (!simple.ok) {
      set({
        search: { ...createInitialSearchState(effectiveLimits), status: 'error', error: simple.error },
      });
      return { ok: false, error: simple.error };
    }

    const shortest = findShortestPath(nodes, roads, startNodeId, endNodeId, scale);
    if (!shortest.ok) {
      set({
        search: { ...createInitialSearchState(effectiveLimits), status: 'error', error: shortest.error },
      });
      return { ok: false, error: shortest.error };
    }

    const sameEndpoint = startNodeId === endNodeId;
    const hasAnyPath = simple.result.paths.length > 0;

    /*
     * 状态判定必须严谨：
     * - 有简单路径 → found
     * - 没有简单路径，但搜索被上限截断 → partial（搜索没做完，不能断言“无路径”）
     * - 没有简单路径，且搜索已穷举完毕 → no-path（确实不可达）
     *
     * 关键：大图上 DFS 可能在找到第一条路径之前就耗尽扩展次数，
     * 此时“简单路径为空”只说明“还没找到”，不说明“不存在”。
     * 而 Dijkstra 是多项式复杂度，往往仍能给出最短路径——若按旧逻辑
     * 直接把空结果当作 no-path，就会出现“面板说无路径、地图却高亮着真路”的矛盾。
     */
    const simpleComplete = simple.result.complete;
    const status: 'found' | 'partial' | 'no-path' = hasAnyPath
      ? 'found'
      : simpleComplete
        ? 'no-path'
        : 'partial';

    set({
      search: {
        status,
        simple: simple.result,
        shortest: shortest.result.path,
        sameEndpoint,
        searchedStartId: startNodeId,
        searchedEndId: endNodeId,
        limits: effectiveLimits,
        // 默认高亮最短路径，便于直接在地图上看到结果
        highlightedRoadIds: shortest.result.path ? [...shortest.result.path.roadIds] : [],
        highlightedNodeIds: shortest.result.path ? [...shortest.result.path.nodeIds] : [],
        highlightedPolyline: shortest.result.path
          ? shortest.result.path.polyline.map((p) => ({ x: p.x, y: p.y }))
          : [],
      },
    });
    return { ok: true };
  },

  // ---------------- 比例尺校准 ----------------

  setScalePicking: (on) =>
    set({
      scalePicking: on,
      // 进入点选模式时，若两点已齐，则从 A 重新开始
      scaleNextPoint: on && get().scalePointA && get().scalePointB ? 'a' : get().scaleNextPoint,
    }),

  pickScalePoint: (point) => {
    const { scalePointA, scalePointB, scaleNextPoint } = get();
    // 两个点都已有值时，再次点选视为“重新开始”，先清空 A 再填 A
    if (scalePointA && scalePointB) {
      set({ scalePointA: point, scalePointB: null, scaleNextPoint: 'b' });
      return;
    }
    if (!scalePointA || scaleNextPoint === 'a') {
      set({ scalePointA: point, scaleNextPoint: 'b' });
      return;
    }
    set({ scalePointB: point, scaleNextPoint: null, scalePicking: false });
  },

  setScalePoint: (which, point) => {
    if (which === 'a') {
      set({ scalePointA: point, scaleNextPoint: point ? 'b' : 'a' });
    } else {
      set({ scalePointB: point, scaleNextPoint: point ? null : 'b' });
    }
  },

  resetScalePoints: () => set({ scalePointA: null, scalePointB: null, scaleNextPoint: 'a' }),

  applyScale: (knownDistance, unit) => {
    const { scalePointA, scalePointB, imageWidth, imageHeight } = get();
    const result = createMapScale(
      scalePointA,
      scalePointB,
      knownDistance,
      unit,
      imageWidth,
      imageHeight,
    );
    if (!result.ok) return result;

    set({
      scale: result.scale,
      scalePicking: false,
      // 搜索结果中的实际距离依赖比例尺，必须失效以便重算
      ...invalidateSearch(get()),
    });
    return result;
  },

  clearScale: () =>
    set({
      scale: null,
      scalePointA: null,
      scalePointB: null,
      scalePicking: false,
      scaleNextPoint: 'a',
      ...invalidateSearch(get()),
    }),

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
    const { image, nodes, roads, scale } = get();
    if (!image) return null;
    return {
      version: 1,
      image,
      nodes: sortNodes(nodes),
      roads,
      scale,
    };
  },

  setImageSource: (file, dataUrl) => set({ imageFile: file, imageDataUrl: dataUrl }),

  importProject: ({ image, imageDataUrl, objectUrl, nodes, roads, scale, searchLimits }) => {
    const previousUrl = get().imageUrl;
    // 仅释放属于本应用创建的 blob URL；导入的 data URL 不是 blob，无需释放
    if (previousUrl && previousUrl.startsWith('blob:')) URL.revokeObjectURL(previousUrl);

    const limits = searchLimits ?? get().searchLimits;

    set({
      image,
      // 未内嵌图片时 objectUrl 为 null：节点与道路仍完整保留，但界面需提示重新选择底图
      imageUrl: objectUrl,
      imageWidth: image.width,
      imageHeight: image.height,
      imageFile: null,
      imageDataUrl,
      nodes: sortNodes(nodes),
      roads,
      scale,
      // 导入即替换整份项目：起终点、搜索结果与视图状态全部重置，避免残留旧项目的结果
      startNodeId: '',
      endNodeId: '',
      searchLimits: limits,
      // 导入的比例尺直接生效（不再先清空再加回，避免同名字段重复）
      scalePointA: null,
      scalePointB: null,
      scalePicking: false,
      scaleNextPoint: 'a',
      ...initialView,
      search: createInitialSearchState(limits),
      notices: get().notices,
    });
  },
}));

/** 便捷选择器：获取某条道路的完整折线（端点由节点实时提供） */
export function selectRoadPolyline(road: Road, nodes: MapNode[]): PixelPoint[] | null {
  const from = nodes.find((n) => n.id === road.fromNodeId);
  const to = nodes.find((n) => n.id === road.toNodeId);
  if (!from || !to) return null;
  return buildRoadPolyline(road, from.point, to.point);
}
