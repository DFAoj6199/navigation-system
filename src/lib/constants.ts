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

/**
 * 寻路相关节点的角色配色。
 *
 * 起点、终点刻意选用与所有节点类型色都不同的高饱和色，
 * 保证在地图上能一眼区分“普通节点 / 起点 / 终点 / 所选路线上的节点”。
 */
export const PATH_ROLE_COLORS = {
  /** 起点：翠绿 */
  start: '#059669',
  /** 终点：品红 */
  end: '#db2777',
  /** 所选路线经过的中间节点：紫色 */
  onRoute: '#7c3aed',
  /** 所选路线折线高亮色 */
  route: '#7c3aed',
} as const;

/** 节点在寻路结果中的角色 */
export type PathNodeRole = 'normal' | 'start' | 'end' | 'onRoute';

/** 取某角色对应的填充色；普通节点按自身类型着色 */
export function nodeFillColor(type: NodeType, role: PathNodeRole): string {
  switch (role) {
    case 'start':
      return PATH_ROLE_COLORS.start;
    case 'end':
      return PATH_ROLE_COLORS.end;
    case 'onRoute':
      return PATH_ROLE_COLORS.onRoute;
    default:
      return NODE_TYPE_COLORS[type];
  }
}


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
