import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_BYTES } from './constants';

/**
 * 图片上传与解码工具。
 *
 * 安全约束（项目需求：地图必须由用户自行上传，禁止联网获取）：
 *   - 本模块只读取用户通过 <input type="file"> 选择的本地文件；
 *   - 只在浏览器内用 createObjectURL / Image 解码，不发起任何网络请求；
 *   - 不内置任何底图，不提供示例地图 URL。
 */

export interface LoadedImage {
  /** 对象 URL，用于 <img src>；使用后需调用 URL.revokeObjectURL 释放 */
  objectUrl: string;
  width: number;
  height: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ImageLoadError {
  message: string;
}

/** 校验文件类型与大小（不读取内容） */
export function validateImageFile(file: File): string | null {
  if (file.size === 0) return '文件内容为空，请重新选择地图图片';
  if (file.size > MAX_IMAGE_BYTES) {
    return `图片过大（${(file.size / 1024 / 1024).toFixed(1)}MB），请选择小于 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 的图片`;
  }
  const type = file.type.toLowerCase();
  const hasValidMime = ACCEPTED_IMAGE_TYPES.includes(type);
  // 部分浏览器对 bmp/avif 的 type 可能为空，此时退化为按扩展名判断
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const hasValidExt = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'].includes(ext);
  if (!hasValidMime && !hasValidExt) {
    return '不支持的文件格式，请上传 PNG、JPG、WEBP、GIF、BMP 或 AVIF 图片';
  }
  return null;
}

/**
 * 解码图片并取得原始像素尺寸。
 * 失败时返回明确的中文错误信息（例如文件损坏或伪装成图片的文本文件）。
 */
export function loadImageFile(file: File): Promise<LoadedImage> {
  const validationError = validateImageFile(file);
  if (validationError) {
    return Promise.reject(new Error(validationError));
  }

  return new Promise<LoadedImage>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('无法读取图片尺寸，文件可能已损坏'));
        return;
      }
      resolve({
        objectUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        fileName: file.name,
        mimeType: file.type || 'image/*',
        sizeBytes: file.size,
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('图片解码失败，文件可能已损坏或不是有效的图片格式'));
    };

    img.src = objectUrl;
  });
}
