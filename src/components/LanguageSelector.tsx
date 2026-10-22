import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { LANGUAGES } from "@/lib/i18n/languages";
import { cn } from "@/lib/utils";

type Props = {
  variant?: "icon" | "inline";
  className?: string;
};

export function LanguageSelector({ variant = "icon", className }: Props) {
  const { language, setLanguage, t } = useLanguage();

  return (
    <Popover>
      <PopoverTrigger asChild>
        {variant === "icon" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("h-9 w-9 p-0", className)}
            aria-label={t("languageSelector")}
          >
            <Languages className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("h-8 gap-1.5 px-2.5", className)}
            aria-label={t("openLanguageSelector")}
          >
            <Languages className="size-3.5" />
            <span className="text-xs">{t("pleaseSelectLanguage")}</span>
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-0">
        <ScrollArea className="h-72">
          <div className="flex flex-col p-1">
            {LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                type="button"
                onClick={() => setLanguage(lang.code)}
                className={cn(
                  "flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  language === lang.code && "bg-accent font-medium",
                )}
              >
                {lang.nativeName}
              </button>
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
