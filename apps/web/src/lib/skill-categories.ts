export type SkillCategoryId =
  | "document_processing"
  | "data_analysis"
  | "industry_skills"
  | "it_operations"
  | "code_development"
  | "web_research"
  | "product_design"
  | "automation_workflow"
  | "security_testing"
  | "finance_web3"
  | "ai_agents"
  | "others";

type SkillLike = {
  slug: string;
  name: string;
  description: string;
  tags: readonly string[];
  downloads?: number;
  stars?: number;
};

type CategoryRule = {
  id: SkillCategoryId;
  tagTerms: readonly string[];
  textTerms: readonly string[];
};

export const SKILL_CATEGORY_ORDER: readonly SkillCategoryId[] = [
  "document_processing",
  "data_analysis",
  "industry_skills",
  "it_operations",
  "code_development",
  "web_research",
  "product_design",
  "automation_workflow",
  "security_testing",
  "finance_web3",
  "ai_agents",
  "others",
] as const;

const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    id: "document_processing",
    tagTerms: [
      "document_processing",
      "documentation",
      "document",
      "documents",
      "docs",
      "file",
      "pdf",
      "word",
      "excel",
      "spreadsheet",
      "spreadsheets",
      "presentation",
      "slides",
      "ppt",
      "office",
      "office-collab",
      "writing",
      "text",
      "email",
      "notion",
    ],
    textTerms: [
      "document",
      "docs",
      "markdown",
      "pdf",
      "word",
      "excel",
      "spreadsheet",
      "presentation",
      "slides",
      "ppt",
      "notion",
      "feishu",
      "lark",
      "文档",
      "表格",
      "幻灯片",
      "多维表格",
    ],
  },
  {
    id: "data_analysis",
    tagTerms: [
      "data_analysis",
      "analytics",
      "analysis",
      "data",
      "database",
      "csv",
      "sql",
      "report",
      "reports",
      "chart",
      "visualization",
      "statistics",
      "bi",
      "business-intelligence",
    ],
    textTerms: [
      "analytics",
      "analysis",
      "database",
      "csv",
      "sql",
      "chart",
      "dashboard",
      "statistics",
      "report",
      "数据",
      "分析",
      "报表",
      "图表",
      "统计",
    ],
  },
  {
    id: "industry_skills",
    tagTerms: [
      "industry_skills",
      "business",
      "marketing",
      "sales",
      "finance",
      "legal",
      "health",
      "healthcare",
      "medical",
      "hr",
      "education",
      "ecommerce",
      "customer-support",
      "customer-service",
      "real-estate",
      "travel",
      "food",
      "fitness",
    ],
    textTerms: [
      "crm",
      "erp",
      "sales",
      "marketing",
      "customer",
      "legal",
      "healthcare",
      "medical",
      "recruiting",
      "客户",
      "营销",
      "销售",
      "法务",
      "医疗",
      "招聘",
      "电商",
      "教育",
    ],
  },
  {
    id: "it_operations",
    tagTerms: [
      "it_operations",
      "devops",
      "operations",
      "server",
      "cloud",
      "network",
      "docker",
      "kubernetes",
      "k8s",
      "deployment",
      "deploy",
      "monitoring",
      "observability",
      "logs",
      "storage",
      "sre",
      "infrastructure",
    ],
    textTerms: [
      "devops",
      "server",
      "ssh",
      "vps",
      "docker",
      "kubernetes",
      "deploy",
      "deployment",
      "monitoring",
      "logs",
      "运维",
      "服务器",
      "部署",
      "监控",
      "日志",
    ],
  },
  {
    id: "code_development",
    tagTerms: [
      "backend_development",
      "frontend_development",
      "development",
      "code",
      "coding",
      "github",
      "api",
      "cli",
      "testing",
      "test",
      "frontend",
      "backend",
    ],
    textTerms: [
      "code",
      "coding",
      "github",
      "typescript",
      "javascript",
      "python",
      "api",
      "frontend",
      "backend",
      "debug",
      "代码",
      "开发",
      "前端",
      "后端",
      "接口",
      "调试",
    ],
  },
  {
    id: "web_research",
    tagTerms: [
      "web",
      "search",
      "browser",
      "research",
      "news",
      "crawler",
      "scraper",
      "internet",
    ],
    textTerms: [
      "web",
      "search",
      "browser",
      "research",
      "crawl",
      "scrape",
      "internet",
      "网页",
      "搜索",
      "浏览器",
      "爬取",
    ],
  },
  {
    id: "product_design",
    tagTerms: [
      "product_design",
      "design",
      "image",
      "images",
      "media",
      "video",
      "music",
      "3d",
      "logo",
      "creative",
    ],
    textTerms: [
      "design",
      "image",
      "video",
      "media",
      "logo",
      "poster",
      "3d",
      "生成图片",
      "设计",
      "图片",
      "视频",
      "海报",
    ],
  },
  {
    id: "automation_workflow",
    tagTerms: [
      "automation",
      "workflow",
      "productivity",
      "tools",
      "utility",
      "calendar",
      "chat",
      "communication",
      "slack",
      "discord",
      "telegram",
    ],
    textTerms: [
      "automation",
      "workflow",
      "productivity",
      "calendar",
      "task",
      "todo",
      "自动化",
      "工作流",
      "日程",
      "任务",
    ],
  },
  {
    id: "security_testing",
    tagTerms: [
      "security_testing",
      "security",
      "safety",
      "audit",
      "compliance",
      "identity",
      "1password",
      "password",
    ],
    textTerms: [
      "security",
      "audit",
      "compliance",
      "password",
      "vault",
      "安全",
      "审计",
      "合规",
      "密码",
      "密钥",
    ],
  },
  {
    id: "finance_web3",
    tagTerms: [
      "crypto",
      "crypto_trading",
      "blockchain",
      "defi",
      "trading",
      "bitcoin",
      "ethereum",
      "nft",
      "web3",
      "dao",
      "payment",
      "solana",
    ],
    textTerms: [
      "crypto",
      "blockchain",
      "trading",
      "bitcoin",
      "ethereum",
      "web3",
      "wallet",
      "payment",
      "区块链",
      "钱包",
      "交易",
      "支付",
    ],
  },
  {
    id: "ai_agents",
    tagTerms: [
      "ai",
      "agent",
      "agents",
      "ai-agent",
      "ai-agents",
      "multi-agent",
      "llm",
      "rag",
      "embedding",
      "prompt",
      "machine-learning",
    ],
    textTerms: [
      "agent",
      "agents",
      "llm",
      "rag",
      "embedding",
      "prompt",
      "ai agent",
      "智能体",
      "大模型",
      "提示词",
    ],
  },
];

const CATEGORY_RANK = new Map(
  SKILL_CATEGORY_ORDER.map((category, index) => [category, index]),
);
const CATEGORY_ID_SET = new Set<string>(SKILL_CATEGORY_ORDER);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/|]+/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeCategoryId(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[-\s]+/gu, "_");
}

function hasTextTerm(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => text.includes(normalize(term)));
}

function matchesRule(skill: SkillLike, rule: CategoryRule): boolean {
  const tags = new Set(skill.tags.map(normalize));
  if (rule.tagTerms.some((term) => tags.has(normalize(term)))) {
    return true;
  }

  const text = normalize(
    [skill.slug, skill.name, skill.description, ...skill.tags].join(" "),
  );
  return hasTextTerm(text, rule.textTerms);
}

export function getSkillCategoryId(skill: SkillLike): SkillCategoryId {
  const explicitCategory = skill.tags
    .map(normalizeCategoryId)
    .find((tag) => CATEGORY_ID_SET.has(tag));
  if (explicitCategory) {
    return explicitCategory as SkillCategoryId;
  }

  return (
    CATEGORY_RULES.find((rule) => matchesRule(skill, rule))?.id ?? "others"
  );
}

export function skillMatchesCategory(
  skill: SkillLike,
  categoryId: string,
): boolean {
  if (categoryId === "all") return true;
  return getSkillCategoryId(skill) === categoryId;
}

export function compareSkillsForMarketplace(
  left: SkillLike,
  right: SkillLike,
): number {
  const leftRank = CATEGORY_RANK.get(getSkillCategoryId(left)) ?? 999;
  const rightRank = CATEGORY_RANK.get(getSkillCategoryId(right)) ?? 999;
  if (leftRank !== rightRank) return leftRank - rightRank;

  const leftScore = (left.downloads ?? 0) + (left.stars ?? 0) * 10;
  const rightScore = (right.downloads ?? 0) + (right.stars ?? 0) * 10;
  if (leftScore !== rightScore) return rightScore - leftScore;

  return left.name.localeCompare(right.name);
}
