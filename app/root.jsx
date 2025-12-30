import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { useEffect } from "react";

export default function App() {
  useEffect(() => {
    // Suppress App Bridge internal errors (metrics/logs export)
    const originalError = console.error;
    console.error = (...args) => {
      const message = args.join(" ");
      if (
        message.includes("exporting metrics") ||
        message.includes("exporting logs") ||
        message.includes("Suppressed error") ||
        (message.includes("Failed to fetch") && message.includes("app-bridge"))
      ) {
        // Silently ignore App Bridge internal errors
        return;
      }
      originalError.apply(console, args);
    };

    // Also catch unhandled errors
    window.addEventListener("error", (event) => {
      if (
        event.message?.includes("exporting metrics") ||
        event.message?.includes("exporting logs") ||
        event.message?.includes("app-bridge")
      ) {
        event.preventDefault();
        return false;
      }
    });

    return () => {
      console.error = originalError;
    };
  }, []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
