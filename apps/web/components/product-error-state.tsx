import Link from "next/link";

export function ProductErrorState({
  reason,
  title = "Live repository data unavailable",
}: {
  readonly reason: string;
  readonly title?: string;
}) {
  return (
    <section className="product-error" role="alert">
      <span className="product-error-code">LIVE / INTERRUPTED</span>
      <div>
        <h1>{title}</h1>
        <p>{reason}</p>
        <p>
          Start PostgreSQL and the IntelliRepo API, register this repository, then reload. Fixture
          data is never substituted on a live route.
        </p>
      </div>
      <Link href="/">RETURN HOME →</Link>
    </section>
  );
}
