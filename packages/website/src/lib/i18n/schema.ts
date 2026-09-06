// 正交意图（维护于 2026-09-06 Asia/Shanghai）：站点内容字典的类型契约 ——
// en/zh 两份文案同构（同一 schema），页面组件按 content 渲染，杜绝结构漂移。
//
// 原始需求（2026-09-06 Asia/Shanghai）：openspec/changes/2026-09-06-site-i18n-zh —
// `/` 保持英文（URL 稳定），`/zh/` 为中文镜像；zh 文案信源 README-zh.md，不虚构。
// 富文本注记用有序 segments 表达（text / code / link），保序且免 {@html}。

/** 行内注记段：text 直排、code 行内代码、link 外链（kind 决定 href）。 */
export type NoteSegment =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; v: string; kind: 'docker' | 'github' };

export interface NavAnchor {
  /** 站内锚点 id（两 locale 必须一致：#features/#quick-start/#packages/#ecosystem） */
  id: string;
  label: string;
}

export interface FeatureCard {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
}

export interface PackageRow {
  pkg: string;
  role: string;
}

/** 两 locale 同构的整页内容（chrome + 首页全部文案与样例代码）。 */
export interface WebsiteContent {
  meta: {
    siteTitle: string;
    description: string;
  };
  chrome: {
    /** header 品牌块第三行（desktop） */
    subtitle: string;
    /** language-switcher 的 aria-label */
    languageLabel: string;
    anchors: readonly NavAnchor[];
    githubLabel: string;
    drawerLabel: string;
    /** footer「project」列里的 README 链接文案（指向另一语言的 README） */
    readmeLabel: string;
    /** footer EXAMPLE 手册链接文案 */
    exampleLabel: string;
  };
  hero: {
    eyebrow: string;
    /** title = lead + <em>em</em> + tail */
    titleLead: string;
    titleEm: string;
    titleTail: string;
    badges: readonly string[];
    summary: string;
    quickStartLabel: string;
    barTitle: string;
    command: string;
    outputs: readonly string[];
  };
  featuresHeading: string;
  features: readonly FeatureCard[];
  quickStart: {
    eyebrow: string;
    title: string;
    summary: string;
    scriptMeta: string;
    script: string;
    bannerMeta: string;
    banner: string;
    note: readonly NoteSegment[];
  };
  packages: {
    eyebrow: string;
    title: string;
    summary: string;
    pkgHeader: string;
    roleHeader: string;
    rows: readonly PackageRow[];
  };
  ecosystem: {
    eyebrow: string;
    title: string;
    summary: string;
    pluginLabel: string;
    pluginMeta: string;
    pluginSample: string;
    sdkLabel: string;
    sdkMeta: string;
    sdkSample: string;
    note: readonly NoteSegment[];
  };
}
