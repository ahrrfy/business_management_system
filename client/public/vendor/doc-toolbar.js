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
    var isPayslip = toolbar.getAttribute('data-payslip') === 'true';
    var autoPrint = toolbar.getAttribute('data-auto-print') === 'true';

    var assetsReady;
    var assetsReadyDone = false;
    function waitForAssets() {
      if (!assetsReady) {
        var images = Array.from(document.images).map(function (image) {
          return image.complete ? Promise.resolve() : new Promise(function (resolve) {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
          });
        });
        var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
        var ready = Promise.all([fonts].concat(images));
        if (isPayslip) {
          assetsReady = new Promise(function (resolve, reject) {
            var timer = window.setTimeout(function () { reject(new Error('PAYSLIP_ASSET_TIMEOUT')); }, 10000);
            ready.then(function (value) {
              window.clearTimeout(timer);
              if (Array.from(document.images).some(function (image) { return image.naturalWidth === 0; })) {
                var warning = document.getElementById('payslip-image-warning');
                if (!warning) {
                  warning = document.createElement('span');
                  warning.id = 'payslip-image-warning';
                  warning.setAttribute('role', 'status');
                  warning.style.cssText = 'font-size:12px;font-weight:700;padding:0 10px';
                  toolbar.appendChild(warning);
                }
                warning.textContent = 'تعذّر تحميل شعار القسيمة؛ سيصدر المستند دون شعار.';
              }
              assetsReadyDone = true;
              resolve(value);
            }, function (err) { window.clearTimeout(timer); reject(err); });
          }).catch(function (err) { assetsReady = null; throw err; });
        } else {
          assetsReady = ready;
        }
      }
      return assetsReady;
    }

    function showPayslipError(message) {
      var error = document.getElementById('payslip-print-error');
      if (!error) {
        error = document.createElement('div');
        error.id = 'payslip-print-error';
        error.setAttribute('role', 'alert');
        error.style.cssText = 'background:#fff0ef;color:#9b1c1c;padding:8px 12px;font-size:12px;font-weight:700';
        toolbar.insertAdjacentElement('afterend', error);
      }
      error.textContent = message;
      error.hidden = false;
    }

    function payslipErrorMessage(err) {
      if (err && err.message === 'PAYSLIP_ASSET_TIMEOUT') {
        return 'تعذّر تحميل خط القسيمة أو صورتها. تحقق من الاتصال ثم أعد المحاولة.';
      }
      var employee = err && err.payslipEmployeeId ? ' للموظف #' + err.payslipEmployeeId : '';
      return 'تعذّر احتواء بيانات القسيمة' + employee + ' في صفحة واحدة بوضوح. راجع طول البيانات ثم أعد المحاولة.';
    }

    function fitPayslipPages() {
      var pages = Array.from(document.querySelectorAll('.page.payslip-page'));
      if (!pages.length) throw new Error('No payslip pages');
      pages.forEach(function (page) {
        var content = page.querySelector('.payslip-content');
        if (!content) throw new Error('Missing payslip content');
        var frame = page.querySelector('.payslip-frame');
        if (!frame) throw new Error('Missing payslip frame');
        function failPage(message) {
          var error = new Error(message);
          error.payslipEmployeeId = frame.getAttribute('data-employee-id');
          throw error;
        }
        frame.removeAttribute('data-fitted');
        content.style.transform = 'none';
        var pageBox = page.getBoundingClientRect();
        var contentBox = content.getBoundingClientRect();
        var inset = pageBox.width / 21; // 10 mm of a 210 mm A4 width.
        var width = Math.max(contentBox.width, content.scrollWidth);
        var height = Math.max(contentBox.height, content.scrollHeight);
        var scale = Math.min(1, (pageBox.width - 2 * inset - 2) / width, (pageBox.height - 2 * inset - 2) / height);
        if (!Number.isFinite(scale) || scale < 0.7) failPage('Payslip content cannot fit legibly');
        content.style.transform = 'scale(' + scale + ')';
        var frameBox = frame.getBoundingClientRect();
        var outside = [content].concat(Array.from(content.querySelectorAll('*'))).some(function (element) {
          var box = element.getBoundingClientRect();
          if (!box.width || !box.height) return false;
          return box.left < frameBox.left - 1 || box.right > frameBox.right + 1 ||
            box.top < frameBox.top - 1 || box.bottom > frameBox.bottom + 1;
        });
        if (outside) failPage('Payslip content exceeds the safe area');
        frame.setAttribute('data-fitted', 'true');
      });
      document.body.classList.remove('payslip-print-pending');
      var error = document.getElementById('payslip-print-error');
      if (error) error.hidden = true;
      return pages;
    }

    async function preparePayslips() {
      try {
        await waitForAssets();
        return fitPayslipPages();
      } catch (err) {
        console.error('[Payslip layout] failed:', err);
        showPayslipError(payslipErrorMessage(err));
        return null;
      }
    }

    async function printDoc() {
      if (isPayslip && !(await preparePayslips())) return;
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
          var pdfBlob;
          if (isPayslip) {
            var pages = await preparePayslips();
            if (!pages) { resetBtn(); return; }
            var pdf = null;
            var payslipOpt = Object.assign({}, opt, {
              html2canvas: Object.assign({}, opt.html2canvas, { letterRendering: false }),
              jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            });
            for (var i = 0; i < pages.length; i++) {
              var pageWorker = window.html2pdf().set(payslipOpt).from(pages[i]).toCanvas();
              var canvas = await pageWorker.get('canvas');
              if (!canvas || !canvas.width || !canvas.height) throw new Error('Empty payslip page');
              if (!pdf) {
                pdf = await pageWorker.toPdf().get('pdf');
                pdf.addPage('a4', 'portrait');
                while (pdf.getNumberOfPages() > 1) pdf.deletePage(1);
              } else {
                pdf.addPage('a4', 'portrait');
              }
              pdf.addImage(canvas.toDataURL('image/jpeg', 0.98), 'JPEG', 0, 0, 210, 296);
              canvas.width = 0;
              canvas.height = 0;
            }
            pdfBlob = pdf.output('blob');
          } else {
            var worker = window.html2pdf().set(opt).from(target);
            if (fileHandle) pdfBlob = await worker.outputPdf('blob');
            else await worker.save();
          }
          if (fileHandle) {
            var writable = await fileHandle.createWritable();
            await writable.write(pdfBlob);
            await writable.close();
          } else if (isPayslip) {
            pdf.save(filename);
          }
          resetBtn();
        } else {
          resetBtn();
          await printDoc();
        }
      } catch (err) {
        console.error('[PDF Export] failed:', err);
        resetBtn();
        if (isPayslip) showPayslipError('تعذّر حفظ ملف PDF. استخدم الطباعة واختر الحفظ بصيغة PDF.');
        else window.print();
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

    if (isPayslip) {
      void preparePayslips();
      window.addEventListener('beforeprint', function () {
        try {
          if (!assetsReadyDone) throw new Error('PAYSLIP_ASSET_TIMEOUT');
          fitPayslipPages();
          document.body.classList.remove('payslip-print-invalid');
        } catch (err) {
          console.error('[Payslip layout] failed:', err);
          document.body.classList.add('payslip-print-invalid');
          showPayslipError(payslipErrorMessage(err));
        }
      });
      window.addEventListener('afterprint', function () { document.body.classList.remove('payslip-print-invalid'); });
    }
    if (autoPrint) {
      var printWhenReady = function () {
        window.setTimeout(function () {
          void printDoc();
        }, 120);
      };
      if (isPayslip) printWhenReady();
      else waitForAssets().then(printWhenReady);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDocToolbar);
  } else {
    initDocToolbar();
  }
})();
