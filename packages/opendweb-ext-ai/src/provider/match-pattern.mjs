// adapted from ai-fly src/provider/match-pattern.ts (v0.6.0)
// URLPattern 编译（pattern 路由）。运行时兼容层：Node 的 URLPattern（Ada 实现）
// 只认 `:name` 组语法——`{name}` 花括号形式在编译期翻译为冒号形式（仅字母开头
// 的名字，避免误伤正则量词如 \d{4}）。编译结果按原文缓存（服务为不可变数据）。

export class MatchPatternError extends Error {
  constructor(message) {
    super(message);
    this.name = "MatchPatternError";
  }
}

/** 花括号组 → 冒号组（兼容两种 URLPattern 文档写法）。 */
export function normalizeMatchPatternSyntax(raw) {
  return raw.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ":$1");
}

const compiled = new Map();

/**
 * @param {string} raw
 * @returns {URLPattern}
 */
export function compileMatchPattern(raw) {
  const cached = compiled.get(raw);
  if (cached !== undefined) return cached;
  if (typeof URLPattern !== "function") {
    throw new MatchPatternError("URLPattern is unavailable in this runtime");
  }
  const translated = normalizeMatchPatternSyntax(raw);
  let pattern;
  try {
    pattern = new URLPattern({ pathname: translated });
  } catch (err) {
    throw new MatchPatternError(err.message || "invalid urlpattern");
  }
  compiled.set(raw, pattern);
  return pattern;
}

/**
 * 匹配请求路径（含可选查询串）。返回捕获组（pathname groups）；未命中返回
 * null。exec 需要完整 URL——以 http://localhost 为基座构造。
 * @param {URLPattern} pattern
 * @param {string} pathname
 * @param {string} search
 * @returns {Record<string, string> | null}
 */
export function matchRequestPath(pattern, pathname, search) {
  const url = `http://localhost${pathname.startsWith("/") ? pathname : `/${pathname}`}${search === "" ? "" : `?${search}`}`;
  const result = pattern.exec(url);
  if (result === null) return null;
  return { ...result.pathname.groups };
}
