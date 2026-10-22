import type { MapImageMeta, MapNode, NodeType, PixelPoint, Road } from '../types';
import type { MapScale, DistanceUnit } from './scale';

/**
 * 项目文件的序列化 / 反序列化与校验。
 *
 * 【为什么要内嵌图片】
 * 需求要求“地图图片数据或可恢复的地图资源引用”。浏览器出于安全限制，页面无法通过
 * 文件路径重新读取本地图片（file:// 路径在导入方机器上也不存在），所以只有把图片
 * 以 base64 data URL 内嵌进 JSON，导出文件才真正能在任何机器上完整恢复。
 *
 * 【校验原则】
 * 校验函数是纯函数，只做数据判断、不抛异常、不修改输入。
 * 任何不合法之处都以「人类可读的中文说明 + 出错位置」返回，便于界面精确提示，
 * 并且导入方在真正写入 store 之前就能拒绝整份文件，绝不会只导入一半。
 */

/** 当前项目文件格式版本 */
export const PROJECT_FILE_VERSION = 1;

/** 项目文件标识，用于快速识别“这是不是本系统导出的文件” */
export const PROJECT_FILE_APP = 'tianhe-navigation';

/** 导出文件默认扩展名 */
export const PROJECT_FILE_EXT = '.tianhe.json';

/** 单张内嵌图片 data URL 的长度上限（约 60MB 原图经 base64 膨胀后的量级） */
export const MAX_EMBEDDED_IMAGE_CHARS = 90 * 1024 * 1024;

/** 节点/道路数量上限，防止恶意或异常文件让页面卡死 */
export const MAX_PROJECT_NODES = 20000;
export const MAX_PROJECT_ROADS = 20000;
export const MAX_ROAD_POINTS = 5000;

/** 校验结果：ok 为 false 时 error 一定有值 */
export type ValidationResult = { ok: true } | { ok: false; error: string; path?: string };

/**
 * 内嵌图片描述。
 * `dataUrl` 形如 `data:image/png;base64,xxxx`，与 `mimeType` 一致。
 */
export interface ProjectImage extends MapImageMeta {
  /** base64 data URL；为 null 表示文件未内嵌图片（仅能恢复坐标与拓扑） */
  dataUrl: string | null;
}

/** 项目配置：非地图几何但影响使用体验的少量设置 */
export interface ProjectConfig {
  /** 导出时使用的程序版本标记，仅作溯源 */
  exportedAt: string;
  /** 搜索时最多返回的简单路径数量（与界面设置保持一致） */
  maxResults: number;
}

/** 项目文件根结构 */
export interface ProjectFile {
  app: typeof PROJECT_FILE_APP;
  version: typeof PROJECT_FILE_VERSION;
  image: ProjectImage;
  nodes: MapNode[];
  roads: Road[];
  scale: MapScale | null;
  config: ProjectConfig;
}

const NODE_TYPES: NodeType[] = ['junction', 'entrance', 'landmark'];
const DISTANCE_UNITS: DistanceUnit[] = ['m', 'km'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 构造失败结果的小工具（返回单一下降后的失败类型，便于各校验函数直接返回） */
type Failure = { ok: false; error: string; path?: string };

function fail(error: string, path?: string): Failure {
  return { ok: false, error, path };
}

/** 校验一个像素坐标点；返回错误说明或 null */
function checkPoint(value: unknown, label: string, width: number, height: number): string | null {
  if (!isPlainObject(value)) return `${label} 不是有效的坐标对象`;
  const { x, y } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
    return `${label}的 x/y 必须是有限数字（当前 ${JSON.stringify(x)} / ${JSON.stringify(y)}）`;
  }
  // 坐标允许略微超出边界（节点可能贴在边缘），但明显越界视为非法
  const marginX = width * 0.5;
  const marginY = height * 0.5;
  if (x < -marginX || x > width + marginX || y < -marginY || y > height + marginY) {
    return `${label}的坐标 (${x}, ${y}) 明显超出图片范围 ${width}×${height}`;
  }
  return null;
}

/** 校验图片字段 */
function checkImage(value: unknown): { ok: true; image: ProjectImage } | { ok: false; error: string; path?: string } {
  if (!isPlainObject(value)) return fail('缺少地图图片信息（image 字段）', 'image');
  const { fileName, width, height, mimeType, dataUrl } = value;

  if (!isNonEmptyString(fileName)) return fail('地图文件名为空', 'image.fileName');
  if (!isFiniteNumber(width) || width <= 0 || !Number.isInteger(width)) {
    return fail(`地图宽度必须是正整数（当前 ${JSON.stringify(width)}）`, 'image.width');
  }
  if (!isFiniteNumber(height) || height <= 0 || !Number.isInteger(height)) {
    return fail(`地图高度必须是正整数（当前 ${JSON.stringify(height)}）`, 'image.height');
  }
  if (!isNonEmptyString(mimeType)) return fail('地图 MIME 类型为空', 'image.mimeType');

  // 图片数据可以为 null（允许“无底图”的纯数据项目），但给了就必须是合法 data URL
  if (dataUrl !== null && dataUrl !== undefined) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return fail('内嵌图片数据格式错误，应为 data: 开头的 data URL', 'image.dataUrl');
    }
    if (!dataUrl.includes(';base64,')) {
      return fail('内嵌图片数据必须是 base64 编码的 data URL', 'image.dataUrl');
    }
    if (dataUrl.length > MAX_EMBEDDED_IMAGE_CHARS) {
      return fail('内嵌图片数据过大，超出支持范围', 'image.dataUrl');
    }
    // MIME 一致性：data URL 头部的类型应与 mimeType 一致
    const header = dataUrl.slice(5, dataUrl.indexOf(';base64,'));
    if (header && header.toLowerCase() !== mimeType.toLowerCase()) {
      return fail(
        `内嵌图片类型（${header}）与声明的 mimeType（${mimeType}）不一致`,
        'image.dataUrl',
      );
    }
  }

  return {
    ok: true,
    image: {
      fileName,
      width,
      height,
      mimeType,
      dataUrl: typeof dataUrl === 'string' ? dataUrl : null,
    },
  };
}

/** 校验节点数组，返回去重后的 ID 集合或错误 */
function checkNodes(
  value: unknown,
  width: number,
  height: number,
): { ok: true; nodes: MapNode[]; ids: Set<string> } | { ok: false; error: string; path?: string } {
  if (!Array.isArray(value)) return fail('节点列表（nodes）必须是数组', 'nodes');
  if (value.length > MAX_PROJECT_NODES) {
    return fail(`节点数量 ${value.length} 超过上限 ${MAX_PROJECT_NODES}`, 'nodes');
  }

  const ids = new Set<string>();
  const nodes: MapNode[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    const label = `第 ${i + 1} 个节点`;
    const path = `nodes[${i}]`;
    if (!isPlainObject(raw)) return fail(`${label} 不是有效的对象`, path);

    if (!isNonEmptyString(raw.id)) return fail(`${label} 缺少有效的 id`, `${path}.id`);
    const id = raw.id;
    if (ids.has(id)) return fail(`节点 id 重复：${id}（同一项目中 id 必须唯一）`, `${path}.id`);
    ids.add(id);

    if (!isNonEmptyString(raw.name)) return fail(`${label}（${id}）缺少名称`, `${path}.name`);

    const pointError = checkPoint(raw.point, `${label}（${raw.name}）`, width, height);
    if (pointError) return fail(pointError, `${path}.point`);
    const point = raw.point as PixelPoint;

    const type = raw.type;
    if (typeof type !== 'string' || !NODE_TYPES.includes(type as NodeType)) {
      return fail(
        `${label}（${raw.name}）的类型无效：${JSON.stringify(type)}，应为 ${NODE_TYPES.join(' / ')}`,
        `${path}.type`,
      );
    }

    if (!isNonEmptyString(raw.createdAt)) {
      return fail(`${label}（${raw.name}）缺少 createdAt 时间戳`, `${path}.createdAt`);
    }

    nodes.push({
      id,
      name: raw.name,
      point: { x: point.x, y: point.y },
      type: type as NodeType,
      createdAt: raw.createdAt,
    });
  }

  return { ok: true, nodes, ids };
}

/** 校验道路数组 */
function checkRoads(
  value: unknown,
  nodeIds: Set<string>,
  width: number,
  height: number,
): { ok: true; roads: Road[] } | { ok: false; error: string; path?: string } {
  if (!Array.isArray(value)) return fail('道路列表（roads）必须是数组', 'roads');
  if (value.length > MAX_PROJECT_ROADS) {
    return fail(`道路数量 ${value.length} 超过上限 ${MAX_PROJECT_ROADS}`, 'roads');
  }

  const roadIds = new Set<string>();
  const pairKeys = new Set<string>();
  const roads: Road[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    const label = `第 ${i + 1} 条道路`;
    const path = `roads[${i}]`;
    if (!isPlainObject(raw)) return fail(`${label} 不是有效的对象`, path);

    if (!isNonEmptyString(raw.id)) return fail(`${label} 缺少有效的 id`, `${path}.id`);
    const id = raw.id;
    if (roadIds.has(id)) return fail(`道路 id 重复：${id}`, `${path}.id`);
    roadIds.add(id);

    // 端点必须引用已存在的节点
    if (!isNonEmptyString(raw.fromNodeId)) {
      return fail(`${label}（${id}）缺少起点节点引用`, `${path}.fromNodeId`);
    }
    if (!isNonEmptyString(raw.toNodeId)) {
      return fail(`${label}（${id}）缺少终点节点引用`, `${path}.toNodeId`);
    }
    if (!nodeIds.has(raw.fromNodeId)) {
      return fail(
        `${label}（${id}）的起点节点 ${raw.fromNodeId} 不存在（无效的道路端点引用）`,
        `${path}.fromNodeId`,
      );
    }
    if (!nodeIds.has(raw.toNodeId)) {
      return fail(
        `${label}（${id}）的终点节点 ${raw.toNodeId} 不存在（无效的道路端点引用）`,
        `${path}.toNodeId`,
      );
    }
    const fromNodeId = raw.fromNodeId;
    const toNodeId = raw.toNodeId;

    if (fromNodeId === toNodeId) {
      return fail(`${label}（${id}）的起点与终点是同一个节点`, `${path}.fromNodeId`);
    }

    // 同一对节点之间不允许出现重复道路
    const pairKey = [fromNodeId, toNodeId].sort().join('::');
    if (pairKeys.has(pairKey)) {
      return fail(`${label}（${id}）与已有道路重复：两端节点相同`, `${path}.fromNodeId`);
    }
    pairKeys.add(pairKey);

    if (!Array.isArray(raw.points)) {
      return fail(`${label}（${id}）的折线中间点（points）必须是数组`, `${path}.points`);
    }
    if (raw.points.length > MAX_ROAD_POINTS) {
      return fail(`${label}（${id}）的中间点数量超过上限 ${MAX_ROAD_POINTS}`, `${path}.points`);
    }
    const points: PixelPoint[] = [];
    for (let j = 0; j < raw.points.length; j += 1) {
      const p = raw.points[j];
      const pErr = checkPoint(p, `${label} 的第 ${j + 1} 个中间点`, width, height);
      if (pErr) return fail(pErr, `${path}.points[${j}]`);
      points.push({ x: (p as PixelPoint).x, y: (p as PixelPoint).y });
    }

    if (raw.name !== undefined && typeof raw.name !== 'string') {
      return fail(`${label}（${id}）的名称必须是字符串`, `${path}.name`);
    }
    if (!isNonEmptyString(raw.createdAt)) {
      return fail(`${label}（${id}）缺少 createdAt 时间戳`, `${path}.createdAt`);
    }

    roads.push({
      id,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      fromNodeId,
      toNodeId,
      points,
      createdAt: raw.createdAt,
    });
  }

  return { ok: true, roads };
}

/** 校验比例尺 */
function checkScale(value: unknown): { ok: true; scale: MapScale | null } | { ok: false; error: string; path?: string } {
  if (value === null || value === undefined) return { ok: true, scale: null };
  if (!isPlainObject(value)) return fail('比例尺（scale）必须是对象或 null', 'scale');

  const { knownDistance, unit, knownDistanceMeters, pixelDistance, metersPerPixel, calibratedAt } = value;

  for (const [key, label] of [
    ['a', '校准点 A'],
    ['b', '校准点 B'],
  ] as const) {
    const p = value[key];
    if (!isPlainObject(p) || !isFiniteNumber(p.x) || !isFiniteNumber(p.y)) {
      return fail(`比例尺的${label}坐标无效`, `scale.${key}`);
    }
  }
  if (!isFiniteNumber(knownDistance) || knownDistance <= 0) {
    return fail(`比例尺的已知距离必须是正数（当前 ${JSON.stringify(knownDistance)}）`, 'scale.knownDistance');
  }
  if (typeof unit !== 'string' || !DISTANCE_UNITS.includes(unit as DistanceUnit)) {
    return fail(`比例尺单位无效：${JSON.stringify(unit)}，应为 m 或 km`, 'scale.unit');
  }
  if (!isFiniteNumber(knownDistanceMeters) || knownDistanceMeters <= 0) {
    return fail('比例尺的已知距离（米）无效', 'scale.knownDistanceMeters');
  }
  if (!isFiniteNumber(pixelDistance) || pixelDistance <= 0) {
    return fail('比例尺的像素距离必须为正数（校准点不能重合）', 'scale.pixelDistance');
  }
  if (!isFiniteNumber(metersPerPixel) || metersPerPixel <= 0) {
    return fail('比例尺的换算系数（米/像素）无效', 'scale.metersPerPixel');
  }
  if (!isNonEmptyString(calibratedAt)) return fail('比例尺缺少校准时间', 'scale.calibratedAt');

  const aPt = value.a as PixelPoint;
  const bPt = value.b as PixelPoint;
  return {
    ok: true,
    scale: {
      a: { x: aPt.x, y: aPt.y },
      b: { x: bPt.x, y: bPt.y },
      knownDistance,
      unit: unit as DistanceUnit,
      knownDistanceMeters,
      pixelDistance,
      metersPerPixel,
      calibratedAt,
    },
  };
}

/** 完整校验一份项目文件的原始解析结果 */
export function validateProject(raw: unknown):
  | { ok: true; project: ProjectFile }
  | { ok: false; error: string; path?: string } {
  if (!isPlainObject(raw)) {
    return fail('文件内容不是有效的 JSON 对象', '');
  }

  if (raw.app !== undefined && raw.app !== PROJECT_FILE_APP) {
    return fail(
      `不是本系统导出的项目文件（app = ${JSON.stringify(raw.app)}，应为 "${PROJECT_FILE_APP}"）`,
      'app',
    );
  }

  if (raw.version === undefined) return fail('缺少格式版本号（version）', 'version');
  if (raw.version !== PROJECT_FILE_VERSION) {
    return fail(
      `不支持的文件版本：${JSON.stringify(raw.version)}（当前支持 ${PROJECT_FILE_VERSION}）`,
      'version',
    );
  }

  const imageRes = checkImage(raw.image);
  if (!imageRes.ok) return imageRes;
  const { image } = imageRes;

  const nodesRes = checkNodes(raw.nodes, image.width, image.height);
  if (!nodesRes.ok) return nodesRes;

  const roadsRes = checkRoads(raw.roads, nodesRes.ids, image.width, image.height);
  if (!roadsRes.ok) return roadsRes;

  const scaleRes = checkScale(raw.scale);
  if (!scaleRes.ok) return scaleRes;

  // config 可选：缺失时用默认值补全，保证旧文件也能导入
  const configRaw = raw.config;
  let config: ProjectConfig;
  if (configRaw === undefined || configRaw === null) {
    config = { exportedAt: '', maxResults: 200 };
  } else if (!isPlainObject(configRaw)) {
    return fail('项目配置（config）必须是对象', 'config');
  } else {
    const maxResults = configRaw.maxResults;
    if (maxResults !== undefined && (!isFiniteNumber(maxResults) || maxResults <= 0 || !Number.isInteger(maxResults))) {
      return fail('项目配置的 maxResults 必须是正整数', 'config.maxResults');
    }
    config = {
      exportedAt: typeof configRaw.exportedAt === 'string' ? configRaw.exportedAt : '',
      maxResults: typeof maxResults === 'number' ? maxResults : 200,
    };
  }

  return {
    ok: true,
    project: {
      app: PROJECT_FILE_APP,
      version: PROJECT_FILE_VERSION,
      image,
      nodes: nodesRes.nodes,
      roads: roadsRes.roads,
      scale: scaleRes.scale,
      config,
    },
  };
}

/** 序列化为可直接写入文件的 JSON 文本 */
export function serializeProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

/** 生成导出文件名：项目名 + 时间戳 */
export function makeProjectFileName(fileName: string, now = new Date()): string {
  const base = (fileName || 'project').replace(/\.[^./\\]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base}-${stamp}${PROJECT_FILE_EXT}`;
}
