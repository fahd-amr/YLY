(function () {
  "use strict";

  function initializeLayout() {
    const sidebar = document.getElementById("app-sidebar");
    const toggle = document.getElementById("menu-toggle");
    const closeButton = document.getElementById("sidebar-close");
    const backdrop = document.getElementById("sidebar-backdrop");
    const main = document.getElementById("main-content");
    if (!sidebar || !toggle || !closeButton || !backdrop || !main) return;

    const mobile = window.matchMedia("(max-width: 768px)");
    let opened = false;

    function render() {
      const expanded = mobile.matches && opened;
      sidebar.classList.toggle("sidebar-active", expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", expanded ? "Close navigation" : "Open navigation");
      sidebar.inert = mobile.matches && !expanded;
      if (sidebar.inert) sidebar.setAttribute("aria-hidden", "true");
      else sidebar.removeAttribute("aria-hidden");
      main.inert = expanded;
      backdrop.hidden = !expanded;
      document.body.classList.toggle("sidebar-open", expanded);
    }

    function closeSidebar(restoreFocus = true) {
      const wasOpened = opened;
      opened = false;
      render();
      if (wasOpened && restoreFocus && mobile.matches) {
        // Pointer activation does not focus buttons in every browser.
        toggle.focus();
      }
    }

    toggle.addEventListener("click", () => {
      if (!mobile.matches) return;
      if (opened) {
        closeSidebar();
        return;
      }
      opened = true;
      render();
      closeButton.focus();
    });
    closeButton.addEventListener("click", () => closeSidebar());
    backdrop.addEventListener("click", () => closeSidebar());
    sidebar.addEventListener("click", (event) => {
      if (event.target.closest("a[href]")) closeSidebar();
    });

    document.addEventListener("keydown", (event) => {
      if (!mobile.matches || !opened) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSidebar();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(sidebar.querySelectorAll("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])"))
        .filter((element) => !element.hidden && !element.inert);
      const first = focusable[0] || closeButton;
      const last = focusable[focusable.length - 1] || closeButton;
      const outside = !sidebar.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    });

    function resetForViewport() {
      const focused = document.activeElement;
      const focusInSidebar = sidebar.contains(focused);
      closeSidebar(false);
      if (mobile.matches && focusInSidebar) toggle.focus();
      else if (!mobile.matches && (focused === toggle || focused === closeButton)) {
        const currentLink = sidebar.querySelector("a[aria-current]") || sidebar.querySelector("a[href]");
        if (currentLink) currentLink.focus();
      }
    }

    if (typeof mobile.addEventListener === "function") mobile.addEventListener("change", resetForViewport);
    else mobile.addListener(resetForViewport);
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeLayout, { once: true });
  } else {
    initializeLayout();
  }
})();
