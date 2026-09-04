/* Shared_JS 有沒有真的載進來 —— 見 Admin_JS.html 開頭同一段檢查的完整說明。
   簡述：include('Shared_JS') 遇到「存在但空白」的檔案不會拋錯，只會安靜回傳空字串，
   接著整頁死在一個指不出真正原因的「XXX is not defined」上。這裡先攔下來講清楚。
   使用者頁面的處理方式跟管理介面不同：這裡直接把訊息畫到畫面上，因為看到這一頁的是案主，
   不是管理者，不能只留在 console 裡讓人對著一片空白發呆。 */
if (typeof WHEEL_MODES === 'undefined' || typeof layoutMiddleClouds === 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    document.body.classList.remove('is-loading');
    var d = document.createElement('div');
    d.style.cssText = 'padding:40px;text-align:center;font:15px/1.8 system-ui,sans-serif;color:#8A8078;';
    d.textContent = '頁面暫時無法顯示，請稍後再試，或聯絡提供這個連結的人。';
    document.body.appendChild(d);
  });
  throw new Error(
    'Shared_JS 沒有載入（Apps Script 專案裡的 Shared_JS 檔案是空的，或內容沒有存成功）。' +
    '請開啟 Apps Script 專案裡的 Shared_JS 檔案，重新貼上完整內容並存檔，然後重新部署新版本。'
  );
}

const SVGNS = 'http://www.w3.org/2000/svg';

/* Styled message box, mirroring Admin_JS.html's showAlertDialog — replaces window.alert() on the
   user-facing page. Beyond just looking foreign, the browser's own dialog is actively confusing in the
   Apps Script build: the page runs inside Google's sandbox iframe, so the browser labels the popup
   with the googleusercontent.com origin rather than anything the user recognises. Resolves once
   dismissed, so callers can await it. */
function showAlertDialog(message){
  return new Promise(resolve => {
    // Repeatedly triggering the same error (double-tapping 加入 while already at the 10-tag cap is the
    // easy one) otherwise stacks identical dialogs the user has to dismiss one by one. If this exact
    // message is already on screen, just re-focus it instead of piling another copy on top.
    const existing = [...document.querySelectorAll('.modal-overlay')]
      .find(o => { const m = o.querySelector('.modal-message'); return m && m.textContent === message; });
    if(existing){
      const btn = existing.querySelector('[data-action="ok"]');
      if(btn) btn.focus();
      resolve();
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <p class="modal-message"></p>
        <div class="modal-actions">
          <button type="button" class="btn" data-action="ok">好</button>
        </div>
      </div>
    `;
    overlay.querySelector('.modal-message').textContent = message;
    function close(){
      if(overlay.parentNode) document.body.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      resolve();
    }
    function onKey(e){ if(e.key === 'Enter' || e.key === 'Escape'){ e.preventDefault(); close(); } }
    overlay.querySelector('[data-action="ok"]').addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if(e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('[data-action="ok"]').focus();
  });
}

let emotions = [];
let activeEmotionId = null;
let activeMiddleIndex = null;
let activeBubbleIndex = null; // which layer-3 bubble (within the current middle) is currently focused, if any —
                               // clicking a bubble only focuses it now, same as layers 1/2; committing to the
                               // tray always goes through the collectLevelBtn near the breadcrumb.
let activeBubbleKey = null;   // HideMiddleLayer 輪專用：這種輪一次會攤平顯示「所有」中層詞底下的
                               // 泡泡，i 這個索引在不同中層詞之間會重複，沒辦法唯一辨識是哪一顆，
                               // 所以改用全域唯一的 tagKey 字串記錄目前對焦的是哪一顆。

/* ---------------- Multiple emotion wheels: pick which enabled wheel to explore. Switching wheels only
   re-points "emotions" and re-renders the wheel/clouds — the collection tray (selectedTags) is completely
   independent of which wheel is currently showing, so it's untouched by any of this. ---------------- */
let wheels = [];
let activeViewWheelId = null;

/* ---------------- 處方連結（?wheel=…&mode=…）----------------
   本機版是前端自己用 URLSearchParams 解析網址；在 Apps Script 這招完全行不通——頁面被 Google
   包在沙盒 iframe 裡，前端的 window.location.search 永遠是空字串。參數只有伺服器端的 doGet(e)
   讀得到，所以改由 Viewer.html 把值印成全域變數（DEEP_LINK_*），這裡接手。 */
const deepLinkWheelId = (typeof DEEP_LINK_WHEEL_ID === 'string' && DEEP_LINK_WHEEL_ID) ? DEEP_LINK_WHEEL_ID : null;
const deepLinkMode = (DEEP_LINK_MODE === 'inward' || DEEP_LINK_MODE === 'outward') ? DEEP_LINK_MODE : null;
let deepLinkModeApplied = false;
let deepLinkFailed = false;           // 連結指名的輪找不到／已停用
let deepLinkFailedNotified = false;   // 只提示一次

function availableWheels(){
  const enabled = wheels.filter(w => w.enabled);
  return enabled.length ? enabled : wheels; // if the admin somehow disabled every wheel, fall back to showing all of them rather than a blank page
}

/* 依 ?wheel= 決定開場要看哪個輪。找不到（心理師事後停用或刪掉了）就退回預設輪，但要記下來
   之後明確告訴使用者一聲——以前是「安靜地改開另一個輪」，案主拿到的會是完全不同的臨床內容，
   而且兩邊都不會發現。 */
function pickViewWheel_(preferId){
  const avail = availableWheels();
  const preferred = preferId && avail.find(w => w.id === preferId);
  if(deepLinkWheelId && preferId === deepLinkWheelId && !preferred && !deepLinkFailedNotified){
    deepLinkFailedNotified = true;
    deepLinkFailed = true;
  }
  // 沒有指定的話，優先挑「真的有內容」的輪：空的輪會讓案主看到一個沒有任何扇區的空圓盤
  return preferred || avail.find(w => w.emotions && w.emotions.length) || avail[0];
}

/* &mode=inward|outward 只在剛開頁時套用一次，而且只對 both 的輪有意義；
   使用者後續自己按過模式切換鈕之後，不該再被網址參數打斷。 */
function applyDeepLinkModeOnce(){
  if(deepLinkModeApplied) return;
  deepLinkModeApplied = true;
  if(deepLinkMode && wheelDeclaredMode() === 'both') userChosenMode = deepLinkMode;
}
function switchViewWheel(id){
  const target = wheels.find(w => w.id === id);
  if(!target) return;
  activeViewWheelId = target.id;
  emotions = target.emotions;
  applyMaterial(target.materialId || 'watercolor');
  activeEmotionId = null; activeMiddleIndex = null; activeBubbleIndex = null; activeBubbleKey = null;
  // 每個輪各自的探索方向不同，切輪時要把 outward 的進行狀態整個歸零，
  // 否則上一輪揭示到一半的狀態會殘留到新的輪上。
  userChosenMode = null;   // 新的輪重新決定預設模式
  resetOutwardState();
  renderWheelSwitcher();
  renderModeSwitcher();
  renderWheel();
  applyWheelState();   // 必須在 renderWheel() 之後：renderWheel 會重建扇區，先設的透明度會被蓋掉
  renderClouds();
}
function renderWheelSwitcher(){
  const row = document.getElementById('wheelSwitcherRow');
  if(!row) return;
  /* 處方連結（?wheel=）成功指到某一輪時，一律不顯示切換清單，跟這一輪本身的 Listed 設定
     無關。案主是被心理師指定看這一份內容，不該在畫面上看到「還有其他輪可以切換」——這是
     整個處方連結功能的核心前提（案主零導覽），Listed 只負責「一般瀏覽時的清單可見性」，
     兩件事完全獨立，不能只看 Listed 就決定切換鈕要不要出現。
     deepLinkWheelId 存在且真的成功切到那一輪（沒有落到 pickViewWheel_ 的退回邏輯）才算數；
     連結失效、退回預設輪的情況則維持原本可以切換瀏覽的樣子。 */
  if(deepLinkWheelId && activeViewWheelId === deepLinkWheelId){
    row.style.display = 'none'; row.innerHTML = '';
    return;
  }
  // Listed=false 的輪只是不出現在這排切換鈕裡（只能靠處方連結進去），不影響它能不能被開啟
  const avail = availableWheels().filter(w => w.listed !== false);
  if(avail.length <= 1){ row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = '';
  row.innerHTML = '';
  avail.forEach(w => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn wheel-switch-btn' + (w.id === activeViewWheelId ? ' active' : '');
    btn.textContent = w.name;
    btn.addEventListener('click', () => { if(w.id !== activeViewWheelId) switchViewWheel(w.id); });
    row.appendChild(btn);
  });
}

/* ---------------- Selected-sentence tray: cross-emotion, removable, temporary (resets on reload) ---------------- */
const MAX_SELECTED_TAGS = 10; // calibrated visually: at 10, layoutTags() still fits everyone at the full 26px font
                               // with clear gaps between tags in both aspect ratios — beyond this it starts to feel busy
let selectedTags = [];
let customTemplates = [];
let selectedTemplateId = null;
/* Download-time colour override — a front-end-only, ephemeral choice (never saved to the
   published data), so it can't drift out of sync with anything the admin configured. */
let useSingleColor = false;
let singleColor = '#4A3626';
document.getElementById('singleColorToggle').addEventListener('change', (e) => {
  useSingleColor = e.target.checked;
  document.getElementById('singleColorInput').style.display = useSingleColor ? '' : 'none';
});
document.getElementById('singleColorInput').addEventListener('input', (e) => {
  singleColor = e.target.value;
});
function todayLocalDateStr(){
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function renderSelectedTags(){
  const wrap = document.getElementById('selectedTags');
  wrap.innerHTML = '';
  if(!selectedTags.length){
    const empty = document.createElement('div');
    empty.className = 'selected-empty';
    empty.textContent = '點泡泡句裡想留下的那句話，會收集到這裡（最多 ' + MAX_SELECTED_TAGS + ' 個）。';
    wrap.appendChild(empty);
    return;
  }
  selectedTags.forEach(tag => {
    const chip = document.createElement('div');
    chip.className = 'tag-chip';
    chip.style.setProperty('--ink-line', inkLine(tag.color));
    const dot = document.createElement('span'); dot.className = 'tag-dot'; dot.style.background = tag.color;
    const label = document.createElement('span');
    label.textContent = tag.text;
    label.style.whiteSpace = 'pre-line';   // outward 的三層發現是多行的
    label.style.textAlign = 'center';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button'; removeBtn.className = 'tag-remove'; removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => removeTag(tag.key));
    chip.appendChild(dot); chip.appendChild(label); chip.appendChild(removeBtn);
    wrap.appendChild(chip);
  });
}
function addTag(tag){
  if(selectedTags.some(t => t.key === tag.key)) return false;
  if(selectedTags.length >= MAX_SELECTED_TAGS){
    showAlertDialog('最多只能收集 ' + MAX_SELECTED_TAGS + ' 個心情，先移除一個再新增新的吧！');
    return false;
  }
  selectedTags.push(tag);
  renderSelectedTags();
  renderGeneratePanel();
  renderCollectLevelButton();
  return true;
}
function removeTag(key){
  selectedTags = selectedTags.filter(t => t.key !== key);
  const el = document.querySelector('.cloud-sentence[data-tag-key="' + key + '"]');
  if(el) el.classList.remove('popped');
  renderSelectedTags();
  renderGeneratePanel();
  renderCollectLevelButton();
}

function currentLevelTag(){
  if(!activeEmotionId) return null;
  const emo = findEmotion(activeEmotionId);
  if(!emo) return null;
  if(currentWheelHideMiddle()){
    if(activeBubbleKey){
      const found = findBubbleByTagKey(emo, activeBubbleKey);
      if(found) return { key: activeBubbleKey, color: emo.color, text: found.text };
    }
    return { key: emo.id, color: emo.color, text: emo.label };
  }
  if(activeMiddleIndex === null){
    return { key: emo.id, color: emo.color, text: emo.label };
  }
  const m = emo.middles[activeMiddleIndex];
  if(!m) return null;
  // A focused layer-3 bubble takes priority over the middle-level tag — same "deepest level wins"
  // rule as before, just one layer deeper now that bubbles go through this same focus+confirm flow.
  if(activeBubbleIndex !== null && m.bubbles[activeBubbleIndex]){
    return { key: emo.id + '::' + m.id + '::' + activeBubbleIndex, color: emo.color, text: m.bubbles[activeBubbleIndex] };
  }
  // Deliberately just the middle word itself, not "emo.label + m.label" — consistent with how a
  // layer-3 bubble's collected text is only ever the bubble sentence, never prefixed by its parents.
  return { key: emo.id + '::' + m.id, color: emo.color, text: m.label };
}
function renderCollectLevelButton(){
  const row = document.getElementById('collectLevelRow');
  const btn = document.getElementById('collectLevelBtn');
  if(!row || !btn) return;
  // outward 有自己的收尾按鈕（收集這個發現／再選一句），這顆浮動鈕會打架，所以不出現
  if(isOutward()){ row.style.display = 'none'; return; }
  const tag = currentLevelTag();
  if(!tag){ row.style.display = 'none'; return; }
  row.style.display = '';
  const already = selectedTags.some(t => t.key === tag.key);
  btn.className = 'btn collect-level-btn' + (already ? ' active' : '');
  btn.textContent = (already ? '✓ 已加入「' : '＋ 加入「') + tag.text + '」';
  btn.onclick = () => {
    if(already){ removeTag(tag.key); return; }
    if(addTag(tag)){
      // Bubbles render their own "popped" ring straight off selectedTags on the next renderClouds(),
      // but adding here doesn't trigger one — patch the already-live DOM node so the ring updates
      // immediately, same as removeTag() already does when un-adding.
      const el = document.querySelector('.cloud-sentence[data-tag-key="' + tag.key + '"]');
      if(el) el.classList.add('popped');
    }
  };
}

/* ---------------- Custom emotion words: front-end only, never sent to the backend — the tag object
   lives in the exact same selectedTags array as everything else, so "not persisted" falls out for free. */
const CUSTOM_TAG_MAX_WEIGHTED_LEN = 30; // full-width (CJK etc.) counts as 2, half-width as 1
function weightedTextLength(str){
  let total = 0;
  for(const ch of str){
    const code = ch.codePointAt(0);
    const isFullWidth = (
      (code >= 0x1100 && code <= 0x115F) ||   // Hangul Jamo
      (code >= 0x2E80 && code <= 0xA4CF) ||   // CJK radicals ... Yi
      (code >= 0xAC00 && code <= 0xD7A3) ||   // Hangul syllables
      (code >= 0xF900 && code <= 0xFAFF) ||   // CJK compatibility ideographs
      (code >= 0xFF00 && code <= 0xFF60) ||   // Fullwidth forms
      (code >= 0xFFE0 && code <= 0xFFE6) ||
      (code >= 0x20000 && code <= 0x3FFFD)    // CJK extension planes
    );
    total += isFullWidth ? 2 : 1;
  }
  return total;
}
function addCustomTag(){
  const input = document.getElementById('customTagInput');
  const colorInput = document.getElementById('customTagColor');
  const text = input.value.trim();
  if(!text) return;
  if(weightedTextLength(text) > CUSTOM_TAG_MAX_WEIGHTED_LEN){
    showAlertDialog('這句話有點太長了（全形字最多算 30 個字元），縮短一點再試試看！');
    return;
  }
  const key = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const added = addTag({ key, color: colorInput.value, text });
  if(added) input.value = '';
}
document.getElementById('customTagAddBtn').addEventListener('click', addCustomTag);
document.getElementById('customTagInput').addEventListener('keydown', (e) => {
  if(e.key === 'Enter'){ e.preventDefault(); addCustomTag(); }
});

/* ---------------- Emotion-cloud image generation: scatter-layout selected tags over a template, download as PNG ---------------- */
const TEMPLATE_OUTPUT_SIZES = { square: [1080, 1080], mobile: [1080, 1920] };
const TEMPLATE_ASPECTS = [
  { id: 'square', label: '1:1（正方形）' },
  { id: 'mobile', label: '手機直式（9:16）' },
];
const TAG_MIN_FONT_SIZE = 14;  // absolute floor — never go smaller than this
const TAG_MAX_FONT_SIZE = 60;  // ideal size when there's room; shrinks toward the floor only as needed

/* Scatters tags with small random rotation + position, retrying on overlap and shrinking the
   font (down to TAG_MIN_FONT_SIZE) if they don't all fit — gives the "drifting" look instead of
   a plain top-to-bottom list. Returns null if even the floor font size can't fit everyone. */
function layoutTags(ctx, tags, canvasW, canvasH, fontStack){
  const marginX = canvasW * 0.12, marginY = canvasH * 0.14;
  const usableW = canvasW - marginX * 2, usableH = canvasH - marginY * 2;
  const maxAttemptsPerTag = 500;
  for(let fontSize = TAG_MAX_FONT_SIZE; fontSize >= TAG_MIN_FONT_SIZE; fontSize -= 2){
    ctx.font = `700 ${fontSize}px ${fontStack || DEFAULT_FONT_STACK}`;
    const placed = [];
    let ok = true;
    for(const tag of tags){
      // 標籤可能是多行的（outward 收集的三層發現），寬度取最寬那一行，高度是行高 × 行數
      const lines = String(tag.text).split('\n');
      const lineH = fontSize * 1.3;
      const w = Math.max(...lines.map(l => ctx.measureText(l).width));
      const h = lineH * lines.length;
      const pad = Math.max(w, lineH) * 0.18;
      const boxW = w + pad, boxH = h + pad;
      let placedThis = false;
      for(let attempt = 0; attempt < maxAttemptsPerTag; attempt++){
        const cx = marginX + boxW/2 + Math.random() * Math.max(0, usableW - boxW);
        const cy = marginY + boxH/2 + Math.random() * Math.max(0, usableH - boxH);
        const box = { left: cx - boxW/2, right: cx + boxW/2, top: cy - boxH/2, bottom: cy + boxH/2 };
        const collide = placed.some(p => !(box.right < p.left || box.left > p.right || box.bottom < p.top || box.top > p.bottom));
        if(!collide){
          const rot = Math.random() * 24 - 12;
          placed.push({ ...box, cx, cy, rot, text: tag.text, lines, lineH, color: tag.color, w, h });
          placedThis = true;
          break;
        }
      }
      if(!placedThis){ ok = false; break; }
    }
    if(ok) return { fontSize, placed };
  }
  return null;
}

function renderGeneratePanel(){
  const panel = document.getElementById('generatePanel');
  const picker = document.getElementById('templatePicker');
  if(!panel || !picker) return;
  // Template images are no longer eagerly resolved by getPublishedData() (see generateEmotionCloudImage) —
  // only enabled-ness is known at this point, the image itself is fetched lazily at download time.
  const enabled = customTemplates.filter(t => t.enabled);
  if(!enabled.length){ panel.style.display = 'none'; return; }
  panel.style.display = '';
  picker.innerHTML = '';
  // Render one group per aspect ratio that still has an enabled template — even when there's only
  // one enabled template overall. Gating this on "more than one template" (as before grouping existed)
  // meant disabling every template in one aspect-ratio group could drop the *total* enabled count to 1
  // and hide the picker (and its group label) entirely, even though the surviving group is still valid.
  if(!enabled.some(t => t.id === selectedTemplateId)) selectedTemplateId = enabled[0].id;
  TEMPLATE_ASPECTS.forEach(aspect => {
    const group = enabled.filter(t => t.aspectRatio === aspect.id);
    if(!group.length) return;
    const groupEl = document.createElement('div');
    groupEl.className = 'template-group';
    const label = document.createElement('div');
    label.className = 'template-group-label';
    label.textContent = aspect.label;
    groupEl.appendChild(label);
    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'template-group-buttons';
    group.forEach(t => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn template-pick-btn' + (t.id === selectedTemplateId ? ' active' : '');
      btn.textContent = t.name;
      btn.addEventListener('click', () => { selectedTemplateId = t.id; renderGeneratePanel(); });
      buttonsRow.appendChild(btn);
    });
    groupEl.appendChild(buttonsRow);
    picker.appendChild(groupEl);
  });
  document.getElementById('generateBtn').disabled = generatingImage || !selectedTags.length;
}

/* ---------------- QA 報告第五輪：改用 fetch() 打 Apps Script 的 ?api= JSON 端點 ---------------- */
/* 使用者頁面搬到 GitHub Pages（純靜態頁）之後，google.script.run 這個物件不存在了——它只在
   Apps Script 的 HtmlService 沙盒 iframe 裡才有意義，純靜態頁引用不到。改用 fetch() 打同一支
   Apps Script 部署自己開的 ?api=published／?api=template 這兩個 JSON 端點（見 Code.gs 的
   doGet() 那兩段、getPublishedData()／getTemplateImage() 兩支既有函式）。

   ⚠️⚠️ credentials 一定要用預設值，絕對不能寫成 credentials: 'include'！這正是這整個搬遷方案
   能成立的唯一原因：手機瀏覽器如果登入了 Google 帳號，直接開啟 Apps Script 的 /exec 網址會被
   Google 依登入狀態改寫成該帳號的槽位路徑（/u/1/、/u/2/…）並導向 Google 雲端硬碟的錯誤頁——
   這個「依 cookie 辨識身分、改寫路徑」的行為，只有在請求帶著能辨識身分的 cookie 時才會發生。
   跨來源 fetch() 預設完全不送第三方 cookie，Google 認不出這個訪客是誰，就不會做帳號槽位改寫，
   直接以匿名身分正常回應（這個部署本來就是「誰都能存取」，匿名請求本來就該被正常服務）。
   之後如果有人「為了保險」把這裡改成 credentials: 'include'，等於把這個問題原封不動改回來——
   請不要加，也不要因為看到其他專案的常見寫法就順手補上。下面的 qa-suite 測試有鎖住這件事，
   改了會直接測試失敗。 */
const API_BASE_ = 'https://script.google.com/macros/s/AKfycbwJ1vFHHmoBKRBQ4daiUWoZz_A4IZ63m52KPbpRNwwU50onLxlN_QTvcQZMkuW_jMQ/exec'; // ⚠️ 部署方請換成自己這份 Apps Script 部署的網址，見 README「部署流程」
const FETCH_TIMEOUT_MS_ = 20000; // 跟舊版 CALL_SERVER_TIMEOUT_MS_／loadData() 的 watchdog 一致，不要改這個數字，下面有測試在檢查

/* 打一個 ?api= 端點，回傳解析過的 JSON。20 秒逾時用 AbortController 實作——比 google.script.run
   時代「兩個 Promise 賽跑」的 Promise.race 乾淨，fetch() 原生支援 AbortSignal。逾時訊息文字
   沿用舊版 callServer() 的用字（既有測試在檢查，故意不改），呼叫端原本「catch 到就顯示錯誤、
   解除 is-loading 遮罩」那一套完全不用跟著改。 */
async function fetchApi_(apiName, extraParams){
  const qs = new URLSearchParams(Object.assign({ api: apiName }, extraParams || {}));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS_);
  let res;
  try{
    res = await fetch(API_BASE_ + '?' + qs.toString(), { signal: controller.signal });
    // credentials 刻意不設定（見上面 ⚠️ 的完整說明）——千萬不要加 credentials: 'include'
  }catch(err){
    if(err && err.name === 'AbortError'){
      throw new Error(apiName + ' 逾時（超過 ' + (FETCH_TIMEOUT_MS_ / 1000) + ' 秒沒有任何回應），請重新整理頁面再試一次。');
    }
    throw new Error('無法連線到伺服器：' + (err && err.message ? err.message : err));
  }finally{
    clearTimeout(timer);
  }
  if(!res.ok) throw new Error('伺服器回應異常（HTTP ' + res.status + '）');
  return res.json();
}

/* 沿用舊名稱 callServer()，唯一的呼叫端（下面 generateEmotionCloudImage() 裡的
   getTemplateImage）完全不用改一個字。這裡不是真的通用轉發器，只對應目前唯一用到的這個
   API——之後如果要加別的端點，在這裡多加一個 if 分支即可，不需要改呼叫端的寫法。 */
async function callServer(methodName, ...args){
  if(methodName === 'getTemplateImage'){
    const data = await fetchApi_('template', { id: args[0] });
    return data.image;
  }
  throw new Error('callServer(' + methodName + ')：沒有對應的 ?api= 端點');
}

let generatingImage = false; // re-entrancy guard: the template-image fetch below is now a real network
                              // round trip, so a second click (or a tag change re-enabling the button
                              // via renderGeneratePanel) mid-flight must not kick off a second overlapping run.
async function generateEmotionCloudImage(){
  if(generatingImage) return;
  const tpl = customTemplates.find(t => t.id === selectedTemplateId);
  if(!tpl || !selectedTags.length) return;

  generatingImage = true;
  const generateBtn = document.getElementById('generateBtn');
  const originalLabel = generateBtn.textContent;
  generateBtn.disabled = true;
  generateBtn.textContent = '產生中…';
  const restoreButton = () => {
    generatingImage = false;
    generateBtn.disabled = !selectedTags.length;
    generateBtn.textContent = originalLabel;
  };

  // Template images aren't sent down with the page anymore (see getPublishedData() on the server) —
  // only fetch the one the user actually picked, only when they actually click download.
  let templateImage;
  try{
    templateImage = await callServer('getTemplateImage', tpl.id);
  }catch(err){
    restoreButton();
    showAlertDialog('套圖讀取失敗，請稍後再試：' + (err && err.message ? err.message : err));
    return;
  }
  if(!templateImage){
    restoreButton();
    showAlertDialog('這張套圖目前沒辦法使用，換一張試試看！');
    return;
  }

  const [outW, outH] = TEMPLATE_OUTPUT_SIZES[tpl.aspectRatio] || TEMPLATE_OUTPUT_SIZES.square;
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');

  // Canvas text is drawn synchronously and does NOT wait for web fonts on its own —
  // if a custom font is chosen, make sure it's actually loaded before we draw anything,
  // otherwise the exported image would silently use the fallback stack even though the
  // on-screen page (which repaints whenever the font arrives) shows the right font.
  await ensureFontFaceLoaded(currentFontId);
  const fontStack = fontCssStack(currentFontId);

  const bg = new Image();
  bg.onload = () => {
    ctx.drawImage(bg, 0, 0, outW, outH);
    const layout = layoutTags(ctx, selectedTags, outW, outH, fontStack);
    restoreButton();
    if(!layout){
      showAlertDialog('心情有點太多了，畫面放不下，先移除幾個再試試看！');
      return;
    }
    layout.placed.forEach(p => {
      ctx.save();
      ctx.translate(p.cx, p.cy);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.font = `700 ${layout.fontSize}px ${fontStack}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = layout.fontSize * 0.3;
      ctx.strokeStyle = 'rgba(255,253,246,.92)';
      ctx.fillStyle = useSingleColor ? singleColor : p.color;
      // canvas 的 fillText 不會處理 \n，多行必須自己一行一行畫。
      // 以整塊文字的垂直中心為基準往上推半塊，再逐行往下疊。
      const lines = p.lines || [p.text];
      const startY = -((lines.length - 1) * p.lineH) / 2;
      lines.forEach((line, i) => {
        const y = startY + i * p.lineH;
        ctx.strokeText(line, 0, y);
        ctx.fillText(line, 0, y);
      });
      ctx.restore();
    });
    // QA 報告第四輪 B-2：這張輸出圖是「套圖背景照片 + 描邊文字」，1080×1080/1920 的 PNG（無損）
    // 對照片類的內容幾乎壓不動，實測約 2MB，用 LINE 傳、存在手機裡都偏重。改用 JPEG 品質 0.85，
    // 同畫質下預期落在 200～400KB。**JPEG 不支援透明背景，這裡之所以安全，是因為 canvas 在畫
    // 文字之前已經先用 drawImage(bg, 0, 0, outW, outH) 把整個畫布鋪滿不透明的套圖背景**——沒有任何
    // 一格是透明的。如果之後套圖改成支援透明背景（例如去背的季節限定套圖），這裡要退回 PNG，
    // 不能無條件假設 JPEG 安全。品質 0.85 是實測起點、不是定論：文字邊緣的白色描邊（strokeText）
    // 在 JPEG 壓縮下容易出現色塊雜訊，如果之後肉眼看得出來，往上調這個數字。
    canvas.toBlob((blob) => {
      // toBlob hands back null when encoding fails — running out of memory encoding a 1080x1920
      // canvas on a low-end phone is the realistic case. Without this guard URL.createObjectURL(null)
      // throws and the user gets a dead button with no explanation at all.
      if(!blob){
        showAlertDialog('圖片產生失敗，可能是裝置記憶體不足，關掉一些分頁再試一次看看！');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '今日情緒雲-' + todayLocalDateStr() + '.jpg';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      // Revoke on the next tick, not synchronously: some browsers (notably older Safari/iOS) have
      // not yet started reading the blob when click() returns, and revoking immediately can abort
      // the download. A short delay costs nothing and removes that race.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }, 'image/jpeg', 0.85);
  };
  bg.onerror = () => {
    restoreButton();
    showAlertDialog('套圖圖片載入失敗，請稍後再試！');
  };
  bg.src = templateImage;
}
document.getElementById('generateBtn').addEventListener('click', generateEmotionCloudImage);

function findEmotion(id){ return emotions.find(e => e.id === id); }

/* ---------------- Background theme (vars come fully-resolved from the published snapshot) ---------------- */
/* QA 報告 M-2（已實測成功）：vars 是伺服器回傳的已發佈快照內容，理論上會經過 Code.gs 的
   normalizeCssColor_ 正規化過一次，但「有人直接在 Google Sheets 裡編輯 PublishedSnapshot
   那格 JSON」這條管道完全不經過任何一行 Code.gs——這裡是公開頁面真正把值塞進 CSS 自訂屬性
   的那一刻，是唯一堵得住那條管道的地方，每個欄位都要過 sanitizeCssColor()（Shared_JS.html）
   才能 setProperty，不能再直接信任 vars 本身「應該」是乾淨的。 */
function applyTheme(vars){
  if(!vars) return;
  const root = document.documentElement.style;
  root.setProperty('--bg', sanitizeCssColor(vars.bg, '#F3E7D3'));
  root.setProperty('--panel', sanitizeCssColor(vars.panel, '#FFFCF4'));
  root.setProperty('--paper', sanitizeCssColor(vars.paper, '#FFFBF2'));
  root.setProperty('--ink', sanitizeCssColor(vars.ink, '#4A3626'));
  root.setProperty('--ink-soft', sanitizeCssColor(vars.inkSoft, '#8C7660'));
  root.setProperty('--line', sanitizeCssColor(vars.line, '#E6D4B4'));
  root.setProperty('--accent', sanitizeCssColor(vars.accent, '#C98A4B'));
  root.setProperty('--glow', sanitizeCssColor(vars.glow, 'rgba(255,205,120,.38)'));
  INK_DARK = sanitizeCssColor(vars.inkDark, '#3B2A1B');
}

/* ---------------- Wheel "material" (rendering style) — independent of color theme ---------------- */
const MATERIALS = [
  { id: 'flat', name: '原始扁平風' },
  { id: 'watercolor', name: '水彩暈染風' },
  { id: 'wood', name: '木質風' },
  { id: 'crayon', name: '蠟筆風' },
];
let currentMaterial = 'watercolor';
let customMaterials = [];
function findCustomMaterial(id){ return customMaterials.find(m => m.id === id); }
function applyMaterial(id){
  currentMaterial = (MATERIALS.some(m => m.id === id) || findCustomMaterial(id)) ? id : 'watercolor';
  document.body.setAttribute('data-material', currentMaterial);
}

/* ---------------- Global font choice — DEFAULT_FONT_STACK/FONTS themselves live in Shared_JS.html now
   (identical to Admin.html's copy). Loaded via the FontFace API (not static @font-face) so we can await
   the load before drawing on a canvas, and so a failed load simply never gets added to document.fonts:
   since the CSS font-family value is always 'CustomFamily', <original fallback stack>, the browser's
   own font fallback already handles "device doesn't have this font" or "CDN unreachable" with no
   special-case code needed. ---------------- */
let currentFontId = 'system';
const fontFaceLoads = {};

function fontCssStack(id){
  const f = FONTS.find(x => x.id === id);
  if(!f || !f.family) return DEFAULT_FONT_STACK;
  return `'${f.family}', ${DEFAULT_FONT_STACK}`;
}
function ensureFontFaceLoaded(id){
  const f = FONTS.find(x => x.id === id);
  if(!f || !f.family) return Promise.resolve();
  if(!fontFaceLoads[id]){
    fontFaceLoads[id] = new FontFace(f.family, `url(${f.url}) format('${f.format}')`)
      .load()
      .then(loaded => { document.fonts.add(loaded); })
      .catch((err) => { console.error('字體載入失敗，退回系統預設字體:', err); }); // CDN unreachable / file failed to parse — keep the fallback stack, just log it
  }
  return fontFaceLoads[id];
}
function applyFont(id){
  const match = FONTS.find(f => f.id === id);
  currentFontId = match ? id : 'system';
  document.documentElement.style.setProperty('--app-font', fontCssStack(currentFontId));
  document.documentElement.style.setProperty('--text-scale', String((match && match.textScale) || 1));
  if(currentFontId !== 'system') ensureFontFaceLoaded(currentFontId);
}

/* ---------------- Page text (title / subtitle / wheel microcopy), editable from Admin.html ---------------- */
const DEFAULT_SETTINGS = {
  title: '今天，你的心情是？',
  subtitle: '每一種心情，都值得被好好看見。',
  centerTitle: '情緒輪',
  centerHint: '點一塊角角看看',
  breadcrumbDefault: '點一塊圓餅看看',
  breadcrumbPickMiddle: '選一個中層詞',
  hintDefault: '點一塊圓餅角角，看看會長出哪些詞',
  hintPickMiddle: '點一朵中層詞的雲，看看會冒出哪些話',
  /* ---- 由外而內（outward）模式專用的引導語 ----
     刻意全部都是「不含結果」的句子：揭示出來的中層詞與基礎情緒是用雲朵、扇區這些既有的
     圖形元件呈現的，不會被塞進這些字串裡，所以管理者怎麼改都不會壞。 */
  outwardEntryHint: '哪一句話最像你現在的心情？',
  outwardRevealMidHint: '點這朵雲，看看它的根是什麼',
  outwardRevealBaseHint: '而它的根，也許是這種感覺',
  outwardShuffleLabel: '換一批看看',
  outwardCollectLabel: '收集這個發現',
  outwardAgainLabel: '再選一句',
  outwardBackLabel: '好像不是這句',
  outwardExhaustedHint: '都沒有相近的嗎？再選一次，或者我們來試著書寫看看',
  outwardRestartLabel: '再選一次',
  inwardModeLabel: '基礎模式',
  outwardModeLabel: '探索模式',
  tabTitle: '今天，你的心情是？',
  footerText: '本情緒輪工具僅供探索輔助，不作為醫療診斷用途。(© 2026 JT v2.0)',
};
let currentSettings = { ...DEFAULT_SETTINGS };
function applySettings(settings){
  currentSettings = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  document.getElementById('pageTitle').textContent = currentSettings.title;
  document.getElementById('pageSubtitle').textContent = currentSettings.subtitle;
  // Cosmetic only: inside the Apps Script sandbox iframe this never reaches the real browser tab
  // (Code.gs's doGet().setTitle() is what actually sets it). Harmless, and correct when the file is
  // opened directly outside Apps Script.
  document.title = currentSettings.tabTitle || DEFAULT_SETTINGS.tabTitle;
  const footerEl = document.getElementById('pageFooter');
  if(footerEl){
    footerEl.textContent = currentSettings.footerText || '';
    footerEl.style.display = currentSettings.footerText ? '' : 'none';
  }
}

/* ---------------- SVG defs: watercolor filters + per-emotion gradients ---------------- */
function buildDefs(){
  const defs = document.createElementNS(SVGNS,'defs');
  defs.innerHTML = `
    <filter id="roughEdge" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.05 0.09" numOctaves="2" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="inkWobble" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.045" numOctaves="2" seed="9" result="n2"/>
      <feDisplacementMap in="SourceGraphic" in2="n2" scale="10" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="softBlur"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="grain" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" result="n3"/>
      <feColorMatrix in="n3" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.5 0 0 0 0"/>
    </filter>
    <clipPath id="donutClip" clipPathUnits="userSpaceOnUse" clip-rule="evenodd">
      <circle cx="${CX}" cy="${CY}" r="${R_OUTER}"/>
      <circle cx="${CX}" cy="${CY}" r="${R_INNER}"/>
    </clipPath>
    <filter id="woodEdge" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.06 0.1" numOctaves="2" seed="33" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="6" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="woodOutline1" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.02 0.05" numOctaves="2" seed="21" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="woodOutline2" x="-20%" y="-20%" width="140%" height="140%">
      <feTurbulence type="fractalNoise" baseFrequency="0.025 0.06" numOctaves="2" seed="47" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="9" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
  `;
  emotions.forEach((emo, i) => {
    const g = document.createElementNS(SVGNS,'radialGradient');
    g.setAttribute('id','grad-'+emo.id);
    g.setAttribute('cx','35%'); g.setAttribute('cy','30%'); g.setAttribute('r','85%');
    const safeColor = sanitizeColor(emo.color);
    g.innerHTML = `
      <stop offset="0%" stop-color="${tint(safeColor)}"/>
      <stop offset="60%" stop-color="${safeColor}"/>
      <stop offset="100%" stop-color="${shade(safeColor)}"/>
    `;
    defs.appendChild(g);

    // Per-emotion watercolor fill filter: pigment-pooling blotches (darker islands),
    // paper-showing-through blotches (lighter islands), and an edge bloom band
    // (pigment concentrating near the wash boundary as water dries toward the edge).
    const pigment = shade(safeColor);
    const seedA = 11 + i * 7;
    const seedB = 31 + i * 13;
    const wf = document.createElementNS(SVGNS,'filter');
    wf.setAttribute('id', 'watercolor-' + emo.id);
    wf.setAttribute('x','-25%'); wf.setAttribute('y','-25%'); wf.setAttribute('width','150%'); wf.setAttribute('height','150%');
    wf.innerHTML = `
      <feTurbulence type="fractalNoise" baseFrequency="0.011 0.015" numOctaves="2" seed="${seedA}" result="blotchNoise"/>
      <feColorMatrix in="blotchNoise" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0.9 0.9 0 -0.35" result="blotchAlpha"/>
      <feComponentTransfer in="blotchAlpha" result="blotchAlphaSharp">
        <feFuncA type="gamma" amplitude="1" exponent="2.6" offset="0"/>
      </feComponentTransfer>
      <feComposite in="blotchAlphaSharp" in2="SourceAlpha" operator="in" result="blotchAlphaClipped"/>
      <feFlood flood-color="${pigment}" flood-opacity="0.22" result="pigmentColor"/>
      <feComposite in="pigmentColor" in2="blotchAlphaClipped" operator="in" result="pigmentBlotches"/>
      <feBlend in="SourceGraphic" in2="pigmentBlotches" mode="multiply" result="withDarkBlotches"/>

      <feTurbulence type="fractalNoise" baseFrequency="0.017 0.021" numOctaves="2" seed="${seedB}" result="lightNoise"/>
      <feColorMatrix in="lightNoise" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0.9 0.9 0 -0.42" result="lightAlpha"/>
      <feComponentTransfer in="lightAlpha" result="lightAlphaSharp">
        <feFuncA type="gamma" amplitude="1" exponent="2.2" offset="0"/>
      </feComponentTransfer>
      <feComposite in="lightAlphaSharp" in2="SourceAlpha" operator="in" result="lightAlphaClipped"/>
      <feFlood flood-color="#FFFDF6" flood-opacity="0.65" result="paperColor"/>
      <feComposite in="paperColor" in2="lightAlphaClipped" operator="in" result="paperBlotches"/>
      <feBlend in="withDarkBlotches" in2="paperBlotches" mode="screen" result="withLightBlotches"/>

      <feMorphology in="SourceAlpha" operator="erode" radius="7" result="eroded"/>
      <feComposite in="SourceAlpha" in2="eroded" operator="xor" result="edgeBand"/>
      <feGaussianBlur in="edgeBand" stdDeviation="3.5" result="edgeBandSoft"/>
      <feComposite in="edgeBandSoft" in2="SourceAlpha" operator="in" result="edgeBandClipped"/>
      <feFlood flood-color="${pigment}" flood-opacity="0.22" result="edgeColor"/>
      <feComposite in="edgeColor" in2="edgeBandClipped" operator="in" result="edgeBloom"/>
      <feBlend in="withLightBlotches" in2="edgeBloom" mode="multiply" result="watercolorFinal"/>
      <feComposite in="watercolorFinal" in2="SourceAlpha" operator="in"/>
    `;
    defs.appendChild(wf);

    // Per-emotion wood-grain fill filter: directional waxy streak marks over a solid base color.
    const woodPigment = shade(safeColor);
    const cSeed = 5 + i * 9;
    const cf = document.createElementNS(SVGNS,'filter');
    cf.setAttribute('id', 'wood-' + emo.id);
    cf.setAttribute('x','-20%'); cf.setAttribute('y','-20%'); cf.setAttribute('width','140%'); cf.setAttribute('height','140%');
    cf.innerHTML = `
      <feTurbulence type="turbulence" baseFrequency="0.015 0.35" numOctaves="2" seed="${cSeed}" result="streak"/>
      <feColorMatrix in="streak" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0.9 0.9 0 -0.3" result="streakAlpha"/>
      <feComponentTransfer in="streakAlpha" result="streakAlphaSharp">
        <feFuncA type="gamma" amplitude="1" exponent="1.4" offset="0"/>
      </feComponentTransfer>
      <feComposite in="streakAlphaSharp" in2="SourceAlpha" operator="in" result="streakClipped"/>
      <feFlood flood-color="${woodPigment}" flood-opacity="0.4" result="streakColor"/>
      <feComposite in="streakColor" in2="streakClipped" operator="in" result="streakMarks"/>
      <feBlend in="SourceGraphic" in2="streakMarks" mode="multiply" result="withStreaks"/>
      <feComposite in="withStreaks" in2="SourceAlpha" operator="in"/>
    `;
    defs.appendChild(cf);

    // Per-emotion crayon fill filter: directional (near-vertical) stroke/paper-gap bands
    // simulate a hand dragging the crayon back and forth, plus a fine isotropic micro-grain
    // for paper tooth showing through even where strokes overlap. The same stroke pattern
    // (not a smooth blur) also decides the boundary, so the edge itself reads as strokes
    // stopping short or overshooting rather than a uniform vignette.
    const cr = document.createElementNS(SVGNS,'filter');
    cr.setAttribute('id', 'crayon-' + emo.id);
    cr.setAttribute('x','-20%'); cr.setAttribute('y','-20%'); cr.setAttribute('width','140%'); cr.setAttribute('height','140%');
    cr.innerHTML = `
      <feTurbulence type="fractalNoise" baseFrequency="0.22" numOctaves="2" seed="${40 + i * 5}" result="microNoise"/>
      <feColorMatrix in="microNoise" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.9 0.9 0.9 0 -1.1" result="microAlpha"/>
      <feComponentTransfer in="microAlpha" result="microAlphaSharp">
        <feFuncA type="gamma" amplitude="1" exponent="1.7" offset="0"/>
      </feComponentTransfer>
      <feComposite in="microAlphaSharp" in2="SourceAlpha" operator="in" result="microClipped"/>
      <feFlood flood-color="#FFF3DC" flood-opacity="0.4" result="microColor"/>
      <feComposite in="microColor" in2="microClipped" operator="in" result="microMarks"/>
      <feBlend in="microMarks" in2="SourceGraphic" mode="normal" result="withMicro"/>

      <!-- directional stroke/paper-gap bands, then softened + gently wobbled so the strokes
           read as a relaxed, hand-drawn scribble instead of a ruler-straight, mechanical pattern -->
      <feTurbulence type="turbulence" baseFrequency="0.35 0.006" numOctaves="2" seed="${52 + i * 6}" result="strokeNoise"/>
      <feColorMatrix in="strokeNoise" type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.75 0.75 0.75 0 -0.18" result="strokeAlphaRaw"/>
      <feComponentTransfer in="strokeAlphaRaw" result="paperMaskHard">
        <feFuncA type="discrete" tableValues="0 0 0 1 1 1"/>
      </feComponentTransfer>
      <feGaussianBlur in="paperMaskHard" stdDeviation="1.1" result="paperMaskSoft"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.02" numOctaves="2" seed="${70 + i * 4}" result="wobbleField"/>
      <feDisplacementMap in="paperMaskSoft" in2="wobbleField" scale="14" xChannelSelector="R" yChannelSelector="G" result="paperMask"/>
      <feComposite in="paperMask" in2="SourceAlpha" operator="in" result="paperMaskClipped"/>
      <feFlood flood-color="#FFF3DC" flood-opacity="0.72" result="paperColor"/>
      <feComposite in="paperColor" in2="paperMaskClipped" operator="in" result="paperMarks"/>
      <feBlend in="paperMarks" in2="withMicro" mode="normal" result="withStrokes"/>

      <feMorphology in="SourceAlpha" operator="erode" radius="9" result="core"/>
      <feComposite in="SourceAlpha" in2="core" operator="xor" result="edgeZone"/>
      <feComposite in="paperMask" in2="edgeZone" operator="in" result="edgeGap"/>
      <feComposite in="edgeZone" in2="edgeGap" operator="out" result="edgeKeep"/>
      <feMerge result="raggedAlpha">
        <feMergeNode in="core"/>
        <feMergeNode in="edgeKeep"/>
      </feMerge>
      <feComposite in="withStrokes" in2="raggedAlpha" operator="in"/>
    `;
    defs.appendChild(cr);
  });

  customMaterials.forEach(mat => {
    if(!mat.image) return;
    const pattern = document.createElementNS(SVGNS,'pattern');
    pattern.setAttribute('id', 'customtex-' + mat.id);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    pattern.setAttribute('width', mat.tileSize);
    pattern.setAttribute('height', mat.tileSize);
    const image = document.createElementNS(SVGNS,'image');
    image.setAttribute('href', mat.image);
    image.setAttribute('x', '0'); image.setAttribute('y', '0');
    image.setAttribute('width', mat.tileSize); image.setAttribute('height', mat.tileSize);
    image.setAttribute('preserveAspectRatio', 'none');
    pattern.appendChild(image);
    defs.appendChild(pattern);
  });

  return defs;
}

/* ---------------- Wheel rendering ---------------- */
function renderWheel(){
  const svg = document.getElementById('wheelSvg');
  svg.setAttribute('viewBox', `0 0 ${CX*2} ${CY*2}`);
  svg.innerHTML = '';
  const n = emotions.length;
  if(!n) return;

  svg.appendChild(buildDefs());

  const group = document.createElementNS(SVGNS,'g');
  group.setAttribute('id','wheelGroup'); group.setAttribute('class','wheel-group');
  svg.appendChild(group);

  emotions.forEach((emo, i) => {
    const step = 360 / n, start = i * step, end = start + step;
    const mid = bisectorAngle(i, n);
    const ink = inkLine(emo.color);

    const wedge = document.createElementNS(SVGNS,'g');
    wedge.setAttribute('class','wedge');
    wedge.dataset.id = emo.id;

    const path = document.createElementNS(SVGNS,'path');
    path.setAttribute('d', arcPath(CX, CY, R_OUTER, R_INNER, start, end));
    path.setAttribute('class', 'segment');
    path.addEventListener('click', () => selectEmotion(emo.id));
    // 扇區是 SVG <path>，本身沒有任何鍵盤語意；補上 role/tabindex/Enter-Space，
    // 讓只能用鍵盤或讀螢幕的使用者也走得完整個流程。
    makeActivatable(path, () => selectEmotion(emo.id), emo.label);
    const customMatForFill = findCustomMaterial(currentMaterial);
    if(currentMaterial === 'flat'){
      path.setAttribute('fill', emo.color);
      path.style.setProperty('--wc-filter', 'brightness(1)');
    } else if(currentMaterial === 'wood'){
      path.setAttribute('fill', emo.color);
      path.style.setProperty('--wc-filter', `url(#wood-${emo.id})`);
    } else if(currentMaterial === 'crayon'){
      path.setAttribute('fill', emo.color);
      path.style.setProperty('--wc-filter', `url(#crayon-${emo.id})`);
    } else if(customMatForFill){
      path.setAttribute('fill', emo.color);
      path.style.setProperty('--wc-filter', 'brightness(1)');
    } else {
      path.setAttribute('fill', `url(#grad-${emo.id})`);
      path.style.setProperty('--wc-filter', `url(#watercolor-${emo.id})`);
    }
    wedge.appendChild(path);

    const customMat = findCustomMaterial(currentMaterial);
    if(customMat && customMat.image){
      const texOverlay = document.createElementNS(SVGNS,'path');
      texOverlay.setAttribute('d', arcPath(CX, CY, R_OUTER, R_INNER, start, end));
      texOverlay.setAttribute('fill', `url(#customtex-${customMat.id})`);
      texOverlay.setAttribute('pointer-events', 'none');
      texOverlay.style.mixBlendMode = 'multiply';
      wedge.appendChild(texOverlay);
    }

    if(currentMaterial !== 'crayon'){
      const outline = document.createElementNS(SVGNS,'path');
      outline.setAttribute('d', arcPath(CX, CY, R_OUTER, R_INNER, start, end));
      outline.setAttribute('fill', 'none');
      outline.setAttribute('stroke', ink);
      outline.setAttribute('stroke-linejoin', 'round');
      outline.setAttribute('pointer-events', 'none');
      if(currentMaterial === 'flat'){
        outline.setAttribute('stroke-width', '1.2');
        outline.setAttribute('opacity', '0.35');
      } else if(currentMaterial === 'wood'){
        outline.setAttribute('stroke-width', '3.2');
        outline.setAttribute('opacity', '0.55');
        outline.setAttribute('filter', 'url(#woodOutline1)');
      } else if(findCustomMaterial(currentMaterial)){
        outline.setAttribute('stroke-width', '1.4');
        outline.setAttribute('opacity', '0.4');
      } else {
        outline.setAttribute('stroke-width', '1.6');
        outline.setAttribute('opacity', '0.45');
      }
      wedge.appendChild(outline);
    }

    if(currentMaterial === 'wood'){
      const outline2 = document.createElementNS(SVGNS,'path');
      outline2.setAttribute('d', arcPath(CX, CY, R_OUTER, R_INNER, start, end));
      outline2.setAttribute('fill', 'none');
      outline2.setAttribute('stroke', ink);
      outline2.setAttribute('stroke-width', '2.2');
      outline2.setAttribute('stroke-linejoin', 'round');
      outline2.setAttribute('opacity', '0.4');
      outline2.setAttribute('filter', 'url(#woodOutline2)');
      outline2.setAttribute('pointer-events', 'none');
      wedge.appendChild(outline2);
    }

    const labelPos = polar(CX, CY, (R_OUTER+R_INNER)/2, mid);
    const text = document.createElementNS(SVGNS,'text');
    text.setAttribute('x', labelPos.x); text.setAttribute('y', labelPos.y);
    text.setAttribute('text-anchor','middle'); text.setAttribute('dominant-baseline','middle');
    text.setAttribute('class','segment-label'); text.textContent = emo.label;
    wedge.appendChild(text);

    group.appendChild(wedge);
  });

  if(currentMaterial !== 'flat' && currentMaterial !== 'crayon' && !findCustomMaterial(currentMaterial)){
    const grain = document.createElementNS(SVGNS,'rect');
    grain.setAttribute('x', CX-R_OUTER); grain.setAttribute('y', CY-R_OUTER);
    grain.setAttribute('width', R_OUTER*2); grain.setAttribute('height', R_OUTER*2);
    grain.setAttribute('filter', 'url(#grain)');
    grain.setAttribute('clip-path', 'url(#donutClip)');
    grain.setAttribute('pointer-events', 'none');
    grain.style.mixBlendMode = 'multiply';
    grain.style.opacity = currentMaterial === 'wood' ? '0.1' : '0.07';
    group.appendChild(grain);
  }

  const c1 = document.createElementNS(SVGNS,'text');
  c1.setAttribute('x', CX); c1.setAttribute('y', CY - 4); c1.setAttribute('class','wheel-center-label center-label'); c1.textContent = currentSettings.centerTitle;
  svg.appendChild(c1);
  const c2 = document.createElementNS(SVGNS,'text');
  c2.setAttribute('x', CX); c2.setAttribute('y', CY + 14); c2.setAttribute('class','wheel-center-label center-label'); c2.textContent = currentSettings.centerHint;
  svg.appendChild(c2);

  applyWheelState();
}

function applyWheelState(){
  const svg = document.getElementById('wheelSvg');
  const group = document.getElementById('wheelGroup');
  if(!group) return;
  if(!activeEmotionId){
    group.style.transform = 'matrix(1,0,0,1,0,0)';
  } else {
    const emoIndex = emotions.findIndex(e => e.id === activeEmotionId);
    const angle = bisectorAngle(emoIndex, emotions.length);
    const centroid = polar(CX, CY, (R_OUTER+R_INNER)/2, angle);
    /* outward 揭示基礎情緒的那一刻，圓餅縮小並沉到畫面底部，只露出上緣的尖角與情緒文字，
       當作上方兩朵雲的視覺基座。位移量用 CY 的固定比例（viewBox 自身座標）而不是真實像素——
       ty 本來就是 viewBox 座標，摻進 CSS 像素會在不同螢幕尺寸下位移出不成比例的距離。 */
    const sinking = isOutward() && outwardStage === 'base';
    const k = sinking ? ZOOM_K * 0.85 : ZOOM_K;
    const tx = CX - k * centroid.x;
    const ty = CY - k * centroid.y + (sinking ? CY * 0.55 : 0);
    group.style.transform = `matrix(${k},0,0,${k},${tx},${ty})`;
  }
  svg.querySelectorAll('.wedge').forEach(g => {
    const isActive = g.dataset.id === activeEmotionId;
    g.style.opacity = (!activeEmotionId || isActive) ? '1' : '0';
  });
  svg.querySelectorAll('.center-label').forEach(t => { t.style.opacity = activeEmotionId ? '0' : '1'; });
}

/* Builds the breadcrumb from plain-text parts (optionally bold) via real DOM nodes, never innerHTML —
   emo.label / middle labels / breadcrumb settings text are admin-editable content and must never be
   parsed as HTML (a stored-XSS vector otherwise, since this page is publicly readable). */
function renderBreadcrumbParts(el, parts){
  el.innerHTML = '';
  parts.forEach(p => {
    if(p.bold){
      const b = document.createElement('b');
      b.textContent = p.text;
      el.appendChild(b);
    } else {
      el.appendChild(document.createTextNode(p.text));
    }
  });
}


/* ==================================================================
   由外而內（outward）模式
   ==================================================================
   泡泡句先自由飄浮，使用者點一句之後其餘如雲散開，再一層一層往回揭示
   它背後的中層詞與基礎情緒。資料結構完全沿用既有的 Emotions → Middles →
   Bubble1~4，這裡只是換一個「反過來走」的呈現方式。 */
let outwardStage = 'floating';    // 'floating' | 'mid' | 'base' | 'exhausted'
let outwardPick = null;           // { emo, mid, midIndex, bubbleIndex, text, tagKey }
let outwardBatch = [];            // 目前飄在畫面上的這一批
let outwardSeen = new Set();      // 已經出現過的泡泡（做輪替涵蓋用）
let outwardExhausted = false;     // 整輪都輪過一遍、使用者還是沒挑到共鳴的那句
/*
  [歷史命名備註]
  注意：本系統的程式碼命名與實際探索方向在字義上是相反的。
  'inward' (基礎模式)：實際上是由內核心向外展開 (Center -> Edge)。
  'outward' (探索模式)：實際上是由外圍泡泡向內深掘 (Edge -> Center)。
  因考慮到資料庫相容性，保留此遺留命名。
*/
/* both 的輪由使用者自己在左側切換，這裡記住他選了哪一邊（純畫面狀態，不存檔）。 */
let userChosenMode = null;

/* HideMiddleLayer 輪沒有「目前選到哪個中層詞」這個中繼狀態（中層詞整層都被跳過），
   對焦一顆泡泡靠的是 activeBubbleKey 而不是 activeMiddleIndex+activeBubbleIndex。 */
function findBubbleByTagKey(emo, tagKey){
  const parts = String(tagKey).split('::');
  if(parts.length !== 3) return null;
  const m = emo.middles.find(mm => mm.id === parts[1]);
  if(!m) return null;
  const text = m.bubbles[parseInt(parts[2], 10)];
  if(!text) return null;
  return { m, text };
}

/* 單顆泡泡句雲朵的渲染＋互動，一般模式（單一中層詞）與 HideMiddleLayer（攤平所有中層詞）
   共用同一份幾何計算，只有「對焦狀態怎麼記」和「點擊後做什麼」不同。posOverride 有值時
   （HideMiddleLayer）直接用 layoutHideMiddleBubbles() 算好的座標，不再套用固定格子公式。 */
function renderSentenceBubbleEl({ layer, emo, m, midIdx, i, text, angle, ink, hideMiddle, posOverride, midInfo, midOuterRadius }){
  if(!text) return;
  let pos;
  if(posOverride){
    pos = { x: posOverride.x / 100 * (CX * 2), y: posOverride.y / 100 * (CY * 2) };
  } else {
    // 第二輪覆核 R-1（根因兩層，都要修，見進度記錄）：
    // (1) 半徑基準要用「這一圈裡最外層的中層雲半徑」（呼叫端算好傳進來的 midOuterRadius），
    //     不能只看被選中那一朵自己的半徑（midInfo.radius）——中層詞多時常被排到外圈，只看
    //     被選中那一朵會讓泡泡句退得不夠遠，直接疊進其他中層雲裡面。
    // (2) 淨空不能用寫死的 viewBox 常數（原本是 80）：字級下限是用 CSS px 定義的、不是跟著
    //     容器等比縮放，手機上 vbPerPx 可能到 2.5 以上，同樣的常數在手機上完全不夠、但乘上
    //     vbPerPx 又會把淨空撐得太大、把雲朵推出可視範圍（實測跑過好幾組數值，見下面「已知
    //     取捨」）。改成直接量測「一朵已經在畫面上的中層雲」跟「這句泡泡句自己」實際渲染
    //     出來的高度，兩者半高相加當作真正需要的淨空，是跟 layoutMiddleClouds() 同一套
    //     「先量真實尺寸再算位置」的做法，不是另外發明一套。量測方式用 offsetWidth/Height
    //     （版面尺寸），不用 getBoundingClientRect()（這時候泡泡句還沒真的定位插入，量不到）。
    //
    //     已知取捨（在真瀏覽器用 5 個中層詞 + 4 句泡泡句、375px 寬反覆實測調出來的）：
    //     兩朵雲「完全不緊貼」所需要的淨空（下面 0.7 的係數若改成 1）雖然能做到零重疊，
    //     但會把最外圈那幾顆泡泡句推到超出 .stage 可視範圍 50px 以上；乘 0.7 折扣後重疊
    //     壓到 17%（在驗收標準的 ≤18% 內），代價是密集情境（5 個以上中層詞、選到外圈那朵、
    //     泡泡句本身文字又偏長）下，1-2 顆泡泡句可能還是會超出可視範圍 20-40px、需要稍微
    //     捲動才看得到——這是密集情境下己知還沒完全解決的殘留問題，不是這次沒測到，寫在
    //     這裡是刻意的取捨記錄。真實資料如果中層詞數量在 4 個以內（多數情況)，不會被排到
    //     第三圈，實測不會踩到這個殘留問題。
    const wrap = document.getElementById('wheelWrap');
    const vbPerPx = wrap && wrap.clientWidth ? (CX * 2) / wrap.clientWidth : 1;
    const a = angle + (SENT_SPREAD[i % SENT_SPREAD.length] || 0);
    const existingMid = layer.querySelector('.cloud-mid');
    const midHalfH = existingMid ? (existingMid.offsetHeight / 2) * vbPerPx : 20;
    const tempSent = document.createElement('div');
    tempSent.className = 'cloud cloud-sentence';
    tempSent.style.visibility = 'hidden';
    tempSent.style.left = '0'; tempSent.style.top = '0';
    tempSent.textContent = text;
    layer.appendChild(tempSent);
    const sentHalfH = (tempSent.offsetHeight / 2) * vbPerPx;
    tempSent.remove();
    // QA 報告第六輪 F-2：倍率改用 Shared_JS.html 的具名常數 SENTENCE_CLEARANCE_FACTOR
    // （0.7 → 1.5），跟 Admin_JS_Preview.html 的 renderPreviewSentenceBubbleEl 共用同一個值，
    // 不要各自寫死——那份常數上面的說明有完整的實測數據跟為什麼要改。
    const clearance = (midHalfH + sentHalfH + 14) * SENTENCE_CLEARANCE_FACTOR;
    const outerMidRadius = midOuterRadius !== undefined ? midOuterRadius : (midInfo ? midInfo.radius : R_MID);
    const baseR = Math.max(R_SENT, outerMidRadius + clearance);
    // 根據字數動態外推：超過 5 個字後，每個字把氣泡往外推 5px，避免長句子的氣泡疊到中層氣泡；
    // 維持原本固定的 CSS px 級距離感（不乘 vbPerPx）——上面的 baseR 已經改用真實測量的淨空，
    // 這裡疊加 vbPerPx 縮放實測會把長句子推出可視範圍更多，對重疊的改善卻很有限。
    const extraDist = Math.max(0, text.length - 5) * 5;
    const r = baseR + extraDist + (SENT_RADIUS_JITTER[i % SENT_RADIUS_JITTER.length] || 0);
    pos = polar(CX, CY, r, a);
  }
  const tagKey = emo.id + '::' + m.id + '::' + i;
  const isFocused = hideMiddle ? (tagKey === activeBubbleKey) : (i === activeBubbleIndex);
  const el = document.createElement('div');
  el.className = 'cloud cloud-sentence'
    + (selectedTags.some(t => t.key === tagKey) ? ' popped' : '')
    + (isFocused ? ' focused' : '');
  el.dataset.tagKey = tagKey;
  el.style.left = (pos.x / (CX * 2) * 100) + '%'; el.style.top = (pos.y / (CY * 2) * 100) + '%';
  el.style.setProperty('--ink-line', ink);
  el.style.setProperty('--halo', hexToRgba(emo.color, .22));
  el.style.setProperty('--blob-radius', BLOB_RADII[(i+2) % BLOB_RADII.length]);
  el.textContent = text;
  const tailWrap = document.createElement('div');
  tailWrap.className = 'tail-wrap';
  ['tail-dot tail-dot-1','tail-dot tail-dot-2','tail-dot tail-dot-3'].forEach(cls => {
    const dot = document.createElement('div');
    dot.className = cls;
    tailWrap.appendChild(dot);
  });
  el.appendChild(tailWrap);
  layer.appendChild(el); // 先掛進畫面，下面才量得到泡泡實際渲染出來的寬高

  // 指向「這句話所屬的中層氣泡」實際渲染的位置，而不是圓心方向——中層詞的位置是
  // layoutMiddleClouds() 動態算出來的（可能被排到外圈），所以尾巴要吃它算好的座標，
  // 不能自己另外推算。HideMiddleLayer 輪沒有畫中層雲，退回用扇形基準角，泡泡仍會保有
  // 以情緒為圓心的扇形分布。
  const midPos = midInfo ? midInfo.pos : polar(CX, CY, R_MID, angle);
  const tailAngle = Math.atan2(midPos.y - pos.y, midPos.x - pos.x) * 180 / Math.PI - 90;
  tailWrap.style.transform = `rotate(${tailAngle}deg)`;

  // 泡泡本體是橫向的橢圓（寬可到 168px，但通常只有一兩行高），尾巴朝側邊伸的時候需要的淨空
  // 遠比朝上下多；用字數猜距離常常猜不準，尾巴會被自己泡泡的白底蓋住看不見。改成量泡泡「實際
  // 渲染出來」的寬高，算出尾巴在那個方向上要離開泡泡本體多遠，才不會被自己的白底吃掉。
  // 用 offsetWidth/Height（版面尺寸）而非 getBoundingClientRect()（視覺尺寸）——泡泡剛插入時還在
  // 播放 scale(0) 進場動畫，這時候量到的視覺框會是 0×0，offsetWidth/Height 不受 transform 影響，
  // 量到的才是真正的版面大小。
  const halfW = el.offsetWidth / 2, halfH = el.offsetHeight / 2;
  if(halfW > 0 && halfH > 0){
    const rad = tailAngle * Math.PI / 180;
    const dirX = -Math.sin(rad), dirY = Math.cos(rad);
    const clearance = 1 / Math.sqrt((dirX * dirX) / (halfW * halfW) + (dirY * dirY) / (halfH * halfH));
    const baseOffset = parseFloat(getComputedStyle(tailWrap.querySelector('.tail-dot-1')).top) || 0;
    const tailPush = Math.max(0, clearance - baseOffset + 12);
    tailWrap.style.setProperty('--tail-push', tailPush + 'px');
  }

  // Clicking a bubble only focuses/unfocuses it now — same "select, don't commit" behaviour as
  // clicking an emotion wedge or a middle cloud. Actually adding/removing always goes through
  // the collectLevelBtn near the breadcrumb (renderCollectLevelButton), which is right next to
  // where the user is already looking, instead of relying on a change way down on the wheel itself.
  const toggleFocus = () => {
    if(hideMiddle) activeBubbleKey = (activeBubbleKey === tagKey) ? null : tagKey;
    else activeBubbleIndex = (activeBubbleIndex === i) ? null : i;
    renderClouds();
  };
  el.addEventListener('click', toggleFocus);
  makeActivatable(el, toggleFocus);   // 鍵盤也要能操作
}

/* 輪本身宣告的方向：'inward' | 'outward' | 'both'。沒有 mode 的舊資料一律視同現況。 */
function wheelDeclaredMode(){
  const w = wheels.find(x => x.id === activeViewWheelId);
  return (w && w.mode) || 'inward';
}

function currentWheelMode(){
  const declared = wheelDeclaredMode();
  if(declared !== 'both') return declared;
  return userChosenMode || 'inward'; // both 輪預設先給熟悉的 inward
}

/* 是否隱藏第二層（中層詞）：輪層級開關，兩種方向都要對應跳過。 */
function currentWheelHideMiddle(){
  const w = wheels.find(x => x.id === activeViewWheelId);
  return !!(w && w.hideMiddleLayer);
}

function isOutward(){ return currentWheelMode() === 'outward'; }

/* 左側的模式切換鈕：只有 both 的輪才出現，純 inward／純 outward 的輪保持畫面乾淨。
   顯示文字吃管理介面自訂的名稱，讓命名本身就是說明。 */
function renderModeSwitcher(){
  const row = document.getElementById('modeSwitcherRow');
  if(!row) return;
  // 手機版的直書切換鈕會蓋在麵包屑上，要讓麵包屑退讓——但只有真的有切換鈕時才退，
  // 所以把「有沒有切換鈕」這件事標記到卡片上讓 CSS 去判斷（見 @media 內的規則）。
  const panel = row.closest('.wheel-panel');
  if(wheelDeclaredMode() !== 'both'){
    row.style.display = 'none'; row.innerHTML = '';
    if(panel) panel.classList.remove('has-mode-switcher');
    return;
  }
  if(panel) panel.classList.add('has-mode-switcher');
  row.style.display = '';
  row.innerHTML = '';
  const active = currentWheelMode();
  [
    { id: 'inward', label: currentSettings.inwardModeLabel },
    { id: 'outward', label: currentSettings.outwardModeLabel },
  ].forEach(m => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn mode-switch-btn' + (m.id === active ? ' active' : '');
    btn.textContent = m.label;
    btn.addEventListener('click', () => {
      if(m.id === active) return;
      switchViewMode(m.id);
    });
    row.appendChild(btn);
  });
}

function switchViewMode(mode){
  userChosenMode = mode;
  activeEmotionId = null; activeMiddleIndex = null; activeBubbleIndex = null; activeBubbleKey = null;
  resetOutwardState();
  renderModeSwitcher();
  renderWheel();
  applyWheelState();
  renderClouds();
  // 等這一輪 render 造成的排版變化落定，再重新置中（跟初次載入用同一個延遲）
  // QA 報告第七輪：instant=true，理由同初次載入那個呼叫點——切換模式當下畫面整個重畫，
  // 不是「使用者剛做了一個小動作、期待看到平滑的回饋捲動」那種情境，直接跳過去。
  setTimeout(() => centerStageScroll(true), 50);
}

function resetOutwardState(){
  outwardStage = 'floating';
  outwardPick = null;
  outwardBatch = [];
  outwardSeen = new Set();
  outwardExhausted = false;
}

/* 攤平與抽樣的規則本身放在 Shared_JS，使用者頁面與管理預覽共用同一份，
   這裡只負責把「這一輪的內容」和「這一頁自己的已看過紀錄」餵進去。 */
function allOutwardBubbles(){
  return outwardBubblesOf(emotions);
}
function sampleOutwardBubbles(){
  const all = allOutwardBubbles();
  const picked = sampleOutwardFrom(all, outwardSeen);
  /* 先把 outwardSeen 裡「已經不存在於目前內容」的 key 清掉再判斷是否輪完。
     否則內容一被重新發佈（刪掉情緒或中層詞），舊的 key 還留著，size 會大於實際泡泡數，
     於是明明還有沒看過的泡泡，卻誤判成「整輪都輪完了」。 */
  const liveKeys = new Set(all.map(b => b.tagKey));
  outwardSeen.forEach(k => { if(!liveKeys.has(k)) outwardSeen.delete(k); });
  // 整輪都輪過一遍了。不直接靜靜重置重來——使用者已經看完全部卻都沒有共鳴，
  // 這時候應該停下來說一句話，讓他知道找不到是正常的、可以自己寫。
  if(outwardSeen.size >= all.length) outwardExhausted = true;
  return picked;
}

function renderOutwardFloating(){
  const layer = document.getElementById('bubbleLayer');
  const wrap = document.getElementById('wheelWrap');
  const breadcrumb = document.getElementById('breadcrumb');
  const backBtn = document.getElementById('backBtn');
  const hint = document.getElementById('hint');

  outwardStage = 'floating';
  outwardPick = null;
  layer.innerHTML = '';
  renderCollectLevelButton();   // 這支在 outward 下會把 inward 的浮動鈕收起來，避免兩組同時出現
  wrap.classList.add('outward-mode');          // 泡泡改用實際可讀的尺寸，不跟著圓餅縮放
  wrap.classList.add('outward-hide-wheel');   // 圓餅先收起來，最後揭示時才浮現
  wrap.classList.remove('tinted');
  wrap.style.removeProperty('--reveal-tint');
  backBtn.classList.remove('show');
  breadcrumb.textContent = '';
  hint.style.display = '';
  hint.textContent = currentSettings.outwardEntryHint;

  // 上一批已經把整輪輪完了，卻還是沒有一句打中他 —— 停下來邀請他自己寫，
  // 而不是若無其事地從頭再輪一遍（那會讓人覺得自己找不到是自己的問題）。
  if(outwardExhausted){
    outwardStage = 'exhausted';
    hint.textContent = '';
    const box = document.createElement('div');
    box.className = 'outward-exhausted';
    box.textContent = currentSettings.outwardExhaustedHint;
    layer.appendChild(box);
    renderOutwardActions();
    return;
  }

  outwardBatch = sampleOutwardBubbles();
  if(!outwardBatch.length){
    hint.textContent = '這個情緒輪還沒有任何泡泡句';
    renderOutwardActions();
    return;
  }

  const positions = layoutOutwardPositions(outwardBatch);
  outwardBatch.forEach((b, i) => {
    const el = document.createElement('div');
    el.className = 'cloud cloud-sentence cloud-drift';
    el.dataset.tagKey = b.tagKey;
    el.textContent = b.text;
    el.style.left = positions[i].x + '%';
    el.style.top = positions[i].y + '%';
    el.style.setProperty('--blob-radius', BLOB_RADII[i % BLOB_RADII.length]);
    // 每顆各自的飄浮節奏，才不會整批同步擺動像機械
    el.style.setProperty('--drift-dur', (7 + Math.random() * 6).toFixed(1) + 's');
    el.style.setProperty('--drift-delay', (-Math.random() * 6).toFixed(1) + 's');
    el.style.setProperty('--drift-x', (4 + Math.random() * 8).toFixed(1) + 'px');
    el.style.setProperty('--drift-y', (5 + Math.random() * 9).toFixed(1) + 'px');
    el._outward = { ...b, x: positions[i].x, y: positions[i].y };
    el.addEventListener('click', () => pickOutwardBubble(el));
    makeActivatable(el, () => pickOutwardBubble(el));   // 鍵盤也要能選句子
    layer.appendChild(el);
  });
  renderOutwardActions();
}

/* 使用者點了一句：其餘的雲散開，被點的飄到中央，然後逐層揭示。 */
function pickOutwardBubble(el){
  if(outwardStage !== 'floating') return;   // 揭示進行中就不再接受點擊
  const layer = document.getElementById('bubbleLayer');
  const hint = document.getElementById('hint');
  const info = el._outward;
  outwardPick = info;
  outwardStage = 'mid';

  // 其他泡泡：沿著自己相對中心的方位往外散開，所以是「擴散」而不是全部往同一邊飛
  [...layer.children].forEach(child => {
    if(child === el) return;
    const p = child._outward;
    const dx = (p ? p.x : 50) - 50, dy = (p ? p.y : 50) - 50;
    const len = Math.hypot(dx, dy) || 1;
    child.style.setProperty('--fly-x', Math.round(dx / len * 90) + 'px');
    child.style.setProperty('--fly-y', Math.round(dy / len * 90) + 'px');
    child.classList.add('cloud-disperse');
  });

  // 主角飄到中央偏下，把上方留給待會浮現的中層詞
  el.classList.remove('cloud-drift');
  el.classList.add('cloud-chosen');
  el.style.left = '50%';
  el.style.top = '62%';

  document.getElementById('backBtn').classList.add('show');
  renderOutwardActions();

  setTimeout(() => {
    [...layer.querySelectorAll('.cloud-disperse')].forEach(n => n.remove());
    // HideMiddleLayer 的輪跳過中層雲這一步，點下泡泡後直接揭示基礎情緒
    if(currentWheelHideMiddle()) revealOutwardBase(el, null);
    else revealOutwardMiddle(el);
  }, 620);
}

function revealOutwardMiddle(chosenEl){
  const layer = document.getElementById('bubbleLayer');
  const hint = document.getElementById('hint');
  const breadcrumb = document.getElementById('breadcrumb');
  const info = outwardPick;
  if(!info) return;

  hint.textContent = currentSettings.outwardRevealMidHint;

  const mid = document.createElement('div');
  mid.className = 'cloud cloud-mid cloud-reveal cloud-next';
  mid.textContent = info.mid.label || '(未命名)';
  mid.style.left = '50%';
  mid.style.top = '38%';
  // 中層這一步仍然不上基礎情緒的色（顏色留到最後一步才浮現）
  mid.style.setProperty('--ink-line', '#8C7660');
  mid.style.setProperty('--blob-radius', BLOB_RADII[1]);
  // 由使用者自己點這朵雲才往下一層，不做定時跳轉——揭示的節奏交給使用者決定，
  // 他可能想在這個詞上多停留一下。點的動作本身也跟 inward 的「點雲往下走」一致。
  const goDeeper = () => {
    if(outwardStage !== 'mid') return;   // 已經揭示過就不重複觸發
    mid.classList.remove('cloud-next');
    revealOutwardBase(chosenEl, mid);
  };
  mid.addEventListener('click', goDeeper);
  makeActivatable(mid, goDeeper);   // 鍵盤也要能往下一層
  layer.appendChild(mid);
  mid.focus({ preventScroll: true });   // 鍵盤使用者不用自己找下一步在哪

  renderBreadcrumbParts(breadcrumb, [{ text: info.mid.label || '', bold: true }]);
  renderOutwardActions();
}

function revealOutwardBase(chosenEl, midEl){
  const wrap = document.getElementById('wheelWrap');
  const hint = document.getElementById('hint');
  const breadcrumb = document.getElementById('breadcrumb');
  const info = outwardPick;
  if(!info) return;
  outwardStage = 'base';

  const ink = inkLine(info.emo.color);
  hint.textContent = currentSettings.outwardRevealBaseHint;

  // 顏色到這一步才浮現：泡泡與中層詞染上該情緒的線條色，舞台漸漸透出情緒的顏色
  [chosenEl, midEl].forEach(n => {
    if(!n) return;
    n.style.transition = 'color .8s ease';
    n.style.setProperty('--ink-line', ink);
    n.style.setProperty('--halo', hexToRgba(info.emo.color, .3));
  });
  wrap.style.setProperty('--reveal-tint', hexToRgba(info.emo.color, .28));
  wrap.classList.add('tinted');

  // 兩朵雲往上收成一疊（句子在上、中層詞在下），把中央讓給即將浮現的圓餅
  layoutRevealStack(chosenEl, midEl);

  // 圓餅浮現，並聚焦到這個情緒的扇區——這就是「結果」的圖形呈現，
  // 情緒名稱本身由既有的扇區標籤畫出來，不需要塞進任何句子裡。
  activeEmotionId = info.emo.id;
  activeMiddleIndex = null;
  applyWheelState();
  wrap.classList.remove('outward-hide-wheel');

  renderBreadcrumbParts(breadcrumb, midEl
    ? [
        { text: info.mid.label || '', bold: true },
        { text: '　→　' },
        { text: info.emo.label || '', bold: true },
      ]
    : [{ text: info.emo.label || '', bold: true }]);
  renderOutwardActions();
}

/* 兩朵雲往上收成一疊的實際計算放在 Shared_JS（管理預覽用的是同一支）。 */
function layoutRevealStack(chosenEl, midEl){
  layoutRevealStackOn(document.getElementById('wheelWrap'), chosenEl, midEl);
}

/* 收尾按鈕。「到情緒輪上看看它的位置」是兩個模式之間的橋，但那需要 BridgeWheelID
   （見備忘補註），這一版先不做，只留收集與再選一句。 */
function renderOutwardActions(){
  const row = document.getElementById('outwardActions');
  if(!row) return;
  row.innerHTML = '';
  if(!isOutward()){ row.style.display = 'none'; return; }
  row.style.display = '';

  const add = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    row.appendChild(b);
    return b;
  };

  if(outwardStage === 'floating'){
    add(currentSettings.outwardShuffleLabel, '', () => renderOutwardFloating());
    return;
  }
  // 整輪輪完都沒選到：只給「再選一次」，把輪替重新開始
  if(outwardStage === 'exhausted'){
    add(currentSettings.outwardRestartLabel, 'primary', () => {
      outwardSeen = new Set();
      outwardExhausted = false;
      renderOutwardFloating();
    });
    return;
  }
  // 選了泡泡、中層詞正要浮現，但還沒點下去看到基礎情緒——這一步還沒「深挖完」，
  // 用「再選一句」（那是深挖完之後才適用的語氣）會讓人誤以為已經選完了，
  // 所以獨立一顆文字給這個「退回」動作，跟深挖完的「再選一句」分開設定。
  if(outwardStage === 'mid'){
    add(currentSettings.outwardBackLabel, '', () => renderOutwardFloating());
    return;
  }

  if(outwardStage === 'base' && outwardPick){
    /* 收集「完整的三層」：原本那句話 → 中層詞 → 基礎情緒。
       只記後兩層的話，使用者事後回頭看會忘記自己最初被打中的是哪一句 ——
       而那句話往往才是他當下真正的感受。直接餵進既有的 selectedTags 管線，
       所以今日情緒雲與套圖下載自動可用。 */
    const key = 'outward::' + outwardPick.tagKey;
    const already = selectedTags.some(t => t.key === key);
    const btn = add(already ? '✓ ' + currentSettings.outwardCollectLabel : currentSettings.outwardCollectLabel,
      'primary', () => {
        if(selectedTags.some(t => t.key === key)) return;
        /* 各層一行：排成一長串的話，套圖產圖時整張圖的字級會被這條長標籤拖到很小。
           隱藏第二層的輪要跳過中層詞——那個詞心理師刻意關掉、案主從頭到尾沒看過，
           不該出現在他帶回家的圖上。 */
        const lines = [outwardPick.text];
        if(!currentWheelHideMiddle()) lines.push('→ ' + (outwardPick.mid.label || ''));
        lines.push('→ ' + (outwardPick.emo.label || ''));
        addTag({ key, color: outwardPick.emo.color, text: lines.join('\n') });
        renderOutwardActions();
      });
    btn.disabled = already;
  }
  add(currentSettings.outwardAgainLabel, '', () => renderOutwardFloating());
}

function renderClouds(){
  const layer = document.getElementById('bubbleLayer');
  const breadcrumb = document.getElementById('breadcrumb');
  const backBtn = document.getElementById('backBtn');
  const hint = document.getElementById('hint');

  // outward 有自己的一套渲染流程（飄浮 → 雲散 → 揭示），走完全不同的路徑
  if(isOutward()){
    renderOutwardFloating();
    return;
  }
  document.getElementById('wheelWrap').classList.remove('outward-mode', 'outward-hide-wheel', 'tinted');
  renderOutwardActions();

  layer.innerHTML = '';
  renderCollectLevelButton();

  if(!activeEmotionId){
    breadcrumb.textContent = currentSettings.breadcrumbDefault;
    backBtn.classList.remove('show');
    hint.style.display = ''; hint.textContent = currentSettings.hintDefault;
    centerStageScroll(); // 第三輪 R-1：沒有雲朵了，退回幾何置中（見 centerStageScroll 的說明）
    return;
  }
  backBtn.classList.add('show');
  const emo = findEmotion(activeEmotionId);
  const emoIndex = emotions.findIndex(e => e.id === activeEmotionId);
  const angle = bisectorAngle(emoIndex, emotions.length);
  const ink = inkLine(emo.color);

  const hideMiddle = currentWheelHideMiddle();

  if(hideMiddle){
    // 隱藏第二層：不畫中層詞的雲，選了情緒就直接把「所有」中層詞底下的泡泡攤開顯示——
    // 泡泡的角度／尾巴指向仍沿用各自中層詞原本會站的位置（只是那個點沒有雲畫在那裡），
    // 這樣泡泡還是會保有原本以情緒為圓心的扇形分布，看起來不會像隨機亂丟。
    renderBreadcrumbParts(breadcrumb, [{ text: emo.label, bold: true }]);
    hint.style.display = 'none';
    const hideMiddleItems = [];
    emo.middles.forEach((m, midIdx) => {
      (m.bubbles || []).forEach((text, i) => {
        if(text) hideMiddleItems.push({ m, midIdx, i, text });
      });
    });
    // 固定 4 個角度格子（SENT_SPREAD）是給「一個中層詞的 4 句」設計的——這種輪一次要擠下
    // 「所有中層詞的所有泡泡句」，格子數量遠遠不夠用，要走跟 outward 飄浮泡泡同一套
    // 「先量真實尺寸、再防碰撞」的邏輯，見 layoutHideMiddleBubbles()。
    const hideMiddlePositions = layoutHideMiddleBubbles(hideMiddleItems);
    hideMiddleItems.forEach((it, idx) => {
      renderSentenceBubbleEl({
        layer, emo, m: it.m, midIdx: it.midIdx, i: it.i, text: it.text, angle, ink,
        hideMiddle: true, posOverride: hideMiddlePositions[idx],
      });
    });
    centerStageScroll(); // 第三輪 R-1：這一支路徑一次攤開所有泡泡句，同樣要重新對位
    return;
  }

  renderBreadcrumbParts(breadcrumb, activeMiddleIndex === null
    ? [{ text: emo.label, bold: true }, { text: '　→　' + currentSettings.breadcrumbPickMiddle }]
    : [{ text: emo.label, bold: true }, { text: '　→　' }, { text: emo.middles[activeMiddleIndex] ? emo.middles[activeMiddleIndex].label : '', bold: true }]);

  const midLayout = layoutMiddleClouds(emo.middles, angle);
  // 第二輪覆核 R-1：中層詞可能被 layoutMiddleClouds() 排到外圈（詞多時常見，例如手機字級
  // 下限生效後更容易發生），但泡泡句原本只看「被選中那一朵」中層雲的半徑，不知道還有其他
  // 中層雲被排到更外圈——手機上選到內圈那朵中層詞時，泡泡句會算出偏內側的半徑，直接疊進
  // 外圈那幾朵中層雲裡面。改成用「這一圈裡最外層的半徑」，泡泡句永遠退到比所有中層雲都更外面。
  const midOuterRadius = midLayout.length ? Math.max(...midLayout.map(mi => mi.radius)) : R_MID;
  emo.middles.forEach((m, idx) => {
    const pos = midLayout[idx].pos;
    const el = document.createElement('div');
    el.className = 'cloud cloud-mid' + (idx === activeMiddleIndex ? ' selected' : (activeMiddleIndex !== null ? ' dim' : ''));
    // % of the wheel's own coordinate space (not px) — so this tracks .wheel-wrap's actual rendered
    // size (which shrinks on narrow screens) instead of assuming the desktop-sized 840×840 box.
    el.style.left = (pos.x / (CX * 2) * 100) + '%'; el.style.top = (pos.y / (CY * 2) * 100) + '%';
    el.style.setProperty('--ink-line', ink);
    el.style.setProperty('--halo', hexToRgba(emo.color, .3));
    el.style.setProperty('--blob-radius', BLOB_RADII[idx % BLOB_RADII.length]);
    if(idx === activeMiddleIndex){ el.style.setProperty('--bubble-fill', emo.color); }
    el.textContent = m.label || '(未命名)';
    el.addEventListener('click', () => selectMiddle(idx));
    makeActivatable(el, () => selectMiddle(idx));   // 鍵盤也要能操作
    layer.appendChild(el);
  });

  if(activeMiddleIndex === null){
    hint.style.display = ''; hint.textContent = currentSettings.hintPickMiddle;
    centerStageScroll(); // 第三輪 R-1：只有中層雲、還沒選中層詞，也要對齊這一圈中層雲的位置
    return;
  }
  const m = emo.middles[activeMiddleIndex];
  if(!m){ hint.style.display=''; centerStageScroll(); return; }
  hint.style.display = 'none';

  m.bubbles.forEach((text, i) => {
    renderSentenceBubbleEl({
      layer, emo, m, midIdx: activeMiddleIndex, i, text, angle, ink,
      hideMiddle: false, midInfo: midLayout[activeMiddleIndex], midOuterRadius,
    });
  });
  centerStageScroll(); // 第三輪 R-1：泡泡句展開後，對齊這一圈雲朵（中層雲＋泡泡句）的包圍盒中心
}

function selectEmotion(id){
  if(activeEmotionId === id){ activeEmotionId = null; activeMiddleIndex = null; }
  else { activeEmotionId = id; activeMiddleIndex = null; }
  activeBubbleIndex = null; activeBubbleKey = null;
  applyWheelState(); renderClouds();
}
function selectMiddle(idx){
  activeMiddleIndex = (activeMiddleIndex === idx) ? null : idx;
  activeBubbleIndex = null;
  renderClouds();
}
document.getElementById('backBtn').addEventListener('click', () => {
  // outward 沒有「上一層」的概念——揭示是一條單向的路，收回就是重新飄一批
  if(isOutward()){
    activeEmotionId = null; activeMiddleIndex = null; activeBubbleIndex = null; activeBubbleKey = null;
    applyWheelState();
    renderOutwardFloating();
    return;
  }
  // HideMiddleLayer 的輪沒有中層這一步可以「收回一層」，選了情緒就直接看到泡泡
  if(currentWheelHideMiddle()) activeEmotionId = null;
  else if(activeMiddleIndex !== null) activeMiddleIndex = null;
  else activeEmotionId = null;
  activeBubbleIndex = null; activeBubbleKey = null;
  applyWheelState(); renderClouds();
});

/* ---------------- Load data from the Google Sheet via the ?api=published endpoint ---------------- */
/* 第五輪之後，fetchApi_() 內建的 AbortController 已經是第一層逾時保護，理論上 loadData() 這裡
   的 fetch 呼叫一定會在 20 秒內 resolve 或 reject。這個 watchdog 是第二層、獨立的保底：萬一
   fetchApi_() 本身因為某種沒預料到的原因（例如瀏覽器分頁被背景凍結、Service Worker 卡住）
   沒有照時間觸發，watchdog 還是能強制解除 is-loading 遮罩，不讓案主永遠停在「載入中…」、
   一點線索都沒有。由 loadData() 裡先觸發的那一條（成功或失敗）清掉，健康的情況下永遠不會跑到。 */
const LOAD_WATCHDOG_MS = 20000;
let loadWatchdog = null;
function clearLoadWatchdog(){
  if(loadWatchdog){ clearTimeout(loadWatchdog); loadWatchdog = null; }
}
function startLoadWatchdog(){
  clearLoadWatchdog();
  loadWatchdog = setTimeout(() => {
    loadWatchdog = null;
    if(!document.body.classList.contains('is-loading')) return; // already revealed, nothing to rescue
    document.body.classList.remove('is-loading');
    const breadcrumb = document.getElementById('breadcrumb');
    const hint = document.getElementById('hint');
    if(breadcrumb) breadcrumb.textContent = '載入逾時';
    if(hint) hint.textContent = '連線好像卡住了，請重新整理頁面再試一次。';
    console.error('getPublishedData() 超過 ' + LOAD_WATCHDOG_MS + 'ms 沒有任何回應，已解除載入遮罩。');
  }, LOAD_WATCHDOG_MS);
}

/* 第五輪：改用 fetchApi_('published') 打 ?api=published，取代原本的 google.script.run
   .getPublishedData()。success／failure 兩條路徑的畫面處理（解除 is-loading 遮罩、顯示的
   錯誤訊息文字）完全不變，只是從 withSuccessHandler／withFailureHandler 的回呼風格改成
   try/catch——網路層的錯誤（斷線、DNS 失敗等）現在會直接讓 fetch() 的 promise reject，
   不需要另外處理；逾時仍然由 fetchApi_() 內建的 AbortController 負責，跟這裡的 watchdog
   是兩層獨立的保護（fetchApi_ 20 秒逾時 reject，watchdog 20 秒後強制解除遮罩，就算 fetchApi_
   本身因為某種原因沒有照時間 reject，watchdog 還是能兜底）。 */
async function loadData(){
  const hint = document.getElementById('hint');
  const breadcrumb = document.getElementById('breadcrumb');
  startLoadWatchdog();
  let data;
  try{
    data = await fetchApi_('published');
  }catch(err){
    clearLoadWatchdog();
    document.getElementById('breadcrumb').textContent = '載入失敗';
    document.getElementById('hint').textContent = '無法讀取情緒輪資料：' + (err && err.message ? err.message : err);
    document.body.classList.remove('is-loading'); // surface the error instead of masking it forever
    return;
  }
  clearLoadWatchdog();
  try{
    applyPublishedData_(data);
  }catch(err){
    console.error('情緒輪資料處理失敗：', err);
    document.getElementById('breadcrumb').textContent = '載入失敗';
    document.getElementById('hint').textContent = '這份情緒輪資料讀不起來，請管理者到管理介面重新發佈一次。';
    document.body.classList.remove('is-loading'); // 一定要解除遮罩，不能讓使用者停在全白畫面
  }
}

/* 真正處理資料的部分抽成獨立函式，讓上面的 withSuccessHandler 可以整段包 try/catch。 */
function applyPublishedData_(data){
  const hint = document.getElementById('hint');
  const breadcrumb = document.getElementById('breadcrumb');
  {
      /* 這是使用者頁面唯一的資料入口，而且是案主會看到的畫面——只要有一個輪的 emotions
         少了欄位或型別不對，後面 renderWheel() 就會丟例外，而例外一丟出去，下面那段
         「解除 is-loading 遮罩」就永遠不會執行，案主看到的是一片全白。與其相信資料一定
         正確，這裡先把每一個輪整理成保證可用的形狀（normalizeEmotions 在 Shared_JS）。 */
      const rawWheels = (data && Array.isArray(data.wheels)) ? data.wheels : [];
      wheels = rawWheels
        .filter(w => w && typeof w === 'object')
        .map(w => ({ ...w, emotions: normalizeEmotions(w.emotions) }));
      let activeWheel = null;
      if(wheels.length){
        // 處方連結指名的輪優先；找不到就退回預設輪，並記下來稍後提示使用者一聲
        activeWheel = pickViewWheel_(deepLinkWheelId);
        activeViewWheelId = activeWheel.id;
        emotions = activeWheel.emotions || [];
      } else {
        emotions = [];
      }
      renderWheelSwitcher();
      customMaterials = (data && data.customMaterials) || [];
      customTemplates = (data && data.customTemplates) || [];
      applyTheme(data && data.theme);
      applySettings(data && data.settings);
      applyMaterial((activeWheel && activeWheel.materialId) || 'watercolor');
      applyFont((data && data.fontId) || 'system');
      renderSelectedTags();
      renderGeneratePanel();
      // 要等 applySettings() 跑完（模式鈕的文字吃 currentSettings），也要等 wheels 就緒
      applyDeepLinkModeOnce();
      renderModeSwitcher();

      if(data && data.notPublishedYet){
        breadcrumb.textContent = '';
        hint.textContent = '';
        document.getElementById('wheelSvg').innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '目前還沒有發佈的內容，請管理者先到管理介面編輯並發佈。';
        document.getElementById('wheelWrap').appendChild(empty);
        document.body.classList.remove('is-loading'); // no wheel to centre-scroll to, so just reveal now
        return;
      }
      if(!emotions.length){
        breadcrumb.textContent = '目前沒有情緒輪資料';
        hint.textContent = '請管理者到管理介面新增情緒與中層詞';
        document.body.classList.remove('is-loading'); // no wheel to centre-scroll to, so just reveal now
        return;
      }
      renderWheel();
      applyWheelState();   // 必須在 renderWheel() 之後：renderWheel 會重建扇區
      renderClouds();

      // .wheel-wrap carries a margin buffer (see its CSS) so overflowing bubbles have room to scroll
      // into view; that buffer leaves the wheel sitting off-center at the natural scrollLeft/Top of 0,
      // so centre the scroll position once the wheel has actually rendered. setTimeout (not immediate)
      // so it runs after this render pass's own layout settles. The loading mask is lifted in this same
      // callback so the scroll position is already correct the moment the page fades into view — never
      // a visible jump from off-centre to centred.
      // QA 報告第七輪：instant=true——這裡是初次載入，.stage 的 scroll-behavior:smooth 會讓這一次
      // 置中變成一段使用者看得到、耗時超過 1 秒的捲動動畫，違背上面這段註解本來就想達成的
      // 「never a visible jump」。使用者實測回報「開啟時沒有置中」，根因就是這個。
      setTimeout(() => {
        centerStageScroll(true);
        document.body.classList.remove('is-loading');
      }, 50);

      // 處方連結指向的輪不存在／已停用時才會被設起來。等畫面畫完再說，
      // 免得對話框搶在頁面還沒出現的時候彈出來。
      if(deepLinkFailed){
        setTimeout(() => {
          showAlertDialog('這個連結指向的情緒輪目前沒有開放，已經先帶你到預設的情緒輪。如果這不是你要的，再跟你的心理師確認一下連結。');
        }, 400);
      }
  }
}

loadData();
