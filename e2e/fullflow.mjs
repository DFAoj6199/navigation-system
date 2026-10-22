/**
 * 完整流程回归：模拟真实用户，一次连续走完操作手册的 15 个步骤。
 *
 * 与 e2e/verify.mjs 的逐项断言不同，这里输出每一步的真实观察值，
 * 用于人工核对数值是否正确（例如路径长度、坐标误差）。
 *
 * 前置条件：先启动开发服务器（pnpm dev）。
 * 用法：node e2e/fullflow.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173/';
const MAP = path.join(ROOT, 'test-map.png');
const OUT = path.join(ROOT, 'test-results', 'p7');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const log = [];
function step(name, detail) {
  log.push({ name, detail });
  console.log(`[${String(log.length).padStart(2, '0')}] ${name}\n     ${detail}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('dialog', (d) => void d.accept().catch(() => {}));

// ---------- 1. 全新启动 ----------
await page.goto(BASE, { waitUntil: 'networkidle' });
const fresh = await page.evaluate(() => ({
  empty: Boolean(document.querySelector('[data-testid="map-empty"]')),
  emptyText: document.querySelector('[data-testid="map-empty"]')?.innerText.replace(/\n/g, ' ').trim(),
  imageBadge: document.querySelector('header')?.innerText.includes('未加载底图'),
  nodes: document.querySelectorAll('[data-node-marker]').length,
  roads: document.querySelectorAll('[data-road-line="true"]').length,
}));
step('1. 全新启动状态', `空状态=${fresh.empty}，未加载底图=${fresh.imageBadge}，节点=${fresh.nodes}，道路=${fresh.roads}；提示=“${fresh.emptyText}”`);
await page.screenshot({ path: path.join(OUT, '01-fresh.png') });

// ---------- 2. 上传地图 ----------
await page.click('[data-testid="tab-nodes"]');
await page.setInputFiles('[data-testid="file-input"]', MAP);
await page.waitForTimeout(1000);
const uploaded = await page.evaluate(() => ({
  info: document.querySelector('[data-testid="image-info"]')?.innerText.replace(/\n/g, ' | ').trim(),
  hasCanvas: Boolean(document.querySelector('[data-testid="map-canvas"]')),
  zoom: document.querySelector('[data-testid="map-layer"]')?.dataset.zoom,
}));
step('2. 上传地图', `信息=${uploaded.info}，画布=${uploaded.hasCanvas}，初始 zoom=${Number(uploaded.zoom).toFixed(4)}`);

// ---------- 3. 用原始像素坐标添加节点 ----------
const addNode = async (x, y, name) => {
  await page.click('[data-testid="tab-nodes"]');
  await page.waitForTimeout(120);
  await page.fill('[data-testid="input-x"]', String(x));
  await page.fill('[data-testid="input-y"]', String(y));
  await page.fill('[data-testid="input-name"]', name);
  await page.click('[data-testid="add-node-submit"]');
  await page.waitForTimeout(160);
};
const COORDS = [
  [200, 200, '天河体育中心'],
  [1400, 200, '体育东路'],
  [800, 900, '天河北路'],
  [200, 1000, '体育西路'],
  [1400, 1000, '天河东路'],
];
for (const [x, y, n] of COORDS) await addNode(x, y, n);
const nodeState = await page.evaluate(() => ({
  listCount: document.querySelectorAll('[data-testid="node-item"]').length,
  markers: [...document.querySelectorAll('[data-node-marker]')].map((m) =>
    `${m.getAttribute('data-node-id')?.slice(0, 8)}@${m.getAttribute('data-pixel-x')},${m.getAttribute('data-pixel-y')}`),
}));
step('3. 输入原始像素坐标添加节点', `列表 ${nodeState.listCount} 个；地图标记=${nodeState.markers.join(' ')}`);

// 校验一个节点屏幕位置是否与坐标换算一致
await page.click('[data-testid="view-fit"]');
await page.waitForTimeout(300);
const geom = await page.evaluate(() => {
  const layer = document.querySelector('[data-testid="map-layer"]');
  const zoom = Number(layer.dataset.zoom);
  const ox = Number(layer.dataset.offsetX);
  const oy = Number(layer.dataset.offsetY);
  const c = document.querySelector('[data-testid="map-canvas"]');
  const r = c.getBoundingClientRect();
  const left = r.left + c.clientLeft, top = r.top + c.clientTop;
  const out = [];
  for (const m of document.querySelectorAll('[data-node-marker]')) {
    const px = Number(m.getAttribute('data-pixel-x')), py = Number(m.getAttribute('data-pixel-y'));
    const circle = m.querySelector('circle:not([fill="none"])');
    const b = circle.getBoundingClientRect();
    out.push({
      px, py,
      expectX: left + px * zoom + ox, expectY: top + py * zoom + oy,
      actualX: b.left + b.width / 2, actualY: b.top + b.height / 2,
    });
  }
  return out;
});
const maxErr0 = Math.max(...geom.map((g) => Math.hypot(g.expectX - g.actualX, g.expectY - g.actualY)));
step('3b. 坐标换算精度', `5 个节点屏幕位置最大误差 ${maxErr0.toFixed(4)}px`);

// ---------- 4. 缩放和拖动，检查节点位置 ----------
const readCam = async () => page.evaluate(() => {
  const l = document.querySelector('[data-testid="map-layer"]');
  const c = document.querySelector('[data-testid="map-canvas"]');
  const r = c.getBoundingClientRect();
  return { zoom: +l.dataset.zoom, ox: +l.dataset.offsetX, oy: +l.dataset.offsetY, left: r.left + c.clientLeft, top: r.top + c.clientTop };
});
const measureErr = async () => page.evaluate(() => {
  const layer = document.querySelector('[data-testid="map-layer"]');
  const zoom = Number(layer.dataset.zoom), ox = Number(layer.dataset.offsetX), oy = Number(layer.dataset.offsetY);
  const c = document.querySelector('[data-testid="map-canvas"]');
  const r = c.getBoundingClientRect();
  const left = r.left + c.clientLeft, top = r.top + c.clientTop;
  let worst = 0;
  for (const m of document.querySelectorAll('[data-node-marker]')) {
    const px = Number(m.getAttribute('data-pixel-x')), py = Number(m.getAttribute('data-pixel-y'));
    const b = m.querySelector('circle:not([fill="none"])').getBoundingClientRect();
    worst = Math.max(worst, Math.hypot(left + px * zoom + ox - (b.left + b.width / 2), top + py * zoom + oy - (b.top + b.height / 2)));
  }
  return worst;
});
let cam = await readCam();
await page.mouse.move(cam.left + 600, cam.top + 400);
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(70); }
await page.waitForTimeout(200);
const errZoom = await measureErr();
const camAfterZoom = await readCam();
await page.mouse.move(camAfterZoom.left + 650, camAfterZoom.top + 400);
await page.mouse.down();
await page.mouse.move(camAfterZoom.left + 480, camAfterZoom.top + 280, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(250);
const errDrag = await measureErr();
const camAfterDrag = await readCam();
step('4. 缩放 / 拖动后节点位置', `zoom ${cam.zoom.toFixed(3)} → ${camAfterZoom.zoom.toFixed(3)}，offset (${cam.ox.toFixed(0)},${cam.oy.toFixed(0)}) → (${camAfterDrag.ox.toFixed(0)},${camAfterDrag.oy.toFixed(0)})；缩放后误差 ${errZoom.toFixed(4)}px，拖动后误差 ${errDrag.toFixed(4)}px`);
await page.screenshot({ path: path.join(OUT, '02-zoom-drag.png') });

// ---------- 5. 创建双向道路并绘制多个中间点 ----------
await page.click('[data-testid="view-fit"]');
await page.waitForTimeout(300);
const connect = async (from, to, mids = []) => {
  await page.click('[data-testid="tab-roads"]');
  await page.waitForTimeout(200);
  const opts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="road-from-select"] option')].map((o) => ({ v: o.value, t: o.textContent })));
  await page.selectOption('[data-testid="road-from-select"]', opts.find((o) => o.t === from).v);
  await page.selectOption('[data-testid="road-to-select"]', opts.find((o) => o.t === to).v);
  await page.click('[data-testid="road-draw-start"]');
  await page.waitForTimeout(250);
  const c = await readCam();
  for (const [x, y] of mids) {
    await page.mouse.click(c.left + x * c.zoom + c.ox, c.top + y * c.zoom + c.oy);
    await page.waitForTimeout(140);
  }
  await page.click('[data-testid="road-draw-commit"]');
  await page.waitForTimeout(220);
};
await connect('天河体育中心', '体育东路', [[600, 400], [1000, 400]]);
await connect('天河体育中心', '天河北路', [[500, 550]]);
await connect('天河北路', '体育东路');
await connect('天河体育中心', '体育西路');
await connect('体育西路', '天河东路', [[800, 1100]]);
await connect('天河东路', '体育东路');
await page.click('[data-testid="tab-roads"]');
await page.waitForTimeout(300);
const roadState = await page.evaluate(() => ({
  count: document.querySelectorAll('[data-testid="road-item"]').length,
  pointsPerRoad: [...document.querySelectorAll('[data-testid="road-item"]')].map((li) => li.getAttribute('data-point-count')),
  bidirMarks: [...document.querySelectorAll('[data-testid="road-item"]')].length,
  arrows: document.querySelectorAll('[data-testid="road-bidirectional-marker"]').length,
  lines: [...document.querySelectorAll('[data-road-line="true"]')].map((g) => g.getAttribute('data-points')),
}));
step('5. 创建双向道路（含多个中间点）', `道路 ${roadState.count} 条；各道路中间点数=${roadState.pointsPerRoad.join(',')}；地图箭头数=${roadState.arrows}；折线示例=${roadState.lines[0]}`);

// ---------- 6. 修改折线、删除道路、删除节点 ----------
// 中间点默认不在图上画圆点；用于拖动的细小手柄只在“道路管理”页签且该道路被选中时出现。
// 因此拖动前先选中一条带中间点的道路。
const dotsBeforeSelect = await page.evaluate(() => document.querySelectorAll('[data-road-line="true"] circle').length);
const firstRoadWithMid = await page.evaluate(() => {
  const g = [...document.querySelectorAll('[data-road-line="true"]')].find((x) => Number(x.getAttribute('data-point-count')) > 0);
  return g ? g.getAttribute('data-road-id') : null;
});
await page.click(`[data-testid="road-item"][data-road-id="${firstRoadWithMid}"]`);
await page.waitForTimeout(300);
const handlesAfterSelect = await page.evaluate(() => document.querySelectorAll('[data-road-point]').length);
step('5b. 中间点不画圆点，选中道路后才出现拖动小手柄', `未选中时道路上的圆点数=${dotsBeforeSelect}；选中含中间点的道路后手柄数=${handlesAfterSelect}`);

// 修改折线：拖动那条道路的中间点
const dragBefore = await page.evaluate(() => [...document.querySelectorAll('[data-road-point]')].map((c) => `${c.getAttribute('data-pixel-x')},${c.getAttribute('data-pixel-y')}`));
const handle = page.locator('[data-road-point]').first();
const hb = await handle.boundingBox();
const c2 = await readCam();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.mouse.down();
await page.mouse.move(c2.left + 560 * c2.zoom + c2.ox, c2.top + 620 * c2.zoom + c2.oy, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(350);
const dragAfter = await page.evaluate(() => [...document.querySelectorAll('[data-road-point]')].map((c) => `${c.getAttribute('data-pixel-x')},${c.getAttribute('data-pixel-y')}`));
step('6a. 拖动修改道路折线中间点', `中间点坐标 ${dragBefore[0]} → ${dragAfter[0]}（拖到约 560,620）`);

// 删除一条道路
const roadsBeforeDel = await page.locator('[data-testid="road-item"]').count();
await page.locator('[data-testid="road-delete"]').first().click();
await page.waitForTimeout(500);
const roadsAfterDel = await page.locator('[data-testid="road-item"]').count();
step('6b. 删除道路', `道路 ${roadsBeforeDel} → ${roadsAfterDel}`);

// 删除一个节点（含关联道路）
await page.click('[data-testid="tab-nodes"]');
await page.waitForTimeout(250);
// 注意：节点列表只在“节点管理”页签渲染，道路列表只在“道路管理”页签渲染，
// 统计时必须各自回到对应页签，否则会读到 0。
const nodesBeforeDel = await page.locator('[data-testid="node-item"]').count();
const delNodeName = (await page.locator('[data-testid="node-item"]').last().locator('span[title]').textContent()).trim();
await page.click('[data-testid="tab-roads"]');
await page.waitForTimeout(250);
const roadsBeforeNodeDel = await page.locator('[data-testid="road-item"]').count();

await page.click('[data-testid="tab-nodes"]');
await page.waitForTimeout(250);
await page.locator('[data-testid="node-item"]').last().locator('[data-testid="node-delete"]').click();
await page.waitForTimeout(700);
const nodesAfterDel = await page.locator('[data-testid="node-item"]').count();
await page.click('[data-testid="tab-roads"]');
await page.waitForTimeout(300);
const roadsAfterNodeDel = await page.locator('[data-testid="road-item"]').count();
step('6c. 删除节点（级联道路）', `删除「${delNodeName}」：节点 ${nodesBeforeDel} → ${nodesAfterDel}（应 -1），道路 ${roadsBeforeNodeDel} → ${roadsAfterNodeDel}（关联道路一并删除）`);
await page.screenshot({ path: path.join(OUT, '03-roads.png') });

// 重新补齐节点，便于后续寻路
await addNode(1400, 1000, '天河东路');
await page.click('[data-testid="view-fit"]');
await page.waitForTimeout(250);
await connect('体育西路', '天河东路', [[800, 1100]]);
await connect('天河东路', '体育东路');

// ---------- 7. 校准比例尺 ----------
await page.click('[data-testid="tab-scale"]');
await page.waitForTimeout(250);
await page.click('[data-testid="scale-pick-toggle"]');
await page.waitForTimeout(200);
const cs = await readCam();
// 选像素 (0,0) 与 (1000,0)，输入 2000 米 => 2 米/像素
await page.mouse.click(cs.left + 0 * cs.zoom + cs.ox, cs.top + 0 * cs.zoom + cs.oy);
await page.waitForTimeout(200);
await page.mouse.click(cs.left + 1000 * cs.zoom + cs.ox, cs.top + 0 * cs.zoom + cs.oy);
await page.waitForTimeout(250);
const pxDist = await page.textContent('[data-testid="scale-pixel-distance"]');
await page.fill('[data-testid="scale-distance-input"]', '2000');
await page.selectOption('[data-testid="scale-unit-select"]', 'm');
await page.click('[data-testid="scale-apply"]');
await page.waitForTimeout(400);
const scaleInfo = await page.evaluate(() => ({
  status: document.querySelector('[data-testid="scale-status"]')?.innerText.replace(/\n/g, ' | ').trim(),
  ratio: document.querySelector('[data-testid="scale-ratio"]')?.innerText.trim(),
  detail: document.querySelector('[data-testid="scale-detail"]')?.innerText.replace(/\n/g, ' ').trim(),
}));
step('7. 校准比例尺', `像素距离显示=“${pxDist.trim()}”，输入 2000 米；状态=${scaleInfo.status}，比例尺=“${scaleInfo.ratio}”，明细=“${scaleInfo.detail}”；手算 2000/1000=2.0000 米/像素`);
await page.screenshot({ path: path.join(OUT, '04-scale.png') });

// ---------- 8. 验证道路估算距离 ----------
// 道路长度只在“道路管理”页签渲染
await page.click('[data-testid="tab-roads"]');
await page.waitForTimeout(350);
const roadDist = await page.evaluate(() => [...document.querySelectorAll('[data-testid="road-length"]')].map((e) => e.textContent.trim()));
step('8. 道路估算距离（米）', `道路列表长度=${roadDist.join(' | ')}（已校准 2 米/像素，应为实际米数）`);

// ---------- 9/10. 查询所有简单路径 + 最短路径 ----------
await page.click('[data-testid="tab-paths"]');
await page.waitForTimeout(250);
const popts = await page.evaluate(() => [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({ v: o.value, t: o.textContent })));
await page.selectOption('[data-testid="path-start-select"]', popts.find((o) => o.t === '天河体育中心').v);
await page.selectOption('[data-testid="path-end-select"]', popts.find((o) => o.t === '体育东路').v);
await page.click('[data-testid="path-search"]');
await page.waitForTimeout(600);
const pathInfo = await page.evaluate(() => ({
  count: document.querySelector('[data-testid="path-count"]')?.textContent.trim(),
  completeness: document.querySelector('[data-testid="path-completeness"]')?.textContent.trim(),
  complete: document.querySelector('[data-testid="path-completeness"]')?.getAttribute('data-complete'),
  shortest: document.querySelector('[data-testid="path-shortest"]')?.innerText.replace(/\n/g, ' | ').trim(),
  seqs: [...document.querySelectorAll('[data-testid="path-sequence"]')].map((e) => e.textContent.trim()),
  lens: [...document.querySelectorAll('[data-testid="path-item-length"]')].map((e) => e.textContent.trim()),
  unit: document.querySelector('[data-testid="length-unit"]')?.textContent.trim(),
  info: document.querySelector('[data-testid="path-search-info"]')?.innerText.replace(/\n/g, ' ').trim(),
}));
step('9. 全部简单路径', `${pathInfo.count}；完整性=${pathInfo.completeness}（complete=${pathInfo.complete}）；单位=“${pathInfo.unit}”`);
step('9b. 路径序列与长度', pathInfo.seqs.map((s, i) => `${s} = ${pathInfo.lens[i]}`).join('  ||  '));
step('10. 最短路径', `${pathInfo.shortest}；结果区标注=“${pathInfo.info}”`);
await page.screenshot({ path: path.join(OUT, '05-paths.png') });

// ---------- 11. 选择不同路线，检查高亮 ----------
const highlightAt = async () => page.evaluate(() => ({
  roles: [...document.querySelectorAll('[data-node-marker]')].map((m) => `${m.getAttribute('aria-label')?.replace(/节点 | \(.*/g, '')}:${m.getAttribute('data-node-role')}`),
  hlRoads: [...document.querySelectorAll('[data-road-highlighted="true"]')].map((g) => g.getAttribute('data-points')),
  hlNodes: document.querySelectorAll('[data-node-role="start"]').length + '/' + document.querySelectorAll('[data-node-role="end"]').length,
}));
const hl1 = await highlightAt();
const itemCount = await page.locator('[data-testid="path-item"]').count();
let hl2 = null;
if (itemCount > 1) {
  await page.locator('[data-testid="path-item"]').nth(1).click();
  await page.waitForTimeout(450);
  hl2 = await highlightAt();
}
step('11. 选择不同路线检查高亮', `默认高亮道路=${JSON.stringify(hl1.hlRoads)}；起/终点数=${hl1.hlNodes}；节点角色=${hl1.roles.join(' ')}` + (hl2 ? `\n     切换第2条后高亮道路=${JSON.stringify(hl2.hlRoads)}` : '（仅 1 条路线）'));
await page.screenshot({ path: path.join(OUT, '06-highlight.png') });

// ---------- 12. 不可达终点 ----------
await page.click('[data-testid="tab-nodes"]');
await page.waitForTimeout(200);
await addNode(1500, 60, '孤立点');
await page.click('[data-testid="tab-paths"]');
await page.waitForTimeout(250);
const popts2 = await page.evaluate(() => [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({ v: o.value, t: o.textContent })));
await page.selectOption('[data-testid="path-start-select"]', popts2.find((o) => o.t === '天河体育中心').v);
await page.selectOption('[data-testid="path-end-select"]', popts2.find((o) => o.t === '孤立点').v);
await page.click('[data-testid="path-search"]');
await page.waitForTimeout(600);
const noPath = await page.evaluate(() => ({
  text: document.querySelector('[data-testid="path-no-result"]')?.textContent.trim(),
  hl: document.querySelectorAll('[data-road-highlighted="true"]').length,
  shortest: document.querySelectorAll('[data-testid="path-shortest"]').length,
  items: document.querySelectorAll('[data-testid="path-item"]').length,
  info: document.querySelector('[data-testid="path-search-info"]')?.innerText.replace(/\n/g, ' ').trim(),
}));
step('12. 不可达终点', `提示=“${noPath.text}”；残留高亮=${noPath.hl}；最短路径框=${noPath.shortest}；结果条目=${noPath.items}；标注=“${noPath.info}”`);
await page.screenshot({ path: path.join(OUT, '07-nopath.png') });

// ---------- 13. 导出再导入 ----------
await page.click('[data-testid="tab-project"]');
await page.waitForTimeout(300);
const beforeExport = await page.evaluate(() => ({
  counts: document.querySelector('[data-testid="project-counts"]')?.textContent.trim(),
  scale: document.querySelector('[data-testid="project-scale"]')?.textContent.trim(),
  embed: document.querySelector('[data-testid="project-embed"]')?.textContent.trim(),
}));
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="project-export"]')]);
const file = path.join(OUT, dl.suggestedFilename());
await dl.saveAs(file);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
step('13a. 导出项目', `${dl.suggestedFilename()}（${(fs.statSync(file).size / 1024).toFixed(1)} KB）；节点=${raw.nodes.length}、道路=${raw.roads.length}、中间点=${JSON.stringify(raw.roads.map((r) => r.points.length))}、米/像素=${raw.scale?.metersPerPixel}、内嵌=${raw.image.dataUrl ? '是' : '否'}`);

// 清空后重新导入
await page.click('[data-testid="tab-nodes"]');
await page.waitForTimeout(200);
for (let i = 0; i < 30; i++) {
  const n = await page.locator('[data-testid="node-item"]').count();
  if (n === 0) break;
  await page.locator('[data-testid="node-item"]').first().locator('[data-testid="node-delete"]').click();
  await page.waitForTimeout(200);
}
await page.evaluate(() => { const d = document.querySelector('[data-testid="uploader-details"]'); if (d && !d.open) d.open = true; });
await page.waitForTimeout(200);
await page.getByRole('button', { name: '移除底图' }).click();
await page.waitForTimeout(600);
const cleared = await page.evaluate(() => ({
  empty: Boolean(document.querySelector('[data-testid="map-empty"]')),
  text: document.querySelector('[data-testid="map-empty"]')?.innerText.replace(/\n/g, ' ').slice(0, 40),
}));
step('13b. 清空当前项目', `空状态=${cleared.empty}，提示=“${cleared.text}”`);

await page.click('[data-testid="tab-project"]');
await page.waitForTimeout(250);
await page.setInputFiles('[data-testid="project-file-input"]', file);
await page.waitForTimeout(1600);
const imported = await page.evaluate(() => ({
  counts: document.querySelector('[data-testid="project-counts"]')?.textContent.trim(),
  scale: document.querySelector('[data-testid="project-scale"]')?.textContent.trim(),
  embed: document.querySelector('[data-testid="project-embed"]')?.textContent.trim(),
  canvas: Boolean(document.querySelector('[data-testid="map-canvas"]')),
  markers: document.querySelectorAll('[data-node-marker]').length,
  roads: document.querySelectorAll('[data-road-line="true"]').length,
}));
step('13c. 重新导入', `节点/道路=${imported.counts}；比例尺=${imported.scale}；内嵌=${imported.embed}；画布=${imported.canvas}；地图节点=${imported.markers}、道路=${imported.roads}`);
await page.screenshot({ path: path.join(OUT, '08-imported.png') });

// ---------- 14. 验证导入后的地图/节点/道路/比例尺/搜索 ----------
const consistency = await page.evaluate(() => {
  const markers = [...document.querySelectorAll('[data-node-marker]')].map((m) => ({ id: m.getAttribute('data-node-id'), x: +m.getAttribute('data-pixel-x'), y: +m.getAttribute('data-pixel-y') }));
  const roads = [...document.querySelectorAll('[data-road-line="true"]')].map((g) => ({ pts: g.getAttribute('data-points'), mids: Number(g.getAttribute('data-point-count')), dots: g.querySelectorAll('circle').length }));
  return { markers, roads };
});
const fileNodeMap = new Map(raw.nodes.map((n) => [n.id, `${n.point.x},${n.point.y}`]));
const nodesMatch = consistency.markers.length === raw.nodes.length && consistency.markers.every((m) => fileNodeMap.get(m.id) === `${m.x},${m.y}`);
const roadsMatch = consistency.roads.length === raw.roads.length && consistency.roads.every((r) => r.pts.trim().split(/\s+/).length === r.mids + 2);
const noDots = consistency.roads.every((r) => r.dots === 0);
step('14a. 导入后节点/道路一致性', `节点完全一致=${nodesMatch}（${consistency.markers.length}/${raw.nodes.length}）；道路折线点数=中间点+2：${roadsMatch}；地图上中间点圆点数=${consistency.roads.map((r) => r.dots).join(',')}（全为 0=${noDots}）`);

await page.click('[data-testid="tab-paths"]');
await page.waitForTimeout(300);
const popts3 = await page.evaluate(() => [...document.querySelectorAll('[data-testid="path-start-select"] option')].map((o) => ({ v: o.value, t: o.textContent })));
await page.selectOption('[data-testid="path-start-select"]', popts3.find((o) => o.t === '天河体育中心').v);
await page.selectOption('[data-testid="path-end-select"]', popts3.find((o) => o.t === '体育东路').v);
await page.click('[data-testid="path-search"]');
await page.waitForTimeout(700);
const afterImportSearch = await page.evaluate(() => ({
  count: document.querySelector('[data-testid="path-count"]')?.textContent.trim(),
  shortest: document.querySelector('[data-testid="path-shortest"]')?.innerText.replace(/\n/g, ' | ').trim(),
  unit: document.querySelector('[data-testid="length-unit"]')?.textContent.trim(),
  hl: document.querySelectorAll('[data-road-highlighted="true"]').length,
}));
step('14b. 导入后搜索功能', `${afterImportSearch.count}；最短路径=${afterImportSearch.shortest}；单位=${afterImportSearch.unit}；高亮道路=${afterImportSearch.hl}`);

// ---------- 15. 控制台检查 ----------
step('15. 浏览器控制台', consoleErrors.length ? `发现 ${consoleErrors.length} 条错误：${consoleErrors.join(' | ')}` : '无 JS 错误、无 console.error');
await page.screenshot({ path: path.join(OUT, '09-final.png') });

fs.writeFileSync(path.join(OUT, 'flow-log.json'), JSON.stringify(log, null, 2));
console.log('\n===== 流程完成 =====');
await browser.close();
