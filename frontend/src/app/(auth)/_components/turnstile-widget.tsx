import { useEffect, useRef } from "react";

/**
 * Cloudflare's script, rendered explicitly so the widget mounts where and when
 * this component does rather than wherever the page has a `.cf-turnstile`.
 */
export const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * The header the backend's captcha plugin reads the token off
 * (`CAPTCHA_RESPONSE_HEADER` in `backend/src/auth/turnstile.ts`).
 */
export const CAPTCHA_RESPONSE_HEADER = "x-captcha-response";

type TurnstileApi = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Cloudflare's script, added to the page once however many widgets mount. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile did not load"));
    script.onerror = () => {
      loading = null;
      reject(new Error("Turnstile did not load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Cloudflare Turnstile on the Hosted instance's public sign-up form.
 * It hands `onToken` the token the sign-up must carry, and `null` again once
 * that token expires or the check fails. A token is good for one sign-up, so
 * the form bumps `resetKey` after every refused one to get a fresh token.
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  // The latest callback, so a re-render of the form does not re-render the
  // widget (which would throw its token away).
  const tokenTo = useRef(onToken);
  useEffect(() => {
    tokenTo.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let cancelled = false;
    void loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current) return;
        const id = api.render(container.current, {
          sitekey: siteKey,
          callback: (token) => tokenTo.current(token),
          "expired-callback": () => tokenTo.current(null),
          "error-callback": () => tokenTo.current(null),
        });
        widget.current = { api, id };
      })
      // No widget means no token, and the sign-up's refusal says so.
      .catch(() => tokenTo.current(null));
    return () => {
      cancelled = true;
      widget.current?.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey === 0 || !widget.current) return;
    tokenTo.current(null);
    widget.current.api.reset(widget.current.id);
  }, [resetKey]);

  return (
    <div
      ref={container}
      data-testid="turnstile"
      data-sitekey={siteKey}
      className="min-h-[65px]"
    />
  );
}
