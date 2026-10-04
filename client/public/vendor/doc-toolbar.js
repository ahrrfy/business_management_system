/**
 * doc-toolbar.js — شريط أدوات الطباعة وحفظ PDF للمستندات الرسمية A4
 *
 * مصمم ليعمل كملف خارجي ثابت من نفس الأصل ('self') ليتوافق 100% مع سياسة أمان المحتوى (CSP)
 * الصارمة في بيئة الإنتاج (Helmet CSP: script-src 'self' بدون 'unsafe-inline').
 *
 * يوفر تحكماً كاملاً للأزرار:
 *  1. طباعة المستند (window.print)
 *  2. حفظ كملف PDF عالي الدقة عبر html2pdf مع دعم File System Access API
 *  3. إغلاق المعاينة والتبويبة بسلاسة
 */
(function () {
  'use strict';

  function initDocToolbar() {
    var toolbar = document.querySelector('.doc-toolbar');
    if (!toolbar) return;

    var rawTitle = toolbar.getAttribute('data-title') || document.title || 'document';
    var safeTitle = rawTitle.replace(/[/\\?%*:|"<>]/g, '_').trim();
    var filename = safeTitle + '.pdf';

    var pageWidth = parseInt(toolbar.getAttribute('data-page-width') || '794', 10);
    var pageHeight = parseInt(toolbar.getAttribute('data-page-height') || '1123', 10);
    var landscape = toolbar.getAttribute('data-landscape') === 'true';
    var isMulti = toolbar.getAttribute('data-multi') === 'true';
    var autoPrint = toolbar.getAttribute('data-auto-print') === 'true';

    function printDoc() {
      window.focus();
      window.print();
    }
    window.printDoc = printDoc;

    function closeDocPreview() {
      try {
        if (window.opener && !window.opener.closed) {
          var targetOrigin = window.location.origin || '*';
          window.opener.postMessage({ type: 'CLOSE_PRINT_WINDOW' }, targetOrigin);
        }
      } catch (e) {}
      try {
        window.close();
      } catch (e) {}
      try {
        window.open('', '_self');
        window.close();
      } catch (e) {}
      setTimeout(function () {
        if (!window.closed) {
          var btn = document.getElementById('doc-btn-close');
          if (btn) {
            btn.innerHTML = '<span>إغلاق التبويبة (Ctrl+W)</span>';
            btn.style.background = '#DC2626';
            btn.style.color = '#fff';
          }
        }
      }, 250);
    }
    window.closeDocPreview = closeDocPreview;

    async function saveDocAsPdf() {
      var fileHandle = null;
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: filename,
            types: [{
              description: 'ملف PDF (*.pdf)',
              accept: { 'application/pdf': ['.pdf'] }
            }]
          });
        } catch (err) {
          if (err && err.name === 'AbortError') {
            return;
          }
          fileHandle = null;
        }
      }

      var saveBtn = document.getElementById('doc-btn-save-pdf');
      var origHtml = saveBtn ? saveBtn.innerHTML : '';
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.style.opacity = '0.75';
        saveBtn.style.cursor = 'wait';
        saveBtn.innerHTML = '<svg class="doc-spinner" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10"/></svg><span>جارٍ حفظ ملف PDF…</span>';
      }

      function resetBtn() {
        document.body.classList.remove('doc-exporting-pdf');
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.style.opacity = '1';
          saveBtn.style.cursor = 'pointer';
          saveBtn.innerHTML = origHtml;
        }
      }

      document.body.classList.add('doc-exporting-pdf');
      var target = isMulti
        ? (document.getElementById('doc-pages-container') || document.body)
        : (document.querySelector('.page') || document.body);

      var opt = {
        margin: 0,
        filename: filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          letterRendering: true,
          windowWidth: pageWidth,
          scrollY: 0,
          scrollX: 0
        },
        jsPDF: {
          unit: 'px',
          format: [pageWidth, pageHeight],
          hotfixes: ['px_scaling'],
          orientation: landscape ? 'landscape' : 'portrait'
        }
      };

      try {
        if (typeof window.html2pdf === 'function') {
          var worker = window.html2pdf().set(opt).from(target);
          if (fileHandle) {
            var pdfBlob = await worker.outputPdf('blob');
            var writable = await fileHandle.createWritable();
            await writable.write(pdfBlob);
            await writable.close();
            resetBtn();
          } else {
            await worker.save();
            resetBtn();
          }
        } else {
          resetBtn();
          window.print();
        }
      } catch (err) {
        console.error('[PDF Export] failed:', err);
        resetBtn();
        window.print();
      }
    }
    window.saveDocAsPdf = saveDocAsPdf;

    var printBtn = document.getElementById('doc-btn-print');
    if (printBtn && !printBtn.__bound) {
      printBtn.__bound = true;
      printBtn.addEventListener('click', printDoc);
    }

    var saveBtn = document.getElementById('doc-btn-save-pdf');
    if (saveBtn && !saveBtn.__bound) {
      saveBtn.__bound = true;
      saveBtn.addEventListener('click', saveDocAsPdf);
    }

    var closeBtn = document.getElementById('doc-btn-close');
    if (closeBtn && !closeBtn.__bound) {
      closeBtn.__bound = true;
      closeBtn.addEventListener('click', closeDocPreview);
    }

    if (autoPrint) {
      var images = Array.from(document.images).map(function (image) {
        return image.complete
          ? Promise.resolve()
          : new Promise(function (resolve) {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            });
      });
      var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      Promise.all([fonts].concat(images)).then(function () {
        window.setTimeout(function () {
          window.focus();
          window.print();
        }, 120);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDocToolbar);
  } else {
    initDocToolbar();
  }
})();
