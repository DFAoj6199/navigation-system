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

    // ---------- 21. 控制台无错误 ----------
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
