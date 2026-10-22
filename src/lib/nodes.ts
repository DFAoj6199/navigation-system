import type { MapNode, NodeType } from '../types';

/**
 * 节点相关的纯函数工具（便于单元测试与后续道路阶段复用）。
 */

const ID_PREFIX = 'node';

/** 生成节点唯一 ID：基于时间戳 + 随机后缀，避免依赖 crypto 在旧浏览器不可用 */
export function createNodeId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${ID_PREFIX}-${Date.now().toString(36)}-${random}`;
}

export function createNode(
  point: { x: number; y: number },
  name: string,
  type: NodeType = 'junction',
): MapNode {
  return {
    id: createNodeId(),
    name: name.trim(),
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    type,
    createdAt: new Date().toISOString(),
  };
}

/** 根据已有节点自动生成默认名称，如 “节点 1” */
export function nextNodeName(nodes: MapNode[]): string {
  let index = nodes.length + 1;
  const existing = new Set(nodes.map((node) => node.name));
  while (existing.has(`节点 ${index}`)) {
    index += 1;
  }
  return `节点 ${index}`;
}

/** 校验节点名称：非空、去空格后长度 <= 40 */
export function validateNodeName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '节点名称不能为空';
  if (trimmed.length > 40) return '节点名称不能超过 40 个字符';
  return null;
}

export type CoordinateParseResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * 解析用户手动输入的坐标文本。
 * 规则：必须是有限数字（允许负数以便给出“超出范围”的明确提示），
 * 不接受空字符串、NaN、Infinity 和非数字文本。
 */
export function parseCoordinateInput(raw: string, axis: 'X' | 'Y'): CoordinateParseResult {
  const text = raw.trim();
  if (text === '') return { ok: false, error: `${axis} 坐标不能为空` };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) {
    return { ok: false, error: `${axis} 坐标必须是数字（可含小数）` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `${axis} 坐标不是有效数字` };
  return { ok: true, value };
}

export type NodeCoordinateCheck =
  | { ok: true; point: { x: number; y: number } }
  | { ok: false; error: string };

/**
 * 校验一组原始像素坐标是否落在地图范围内，并取整。
 * 超出范围时给出明确的中文错误信息，调用方据此阻止无效操作。
 */
export function validateNodePoint(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
): NodeCoordinateCheck {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: '坐标必须是有效数字' };
  }
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px > imageWidth) {
    return {
      ok: false,
      error: `X 坐标 ${px} 超出图片范围（有效范围 0 ~ ${imageWidth}）`,
    };
  }
  if (py < 0 || py > imageHeight) {
    return {
      ok: false,
      error: `Y 坐标 ${py} 超出图片范围（有效范围 0 ~ ${imageHeight}）`,
    };
  }
  return { ok: true, point: { x: px, y: py } };
}

/** 按创建顺序排序节点（保持稳定顺序） */
export function sortNodes(nodes: MapNode[]): MapNode[] {
  return [...nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
