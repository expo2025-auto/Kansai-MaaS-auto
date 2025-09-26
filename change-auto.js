// ==UserScript==
// @name         Kansai-MaaS 予約時間変更オート（前/後
// @namespace    https://example.com/na
// @version      1.0
// @description  関西MaaSの予約時間を前後にずらす
// @match        https://app.kansai-maas.jp/ticket-managements*
// @run-at       document-idle
// @grant        none
// @updateURL    https://github.com/expo2025-auto/Kansai-MaaS-auto/raw/refs/heads/main/change-auto.js
// @downloadURL  https://github.com/expo2025-auto/Kansai-MaaS-auto/raw/refs/heads/main/change-auto.js
// @homepageURL  https://github.com/expo2025-auto/Kansai-MaaS-auto
// @supportURL   https://github.com/expo2025-auto/Kansai-MaaS-auto/issues
// ==/UserScript==

(function () {
  'use strict';

  /********** 定数 **********/
  const STATE_KEY = 'km_auto_rescheduler_state_v1';
  const RESTART_FLAG_KEY = 'km_auto_rescheduler_restart_flag_v1';
  const MAIN_URL = `${location.origin}/ticket-managements?tab=in_use`; // 強制復帰先
  const RESTART_FLAG_TTL_MS = 60_000; // 再開フラグの寿命（保険）

  /********** 状態 **********/
  const defaultState = {
    running: false,
    direction: 'earlier',        // 'earlier' or 'later'
    baseHour: 10,                // 現在の予約時刻（時）/ 負数（例:-19）はセンチネル
    phase: 'search',             // 'search' | 'finalize'
    laterAllowedHours: [20,21],  // 後ろにずらす時に対象とする時刻（20/21）
    lastReloadAt: 0,
    minReloadIntervalMs: 7000
  };
  let state = loadState();
  function loadState() {
    try { return Object.assign({}, defaultState, JSON.parse(localStorage.getItem(STATE_KEY) || '{}')); }
    catch { return { ...defaultState }; }
  }
  function saveState(){ localStorage.setItem(STATE_KEY, JSON.stringify(state)); }

  /********** 汎用 **********/
  const rand = (a,b)=>Math.random()*(b-a)+a;
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  const isVisible = (el)=>{ const r = el?.getBoundingClientRect?.(); return !!(r && r.width>0 && r.height>0); };
  const isDisabledLike = (el)=> el?.hasAttribute('disabled')
      || el?.getAttribute('aria-disabled') === 'true'
      || /\bMui-disabled\b/.test(el?.className||'');
  async function clickWithHumanDelay(el){ try{ el?.scrollIntoView({block:'center'});}catch{} await sleep(rand(500,1000)); el?.click(); }
  async function waitForReady(){ if (document.readyState === 'complete') return; await new Promise(res=>window.addEventListener('load',res,{once:true})); }
  function waitForElement(selector, timeout=10000, mustBeVisible=true){
    return new Promise((resolve,reject)=>{
      const t0 = performance.now();
      const iv = setInterval(()=>{
        const el = document.querySelector(selector);
        if (el && (!mustBeVisible || isVisible(el))) { clearInterval(iv); clearTimeout(to); resolve(el); }
        else if (performance.now()-t0 > timeout){ clearInterval(iv); clearTimeout(to); reject(new Error('Timeout '+selector)); }
      },120);
      const to = setTimeout(()=>{ clearInterval(iv); reject(new Error('Timeout '+selector)); },timeout+120);
    });
  }
  function queryButtonByText(text){ return Array.from(document.querySelectorAll('button,[role="button"]')).filter(isVisible).find(b => (b.innerText||'').trim() === text) || null; }

  async function clickButtonByIdOrText({idSelector, text, timeout=10000}){
    const t0 = performance.now();
    let el = null;
    while (performance.now()-t0 < timeout){
      if (await handleIfErrorDialog()) throw new Error('InterruptedByErrorDialog');
      el = document.querySelector(idSelector) || queryButtonByText(text);
      if (el && isVisible(el) && !isDisabledLike(el)) break;
      await sleep(120);
    }
    if (!el) throw new Error('ButtonNotFound '+text);
    await clickWithHumanDelay(el);
    return true;
  }

  function safeReload(){
    const now = Date.now();
    if (now - state.lastReloadAt < state.minReloadIntervalMs) return;
    state.lastReloadAt = now; saveState(); location.reload();
  }
  function reloadNow(){
    state.lastReloadAt = 0; saveState();
    location.reload();
  }

  /********** 再開フラグ **********/
  function setRestartFlag() {
    const payload = { resume: state.running, ts: Date.now() };
    sessionStorage.setItem(RESTART_FLAG_KEY, JSON.stringify(payload));
  }
  function consumeRestartFlag(){
    try {
      const raw = sessionStorage.getItem(RESTART_FLAG_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      sessionStorage.removeItem(RESTART_FLAG_KEY);
      if (!obj || typeof obj.ts !== 'number') return null;
      if (Date.now() - obj.ts > RESTART_FLAG_TTL_MS) return null;
      return obj;
    } catch { return null; }
  }
  function clearRestartFlag(){ sessionStorage.removeItem(RESTART_FLAG_KEY); }

  /********** 左下UI **********/
  function createPanel(){
    const root = document.createElement('div');
    root.id='km-auto-panel';
    Object.assign(root.style,{
      position:'fixed',left:'12px',bottom:'12px',zIndex:'999999',
      background:'rgba(0,0,0,0.75)',color:'#fff',padding:'10px 12px',
      borderRadius:'10px',fontSize:'12px',lineHeight:'1.4',maxWidth:'260px',
      backdropFilter:'blur(3px)',boxShadow:'0 6px 18px rgba(0,0,0,0.3)'
    });
    root.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">予約時間変更オート</div>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input id="km-run-toggle" type="checkbox" ${state.running?'checked':''}><span>スクリプト実行</span>
      </label>
      <div style="margin-top:8px;">ずらす方向</div>
      <div style="display:flex;gap:8px;margin-top:4px;">
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
          <input id="km-dir-earlier" type="checkbox" ${state.direction==='earlier'?'checked':''}><span>前にずらす</span>
        </label>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
          <input id="km-dir-later" type="checkbox" ${state.direction==='later'?'checked':''}><span>後ろにずらす</span>
        </label>
      </div>
      <div id="km-time-list" style="margin-top:8px;"></div>
      <div id="km-status" style="margin-top:8px;opacity:0.9;">状態: <span id="km-status-text">待機</span> <span id="km-phase" style="margin-left:6px;opacity:0.8;"></span></div>
    `;
    document.body.appendChild(root);

    const chE = root.querySelector('#km-dir-earlier');
    const chL = root.querySelector('#km-dir-later');
    const run = root.querySelector('#km-run-toggle');

    function renderTimes(){
      const times = state.direction==='earlier'?[9,10,11,12]:[19,20,21,22]; // -19 センチネル設計は別途
      const box = root.querySelector('#km-time-list');
      box.innerHTML = `
        <div>現在の予約時刻</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
          ${times.map(h=>`
            <label style="display:flex;align-items:center;gap:4px;background:rgba(255,255,255,0.08);padding:4px 6px;border-radius:6px;cursor:pointer;">
              <input type="radio" name="km-base-hour" value="${h}" ${Number(state.baseHour)===h?'checked':''}>
              <span>${h}時</span>
            </label>
          `).join('')}
        </div>

        ${state.direction==='later' ? `
        <div style="margin-top:10px;">対象時刻（後ろにずらす時）</div>
        <div style="display:flex;gap:10px;margin-top:4px;">
          ${[20,21].map(h=>`
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input type="checkbox" class="km-later-hour" value="${h}" ${Array.isArray(state.laterAllowedHours)&&state.laterAllowedHours.includes(h)?'checked':''}>
              <span>${h}時台</span>
            </label>
          `).join('')}
        </div>` : '' }
      `;
      // 基準時刻
      box.querySelectorAll('input[name="km-base-hour"]').forEach(r=>{
        r.addEventListener('change',()=>{ state.baseHour = Number(r.value); saveState(); });
      });
      // 後ろ対象時刻
      box.querySelectorAll('.km-later-hour').forEach(ch=>{
        ch.addEventListener('change',()=>{
          const checks = Array.from(box.querySelectorAll('.km-later-hour'))
            .filter(el=>el.checked).map(el=>Number(el.value));
          state.laterAllowedHours = checks; // 空なら全時刻許容（後段で処理）
          saveState();
        });
      });
    }

    function syncUI(){
      document.querySelector('#km-status-text').textContent = state.running ? '実行中' : '待機';
      setPhaseBadge();
      chE.checked = state.direction==='earlier';
      chL.checked = state.direction==='later';
      renderTimes();
    }

    renderTimes();
    syncUI();

    chE.addEventListener('change',()=>{
      if (chE.checked){ chL.checked=false; state.direction='earlier'; }
      else if(!chL.checked){ chL.checked=true; state.direction='later'; }
      saveState(); renderTimes();
    });
    chL.addEventListener('change',()=>{
      if (chL.checked){ chE.checked=false; state.direction='later'; }
      else if(!chE.checked){ chE.checked=true; state.direction='earlier'; }
      saveState(); renderTimes();
    });
    run.addEventListener('change',()=>{
      if (run.checked){
        state.running = true; state.phase='search'; saveState();
        syncUI();
        kickMainLoop();
      } else {
        // 実行OFF: 設定と再開フラグの完全初期化
        clearRestartFlag();
        state = {...defaultState, running:false};
        saveState();
        syncUI();
      }
    });
  }
  function setStatus(msg){ const el = document.querySelector('#km-status-text'); if (el) el.textContent = msg; }
  function setPhaseBadge(){ const el = document.querySelector('#km-phase'); if (!el) return; el.textContent = state.phase==='finalize' ? '（探索停止中→確定処理）' : '（探索中）'; }

  /********** ドロップダウン開閉 **********/
  async function openSelectMenu(selectDiv){
    if (await handleIfErrorDialog()) return false;
    if (selectDiv.getAttribute('aria-expanded') === 'true') return true;
    selectDiv.focus();
    await clickWithHumanDelay(selectDiv);
    await sleep(150);
    if (selectDiv.getAttribute('aria-expanded') === 'true') return true;

    selectDiv.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));
    selectDiv.dispatchEvent(new KeyboardEvent('keyup',{key:' ',code:'Space',bubbles:true}));
    await sleep(120);
    if (selectDiv.getAttribute('aria-expanded') === 'true') return true;

    selectDiv.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));
    selectDiv.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowDown',code:'ArrowDown',bubbles:true}));
    await sleep(120);
    if (selectDiv.getAttribute('aria-expanded') === 'true') return true;

    const icon = selectDiv.parentElement?.querySelector('.MuiSelect-icon, .MuiSelect-iconOutlined, svg[data-testid="ArrowDropDownIcon"]');
    if (icon) { await clickWithHumanDelay(icon); await sleep(150); }
    if (selectDiv.getAttribute('aria-expanded') === 'true') return true;

    ['pointerdown','mousedown','mouseup','click'].forEach(type=>{
      selectDiv.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,view:window}));
    });
    await sleep(150);
    return selectDiv.getAttribute('aria-expanded') === 'true';
  }
  async function waitForMenuListbox(timeout=8000){
    const t0 = performance.now();
    while (performance.now()-t0 < timeout){
      if (await handleIfErrorDialog()) throw new Error('InterruptedByErrorDialog');
      const list = Array.from(document.querySelectorAll('[role="listbox"], ul.MuiMenu-list')).find(isVisible);
      if (list) return list;
      await sleep(120);
    }
    throw new Error('Timeout waiting listbox');
  }

  /********** エラーダイアログ：検出＆処理（強制復帰付き） **********/
  function getErrorDialog(){
    const dlgs = Array.from(document.querySelectorAll('[role="dialog"], .MuiDialog-paper')).filter(isVisible);
    for (const d of dlgs){
      const text = (d.innerText || d.textContent || '').trim();
      if (text.includes('エラーが発生しました') || text.includes('ご指定の条件へは変更できません')) {
        const closeBtn = d.querySelector('#\\:r4\\:') ||
          Array.from(d.querySelectorAll('button')).find(b=>/閉じる/.test((b.innerText||'').trim()));
        return { dialog: d, closeBtn };
      }
    }
    return null;
  }

  async function handleIfErrorDialog(){
    const info = getErrorDialog();
    if (!info) return false;

    setStatus('エラー→閉じる→戻る→復帰URLへ遷移→再探索');
    if (info.closeBtn) await clickWithHumanDelay(info.closeBtn);

    // ダイアログ消滅待ち
    for (let i=0;i<30;i++){
      if (!getErrorDialog()) break;
      await sleep(100);
    }
    await sleep(200);

    // 再開フラグを立ててから、戻る→強制遷移（SPA対策）
    setRestartFlag();                 // ← リロード後に running/phase=search で再開する合図
    try { history.back(); } catch {}
    await sleep(500);

    // URLが異なる/戻れない等に備え、確実に一覧タブへ
    location.replace(MAIN_URL);
    // 以後の処理はページ遷移で途切れる前提
    return true;
  }

  /********** 時刻パース（全角OK） **********/
  function toHalfWidthDigits(s){ return s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0)-0xFEE0)); }
  function parseHourFromText(t){
    if (!t) return null;
    const s = toHalfWidthDigits(t).replace(/\s/g,'');
    const m = s.match(/(\d{1,2})(?::\d{2})?時台?|(\d{1,2})時台/);
    if (m){
      const num = Number(m[1] || m[2]);
      if (Number.isInteger(num) && num>=0 && num<=23) return num;
    }
    return null;
  }
  function listTimeOptions(menuRoot){
    const items = Array.from(menuRoot.querySelectorAll('[role="option"], li, [data-value]'));
    const results = [];
    for (const el of items){
      const text = (el.innerText || el.textContent || '').trim();
      if (!text || text.includes('種別を選択してください')) continue;
      const disabled = el.getAttribute('aria-disabled')==='true'
                    || el.hasAttribute('disabled')
                    || /\bMui-disabled\b/.test(el.className)
                    || /line-through/.test(el.className);
      const hour = parseHourFromText(text);
      const isWheel = /車いす/.test(text); // 車いすは除外
      results.push({ el, text, hour, disabled, isWheel });
    }
    return results;
  }

  /********** ステップ群 **********/
  async function step_search(){
    setStatus('探索'); setPhaseBadge();

    // 1) セレクト本体
    let selectDiv = null;
    try { selectDiv = await waitForElement('#mui-component-select-stockId', 8000, true); }
    catch { selectDiv = Array.from(document.querySelectorAll('[id^="mui-component-select-"]')).find(isVisible) || null; }
    if (!selectDiv){ await sleep(800); safeReload(); await sleep(2500); return; }

    // 1') 開く
    const opened = await openSelectMenu(selectDiv);
    if (!opened){ await sleep(400); safeReload(); await sleep(2500); return; }

    // 2) メニュー取得
    let menuRoot = null;
    try { menuRoot = await waitForMenuListbox(6000); }
    catch { await sleep(400); document.body.click(); await sleep(200); safeReload(); await sleep(2500); return; }

    // 2') オプション抽出（車いす/無効/基準除外）
    const opts = listTimeOptions(menuRoot)
      .filter(o => o.hour !== null && !o.disabled && !o.isWheel);

    const base = Number(state.baseHour);
    const pre19 = base < 0; // -19 等のセンチネル
    const allowedLater = Array.isArray(state.laterAllowedHours)
      ? state.laterAllowedHours.map(Number)
      : [];

    let candidates = opts.filter(o => o.hour !== base);

    // 後ろにずらす時の時刻制限
    if (state.direction === 'later'){
      // -19 のときは 20時以上だけ
      if (pre19) candidates = candidates.filter(o => o.hour >= 20);
      // 20/21の個別指定（チェックが1つ以上あれば適用）
      if (allowedLater.length > 0) {
        candidates = candidates.filter(o => allowedLater.includes(o.hour));
      }
    }

    if (state.direction === 'earlier'){
      // 前＝最も早い（min）
      candidates = candidates
        .filter(o => o.hour < base)
        .sort((a,b)=> a.hour - b.hour);
    } else {
      // 後＝最も遅い（max）
      candidates = candidates
        .filter(o => o.hour > base)
        .sort((a,b)=> b.hour - a.hour);
    }

    if (!candidates.length){
      document.body.click(); // メニュー閉じ
      const waitMs = Math.round(rand(1000, 5000)); // 1〜5秒
      setStatus(`空きなし→${Math.ceil(waitMs/1000)}秒待って更新`);
      await sleep(waitMs);
      location.reload(); // 即リロード
      return;
    }

    // 2.2) 候補クリック
    const target = candidates[0];
    await clickWithHumanDelay(target.el);

    // メニューが閉じるのを待つ
    await sleep(150);
    for (let i=0;i<20;i++){
      const anyList = Array.from(document.querySelectorAll('[role="listbox"], ul.MuiMenu-list')).find(isVisible);
      if (!anyList) break;
      await sleep(80);
    }

    // 3) 「変更内容を確認する」→ 押下したら finalize へ
    try {
      await clickButtonByIdOrText({
        idSelector: '#\\:r3\\:',
        text: '変更内容を確認する',
        timeout: 12000
      });
      state.phase = 'finalize'; saveState(); setPhaseBadge();
      setStatus('確認画面へ→探索停止');
    } catch (e){
      if (!String(e.message).includes('InterruptedByErrorDialog')){
        await sleep(400); safeReload(); await sleep(2500);
      }
    }
  }

  async function step_finalize(){
    setStatus('確定処理中'); setPhaseBadge();

    // 4) 「この内容で変更する」
    try {
      await clickButtonByIdOrText({
        idSelector: '#\\:R3bafnnnniv5cja\\:',
        text: 'この内容で変更する',
        timeout: 15000
      });
    } catch (e){
      if (String(e.message).includes('InterruptedByErrorDialog')) return;
      // 見つからなくても後段で判定
    }

    // 5) 成功 or 失敗判定
    try{
      await Promise.race([
        waitForTextContains('【未確定】変更申込手続き終了', 15000),
        (async ()=>{
          const t0 = performance.now();
          while (performance.now()-t0 < 15000){
            if (await handleIfErrorDialog()) throw new Error('ChangeFailedAndRecovered');
            await sleep(200);
          }
          throw new Error('Timeout success/error');
        })()
      ]);
      // 成功
      setStatus('完了→停止');
      state.running = false; saveState();
      alert('【未確定】変更申込手続き終了 が表示されました。スクリプトを停止します。');
    }catch(e){
      if (String(e.message).includes('ChangeFailedAndRecovered')){
        // 既に handleIfErrorDialog 内で復帰遷移済み
        return;
      }
      // 判定つかず → 探索に戻す
      state.phase = 'search'; saveState(); setPhaseBadge();
      await sleep(400); safeReload(); await sleep(2500);
    }
  }

  function waitForTextContains(text, timeout=10000){
    return new Promise((resolve,reject)=>{
      const t0 = performance.now();
      (function loop(){
        if ((document.body.innerText||'').includes(text)) return resolve(true);
        if (performance.now()-t0 > timeout) return reject(new Error('Timeout waiting text '+text));
        setTimeout(loop,150);
      })();
    });
  }

  /********** メインループ **********/
  let mainLoopRunning = false;
  async function kickMainLoop(){
    if (mainLoopRunning) return;
    mainLoopRunning = true;
    try{
      await waitForReady();

      while(state.running){
        if (await handleIfErrorDialog()) continue;
        if (state.phase === 'search') await step_search();
        else await step_finalize();
        await sleep(200);
      }
    }finally{
      mainLoopRunning = false;
    }
  }

  /********** 起動：エラー復帰の自動再開 **********/
  function maybeResumeAfterError(){
    const flag = consumeRestartFlag();
    if (!flag) return;
    // 直前まで動いていたなら自動再開
    if (flag.resume){
      state.running = true;
      state.phase = 'search';
      saveState();
      // UIが出るのを待ってからでも良いが、そのまま実行
      kickMainLoop();
    }
  }

  createPanel();
  // 再開フラグがあれば最優先で再開
  maybeResumeAfterError();

  if (state.running) kickMainLoop();
})();
