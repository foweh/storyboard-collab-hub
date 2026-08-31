// ─── 通用图片预览（Lightbox）──────────────────────────
// 全局 API：
//   openImagePreview(src)  打开大图预览
//   closeImagePreview()    关闭预览
// 退出方式：右上角 ✕ 按钮 / 点击遮罩空白处 / 按 Esc
(function () {
  'use strict';

  let overlay = null;

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'img-preview-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.86);' +
      'display:none;align-items:center;justify-content:center;cursor:zoom-out;' +
      'animation:imgPreviewIn 0.18s ease-out;';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'img-preview-close';
    closeBtn.title = '关闭 (Esc)';
    closeBtn.innerHTML = '✕';
    closeBtn.style.cssText =
      'position:absolute;top:16px;right:20px;width:40px;height:40px;border-radius:50%;' +
      'border:2px solid rgba(255,255,255,0.35);background:rgba(20,20,40,0.8);color:#fff;' +
      'font-size:17px;cursor:pointer;z-index:2;display:flex;align-items:center;justify-content:center;' +
      'transition:0.15s;';

    const img = document.createElement('img');
    img.className = 'img-preview-img';
    img.alt = '图片预览';
    img.style.cssText =
      'max-width:90vw;max-height:86vh;border-radius:10px;box-shadow:0 12px 60px rgba(0,0,0,0.7);' +
      'object-fit:contain;cursor:default;background:#fff;';

    overlay.appendChild(img);
    overlay.appendChild(closeBtn);

    // 关闭按钮
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    closeBtn.addEventListener('mouseenter', () => {
      closeBtn.style.background = 'rgba(255,60,60,0.9)';
      closeBtn.style.borderColor = '#ff5252';
    });
    closeBtn.addEventListener('mouseleave', () => {
      closeBtn.style.background = 'rgba(20,20,40,0.8)';
      closeBtn.style.borderColor = 'rgba(255,255,255,0.35)';
    });

    // 点击遮罩（非图片区域）关闭
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    // Esc 关闭
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && overlay.style.display === 'flex') close();
    });

    document.body.appendChild(overlay);

    // 动画样式（一次性注入）
    if (!document.getElementById('img-preview-anim')) {
      const st = document.createElement('style');
      st.id = 'img-preview-anim';
      st.textContent = '@keyframes imgPreviewIn{from{opacity:0}to{opacity:1}}';
      document.head.appendChild(st);
    }
    return overlay;
  }

  function open(src) {
    if (!src) return;
    const ov = ensureOverlay();
    const img = ov.querySelector('.img-preview-img');
    img.onload = () => { img.style.display = ''; };
    img.onerror = () => { img.style.display = 'none'; };
    img.src = src;
    ov.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!overlay) return;
    overlay.style.display = 'none';
    const img = overlay.querySelector('.img-preview-img');
    if (img) { img.src = ''; }
    document.body.style.overflow = '';
  }

  window.openImagePreview = open;
  window.closeImagePreview = close;
})();
