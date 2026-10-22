import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  DEFAULT_ZOOM_LIMITS,
  centeredOffset,
  clamp,
  clampOffset,
  computeFitZoom,
  screenToPixel,
  zoomAt,
} from '../lib/viewport';
import type { ViewportSize } from '../lib/viewport';
import { NODE_TYPE_COLORS } from '../lib/constants';
import type { MapNode, PixelPoint } from '../types';
import { RoadLayer } from './RoadLayer';
import styles from './MapViewport.module.css';

/** 地图交互模式 */
export type MapMode = 'pan' | 'add' | 'draw';

interface MapViewportProps {
  /**
   * 当前交互模式：
   *   pan  拖动/浏览（点击可选中节点或道路）
   *   add  点击添加节点
   *   draw 点击添加道路中间点
   */
  mode: MapMode;
  /**
   * 当前所在的管理页签。
   * 比例尺校准点只在“比例尺”页签显示；切换到其他页签时暂时隐藏，
   * 避免校准标记长期遮挡节点与道路，但不影响已保存的比例尺。
   */
  activeTab?: string;
}

const ZOOM_STEP = 1.15;

/**
 * 地图视口：负责底图渲染、缩放、拖动、以及把点击位置换算成原始图片像素坐标。
 *
 * 坐标系说明：
 *   - 容器 .canvas 为定位基准；
 *   - 内部 .layer 使用 transform: translate(offsetX, offsetY) scale(zoom)，
 *     transform-origin 为 0 0，因此 屏幕坐标 = 像素坐标 * zoom + offset；
 *   - 图片与 SVG 节点层都设置 width/height 为原始像素尺寸，并施加同一变换，
 *     所以节点的像素坐标与底图像素严格一一对应，缩放/拖动/改变窗口大小时不会漂移。
 */
export function MapViewport({ mode, activeTab }: MapViewportProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [hoverPixel, setHoverPixel] = useState<{ x: number; y: number } | null>(null);
  const dragState = useRef<{ pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number; moved: boolean } | null>(null);

  const imageUrl = useAppStore((s) => s.imageUrl);
  const image = useAppStore((s) => s.image);
  const imageWidth = useAppStore((s) => s.imageWidth);
  const imageHeight = useAppStore((s) => s.imageHeight);
  const nodes = useAppStore((s) => s.nodes);
  const roads = useAppStore((s) => s.roads);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectedRoadId = useAppStore((s) => s.selectedRoadId);
  const draft = useAppStore((s) => s.draft);
  const search = useAppStore((s) => s.search);
  const startNodeId = useAppStore((s) => s.startNodeId);
  const endNodeId = useAppStore((s) => s.endNodeId);
  const camera = useAppStore((s) => s.camera);
  const viewInitialized = useAppStore((s) => s.viewInitialized);
  const setCamera = useAppStore((s) => s.setCamera);
  const markViewInitialized = useAppStore((s) => s.markViewInitialized);
  const addNodeAtPixel = useAppStore((s) => s.addNodeAtPixel);
  const selectNode = useAppStore((s) => s.selectNode);
  const selectRoad = useAppStore((s) => s.selectRoad);
  const addDraftPoint = useAppStore((s) => s.addDraftPoint);
  const updateDraftPoint = useAppStore((s) => s.updateDraftPoint);
  const updateRoadPoint = useAppStore((s) => s.updateRoadPoint);
  const pushNotice = useAppStore((s) => s.pushNotice);
  // 比例尺校准：点选模式下点击地图即记录一个校准点
  const scalePicking = useAppStore((s) => s.scalePicking);
  const scalePointA = useAppStore((s) => s.scalePointA);
  const scalePointB = useAppStore((s) => s.scalePointB);
  const scaleNextPoint = useAppStore((s) => s.scaleNextPoint);
  const pickScalePoint = useAppStore((s) => s.pickScalePoint);

  // 校准点只在“比例尺”页签可见：离开该页签即暂时隐藏（比例尺数据本身不受影响）
  const showScaleLayer = activeTab === 'scale' && Boolean(scalePointA || scalePointB);
  // 点选只在“比例尺”页签生效，避免隐藏标记后仍在地图上记录校准点
  const scalePickActive = scalePicking && activeTab === 'scale';

  /** 正在拖动的中间点（草稿点或已存道路的中间点） */
  const pointDragRef = useRef<
    | { kind: 'draft'; index: number }
    | { kind: 'road'; roadId: string; index: number }
    | null
  >(null);

  // ---- 监听容器尺寸变化（含浏览器窗口缩放）----
  // 注意：空状态时本组件不渲染画布（提前 return），因此必须依赖 imageUrl，
  // 在画布真正挂载后重新绑定，否则尺寸会一直是 0，导致缩放/适配全部失效。
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    // 使用 getBoundingClientRect 兜底，避免个别环境下 clientWidth 读到 0
    const observer = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(el.clientWidth || rect.width);
      const height = Math.round(el.clientHeight || rect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [imageUrl]);

  // ---- 首次拿到图片/视口尺寸后，自动适配居中 ----
  useEffect(() => {
    if (!image || viewInitialized) return;
    if (size.width <= 0 || size.height <= 0) return;
    const fitZoom = clamp(computeFitZoom(imageWidth, imageHeight, size), DEFAULT_ZOOM_LIMITS.min, DEFAULT_ZOOM_LIMITS.max);
    const offset = centeredOffset(imageWidth, imageHeight, fitZoom, size);
    setCamera({ zoom: fitZoom, offsetX: offset.offsetX, offsetY: offset.offsetY });
    markViewInitialized();
  }, [image, viewInitialized, size, imageWidth, imageHeight, setCamera, markViewInitialized]);

  // ---- 窗口尺寸变化时夹取平移量，保证图片不会完全跑出视口 ----
  useEffect(() => {
    if (!image || !viewInitialized) return;
    if (size.width <= 0 || size.height <= 0) return;
    const offsetX = clampOffset(camera.offsetX, imageWidth, size.width, camera.zoom);
    const offsetY = clampOffset(camera.offsetY, imageHeight, size.height, camera.zoom);
    if (offsetX !== camera.offsetX || offsetY !== camera.offsetY) {
      setCamera({ ...camera, offsetX, offsetY });
    }
  }, [size, image, viewInitialized, camera, imageWidth, imageHeight, setCamera]);

  const applyCamera = useCallback(
    (zoom: number, offsetX: number, offsetY: number) => {
      setCamera({
        zoom,
        offsetX: clampOffset(offsetX, imageWidth, size.width, zoom),
        offsetY: clampOffset(offsetY, imageHeight, size.height, zoom),
      });
    },
    [imageWidth, imageHeight, size.width, size.height, setCamera],
  );

  const zoomBy = useCallback(
    (factor: number, anchorScreenX?: number, anchorScreenY?: number) => {
      if (size.width <= 0 || size.height <= 0) return;
      const anchorX = anchorScreenX ?? size.width / 2;
      const anchorY = anchorScreenY ?? size.height / 2;
      const next = zoomAt(anchorX, anchorY, { ...camera }, camera.zoom * factor, DEFAULT_ZOOM_LIMITS);
      applyCamera(next.zoom, next.offsetX, next.offsetY);
    },
    [camera, applyCamera, size.width, size.height],
  );

  const fitToScreen = useCallback(() => {
    if (!image || size.width <= 0 || size.height <= 0) return;
    const fitZoom = clamp(computeFitZoom(imageWidth, imageHeight, size), DEFAULT_ZOOM_LIMITS.min, DEFAULT_ZOOM_LIMITS.max);
    const offset = centeredOffset(imageWidth, imageHeight, fitZoom, size);
    setCamera({ zoom: fitZoom, offsetX: offset.offsetX, offsetY: offset.offsetY });
  }, [image, size, imageWidth, imageHeight, setCamera]);

  const resetToActualSize = useCallback(() => {
    if (!image || size.width <= 0 || size.height <= 0) return;
    const zoom = 1;
    const offset = centeredOffset(imageWidth, imageHeight, zoom, size);
    applyCamera(zoom, offset.offsetX, offset.offsetY);
  }, [image, size, imageWidth, imageHeight, applyCamera]);

  // ---- 滚轮缩放（以鼠标位置为锚点）----
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!image) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      // 扣掉 1px 边框：我们的坐标系原点在“内容区”左上角，而非边框盒左上角
      const anchorX = event.clientX - rect.left - el.clientLeft;
      const anchorY = event.clientY - rect.top - el.clientTop;
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const next = zoomAt(anchorX, anchorY, { ...camera }, camera.zoom * factor, DEFAULT_ZOOM_LIMITS);
      setCamera({
        zoom: next.zoom,
        offsetX: clampOffset(next.offsetX, imageWidth, size.width, next.zoom),
        offsetY: clampOffset(next.offsetY, imageHeight, size.height, next.zoom),
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [image, camera, imageWidth, imageHeight, size.width, size.height, setCamera]);

  const toPixel = useCallback(
    (clientX: number, clientY: number) => {
      const el = canvasRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      // 同样扣掉边框，保证点击落点、悬停读数与滚轮锚点使用同一套原点
      const x = clientX - rect.left - el.clientLeft;
      const y = clientY - rect.top - el.clientTop;
      return screenToPixel(x, y, camera);
    },
    [camera],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!image) return;
    if (event.button !== 0 && event.button !== 1) return;
    // 添加节点 / 绘制道路模式下，左键点击交给 click 逻辑处理，不进入平移
    // 校准点选模式下左键用于记录校准点，不进入平移
    if (scalePickActive && event.button === 0) return;
    if ((mode === 'add' || mode === 'draw') && event.button === 0) return;
    const el = canvasRef.current;
    if (!el) return;
    el.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: camera.offsetX,
      offsetY: camera.offsetY,
      moved: false,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!image) return;
    const pixel = toPixel(event.clientX, event.clientY);
    if (pixel) {
      setHoverPixel({
        x: Math.round(pixel.x),
        y: Math.round(pixel.y),
      });
    }

    // ---- 拖动中间点 ----
    const pointDrag = pointDragRef.current;
    if (pointDrag && pixel) {
      if (pointDrag.kind === 'draft') {
        updateDraftPoint(pointDrag.index, pixel.x, pixel.y);
      } else {
        updateRoadPoint(pointDrag.roadId, pointDrag.index, pixel.x, pixel.y);
      }
      return;
    }

    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) > 3) {
      drag.moved = true;
    }
    if (!drag.moved) return;
    setCamera({
      zoom: camera.zoom,
      offsetX: clampOffset(drag.offsetX + dx, imageWidth, size.width, camera.zoom),
      offsetY: clampOffset(drag.offsetY + dy, imageHeight, size.height, camera.zoom),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    // 结束中间点拖动
    if (pointDragRef.current) {
      pointDragRef.current = null;
      return;
    }

    const drag = dragState.current;
    const isSamePointer = drag !== null && drag.pointerId === event.pointerId;
    if (isSamePointer) {
      dragState.current = null;
      setIsDragging(false);
    }
    // 只把“未发生拖动的左键抬起”视为一次点击
    const isClick = event.type === 'pointerup' && event.button === 0 && drag === null;

    if (isClick && scalePickActive) {
      const pixel = toPixel(event.clientX, event.clientY);
      if (!pixel) return;
      const point = { x: Math.round(pixel.x), y: Math.round(pixel.y) };
      pickScalePoint(point);
      pushNotice('info', `已记录校准点 (${point.x}, ${point.y})`);
      return;
    }

    if (isClick && mode === 'add') {
      const pixel = toPixel(event.clientX, event.clientY);
      if (!pixel) return;
      const result = addNodeAtPixel(pixel.x, pixel.y);
      if (result.ok && result.node) {
        pushNotice(
          'success',
          `已在像素坐标 (${result.node.point.x}, ${result.node.point.y}) 添加节点“${result.node.name}”`,
        );
      } else {
        pushNotice('error', result.error ?? '添加节点失败');
      }
      return;
    }

    if (isClick && mode === 'draw') {
      const pixel = toPixel(event.clientX, event.clientY);
      if (!pixel) return;
      const result = addDraftPoint(pixel.x, pixel.y);
      if (!result.ok) {
        pushNotice('error', result.error ?? '添加中间点失败');
      }
    }
  };

  /** 开始拖动草稿中间点 */
  const handleDragDraftPointStart = (event: React.PointerEvent<SVGCircleElement>, index: number) => {
    event.stopPropagation();
    pointDragRef.current = { kind: 'draft', index };
    canvasRef.current?.setPointerCapture(event.pointerId);
  };

  /** 开始拖动已存道路的中间点 */
  const handleDragRoadPointStart = (
    event: React.PointerEvent<SVGCircleElement>,
    roadId: string,
    index: number,
  ) => {
    event.stopPropagation();
    selectRoad(roadId);
    pointDragRef.current = { kind: 'road', roadId, index };
    canvasRef.current?.setPointerCapture(event.pointerId);
  };

  if (!image || !imageUrl) {
    return (
      <div className={styles.emptyState} data-testid="map-empty">
        <div className={styles.emptyIcon} aria-hidden="true">🗺️</div>
        <h2 className={styles.emptyTitle}>尚未加载地图</h2>
        <p className={styles.emptyText}>
          请在左侧“地图底图”区域点击 <strong>上传地图图片</strong>，选择本地的天河体育中心周边地图。
          <br />
          本系统不会联网获取地图，底图完全来自你上传的文件。
        </p>
      </div>
    );
  }

  const pixelReadout = hoverPixel
    ? hoverPixel.x < 0 || hoverPixel.y < 0 || hoverPixel.x > imageWidth || hoverPixel.y > imageHeight
      ? `超出地图范围 (${hoverPixel.x}, ${hoverPixel.y})`
      : `像素坐标 X=${hoverPixel.x} Y=${hoverPixel.y}`
    : '将鼠标移到地图上查看像素坐标';

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar} role="toolbar" aria-label="地图视图工具">
        <button type="button" onClick={() => zoomBy(1 / ZOOM_STEP)} title="缩小" aria-label="缩小">−</button>
        <span className={styles.zoomValue} data-testid="zoom-value">{Math.round(camera.zoom * 100)}%</span>
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} title="放大" aria-label="放大">＋</button>
        <span className={styles.divider} />
        <button type="button" onClick={fitToScreen} data-testid="view-fit">适配窗口</button>
        <button type="button" onClick={resetToActualSize} data-testid="view-actual">原始像素 1:1</button>
        <span className={styles.divider} />
        <span className={styles.meta} data-testid="image-meta">
          {image.fileName} · {imageWidth}×{imageHeight}px
        </span>
      </div>

      <div
        ref={canvasRef}
        className={[
          styles.canvas,
          mode === 'add' ? styles.canvasAdd : '',
          mode === 'draw' ? styles.canvasDraw : '',
          mode === 'pan' || isDragging ? (isDragging ? styles.canvasDragging : styles.canvasPan) : '',
        ].join(' ')}
        data-testid="map-canvas"
        data-mode={mode}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHoverPixel(null)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div
          className={styles.layer}
          style={{
            width: imageWidth,
            height: imageHeight,
            transform: `translate(${camera.offsetX}px, ${camera.offsetY}px) scale(${camera.zoom})`,
          }}
          data-testid="map-layer"
          data-zoom={camera.zoom}
          data-offset-x={camera.offsetX}
          data-offset-y={camera.offsetY}
        >
          <img
            src={imageUrl}
            alt="用户上传的地图底图"
            className={styles.image}
            draggable={false}
            width={imageWidth}
            height={imageHeight}
          />

          {/* 节点层：与底图共用同一 transform，坐标单位为原始图片像素 */}
          <svg
            className={styles.nodeLayer}
            viewBox={`0 0 ${imageWidth} ${imageHeight}`}
            width={imageWidth}
            height={imageHeight}
            data-testid="node-layer"
          >
            {/* 道路图层放在节点下方，保证节点始终可见、可点选 */}
            <RoadLayer
              roads={roads}
              nodes={nodes}
              zoom={camera.zoom}
              selectedRoadId={selectedRoadId}
              draftPoints={draft?.points ?? []}
              draftFromNodeId={draft?.fromNodeId}
              draftToNodeId={draft?.toNodeId}
              editable={mode === 'pan' || mode === 'draw'}
              onSelectRoad={selectRoad}
              onDragPointStart={handleDragRoadPointStart}
              onDragDraftPointStart={handleDragDraftPointStart}
            />
            {/* 寻路结果高亮：与底图共用同一 transform，缩放拖动严格对齐 */}
            <PathHighlightLayer
              polyline={search.highlightedPolyline}
              zoom={camera.zoom}
              startNodeId={startNodeId}
              endNodeId={endNodeId}
              nodes={nodes}
            />
            {/* 比例尺校准点与连线：仅在“比例尺”页签显示，切到其他页签暂时隐藏 */}
            {showScaleLayer && (
              <g data-testid="scale-layer">
                {scalePointA && scalePointB && (
                  <line
                    x1={scalePointA.x}
                    y1={scalePointA.y}
                    x2={scalePointB.x}
                    y2={scalePointB.y}
                    stroke="#dc2626"
                    strokeWidth={3 / camera.zoom}
                    strokeDasharray={`${8 / camera.zoom} ${5 / camera.zoom}`}
                    data-testid="scale-line"
                  />
                )}
                {scalePointA && (
                  <g data-testid="scale-point-a-marker">
                    <circle cx={scalePointA.x} cy={scalePointA.y} r={8 / camera.zoom} fill="#dc2626" stroke="#fff" strokeWidth={2.5 / camera.zoom} />
                    <text x={scalePointA.x + 12 / camera.zoom} y={scalePointA.y} fontSize={12 / camera.zoom} fill="#dc2626" paintOrder="stroke" stroke="#fff" strokeWidth={3 / camera.zoom}>A</text>
                  </g>
                )}
                {scalePointB && (
                  <g data-testid="scale-point-b-marker">
                    <circle cx={scalePointB.x} cy={scalePointB.y} r={8 / camera.zoom} fill="#dc2626" stroke="#fff" strokeWidth={2.5 / camera.zoom} />
                    <text x={scalePointB.x + 12 / camera.zoom} y={scalePointB.y} fontSize={12 / camera.zoom} fill="#dc2626" paintOrder="stroke" stroke="#fff" strokeWidth={3 / camera.zoom}>B</text>
                  </g>
                )}
              </g>
            )}

            {nodes.map((node) => {
              const isSelected = node.id === selectedNodeId;
              // 标记尺寸随缩放反向补偿，保持屏幕上大小恒定、易点击
              const r = 9 / camera.zoom;
              const strokeW = 2.5 / camera.zoom;
              const fontSize = 12 / camera.zoom;
              return (
                <g
                  key={node.id}
                  data-node-id={node.id}
                  data-node-marker="true"
                  data-pixel-x={node.point.x}
                  data-pixel-y={node.point.y}
                  className={styles.nodeGroup}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    selectNode(node.id);
                  }}
                  role="button"
                  tabIndex={-1}
                  aria-label={`节点 ${node.name} (${node.point.x}, ${node.point.y})`}
                >
                  {isSelected && (
                    <circle
                      cx={node.point.x}
                      cy={node.point.y}
                      r={r + 5 / camera.zoom}
                      fill="none"
                      stroke="#fbbf24"
                      strokeWidth={3 / camera.zoom}
                    />
                  )}
                  <circle
                    cx={node.point.x}
                    cy={node.point.y}
                    r={r}
                    fill={NODE_TYPE_COLORS[node.type]}
                    stroke="#ffffff"
                    strokeWidth={strokeW}
                  />
                  <text
                    x={node.point.x + r + 4 / camera.zoom}
                    y={node.point.y + fontSize / 3}
                    fontSize={fontSize}
                    className={styles.nodeLabel}
                    paintOrder="stroke"
                    stroke="#ffffff"
                    strokeWidth={3 / camera.zoom}
                  >
                    {node.name}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className={styles.statusBar}>
        <span className={styles.statusPixel} data-testid="pixel-readout">{pixelReadout}</span>
        <span className={styles.statusHint}>
          {mode === 'add'
            ? '点击模式：在地图上单击即可在对应像素位置添加节点'
            : scalePickActive
              ? '比例尺校准模式：点击地图记录校准点（原始像素坐标）'
              : mode === 'draw'
              ? '绘制模式：在道路上连续单击添加中间点，点“完成绘制”保存'
              : '拖动模式：按住鼠标拖动平移，滚轮缩放；点击节点/道路可选中，拖动白色圆点可编辑中间点'}
        </span>
      </div>
      {mode === 'add' && (
        <div className={styles.addBanner} data-testid="add-mode-banner">
          ➕ 添加节点模式已开启：单击地图放置节点；完成后请切回“拖动 / 浏览”模式以免误加
        </div>
      )}
      {scalePickActive && (
        <div className={styles.scaleBanner} data-testid="scale-mode-banner">
          📏 比例尺校准中：请在地图上点击{scaleNextPoint === 'a' ? '第 1 个点（A）' : '第 2 个点（B）'}
        </div>
      )}
      {mode === 'draw' && (
        <div className={styles.drawBanner} data-testid="draw-mode-banner">
          ✏️ 道路绘制中：在道路上单击添加中间点（可多个）· 当前中间点 {draft?.points.length ?? 0} 个
        </div>
      )}
    </div>
  );
}

interface PathHighlightLayerProps {
  polyline: PixelPoint[];
  zoom: number;
  startNodeId: string;
  endNodeId: string;
  nodes: MapNode[];
}

/**
 * 寻路结果高亮层。
 *
 * 点坐标全部是原始图片像素，与底图共用同一个 transform，
 * 因此缩放、拖动时高亮路线始终贴合道路，不会漂移。
 * 线宽/标记尺寸按 1/zoom 反向补偿，保持屏幕上大小恒定。
 */
function PathHighlightLayer({ polyline, zoom, startNodeId, endNodeId, nodes }: PathHighlightLayerProps) {
  if (polyline.length < 2) {
    // 起终点相同（零长度路径）：只标出起终点，不画线
    if (startNodeId && startNodeId === endNodeId) {
      const node = nodes.find((n) => n.id === startNodeId);
      if (!node) return null;
      return (
        <g data-testid="path-highlight">
          <circle
            cx={node.point.x}
            cy={node.point.y}
            r={14 / zoom}
            fill="none"
            stroke="#7c3aed"
            strokeWidth={3 / zoom}
            strokeDasharray={`${4 / zoom} ${3 / zoom}`}
          />
        </g>
      );
    }
    return null;
  }

  const pointsAttr = polyline.map((p) => `${p.x},${p.y}`).join(' ');
  const first = polyline[0];
  const last = polyline[polyline.length - 1];

  return (
    <g data-testid="path-highlight" data-point-count={polyline.length} data-points={pointsAttr}>
      {/* 外发光底色，保证在任意底图上都清晰可见 */}
      <polyline
        points={pointsAttr}
        fill="none"
        stroke="#ffffff"
        strokeWidth={12 / zoom}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
      <polyline
        points={pointsAttr}
        fill="none"
        stroke="#7c3aed"
        strokeWidth={7 / zoom}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={`${16 / zoom} ${7 / zoom}`}
      />
      {/* 起点/终点标记 */}
      <circle cx={first.x} cy={first.y} r={11 / zoom} fill="#7c3aed" stroke="#ffffff" strokeWidth={3 / zoom} data-highlight="start" />
      <circle cx={last.x} cy={last.y} r={11 / zoom} fill="#db2777" stroke="#ffffff" strokeWidth={3 / zoom} data-highlight="end" />
    </g>
  );
}
