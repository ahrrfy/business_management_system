/**
 * حارس عام لحقول التاريخ والوقت في شاشات النظام:
 * يضمن تعيين lang="en-GB" و dir="ltr" على كل input[type=date/time/datetime-local/month]
 * لمنع محرك Chromium من عكس نص placeholder إلى «ةنس/رهش/موي» أو إظهار الأرقام الهندية.
 */
export function installDateTimeInputLocaleGuard() {
  if (typeof document === "undefined") return;

  const enforce = (node: Node) => {
    if (node instanceof HTMLInputElement) {
      const type = node.type;
      if (
        type === "date" ||
        type === "time" ||
        type === "datetime-local" ||
        type === "month"
      ) {
        if (!node.getAttribute("lang")) node.setAttribute("lang", "en-GB");
        if (!node.getAttribute("dir")) node.setAttribute("dir", "ltr");
      }
    } else if (node instanceof HTMLElement) {
      const inputs = node.querySelectorAll<HTMLInputElement>(
        'input[type="date"], input[type="time"], input[type="datetime-local"], input[type="month"]',
      );
      inputs.forEach((input) => {
        if (!input.getAttribute("lang")) input.setAttribute("lang", "en-GB");
        if (!input.getAttribute("dir")) input.setAttribute("dir", "ltr");
      });
    }
  };

  enforce(document.documentElement);

  const observer = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const added = mutations[i].addedNodes;
      for (let j = 0; j < added.length; j++) {
        enforce(added[j]);
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}
