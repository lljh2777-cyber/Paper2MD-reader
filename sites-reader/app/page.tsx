"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;

    void import("../../local-reader/main")
      .then(({ mountLocalReader }) => {
        const root = document.querySelector<HTMLElement>("#app");
        if (!cancelled && root) dispose = mountLocalReader(root);
      })
      .catch((error: unknown) => {
        console.error("Paper2MD Reader failed to start", error);
        setFailed(true);
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  if (failed) {
    return (
      <main className="p2md-site-startup-error">
        <h1>Paper2MD Reader could not start</h1>
        <p>Refresh the page and try again.</p>
      </main>
    );
  }

  return <div id="app" aria-live="polite" />;
}
