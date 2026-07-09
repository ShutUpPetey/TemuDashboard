import { useEffect, useState } from "react";

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

const LAYOUT_KEY = "temu-layout"; // "auto" | "desktop" | "mobile"

/* Which shell to render. Auto = phone-width viewports get the gallery
   shell, everything else the command-center shell. The override (set in
   Settings) lets you force either — e.g. the card grid on a big monitor. */
export function useLayoutMode() {
  const [override, setOverride] = useState(() => localStorage.getItem(LAYOUT_KEY) || "auto");
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const setLayoutOverride = (v) => {
    setOverride(v);
    localStorage.setItem(LAYOUT_KEY, v);
  };
  const mode = override === "auto" ? (isNarrow ? "mobile" : "desktop") : override;
  return { mode, override, setLayoutOverride };
}

export function useWindowWidth() {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return w;
}
