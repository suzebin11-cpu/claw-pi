import { describe, expect, it } from "vitest";
import {
  compareSkillsForMarketplace,
  getSkillCategoryId,
  skillMatchesCategory,
} from "../src/lib/skill-categories";

describe("skill categories", () => {
  it("puts practical document skills into document processing", () => {
    const skill = {
      slug: "pdf-report-writer",
      name: "PDF Report Writer",
      description: "Summarize PDF files and create Word documents",
      tags: ["pdf", "writing"],
      downloads: 10,
      stars: 0,
    };

    expect(getSkillCategoryId(skill)).toBe("document_processing");
    expect(skillMatchesCategory(skill, "document_processing")).toBe(true);
  });

  it("keeps uncategorized skills in others", () => {
    expect(
      getSkillCategoryId({
        slug: "tiny-unknown-tool",
        name: "Tiny Unknown Tool",
        description: "A small helper",
        tags: ["misc"],
      }),
    ).toBe("others");
  });

  it("uses the first explicit business category as the only filter bucket", () => {
    const mixedSkill = {
      slug: "nutrigenomics",
      name: "Nutrigenomics",
      description: "Generate a nutrition report from genetic data",
      tags: ["industry_skills", "data_analysis", "document_processing"],
    };

    expect(getSkillCategoryId(mixedSkill)).toBe("industry_skills");
    expect(skillMatchesCategory(mixedSkill, "industry_skills")).toBe(true);
    expect(skillMatchesCategory(mixedSkill, "data_analysis")).toBe(false);
    expect(skillMatchesCategory(mixedSkill, "document_processing")).toBe(false);
  });

  it("sorts useful business-facing categories before Web3-heavy catalog items", () => {
    const web3 = {
      slug: "wallet-trader",
      name: "Wallet Trader",
      description: "Trade crypto tokens",
      tags: ["crypto"],
      downloads: 10_000,
      stars: 100,
    };
    const docs = {
      slug: "slides-builder",
      name: "Slides Builder",
      description: "Create presentations from documents",
      tags: ["presentation"],
      downloads: 10,
      stars: 0,
    };

    expect(compareSkillsForMarketplace(docs, web3)).toBeLessThan(0);
  });
});
