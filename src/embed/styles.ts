/**
 * Self-contained CSS, injected once per document so the embed needs no CSS loader or Tailwind.
 * Every rule is under `.fmp`; colors are custom properties a host can override
 * (`.fmp { --fmp-accent: hotpink }`).
 */
const CSS = `
.fmp{--fmp-bg:#16161d;--fmp-fg:#f2f2f5;--fmp-muted:#a0a0ad;--fmp-accent:#ff6a3d;--fmp-track:#3a3a46;
  --fmp-radius:10px;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;max-width:100%;
  padding:8px 12px;background:var(--fmp-bg);color:var(--fmp-fg);border-radius:var(--fmp-radius);
  font:14px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;min-width:0}
@media (prefers-color-scheme:light){.fmp:not([data-theme=dark]){--fmp-bg:#f4f4f7;--fmp-fg:#16161d;--fmp-muted:#5c5c68;--fmp-accent:#d6461a;--fmp-track:#cfcfd8}}
.fmp[data-theme=light]{--fmp-bg:#f4f4f7;--fmp-fg:#16161d;--fmp-muted:#5c5c68;--fmp-accent:#d6461a;--fmp-track:#cfcfd8}
.fmp *{box-sizing:border-box}
.fmp-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:0;
  border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer;transition:background-color .15s}
.fmp-btn:hover{background:color-mix(in srgb,var(--fmp-fg) 12%,transparent)}
.fmp-btn:disabled{opacity:.4;cursor:default;background:transparent}
.fmp-btn:focus-visible,.fmp-range:focus-visible{outline:2px solid var(--fmp-accent);outline-offset:2px}
.fmp-btn svg{width:20px;height:20px;fill:currentColor}
.fmp-play{width:40px;height:40px;background:var(--fmp-accent);color:#fff}
.fmp-play:hover{background:var(--fmp-accent);filter:brightness(1.1)}
.fmp-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}
.fmp-meta{display:flex;gap:6px;min-width:0;white-space:nowrap}
.fmp-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;min-width:0}
.fmp-artist{color:var(--fmp-muted);overflow:hidden;text-overflow:ellipsis;min-width:0}
.fmp-seekrow{display:flex;align-items:center;gap:8px;min-width:0}
.fmp-time{flex:none;font-variant-numeric:tabular-nums;font-size:12px;color:var(--fmp-muted)}
.fmp-range{flex:1 1 auto;min-width:0;height:20px;margin:0;accent-color:var(--fmp-accent);background:transparent;cursor:pointer}
.fmp-volume{flex:none;display:flex;align-items:center;gap:4px;width:110px}
.fmp-art{flex:none;width:48px;height:48px;border-radius:6px;object-fit:cover;background:var(--fmp-track)}
.fmp-error{color:var(--fmp-accent);font-size:12px}
.fmp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.fmp--card{flex-wrap:wrap;padding:12px}
.fmp--card .fmp-art{width:72px;height:72px}
.fmp--card .fmp-meta{flex-direction:column;gap:0;white-space:normal}
.fmp--card .fmp-main{flex-basis:calc(100% - 84px)}
.fmp--card .fmp-controls{display:flex;align-items:center;gap:4px;width:100%}
.fmp--card .fmp-volume{margin-left:auto}
.fmp-controls{display:contents}
@media (max-width:420px){.fmp-volume{display:none}.fmp{gap:6px;padding:6px 8px}.fmp-time{font-size:11px}}
@media (prefers-reduced-motion:reduce){.fmp *,.fmp{transition:none!important;animation:none!important}}
`;

const STYLE_ID = 'flac-mini-player-styles';

export function ensureMiniPlayerStyles(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
