const tagTranslationsZh: Record<string, string> = {
  latest: "最新",
  automation: "自动化",
  ai: "AI",
  finance: "金融",
  security: "安全",
  api: "API",
  crypto: "加密货币",
  mcp: "MCP",
  openclaw: "AI 引擎",
  memory: "记忆",
  productivity: "效率",
  agents: "智能体",
  audit: "审计",
  compliance: "合规",
  agent: "智能体",
  business: "商业",
  defi: "DeFi",
  base: "基础",
  blockchain: "区块链",
  chinese: "中文",
  marketing: "营销",
  "ai-agents": "AI 智能体",
  content: "内容",
  research: "研究",
  monitoring: "监控",
  search: "搜索",
  safety: "安全",
  cli: "命令行",
  devops: "DevOps",
  documentation: "文档",
  document: "文档",
  documents: "文档",
  docs: "文档",
  email: "邮件",
  office: "办公",
  "office-collab": "办公协作",
  operations: "运营",
  trading: "交易",
  analysis: "分析",
  "social-media": "社交媒体",
  "ai-agent": "AI 智能体",
  browser: "浏览器",
  identity: "身份",
  "multi-agent": "多智能体",
  governance: "治理",
  context: "上下文",
  solana: "Solana",
  health: "健康",
  hr: "人力资源",
  social: "社交",
  github: "GitHub",
  sales: "销售",
  analytics: "数据分析",
  statistics: "统计",
  visualization: "可视化",
  chart: "图表",
  report: "报表",
  reports: "报表",
  spreadsheet: "表格",
  spreadsheets: "表格",
  presentation: "演示文稿",
  slides: "幻灯片",
  ppt: "PPT",
  pdf: "PDF",
  word: "Word",
  excel: "Excel",
  sql: "SQL",
  csv: "CSV",
  bi: "BI",
  "business-intelligence": "商业智能",
  bitcoin: "比特币",
  workflow: "工作流",
  tools: "工具",
  code: "代码",
  data: "数据",
  database: "数据库",
  design: "设计",
  creative: "创意",
  development: "开发",
  frontend: "前端",
  backend: "后端",
  coding: "代码开发",
  education: "教育",
  entertainment: "娱乐",
  file: "文件",
  gaming: "游戏",
  image: "图片",
  language: "语言",
  legal: "法律",
  math: "数学",
  media: "媒体",
  music: "音乐",
  network: "网络",
  news: "新闻",
  payment: "支付",
  project: "项目",
  science: "科学",
  server: "服务器",
  storage: "存储",
  deployment: "部署",
  deploy: "部署",
  observability: "可观测性",
  logs: "日志",
  infrastructure: "基础设施",
  sre: "SRE",
  k8s: "Kubernetes",
  testing: "测试",
  text: "文本",
  translation: "翻译",
  utility: "工具",
  video: "视频",
  weather: "天气",
  web: "网页",
  writing: "写作",
  calendar: "日历",
  chat: "聊天",
  cloud: "云",
  communication: "通讯",
  "customer-support": "客服",
  "customer-service": "客服",
  ecommerce: "电商",
  kubernetes: "Kubernetes",
  docker: "Docker",
  slack: "Slack",
  discord: "Discord",
  telegram: "Telegram",
  twitter: "Twitter",
  notion: "Notion",
  "real-estate": "房地产",
  travel: "旅行",
  food: "美食",
  fitness: "健身",
  crypto_trading: "加密货币交易",
  ethereum: "以太坊",
  nft: "NFT",
  web3: "Web3",
  dao: "DAO",
  llm: "大模型",
  rag: "RAG",
  embedding: "向量嵌入",
  prompt: "提示词",
  "machine-learning": "机器学习",
  it_operations: "IT 运维",
  document_processing: "文档处理",
  backend_development: "后端开发",
  frontend_development: "前端开发",
  data_analysis: "数据分析",
  product_design: "产品设计",
  industry_skills: "行业技能",
  security_testing: "安全测试",
  code_development: "代码开发",
  web_research: "网页搜索",
  automation_workflow: "自动化流程",
  finance_web3: "金融/Web3",
  ai_agents: "AI 智能体",
  others: "其他",
};

export type SkillTranslation = {
  name?: string;
  description?: string;
};

export type SkillTranslationMap = Record<string, SkillTranslation>;

export function isChineseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

export function getTagLabel(tag: string, locale: string): string {
  if (!isChineseLocale(locale)) return tag;
  return tagTranslationsZh[tag] ?? tag;
}

export function getSkillTranslation(
  slug: string,
  translations: SkillTranslationMap,
  locale: string,
): SkillTranslation | null {
  if (!isChineseLocale(locale)) return null;
  return translations[slug] ?? null;
}

export function localizeSkillText<
  T extends { slug: string; name: string; description: string },
>(skill: T, translations: SkillTranslationMap, locale: string): T {
  const translation = getSkillTranslation(skill.slug, translations, locale);
  if (!translation) return skill;

  const name = translation.name?.trim();
  const description = translation.description?.trim();

  if (!name && !description) return skill;

  return {
    ...skill,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

export function composeSkillSearchText(
  slug: string,
  name: string,
  description: string,
  localizedName?: string | null,
  localizedDescription?: string | null,
): string {
  return [
    slug,
    name,
    description,
    localizedName ?? "",
    localizedDescription ?? "",
  ]
    .join("\n")
    .toLowerCase();
}
