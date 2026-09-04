/* QA 報告第五輪 LE-5：這份檔案第五輪之後同時被兩個不同的執行環境使用——GitHub Pages 上純靜態的
   使用者頁面（build_deploy.py 產生 dist-web/shared.js，脫掉這層 <script> 外殼）、以及仍然留在
   Apps Script HtmlService 沙盒 iframe 裡的管理介面即時預覽（繼續用 include_() 整份含殼引入）。
   改這份檔案時要同時考慮兩邊：使用者頁面能直接讀 location.search、fetch()，管理介面不行
   （沙盒 iframe 裡那些會讀到空值或被攔截）；不要在這裡加任何假設「這一定是在管理介面/使用者
   頁面裡執行」的程式碼。renderClouds()／renderSentenceBubbleEl() 這類跟畫面渲染相關的邏輯，
   Viewer_JS.html 跟 Admin_JS_Preview.html 本來就是各自維護一份、只共用這份檔案裡的底層工具函式
   （layoutMiddleClouds、centerStageScroll 等）——兩邊執行環境不同之後，這兩份各自維護的渲染
   邏輯之間漂移的機會更高，之前 R-1 的排版修正就是兩邊都要改的例子，改完記得比照辦理。 */
/* ---------------- Color helpers (for deriving full themes from base colors) ---------------- */
function hexToRgb(hex){
  hex = hex.replace('#','');
  if(hex.length===3) hex = hex.split('').map(c=>c+c).join('');
  const num = parseInt(hex,16);
  return { r:(num>>16)&255, g:(num>>8)&255, b:num&255 };
}
function rgbToHex(r,g,b){
  return '#' + [r,g,b].map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('');
}
function mixHex(hexA, hexB, t){
  const a = hexToRgb(hexA), b = hexToRgb(hexB);
  return rgbToHex(a.r+(b.r-a.r)*t, a.g+(b.g-a.g)*t, a.b+(b.b-a.b)*t);
}
function hexToRgba(hex, alpha){
  const {r,g,b} = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
let INK_DARK = '#3B2A1B';
function tint(hex){ return mixHex(hex, '#FFFFFF', 0.55); }
function shade(hex){ return mixHex(hex, INK_DARK, 0.18); }
function inkLine(hex){ return mixHex(hex, INK_DARK, 0.62); }

/* 情緒顏色在 buildDefs() 裡會被直接拼進 SVG 漸層的 innerHTML 樣板字面值
   （`<stop stop-color="${emo.color}"/>`），沒有經過任何跳脫。tint()/shade() 因為內部會走
   parseInt(..., 16)，遇到不是十六進位的字串時會產出 NaN 系列的亂碼，意外地把惡意字串「消化」
   掉了——但那是副作用，不是設計出來的防護，不能依賴它。stop-color 那一行用的是**原始**
   emo.color，完全沒有經過 tint/shade，是真正可以被利用的注入點：只要顏色欄位曾經被塞進類似
   `red" x="1"/><image href=x onerror=alert(document.cookie)//` 這種字串，就會跳脫屬性、
   在 SVG 裡插入新元素觸發——而 Viewer 頁面完全公開、不需要登入，任何打開情緒輪的訪客都會
   中招。伺服器端（Code.gs 的 normalizeHexColor_）在讀寫結構化工作表時也做了同樣的檢查，但
   「已發佈快照」跟「背景自動存檔」這兩份資料是直接把前端送來的 JSON 整包存進去，不會經過
   那道檢查——顏色資料實際上有三條不同的路徑會流到這裡，攔截點放在真正輸出到畫面的這一刻，
   才能保證不管資料是從哪條路徑來的都安全。 */
function sanitizeColor(hex, fallback){
  const s = String(hex == null ? '' : hex).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : (fallback || '#CCCCCC');
}

/* 主題色（theme vars）可能是 #rrggbb／#rgb 或 rgba(...)（glow，帶透明度）兩種語法，跟情緒色
   固定只有 #rrggbb 一種格式不一樣，不能直接套用上面的 sanitizeColor()。
   QA 報告 M-2（已實測成功）：applyTheme() 以前直接把伺服器回傳的 theme 每個欄位塞進 CSS
   自訂屬性（style.setProperty），中間完全沒有驗證——把 theme.bg 設成
   url("http://.../beacon.png")，公開頁面就對外發出請求，能把每一個開啟情緒輪頁面的案主的
   IP 跟時間回報給外部第三方。伺服器端（Code.gs 的 normalizeCssColor_）在組已發佈快照時也做了
   同樣的檢查，但「有人直接在 Google Sheets 裡編輯 PublishedSnapshot 那格 JSON」這條管道完全
   不經過任何一行 Code.gs——攔截點放在真正 setProperty 進 CSS 的這一刻，才能保證不管資料是
   從哪條路徑來的都安全，這也是為什麼讀取端比寫入端更重要。
   只允許三種語法：#rrggbb／#rgb、rgb(r,g,b)、rgba(r,g,b,a)，且每個數字都要落在合法範圍
   （0-255，alpha 0-1）——嚴格比對整個字串（^...$），不是找片段有沒有出現，避免
   `rgb(0,0,0); background:url(evil)` 這種夾帶額外語法的字串被誤判成合法。 */
function sanitizeCssColor(value, fallback){
  const s = String(value == null ? '' : value).trim();
  // fallback 用 undefined 判斷、不是用 ||（這裡故意不跟上面的 sanitizeColor() 一樣）——
  // accent2／glow2 留空是刻意的語意（交給前端從 accent／ink 推導，見 Code.gs 的
  // normalizeHexColor_ 對同一件事的說明），呼叫端會明確傳 '' 當 fallback；用 || 的話這個
  // 空字串會被判定成 falsy，悄悄換成 #CCCCCC，把刻意的空字串語意吃掉。
  const fb = fallback === undefined ? '#CCCCCC' : fallback;
  if(/^#[0-9a-fA-F]{3}$/.test(s) || /^#[0-9a-fA-F]{6}$/.test(s)) return s;
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+)\s*)?\)$/i.exec(s);
  if(m){
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    if(r <= 255 && g <= 255 && b <= 255 && a >= 0 && a <= 1) return s;
  }
  return fb;
}

/* ---------------- Geometry ---------------- */
const CX = 420, CY = 420, R_OUTER = 165, R_INNER = 75;
const R_MID = R_OUTER + 70;
const R_SENT = R_OUTER + 150;
const SENT_SPREAD = [-58, -19, 19, 58];
const SENT_RADIUS_JITTER = [-14, 10, -10, 14];
const ZOOM_K = 2.35;

/* QA 報告第六輪 F-2：泡泡句要退到中層雲外面多遠，倍率乘在「量到的中層雲半高 + 泡泡句半高
   + 14」上（見 Viewer_JS.html 的 renderSentenceBubbleEl／Admin_JS_Preview.html 的
   renderPreviewSentenceBubbleEl，兩邊共用這個常數，不要各自寫死一份數字，那正是這次要修的
   漂移風險）。原本是 0.7，第二輪 R-1（批次 9）當時是為了「避免泡泡句被推出可視區」加的折扣，
   但那組驗收標準是用合成的長詞假資料（「開心中層0」這種 6 字詞）量出來的——真實的
   Code.gs SAMPLE_EMOTIONS_ 是「知足」「失落」這種 2 字短詞，短詞會讓 layoutMiddleClouds()
   把 4 個中層詞全部塞進同一圈，幾何條件完全不同，用真實資料重量在 0.7 這個舊值下最嚴重
   重疊高達 70%。第三輪（批次 15）加上 centerStageScroll() 自動置中之後，「泡泡句被推出
   可視區」這個 0.7 原本要解的問題已經不成立（實測超出可視區只剩個位數 px），改成 1.5——
   用真實 SAMPLE_EMOTIONS_ 資料、375px、9 個情緒逐一實測掃出來的：1.5 讓最嚴重重疊降到個位數
   百分比、沒有任何情緒超過 18% 的驗收標準，同時「完全捲不到」的雲朵數維持 0（見批次 23
   進度記錄的完整實測數字）。 */
const SENTENCE_CLEARANCE_FACTOR = 1.5;

/* 中層詞雲的排版常數。原本是 4 個寫死的角度（MID_SPREAD = [-46,-15,15,46]）用 idx % 4 取值，
   所以第 5 個中層詞會跟第 1 個落在「完全相同」的座標上、整朵被蓋住又點不到，而且完全沒有
   錯誤訊息——心理師替某個情緒加第 5 個中層詞是完全正常的編輯行為，所以改成動態排版。

   為什麼不是「塞進該情緒扇形的 360/n 夾角內」：選了情緒之後其他扇區會整個淡出
   （applyWheelState 把它們的 opacity 設成 0），畫面上只剩這一個情緒的中層詞，
   沒有跟鄰居搶位置的問題；而 9 個情緒的扇形只有 40°，硬塞進去只會更擠。 */
const MID_BASE_HALF_SPAN = 46;   // 詞少的時候維持原本的視覺手感
const MID_MAX_HALF_SPAN = 74;    // 再寬就會繞到圓餅側面，看起來不像屬於這個扇形
const MID_RING_GAP = 58;         // 一圈放不下時，往外再開一圈的半徑間距
const MID_ANGLE_MARGIN = 5;      // 相鄰兩朵雲之間額外留的角度餘裕

/* 由外而內一次飄幾顆泡泡。使用者頁面與管理預覽共用，避免兩邊各寫一份而悄悄漂移。 */
const OUTWARD_DESKTOP_COUNT = 11;
const OUTWARD_MOBILE_COUNT = 8;

/*
  [歷史命名備註]
  注意：本系統的程式碼命名與實際探索方向在字義上是相反的。
  'inward' (基礎模式)：實際上是由內核心向外展開 (Center -> Edge)。
  'outward' (探索模式)：實際上是由外圍泡泡向內深掘 (Edge -> Center)。
  因考慮到資料庫相容性，保留此遺留命名。
*/
/* 輪的探索方向。'both' 會在使用者頁面左側長出切換鈕，讓案主自己選。 */
const WHEEL_MODES = [
  { id: 'inward', label: '由內而外', desc: '先選基礎情緒，再往下看中層詞與泡泡句' },
  { id: 'outward', label: '由外而內', desc: '泡泡句先飄浮，點一句再往內揭示它背後的情緒' },
  { id: 'both', label: '兩種都可以', desc: '使用者頁面左側會出現切換鈕，讓案主自己選要用哪一種' },
];
const BLOB_RADII = [
  '42% 58% 55% 45% / 45% 42% 58% 55%',
  '58% 42% 47% 53% / 40% 58% 42% 60%',
  '48% 52% 62% 38% / 55% 45% 55% 45%',
  '55% 45% 42% 58% / 48% 55% 45% 52%',
];
function polar(cx, cy, r, angleDeg){ const a = (angleDeg - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; }
function arcPath(cx, cy, rOuter, rInner, startAngle, endAngle){
  const p1 = polar(cx, cy, rOuter, endAngle), p2 = polar(cx, cy, rOuter, startAngle);
  const p3 = polar(cx, cy, rInner, startAngle), p4 = polar(cx, cy, rInner, endAngle);
  const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
  return ['M', p1.x, p1.y,'A', rOuter, rOuter, 0, largeArc, 0, p2.x, p2.y,
    'L', p3.x, p3.y,'A', rInner, rInner, 0, largeArc, 1, p4.x, p4.y,'Z'].join(' ');
}
function bisectorAngle(i, n){ const step = 360 / n; return i * step + step / 2; }

/* ---------------- Global font choice — the FONTS list itself is shared (Admin's picker UI reads
   the extra `desc` field on each entry; Viewer simply never looks at it, so carrying it there is
   harmless), but each file keeps its OWN currentFontId/fontFaceLoads/ensureFontFaceLoaded/
   fontCssStack/applyFont, since font *loading* is a different job in an editor with a live-swappable
   picker vs. a page that just applies whatever the published snapshot says once.
   Pinned to commit hashes (not @main / a floating tag) — see the per-entry comments below for why. ---------------- */
const DEFAULT_FONT_STACK = `"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif`;
const FONTS = [
  { id: 'system', name: '系統預設字體', desc: '不額外載入任何字型檔案，直接用裝置上的預設中文字體，載入最快、最保險。', textScale: 1 },
  { id: 'chenyu', name: '辰宇落雁體', desc: '手寫溫度感的開源字型（高中生創作，OFL 授權），適合水彩繪本風的調性。', family: 'ChenYuLuoYan', textScale: 1.35,
    // Pinned to a commit hash (not @main) — @main is a floating branch reference that can silently
    // change or break if the upstream repo restructures; a commit hash can never change under you.
    url: 'https://cdn.jsdelivr.net/gh/Chenyu-otf/chenyuluoyan_thin@06207b4d03c53d37fe28e38fb4ae15d9f63621af/ChenYuluoyan-2.0-Thin.ttf', format: 'truetype' },
  { id: 'openhuninn', name: 'OPEN粉圓', desc: '圓潤可愛的開源圓體（justfont 團隊創作，OFL 授權）。', family: 'jfOpenHuninn', textScale: 1.1,
    // Pinned to v1.1's commit hash rather than the "@1.1" tag alias — tags can technically be moved
    // by the repo owner (unlike a commit hash), so this is the most immutable form of pinning short
    // of self-hosting the file.
    url: 'https://cdn.jsdelivr.net/gh/marsnow/open-huninn-font@1f7c596821d7e76b0c84cab625a0eba06a3a12a8/font/jf-openhuninn.woff', format: 'woff' },
];


/* ============================================================
   以下是「使用者頁面」與「管理介面即時預覽」共用的排版／互動邏輯。
   放在這裡是刻意的：本機版是兩個獨立的 .html 檔案，同一套演算法只能各寫一份、靠人工同步；
   Apps Script 有 include() 機制，就把共用的部分收在這一個檔案裡，兩邊都 include 進去，
   從此不會再有「改了使用者頁面卻忘了改管理預覽」這種漂移。
   ============================================================ */

/* 中層詞雲的動態排版：取代原本寫死的 4 個角度格子。
   做法跟這個檔案裡其他排版一樣「先量真實尺寸再算位置」——中層詞的寬度完全取決於字數與
   使用者裝置上實際的中文字體，猜不準；量出來才知道一圈到底放得下幾個。
   排不下就往外再開一圈（而不是硬擠在同一圈上），這樣不管幾個中層詞都不會互相蓋住。
   全程沒有亂數：同一份資料每次重繪都會排在同一個位置，不會跳來跳去。 */
function layoutMiddleClouds(middles, angle){
  const wrap = document.getElementById('wheelWrap');
  const layer = document.getElementById('bubbleLayer');
  const stageW = wrap.clientWidth || 1;
  // 雲朵用 % 定位在 840×840 的 viewBox 座標系裡，但量到的是 CSS 像素，要換算回 viewBox 單位
  const vbPerPx = (CX * 2) / stageW;

  const temp = middles.map(m => {
    const el = document.createElement('div');
    el.className = 'cloud cloud-mid';
    el.style.visibility = 'hidden';
    el.style.left = '0'; el.style.top = '0';
    el.textContent = m.label || '(未命名)';
    layer.appendChild(el);
    return el;
  });
  // ::before 的墨水底往外撐 calc(-6*var(--px)) 上下、calc(-8*var(--px)) 左右，--px 就是 1 個 viewBox 單位
  const widths = temp.map(el => el.offsetWidth * vbPerPx + 16);
  const heights = temp.map(el => el.offsetHeight * vbPerPx + 12);
  temp.forEach(el => el.remove());

  // 一個寬 w 的雲放在半徑 r 那一圈上，會佔掉多少角度
  const angularWidth = (w, r) => 2 * Math.asin(Math.min(1, (w / 2) / r)) * 180 / Math.PI + MID_ANGLE_MARGIN;

  // 先分圈：從內圈開始塞，這一圈的角度總和超過上限就往外開一圈。
  // 外圈半徑更大、同樣的雲佔掉的角度更小，所以一定會收斂，不會無限開圈。
  const MAX_SPAN = MID_MAX_HALF_SPAN * 2;
  const rings = [];
  let ring = { r: R_MID, items: [], total: 0 };
  middles.forEach((m, idx) => {
    if(ring.items.length && ring.total + angularWidth(widths[idx], ring.r) > MAX_SPAN){
      rings.push(ring);
      ring = { r: R_MID + rings.length * MID_RING_GAP, items: [], total: 0 };
    }
    const aw = angularWidth(widths[idx], ring.r);
    ring.items.push({ idx, aw });
    ring.total += aw;
  });
  if(ring.items.length) rings.push(ring);

  // 再把每一圈以情緒的方位角為中心、左右對稱地攤開。
  // 想要的張角：沿用原本 4 個詞 ±46°（共 92°）的比例，2 個詞就約 31°、3 個約 61°，
  // 讓詞少的時候看起來跟以前一樣，不會突然攤得很開。
  const out = new Array(middles.length);
  rings.forEach(rg => {
    const n = rg.items.length;
    const preferred = n > 1 ? (MID_BASE_HALF_SPAN * 2) * (n - 1) / 3 : 0;
    // 至少要放得下（rg.total），最多不超過上限
    const used = Math.min(MAX_SPAN, Math.max(rg.total, preferred));
    let cursor = -used / 2;
    rg.items.forEach(it => {
      const share = used * (it.aw / rg.total);   // 寬的雲分到比較大的角度份額
      const a = angle + cursor + share / 2;
      cursor += share;
      out[it.idx] = { angle: a, radius: rg.r, pos: polar(CX, CY, rg.r, a) };
    });
  });

  /* 最後一道防線：分圈只保證「同一圈內」排得開，相鄰兩圈的雲仍可能在角度接近時湊在一起
     （實測 12 個中層詞時就有 3 組是跨圈相撞）。這裡照實際量到的寬高做一次 AABB 檢查，
     撞到的就沿著自己的方位角往外推，推到不撞為止——推的是半徑不是角度，所以每朵雲
     仍然待在「屬於這個情緒的方向」上，只是離圓心遠一點。 */
  const placed = [];
  out.forEach((o, idx) => {
    const hw = widths[idx] / 2, hh = heights[idx] / 2;
    let r = o.radius, p = o.pos, guard = 0;
    while(guard++ < 60 && placed.some(q =>
      Math.abs(p.x - q.x) < hw + q.hw && Math.abs(p.y - q.y) < hh + q.hh)){
      r += 16;
      p = polar(CX, CY, r, o.angle);
    }
    o.radius = r; o.pos = p;
    placed.push({ x: p.x, y: p.y, hw, hh });
  });
  return out;
}

/* 讓一個非 <button> 的元素也能用鍵盤操作（Tab 走到、Enter／Space 觸發）。
   雲朵與扇區都是 div/SVG，本身沒有任何鍵盤語意，對只能用鍵盤或讀螢幕的使用者等於不存在。 */
/* 記錄使用者現在是用鍵盤還是滑鼠在操作。只有按過 Tab 之後，焦點框才會亮起來；
   一碰滑鼠或觸控就關掉。這比 :focus-visible 可靠——瀏覽器對 SVG 元素的判斷會把
   滑鼠點擊也算成「需要顯示焦點」，導致點一下圓餅就多出一個沿著矩形邊界畫的方框。 */
(function markKeyboardNav(){
  const root = document.documentElement;
  window.addEventListener('keydown', (e) => {
    if(e.key === 'Tab') root.classList.add('kbd-nav');
  });
  window.addEventListener('mousedown', () => root.classList.remove('kbd-nav'));
  window.addEventListener('touchstart', () => root.classList.remove('kbd-nav'), { passive: true });
})();

function makeActivatable(el, onActivate, label){
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  if(label) el.setAttribute('aria-label', label);
  el.addEventListener('keydown', (e) => {
    if(e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar'){
      e.preventDefault();
      onActivate();
    }
  });
}

/* 泡泡的實際寬高完全看使用者裝置裝了哪款中文字體（這個 app 沒有內嵌網頁字型，見備忘），
   同一句話在不同電腦上量出來的寬度不一樣，猜一個百分比常數永遠賭不準。改成「先掛進畫面、
   量真實渲染出來的框，再用這個真實尺寸做防碰撞」——不管使用者裝置字體是什麼，算出來的
   安全距離都是照著「這台裝置實際會畫出多大」算的，不是憑空假設。
   判定用 AABB（矩形）而不是圓形／橢圓形距離：泡泡本身就是矩形（圓角只是視覺，不影響碰撞
   判定），矩形防碰撞的規則很單純——兩個矩形只要「水平間距 ≥ 兩者半寬和」或「垂直間距 ≥
   兩者半高和」任一成立，就不會重疊，不需要再猜橢圓的權重該抓多少。 */
function layoutOutwardPositions(batch){
  const wrap = document.getElementById('wheelWrap');
  const layer = document.getElementById('bubbleLayer');
  const stageW = wrap.clientWidth || 1, stageH = wrap.clientHeight || 1;
  const CENTER_KEEP = 13;   // 中央留白（% ），等一下揭示時主角要站這裡
  // outward 模式 .cloud-sentence::before 的墨水外擴是 inset:-5px -7px——這才是使用者「眼睛
  // 看到」的視覺邊界，比 offsetWidth/Height 量到的文字方塊本身還大一圈，要算進碰撞判定。
  const INK_BLEED_X = 7, INK_BLEED_Y = 5;
  // 每顆泡泡都有自己獨立、隨機相位的呼吸飄浮動畫（--drift-x 4~12px／--drift-y 5~14px，
  // 50% 相位時 y 還會再乘 1.6），會讓靜態算好的位置在動畫過程中悄悄靠近。這裡抓一個折衷值
  // 當緩衝——不是每次都用滿滿的最大振幅（那樣會逼所有泡泡都散得太開，見下面 fallback 統計），
  // 但足夠讓「兩顆同時飄向對方」的情況也還有餘裕。
  const DRIFT_BUFFER = 10;

  // 量測：暫時把每顆泡泡的真實文字掛進畫面（visibility:hidden，使用者看不到），
  // 量出它在「這個裝置、這個字體」下實際渲染出來的寬高，量完就丟掉。
  const temp = batch.map(b => {
    const el = document.createElement('div');
    el.className = 'cloud cloud-sentence cloud-drift';
    el.style.visibility = 'hidden';
    el.style.left = '0'; el.style.top = '0';
    el.textContent = b.text;
    layer.appendChild(el);
    return el;
  });
  const halfExtents = temp.map(el => ({
    hw: ((el.offsetWidth / 2 + INK_BLEED_X + DRIFT_BUFFER) / stageW) * 100,
    hh: ((el.offsetHeight / 2 + INK_BLEED_Y + DRIFT_BUFFER) / stageH) * 100,
  }));
  temp.forEach(el => el.remove());

  const positions = [];
  for(let i = 0; i < batch.length; i++){
    let best = null, bestScore = -Infinity;
    for(let attempt = 0; attempt < 300; attempt++){
      const x = 20 + Math.random() * 60;
      const y = 14 + Math.random() * 72;
      if(Math.hypot(x - 50, y - 50) < CENTER_KEEP) continue;
      let ok = true, minSlack = Infinity;
      for(let j = 0; j < positions.length; j++){
        const dx = Math.abs(positions[j].x - x), dy = Math.abs(positions[j].y - y);
        const needX = halfExtents[i].hw + halfExtents[j].hw;
        const needY = halfExtents[i].hh + halfExtents[j].hh;
        // 矩形防碰撞：水平或垂直只要有一軸的間距蓋過兩者半寬／半高和，就不算重疊。
        // slack 是「離達標還差多少」，負的代表還在重疊，正的代表已經有安全空間。
        const slack = Math.max(dx - needX, dy - needY);
        if(slack < 0) ok = false;
        if(slack < minSlack) minSlack = slack;
      }
      if(ok){ best = { x, y }; break; }
      if(!positions.length){ best = { x, y }; break; }
      if(minSlack > bestScore){ bestScore = minSlack; best = { x, y }; } // 退而求其次：挑最不擠的
    }
    positions.push(best || { x: 50, y: 50 });
  }
  return positions;
}

/* HideMiddleLayer 專用：固定 4 個角度格子（SENT_SPREAD）是給「一個中層詞的 4 句」設計的，
   這種輪一次要擠下「所有中層詞的所有泡泡句」（可能十幾二十句），格子數量完全不夠用，硬套
   固定格子只會讓不同中層詞的泡泡疊在同樣的 4 個角度上。改用跟 outward 飄浮泡泡同一套
   「先掛進畫面量真實尺寸、再用 AABB 防碰撞」的邏輯。
   位置搜尋刻意用「整個舞台」而不是侷限在這個情緒的扇形附近：選了情緒之後 applyWheelState()
   會把其他扇區的 opacity 全部歸零、只留這一片放大填滿畫面，等於整個舞台這時候都是空的——
   侷限在窄扇形內搜尋，等於自己把可用空間縮小了好幾倍，泡泡一多（十幾顆）根本擠不下。 */
function layoutHideMiddleBubbles(items){
  const wrap = document.getElementById('wheelWrap');
  const layer = document.getElementById('bubbleLayer');
  const stageW = wrap.clientWidth || 1, stageH = wrap.clientHeight || 1;

  const temp = items.map(it => {
    const el = document.createElement('div');
    el.className = 'cloud cloud-sentence';
    el.style.visibility = 'hidden';
    el.style.left = '0'; el.style.top = '0';
    el.textContent = it.text;
    layer.appendChild(el);
    return el;
  });
  // .cloud-sentence::before 的 inset 是 calc(-7*var(--px)) calc(-9*var(--px))，桌機 --px≈1，
  // 手機會更小——這裡用桌機的滿額當估計值，寧可手機上留白多一點，也不要低估墨水外擴。
  const halfExtents = temp.map(el => ({
    hw: (el.offsetWidth / 2 + 9) / stageW * 100,
    hh: (el.offsetHeight / 2 + 7) / stageH * 100,
  }));
  temp.forEach(el => el.remove());

  const positions = [];
  for(let idx = 0; idx < items.length; idx++){
    let best = null, bestScore = -Infinity;
    for(let attempt = 0; attempt < 400; attempt++){
      const x = 6 + Math.random() * 88, y = 6 + Math.random() * 88;
      if(Math.hypot(x - 50, y - 50) < 10) continue; // 中央留一點空間給扇區本身的情緒標籤
      let ok = true, minSlack = Infinity;
      for(let j = 0; j < positions.length; j++){
        const dx = Math.abs(positions[j].x - x), dy = Math.abs(positions[j].y - y);
        const needX = halfExtents[idx].hw + halfExtents[j].hw;
        const needY = halfExtents[idx].hh + halfExtents[j].hh;
        const slack = Math.max(dx - needX, dy - needY);
        if(slack < 0) ok = false;
        if(slack < minSlack) minSlack = slack;
      }
      if(ok){ best = { x, y }; break; }
      if(!positions.length){ best = { x, y }; break; }
      if(minSlack > bestScore){ bestScore = minSlack; best = { x, y }; }
    }
    positions.push(best || { x: 50, y: 50 });
  }
  return positions;
}

/* 目前這一批泡泡要抽幾顆（手機少一點，免得太擠、觸控目標太小）。 */
function outwardSampleTarget(total){
  return Math.min(total, window.innerWidth < 768 ? OUTWARD_MOBILE_COUNT : OUTWARD_DESKTOP_COUNT);
}

/* 把整個輪攤平成一份泡泡清單，每顆都記得自己來自哪個情緒／中層／第幾句。
   因為每顆泡泡都自帶來源，揭示時要顯示誰是完全明確的——即使有兩句字面相同，
   它們是兩筆各自獨立的紀錄，不會混淆。 */
function outwardBubblesOf(emotionList){
  const out = [];
  (emotionList || []).forEach(emo => {
    (emo.middles || []).forEach((mid, midIndex) => {
      (mid.bubbles || []).forEach((text, i) => {
        if(!text || !text.trim()) return;
        out.push({ emo, mid, midIndex, bubbleIndex: i, text: text.trim(),
                   tagKey: emo.id + '::' + mid.id + '::' + i });
      });
    });
  });
  return out;
}

/* 抽樣規則：輪替涵蓋（這批沒出現的下一批優先）＋ 同批文字去重 ＋ 每個基礎情緒的數量上限。
   perEmotionCap 是必要的，不能只靠 round-robin：輪替週期快結束時可能只剩一兩個情緒還有
   「沒出現過」的泡泡，光靠 round-robin 會一直在那兩個情緒之間繞、把整批洗版成同一個情緒。
   seen 是呼叫端自己保管的 Set（使用者頁面與管理預覽各有一份，互不干擾）。 */
function sampleOutwardFrom(all, seen){
  if(!all.length) return [];
  const target = outwardSampleTarget(all.length);

  const byEmotion = new Map();
  all.forEach(b => {
    if(!byEmotion.has(b.emo.id)) byEmotion.set(b.emo.id, []);
    byEmotion.get(b.emo.id).push(b);
  });
  // 每輪抽樣都重新洗牌，同一個情緒底下不會每次都抽到同一句
  byEmotion.forEach(list => list.sort(() => Math.random() - 0.5));
  // 情緒的順序也洗牌，否則永遠是排在前面的情緒先被抽到
  const emoIds = [...byEmotion.keys()].sort(() => Math.random() - 0.5);

  const perEmotionCap = Math.max(1, Math.ceil(target / emoIds.length));
  const taken = new Map(emoIds.map(id => [id, 0]));
  const picked = [], usedText = new Set();

  // 兩趟：第一趟只收「沒出現過的」，不夠再第二趟放寬。兩趟都受 perEmotionCap 約束。
  for(const onlyUnseen of [true, false]){
    let progressed = true;
    while(picked.length < target && progressed){
      progressed = false;
      for(const id of emoIds){
        if(picked.length >= target) break;
        if(taken.get(id) >= perEmotionCap) continue;
        const list = byEmotion.get(id);
        const idx = list.findIndex(b =>
          !picked.includes(b) && !usedText.has(b.text) && (!onlyUnseen || !seen.has(b.tagKey)));
        if(idx === -1) continue;
        picked.push(list[idx]); usedText.add(list[idx].text);
        taken.set(id, taken.get(id) + 1); progressed = true;
      }
    }
    if(picked.length >= target) break;
  }
  picked.forEach(b => seen.add(b.tagKey));
  return picked;
}

/* 揭示基礎情緒時，把兩朵雲往上收成一疊，讓出中央給圓餅。
   刻意用量的、不用寫死的百分比：泡泡句長短差很多（實測 1~4 行都有），固定座標在長句或
   小螢幕上一定會壓到圓餅。用 offsetHeight 而不是 getBoundingClientRect()：前者是版面高度，
   不受 transform 影響——這些雲身上正掛著 translate/scale 的動畫，用後者會量到動畫中間值。 */
function layoutRevealStackOn(wrap, chosenEl, midEl){
  const stageH = wrap.clientHeight || 1;
  let pad = Math.max(10, stageH * 0.035);

  /* offsetHeight 量到的是「文字方塊」的版面高度，但雲朵看得見的邊界是 ::before 那層墨水底：
     它用 inset 往外撐（outward 模式是 -5px 上下），再加上框線本身（中層雲呼吸時是 2.8px
     而且會 scale）。不補償的話兩朵雲上下排時框線會疊在一起。 */
  const INK_BLEED = 24;
  const minGap = 6 + INK_BLEED;   // 補償要含在下限裡，否則下面「太擠」的退路會把它整個抵銷掉
  let gap = Math.max(minGap, stageH * 0.022 + INK_BLEED);

  const h1 = chosenEl ? chosenEl.offsetHeight : 0;
  const h2 = midEl ? midEl.offsetHeight : 0;

  // 圓餅這一刻已經在 applyWheelState() 縮小＋沉到畫面底部了，安全上緣跟著往下讓
  const pieSafeTop = stageH * 0.60;
  if(pad + h1 + gap + h2 > pieSafeTop){
    gap = minGap;
    // 間距的墨水補償不能讓（讓了就回到框線相撞的原始問題），改成壓縮頂端留白把整疊往上推
    pad = Math.max(4, Math.min(pad, pieSafeTop - (h1 + gap + h2)));
  }

  const toPct = (px) => (px / stageH * 100).toFixed(2) + '%';
  // 左右輕微錯位，打破兩朵雲直挺挺疊在正中央的死板感
  if(chosenEl){ chosenEl.style.left = '47%'; chosenEl.style.top = toPct(pad + h1 / 2); }
  if(midEl){
    // 比句子那顆再慢一點、又晚一點起步，兩朵雲就不會像同一塊板子被整片抬上去
    midEl.style.transition = 'left 1.7s cubic-bezier(.22,.61,.24,1) .12s, top 1.7s cubic-bezier(.22,.61,.24,1) .12s';
    midEl.style.left = '53%'; midEl.style.top = toPct(pad + h1 + gap + h2 / 2);
  }
}

/* .wheel-wrap 帶著一圈 margin 緩衝，讓飄出去的泡泡有空間可以捲進畫面；但那圈緩衝也讓
   「捲軸在 0 的位置」＝輪盤偏一邊，所以要主動把捲軸推到正中間。除了初次載入，每次切換
   模式後也要重來一次：outward 會把圓餅整個藏起來、inward 又把它放回來，兩者的內容尺寸
   不同，捲軸會停在上一個模式算出來的座標上，看起來就像「位置跑掉了」。

   QA 報告第三輪 R-1 補測：雲朵是繞著「被選中的那個情緒」單側展開的，不是繞著輪盤中心對稱
   展開；上面「永遠對齊輪盤幾何正中間」的舊邏輯，在雲朵整群偏向某一側時會把偏出去的那一側
   切在可視範圍外——補測過 9 個情緒，捲動範圍其實一直都夠，只是捲軸停錯地方。改成：
   畫面上有雲朵時，改成對齊雲朵群的包圍盒中心；沒有雲朵時（初次載入、剛切換模式，都還沒
   選情緒）維持原本的幾何置中，行為不變。 */
/* QA 報告第七輪：使用者實測回報「開啟時預設沒有置中」——真的用 GitHub Pages 上的部署版本
   量過：.stage 的 scroll-behavior:smooth 讓這裡算好的 scrollLeft/Top 用動畫慢慢滑過去，
   實測耗時比預期長不少（超過 1 秒），初次載入這一刻使用者根本還沒看過畫面就已經先看到
   「沒有置中」的第一印象，等動畫真的播完使用者可能都已經離開視線或截圖回報了——這不是
   centerStageScroll() 的計算邏輯錯，是「用動畫捲到正確位置」這個手法在初次載入這個時機
   選錯了。真正需要平滑捲動、讓使用者看得出「畫面因為我的操作而移動」的情境，是選情緒／
   選中層詞之後（renderClouds() 觸發的那幾次呼叫）；初次載入、切換模式這種「使用者還沒看過
   畫面、或畫面剛整個重來一次」的情境，應該直接跳到正確位置，不要有任何動畫。
   instant 為 true 時，暫時把 scroll-behavior 切成 auto、捲完再還原，只影響這一次呼叫，
   不影響 CSS 本身的 smooth 設定（其他呼叫端不用跟著改）。 */
function centerStageScroll(instant){
  const st = document.querySelector('.stage');
  if(!st) return;
  const applyScroll = (left, top) => {
    if(instant){
      const prevBehavior = st.style.scrollBehavior;
      st.style.scrollBehavior = 'auto';
      st.scrollLeft = left; st.scrollTop = top;
      st.style.scrollBehavior = prevBehavior;
    }else{
      st.scrollLeft = left; st.scrollTop = top;
    }
  };

  const wrap = document.querySelector('.wheel-wrap');
  const clouds = wrap ? wrap.querySelectorAll('#bubbleLayer .cloud') : [];
  if(!wrap || !clouds.length){
    applyScroll((st.scrollWidth - st.clientWidth) / 2, (st.scrollHeight - st.clientHeight) / 2);
    return;
  }
  const box = cloudsBoundingBoxInStage_(wrap, clouds);
  if(!box) return; // 防禦性：算不出有效包圍盒（理論上不會發生）就什麼都不做，不要亂捲

  // 只在「包圍盒沒有完整落在目前可視範圍內」時才調整——不然每點一下畫面都自己在動，見報告
  // 「兩個體驗上的要求」第 1 條。
  const visLeft = st.scrollLeft, visTop = st.scrollTop;
  const visRight = visLeft + st.clientWidth, visBottom = visTop + st.clientHeight;
  const fits = box.left >= visLeft && box.right <= visRight && box.top >= visTop && box.bottom <= visBottom;
  if(fits) return;

  const maxScrollLeft = Math.max(0, st.scrollWidth - st.clientWidth);
  const maxScrollTop = Math.max(0, st.scrollHeight - st.clientHeight);
  applyScroll(
    Math.max(0, Math.min(maxScrollLeft, (box.left + box.right) / 2 - st.clientWidth / 2)),
    Math.max(0, Math.min(maxScrollTop, (box.top + box.bottom) / 2 - st.clientHeight / 2))
  );
}

/* 算出目前畫面上所有 .cloud 的包圍盒，換算成「.stage 捲動內容座標系」下的座標（給 centerStageScroll
   拿去跟 scrollLeft/scrollTop 比較、計算要不要調整）。

   刻意不用 getBoundingClientRect() 量雲朵本身：.cloud 進場時掛著 cloudIn（scale(0) → scale(1)）跟
   常駐的 floaty 動畫，getBoundingClientRect() 會把動畫進行中的 transform 也算進去——如果在
   renderClouds() 剛把雲朵掛上版面那一刻就量，量到的會是一堆寬高幾乎是 0 的方塊，包圍盒中心整個
   算錯（這正是覆核方自己做量測時踩過的坑，見報告「實作上最容易踩的坑」那節）。改用完全不受
   transform 影響的版面座標：雲朵的位置本來就是用 el.style.left／top 的「viewBox 百分比」設定的
   （見 renderSentenceBubbleEl／layoutMiddleClouds 等），乘上 wrap.clientWidth／clientHeight 換算成
   像素；尺寸用 offsetWidth／offsetHeight（版面盒尺寸，同樣不受 transform 影響）。這樣算出來的就是
   「動畫結束後」的最終位置與大小，不用等動畫跑完就能拿到正確答案。

   .cloud 本身用 transform: translate(-50%,-50%) 置中，所以 left/top 百分比代表的是雲朵的「中心點」，
   不是左上角——這裡用半寬高往兩邊展開就是完整的包圍盒。

   wrap／st 這兩個容器元素本身沒有掛任何 transform 動畫，用 offsetLeft／offsetTop（一樣是不受
   transform 影響的版面座標）取得 wrap 在 st 座標系裡的偏移量是安全的，只是 .cloud 個別元素不能
   這樣量。 */
function cloudsBoundingBoxInStage_(wrap, clouds){
  const wrapW = wrap.clientWidth, wrapH = wrap.clientHeight;
  if(!wrapW || !wrapH) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let counted = 0;
  clouds.forEach(function(el){
    const hw = el.offsetWidth / 2, hh = el.offsetHeight / 2;
    if(!hw && !hh) return; // 還沒真正產生版面尺寸的雲朵（理論上不會出現），跳過不納入計算
    const cx = (parseFloat(el.style.left) || 0) / 100 * wrapW;
    const cy = (parseFloat(el.style.top) || 0) / 100 * wrapH;
    minX = Math.min(minX, cx - hw); maxX = Math.max(maxX, cx + hw);
    minY = Math.min(minY, cy - hh); maxY = Math.max(maxY, cy + hh);
    counted++;
  });
  if(!counted) return null;
  return {
    left: wrap.offsetLeft + minX, right: wrap.offsetLeft + maxX,
    top: wrap.offsetTop + minY, bottom: wrap.offsetTop + maxY
  };
}

/* 按鈕文字的長度上限。這些字會出現在小按鈕上（手機的浮動列一次最多並排兩顆，模式切換鈕
   更是只有指甲大小），太長會擠爆或被截掉。用「權重長度」而不是單純字數：全形算 2、
   半形算 1，所以 12 ＝ 6 個中文字 ＝ 12 個英文字母，中英文都有合理的空間。 */
const BUTTON_LABEL_MAX_WEIGHTED = 12;
function weightedLen(str){
  let n = 0;
  for(const ch of String(str)){
    const c = ch.codePointAt(0);
    const full = (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
                 (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
                 (c >= 0xFF00 && c <= 0xFF60) || (c >= 0xFFE0 && c <= 0xFFE6) ||
                 (c >= 0x20000 && c <= 0x3FFFD);
    n += full ? 2 : 1;
  }
  return n;
}
function trimToWeighted(str, max){
  let out = '', n = 0;
  for(const ch of String(str)){
    const w = weightedLen(ch);
    if(n + w > max) break;
    out += ch; n += w;
  }
  return out;
}

/* 提示視窗（showAlertDialog）刻意不放在這裡：Viewer_JS 與 Admin_JS 各自已經有一份，
   而且使用者頁面那份多做了「同一則訊息不重複疊視窗」的處理，跟這兩個頁面的實際情境綁得比較緊。
   共用檔載入在前面，硬放一份在這裡只會被後面覆蓋，反而讓人誤以為兩邊共用的是這一支。 */


/* 把一份來路不明的 emotions 整理成「渲染程式一定吃得下」的形狀。每一層都給預設值，
   缺欄位就補、型別不對就丟掉，不讓壞資料一路傳到渲染階段才爆掉。 */
function normalizeEmotions(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(e => e && typeof e === 'object')
    .map((e, i) => ({
      id: e.id || ('e_recovered_' + i),
      label: typeof e.label === 'string' ? e.label : '',
      color: /^#[0-9a-fA-F]{6}$/.test(e.color) ? e.color : '#CCCCCC',
      middles: (Array.isArray(e.middles) ? e.middles : [])
        .filter(m => m && typeof m === 'object')
        .map((m, j) => ({
          id: m.id || ('m_recovered_' + i + '_' + j),
          label: typeof m.label === 'string' ? m.label : '',
          bubbles: (Array.isArray(m.bubbles) ? m.bubbles : []).map(b => (typeof b === 'string' ? b : '')),
        })),
    }));
}
