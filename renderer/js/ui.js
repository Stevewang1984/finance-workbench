'use strict';
/* UI 通用工具 */
window.UI = (function () {
  const CUR_SYMBOL = { USD: '$', CNY: '¥', HKD: 'HK$' };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(v, cur) {
    if (v == null || !isFinite(v)) return '—';
    const sym = CUR_SYMBOL[cur] || cur || '';
    const abs = Math.abs(v);
    let s;
    if (abs >= 1e8) s = (v / 1e8).toFixed(2) + '亿';
    else if (abs >= 1e4) s = (v / 1e4).toFixed(2) + '万';
    else s = v.toFixed(2);
    return `${sym}${s}`;
  }

  function num(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + Number(v).toFixed(d == null ? 2 : d);
  }

  function pct(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function cls(v) {
    if (v == null || !isFinite(v) || v === 0) return 'flat';
    return v > 0 ? 'up' : 'down';
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = 'none'), ms || 2200);
  }

  function showModal(html) {
    const box = document.getElementById('modalBox');
    box.innerHTML = html;
    document.getElementById('modalMask').style.display = 'grid';
  }
  function closeModal() {
    document.getElementById('modalMask').style.display = 'none';
    document.getElementById('modalBox').innerHTML = '';
  }

  // 点击遮罩关闭
  document.getElementById('modalMask').addEventListener('click', (e) => {
    if (e.target.id === 'modalMask') closeModal();
  });

  function confirmBox(title, message) {
    return new Promise((resolve) => {
      showModal(`
        <h3>${esc(title)}</h3>
        <p class="sub" style="line-height:1.6">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn" id="cfNo">取消</button>
          <button class="btn btn-danger" id="cfYes">确认</button>
        </div>`);
      document.getElementById('cfNo').onclick = () => { closeModal(); resolve(false); };
      document.getElementById('cfYes').onclick = () => { closeModal(); resolve(true); };
    });
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    if (children) for (const c of [].concat(children)) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }

  return { esc, money, num, pct, cls, toast, showModal, closeModal, confirmBox, el, CUR_SYMBOL };
})();
