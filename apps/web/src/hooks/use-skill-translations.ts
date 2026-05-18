import {
  type SkillTranslationMap,
  isChineseLocale,
} from "@/lib/skill-translations";
import { useEffect, useState } from "react";

export function useSkillTranslationMap(locale: string): SkillTranslationMap {
  const [translations, setTranslations] = useState<SkillTranslationMap>({});

  useEffect(() => {
    if (!isChineseLocale(locale) || typeof fetch === "undefined") {
      setTranslations({});
      return;
    }

    let cancelled = false;
    void fetch("/skill-translations-zh.json", { cache: "force-cache" })
      .then((response) => (response.ok ? response.json() : {}))
      .then((data: unknown) => {
        if (!cancelled && data && typeof data === "object") {
          setTranslations(data as SkillTranslationMap);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTranslations({});
        }
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  return translations;
}
