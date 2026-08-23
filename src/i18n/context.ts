import { createContext, useContext } from "react";
import { en, ko } from "./locales";

export type Locale = "ko" | "en";

export type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

type I18nValue = {
  readonly locale: Locale;
  readonly t: Translate;
};

const dictionaries: Record<Locale, Record<string, string>> = { ko, en };

export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const template = dictionaries[locale][key] ?? key;
  if (vars === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

export const I18nContext = createContext<I18nValue>({
  locale: "en",
  t: (key, vars) => translate("en", key, vars),
});

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
