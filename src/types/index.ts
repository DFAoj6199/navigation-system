/**
 * 全局数据模型定义。
 *
 * 【坐标约定】
 * 所有业务数据（节点、折线的中间点等）一律保存“原始图片像素坐标”，
 * 原点在图片左上角，x 向右为正，y 向下为正，单位为原始图像像素。
 * 屏幕坐标、缩放比例、平移量只属于视图层（相机状态），绝不写入业务数据。
 */

/** 原始图片像素坐标。原点为图片左上角，x 向右、y 向下。 */
export interface PixelPoint {
  x: number;
  y: number;
}

/** 节点类型（阶段1仅作为数据字段保留，便于后续道路/导航阶段扩展） */
export type NodeType = 'junction' | 'entrance' | 'landmark';

/** 地图节点：具有唯一 ID、显示名称与原始像素坐标 */
export interface MapNode {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 原始图片像素坐标 */
  point: PixelPoint;
  /** 节点类型，默认 'junction' */
  type: NodeType;
  /** 创建时间（ISO 字符串），便于排查与排序 */
  createdAt: string;
}

/**
 * 地图底图信息（由用户上传的文件得到）。
 * 只为后续持久化预留字段，本阶段不上传服务器、不联网。
 */
export interface MapImageMeta {
  fileName: string;
  /** 原始图像宽度（像素） */
  width: number;
  /** 原始图像高度（像素） */
  height: number;
  /** MIME 类型，如 image/png */
  mimeType: string;
}

/**
 * 地图工程数据。
 *
 * 说明：`roads` 已在类型层预留（双向道路 = 两个节点 + 一组折线坐标），
 * 这是为了让后续道路阶段能直接复用本阶段的数据结构。
 * 阶段1 不创建任何道路，`roads` 恒为空数组，也不实现任何道路功能。
 */
export interface MapProject {
  /** 数据结构版本号，便于后续迁移 */
  version: 1;
  image: MapImageMeta;
  nodes: MapNode[];
  /** 阶段2：双向道路列表 */
  roads: Road[];
}

/**
 * 双向道路数据结构。
 *
 * 一条道路 = 两个端点节点 + 一组有序的折线中间点。
 * `points` 只保存“中间点”的原图像素坐标；渲染时按 from -> ... -> to 串接，
 * 这样移动节点时折线端点会自动跟随节点，不会出现端点与节点脱节。
 * 中间点数量不固定（0 个表示两端点直连），也绝不把折线简化成直线。
 *
 * 所有道路均为双向：没有方向字段，寻路时在邻接表中同时建立正向与反向边。
 */
export interface Road {
  id: string;
  name?: string;
  /** 端点节点 A 的 id */
  fromNodeId: string;
  /** 端点节点 B 的 id */
  toNodeId: string;
  /** 折线中间点（不含端点），原图像素坐标，可为空数组 */
  points: PixelPoint[];
  /** 创建时间（ISO 字符串），用于稳定排序 */
  createdAt: string;
}

/** 视图层相机状态：缩放与平移（只影响渲染，不影响业务数据） */
export interface Camera {
  /** 缩放倍率，1 表示 1 个原始像素渲染为 1 个 CSS 像素 */
  zoom: number;
  /** 平移量（CSS 像素），含义见 lib/viewport.ts */
  offsetX: number;
  offsetY: number;
}
