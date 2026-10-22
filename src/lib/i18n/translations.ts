import { en } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { de } from "./de";
import { pt } from "./pt";
import { zh } from "./zh";
import { ja } from "./ja";
import { ko } from "./ko";
import { th } from "./th";
import type { LanguageCode } from "./languages";
import type { TranslationKey } from "./en";

export const translations: Record<LanguageCode, Record<TranslationKey, string>> = {
  en,
  es,
  fr,
  de,
  pt,
  zh,
  ja,
  ko,
  th,
};

export type { TranslationKey };
