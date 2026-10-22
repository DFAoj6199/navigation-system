/**
 * 阶段1 验收用 E2E 测试（真实 Chromium，由 Playwright 驱动）。
 *
 * 运行前提：开发服务器已在 http://127.0.0.1:5173 运行（或在 CI 中用 webServer 启动）。
 * 运行：pnpm test:e2e
 *
 * 重点验证（对应阶段1“必须验证的坐标逻辑”）：
 *   1. 点击地图 -> 屏幕坐标转换为原始图片像素坐标；
 *   2. 手动输入坐标以图片左上角为原点；
 *   3. 缩放、拖动、调整窗口大小后节点仍贴合原始位置；
 *   4. 超出图片范围的输入被明确阻止。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5173/';
const MAP_PATH = path.resolve(__dirname, '..', 'test-map.png');
const SHOT_DIR = path.resolve(__dirname, '..', 'test-results');
const IMAGE_W = 1600;
const IMAGE_H = 1200;

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

/** 读取相机状态（zoom/offset 来自被测页面真实 DOM 的 data 属性） */
async function readCamera(page) {
  return page.evaluate(() => {
    const layer = document.querySelector('[data-testid="map-layer"]');
    if (!layer) throw new Error('未找到 map-layer');
    const canvas = document.querySelector('[data-testid="map-canvas"]');
    const rect = canvas.getBoundingClientRect();
    return {
      zoom: Number(layer.dataset.zoom),
      offsetX: Number(layer.dataset.offsetX),
      offsetY: Number(layer.dataset.offsetY),
      // 内容区左上角 = 边框盒左上角 + 边框宽度（画布有 1px 边框）。
      // 页面的 offset 相对内容区，因此必须用 clientLeft/clientTop 校正，
      // 否则会产生恒定 1px 的测试偏差（产品本身不受影响）。
      canvasLeft: rect.left + canvas.clientLeft,
      canvasTop: rect.top + canvas.clientTop,
      canvasWidth: rect.width,
      canvasHeight: rect.height,
    };
  });
}

/** 由相机状态计算：某像素坐标在屏幕上的位置 */
function pixelToScreenPoint(cam, px, py) {
  return {
    x: cam.canvasLeft + px * cam.zoom + cam.offsetX,
    y: cam.canvasTop + py * cam.zoom + cam.offsetY,
  };
}

/** 读取某个节点圆心的真实屏幕位置（getBoundingClientRect） */
async function nodeCircleScreenRect(page, nodeId) {
  return page.evaluate((id) => {
    const group = document.querySelector(`[data-node-marker="true"][data-node-id="${id}"]`);
    if (!group) throw new Error(`未找到节点 ${id}`);
    const circle = group.querySelector('circle:not([fill="none"])');
    const r = circle.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  }, nodeId);
}

async function setViewportAndWait(page, width, height) {
  await page.setViewportSize({ width, height });
  // 等待 ResizeObserver 生效并完成夹取
  await page.waitForTimeout(350);
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  if (!fs.existsSync(MAP_PATH)) {
    throw new Error(`缺少测试地图：${MAP_PATH}`);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });

    // ---------- 1. 初始空状态 ----------
    await page.waitForSelector('[data-testid="map-empty"]');
    record('初始空状态显示上传提示', true, '显示“尚未加载地图”');
    await page.screenshot({ path: path.join(SHOT_DIR, '01-empty.png') });

    // ---------- 2. 上传地图（真实 file input） ----------
    // 阶段2 起默认是“查看模式”，列表隐藏；先切到节点管理页签，后续用例才能看到节点列表
    await page.click('[data-testid="tab-nodes"]');
    await page.waitForSelector('[data-testid="file-input"]');
    await page.setInputFiles('[data-testid="file-input"]', MAP_PATH);
    await page.waitForSelector('[data-testid="map-layer"]', { timeout: 10000 });
    const metaText = (await page.textContent('[data-testid="image-meta"]')) ?? '';
    record(
      '上传后显示原始尺寸',
      metaText.includes(`${IMAGE_W}×${IMAGE_H}px`),
      `工具栏显示: ${metaText.trim()}`,
    );

    // 等待自动“适配窗口”
    await page.waitForTimeout(500);
    let cam = await readCamera(page);
    record(
      '首次加载自动适配窗口(contain)',
      cam.zoom > 0 && cam.zoom < 1,
      `zoom=${cam.zoom.toFixed(4)}（1600x1200 装入视口必然 < 1）`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '02-loaded.png') });

    // ---------- 3. 手动输入坐标添加节点（原点在左上角） ----------
    await page.fill('[data-testid="input-x"]', '400');
    await page.fill('[data-testid="input-y"]', '300');
    await page.fill('[data-testid="input-name"]', '原点测试点');
    await page.click('[data-testid="add-node-submit"]');
    await page.waitForSelector('[data-testid="node-item"]');

    const coordsText1 = await page.getAttribute('[data-testid="node-coords"]', 'data-x');
    const coordsText1y = await page.getAttribute('[data-testid="node-coords"]', 'data-y');
    record(
      '手动输入坐标按原图像素保存',
      coordsText1 === '400' && coordsText1y === '300',
      `列表显示 X=${coordsText1}, Y=${coordsText1y}`,
    );

    // 验证该节点圆心在屏幕上的位置 = 像素坐标经相机变换后的位置
    const nodeId1 = await page.getAttribute('[data-testid="node-item"]', 'data-node-id');
    cam = await readCamera(page);
    let expected = pixelToScreenPoint(cam, 400, 300);
    let actualRect = await nodeCircleScreenRect(page, nodeId1);
    const err1 = Math.hypot(actualRect.cx - expected.x, actualRect.cy - expected.y);
    record(
      '节点(400,300)渲染位置与坐标换算一致',
      err1 < 1.5,
      `期望屏幕(${expected.x.toFixed(1)},${expected.y.toFixed(1)})，实际(${actualRect.cx.toFixed(1)},${actualRect.cy.toFixed(1)})，误差 ${err1.toFixed(2)}px`,
    );

    // ---------- 4. 点击地图添加节点：屏幕坐标 -> 像素坐标 ----------
    await page.click('[data-testid="mode-add"]');
    await page.waitForSelector('[data-testid="add-mode-banner"]');
    cam = await readCamera(page);
    // 选取一个明确的点击点：像素 (900, 700)
    const clickPoint = pixelToScreenPoint(cam, 900, 700);
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await page.waitForTimeout(250);

    const nodeItems = page.locator('[data-testid="node-item"]');
    const count = await nodeItems.count();
    const last = nodeItems.nth(count - 1);
    const clickedX = Number(await last.locator('[data-testid="node-coords"]').getAttribute('data-x'));
    const clickedY = Number(await last.locator('[data-testid="node-coords"]').getAttribute('data-y'));
    const clickErr = Math.abs(clickedX - 900) + Math.abs(clickedY - 700);
    record(
      '点击地图换算为原始像素坐标',
      count === 2 && clickErr <= 1,
      `点击像素(900,700)处，实际新增节点(${clickedX},${clickedY})，误差 ${clickErr}`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '03-two-nodes.png') });

    // ---------- 5. 超范围输入被阻止 ----------
    await page.click('[data-testid="mode-pan"]');
    await page.fill('[data-testid="input-x"]', '1601');
    await page.fill('[data-testid="input-y"]', '500');
    await page.click('[data-testid="add-node-submit"]');
    const errorText = (await page.textContent('[data-testid="add-node-error"]')) ?? '';
    const countAfterBad = await page.locator('[data-testid="node-item"]').count();
    record(
      'X 超范围被阻止并提示',
      errorText.includes('超出图片范围') && countAfterBad === 2,
      `提示：“${errorText.trim()}”，节点数仍为 ${countAfterBad}`,
    );

    await page.fill('[data-testid="input-x"]', '100');
    await page.fill('[data-testid="input-y"]', '-1');
    await page.click('[data-testid="add-node-submit"]');
    const errorTextY = (await page.textContent('[data-testid="add-node-error"]')) ?? '';
    const countAfterBadY = await page.locator('[data-testid="node-item"]').count();
    record(
      'Y 负值超范围被阻止并提示',
      errorTextY.includes('超出图片范围') && countAfterBadY === 2,
      `提示：“${errorTextY.trim()}”，节点数仍为 ${countAfterBadY}`,
    );

    await page.fill('[data-testid="input-x"]', 'abc');
    await page.click('[data-testid="add-node-submit"]');
    const errorTextNaN = (await page.textContent('[data-testid="add-node-error"]')) ?? '';
    record(
      '非数字输入被阻止',
      errorTextNaN.includes('必须是数字'),
      `提示：“${errorTextNaN.trim()}”`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '04-error.png') });

    // ---------- 6. 缩放后节点仍贴合 ----------
    // 把鼠标放在像素(400,300)对应的屏幕点上滚轮放大，验证锚点不动
    cam = await readCamera(page);
    const anchor = pixelToScreenPoint(cam, 400, 300);
    await page.mouse.move(anchor.x, anchor.y);
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(250);
    const camAfterZoom = await readCamera(page);
    expected = pixelToScreenPoint(camAfterZoom, 400, 300);
    actualRect = await nodeCircleScreenRect(page, nodeId1);
    const errZoom = Math.hypot(actualRect.cx - expected.x, actualRect.cy - expected.y);
    record(
      '滚轮缩放后节点(400,300)仍精确贴合',
      camAfterZoom.zoom > cam.zoom && errZoom < 1.5,
      `zoom ${cam.zoom.toFixed(3)} -> ${camAfterZoom.zoom.toFixed(3)}，误差 ${errZoom.toFixed(2)}px`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '05-zoomed.png') });

    // ---------- 7. 拖动后节点仍贴合 ----------
    await page.click('[data-testid="mode-pan"]');
    const dragStart = { x: camAfterZoom.canvasLeft + camAfterZoom.canvasWidth / 2, y: camAfterZoom.canvasTop + camAfterZoom.canvasHeight / 2 };
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await page.mouse.move(dragStart.x - 120, dragStart.y - 80, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const camAfterDrag = await readCamera(page);
    expected = pixelToScreenPoint(camAfterDrag, 400, 300);
    actualRect = await nodeCircleScreenRect(page, nodeId1);
    const errDrag = Math.hypot(actualRect.cx - expected.x, actualRect.cy - expected.y);
    record(
      '拖动平移后节点仍精确贴合',
      (camAfterDrag.offsetX !== camAfterZoom.offsetX || camAfterDrag.offsetY !== camAfterZoom.offsetY) && errDrag < 1.5,
      `offset (${camAfterZoom.offsetX.toFixed(1)},${camAfterZoom.offsetY.toFixed(1)}) -> (${camAfterDrag.offsetX.toFixed(1)},${camAfterDrag.offsetY.toFixed(1)})，误差 ${errDrag.toFixed(2)}px`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '06-dragged.png') });

    // ---------- 8. 调整窗口大小后节点仍贴合 ----------
    await setViewportAndWait(page, 1024, 700);
    const camAfterResize = await readCamera(page);
    expected = pixelToScreenPoint(camAfterResize, 400, 300);
    actualRect = await nodeCircleScreenRect(page, nodeId1);
    const errResize = Math.hypot(actualRect.cx - expected.x, actualRect.cy - expected.y);
    record(
      '调整浏览器窗口后节点仍精确贴合',
      errResize < 1.5,
      `视口 1024x700，zoom=${camAfterResize.zoom.toFixed(3)}，误差 ${errResize.toFixed(2)}px`,
    );

    // 同时验证“适配窗口”按钮在改变窗口后依然正确
    await page.click('button:has-text("适配窗口")');
    await page.waitForTimeout(250);
    const camFit = await readCamera(page);
    expected = pixelToScreenPoint(camFit, 400, 300);
    actualRect = await nodeCircleScreenRect(page, nodeId1);
    const errFit = Math.hypot(actualRect.cx - expected.x, actualRect.cy - expected.y);
    const renderedW = IMAGE_W * camFit.zoom;
    const renderedH = IMAGE_H * camFit.zoom;
    record(
      '适配窗口后整图可见且节点贴合',
      errFit < 1.5 && renderedW <= camFit.canvasWidth + 1 && renderedH <= camFit.canvasHeight + 1,
      `渲染尺寸 ${renderedW.toFixed(0)}x${renderedH.toFixed(0)} vs 视口 ${camFit.canvasWidth.toFixed(0)}x${camFit.canvasHeight.toFixed(0)}，误差 ${errFit.toFixed(2)}px`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '07-resized.png') });

    await setViewportAndWait(page, 1440, 900);

    // ---------- 9. 改名 ----------
    const firstItem = page.locator('[data-testid="node-item"]').first();
    await firstItem.locator('button:has-text("改名")').click();
    await page.fill('[data-testid="rename-input"]', '天河体育中心东门');
    await page.locator('[data-testid="node-item"]').first().locator('button:has-text("保存")').click();
    await page.waitForTimeout(200);
    const firstName = await page.locator('[data-testid="node-item"]').first().locator('span[title]').textContent();
    record('修改节点名称', firstName === '天河体育中心东门', `列表显示名称：${firstName}`);
    await page.screenshot({ path: path.join(SHOT_DIR, '08-renamed.png') });

    // ---------- 10. 删除节点 ----------
    // 阶段2 起删除节点会弹确认（若关联道路还会说明级联删除）
    page.once('dialog', (dialog) => dialog.accept());
    const beforeDelete = await page.locator('[data-testid="node-item"]').count();
    await page.locator('[data-testid="node-item"]').first().locator('[data-testid="node-delete"]').click();
    await page.waitForTimeout(300);
    const afterDelete = await page.locator('[data-testid="node-item"]').count();
    record('删除节点', afterDelete === beforeDelete - 1, `${beforeDelete} -> ${afterDelete}`);

    // ---------- 11. 选中节点 ----------
    await page.locator('[data-testid="node-item"]').first().click();
    const selectedCircle = await page.evaluate(() => document.querySelectorAll('[data-node-marker] circle[stroke="#fbbf24"]').length);
    record('选中节点高亮', selectedCircle === 1, `高亮圆数量=${selectedCircle}`);

    // ==========================================================
    // 阶段 2：双向道路管理与折线绘制
    // ==========================================================

    // ---------- 12. 道路列表只在管理模式显示 ----------
    await page.click('[data-testid="tab-view"]');
    await page.waitForTimeout(200);
    const roadsVisibleInView = await page.locator('[data-testid="road-panel"]').count();
    const nodesVisibleInView = await page.locator('[data-testid="node-list"]').count();
    record(
      '查看模式下道路/节点管理列表隐藏',
      roadsVisibleInView === 0 && nodesVisibleInView === 0,
      `查看模式中道路面板=${roadsVisibleInView}，节点列表=${nodesVisibleInView}`,
    );

    // 重新准备一组干净的节点用于道路测试
    await page.click('[data-testid="tab-nodes"]');
    await page.waitForTimeout(200);
    for (let i = 0; i < 6; i += 1) {
      if ((await page.locator('[data-testid="node-item"]').count()) === 0) break;
      page.once('dialog', (dialog) => dialog.accept());
      await page.locator('[data-testid="node-item"]').first().locator('[data-testid="node-delete"]').click();
      await page.waitForTimeout(120);
    }
    const addNode = async (x, y, name) => {
      await page.fill('[data-testid="input-x"]', String(x));
      await page.fill('[data-testid="input-y"]', String(y));
      await page.fill('[data-testid="input-name"]', name);
      await page.click('[data-testid="add-node-submit"]');
      await page.waitForTimeout(160);
    };
    await addNode(300, 300, '起点A');
    await addNode(1200, 900, '终点B');
    const nodeCountNow = await page.locator('[data-testid="node-item"]').count();
    record('准备两个端点节点', nodeCountNow === 2, `节点数=${nodeCountNow}`);

    // ---------- 13. 选择端点 -> 绘制道路 -> 连续点击多个中间点 ----------
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(250);
    const roadPanelVisible = await page.locator('[data-testid="road-panel"]').count();
    record('道路管理页签显示道路面板', roadPanelVisible === 1, `面板数=${roadPanelVisible}`);

    const nodeSelectValues = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="road-from-select"] option')]
        .map((o) => o.value)
        .filter(Boolean),
    );
    record('端点下拉框列出已有节点', nodeSelectValues.length === 2, `可选端点=${nodeSelectValues.length}`);

    await page.selectOption('[data-testid="road-from-select"]', nodeSelectValues[0]);
    await page.selectOption('[data-testid="road-to-select"]', nodeSelectValues[1]);
    await page.click('[data-testid="road-draw-start"]');
    await page.waitForTimeout(250);
    record(
      '点击“绘制道路”进入绘制模式',
      (await page.getAttribute('[data-testid="map-canvas"]', 'data-mode')) === 'draw',
      '画布 data-mode=draw',
    );

    // 在地图上连续点击 3 个中间点（用相机换算，确保落在指定像素）
    cam = await readCamera(page);
    const midPixels = [[500, 400], [700, 700], [950, 850]];
    for (const [px, py] of midPixels) {
      const pt = pixelToScreenPoint(cam, px, py);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(120);
    }
    const draftCountText = (await page.textContent('[data-testid="draft-point-count"]')) ?? '';
    record('连续点击添加多个中间点', draftCountText.includes('3'), `面板显示：${draftCountText.trim()}`);

    // ---------- 14. 完成绘制并校验数据 ----------
    await page.click('[data-testid="road-draw-commit"]');
    await page.waitForTimeout(350);
    const roadItems = await page.locator('[data-testid="road-item"]').count();
    const createdPoints = await page.getAttribute('[data-testid="road-point-count"]', 'data-points');
    record(
      '完成绘制后生成道路并保留全部中间点',
      roadItems === 1 && createdPoints === '500,400 700,700 950,850',
      `道路数=${roadItems}，中间点=${createdPoints}`,
    );

    // ---------- 15. 折线首尾与端点节点严格一致 ----------
    const geom = await page.evaluate(() => {
      const line = document.querySelector('[data-road-line="true"]');
      const pts = (line.getAttribute('data-points') || '').trim().split(/\s+/).map((s) => s.split(',').map(Number));
      const markers = [...document.querySelectorAll('[data-node-marker]')].map((m) => ({
        x: Number(m.getAttribute('data-pixel-x')),
        y: Number(m.getAttribute('data-pixel-y')),
      }));
      return { first: pts[0], last: pts[pts.length - 1], count: pts.length, markers };
    });
    const startMatches = geom.markers.some((m) => m.x === geom.first[0] && m.y === geom.first[1]);
    const endMatches = geom.markers.some((m) => m.x === geom.last[0] && m.y === geom.last[1]);
    record(
      '折线起点/终点与所选节点位置一致',
      startMatches && endMatches && geom.count === 5,
      `折线首点(${geom.first}) 末点(${geom.last})，共 ${geom.count} 个点（2 端点 + 3 中间点）`,
    );

    // ---------- 16. 缩放/拖动后折线仍与道路对齐 ----------
    // 校验方式：不自己推算屏幕坐标（易受边框/布局假设影响），
    // 而是用 SVG 自身的坐标变换 getScreenCTM 把折线顶点映射到屏幕，
    // 再与“节点圆心的真实 getBoundingClientRect”逐点比对。
    // 端点必须与节点圆心重合，中间点必须与手柄圆心重合 —— 这才是“折线贴合道路”的等价命题。
    const measureRoadAlignment = async () => {
      const data = await page.evaluate(() => {
        const group = document.querySelector('[data-road-line="true"]');
        if (!group) return null;
        const visible = [...group.querySelectorAll('polyline')].find(
          (pl) => pl.getAttribute('stroke') !== 'transparent' && pl.getAttribute('stroke') !== '#fbbf24',
        );
        const m = visible.getScreenCTM();
        const map = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
        const pts = visible
          .getAttribute('points')
          .trim()
          .split(/\s+/)
          .map((s) => s.split(',').map(Number))
          .map(([x, y]) => ({ px: x, py: y, ...map(x, y) }));
        const markers = [...document.querySelectorAll('[data-node-marker]')].map((mk) => {
          const c = mk.querySelector('circle:not([fill="none"])');
          const b = c.getBoundingClientRect();
          return {
            px: Number(mk.getAttribute('data-pixel-x')),
            py: Number(mk.getAttribute('data-pixel-y')),
            cx: b.left + b.width / 2,
            cy: b.top + b.height / 2,
          };
        });
        const handles = [...group.querySelectorAll('[data-road-point]')].map((h) => {
          const b = h.getBoundingClientRect();
          return {
            px: Number(h.getAttribute('data-pixel-x')),
            py: Number(h.getAttribute('data-pixel-y')),
            cx: b.left + b.width / 2,
            cy: b.top + b.height / 2,
          };
        });
        return { pts, markers, handles };
      });
      if (!data) return { ok: false, err: Infinity, detail: '未找到道路折线' };

      const errs = [];
      // 端点 ⇄ 节点圆心
      for (const pt of [data.pts[0], data.pts[data.pts.length - 1]]) {
        const mk = data.markers.find((m) => m.px === pt.px && m.py === pt.py);
        if (!mk) {
          errs.push(`端点(${pt.px},${pt.py}) 未与任何节点重合`);
          continue;
        }
        errs.push(Math.hypot(pt.x - mk.cx, pt.y - mk.cy));
      }
      // 中间点 ⇄ 手柄圆心
      for (const pt of data.pts.slice(1, -1)) {
        const h = data.handles.find((x) => x.px === pt.px && x.py === pt.py);
        if (!h) {
          errs.push(`中间点(${pt.px},${pt.py}) 未与手柄重合`);
          continue;
        }
        errs.push(Math.hypot(pt.x - h.cx, pt.y - h.cy));
      }
      const numeric = errs.filter((e) => typeof e === 'number');
      const err = numeric.length ? Math.max(...numeric) : Infinity;
      return {
        ok: errs.length > 0 && errs.every((e) => typeof e === 'number') && err < 1.5,
        err,
        detail: errs.map((e) => (typeof e === 'number' ? e.toFixed(3) : e)).join(','),
      };
    };

    const alignBefore = await measureRoadAlignment();
    cam = await readCamera(page);
    const zoomAnchor = pixelToScreenPoint(cam, 700, 700);
    await page.mouse.move(zoomAnchor.x, zoomAnchor.y);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(250);
    const alignZoomed = await measureRoadAlignment();

    const camZoomed = await readCamera(page);
    await page.mouse.move(camZoomed.canvasLeft + 400, camZoomed.canvasTop + 300);
    await page.mouse.down();
    await page.mouse.move(camZoomed.canvasLeft + 280, camZoomed.canvasTop + 220, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const alignDragged = await measureRoadAlignment();

    record(
      '缩放、拖动后折线与道路位置保持对齐',
      alignBefore.ok && alignZoomed.ok && alignDragged.ok,
      `缩放前最大偏差=${alignBefore.err.toFixed(3)}px，缩放后=${alignZoomed.err.toFixed(3)}px，拖动后=${alignDragged.err.toFixed(3)}px（折线顶点 vs 节点圆心/手柄圆心）`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '09-road.png') });

    // ---------- 17. 拖动中间点编辑 ----------
    await page.click('button:has-text("适配窗口")');
    await page.waitForTimeout(250);
    cam = await readCamera(page);
    const handlePx = await page.evaluate(() => {
      const h = document.querySelector('[data-road-point][data-point-index="1"]');
      return { x: Number(h.getAttribute('data-pixel-x')), y: Number(h.getAttribute('data-pixel-y')) };
    });
    const handleScreen = pixelToScreenPoint(cam, handlePx.x, handlePx.y);
    const targetScreen = pixelToScreenPoint(cam, 800, 500);
    await page.mouse.move(handleScreen.x, handleScreen.y);
    await page.mouse.down();
    await page.mouse.move(targetScreen.x, targetScreen.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const movedPoints = await page.getAttribute('[data-testid="road-point-count"]', 'data-points');
    const movedOk = Math.abs(Number(movedPoints.split(' ')[1].split(',')[0]) - 800) <= 2;
    record(
      '拖动中间点后坐标更新且仍与端点相连',
      movedOk,
      `中间点变为：${movedPoints}`,
    );
    const endpointsIntact = await page.evaluate(() => {
      const line = document.querySelector('[data-road-line="true"]');
      const pts = (line.getAttribute('data-points') || '').trim().split(/\s+/);
      return { first: pts[0], last: pts[pts.length - 1], count: pts.length };
    });
    record(
      '编辑后端点数量与连接关系保持不变',
      endpointsIntact.count === 5 && endpointsIntact.first === '300,300' && endpointsIntact.last === '1200,900',
      `首点=${endpointsIntact.first}，末点=${endpointsIntact.last}，点数=${endpointsIntact.count}`,
    );

    // ---------- 18. 重复建路被拒绝 ----------
    await page.selectOption('[data-testid="road-from-select"]', nodeSelectValues[1]);
    await page.selectOption('[data-testid="road-to-select"]', nodeSelectValues[0]);
    await page.click('[data-testid="road-draw-start"]');
    await page.waitForTimeout(200);
    const dupError = (await page.textContent('[data-testid="road-error"]').catch(() => '')) ?? '';
    record(
      '同一对节点重复建路被拒绝（反向也算重复）',
      dupError.includes('已存在道路'),
      `提示：“${dupError.trim()}”`,
    );

    // ---------- 19. 重新绘制 ----------
    await page.locator('[data-testid="road-redraw"]').first().click();
    await page.waitForTimeout(250);
    cam = await readCamera(page);
    for (const [px, py] of [[600, 500], [850, 600]]) {
      const pt = pixelToScreenPoint(cam, px, py);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(120);
    }
    await page.click('[data-testid="road-draw-commit"]');
    await page.waitForTimeout(300);
    const redrawnPoints = await page.getAttribute('[data-testid="road-point-count"]', 'data-points');
    const roadCountAfterRedraw = await page.locator('[data-testid="road-item"]').count();
    record(
      '重新绘制替换中间点且不新增道路',
      roadCountAfterRedraw === 1 && redrawnPoints === '600,500 850,600',
      `道路数=${roadCountAfterRedraw}，中间点=${redrawnPoints}`,
    );

    // ---------- 20. 删除节点级联删除道路 ----------
    await page.click('[data-testid="tab-nodes"]');
    await page.waitForTimeout(250);
    let dialogMessage = '';
    page.once('dialog', (dialog) => {
      dialogMessage = dialog.message();
      dialog.accept();
    });
    await page.locator('[data-testid="node-item"]').first().locator('[data-testid="node-delete"]').click();
    await page.waitForTimeout(350);
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(250);
    const roadsAfterNodeDelete = await page.locator('[data-testid="road-item"]').count();
    record(
      '删除节点时级联删除关联道路且提示明确',
      roadsAfterNodeDelete === 0 && dialogMessage.includes('关联'),
      `确认框提示：“${dialogMessage.replace(/\n/g, ' ')}”，剩余道路=${roadsAfterNodeDelete}`,
    );

    // 再校验图层中不存在悬空折线
    const danglingLines = await page.evaluate(() => document.querySelectorAll('[data-road-line="true"]').length);
    record('无悬空道路引用', danglingLines === 0, `剩余道路折线元素=${danglingLines}`);

    // ==========================================================
    // 阶段 3：简单路径搜索与最短路径搜索
    // ==========================================================

    /** 清空所有节点（会级联清除道路） */
    const clearAllNodes = async () => {
      await page.click('[data-testid="tab-nodes"]');
      await page.waitForTimeout(150);
      for (let i = 0; i < 40; i += 1) {
        const n = await page.locator('[data-testid="node-item"]').count();
        if (n === 0) break;
        page.once('dialog', (d) => d.accept());
        await page.locator('[data-testid="node-item"]').first().locator('[data-testid="node-delete"]').click();
        await page.waitForTimeout(90);
      }
    };

    const addNodeByName = async (x, y, name) => {
      await page.click('[data-testid="tab-nodes"]');
      await page.waitForTimeout(120);
      await page.fill('[data-testid="input-x"]', String(x));
      await page.fill('[data-testid="input-y"]', String(y));
      await page.fill('[data-testid="input-name"]', name);
      await page.click('[data-testid="add-node-submit"]');
      await page.waitForTimeout(120);
    };

    /** 连接两个节点（mids 为折线中间点的原始像素坐标） */
    const connectNodes = async (fromName, toName, mids = []) => {
      await page.click('[data-testid="tab-roads"]');
      await page.waitForTimeout(180);
      const opts = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="road-from-select"] option')].map((o) => ({
          v: o.value,
          t: o.textContent,
        })),
      );
      await page.selectOption('[data-testid="road-from-select"]', opts.find((o) => o.t === fromName).v);
      await page.selectOption('[data-testid="road-to-select"]', opts.find((o) => o.t === toName).v);
      await page.click('[data-testid="road-draw-start"]');
      await page.waitForTimeout(220);
      const c = await readCamera(page);
      for (const [x, y] of mids) {
        const pt = pixelToScreenPoint(c, x, y);
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(100);
      }
      await page.click('[data-testid="road-draw-commit"]');
      await page.waitForTimeout(200);
    };

    /** 执行一次搜索并读取界面上的全部结果 */
    const runPathSearch = async (startName, endName, maxResults) => {
      await page.click('[data-testid="tab-paths"]');
      await page.waitForTimeout(180);
      const opts = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({
          v: o.value,
          t: o.textContent,
        })),
      );
      await page.selectOption('[data-testid="path-start-select"]', opts.find((o) => o.t === startName).v);
      await page.selectOption('[data-testid="path-end-select"]', opts.find((o) => o.t === endName).v);
      if (maxResults !== undefined) {
        await page.fill('[data-testid="path-max-results"]', String(maxResults));
      }
      await page.click('[data-testid="path-search"]');
      await page.waitForTimeout(450);
      return page.evaluate(() => {
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
        return {
          count: text('[data-testid="path-count"]'),
          noPath: text('[data-testid="path-no-result"]'),
          completeness: text('[data-testid="path-completeness"]'),
          completeAttr: document.querySelector('[data-testid="path-completeness"]')?.getAttribute('data-complete') ?? null,
          truncatedNote: text('[data-testid="path-truncated-note"]'),
          sameEndpoint: !!document.querySelector('[data-testid="path-same-endpoint"]'),
          shortest: text('[data-testid="shortest-sequence"]'),
          unit: text('[data-testid="length-unit"]'),
          error: text('[data-testid="path-error"]'),
          items: [...document.querySelectorAll('[data-testid="path-item"]')].map((li) => ({
            seq: li.querySelector('[data-testid="path-sequence"]')?.textContent?.trim(),
            len: li.querySelector('[data-testid="path-item-length"]')?.textContent?.trim(),
          })),
        };
      });
    };

    // ---------- 22. ① 只有一条道路的简单图 ----------
    // A(100,100) - C(400,500)：人工推导长度 = √(300²+400²) = 500
    await clearAllNodes();
    await addNodeByName(100, 100, 'A1');
    await addNodeByName(400, 500, 'C1');
    await connectNodes('A1', 'C1');
    let r = await runPathSearch('A1', 'C1');
    record(
      '① 单道路图：1 条路径，长度 500 像素',
      r.count === '共 1 条路径' &&
        r.items.length === 1 &&
        r.items[0].seq === 'A1 -> C1' &&
        r.items[0].len === '500.0 像素' &&
        r.completeness?.includes('完整结果'),
      `数量=${r.count}，序列=${r.items[0]?.seq}，长度=${r.items[0]?.len}，完整性=${r.completeness}`,
    );

    // 单位必须是像素，不能出现“米”
    const allText = await page.evaluate(() => document.body.innerText);
    const meterMentions = (allText.match(/\d+\s*米/g) ?? []).length;
    record(
      '长度单位标注为像素，未出现“米”',
      r.unit?.includes('像素') && meterMentions === 0,
      `单位标签=“${r.unit}”，页面中“N 米”出现次数=${meterMentions}`,
    );

    // ---------- 23. ② 两条不同路线的分叉图 ----------
    // A(100,400) -> B(400,200) -> D(700,400)；A -> C(400,600) -> D
    // 人工推导：每条 = √(300²+200²)×2 = 360.555×2 = 721.11
    await clearAllNodes();
    await addNodeByName(100, 400, 'A2');
    await addNodeByName(400, 200, 'B2');
    await addNodeByName(400, 600, 'C2');
    await addNodeByName(700, 400, 'D2');
    await connectNodes('A2', 'B2');
    await connectNodes('B2', 'D2');
    await connectNodes('A2', 'C2');
    await connectNodes('C2', 'D2');
    r = await runPathSearch('A2', 'D2');
    const forkSeqs = r.items.map((i) => i.seq).sort();
    record(
      '② 分叉图：恰好 2 条路径，长度各 721.1 像素',
      r.count === '共 2 条路径' &&
        JSON.stringify(forkSeqs) === JSON.stringify(['A2 -> B2 -> D2', 'A2 -> C2 -> D2']) &&
        r.items.every((i) => i.len === '721.1 像素'),
      `数量=${r.count}，序列=${forkSeqs.join(' / ')}，长度=${r.items.map((i) => i.len).join(' / ')}`,
    );

    // ---------- 24. ③ 存在环路的图 ----------
    // A(100,100) B(400,100) C(700,700) D(100,700)，外环 A-B-C-D-A 另加对角线 A-C
    // 人工推导 A->C 的简单路径共 3 条：
    //   A->C 直连     = √(600²+600²) = 848.528
    //   A->B->C       = 300 + √(300²+600²) = 300 + 670.820 = 970.820
    //   A->D->C       = D(100,700)->A(100,100) 距离 600，D(100,700)->C(700,700) 距离 600 → 1200
    await clearAllNodes();
    await addNodeByName(100, 100, 'A3');
    await addNodeByName(400, 100, 'B3');
    await addNodeByName(700, 700, 'C3');
    await addNodeByName(100, 700, 'D3');
    await connectNodes('A3', 'B3');
    await connectNodes('B3', 'C3');
    await connectNodes('C3', 'D3');
    await connectNodes('D3', 'A3');
    await connectNodes('A3', 'C3');
    r = await runPathSearch('A3', 'C3');
    const loopSeqs = r.items.map((i) => i.seq);
    record(
      '③ 环路图：A->C 共 3 条简单路径且不含重复节点',
      r.count === '共 3 条路径' &&
        JSON.stringify(loopSeqs) ===
          JSON.stringify(['A3 -> C3', 'A3 -> B3 -> C3', 'A3 -> D3 -> C3']) &&
        r.items.every((i) => i.seq.split(' -> ').length === new Set(i.seq.split(' -> ')).size),
      `数量=${r.count}，序列=${loopSeqs.join(' / ')}`,
    );
    record(
      '③ 环路图：最短路径为直连 A3 -> C3（848.5 像素）',
      r.shortest === 'A3 -> C3' && r.items[0]?.len === '848.5 像素',
      `最短路径=${r.shortest}，最短长度=${r.items[0]?.len}`,
    );

    // ---------- 25. ④ 起终点不连通 ----------
    await clearAllNodes();
    await addNodeByName(100, 100, 'A4');
    await addNodeByName(400, 100, 'B4');
    await addNodeByName(900, 900, 'C4');
    await connectNodes('A4', 'B4');
    r = await runPathSearch('A4', 'C4');
    record(
      '④ 不连通图：显示“当前无路径”且无任何结果条目',
      r.noPath === '当前无路径' && r.items.length === 0 && r.count === null,
      `提示=“${r.noPath}”，结果条目数=${r.items.length}`,
    );

    // ---------- 26. ⑤ 起点与终点相同 ----------
    r = await runPathSearch('A4', 'A4');
    record(
      '⑤ 起终点相同：稳定返回 1 条零长度路径并给出说明',
      r.sameEndpoint === true &&
        r.count === '共 1 条路径' &&
        r.items.length === 1 &&
        r.items[0].seq === 'A4' &&
        r.items[0].len === '0.0 像素',
      `说明框=${r.sameEndpoint}，数量=${r.count}，序列=${r.items[0]?.seq}，长度=${r.items[0]?.len}`,
    );

    // ---------- 27. ⑥ 多中间折线点、但节点连接关系相同 ----------
    // 两张图节点与连接完全相同（A6-B6 与 A6-C6-B6），只有 A6-B6 带 3 个中间点
    // 人工推导 A6-B6 折线：A(100,100)->(200,300)->(400,400)->(600,300)->B(700,100)
    //   4 段，每段 √(100²+200²)=223.607，合计 894.428 → 894.4
    // A6->C6->B6 = 500 + 500 = 1000
    await clearAllNodes();
    await addNodeByName(100, 100, 'A6');
    await addNodeByName(700, 100, 'B6');
    await addNodeByName(400, 500, 'C6');
    await connectNodes('A6', 'B6', [[200, 300], [400, 400], [600, 300]]);
    await connectNodes('A6', 'C6');
    await connectNodes('C6', 'B6');
    r = await runPathSearch('A6', 'B6');
    record(
      '⑥ 多中间点：节点序列为 A6->B6，长度按 4 段折线累加 = 894.4（不是直线 600）',
      r.count === '共 2 条路径' &&
        r.items[0]?.seq === 'A6 -> B6' &&
        r.items[0]?.len === '894.4 像素' &&
        r.items[1]?.seq === 'A6 -> C6 -> B6' &&
        r.items[1]?.len === '1000.0 像素',
      `路径1=${r.items[0]?.seq}(${r.items[0]?.len})，路径2=${r.items[1]?.seq}(${r.items[1]?.len})；端点直线距离为 600`,
    );
    record(
      '⑥ 含中间点的道路决定了最短路径选择（894.4 < 1000）',
      r.shortest === 'A6 -> B6',
      `最短路径=${r.shortest}`,
    );

    // ---------- 28. 结果数量保护与完整性标注 ----------
    // K6（6 节点两两相连）：A->B 的简单路径数 = 1+4+12+24+24 = 65（人工推导）
    await clearAllNodes();
    const k6 = ['A7', 'B7', 'C7', 'D7', 'E7', 'F7'];
    for (let i = 0; i < k6.length; i += 1) {
      await addNodeByName(150 + i * 180, 200 + (i % 2) * 400, k6[i]);
    }
    for (let i = 0; i < k6.length; i += 1) {
      for (let j = i + 1; j < k6.length; j += 1) {
        await connectNodes(k6[i], k6[j]);
      }
    }
    r = await runPathSearch('A7', 'B7', 1000);
    record(
      'K6 稠密图：A7->B7 恰好 65 条简单路径（人工推导 1+4+12+24+24）',
      r.count === '共 65 条路径' && r.items.length === 65 && r.completeAttr === 'true',
      `数量=${r.count}，条目数=${r.items.length}，完整性=${r.completeness}`,
    );

    r = await runPathSearch('A7', 'B7', 5);
    record(
      '达到结果上限时明确标注“非完整结果”而非谎称全部',
      r.count === '共 5 条路径' &&
        r.items.length === 5 &&
        r.completeAttr === 'false' &&
        r.completeness?.includes('非完整') &&
        r.truncatedNote?.includes('并非全部路径'),
      `数量=${r.count}，完整性=“${r.completeness}”，说明=“${r.truncatedNote}”`,
    );

    // ---------- 29. 搜索不修改图数据 ----------
    const graphBeforeSearch = await page.evaluate(() => ({
      nodes: document.querySelectorAll('[data-node-marker]').length,
      roads: document.querySelectorAll('[data-road-line="true"]').length,
    }));
    await runPathSearch('A7', 'F7', 50);
    const graphAfterSearch = await page.evaluate(() => ({
      nodes: document.querySelectorAll('[data-node-marker]').length,
      roads: document.querySelectorAll('[data-road-line="true"]').length,
    }));
    record(
      '搜索不会增删改任何节点或道路',
      graphBeforeSearch.nodes === graphAfterSearch.nodes && graphBeforeSearch.roads === graphAfterSearch.roads,
      `搜索前 节点=${graphBeforeSearch.nodes}/道路=${graphBeforeSearch.roads}，搜索后 节点=${graphAfterSearch.nodes}/道路=${graphAfterSearch.roads}`,
    );

    // ---------- 30. 高亮路线与道路严格对齐（缩放/拖动后仍对齐） ----------
    const measureHighlightAlignment = async () =>
      page.evaluate(() => {
        // 阶段5 起，高亮由道路图层按“道路真实折线”绘制（不再是独立的 PathHighlightLayer），
        // 因此对每条高亮道路折线的首末点，都校验其屏幕位置与对应节点圆心严格重合。
        const groups = [...document.querySelectorAll('[data-road-highlighted="true"]')];
        if (groups.length === 0) return { ok: false, err: Infinity, detail: '未找到高亮道路' };
        const allLines = groups
          .map((g) => g.querySelector('[data-testid="road-highlight-line"]'))
          .filter(Boolean);
        if (allLines.length === 0) return { ok: false, err: Infinity, detail: '未找到高亮折线' };

        const markers = [...document.querySelectorAll('[data-node-marker]')].map((mk) => {
          const c = mk.querySelector('circle:not([fill="none"])');
          const b = c.getBoundingClientRect();
          return {
            px: Number(mk.getAttribute('data-pixel-x')),
            py: Number(mk.getAttribute('data-pixel-y')),
            cx: b.left + b.width / 2,
            cy: b.top + b.height / 2,
          };
        });

        const errs = [];
        let checked = 0;
        for (const line of allLines) {
          const m = line.getScreenCTM();
          const map = (x, y) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
          const pts = line
            .getAttribute('points')
            .trim()
            .split(/\s+/)
            .map((t) => t.split(',').map(Number))
            .map(([x, y]) => ({ px: x, py: y, ...map(x, y) }));
          for (const pt of [pts[0], pts[pts.length - 1]]) {
            checked += 1;
            const mk = markers.find((x) => x.px === pt.px && x.py === pt.py);
            if (!mk) {
              errs.push('端点未与节点重合');
              continue;
            }
            errs.push(Math.hypot(pt.x - mk.cx, pt.y - mk.cy));
          }
        }
        const numeric = errs.filter((e) => typeof e === 'number');
        const err = numeric.length ? Math.max(...numeric) : Infinity;
        return { ok: checked > 0 && errs.length === checked && err < 1.5, err, detail: errs.join(',') };
      });

    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(150);
    const hlBefore = await measureHighlightAlignment();
    const cZoom = await readCamera(page);
    await page.mouse.move(cZoom.canvasLeft + 500, cZoom.canvasTop + 300);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(250);
    const hlAfterZoom = await measureHighlightAlignment();
    const cDrag = await readCamera(page);
    await page.mouse.move(cDrag.canvasLeft + 500, cDrag.canvasTop + 300);
    await page.mouse.down();
    await page.mouse.move(cDrag.canvasLeft + 380, cDrag.canvasTop + 220, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const hlAfterDrag = await measureHighlightAlignment();
    record(
      '高亮路线在缩放/拖动后仍与节点严格对齐',
      hlBefore.ok && hlAfterZoom.ok && hlAfterDrag.ok,
      `缩放前=${hlBefore.err.toFixed(3)}px，缩放后=${hlAfterZoom.err.toFixed(3)}px，拖动后=${hlAfterDrag.err.toFixed(3)}px`,
    );
    await page.screenshot({ path: path.join(SHOT_DIR, '10-paths.png') });

    // ==========================================================
    // 阶段 4：比例尺校准与道路距离估算
    // ==========================================================

    /** 读取比例尺相关界面状态 */
    const readScaleUi = async () =>
      page.evaluate(() => {
        const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
        return {
          calibrated: document.querySelector('[data-testid="scale-status"]')?.getAttribute('data-calibrated') ?? null,
          ratio: text('[data-testid="scale-ratio"]'),
          pixelDistance: text('[data-testid="scale-pixel-distance"]'),
          uncalibratedWarning: text('[data-testid="scale-uncalibrated-warning"]'),
          error: text('[data-testid="scale-error"]'),
          pointA: text('[data-testid="scale-point-a"]'),
          pointB: text('[data-testid="scale-point-b"]'),
        };
      });

    /**
     * 在地图上按原始像素坐标点选（校准模式用）。
     * 若目标像素被缩放/平移推到画布外，直接点击不会命中，因此先复位视图。
     */
    const clickPixel = async (x, y) => {
      const c = await readCamera(page);
      const pt = pixelToScreenPoint(c, x, y);
      const insideCanvas =
        pt.x >= c.canvasLeft && pt.x <= c.canvasLeft + c.canvasWidth &&
        pt.y >= c.canvasTop && pt.y <= c.canvasTop + c.canvasHeight;
      if (!insideCanvas) {
        await page.click('[data-testid="view-fit"]');
        await page.waitForTimeout(250);
      }
      const c2 = await readCamera(page);
      const pt2 = pixelToScreenPoint(c2, x, y);
      await page.mouse.click(pt2.x, pt2.y);
      await page.waitForTimeout(160);
    };

    /** 完成一次校准：点选 A(0,0)、B(300,400) → 像素距离恰为 500 */
    const calibrate = async (distance, unit) => {
      await page.click('[data-testid="tab-scale"]');
      await page.waitForTimeout(180);
      const toggleText = (await page.textContent('[data-testid="scale-pick-toggle"]')).trim();
      if (!toggleText.includes('退出')) {
        await page.click('[data-testid="scale-pick-toggle"]');
        await page.waitForTimeout(160);
      }
      await clickPixel(0, 0);
      await clickPixel(300, 400);
      await page.fill('[data-testid="scale-distance-input"]', String(distance));
      await page.selectOption('[data-testid="scale-unit-select"]', unit);
      await page.click('[data-testid="scale-apply"]');
      await page.waitForTimeout(350);
    };

    // ---------- 32. 未校准时不得把像素当米 ----------
    // 重新建立可人工计算的折线：S1(100,100) - S2(700,100)，中间点 (200,300),(400,400),(600,300)
    // 人工推导：4 段 × √(100²+200²) = 4 × 223.6068 = 894.4272 像素
    await clearAllNodes();
    await addNodeByName(100, 100, 'S1');
    await addNodeByName(700, 100, 'S2');
    // 关键：先“适配窗口”，保证整张底图都在画布可见范围内。
    // 若用“原始像素 1:1”，图片比画布大，offset 为负，(200,300) 这类点会被推到画布外，
    // 点击就不会被记录，折线长度也就不等于人工推导值（这是测试点击位置问题，产品计算本身无误）。
    await page.click('[data-testid="view-fit"]');
    await page.waitForTimeout(250);
    await connectNodes('S1', 'S2', [[200, 300], [400, 400], [600, 300]]);
    // 立刻核对：中间点必须精确等于人工指定的三个顶点
    const recordedMids = await page.getAttribute('[data-testid="road-point-count"]', 'data-points');
    if (recordedMids !== '200,300 400,400 600,300') {
      throw new Error(`折线中间点与预期不符：${recordedMids}`);
    }

    await page.click('[data-testid="tab-scale"]');
    await page.waitForTimeout(200);
    let ui = await readScaleUi();
    record(
      '未校准时明确提示，且不存在比例尺',
      ui.calibrated === 'false' && (ui.uncalibratedWarning ?? '').includes('未校准'),
      `状态=${ui.calibrated}，警告=“${(ui.uncalibratedWarning ?? '').slice(0, 30)}…”`,
    );

    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(180);
    const pathOpts0 = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({ v: o.value, t: o.textContent })),
    );
    await page.selectOption('[data-testid="path-start-select"]', pathOpts0.find((o) => o.t === 'S1').v);
    await page.selectOption('[data-testid="path-end-select"]', pathOpts0.find((o) => o.t === 'S2').v);
    await page.click('[data-testid="path-search"]');
    await page.waitForTimeout(350);
    const uncalShortest = (await page.textContent('[data-testid="shortest-length"]')).trim();
    const uncalUnit = (await page.textContent('[data-testid="length-unit"]')).trim();
    // 读取图层里该条道路的真实折线像素长度作为基准（与人工推导 894.4272 对比）
    const uncalExpectedPx = await page.evaluate(() => {
      const li = document.querySelector('[data-testid="path-item"]');
      return li ? Number(li.getAttribute('data-length')) : null;
    });
    record(
      '未校准时长度只显示像素，绝不显示为米',
      uncalExpectedPx !== null &&
        uncalShortest.includes(`${uncalExpectedPx.toFixed(1)} 像素`) &&
        !uncalShortest.includes('米') &&
        uncalUnit.includes('未校准'),
      `折线像素长度=${uncalExpectedPx}，显示=“${uncalShortest}”，单位标签=“${uncalUnit}”`,
    );

    // ---------- 33. 在地图上点选校准点，坐标换算正确 ----------
    await page.click('[data-testid="tab-scale"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="scale-pick-toggle"]');
    await page.waitForTimeout(180);
    await clickPixel(0, 0);
    await clickPixel(300, 400);
    ui = await readScaleUi();
    // 人工核对：A(0,0)、B(300,400) → √(300²+400²) = 500 像素
    const pixDistOk = (ui.pixelDistance ?? '').includes('500.00');
    record(
      '地图点选的两个校准点按原始像素坐标记录，像素距离=500.00',
      (ui.pointA ?? '').includes('0') && (ui.pointB ?? '').includes('300') && pixDistOk,
      `A=${ui.pointA}，B=${ui.pointB}，${ui.pixelDistance}`,
    );

    // ---------- 34. 校准 500 米 / 500 像素 → 1 米每像素 ----------
    await page.fill('[data-testid="scale-distance-input"]', '500');
    await page.selectOption('[data-testid="scale-unit-select"]', 'm');
    await page.click('[data-testid="scale-apply"]');
    await page.waitForTimeout(400);
    ui = await readScaleUi();
    record(
      '校准 500 米 / 500 像素 → 1 像素 ≈ 1.0000 米',
      ui.calibrated === 'true' && (ui.ratio ?? '').includes('1.0000'),
      `状态=${ui.calibrated}，比例尺=“${ui.ratio}”`,
    );

    // ---------- 35. 人工折线：894.4272 像素 → 894.4 米 ----------
    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="path-search"]');
    await page.waitForTimeout(350);
    const calShortest = (await page.textContent('[data-testid="shortest-length"]')).trim();
    const calItem = (await page.textContent('[data-testid="path-item-length"]')).trim();
    const calExpectedPx = await page.evaluate(() => {
      const li = document.querySelector('[data-testid="path-item"]');
      return li ? Number(li.getAttribute('data-length')) : null;
    });
    // 1 米/像素时，米数应等于像素数；同时用人工推导值 894.4272 做区间核对
    const pxMatchesManual = calExpectedPx !== null && Math.abs(calExpectedPx - 894.4272) < 0.01;
    record(
      '人工折线 4×√(100²+200²)=894.4272 像素 → 校准后显示 894.4 米',
      pxMatchesManual && calShortest.includes(`${calExpectedPx.toFixed(1)} 米`) && calItem.includes(`${calExpectedPx.toFixed(1)} 米`),
      `像素长度=${calExpectedPx}（人工推导 894.4272），最短路径=“${calShortest}”，列表长度=“${calItem}”`,
    );
    // 已校准后，路径结果不再显示像素数值
    record(
      '已校准比例尺后路径结果不再显示像素，只显示路径长度',
      !calShortest.includes('像素') && !calItem.includes('像素'),
      `最短路径=“${calShortest}”，列表长度=“${calItem}”`,
    );

    // 道路列表同样显示实际长度
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(250);
    const roadLenCal = (await page.textContent('[data-testid="road-length"]')).trim();
    record(
      '道路管理列表已校准时只显示实际长度（米），不显示像素',
      roadLenCal.includes(`${calExpectedPx.toFixed(1)} 米`) && !roadLenCal.includes('像素'),
      `道路长度=“${roadLenCal}”，基准像素长度=${calExpectedPx}`,
    );

    // ---------- 36. 比例尺变化后长度与最短路径按预期更新 ----------
    // 改为 1000 米 / 500 像素 = 2 米/像素 → 894.4272 像素 = 1788.8544 米 = 1.79 千米
    await calibrate(1000, 'm');
    ui = await readScaleUi();
    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(200);
    await page.click('[data-testid="path-search"]');
    await page.waitForTimeout(350);
    const doubled = (await page.textContent('[data-testid="shortest-length"]')).trim();
    // 人工核对：894.4272 像素 × 2 米/像素 = 1788.8544 米 = 1.79 千米
    const doubledKm = (calExpectedPx * 2 / 1000).toFixed(2);
    record(
      '比例尺改为 2 米/像素后，实际距离翻倍为 1.79 千米（且不再显示像素）',
      (ui.ratio ?? '').includes('2.0000') &&
        doubled.includes(`${doubledKm} 千米`) &&
        !doubled.includes('像素'),
      `比例尺=“${ui.ratio}”，长度=“${doubled}”，人工推导 ${calExpectedPx}×2=${calExpectedPx * 2} 米=${doubledKm} 千米`,
    );

    // ---------- 37. 千米单位输入等价换算 ----------
    // 0.5 千米 / 500 像素 → 1 米/像素（与 500 米等价）
    await calibrate(0.5, 'km');
    ui = await readScaleUi();
    record(
      '千米单位输入正确换算：0.5 千米 / 500 像素 → 1.0000 米每像素',
      (ui.ratio ?? '').includes('1.0000'),
      `比例尺=“${ui.ratio}”`,
    );

    // ---------- 38. 缩放/拖动不改变已保存的比例尺与实际长度 ----------
    const scaleBefore = (await page.textContent('[data-testid="scale-ratio"]')).trim();
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(200);
    const roadLenBefore = (await page.textContent('[data-testid="road-length"]')).trim();

    const camZ = await readCamera(page);
    await page.mouse.move(camZ.canvasLeft + 500, camZ.canvasTop + 300);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(200);
    const camD = await readCamera(page);
    await page.mouse.move(camD.canvasLeft + 600, camD.canvasTop + 350);
    await page.mouse.down();
    await page.mouse.move(camD.canvasLeft + 480, camD.canvasTop + 260, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    await page.click('[data-testid="tab-scale"]');
    await page.waitForTimeout(200);
    const scaleAfter = (await page.textContent('[data-testid="scale-ratio"]')).trim();
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(200);
    const roadLenAfter = (await page.textContent('[data-testid="road-length"]')).trim();
    record(
      '地图缩放、拖动后比例尺系数与道路实际长度均不变',
      scaleBefore === scaleAfter && roadLenBefore === roadLenAfter,
      `比例尺 前=“${scaleBefore}” 后=“${scaleAfter}”；道路长度 前=“${roadLenBefore}” 后=“${roadLenAfter}”`,
    );

    // ---------- 39. 非法输入被明确拒绝 ----------
    await page.click('[data-testid="tab-scale"]');
    await page.waitForTimeout(180);
    await page.fill('[data-testid="scale-distance-input"]', '0');
    await page.click('[data-testid="scale-apply"]');
    await page.waitForTimeout(300);
    const zeroErr = (await page.textContent('[data-testid="scale-error"]')).trim();
    const ratioStill = (await page.textContent('[data-testid="scale-ratio"]')).trim();
    record(
      '距离为 0 被拒绝并给出明确提示，且原比例尺不被破坏',
      zeroErr.includes('必须大于 0') && ratioStill === scaleBefore,
      `提示=“${zeroErr}”，比例尺仍为“${ratioStill}”`,
    );

    const scaleDescText = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="scale-panel"]');
      return panel ? panel.innerText : '';
    });
    record(
      '界面说明了透视变形下仅为近似估算',
      scaleDescText.includes('透视变形') && scaleDescText.includes('近似估算'),
      '校准面板明确标注：假定图片各方向比例一致，存在透视变形时仅为近似估算，不具备测绘级精度',
    );

    // ---------- 39b. 切换页签时暂时隐藏校准点，回到比例尺页签恢复 ----------
    const countScaleLayer = async () =>
      page.evaluate(() => document.querySelectorAll('[data-testid="scale-layer"]').length);

    // 当前在“比例尺”页签，校准点应可见
    const layerOnScaleTab = await countScaleLayer();
    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(220);
    const layerOnPathsTab = await countScaleLayer();
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(220);
    const layerOnRoadsTab = await countScaleLayer();
    await page.click('[data-testid="tab-view"]');
    await page.waitForTimeout(220);
    const layerOnViewTab = await countScaleLayer();
    await page.click('[data-testid="tab-scale"]');
    await page.waitForTimeout(220);
    const layerBackOnScaleTab = await countScaleLayer();
    record(
      '切换到其他页签时校准点暂时隐藏，回到比例尺页签后恢复显示',
      layerOnScaleTab === 1 &&
        layerOnPathsTab === 0 &&
        layerOnRoadsTab === 0 &&
        layerOnViewTab === 0 &&
        layerBackOnScaleTab === 1,
      `比例尺页签=${layerOnScaleTab}，路径=${layerOnPathsTab}，道路=${layerOnRoadsTab}，查看=${layerOnViewTab}，回到比例尺=${layerBackOnScaleTab}`,
    );

    // 隐藏校准点不得影响已保存的比例尺
    const ratioAfterTabSwitch = (await page.textContent('[data-testid="scale-ratio"]')).trim();
    record(
      '隐藏校准点不影响已保存的比例尺',
      ratioAfterTabSwitch === scaleBefore,
      `切换页签后比例尺=“${ratioAfterTabSwitch}”，期望“${scaleBefore}”`,
    );

    await page.screenshot({ path: path.join(SHOT_DIR, '11-scale.png') });

    // ==========================================================
    // 阶段 5：路线可视化与搜索结果展示
    // ==========================================================

    // 建一个 A->B 有两条路线的图：
    //   A(300,300) --中间点(300,600)(1100,600)--> B(1100,300)  绕行，长度 300+800+300=1400
    //   A -> C(700,800) -> B                                  长度 √(400²+500²)×2=640.3×2=1280.6（更短）
    await clearAllNodes();
    await addNodeByName(300, 300, 'VA');
    await addNodeByName(1100, 300, 'VB');
    await addNodeByName(700, 800, 'VC');
    await page.click('[data-testid="view-fit"]');
    await page.waitForTimeout(250);
    await connectNodes('VA', 'VB', [[300, 600], [1100, 600]]);
    await connectNodes('VA', 'VC');
    await connectNodes('VC', 'VB');

    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(200);
    const vOpts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({ v: o.value, t: o.textContent })),
    );
    await page.selectOption('[data-testid="path-start-select"]', vOpts.find((o) => o.t === 'VA').v);
    await page.selectOption('[data-testid="path-end-select"]', vOpts.find((o) => o.t === 'VB').v);
    await page.click('[data-testid="path-search"]');
    await page.waitForTimeout(450);

    /** 读取地图片层上的可视化状态 */
    const readVisual = async () =>
      page.evaluate(() => {
        const roleOf = {};
        for (const mk of document.querySelectorAll('[data-node-marker]')) {
          const label = mk.getAttribute('aria-label') ?? '';
          const m = label.match(/节点 (\S+)/);
          const name = m ? m[1] : label;
          roleOf[name] = {
            role: mk.getAttribute('data-node-role'),
            fill: mk.querySelector('circle:not([fill="none"])')?.getAttribute('fill'),
          };
        }
        const highlighted = [...document.querySelectorAll('[data-road-highlighted="true"]')].map((g) => ({
          roadPoints: g.getAttribute('data-points'),
          hlPoints: g.querySelector('[data-testid="road-highlight-line"]')?.getAttribute('points'),
          pointCount: g.getAttribute('data-point-count'),
        }));
        return {
          roleOf,
          highlighted,
          searchInfo: document.querySelector('[data-testid="path-search-info"]')?.innerText.replace(/\n/g, ' ').trim() ?? null,
          noPath: document.querySelector('[data-testid="path-no-result"]')?.textContent?.trim() ?? null,
          itemCount: document.querySelectorAll('[data-testid="path-item"]').length,
        };
      });

    let vis = await readVisual();

    // ---------- 41. 起点/终点/路线节点/普通节点配色区分 ----------
    const colors = new Set(
      Object.values(vis.roleOf).map((v) => v.fill),
    );
    record(
      '起点、终点、路线节点与普通节点颜色互不相同',
      vis.roleOf.VA?.role === 'start' &&
        vis.roleOf.VB?.role === 'end' &&
        vis.roleOf.VC?.role === 'onRoute' &&
        vis.roleOf.VA.fill === '#059669' &&
        vis.roleOf.VB.fill === '#db2777' &&
        vis.roleOf.VC.fill === '#7c3aed' &&
        colors.size === 3,
      `VA=${vis.roleOf.VA?.role}/${vis.roleOf.VA?.fill}，VB=${vis.roleOf.VB?.role}/${vis.roleOf.VB?.fill}，VC=${vis.roleOf.VC?.role}/${vis.roleOf.VC?.fill}`,
    );

    // ---------- 42. 结果区标注搜索起终点 ----------
    record(
      '结果区明确标注本次搜索的起点与终点',
      (vis.searchInfo ?? '').includes('起点') &&
        (vis.searchInfo ?? '').includes('VA') &&
        (vis.searchInfo ?? '').includes('终点') &&
        (vis.searchInfo ?? '').includes('VB'),
      `标注=“${vis.searchInfo}”`,
    );

    // ---------- 43. 默认高亮最短路径，且高亮复用真实折线 ----------
    const shortestSeq = (await page.textContent('[data-testid="shortest-sequence"]')).trim();
    record(
      '默认高亮最短路径 VA -> VC -> VB（1280.6 < 1400）',
      shortestSeq === 'VA -> VC -> VB' && vis.highlighted.length === 2,
      `最短路径=“${shortestSeq}”，高亮道路数=${vis.highlighted.length}`,
    );
    record(
      '高亮折线复用道路真实折线坐标（逐点相同，非端点直线）',
      vis.highlighted.every((h) => h.roadPoints === h.hlPoints),
      `高亮=${JSON.stringify(vis.highlighted.map((h) => h.hlPoints).join(' | '))}`,
    );

    // ---------- 44. 切换到另一条路线，高亮随之变化且含中间点 ----------
    await page.locator('[data-testid="path-item"]').nth(1).click();
    await page.waitForTimeout(420);
    vis = await readVisual();
    const secondSeq = (
      await page.locator('[data-testid="path-item"]').nth(1).locator('[data-testid="path-sequence"]').textContent()
    ).trim();
    const bypass = vis.highlighted.find((h) => h.pointCount === '2');
    record(
      '选择不同路线后高亮随之切换（绕行路线含 2 个中间点，不是直线）',
      vis.highlighted.length === 1 &&
        Boolean(bypass) &&
        bypass.hlPoints === bypass.roadPoints &&
        bypass.hlPoints.split(' ').length === 4,
      `选中=“${secondSeq}”，高亮折线点数=${bypass ? bypass.hlPoints.split(' ').length : 0}（含端点共 4 点），折线=${bypass?.hlPoints}`,
    );

    // 切回第一条，验证可来回切换
    await page.locator('[data-testid="path-item"]').nth(0).click();
    await page.waitForTimeout(380);
    const backVis = await readVisual();
    record(
      '可在多条路线之间来回切换高亮',
      backVis.highlighted.length === 2 &&
        backVis.highlighted.every((h) => h.roadPoints === h.hlPoints),
      `切回后高亮道路数=${backVis.highlighted.length}`,
    );

    // ---------- 45. 切换高亮不修改底层数据 ----------
    const dataBefore = await page.evaluate(() => ({
      nodes: [...document.querySelectorAll('[data-node-marker]')].map((m) => m.getAttribute('data-pixel-x') + ',' + m.getAttribute('data-pixel-y')).join('|'),
      roads: [...document.querySelectorAll('[data-road-line="true"]')].map((g) => g.getAttribute('data-points')).join('|'),
      lengths: [...document.querySelectorAll('[data-testid="path-item"]')].map((li) => li.getAttribute('data-length')).join('|'),
    }));
    await page.locator('[data-testid="path-item"]').nth(1).click();
    await page.waitForTimeout(300);
    await page.locator('[data-testid="path-item"]').nth(0).click();
    await page.waitForTimeout(300);
    const dataAfter = await page.evaluate(() => ({
      nodes: [...document.querySelectorAll('[data-node-marker]')].map((m) => m.getAttribute('data-pixel-x') + ',' + m.getAttribute('data-pixel-y')).join('|'),
      roads: [...document.querySelectorAll('[data-road-line="true"]')].map((g) => g.getAttribute('data-points')).join('|'),
      lengths: [...document.querySelectorAll('[data-testid="path-item"]')].map((li) => li.getAttribute('data-length')).join('|'),
    }));
    record(
      '切换路线高亮不修改节点、道路或距离数据',
      dataBefore.nodes === dataAfter.nodes &&
        dataBefore.roads === dataAfter.roads &&
        dataBefore.lengths === dataAfter.lengths,
      `节点/道路/距离 前后一致=${dataBefore.nodes === dataAfter.nodes && dataBefore.roads === dataAfter.roads && dataBefore.lengths === dataAfter.lengths}`,
    );

    // ---------- 46. 缩放拖动后高亮仍与底层道路重合 ----------
    const measureHighlightOverlap = async () =>
      page.evaluate(() => {
        const groups = [...document.querySelectorAll('[data-road-highlighted="true"]')];
        if (groups.length === 0) return { ok: false, err: Infinity, count: 0 };
        let worst = 0;
        for (const g of groups) {
          const line = g.querySelector('[data-testid="road-highlight-line"]');
          const roadLine = g.querySelector('polyline[stroke="#0f766e"], polyline[stroke="#b45309"]');
          if (!line || !roadLine) return { ok: false, err: Infinity, count: groups.length };
          // 直接比较两份 points 属性：完全一致说明用的是同一条真实折线
          if (line.getAttribute('points') !== roadLine.getAttribute('points')) {
            return { ok: false, err: Infinity, count: groups.length };
          }
          // 再用屏幕坐标比对，确认渲染后仍重合
          const m1 = line.getScreenCTM();
          const m2 = roadLine.getScreenCTM();
          const pts1 = line.getAttribute('points').trim().split(/\s+/).map((p) => p.split(',').map(Number));
          for (const [x, y] of pts1) {
            const a = { x: m1.a * x + m1.c * y + m1.e, y: m1.b * x + m1.d * y + m1.f };
            const b = { x: m2.a * x + m2.c * y + m2.e, y: m2.b * x + m2.d * y + m2.f };
            worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
          }
        }
        return { ok: worst < 0.001, err: worst, count: groups.length };
      });

    const ovBefore = await measureHighlightOverlap();
    const camP5 = await readCamera(page);
    await page.mouse.move(camP5.canvasLeft + 520, camP5.canvasTop + 320);
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(200);
    const ovZoom = await measureHighlightOverlap();
    const camP5b = await readCamera(page);
    await page.mouse.move(camP5b.canvasLeft + 620, camP5b.canvasTop + 360);
    await page.mouse.down();
    await page.mouse.move(camP5b.canvasLeft + 470, camP5b.canvasTop + 250, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const ovDrag = await measureHighlightOverlap();
    record(
      '缩放、拖动后高亮路线仍与底层道路完全重合',
      ovBefore.ok && ovZoom.ok && ovDrag.ok,
      `缩放前=${ovBefore.err.toFixed(4)}px，缩放后=${ovZoom.err.toFixed(4)}px，拖动后=${ovDrag.err.toFixed(4)}px，高亮道路数=${ovDrag.count}`,
    );

    await page.screenshot({ path: path.join(SHOT_DIR, '12-path-visual.png') });

    // ---------- 47. 无路径时清除旧高亮并显示“当前无路径” ----------
    // 新增一个孤立节点，把它设为终点
    await addNodeByName(1450, 1100, 'VZ');
    await page.click('[data-testid="tab-paths"]');
    await page.waitForTimeout(200);
    const vOpts2 = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({ v: o.value, t: o.textContent })),
    );
    await page.selectOption('[data-testid="path-start-select"]', vOpts2.find((o) => o.t === 'VA').v);
    await page.selectOption('[data-testid="path-end-select"]', vOpts2.find((o) => o.t === 'VZ').v);
    await page.click('[data-testid="path-search"]');
    await page.waitForTimeout(450);
    vis = await readVisual();
    record(
      '无路径时显示“当前无路径”并清除旧路线高亮',
      vis.noPath === '当前无路径' && vis.highlighted.length === 0 && vis.itemCount === 0,
      `提示=“${vis.noPath}”，残留高亮道路数=${vis.highlighted.length}，结果条目=${vis.itemCount}`,
    );

    // ---------- 48. 查看模式隐藏节点与道路管理列表 ----------
    await page.click('[data-testid="tab-view"]');
    await page.waitForTimeout(220);
    const hiddenInView = await page.evaluate(() => ({
      nodeList: document.querySelectorAll('[data-testid="node-item"]').length,
      roadList: document.querySelectorAll('[data-testid="road-item"]').length,
      nodePanel: document.querySelectorAll('[data-testid="node-list"]').length,
      roadPanel: document.querySelectorAll('[data-testid="road-panel"]').length,
    }));
    await page.click('[data-testid="tab-nodes"]');
    await page.waitForTimeout(220);
    const shownInNodes = await page.evaluate(() => ({
      nodeList: document.querySelectorAll('[data-testid="node-item"]').length,
      roadPanel: document.querySelectorAll('[data-testid="road-panel"]').length,
    }));
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(220);
    const shownInRoads = await page.evaluate(() => ({
      nodeList: document.querySelectorAll('[data-testid="node-item"]').length,
      roadPanel: document.querySelectorAll('[data-testid="road-panel"]').length,
    }));
    record(
      '查看模式隐藏节点与道路管理列表，进入对应管理模式才显示',
      hiddenInView.nodeList === 0 &&
        hiddenInView.roadList === 0 &&
        hiddenInView.nodePanel === 0 &&
        hiddenInView.roadPanel === 0 &&
        shownInNodes.nodeList > 0 &&
        shownInNodes.roadPanel === 0 &&
        shownInRoads.roadPanel > 0 &&
        shownInRoads.nodeList === 0,
      `查看模式 节点列表=${hiddenInView.nodeList}/道路面板=${hiddenInView.roadPanel}；节点页签 节点=${shownInNodes.nodeList}/道路面板=${shownInNodes.roadPanel}；道路页签 道路面板=${shownInRoads.roadPanel}/节点=${shownInRoads.nodeList}`,
    );

    // ---------- 48b. 道路选中切换：再次点击取消选中并恢复地图不亮 ----------
    // 复用前面阶段5 建好的道路（VA-VB 绕行道路、VA-VC、VC-VB）
    await page.click('[data-testid="tab-roads"]');
    await page.waitForTimeout(250);

    /** 读取道路列表与地图的实际选中/高亮状态 */
    const readRoadSelection = async () =>
      page.evaluate(() => {
        const items = [...document.querySelectorAll('[data-testid="road-item"]')];
        const selectedIndexes = items
          .map((li, i) => (li.className.includes('Selected') ? i : -1))
          .filter((i) => i >= 0);
        const roads = [...document.querySelectorAll('[data-road-line="true"]')].map((g) => {
          const main = [...g.querySelectorAll('polyline')].find((l) => {
            const st = l.getAttribute('stroke');
            return st && st !== 'transparent' && st !== '#ffffff' && st !== '#fbbf24' && st !== '#7c3aed';
          });
          return {
            roadId: g.getAttribute('data-road-id'),
            stroke: main?.getAttribute('stroke'),
            width: Number(main?.getAttribute('stroke-width') ?? 0),
          };
        });
        return {
          selectedCount: selectedIndexes.length,
          selectedIndexes,
          // 选中外发光描边
          glowCount: document.querySelectorAll('polyline[stroke="#fbbf24"]').length,
          roads,
        };
      });

    // 第一次点击第 1 条：选中
    await page.locator('[data-testid="road-item"]').nth(0).click();
    await page.waitForTimeout(320);
    const sel1 = await readRoadSelection();
    const sel1Road = sel1.roads.find((r) => r.stroke === '#b45309');

    // 第二次点击同一条：取消选中
    await page.locator('[data-testid="road-item"]').nth(0).click();
    await page.waitForTimeout(320);
    const sel2 = await readRoadSelection();

    record(
      '道路管理：选中一条道路后高亮显示',
      sel1.selectedCount === 1 && sel1.selectedIndexes[0] === 0 && Boolean(sel1Road) && sel1.glowCount > 0,
      `选中项=${JSON.stringify(sel1.selectedIndexes)}，选中色道路=${sel1Road ? sel1Road.roadId : '无'}，外发光描边数=${sel1.glowCount}`,
    );
    record(
      '道路管理：再次点击同一条道路取消选中，地图高亮恢复未选中',
      sel2.selectedCount === 0 &&
        sel2.glowCount === 0 &&
        sel2.roads.every((r) => r.stroke === '#0f766e'),
      `选中项=${JSON.stringify(sel2.selectedIndexes)}，外发光描边数=${sel2.glowCount}，道路颜色=${sel2.roads.map((r) => r.stroke).join('/')}`,
    );

    // 第三次点击：可重新选中
    await page.locator('[data-testid="road-item"]').nth(0).click();
    await page.waitForTimeout(320);
    const sel3 = await readRoadSelection();
    record(
      '道路管理：取消后可再次点击重新选中',
      sel3.selectedCount === 1 && sel3.selectedIndexes[0] === 0,
      `选中项=${JSON.stringify(sel3.selectedIndexes)}`,
    );

    // 点击另一条：切换而非取消
    await page.locator('[data-testid="road-item"]').nth(1).click();
    await page.waitForTimeout(320);
    const sel4 = await readRoadSelection();
    record(
      '道路管理：点击另一条道路为切换选中而非取消',
      sel4.selectedCount === 1 && sel4.selectedIndexes[0] === 1,
      `选中项=${JSON.stringify(sel4.selectedIndexes)}`,
    );

    // ---------- 48c. 道路只用线条表示，不再绘制方向箭头 ----------
    const arrowState = await page.evaluate(() => ({
      bidirectionalMarkers: document.querySelectorAll('[data-testid="road-bidirectional-marker"]').length,
      draftArrows: document.querySelectorAll('[data-testid="draft-arrows"]').length,
      // 箭头是以白色描边绘制的小三角形，出现在道路组内
      polygonInRoads: document.querySelectorAll('[data-road-line="true"] polygon').length,
      roadCount: document.querySelectorAll('[data-road-line="true"]').length,
      // 道路主线仍在且坐标完整
      linesOk: [...document.querySelectorAll('[data-road-line="true"]')].every((g) => {
        const main = [...g.querySelectorAll('polyline')].find((l) => {
          const st = l.getAttribute('stroke');
          return st && st !== 'transparent' && st !== '#ffffff' && st !== '#fbbf24' && st !== '#7c3aed';
        });
        return Boolean(main) && (main.getAttribute('points') ?? '').trim().split(/\s+/).length >= 2;
      }),
    }));
    record(
      '道路只用线条表示，不再绘制方向箭头',
      arrowState.bidirectionalMarkers === 0 &&
        arrowState.draftArrows === 0 &&
        arrowState.polygonInRoads === 0 &&
        arrowState.roadCount > 0 &&
        arrowState.linesOk,
      `箭头标记=${arrowState.bidirectionalMarkers}，草稿箭头=${arrowState.draftArrows}，道路内三角形=${arrowState.polygonInRoads}，道路数=${arrowState.roadCount}，线条完整=${arrowState.linesOk}`,
    );

    // ---------- 49. 控制台无错误 ----------
    const relevantErrors = consoleErrors.filter((e) => !e.includes('favicon'));
    record('浏览器控制台无 JS 错误', relevantErrors.length === 0, relevantErrors.length ? relevantErrors.join(' | ') : '无错误');
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n合计 ${checks.length} 项，通过 ${checks.length - failed.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('E2E 执行异常：', error);
  process.exitCode = 1;
});
