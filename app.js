const patternInput = document.getElementById("patternInput");
const clearPatternBtn = document.getElementById("clearPatternBtn");
const regexError = document.getElementById("regexError");
const regexTrack = document.getElementById("regexTrack");
const tokenLegend = document.getElementById("tokenLegend");
const resultList = document.getElementById("resultList");
const matchCount = document.getElementById("matchCount");
const shownCount = document.getElementById("shownCount");
const loadStatus = document.getElementById("loadStatus");
const hintCard = document.getElementById("hintCard");
const dictFile = document.getElementById("dictFile");

const TOKEN_COLORS = 8;
const DISPLAY_LIMIT = 260;
const ACTIVE_HIGHLIGHT_MS = 1400;
const DEFAULT_HINT_TEXT =
  "点击下面的按钮会把相应的符号插入光标位置。";

const state = {
  words: [],
  activeRange: null,
  activeTokenIds: new Set(),
  lastHintHtml: "",
  linkedTokenId: null,
  linkedElements: [],
};

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function debounce(fn, delay = 130) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function buildHintHtml(snippet, hintText) {
  return `<strong>${escapeHtml(snippet)}</strong>：${escapeHtml(hintText)}`;
}

function setHintHtml(html, persist = false) {
  hintCard.innerHTML = html;
  if (persist) {
    state.lastHintHtml = html;
  }
}

function collectHintSamples() {
  const samples = [escapeHtml(DEFAULT_HINT_TEXT)];

  for (const button of document.querySelectorAll(".token-btn")) {
    const snippet = button.dataset.snippet || "";
    const hint = button.dataset.hint || "插入符号";
    samples.push(buildHintHtml(snippet, hint));
  }

  for (const button of document.querySelectorAll(".example-btn")) {
    const pattern = button.dataset.pattern || "";
    if (pattern) {
      samples.push(buildHintHtml(pattern, "已套用示例"));
    }
  }

  return samples;
}

function syncHintCardHeight() {
  const width = hintCard.clientWidth;
  if (!width) {
    return;
  }

  const probe = document.createElement("aside");
  probe.className = "hint-card";
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.zIndex = "-1";
  probe.style.width = `${width}px`;
  probe.style.height = "auto";
  probe.style.minHeight = "0";

  document.body.appendChild(probe);

  let maxHeight = 0;
  for (const sample of collectHintSamples()) {
    probe.innerHTML = sample;
    maxHeight = Math.max(maxHeight, Math.ceil(probe.getBoundingClientRect().height));
  }

  probe.remove();

  if (maxHeight > 0) {
    hintCard.style.height = `${maxHeight}px`;
  }
}

function setLoadStatus(type, text) {
  loadStatus.className = `status-pill ${type}`;
  loadStatus.textContent = text;
}

function parseWords(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function detectActiveTokens(tokens) {
  if (!state.activeRange) {
    state.activeTokenIds = new Set();
    return;
  }

  const now = Date.now();
  if (now > state.activeRange.expiresAt) {
    state.activeRange = null;
    state.activeTokenIds = new Set();
    return;
  }

  const current = tokens
    .filter((token) => token.end > state.activeRange.start && token.start < state.activeRange.end)
    .map((token) => token.id);

  state.activeTokenIds = new Set(current);
}

function isAnchorStart(source, index) {
  return index === 0 || source[index - 1] === "|";
}

function isAnchorEnd(source, index) {
  return index === source.length - 1 || source[index + 1] === "|";
}

function consumeCharClass(source, startIndex) {
  let i = startIndex + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "]") {
      i += 1;
      break;
    }
    i += 1;
  }
  return i;
}

function consumeGroup(source, startIndex) {
  let depth = 0;
  let i = startIndex;

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\\") {
      i += 2;
      continue;
    }

    if (ch === "[") {
      i = consumeCharClass(source, i);
      continue;
    }

    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (ch === ")") {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        return i;
      }
      continue;
    }

    i += 1;
  }

  return source.length;
}

function readQuantifier(source, startIndex) {
  const ch = source[startIndex];
  if (!ch) {
    return null;
  }

  if (ch === "*" || ch === "+" || ch === "?") {
    let quant = ch;
    let i = startIndex + 1;
    if (source[i] === "?") {
      quant += "?";
      i += 1;
    }
    return { value: quant, nextIndex: i };
  }

  if (ch !== "{") {
    return null;
  }

  let i = startIndex + 1;
  while (i < source.length && /[0-9,\s]/.test(source[i])) {
    i += 1;
  }

  if (source[i] !== "}" || i <= startIndex + 1) {
    return null;
  }

  let quant = source.slice(startIndex, i + 1);
  i += 1;

  if (source[i] === "?") {
    quant += "?";
    i += 1;
  }

  return { value: quant, nextIndex: i };
}

function isQuantifiable(type) {
  return type !== "alternation" && !type.startsWith("anchor");
}

function atomConsumesCharacters(type, atom) {
  if (type === "alternation") {
    return false;
  }

  if (type.startsWith("anchor")) {
    return false;
  }

  if (type === "escape" && (atom === "\\b" || atom === "\\B")) {
    return false;
  }

  if (type === "group" && /^\(\?(?:=|!|<=|<!)/.test(atom)) {
    return false;
  }

  return true;
}

function describeQuantifier(quantifier) {
  if (!quantifier) {
    return "";
  }

  let core = quantifier;
  let lazyText = "";

  if (quantifier.endsWith("?") && quantifier.length > 1) {
    core = quantifier.slice(0, -1);
    lazyText = "，并尽量少匹配（惰性）";
  }

  if (core === "*") {
    return `重复 0 次或多次${lazyText}`;
  }

  if (core === "+") {
    return `重复 1 次或多次${lazyText}`;
  }

  if (core === "?") {
    return `重复 0 或 1 次${lazyText}`;
  }

  const inner = core.slice(1, -1).replace(/\s+/g, "");

  if (/^\d+$/.test(inner)) {
    return `恰好重复 ${inner} 次${lazyText}`;
  }

  if (/^\d+,$/.test(inner)) {
    return `至少重复 ${inner.slice(0, -1)} 次${lazyText}`;
  }

  if (/^\d+,\d+$/.test(inner)) {
    const [from, to] = inner.split(",");
    return `重复 ${from} 到 ${to} 次${lazyText}`;
  }

  return `重复次数限制 ${core}${lazyText}`;
}

function describeToken(atom, quantifier, type) {
  const escapeMap = {
    "\\d": "数字字符",
    "\\D": "非数字字符",
    "\\w": "字母/数字/下划线",
    "\\W": "非字母/数字/下划线",
    "\\s": "空白字符",
    "\\S": "非空白字符",
    "\\b": "单词边界位置",
    "\\B": "非单词边界位置",
  };

  let base = "";

  switch (type) {
    case "alternation":
      base = "“或”逻辑：左边或右边任一成立";
      break;
    case "anchor-start":
      base = "开头位置锚点";
      break;
    case "anchor-end":
      base = "结尾位置锚点";
      break;
    case "dot":
      base = "任意单个字符（默认不含换行）";
      break;
    case "class":
      base = atom.startsWith("[^") ? "排除字符集合" : "字符集合";
      break;
    case "group":
      if (/^\(\?=/.test(atom)) {
        base = "正向先行断言（只判断，不消耗字符）";
      } else if (/^\(\?!/.test(atom)) {
        base = "负向先行断言（只判断，不消耗字符）";
      } else if (/^\(\?</.test(atom)) {
        base = "后行断言（只判断，不消耗字符）";
      } else {
        base = "分组模式";
      }
      break;
    case "escape":
      base = escapeMap[atom] || `转义字符 ${atom}`;
      break;
    default:
      base = `字符 “${atom}”`;
  }

  const quantifierText = describeQuantifier(quantifier);
  return quantifierText ? `${base}，${quantifierText}` : base;
}

function canMergeLiteralTokens(previousToken, nextToken) {
  return (
    previousToken.type === "literal" &&
    nextToken.type === "literal" &&
    previousToken.quantifier === "" &&
    nextToken.quantifier === "" &&
    previousToken.end === nextToken.start
  );
}

function mergeAdjacentLiteralTokens(tokens) {
  if (tokens.length < 2) {
    return tokens;
  }

  const merged = [];

  for (const token of tokens) {
    const last = merged[merged.length - 1];

    if (last && canMergeLiteralTokens(last, token)) {
      last.atom += token.atom;
      last.raw = `${last.atom}${last.quantifier}`;
      last.end = token.end;
      last.description = describeToken(last.atom, last.quantifier, last.type);
      continue;
    }

    merged.push({ ...token });
  }

  return merged.map((token, index) => ({ ...token, id: index }));
}

function tokenizePattern(source) {
  const tokens = [];
  let i = 0;
  let id = 0;

  while (i < source.length) {
    const start = i;
    let atom = "";
    let type = "literal";

    if (source[i] === "\\") {
      atom = source.slice(i, Math.min(i + 2, source.length));
      i += atom.length;
      type = "escape";
    } else if (source[i] === "[") {
      const end = consumeCharClass(source, i);
      atom = source.slice(i, end);
      i = end;
      type = "class";
    } else if (source[i] === "(") {
      const end = consumeGroup(source, i);
      atom = source.slice(i, end);
      i = end;
      type = "group";
    } else if (source[i] === "|") {
      atom = "|";
      i += 1;
      type = "alternation";
    } else if (source[i] === "^" && isAnchorStart(source, i)) {
      atom = "^";
      i += 1;
      type = "anchor-start";
    } else if (source[i] === "$" && isAnchorEnd(source, i)) {
      atom = "$";
      i += 1;
      type = "anchor-end";
    } else {
      atom = source[i];
      i += 1;
      type = atom === "." ? "dot" : "literal";
    }

    let quantifier = "";
    if (i < source.length && isQuantifiable(type)) {
      const q = readQuantifier(source, i);
      if (q) {
        quantifier = q.value;
        i = q.nextIndex;
      }
    }

    const consumes = atomConsumesCharacters(type, atom);
    const raw = `${atom}${quantifier}`;

    tokens.push({
      id,
      raw,
      atom,
      quantifier,
      start,
      end: i,
      type,
      consumes,
      description: describeToken(atom, quantifier, type),
    });

    id += 1;
  }

  return mergeAdjacentLiteralTokens(tokens);
}

function buildSegmentedPattern(tokens) {
  let source = "";
  const map = [];
  let groupIndex = 0;

  for (const token of tokens) {
    if (token.consumes) {
      const groupName = `seg${groupIndex}`;
      source += `(?<${groupName}>${token.raw})`;
      map.push({ tokenId: token.id, groupName });
      groupIndex += 1;
    } else {
      source += token.raw;
    }
  }

  return { source, map };
}

function showRegexError(message) {
  regexError.hidden = false;
  regexError.textContent = message;
}

function clearRegexError() {
  regexError.hidden = true;
  regexError.textContent = "";
}

function updateRegexTrack(tokens) {
  if (!tokens.length) {
    regexTrack.className = "regex-track empty";
    regexTrack.textContent = "输入表达式后，这里会把它拆成可联动的彩色片段。";
    return;
  }

  regexTrack.className = "regex-track";
  regexTrack.innerHTML = tokens
    .map((token) => {
      const colorClass = token.consumes ? `color-${token.id % TOKEN_COLORS}` : "";
      const nonConsuming = token.consumes ? "" : "is-non-consuming";
      const active = state.activeTokenIds.has(token.id) ? "is-active" : "";
      return `<span class="regex-chip ${colorClass} ${nonConsuming} ${active}" data-token-id="${
        token.id
      }">${escapeHtml(token.raw)}</span>`;
    })
    .join("");
}

function clearLinkedTokenStyles() {
  for (const element of state.linkedElements) {
    element.classList.remove("is-linked");
  }
  state.linkedElements = [];
}

function applyLinkedTokenStyles() {
  clearLinkedTokenStyles();

  if (!Number.isInteger(state.linkedTokenId)) {
    return;
  }

  const id = state.linkedTokenId;
  const selector = [
    `.regex-chip[data-token-id="${id}"]`,
    `.token-card[data-token-id="${id}"]`,
    `.match-chip[data-token-id="${id}"]`,
  ].join(", ");

  const elements = document.querySelectorAll(selector);
  for (const element of elements) {
    element.classList.add("is-linked");
    state.linkedElements.push(element);
  }
}

function setLinkedToken(tokenId) {
  const normalized = Number.isInteger(tokenId) ? tokenId : null;
  if (state.linkedTokenId === normalized) {
    return;
  }
  state.linkedTokenId = normalized;
  applyLinkedTokenStyles();
}

function bindLinkedHoverZone(container, selector) {
  container.addEventListener("pointerover", (event) => {
    const rawTarget = event.target;
    if (!(rawTarget instanceof Element)) {
      return;
    }
    const tokenNode = rawTarget.closest(selector);
    if (!tokenNode || !container.contains(tokenNode)) {
      return;
    }
    const tokenId = Number(tokenNode.dataset.tokenId);
    if (!Number.isInteger(tokenId)) {
      return;
    }
    setLinkedToken(tokenId);
  });

  container.addEventListener("pointerleave", () => {
    setLinkedToken(null);
  });
}

function bindLinkedHighlights() {
  bindLinkedHoverZone(regexTrack, ".regex-chip[data-token-id]");
  bindLinkedHoverZone(tokenLegend, ".token-card[data-token-id]");
  bindLinkedHoverZone(resultList, ".match-chip[data-token-id]");
}

function updateLegend(tokens) {
  if (!tokens.length) {
    tokenLegend.className = "token-legend empty";
    tokenLegend.innerHTML =
      "输入表达式后，这里会解释每个符号的含义并用颜色对应到结果中的匹配片段。";
    return;
  }

  tokenLegend.className = "token-legend";
  tokenLegend.innerHTML = tokens
    .map((token) => {
      const colorClass = token.consumes ? `color-${token.id % TOKEN_COLORS}` : "";
      const nonConsuming = token.consumes ? "" : "is-non-consuming";
      const active = state.activeTokenIds.has(token.id) ? "is-active" : "";
      return `<article class="token-card ${colorClass} ${nonConsuming} ${active}" data-token-id="${
        token.id
      }">
        <div class="token-head">
          <code>${escapeHtml(token.raw)}</code>
          <span>${token.consumes ? "匹配字符" : "逻辑/定位"}</span>
        </div>
        <p>${escapeHtml(token.description)}</p>
      </article>`;
    })
    .join("");
}

function buildSpansFromMatch(word, match, segmentMap) {
  if (!match || !match.groups) {
    return [];
  }

  const spans = [];
  let cursor = match.index;
  const matchEnd = match.index + match[0].length;

  for (const segment of segmentMap) {
    const part = match.groups[segment.groupName];
    if (typeof part !== "string" || part.length === 0) {
      continue;
    }

    let partStart = word.indexOf(part, cursor);
    if (partStart < 0 || partStart > matchEnd) {
      partStart = cursor;
    }

    const partEnd = Math.min(partStart + part.length, word.length);
    if (partEnd <= partStart) {
      continue;
    }

    spans.push({
      tokenId: segment.tokenId,
      start: partStart,
      end: partEnd,
    });

    cursor = Math.max(cursor, partEnd);
  }

  spans.sort((a, b) => a.start - b.start || a.end - b.end);

  const normalized = [];
  let pointer = -1;
  for (const span of spans) {
    if (span.start < pointer) {
      continue;
    }
    normalized.push(span);
    pointer = span.end;
  }

  return normalized;
}

function renderWordWithSpans(word, spans) {
  if (!spans.length) {
    return escapeHtml(word);
  }

  let html = "";
  let cursor = 0;

  for (const span of spans) {
    html += escapeHtml(word.slice(cursor, span.start));
    const chunk = escapeHtml(word.slice(span.start, span.end));
    const hasTokenId = Number.isInteger(span.tokenId);
    const colorClass = hasTokenId ? `color-${span.tokenId % TOKEN_COLORS}` : "";
    const activeClass = hasTokenId && state.activeTokenIds.has(span.tokenId) ? "is-active" : "";
    const tokenAttr = hasTokenId ? ` data-token-id="${span.tokenId}"` : "";
    html += `<span class="match-chip ${colorClass} ${activeClass}"${tokenAttr}>${chunk}</span>`;
    cursor = span.end;
  }

  html += escapeHtml(word.slice(cursor));
  return html;
}

function compileRegexes(pattern) {
  const flags = "i";
  const baseSource = `^(?:${pattern})$`;

  const baseRegex = new RegExp(baseSource, flags);

  const tokens = tokenizePattern(pattern);
  const segmented = buildSegmentedPattern(tokens);

  let segmentedRegex = null;
  let segmentError = "";

  if (segmented.map.length) {
    const segmentedSource = `^(?:${segmented.source})$`;
    try {
      segmentedRegex = new RegExp(segmentedSource, flags);
    } catch (error) {
      segmentError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    tokens,
    baseRegex,
    segmentedRegex,
    segmentMap: segmented.map,
    segmentError,
  };
}

function renderResults(words, total, segmentedRegex, segmentMap, baseRegex) {
  matchCount.textContent = String(total);
  shownCount.textContent = String(words.length);

  if (!words.length) {
    resultList.innerHTML = `<li class="empty-result">没有匹配结果。你可以尝试放宽条件，比如把某个字母改成 <code>.</code> 或给字符加上 <code>*</code>。</li>`;
    return;
  }

  const items = words
    .map((word, index) => {
      let content = escapeHtml(word);

      if (segmentedRegex && segmentMap.length) {
        const match = segmentedRegex.exec(word);
        const spans = buildSpansFromMatch(word, match, segmentMap);
        content = renderWordWithSpans(word, spans);
      } else {
        const match = baseRegex.exec(word);
        if (match && match[0].length > 0) {
          const start = match.index;
          const end = start + match[0].length;
          const spans = [{ tokenId: null, start, end }];
          content = renderWordWithSpans(word, spans);
        }
      }

      const delay = Math.min(index * 8, 380);
      return `<li class="result-item" style="animation-delay:${delay}ms">
        <span class="index">#${index + 1}</span>
        <span class="word">${content}</span>
      </li>`;
    })
    .join("");

  const overflowText =
    total > words.length
      ? `<li class="empty-result">还有 ${total - words.length} 条结果未展示（已限制前 ${DISPLAY_LIMIT} 条）。</li>`
      : "";

  resultList.innerHTML = items + overflowText;
}

function runSearch() {
  const pattern = patternInput.value;

  if (!pattern.trim()) {
    clearRegexError();
    state.activeTokenIds = new Set();
    setLinkedToken(null);
    updateRegexTrack([]);
    updateLegend([]);
    matchCount.textContent = "0";
    shownCount.textContent = "0";
    resultList.innerHTML =
      '<li class="empty-result">先输入表达式，再查看匹配效果。可以先试试 <code>^\\b\\w*?([a-z])\\d*[^aeiou]{2}[aeiou]+[^aeiou]{2,4}(?:ths|THS).?$\\b</code>。</li>';
    return;
  }

  let regexBundle;
  try {
    regexBundle = compileRegexes(pattern);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    showRegexError(`表达式语法错误：${msg}`);
    setLinkedToken(null);
    updateRegexTrack([]);
    updateLegend([]);
    matchCount.textContent = "0";
    shownCount.textContent = "0";
    resultList.innerHTML =
      '<li class="empty-result">当前表达式无法编译，请根据错误提示修改。</li>';
    return;
  }

  clearRegexError();

  if (regexBundle.segmentError) {
    showRegexError(
      `表达式可以搜索，但细粒度拆解失败（通常是复杂反向引用导致）：${regexBundle.segmentError}`
    );
  }

  if (
    state.linkedTokenId !== null &&
    !regexBundle.tokens.some((token) => token.id === state.linkedTokenId)
  ) {
    state.linkedTokenId = null;
  }

  detectActiveTokens(regexBundle.tokens);
  updateRegexTrack(regexBundle.tokens);
  updateLegend(regexBundle.tokens);

  if (!state.words.length) {
    matchCount.textContent = "0";
    shownCount.textContent = "0";
    resultList.innerHTML =
      '<li class="empty-result">词典尚未加载完成，请稍候，或手动选择 <code>words_alpha.txt</code>。</li>';
    applyLinkedTokenStyles();
    return;
  }

  let total = 0;
  const shown = [];

  for (const word of state.words) {
    if (regexBundle.baseRegex.test(word)) {
      total += 1;
      if (shown.length < DISPLAY_LIMIT) {
        shown.push(word);
      }
    }
  }

  renderResults(
    shown,
    total,
    regexBundle.segmentedRegex,
    regexBundle.segmentMap,
    regexBundle.baseRegex
  );
  applyLinkedTokenStyles();
}

const runSearchDebounced = debounce(runSearch, 120);

function insertSnippet(snippet, cursorOffset, button, hintText) {
  const start = patternInput.selectionStart;
  const end = patternInput.selectionEnd;
  patternInput.setRangeText(snippet, start, end, "end");

  const nextPos = Math.max(0, patternInput.selectionStart + cursorOffset);
  patternInput.setSelectionRange(nextPos, nextPos);

  state.activeRange = {
    start,
    end: start + snippet.length,
    expiresAt: Date.now() + ACTIVE_HIGHLIGHT_MS,
  };

  setHintHtml(buildHintHtml(snippet, hintText), true);

  button.classList.remove("is-clicked");
  void button.offsetWidth;
  button.classList.add("is-clicked");

  patternInput.focus();
  runSearch();
}

function bindButtonPanel() {
  const tokenButtons = Array.from(document.querySelectorAll(".token-btn"));
  for (const button of tokenButtons) {
    const snippet = button.dataset.snippet || "";
    const cursorOffset = Number(button.dataset.cursor || 0);
    const hint = button.dataset.hint || "插入符号";

    button.addEventListener("mouseenter", () => {
      setHintHtml(buildHintHtml(snippet, hint));
    });

    button.addEventListener("mouseleave", () => {
      setHintHtml(state.lastHintHtml);
    });

    button.addEventListener("click", () => {
      insertSnippet(snippet, cursorOffset, button, hint);
    });
  }

  const exampleButtons = Array.from(document.querySelectorAll(".example-btn"));
  for (const button of exampleButtons) {
    button.addEventListener("click", () => {
      const pattern = button.dataset.pattern || "";
      patternInput.value = pattern;
      patternInput.focus();
      patternInput.setSelectionRange(pattern.length, pattern.length);
      state.activeRange = {
        start: 0,
        end: pattern.length,
        expiresAt: Date.now() + ACTIVE_HIGHLIGHT_MS,
      };
      setHintHtml(buildHintHtml(pattern, "已套用示例"), true);
      runSearch();
    });
  }
}

async function loadDictionaryFromFetch() {
  setLoadStatus("loading", "正在从 words_alpha.txt 读取词典...");
  try {
    const response = await fetch("./words_alpha.txt", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    state.words = parseWords(text);
    setLoadStatus("ready", `词典加载完成：${state.words.length.toLocaleString()} 个单词`);
    runSearch();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    setLoadStatus(
      "error",
      "自动读取失败：请用本地服务器打开页面，或在下方手动选择 words_alpha.txt"
    );
    resultList.innerHTML = `<li class="empty-result">自动读取词典失败：${escapeHtml(
      msg
    )}<br />提示：在当前目录执行 <code>python3 -m http.server</code> 后，用浏览器打开页面。</li>`;
  }
}

function bindManualFileLoader() {
  dictFile.addEventListener("change", async () => {
    const file = dictFile.files && dictFile.files[0];
    if (!file) {
      return;
    }

    setLoadStatus("loading", `正在读取 ${file.name} ...`);

    try {
      const text = await file.text();
      state.words = parseWords(text);
      setLoadStatus("ready", `手动载入成功：${state.words.length.toLocaleString()} 个单词`);
      runSearch();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setLoadStatus("error", `手动读取失败：${msg}`);
    }
  });
}

function bindInputEvents() {
  clearPatternBtn.addEventListener("click", () => {
    patternInput.value = "";
    state.activeRange = null;
    setLinkedToken(null);
    patternInput.focus();
    runSearch();
  });

  patternInput.addEventListener("input", () => {
    state.activeRange = null;
    setLinkedToken(null);
    runSearchDebounced();
  });
}

function init() {
  bindButtonPanel();
  bindLinkedHighlights();
  setHintHtml(escapeHtml(DEFAULT_HINT_TEXT), true);
  syncHintCardHeight();
  const syncHintCardHeightDebounced = debounce(syncHintCardHeight, 100);
  window.addEventListener("resize", syncHintCardHeightDebounced);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(syncHintCardHeight).catch(() => {});
  }
  bindManualFileLoader();
  bindInputEvents();
  runSearch();
  loadDictionaryFromFetch();
}

init();
