import { useMemo, type ReactNode } from "react";
import { I18nContext, translate, type Locale, type Translate } from "./context";

type I18nValue = {
  readonly locale: Locale;
  readonly t: Translate;
};

export function I18nProvider({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}) {
  const value = useMemo<I18nValue>(
    () => ({
      locale,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

