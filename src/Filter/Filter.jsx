import React, { useEffect, useMemo, useRef, useState } from "react";
import "./Filter.css";

// Align with DataLoader: use backend base on dev (port 3000)
const API = (typeof window !== 'undefined' && window.location && window.location.port === '3000')
  ? 'http://localhost:8000'
  : '';
// CRA injects PUBLIC_URL at build time; use as an additional hint
// eslint-disable-next-line no-undef
const PUBLIC_URL = (typeof process !== 'undefined' && process.env && process.env.PUBLIC_URL) ? process.env.PUBLIC_URL : '';

// Build a safe JS identifier alias from a column name
function baseNameOf(name) {
  const s = String(name || "");
  const i = s.indexOf("(");
  const base = (i >= 0 ? s.slice(0, i) : s).trim();
  return base.length ? base : s.trim();
}

function aliasOf(name) {
  const base = baseNameOf(name).toLowerCase();
  const a = base.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/__+/g, "_");
  return a || "col";
}

// Guard: only allow safe characters/operators
function isExpressionSafe(expr) {
  // eslint-disable-next-line no-useless-escape
  return /^[\s\w\d_"'().,!<>=&|+\-/*%\[\]]+$/.test(expr);
}

// Infer basic stats for hinting
function parseDescriptorFromName(name) {
  const s = String(name || "");
  const m = s.match(/\((.*)\)\s*$/);
  if (!m) return { base: baseNameOf(s), choices: null, unit: null, desc: null };
  const inside = m[1].trim();
  // Try parse comma-separated label:value
  const parts = inside.split(/\s*,\s*/);
  const choices = [];
  let choiceLike = true;
  for (const p of parts) {
    const mm = p.match(/^(.*?):\s*(.*)$/);
    if (mm) {
      const label = mm[1].trim();
      let valRaw = mm[2].trim();
      const num = Number(valRaw);
      const value = Number.isFinite(num) ? num : valRaw.replace(/^['"]|['"]$/g, "");
      choices.push({ label, value });
    } else {
      choiceLike = false;
      break;
    }
  }
  if (choiceLike && choices.length) return { base: baseNameOf(s), choices, unit: null, desc: inside };
  // Otherwise treat as unit text
  return { base: baseNameOf(s), choices: null, unit: inside, desc: inside };
}

function buildMetaFromFirstRow(rawObj) {
  const list = [];
  const aliasCount = {};
  for (const [rawName, v] of Object.entries(rawObj || {})) {
    const desc = parseDescriptorFromName(rawName);
    let al = aliasOf(rawName);
    aliasCount[al] = (aliasCount[al] || 0) + 1;
    if (aliasCount[al] > 1) al = `${al}_${aliasCount[al]}`;
    const num = Number(v);
    list.push({
      rawName,
      baseName: desc.base,
      alias: al,
      isNumeric: Number.isFinite(num),
      // We only peek the first row, so no min/max; keep undefined
      min: undefined,
      max: undefined,
      examples: [v],
      choices: desc.choices,
      unit: desc.unit,
      description: desc.desc,
    });
  }
  const aliasIndex = {};
  for (const m of list) aliasIndex[m.alias] = m;
  return { list, aliasIndex };
}

function parseChoicesFromDescription(desc) {
  if (!desc) return null;
  const parts = String(desc).split(/\s*,\s*/);
  const choices = [];
  for (const p of parts) {
    const m = p.match(/^(.*?):\s*(.*)$/);
    if (!m) return null;
    const label = m[1].trim();
    const valRaw = m[2].trim();
    const n = Number(valRaw);
    const value = Number.isFinite(n) ? n : valRaw.replace(/^['"]|['"]$/g, "");
    choices.push({ label, value });
  }
  return choices.length ? choices : null;
}

function buildMetaFromSchema(schemaList) {
  const list = [];
  const aliasCount = {};
  for (const s of schemaList || []) {
    const name = s.name || s.rawName || '';
    const rawName = s.rawName || s.name || '';
    let al = aliasOf(name || rawName);
    aliasCount[al] = (aliasCount[al] || 0) + 1;
    if (aliasCount[al] > 1) al = `${al}_${aliasCount[al]}`;
    const choices = parseChoicesFromDescription(s.description || '');
    list.push({
      rawName,
      baseName: baseNameOf(name || rawName),
      alias: al,
      isNumeric: String(s.type || '').toLowerCase() === 'numeric',
      min: undefined,
      max: undefined,
      examples: [],
      choices,
      unit: null,
      description: s.description || '',
    });
  }
  const aliasIndex = {};
  for (const m of list) aliasIndex[m.alias] = m;
  return { list, aliasIndex };
}

export default function Filter({ setFilteredIds = () => {} }) {
  const [expr, setExpr] = useState("");
  const [error, setError] = useState("");
  const [count, setCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [rawRows, setRawRows] = useState(null);
  const [metaList, setMetaList] = useState([]);
  const [aliasIndex, setAliasIndex] = useState({});
  const [loadingMeta, setLoadingMeta] = useState(false);
  const inputRef = useRef(null);
  const [showPopover, setShowPopover] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Load raw.json lazily when first needed
  const ensureMeta = useRef(null);
  ensureMeta.current = async () => {
    if (loadingMeta || metaList.length > 0) return;
    let finalized = false;
    const done = () => { if (!finalized) { setLoadingMeta(false); finalized = true; } };
    try {
      setLoadingMeta(true);
      const ts = Date.now();
      // Align with DataLoader: prefer backend static path first
      const tries = [
        `${API}/public/raw.json?ts=${ts}`,        // FastAPI static (works in dev with API base)
        `/public/raw.json?ts=${ts}`,              // same-origin public
        `/raw.json?ts=${ts}`,                     // CRA maps public/raw.json to root
        `${PUBLIC_URL}/raw.json?ts=${ts}`,        // CRA public base (if defined)
      ];
      let data = null;
      for (const url of tries) {
        try {
          // Surface to devtools which URL we are trying
          // eslint-disable-next-line no-console
          console.debug('Filter: fetch', url);
          const r = await fetch(url, { cache: 'no-store' });
          if (!r.ok) continue;
          // Read as text first to handle non-strict JSON (NaN/Infinity)
          const txt = await r.text();
          try {
            data = JSON.parse(txt);
          } catch (e) {
            // Tolerate NaN/Infinity emitted by some generators; replace with null
            const sanitized = txt
              .replace(/\bNaN\b/g, 'null')
              .replace(/\bInfinity\b/g, 'null')
              .replace(/\b-Infinity\b/g, 'null');
            try { data = JSON.parse(sanitized); }
            catch (e2) {
              // eslint-disable-next-line no-console
              console.warn('Filter: sanitized parse failed', e2);
              data = null;
            }
          }
          if (data) break;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Filter: fetch error', e);
        }
      }
      if (!data) { done(); return; }
      const arr = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);
      setRawRows(arr);
      const first = arr[0] || {};
      if (first && first.schema) {
        const { list, aliasIndex } = buildMetaFromSchema(first.schema);
        setMetaList(list.sort((a,b)=>a.baseName.localeCompare(b.baseName)));
        setAliasIndex(aliasIndex);
        done();
        return;
      }
      const firstRaw = first.raw || first.RAW || first.Raw || first; // tolerate bare raw object
      const { list, aliasIndex } = buildMetaFromFirstRow(firstRaw || {});
      setMetaList(list.sort((a,b)=>a.baseName.localeCompare(b.baseName)));
      setAliasIndex(aliasIndex);
      // eslint-disable-next-line no-console
      console.debug('Filter: meta loaded', list.length, 'columns');
      done();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('Filter: meta load failed', e);
      done();
    }
  };

  // Try preloading on mount so the first focus is faster (if it fails, it will retry on focus)
  useEffect(() => { ensureMeta.current(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const columns = useMemo(() => metaList.map((m)=>m.rawName), [metaList]);

  // Tokens used in the expression (whole word matches)
  const usedColumns = useMemo(() => {
    if (!metaList.length || !expr) return new Set();
    const set = new Set();
    for (const m of metaList) {
      const re = new RegExp(`\\b${m.alias}\\b`, 'i');
      if (re.test(expr)) set.add(m.rawName);
    }
    return set;
  }, [expr, metaList, columns]);

  // Current word prefix at caret
  const caretPrefix = useMemo(() => {
    const el = inputRef.current;
    const pos = el ? el.selectionStart : expr.length;
    const upto = expr.slice(0, pos);
    const m = upto.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    return m ? m[1] : "";
  }, [expr]);

  // Suggest columns by typed prefix; grey out those already used
  // Detect context: if an operator is present after a full alias, switch to value suggestions
  const context = useMemo(() => {
    const el = inputRef.current;
    const pos = el ? el.selectionStart : expr.length;
    const upto = expr.slice(0, pos);
    // match patterns around caret: <alias> [spaces] [op or partial op] [spaces]
    const m = upto.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:([=!<>]{1,2})|\b(i|in)\b)?\s*$/i);
    if (!m) return { mode: 'column' };
    const token = m[1];
    const opSym = m[2] || '';
    const opWord = (m[3] || '').toLowerCase();
    const op = opSym || (opWord === 'in' ? 'in' : '');
    const meta = aliasIndex[token];
    const exactOps = new Set(['==','!=','>=','<=','>','<','in']);
    if (meta && op && exactOps.has(op)) return { mode: 'value', alias: token, op, meta };
    // If alias typed with trailing spaces OR partial operator ('=', '!', '>', '<', or word 'i') → suggest operators
    if (meta && (!op || !exactOps.has(op)) ) return { mode: 'op', alias: token, meta };
    return { mode: 'column' };
  }, [expr, aliasIndex]);

  const suggestions = useMemo(() => {
    if (context.mode === 'value') {
      const m = context.meta;
      if (!m) return [];
      if (Array.isArray(m.choices) && m.choices.length) {
        return m.choices.map((c) => ({ type: 'value', insert: typeof c.value === 'number' ? String(c.value) : JSON.stringify(c.value), label: `${c.label} = ${c.value}` }));
      }
      if (m.isNumeric) {
        const vals = [];
        if (Number.isFinite(m.min)) vals.push(m.min);
        if (Number.isFinite(m.max) && m.max !== m.min) vals.push(m.max);
        return vals.map((v) => ({ type: 'value', insert: String(v), label: String(v) }));
      }
      const ex = (m.examples || []).slice(0, 6).map((v) => ({ type: 'value', insert: JSON.stringify(v), label: JSON.stringify(v) }));
      return ex;
    }
    if (context.mode === 'op') {
      const ops = ['==', '!=', '>', '<', '>=', '<=', 'in'];
      return ops.map((op) => ({ type: 'op', insert: op, label: op }));
    }
    // Column suggestions
    const p = caretPrefix.toLowerCase();
    const ordered = [...metaList].sort((a,b)=>{
      const au = usedColumns.has(a.rawName) ? 1 : 0;
      const bu = usedColumns.has(b.rawName) ? 1 : 0;
      if (au !== bu) return au - bu; // unused first
      return a.baseName.localeCompare(b.baseName);
    });
    return ordered
      .filter((m) => !p || m.baseName.toLowerCase().startsWith(p) || m.alias.toLowerCase().startsWith(p))
      .slice(0, 12)
      .map((m) => ({ type: 'column', meta: m }));
  }, [context, caretPrefix, metaList, usedColumns]);

  // Contextual hint when a full column alias is just typed
  const columnHint = useMemo(() => {
    const el = inputRef.current;
    const pos = el ? el.selectionStart : expr.length;
    const upto = expr.slice(0, pos);
    const m = upto.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    if (!m) return "";
    const token = m[1];
    const meta = aliasIndex[token];
    if (!meta) return "";
    if (Array.isArray(meta.choices) && meta.choices.length) {
      const items = meta.choices.map((c)=>`${c.label}:${c.value}`).join(", ");
      return `${token} == (${items})`;
    }
    if (meta.isNumeric) {
      const min = Number.isFinite(meta.min) ? meta.min : 0;
      const max = Number.isFinite(meta.max) ? meta.max : 0;
      return `${token} > ${min}  |  ${token} < ${max}  |  ${token} == ${min}`;
    }
    const ex = (meta.examples || []).slice(0, 3).map((v) => JSON.stringify(v)).join(", ");
    return ex ? `${token} == ${JSON.stringify((meta.examples||[])[0])}  |  ${token} in [${ex}]` : `${token} == '...'`;
  }, [expr, aliasIndex]);

  const insertTextAtCaret = (text, replaceFromIdx) => {
    const el = inputRef.current;
    const start = typeof replaceFromIdx === 'number' ? replaceFromIdx : el.selectionStart;
    const end = el.selectionEnd;
    const next = expr.slice(0, start) + text + expr.slice(end);
    setExpr(next);
    // restore caret
    requestAnimationFrame(() => {
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
      el.focus();
    });
  };

  const insertSuggestion = (sug) => {
    if (sug.type === 'value') {
      insertTextAtCaret(sug.insert);
      return;
    }
    if (sug.type === 'op') {
      insertTextAtCaret(sug.insert);
      // Keep the popover open and move focus back to input so that
      // value suggestions appear immediately after operator insertion
      setShowPopover(true);
      setActiveIdx(0);
      requestAnimationFrame(() => { try { inputRef.current && inputRef.current.focus(); } catch {} });
      return;
    }
    const alias = sug.meta.alias;
    const m = expr.slice(0, inputRef.current.selectionStart).match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    const replaceFrom = m ? m.index : inputRef.current.selectionStart;
    insertTextAtCaret(alias, replaceFrom);
  };

  const applyFilter = async () => {
    setError("");
    setLoading(true);
    try {
      const rows = rawRows || [];
      if (rows.length === 0) { setFilteredIds(new Set()); setCount(0); return; }
      const exp = (expr || "").trim();
      if (!exp) { setError("Expression is empty"); setFilteredIds(new Set()); setCount(0); return; }
      if (!isExpressionSafe(exp)) { setError("Expression contains unsupported characters"); setFilteredIds(new Set()); setCount(0); return; }

      // Build param aliases from known columns (by aliasIndex order)
      const uniqueAliases = Object.keys(aliasIndex);
      let fn;
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function(...uniqueAliases, `return (${exp});`);
      } catch (e) {
        setError(`Expression syntax error: ${e?.message || e}`);
        setFilteredIds(new Set());
        setCount(0);
        return;
      }

      // Quick dry-run to catch ReferenceError (unknown identifiers) etc.
      try {
        const zeros = new Array(uniqueAliases.length).fill(0);
        void fn(...zeros);
      } catch (e) {
        setError(`Expression is not executable: ${e?.message || e}`);
        setFilteredIds(new Set());
        setCount(0);
        return;
      }

      const ids = new Set();
      for (const item of rows) {
        const obj = item?.raw || {};
        const args = uniqueAliases.map((al) => {
          const col = aliasIndex[al]?.rawName;
          return obj[col];
        });
        let ok = false;
        try { ok = Boolean(fn(...args)); }
        catch (e) { setError(String(e?.message || e)); ok = false; }
        if (ok) ids.add(item.id);
      }
      setFilteredIds(ids);
      setCount(ids.size);
    } finally { setLoading(false); }
  };

  const setCaret = (pos) => {
    const el = inputRef.current; if (!el) return;
    requestAnimationFrame(() => { try { el.setSelectionRange(pos, pos); } catch {} });
  };

  const isWord = (ch) => /[A-Za-z0-9_]/.test(ch || '');
  const findAliasTokenAt = (text, pos) => {
    if (!text) return null;
    const n = text.length;
    let s = pos, epos = pos;
    // If caret is between chars, expand both sides
    while (s > 0 && isWord(text[s-1])) s--;
    while (epos < n && isWord(text[epos])) epos++;
    if (s === epos) return null; // not within a word
    const token = text.slice(s, epos);
    if (aliasIndex[token]) {
      // Ensure word boundaries
      const leftOk = s === 0 || !isWord(text[s-1]);
      const rightOk = epos === n || !isWord(text[epos]);
      if (leftOk && rightOk) return { start: s, end: epos, token };
    }
    return null;
  };

  const onKeyDown = (e) => {
    // Whole-token deletion when caret is inside a full alias
    if ((e.key === 'Backspace' || e.key === 'Delete') && inputRef.current) {
      const el = inputRef.current;
      if (el.selectionStart === el.selectionEnd) { // no selection
        const pos = el.selectionStart;
        // For Delete, when at token start, treat as inside
        const probePos = e.key === 'Backspace' ? Math.max(0, pos-1) : pos;
        const hit = findAliasTokenAt(expr, probePos);
        if (hit) {
          e.preventDefault();
          const next = expr.slice(0, hit.start) + expr.slice(hit.end);
          setExpr(next);
          setCaret(hit.start);
          return;
        }
      }
    }
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); return; }
      if (e.key === 'Tab') { e.preventDefault(); insertSuggestion(suggestions[activeIdx] || suggestions[0]); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); applyFilter(); }
  };

  // ===== Inline highlighting in the input (overlay) =====
  const escapeHtml = (str) =>
    String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const escRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const overlayHtml = useMemo(() => {
    let html = escapeHtml(expr || "");
    const aliases = Object.keys(aliasIndex);
    if (aliases.length === 0) return html;
    // Sort long → short to avoid partial overlaps
    const ordered = [...aliases].sort((a,b)=>b.length-a.length).map(escRegex);
    const re = new RegExp(`\\b(${ordered.join('|')})\\b`, 'gi');
    html = html.replace(re, '<span class="hl-attr">$1</span>');
    return html;
  }, [expr, aliasIndex]);

  const overlayRef = useRef(null);
  useEffect(() => {
    const input = inputRef.current;
    const overlay = overlayRef.current;
    if (!input || !overlay) return;
    const sync = () => {
      overlay.style.transform = `translateX(${-input.scrollLeft}px)`;
    };
    sync();
    input.addEventListener('scroll', sync);
    return () => { input.removeEventListener('scroll', sync); };
  }, [inputRef.current]);
  useEffect(() => {
    const input = inputRef.current; const overlay = overlayRef.current; if (!input || !overlay) return; overlay.style.transform = `translateX(${-input.scrollLeft}px)`; }, [expr]);

  return (
    <div className="filter-block">
      <div className="filter-title">Filter</div>
      <div className="filter-input-row">
        <div className="filter-input-wrap">
          <div ref={overlayRef} className="filter-input-overlay" aria-hidden="true" dangerouslySetInnerHTML={{ __html: overlayHtml }} />
          <input
          ref={inputRef}
          className="filter-input"
          placeholder="Enter expression, e.g. sex == 0 || age > 75"
          value={expr}
          onChange={(e) => { setExpr(e.target.value); setActiveIdx(0); }}
          onKeyDown={onKeyDown}
          onFocus={async () => { setShowPopover(true); await ensureMeta.current(); }}
          onBlur={() => setTimeout(() => setShowPopover(false), 120)}
          spellCheck={false}
        />
        </div>
        <button
          className="filter-apply"
          onClick={applyFilter}
          disabled={loading}
          title="Apply (Enter)"
          aria-label="Apply"
        >
          {loading ? '…' : '⏎'}
        </button>
      </div>

      {/* Live suggestions popover (on focus and while typing) */}
      {showPopover && (
        <div className="filter-popover">
          {loadingMeta && (
            <div className="filter-popover-empty">loading...</div>
          )}
          {!loadingMeta && metaList.length === 0 && (
            <div className="filter-popover-empty">no columns found</div>
          )}
          {!loadingMeta && metaList.length > 0 && suggestions.length === 0 && (
            <div className="filter-popover-empty">no matching columns (continue typing)</div>
          )}
          {!loadingMeta && suggestions.length > 0 && suggestions.map((s, i) => {
            // normalize key/label for all types
            let key;
            let label;
            if (s.type === 'value') {
              key = `v-${i}-${s.label}`;
              label = s.label;
            } else if (s.type === 'op') {
              key = `op-${i}-${s.label}`;
              label = s.label;
            } else {
              // column suggestion (has meta)
              key = `c-${s.meta?.alias ?? i}`;
              label = s.meta?.rawName ?? '';
            }
            const onPick = () => insertSuggestion(s);
            return (
              <div
                key={key}
                className={`filter-popover-item${i === activeIdx ? ' active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onPick(); }}
                title={label}
              >
                <span className="name">{label}</span>
              </div>
            );
          })}
        </div>
      )}

      {columnHint && (
        <div
          className="filter-hint"
          style={{ marginTop: 6, fontSize: 12, color: "#999" }}
        >
          {columnHint}
        </div>
      )}

      {error && (
        <div
          className="filter-error"
          style={{ marginTop: 4, fontSize: 12, color: "#ff6b6b" }}
        >
          {error}
        </div>
      )}

      {count != null && (
        <div
          className="filter-count"
          style={{ marginTop: 2, fontSize: 12, color: "#ccc" }}
        >
          {count} matched cells
        </div>
      )}

    </div>
  );
}
