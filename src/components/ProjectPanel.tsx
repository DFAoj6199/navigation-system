import { useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  MAX_EMBEDDED_IMAGE_CHARS,
  makeProjectFileName,
  serializeProject,
  type ProjectFile,
} from '../lib/project';
import {
  buildProjectFile,
  downloadText,
  parseProjectText,
  readFileAsText,
} from '../lib/projectIO';
import { describeScale } from '../lib/scale';
import styles from './ProjectPanel.module.css';

/**
 * 项目面板：导出 / 导入项目 JSON。
 *
 * 导入流程（严格三步，任何一步失败都不会破坏当前数据）：
 *   1. 读取并校验整份文件 —— 校验纯函数，完全不接触 store；
 *   2. 若有未保存数据，弹出覆盖确认 —— 取消则直接返回，原数据一字不改；
 *   3. 校验与确认都通过后，才一次性替换 store 中的项目数据。
 */
export function ProjectPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorPath, setErrorPath] = useState<string | null>(null);
  const [pending, setPending] = useState<ProjectFile | null>(null);
  const [importingName, setImportingName] = useState<string>('');

  const image = useAppStore((s) => s.image);
  const nodes = useAppStore((s) => s.nodes);
  const roads = useAppStore((s) => s.roads);
  const scale = useAppStore((s) => s.scale);
  const searchLimits = useAppStore((s) => s.searchLimits);
  const imageDataUrl = useAppStore((s) => s.imageDataUrl);
  const importProject = useAppStore((s) => s.importProject);
  const pushNotice = useAppStore((s) => s.pushNotice);

  /** 当前项目是否含有值得提醒用户保护的数据 */
  const hasData = Boolean(image) || nodes.length > 0 || roads.length > 0;

  const handleExport = () => {
    setError(null);
    setErrorPath(null);
    try {
      if (!image) {
        setError('当前没有可导出的项目：请先加载地图底图');
        return;
      }
      if (imageDataUrl && imageDataUrl.length > MAX_EMBEDDED_IMAGE_CHARS) {
        setError('底图过大，无法内嵌到项目文件；请改用更小的地图图片');
        return;
      }
      const project = buildProjectFile({
        image,
        imageDataUrl,
        nodes,
        roads,
        scale,
        searchLimits,
      });
      downloadText(serializeProject(project), makeProjectFileName(image.fileName));
      pushNotice(
        'success',
        imageDataUrl
          ? `已导出项目：${nodes.length} 个节点、${roads.length} 条道路，底图已内嵌`
          : `已导出项目：${nodes.length} 个节点、${roads.length} 条道路（该底图未内嵌图片，导入后需重新选择底图）`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : '导出失败';
      setError(message);
      pushNotice('error', message);
    }
  };

  /** 第 1 步：读取 + 校验 */
  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setErrorPath(null);
    setPending(null);
    setBusy(true);
    setImportingName(file.name);
    try {
      const text = await readFileAsText(file);
      const result = parseProjectText(text);
      if (!result.ok) {
        setError(result.error);
        setErrorPath(result.path ?? null);
        pushNotice('error', `导入失败：${result.error}`);
        return;
      }
      // 第 2 步：有数据时先确认，取消则什么都不做
      if (hasData) {
        setPending(result.project);
        return;
      }
      await commitImport(result.project);
    } catch (e) {
      const message = e instanceof Error ? e.message : '文件读取失败';
      setError(message);
      pushNotice('error', message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  /** 第 3 步：真正写入 store */
  const commitImport = async (project: ProjectFile) => {
    setBusy(true);
    try {
      const dataUrl = project.image.dataUrl;
      importProject({
        image: {
          fileName: project.image.fileName,
          width: project.image.width,
          height: project.image.height,
          mimeType: project.image.mimeType,
        },
        imageDataUrl: dataUrl,
        objectUrl: dataUrl,
        nodes: project.nodes,
        roads: project.roads,
        scale: project.scale,
        searchLimits: project.config?.maxResults
          ? { ...searchLimits, maxResults: project.config.maxResults }
          : undefined,
      });
      setPending(null);
      const parts = [
        `已导入项目：${project.nodes.length} 个节点、${project.roads.length} 条道路`,
        project.scale ? '含比例尺校准' : '未校准比例尺',
      ];
      if (!dataUrl) {
        parts.push('该文件未内嵌底图，请在“节点管理”中重新选择地图图片');
        pushNotice('info', parts.join('；'));
      } else {
        pushNotice('success', parts.join('；'));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : '导入失败';
      setError(message);
      pushNotice('error', message);
    } finally {
      setBusy(false);
    }
  };

  /** 用户取消覆盖 */
  const handleCancelOverwrite = () => {
    setPending(null);
    pushNotice('info', '已取消导入，当前项目数据保持不变');
  };

  return (
    <section className={styles.panel} aria-labelledby="project-heading">
      <h2 id="project-heading" className={styles.heading}>项目数据</h2>

      <div className={styles.summary} data-testid="project-summary">
        <div className={styles.summaryRow}>
          <span className={styles.label}>底图</span>
          <span className={styles.value}>{image ? image.fileName : '未加载'}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.label}>尺寸</span>
          <span className={styles.value}>{image ? `${image.width} × ${image.height}` : '—'}</span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.label}>节点 / 道路</span>
          <span className={styles.value} data-testid="project-counts">
            {nodes.length} / {roads.length}
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.label}>比例尺</span>
          <span className={styles.value} data-testid="project-scale">
            {scale ? describeScale(scale) : '未校准'}
          </span>
        </div>
        <div className={styles.summaryRow}>
          <span className={styles.label}>图片内嵌</span>
          <span className={styles.value} data-testid="project-embed">
            {imageDataUrl ? `是（${Math.round(imageDataUrl.length / 1024)} KB）` : '否'}
          </span>
        </div>
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={handleExport}
          disabled={busy || !image}
          data-testid="project-export"
        >
          导出项目 JSON
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          data-testid="project-import"
        >
          {busy ? '正在处理…' : '导入项目 JSON'}
        </button>
      </div>

      <p className={styles.hint}>
        导出的 JSON 内嵌底图、原始尺寸、节点、道路折线中间点与比例尺参数，可在本机或其他电脑上完整恢复。
        <br />
        数据只保存在你导出的文件里，本系统不上传、也不自动写入浏览器本地存储。
      </p>

      {/* 覆盖确认：只有用户点“确认覆盖”才会写入 */}
      {pending && (
        <div className={styles.confirmBox} data-testid="project-confirm">
          <p className={styles.confirmTitle}>⚠️ 导入将替换当前项目</p>
          <p className={styles.confirmText}>
            当前项目有 {nodes.length} 个节点、{roads.length} 条道路
            {imageDataUrl ? '（含已内嵌的底图）' : ''}，导入后这些数据会被文件
            「{importingName}」中的数据替换，且无法撤销。
          </p>
          <p className={styles.confirmText}>
            文件内容：{pending.image.fileName}（{pending.image.width}×{pending.image.height}）、
            {pending.nodes.length} 个节点、{pending.roads.length} 条道路、
            {pending.scale ? describeScale(pending.scale) : '未校准比例尺'}
            {pending.image.dataUrl ? '、含内嵌底图' : '、未内嵌底图'}
          </p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => void commitImport(pending)}
              data-testid="project-confirm-overwrite"
            >
              确认覆盖
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={handleCancelOverwrite}
              data-testid="project-cancel-overwrite"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className={styles.error} role="alert" data-testid="project-error">
          <p>{error}</p>
          {errorPath && (
            <p className={styles.errorPath} data-testid="project-error-path">
              出错位置：{errorPath}
            </p>
          )}
          <p className={styles.errorHint}>当前项目数据未被修改。</p>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className={styles.hiddenInput}
        data-testid="project-file-input"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />

      {scale && (
        <p className={styles.footNote} data-testid="project-scale-note">
          备注：比例尺 {describeScale(scale)} 为近似估算，受底图透视变形影响，不具备测绘级精度。
        </p>
      )}
    </section>
  );
}
