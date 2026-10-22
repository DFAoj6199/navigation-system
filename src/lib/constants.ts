import type { NodeType } from '../types';

/** 节点类型的中文标签 */
export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  junction: '路口/交叉点',
  entrance: '出入口',
  landmark: '地标',
};

/** 各类型节点的主题色，用于地图标记与列表标记 */
export const NODE_TYPE_COLORS: Record<NodeType, string> = {
  junction: '#ef4444',
  entrance: '#2563eb',
  landmark: '#16a34a',
};

/** 常见图片格式（同时用于 <input accept> 与上传校验） */
export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
];

export const ACCEPT_ATTR = [...ACCEPTED_IMAGE_TYPES, '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].join(',');

/** 单次上传的大小上限：60MB（原始地图可能很大，给足空间） */
export const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
