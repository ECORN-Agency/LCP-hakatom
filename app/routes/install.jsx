import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../shopify.server";
import styles from "./_index/styles.module.css";

// Public marketing landing for the app. Lives at /install so the embedded
// iframe never lands here by accident (the root / always bounces into /app/).
// Reachable from App Store listing, direct shares, marketing emails.
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");
  const embedded = url.searchParams.get("embedded");

  // If somehow Shopify routes us here with embed params, push the merchant
  // into the embedded experience instead of showing the marketing copy.
  if (shop || host || embedded === "1") {
    throw redirect(`/app?${url.searchParams.toString()}`, {
      headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
    });
  }

  return { showForm: Boolean(login) };
};

export const headers = () => ({
  "Cache-Control": "no-store, no-cache, must-revalidate",
});

export default function Install() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>LSP Analizer for Shopify</p>
        <h1 className={styles.heading}>Know which changes hurt your sales.</h1>
        <p className={styles.text}>
          Every theme edit, price move, restock and order is logged
          automatically. We measure the real impact against your store's
          normal pattern and flag anything that looks off — so you don't
          find out from a customer complaint or a quiet day.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Install on your store</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="your-store.myshopify.com"
                autoComplete="off"
              />
            </label>
            <button className={styles.button} type="submit">
              Install
            </button>
          </Form>
        )}
      </header>

      <section className={styles.features}>
        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Everything in one Timeline</h2>
          <p className={styles.featureBody}>
            Theme publishes, Customizer saves (down to the file), price
            changes, stock moves, orders and customer-side events all flow
            into a single feed. Filter by type and time, search by name.
          </p>
        </article>

        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Compared against your baseline</h2>
          <p className={styles.featureBody}>
            For any event, we line up the after-window against the same
            time-of-day × day-of-week slot over the last 4 weeks. The
            comparison removes hour-of-day and weekly seasonality, so the
            delta is actually about the change, not Monday-vs-Saturday noise.
          </p>
        </article>

        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Early conversion signals</h2>
          <p className={styles.featureBody}>
            A Web Pixel feeds storefront events (page views, cart adds,
            checkouts) back in seconds — long before orders settle. Theme
            changes that quietly tank conversion show up immediately, not
            after a slow Sunday.
          </p>
        </article>

        <article className={styles.feature}>
          <h2 className={styles.featureTitle}>Honest, rule-based alerts</h2>
          <p className={styles.featureBody}>
            No black-box ML. Email rules with explicit thresholds (label
            and confidence) tell you when a change crosses the line, and
            the email shows the exact drivers behind the verdict.
          </p>
        </article>
      </section>

      <footer className={styles.footer}>
        <p className={styles.footerNote}>
          LSP Analizer is a research-grade tool. Recommendations are early
          signals, not causal proof — we tell you what we saw and how
          confident we are, you decide what to do.
        </p>
      </footer>
    </div>
  );
}
