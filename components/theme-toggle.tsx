"use client";

export function ThemeToggle() {
  function toggle() {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("nexus-theme", next);
    document.documentElement.dataset.theme = next;
  }
  return <button className="button button-ghost" onClick={toggle} aria-label="Toggle light and dark theme">◐</button>;
}
