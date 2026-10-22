export type LanguageCode = "en" | "es" | "fr" | "de" | "pt" | "zh" | "ja" | "ko" | "th";

export const LANGUAGES: { code: LanguageCode; nativeName: string }[] = [
  { code: "en", nativeName: "English" },
  { code: "es", nativeName: "Español" },
  { code: "fr", nativeName: "Français" },
  { code: "de", nativeName: "Deutsch" },
  { code: "pt", nativeName: "Português" },
  { code: "zh", nativeName: "中文" },
  { code: "ja", nativeName: "日本語" },
  { code: "ko", nativeName: "한국어" },
  { code: "th", nativeName: "ไทย" },
];

export const DEFAULT_LANGUAGE: LanguageCode = "en";
