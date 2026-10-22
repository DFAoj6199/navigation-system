import {
  PROJECT_FILE_APP,
  PROJECT_FILE_VERSION,
  serializeProject,
  validateProject,
  type ProjectFile,
} from './project';
import type { MapNode, Road } from '../types';
import type { MapScale } from './scale';
import type { SearchLimits } from './pathfinding';

/**
 * 项目文件的浏览器侧读写。
 *
 * 全部在本地完成：导出用 Blob + <a download> 触发保存，导入用 FileReader 读取文本，
 * 不发起任何网络请求，也不上传数据。
 */

/** 读取 File 为文本 */
export function readFileAsText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败，请重试'));
    reader.readAsText(file);
  });
}

/** 读取 File 为 base64 data URL（用于把底图内嵌进项目文件） */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      if (!result.startsWith('data:')) {
        reject(new Error('图片编码失败'));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(new Error('图片读取失败，请重试'));
    reader.readAsDataURL(file);
  });
}

/** 组装项目文件对象 */
export function buildProjectFile(input: {
  image: { fileName: string; width: number; height: number; mimeType: string };
  imageDataUrl: string | null;
  nodes: MapNode[];
  roads: Road[];
  scale: MapScale | null;
  searchLimits: SearchLimits;
  now?: Date;
}): ProjectFile {
  const now = input.now ?? new Date();
  return {
    app: PROJECT_FILE_APP,
    version: PROJECT_FILE_VERSION,
    image: { ...input.image, dataUrl: input.imageDataUrl },
    nodes: input.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      point: { x: n.point.x, y: n.point.y },
      type: n.type,
      createdAt: n.createdAt,
    })),
    roads: input.roads.map((r) => ({
      id: r.id,
      ...(r.name !== undefined ? { name: r.name } : {}),
      fromNodeId: r.fromNodeId,
      toNodeId: r.toNodeId,
      points: r.points.map((p) => ({ x: p.x, y: p.y })),
      createdAt: r.createdAt,
    })),
    scale: input.scale ? { ...input.scale } : null,
    config: {
      exportedAt: now.toISOString(),
      maxResults: input.searchLimits.maxResults,
    },
  };
}

/** 触发浏览器下载 */
export function downloadText(text: string, fileName: string, mimeType = 'application/json'): void {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 交给浏览器完成下载后再释放
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 解析并校验项目文件文本；把 JSON 语法错误也翻译成中文提示 */
export function parseProjectText(text: string):
  | { ok: true; project: ProjectFile }
  | { ok: false; error: string; path?: string } {
  if (!text.trim()) {
    return { ok: false, error: '文件内容为空，请选择有效的项目 JSON 文件' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `JSON 格式错误，无法解析：${detail}` };
  }
  return validateProject(raw);
}

/** 便捷：把项目文件序列化为文本 */
export { serializeProject };
