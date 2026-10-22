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
    const beforeDelete = await page.locator('[data-testid="node-item"]').count();
    await page.locator('[data-testid="node-item"]').first().locator('button:has-text("删除")').click();
    await page.waitForTimeout(200);
    const afterDelete = await page.locator('[data-testid="node-item"]').count();
    record('删除节点', afterDelete === beforeDelete - 1, `${beforeDelete} -> ${afterDelete}`);

    // ---------- 11. 选中节点 ----------
    await page.locator('[data-testid="node-item"]').first().click();
    const selectedCircle = await page.evaluate(() => document.querySelectorAll('[data-node-marker] circle[stroke="#fbbf24"]').length);
    record('选中节点高亮', selectedCircle === 1, `高亮圆数量=${selectedCircle}`);

    // ---------- 12. 控制台无错误 ----------
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
