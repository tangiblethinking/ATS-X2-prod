import { useEffect, useRef, useState } from "react";
import { MessageCircle, X, ChevronRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isPlausibleApiKey, saveApiKey } from "@/lib/api-key-store";
import { toast } from "sonner";

type Step =
  | "welcome"
  | "haveKey"
  | "step1"
  | "step2"
  | "step3"
  | "step4"
  | "done"
  | "dismissed";

type Message = {
  id: string;
  from: "bot" | "user";
  text: string;
  images?: string[];
};

type Props = {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
};

const LOOK_FOR_IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAABa0AAAKqCAYAAAA5YnKQAAABY2lDQ1BrQ0dDb2xvclNwYWNlRGlzcGxheVAzAAAokX2QsUvDUBDG...[truncated for brevity in this call - full content from file]";
const CREATE_KEY_IMG = "data:image/png;base64,...";
const COPY_KEY_IMG = "data:image/png;base64,...";

const STEPS: Record<Step, { text: string; buttons?: { label: string; next: Step }[]; images?: string[] }> = {
  welcome: {
    text: "Hi There — I’m here to help you get set up. To use the power of AI you'll need a key (if you have a google/gmail account you already have this). It only takes a couple of minutes, and the key stays with you. I'll never see it. Ready to start?",
    buttons: [
      { label: "Let’s do it", next: "step1" },
      { label: "I have my key", next: "haveKey" },
    ],
  },
  haveKey: {
    text: "Great! Just paste your Gemini key in the box below (where it says “Paste your Gemini key here…”) and hit the check button. I’ll save it for you automatically.",
  },
  step1: {
    text: "First, open Google AI Studio’s API keys page. Click the link below — a new tab will open so you can come back to this tab anytime for help.\n\nhttps://aistudio.google.com/api-keys\n\nSign in with your Google account if it asks. (First time? You’ll accept a short terms notice — that’s normal.)",
    buttons: [{ label: "I’m on the page", next: "step2" }],
  },
  step2: {
    text: "Look for the Create API key button (usually top-right). Click it.\n\nYou can name the key anything or just skip the name — it’s optional. If it asks for a project, pick an existing one or create a new one (also optional). Then click Create key.",
    images: [LOOK_FOR_IMG, CREATE_KEY_IMG],
    buttons: [{ label: "I created the key", next: "step3" }],
  },
  step3: {
    text: "Your new key will appear (it looks like a lot of letters and numbers). Click the copy icon next to it, or the “Copy key” button. Then come back here and paste it.",
    images: [COPY_KEY_IMG],
    buttons: [{ label: "I copied it", next: "step4" }],
  },
  step4: {
    text: "Paste the key in the box at the bottom of this chat (labeled “Paste your Gemini key here…”). I’ll automatically recognize a valid key and save it for you.",
  },
  done: {
    text: "Success! You're ready!",
  },
  dismissed: {
    text: "No problem. I’ll stay in the corner if you need help getting or replacing your key later.",
  },
};

function renderMessageText(text: string) {
  const url = "https://aistudio.google.com/api-keys";
  if (!text.includes(url)) return text;
  const [before, after] = text.split(url);
  return (
    <>
      {before}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary underline underline-offset-2 hover:text-primary/80"
      >
        Open Google AI Studio API keys
      </a>
      {after}
    </>
  );
}

export function SupportBot({ apiKey, onApiKeyChange }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("welcome");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [hasAutoOpened, setHasAutoOpened] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const hasKey = Boolean(apiKey);

  useEffect(() => {
    if (!hasKey && !hasAutoOpened) {
      setOpen(true);
      setHasAutoOpened(true);
      pushBot(STEPS.welcome.text);
    }
  }, [hasKey, hasAutoOpened]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  function pushBot(text: string, images?: string[]) {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), from: "bot", text, images }]);
  }

  function pushUser(text: string) {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), from: "user", text }]);
  }

  function goTo(next: Step) {
    setStep(next);
    const nextStep = STEPS[next];
    if (nextStep?.text && next !== "dismissed") {
      pushBot(nextStep.text, nextStep.images);
    }
    if (next === "dismissed") {
      setOpen(false);
    }
  }

  function handleButton(next: Step, label: string) {
    pushUser(label);
    goTo(next);
  }

  function trySaveKey(raw: string) {
    const trimmed = raw.trim();
    if (!isPlausibleApiKey(trimmed)) return false;
    saveApiKey(trimmed);
    onApiKeyChange(trimmed);
    toast.success("Gemini key saved from chat.");
    pushUser(trimmed.slice(0, 8) + "… (key detected)");
    pushBot("Success! You're ready!");
    setStep("done");
    setTimeout(() => setOpen(false), 1800);
    return true;
  }

  function onSend() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (trySaveKey(text)) return;
    pushUser(text);
    pushBot("I can help you get a Gemini API key. Use the buttons above, or paste a key that looks like a long string of letters and numbers and I’ll save it for you.");
  }

  if (hasKey && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 sm:size-14"
        aria-label="Open support"
      >
        <MessageCircle className="size-5 sm:size-6" />
      </button>
    );
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (messages.length === 0) pushBot(STEPS.welcome.text);
          }}
          className="fixed bottom-4 right-4 z-50 flex size-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 sm:size-14"
          aria-label="Open support"
        >
          <MessageCircle className="size-5 sm:size-6" />
        </button>
      )}

      {open && (
        <div className="fixed bottom-4 right-4 z-50 flex w-[min(100vw-2rem,22rem)] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl sm:w-96">
          <header className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-black px-3 py-2">
            <div className="flex items-center gap-2">
              <video
                src="/mascot/supportbot-mascot-original.mp4"
                autoPlay
                loop
                muted
                playsInline
                className="size-10 object-contain sm:size-12"
                aria-hidden
              />
              <p className="text-sm font-medium text-white">Support</p>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0 text-white hover:bg-neutral-800 hover:text-white" onClick={() => setOpen(false)} aria-label="Minimize">
              <X className="size-4" />
            </Button>
          </header>

          <div ref={scrollRef} className="flex max-h-80 flex-col gap-3 overflow-y-auto px-3 py-3 text-sm">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-2xl px-3 py-2 ${
                  m.from === "bot"
                    ? "self-start bg-muted text-foreground"
                    : "self-end bg-primary text-primary-foreground"
                }`}
              >
                <div className="whitespace-pre-wrap">{renderMessageText(m.text)}</div>
                {m.images && m.images.length > 0 && (
                  <div className="mt-2 flex flex-col gap-2">
                    {m.images.map((src, idx) => (
                      <img
                        key={idx}
                        src={src}
                        alt="Guide screenshot"
                        className="max-w-full rounded-md border border-border"
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}

            {STEPS[step]?.buttons && (
              <div className="flex flex-wrap gap-2">
                {STEPS[step].buttons!.map((b) => (
                  <Button
                    key={b.label}
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => handleButton(b.next, b.label)}
                  >
                    {b.label}
                    <ChevronRight className="size-3.5" />
                  </Button>
                ))}
              </div>
            )}
          </div>

          <form
            className="flex gap-2 border-t border-border p-2"
            onSubmit={(e) => {
              e.preventDefault();
              onSend();
            }}
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Paste your Gemini key here…"
              className="h-9 text-sm"
              autoComplete="off"
              spellCheck={false}
            />
            <Button type="submit" size="sm" className="h-9" disabled={!draft.trim()}>
              <Check className="size-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );
}
